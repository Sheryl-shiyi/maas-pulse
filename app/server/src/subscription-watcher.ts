import https from 'https';
import fs from 'fs';
import { broadcast } from './ws.js';

const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const SA_CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';

let groupToUsers = new Map<string, string[]>();
let namespace = 'models-as-a-service';
let watching = false;
const rateLimitsCache = new Map<string, Record<string, string>>();

export function getWatchedRateLimits(): Map<string, Record<string, string>> {
  return rateLimitsCache;
}

export function startSubscriptionWatcher(
  users: { name: string; group: string }[],
  subscriptionNamespace: string,
) {
  if (!fs.existsSync(SA_TOKEN_PATH)) {
    console.log('[subscription-watcher] not running in-cluster, skipping');
    return;
  }

  namespace = subscriptionNamespace;
  groupToUsers.clear();
  for (const u of users) {
    const list = groupToUsers.get(u.group) || [];
    list.push(u.name);
    groupToUsers.set(u.group, list);
  }

  console.log(`[subscription-watcher] watching MaaSSubscriptions in ${namespace}`);
  console.log(`[subscription-watcher] group mapping: ${[...groupToUsers.entries()].map(([g, u]) => `${g}→[${u}]`).join(', ')}`);
  watching = true;
  watch();
}

export function stopSubscriptionWatcher() {
  watching = false;
}

function watch(resourceVersion?: string) {
  if (!watching) return;

  const token = fs.readFileSync(SA_TOKEN_PATH, 'utf8');
  let caOpts: { ca?: Buffer } = {};
  if (fs.existsSync(SA_CA_PATH)) {
    caOpts.ca = fs.readFileSync(SA_CA_PATH);
  }

  let path = `/apis/maas.opendatahub.io/v1alpha1/namespaces/${namespace}/maassubscriptions?watch=true`;
  if (resourceVersion) {
    path += `&resourceVersion=${resourceVersion}`;
  }

  const req = https.get(`https://kubernetes.default.svc${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    ...caOpts,
    rejectUnauthorized: true,
  }, (res) => {
    if (res.statusCode === 410) {
      console.log('[subscription-watcher] resourceVersion expired, restarting watch');
      setTimeout(() => watch(), 1000);
      return;
    }
    if (res.statusCode !== 200) {
      console.error(`[subscription-watcher] unexpected status ${res.statusCode}`);
      setTimeout(() => watch(), 5000);
      return;
    }

    let buffer = '';
    let latestRV = resourceVersion;

    res.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.object?.metadata?.resourceVersion) {
            latestRV = event.object.metadata.resourceVersion;
          }
          handleEvent(event);
        } catch {
          console.error('[subscription-watcher] failed to parse event');
        }
      }
    });

    res.on('end', () => {
      if (!watching) return;
      console.log('[subscription-watcher] watch stream ended, reconnecting...');
      setTimeout(() => watch(latestRV), 1000);
    });

    res.on('error', (err: Error) => {
      console.error(`[subscription-watcher] stream error: ${err.message}`);
      if (watching) setTimeout(() => watch(latestRV), 5000);
    });
  });

  req.on('error', (err: Error) => {
    console.error(`[subscription-watcher] connection error: ${err.message}`);
    if (watching) setTimeout(() => watch(), 5000);
  });

  req.setTimeout(0);
}

function handleEvent(event: { type: string; object: Record<string, any> }) {
  if (event.type !== 'ADDED' && event.type !== 'MODIFIED') return;

  const sub = event.object;
  const subName = sub.metadata?.name || '?';
  const groups: string[] = (sub.spec?.owner?.groups || []).map((g: { name: string }) => g.name);
  const modelRefs: any[] = sub.spec?.modelRefs || [];

  const perModel: Record<string, string> = {};
  for (const ref of modelRefs) {
    const modelName: string = ref.name || '';
    if (!modelName) continue;
    const limits: { limit: number; window?: string }[] = ref.tokenRateLimits || [];
    if (limits.length === 0) continue;
    const min = limits.reduce((a, b) => a.limit < b.limit ? a : b);
    perModel[modelName] = formatLimit(min.limit, min.window || '1m');
  }

  for (const group of groups) {
    const users = groupToUsers.get(group);
    if (!users) continue;
    const summary = Object.keys(perModel).length > 0
      ? [...new Set(Object.values(perModel))].join(', ')
      : '(no models)';
    console.log(`[subscription-watcher] ${subName} (group=${group}) updated: ${summary}`);
    for (const user of users) {
      rateLimitsCache.set(user, perModel);
      broadcast({ type: 'rate_limit_update', user, rateLimits: perModel });
    }
  }
}

function formatLimit(limit: number, window: string): string {
  const fmt = (n: number) => n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
  return `${fmt(limit)}/${window}`;
}
