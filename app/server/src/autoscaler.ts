import https from 'https';
import fs from 'fs';

const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const SA_CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';

interface AutoscaleModel {
  name: string;
  minReplicas: number;
  maxReplicas: number;
}

interface AutoscaleConfig {
  models: AutoscaleModel[];
  namespace: string;
  cooldownSeconds: number;
}

let config: AutoscaleConfig | null = null;
const scaleDownTimers = new Map<string, number>();

export function initAutoscaler(cfg: AutoscaleConfig) {
  if (!fs.existsSync(SA_TOKEN_PATH)) {
    console.log('[autoscaler] not running in-cluster, skipping');
    return;
  }
  config = cfg;
  console.log(`[autoscaler] initialized for models: ${cfg.models.map(m => m.name).join(', ')}`);
  console.log(`[autoscaler] namespace: ${cfg.namespace}, cooldown: ${cfg.cooldownSeconds}s`);
}

export async function checkAndScale(metrics: { model: string; queueDepth: number; kvCachePercent: number }[]) {
  if (!config) return;

  for (const m of config.models) {
    const metric = metrics.find(x => x.model === m.name);
    if (!metric) continue;

    const overloaded = metric.queueDepth > 10 || metric.kvCachePercent > 85;
    const idle = metric.queueDepth < 3 && metric.kvCachePercent < 30;

    if (overloaded) {
      scaleDownTimers.delete(m.name);
      await scaleUp(m);
    } else if (idle) {
      const now = Date.now();
      const timer = scaleDownTimers.get(m.name);
      if (!timer) {
        scaleDownTimers.set(m.name, now);
      } else if (now - timer > config.cooldownSeconds * 1000) {
        scaleDownTimers.delete(m.name);
        await scaleDown(m);
      }
    } else {
      scaleDownTimers.delete(m.name);
    }
  }
}

async function getCurrentReplicas(name: string): Promise<number | null> {
  if (!config) return null;
  try {
    const token = fs.readFileSync(SA_TOKEN_PATH, 'utf8');
    const path = `/apis/serving.kserve.io/v1alpha1/namespaces/${config.namespace}/llminferenceservices/${name}`;
    const body = await k8sGet(path, token);
    return body?.spec?.replicas ?? 1;
  } catch (err) {
    console.error(`[autoscaler] failed to get replicas for ${name}:`, err);
    return null;
  }
}

async function patchReplicas(name: string, replicas: number): Promise<boolean> {
  if (!config) return false;
  try {
    const token = fs.readFileSync(SA_TOKEN_PATH, 'utf8');
    const path = `/apis/serving.kserve.io/v1alpha1/namespaces/${config.namespace}/llminferenceservices/${name}`;
    const patch = JSON.stringify({ spec: { replicas } });

    return new Promise((resolve) => {
      let caOpts: { ca?: Buffer } = {};
      if (fs.existsSync(SA_CA_PATH)) {
        caOpts.ca = fs.readFileSync(SA_CA_PATH);
      }

      const req = https.request(`https://kubernetes.default.svc${path}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/merge-patch+json',
          'Content-Length': Buffer.byteLength(patch),
        },
        ...caOpts,
        rejectUnauthorized: true,
      }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`[autoscaler] patched ${name} to ${replicas} replicas`);
            resolve(true);
          } else {
            console.error(`[autoscaler] patch failed for ${name}: ${res.statusCode} ${data}`);
            resolve(false);
          }
        });
      });

      req.on('error', (err: Error) => {
        console.error(`[autoscaler] patch error for ${name}:`, err.message);
        resolve(false);
      });

      req.write(patch);
      req.end();
    });
  } catch (err) {
    console.error(`[autoscaler] patchReplicas error:`, err);
    return false;
  }
}

async function scaleUp(model: AutoscaleModel) {
  const current = await getCurrentReplicas(model.name);
  if (current === null) return;
  if (current >= model.maxReplicas) return;
  const target = Math.min(current + 1, model.maxReplicas);
  console.log(`[autoscaler] scaling UP ${model.name}: ${current} → ${target}`);
  await patchReplicas(model.name, target);
}

async function scaleDown(model: AutoscaleModel) {
  const current = await getCurrentReplicas(model.name);
  if (current === null) return;
  if (current <= model.minReplicas) return;
  const target = Math.max(current - 1, model.minReplicas);
  console.log(`[autoscaler] scaling DOWN ${model.name}: ${current} → ${target}`);
  await patchReplicas(model.name, target);
}

function k8sGet(path: string, token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    let caOpts: { ca?: Buffer } = {};
    if (fs.existsSync(SA_CA_PATH)) {
      caOpts.ca = fs.readFileSync(SA_CA_PATH);
    }

    const req = https.get(`https://kubernetes.default.svc${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      ...caOpts,
      rejectUnauthorized: true,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
  });
}
