import fs from 'fs';
import type { ModelInfo, ModelStatus } from './types.js';
import { broadcast } from './ws.js';
import { checkAndScale } from './autoscaler.js';
import { stripMaasPrefix } from './model-names.js';

const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
// Projected SA tokens are rotated by the kubelet, so re-read the file periodically.
const SA_TOKEN_TTL_MS = 60_000;

let prometheusUrl = '';
let staticToken = '';
let cachedToken = '';
let cachedAt = 0;
let pollInterval: ReturnType<typeof setInterval> | null = null;

export function initPrometheus(url: string, token: string) {
  prometheusUrl = url;
  staticToken = token;
  const source = token ? 'PROMETHEUS_TOKEN env'
    : fs.existsSync(SA_TOKEN_PATH) ? 'in-cluster service account'
    : 'none (unauthenticated)';
  console.log(`[prometheus] configured: ${url} — auth: ${source}`);
}

function bearerToken(): string {
  if (staticToken) return staticToken;
  if (cachedAt && Date.now() - cachedAt < SA_TOKEN_TTL_MS) return cachedToken;

  try {
    cachedToken = fs.readFileSync(SA_TOKEN_PATH, 'utf8').trim();
  } catch {
    cachedToken = '';
  }
  cachedAt = Date.now();
  return cachedToken;
}

export async function query(promql: string): Promise<Record<string, string | number>[]> {
  if (!prometheusUrl) return [];

  try {
    const url = `${prometheusUrl}/api/v1/query?query=${encodeURIComponent(promql)}`;
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    const token = bearerToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return [];
    const json = await res.json() as { data?: { result?: Array<{ metric: Record<string, string>; value: [number, string] }> } };
    return json.data?.result?.map(r => ({
      ...r.metric,
      value: parseFloat(r.value[1]),
    })) ?? [];
  } catch {
    return [];
  }
}

/**
 * Pressure thresholds, shared by the colour of a model node and by the decision to
 * scale it.
 *
 * `vllm:num_requests_running` is deliberately absent. It counts the requests in the
 * current continuous batch, which is vLLM working normally, not a backlog: on
 * 2026-10-15 a replica sat at 20 running with 0 waiting and 1.9% KV usage, and both the
 * node and the autoscaler called that overloaded. A GPU was provisioned for nothing and
 * the topology was red while the model was nearly idle.
 *
 * What actually indicates pressure is requests that could not get into the batch, and
 * KV cache approaching full. The numbers match the thresholds RHOAI's own Workload
 * Variant Autoscaler ships with: queueLengthThreshold 5, kvCacheThreshold 0.80.
 */
export const PRESSURE = {
  queuedOverloaded: 5,
  kvOverloadedPercent: 80,
  queuedBusy: 1,
  kvBusyPercent: 50,
  /** Idle enough to give a replica back. */
  kvIdlePercent: 20,
} as const;

export function computeStatus(queued: number, kvCache: number): ModelStatus {
  if (queued > PRESSURE.queuedOverloaded || kvCache > PRESSURE.kvOverloadedPercent) return 'overloaded';
  if (queued >= PRESSURE.queuedBusy || kvCache > PRESSURE.kvBusyPercent) return 'busy';
  return 'healthy';
}

async function pollModelMetrics(models: ModelInfo[]) {
  const [running, waiting, kvCache, latency] = await Promise.all([
    query('vllm:num_requests_running'),
    query('vllm:num_requests_waiting'),
    query('vllm:kv_cache_usage_perc'),
    query('histogram_quantile(0.95, rate(vllm:e2e_request_latency_seconds_bucket[1m]))'),
  ]);

  const scaleMetrics: { model: string; queuedRequests: number; kvCachePercent: number }[] = [];

  for (const model of models) {
    if (model.type === 'external') continue;

    const baseName = stripMaasPrefix(model.name);
    const runningVal = running.find(r => String(r['model_name']) === baseName);
    const waitingVal = waiting.find(r => String(r['model_name']) === baseName);
    const kvVal = kvCache.find(r => String(r['model_name']) === baseName);
    const latVal = latency.find(r => String(r['model_name']) === baseName);

    // Kept apart on purpose: running is how many the batch is chewing through,
    // queued is how many could not get in. Only the second is back-pressure.
    const runningRequests = Number(runningVal?.value) || 0;
    const queuedRequests = Number(waitingVal?.value) || 0;
    const kvPercent = (Number(kvVal?.value) || 0) * 100;
    const latP95 = (Number(latVal?.value) || 0) * 1000;

    broadcast({
      type: 'model_status',
      model: model.name,
      runningRequests: Math.round(runningRequests),
      queuedRequests: Math.round(queuedRequests),
      latencyP95Ms: Math.round(latP95),
      kvCachePercent: Math.round(kvPercent),
      status: computeStatus(queuedRequests, kvPercent),
    });

    scaleMetrics.push({ model: baseName, queuedRequests, kvCachePercent: Math.round(kvPercent) });
  }

  await checkAndScale(scaleMetrics);
}

export function startPolling(models: ModelInfo[], intervalMs = 3000) {
  stopPolling();
  pollModelMetrics(models);
  pollInterval = setInterval(() => pollModelMetrics(models), intervalMs);
  console.log(`[prometheus] polling every ${intervalMs}ms`);
}

export function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}
