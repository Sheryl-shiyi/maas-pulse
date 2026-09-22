import https from 'https';
import fs from 'fs';
import { broadcast } from './ws.js';

const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const SA_CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';

let deployToModel = new Map<string, string>();
let namespace = 'llm';
let watching = false;
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
  watch();
}

export function stopDeploymentWatcher() {
  watching = false;
}

function watch(resourceVersion?: string) {
  if (!watching) return;

  const token = fs.readFileSync(SA_TOKEN_PATH, 'utf8');
  let caOpts: { ca?: Buffer } = {};
  if (fs.existsSync(SA_CA_PATH)) {
    caOpts.ca = fs.readFileSync(SA_CA_PATH);
  }

  let path = `/apis/apps/v1/namespaces/${namespace}/deployments?watch=true`;
  if (resourceVersion) {
    path += `&resourceVersion=${resourceVersion}`;
  }

  const req = https.get(`https://kubernetes.default.svc${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    ...caOpts,
    rejectUnauthorized: true,
  }, (res) => {
    if (res.statusCode === 410) {
      console.log('[deployment-watcher] resourceVersion expired, restarting watch');
      setTimeout(() => watch(), 1000);
      return;
    }
    if (res.statusCode !== 200) {
      console.error(`[deployment-watcher] unexpected status ${res.statusCode}`);
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
          console.error('[deployment-watcher] failed to parse event');
        }
      }
    });

    res.on('end', () => {
      if (!watching) return;
      console.log('[deployment-watcher] watch stream ended, reconnecting...');
      setTimeout(() => watch(latestRV), 1000);
    });

    res.on('error', (err: Error) => {
      console.error(`[deployment-watcher] stream error: ${err.message}`);
      if (watching) setTimeout(() => watch(latestRV), 5000);
    });
  });

  req.on('error', (err: Error) => {
    console.error(`[deployment-watcher] connection error: ${err.message}`);
    if (watching) setTimeout(() => watch(), 5000);
  });

  req.setTimeout(0);
}

function handleEvent(event: { type: string; object: Record<string, any> }) {
  if (event.type !== 'ADDED' && event.type !== 'MODIFIED') return;

  const deploy = event.object;
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
