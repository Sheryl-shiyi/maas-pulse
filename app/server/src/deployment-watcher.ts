import https from 'https';
import fs from 'fs';
import { broadcast } from './ws.js';
import { classifyWatchEvent } from './watch-events.js';

const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const SA_CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';

let deployToModel = new Map<string, string>();
let namespace = 'llm';
let watching = false;
let resyncTimer: NodeJS.Timeout | null = null;
/** How often to re-list regardless of the watch: heals a stream that died without a word. */
const RESYNC_MS = 60_000;
const replicasCache = new Map<string, { replicas: number; desired: number }>();

export function getWatchedReplicas(): Map<string, { replicas: number; desired: number }> {
  return replicasCache;
}

export function startDeploymentWatcher(
  models: { name: string }[],
  modelsNamespace: string,
) {
  if (!fs.existsSync(SA_TOKEN_PATH)) {
    console.log('[deployment-watcher] not running in-cluster, skipping');
    return;
  }

  namespace = modelsNamespace;
  deployToModel.clear();
  for (const m of models) {
    const baseName = m.name.replace(/^publishers\/llm\/models\//, '');
    const deployName = `${baseName}-kserve`;
    deployToModel.set(deployName, baseName);
  }

  console.log(`[deployment-watcher] watching deployments in ${namespace}`);
  console.log(`[deployment-watcher] deploy→model mapping: ${[...deployToModel.entries()].map(([d, m]) => `${d}→${m}`).join(', ')}`);
  watching = true;
  listThenWatch();
  // The watch is the fast path; this is the safety net. A watch connection can go quiet without
  // ever ending (the demo cluster on 2026-11-09 sat on a stale "1/2" with no error in its log),
  // and then nothing but a fresh list brings the replica counts back.
  if (!resyncTimer) resyncTimer = setInterval(resync, RESYNC_MS);
}

/** List the deployments and apply them, without touching the watch. */
function resync() {
  if (!watching) return;
  const token = fs.readFileSync(SA_TOKEN_PATH, 'utf8');
  const req = https.get(`https://kubernetes.default.svc/apis/apps/v1/namespaces/${namespace}/deployments`, {
    headers: { Authorization: `Bearer ${token}` },
    ...getHttpsOptions(),
    rejectUnauthorized: true,
  }, (res) => {
    let data = '';
    res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
    res.on('end', () => {
      if (res.statusCode !== 200) return;
      try {
        for (const deploy of JSON.parse(data).items || []) handleDeployment(deploy);
      } catch {
        // the next resync tries again
      }
    });
  });
  req.on('error', () => { /* the next resync tries again */ });
}

export function stopDeploymentWatcher() {
  watching = false;
  if (resyncTimer) { clearInterval(resyncTimer); resyncTimer = null; }
}

function getHttpsOptions(): { ca?: Buffer } {
  if (fs.existsSync(SA_CA_PATH)) {
    return { ca: fs.readFileSync(SA_CA_PATH) };
  }
  return {};
}

function listThenWatch() {
  if (!watching) return;

  const token = fs.readFileSync(SA_TOKEN_PATH, 'utf8');
  const caOpts = getHttpsOptions();
  const listPath = `/apis/apps/v1/namespaces/${namespace}/deployments`;

  const req = https.get(`https://kubernetes.default.svc${listPath}`, {
    headers: { Authorization: `Bearer ${token}` },
    ...caOpts,
    rejectUnauthorized: true,
  }, (res) => {
    if (res.statusCode !== 200) {
      console.error(`[deployment-watcher] list failed: ${res.statusCode}`);
      if (watching) setTimeout(() => listThenWatch(), 5000);
      return;
    }

    let data = '';
    res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
    res.on('end', () => {
      try {
        const list = JSON.parse(data);
        const rv = list.metadata?.resourceVersion;

        for (const deploy of list.items || []) {
          handleDeployment(deploy);
        }

        console.log(`[deployment-watcher] listed ${list.items?.length || 0} deployments, rv=${rv}`);
        if (watching && rv) {
          watch(rv);
        }
      } catch (err) {
        console.error('[deployment-watcher] failed to parse list response');
        if (watching) setTimeout(() => listThenWatch(), 5000);
      }
    });
  });

  req.on('error', (err: Error) => {
    console.error(`[deployment-watcher] list error: ${err.message}`);
    if (watching) setTimeout(() => listThenWatch(), 5000);
  });
}

function watch(resourceVersion: string) {
  if (!watching) return;

  const token = fs.readFileSync(SA_TOKEN_PATH, 'utf8');
  const caOpts = getHttpsOptions();
  // One reconnect per watch, however many of 'end' / 'error' / the timeout fire: otherwise a
  // dropped connection can start two watchers side by side.
  let finished = false;
  const next = (fn: () => void, ms: number) => {
    if (finished || !watching) return;
    finished = true;
    setTimeout(fn, ms);
  };
  // Bookmarks keep latestRV fresh while the deployments do not change, so a reconnect after a
  // quiet spell does not ask for a resourceVersion the API server has already forgotten.
  const path = `/apis/apps/v1/namespaces/${namespace}/deployments?watch=true&resourceVersion=${resourceVersion}&timeoutSeconds=300&allowWatchBookmarks=true`;

  const req = https.get(`https://kubernetes.default.svc${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    ...caOpts,
    rejectUnauthorized: true,
  }, (res) => {
    if (res.statusCode === 410) {
      console.log('[deployment-watcher] resourceVersion expired, re-listing');
      next(() => listThenWatch(), 1000);
      return;
    }
    if (res.statusCode !== 200) {
      console.error(`[deployment-watcher] watch failed: ${res.statusCode}`);
      next(() => listThenWatch(), 5000);
      return;
    }

    let buffer = '';
    let latestRV = resourceVersion;
    /** The stream reported an ERROR (an expired resourceVersion, typically): list again. */
    let relist = false;

    res.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // skip unparseable lines
        }
        const event = classifyWatchEvent(parsed);
        if (event.kind === 'relist') {
          relist = true;
          console.log(`[deployment-watcher] watch error ${event.code ?? '?'} ${event.reason ?? ''}: re-listing`);
        } else if (event.kind === 'bookmark' || event.kind === 'deployment') {
          if (event.resourceVersion) latestRV = event.resourceVersion;
          if (event.kind === 'deployment') handleDeployment(event.object);
        }
      }
    });

    res.on('end', () => {
      if (relist) {
        next(() => listThenWatch(), 1000);
      } else {
        if (!finished) console.log('[deployment-watcher] watch stream ended, reconnecting...');
        next(() => watch(latestRV), 1000);
      }
    });

    res.on('error', (err: Error) => {
      console.error(`[deployment-watcher] stream error: ${err.message}`);
      next(() => listThenWatch(), 5000);
    });
  });

  req.on('error', (err: Error) => {
    console.error(`[deployment-watcher] connection error: ${err.message}`);
    next(() => listThenWatch(), 5000);
  });

  // The server ends a watch after timeoutSeconds (300) and sends bookmarks in between, so a
  // socket silent for longer than that is dead: drop it, and the 'error' handler re-lists.
  req.setTimeout(330_000, () => req.destroy(new Error('watch silent for 330 s')));
}

function handleDeployment(deploy: Record<string, any>) {
  const deployName: string = deploy.metadata?.name || '';
  const modelName = deployToModel.get(deployName);
  if (!modelName) return;

  const desired: number = deploy.spec?.replicas ?? 1;
  const replicas: number = deploy.status?.readyReplicas ?? 0;

  const cached = replicasCache.get(modelName);
  if (cached && cached.replicas === replicas && cached.desired === desired) return;

  replicasCache.set(modelName, { replicas, desired });
  console.log(`[deployment-watcher] ${deployName}: ${replicas}/${desired} ready`);
  broadcast({ type: 'scale_update', model: modelName, replicas, desiredReplicas: desired });
}
