import https from 'https';
import fs from 'fs';
import { PRESSURE } from './prometheus.js';
import { broadcast } from './ws.js';

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
  console.log(`[autoscaler] initialized for models: ${cfg.models.map(m => `${m.name} (${m.minReplicas}–${m.maxReplicas} replicas)`).join(', ')}`);
  console.log(`[autoscaler] namespace: ${cfg.namespace}, cooldown: ${cfg.cooldownSeconds}s`);
}

export interface ScaleMetric { model: string; queuedRequests: number; kvCachePercent: number }

/** One condition the autoscaler checks, with the reading that was compared against it. */
export interface ScaleCheck { label: string; value: number; limit: number; unit: string; tripped: boolean }

/**
 * Why the autoscaler acted, in the terms an audience can follow: each condition it
 * checks, the reading, the limit, and whether it was the one that fired.
 */
export function scaleReason(direction: 'up' | 'down', m: ScaleMetric, cooldownSeconds: number): { summary: string; checks: ScaleCheck[] } {
  if (direction === 'up') {
    const checks: ScaleCheck[] = [
      { label: 'Requests queued', value: m.queuedRequests, limit: PRESSURE.queuedOverloaded, unit: '', tripped: m.queuedRequests > PRESSURE.queuedOverloaded },
      { label: 'KV cache in use', value: m.kvCachePercent, limit: PRESSURE.kvOverloadedPercent, unit: '%', tripped: m.kvCachePercent > PRESSURE.kvOverloadedPercent },
    ];
    const fired = checks.filter(c => c.tripped).map(c => `${c.label.toLowerCase()} ${c.value}${c.unit} > ${c.limit}${c.unit}`);
    return { summary: fired.join(' and '), checks };
  }
  const minutes = Math.round(cooldownSeconds / 60);
  return {
    summary: `idle for ${minutes} min: nothing queued and KV cache under ${PRESSURE.kvIdlePercent}%`,
    checks: [
      { label: 'Requests queued', value: m.queuedRequests, limit: 0, unit: '', tripped: m.queuedRequests === 0 },
      { label: 'KV cache in use', value: m.kvCachePercent, limit: PRESSURE.kvIdlePercent, unit: '%', tripped: m.kvCachePercent < PRESSURE.kvIdlePercent },
    ],
  };
}

export async function checkAndScale(metrics: ScaleMetric[]) {
  if (!config) return;

  for (const m of config.models) {
    const metric = metrics.find(x => x.model === m.name);
    if (!metric) continue;

    // Scale on back-pressure only. Requests already in the batch are not pressure;
    // see the note on PRESSURE in prometheus.ts for what that cost us.
    const overloaded = metric.queuedRequests > PRESSURE.queuedOverloaded
      || metric.kvCachePercent > PRESSURE.kvOverloadedPercent;
    const idle = metric.queuedRequests === 0 && metric.kvCachePercent < PRESSURE.kvIdlePercent;

    if (overloaded) {
      scaleDownTimers.delete(m.name);
      await scaleUp(m, metric);
    } else if (idle) {
      const now = Date.now();
      const timer = scaleDownTimers.get(m.name);
      if (!timer) {
        scaleDownTimers.set(m.name, now);
      } else if (now - timer > config.cooldownSeconds * 1000) {
        scaleDownTimers.delete(m.name);
        await scaleDown(m, metric);
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

async function scaleUp(model: AutoscaleModel, metric: ScaleMetric) {
  const current = await getCurrentReplicas(model.name);
  if (current === null) return;
  if (current >= model.maxReplicas) return;
  const target = Math.min(current + 1, model.maxReplicas);
  const reason = scaleReason('up', metric, config!.cooldownSeconds);
  console.log(`[autoscaler] scaling UP ${model.name}: ${current} → ${target} (${reason.summary})`);
  if (await patchReplicas(model.name, target)) announce(model.name, 'up', current, target, reason);
}

async function scaleDown(model: AutoscaleModel, metric: ScaleMetric) {
  const current = await getCurrentReplicas(model.name);
  if (current === null) return;
  if (current <= model.minReplicas) return;
  const target = Math.max(current - 1, model.minReplicas);
  const reason = scaleReason('down', metric, config!.cooldownSeconds);
  console.log(`[autoscaler] scaling DOWN ${model.name}: ${current} → ${target} (${reason.summary})`);
  if (await patchReplicas(model.name, target)) announce(model.name, 'down', current, target, reason);
}

/** Tell the UI why replicas changed, so the demo can show the cause, not just the effect. */
function announce(model: string, direction: 'up' | 'down', from: number, to: number, reason: { summary: string; checks: ScaleCheck[] }) {
  broadcast({ type: 'scale_event', model, direction, from, to, summary: reason.summary, checks: reason.checks, at: Date.now() });
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
