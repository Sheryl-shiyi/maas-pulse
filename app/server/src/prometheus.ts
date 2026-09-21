import type { ModelInfo, ModelStatus } from './types.js';
import { broadcast } from './ws.js';

let prometheusUrl = '';
let bearerToken = '';
let pollInterval: ReturnType<typeof setInterval> | null = null;

export function initPrometheus(url: string, token: string) {
  prometheusUrl = url;
  bearerToken = token;
  console.log(`[prometheus] configured: ${url}`);
}

export async function query(promql: string): Promise<Record<string, string | number>[]> {
  if (!prometheusUrl) return [];

  try {
    const url = `${prometheusUrl}/api/v1/query?query=${encodeURIComponent(promql)}`;
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (bearerToken) {
      headers['Authorization'] = `Bearer ${bearerToken}`;
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

function computeStatus(queueDepth: number, kvCache: number): ModelStatus {
  if (queueDepth > 15 || kvCache > 90) return 'overloaded';
  if (queueDepth > 5 || kvCache > 70) return 'busy';
  return 'healthy';
}

async function pollModelMetrics(models: ModelInfo[]) {
  const [running, waiting, kvCache, latency] = await Promise.all([
    query('vllm:num_requests_running'),
    query('vllm:num_requests_waiting'),
    query('vllm:kv_cache_usage_perc'),
    query('histogram_quantile(0.95, rate(vllm:e2e_request_latency_seconds_bucket[1m]))'),
  ]);

  for (const model of models) {
    if (model.type === 'external') continue;

    const runningVal = running.find(r => String(r['model_name']).includes(model.name));
    const waitingVal = waiting.find(r => String(r['model_name']).includes(model.name));
    const kvVal = kvCache.find(r => String(r['model_name']).includes(model.name));
    const latVal = latency.find(r => String(r['model_name']).includes(model.name));

    const queueDepth = (Number(runningVal?.value) || 0) + (Number(waitingVal?.value) || 0);
    const kvPercent = (Number(kvVal?.value) || 0) * 100;
    const latP95 = (Number(latVal?.value) || 0) * 1000;

    broadcast({
      type: 'model_status',
      model: model.name,
      queueDepth,
      latencyP95Ms: Math.round(latP95),
      kvCachePercent: Math.round(kvPercent),
      status: computeStatus(queueDepth, kvPercent),
    });
  }
}

export function startPolling(models: ModelInfo[], intervalMs = 5000) {
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
