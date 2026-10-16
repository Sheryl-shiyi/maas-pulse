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

/**
 * Stable ordering of the pods backing each model, so a replica keeps its number.
 *
 * The UI labels boxes #1, #2 and draws them in this order. Sorting by pod name would
 * let a newly created pod sort ahead of the existing one and appear to be #1, which
 * reads as the established replica resetting. Appending on first sight gives what the
 * eye expects: the incumbent stays #1, the new one shows up beneath it.
 */
const podOrder = new Map<string, string[]>();

export function orderedPods(model: string, seen: string[]): string[] {
  const known = podOrder.get(model) ?? [];
  const kept = known.filter(p => seen.includes(p));
  for (const p of seen) if (!kept.includes(p)) kept.push(p);
  podOrder.set(model, kept);
  return kept;
}

/**
 * Window for the prefix cache hit rate.
 *
 * Deliberately not the raw counters: those are cumulative since the pod started, so a
 * replica that was warm an hour ago keeps looking warm while it serves nothing. A rate
 * over a short window answers the question the topology is actually asking — is this
 * replica getting cache hits *now* — which is what makes a freshly scaled-up pod look
 * different from the one it joined.
 */
const CACHE_RATE_WINDOW = '2m';

async function pollModelMetrics(models: ModelInfo[]) {
  const [running, waiting, kvCache, latency, cacheHits, cacheQueries] = await Promise.all([
    query('vllm:num_requests_running'),
    query('vllm:num_requests_waiting'),
    query('vllm:kv_cache_usage_perc'),
    query('histogram_quantile(0.95, rate(vllm:e2e_request_latency_seconds_bucket[1m]))'),
    query(`rate(vllm:prefix_cache_hits_total[${CACHE_RATE_WINDOW}])`),
    query(`rate(vllm:prefix_cache_queries_total[${CACHE_RATE_WINDOW}])`),
  ]);

  const scaleMetrics: { model: string; queuedRequests: number; kvCachePercent: number }[] = [];

  for (const model of models) {
    if (model.type === 'external') continue;

    const baseName = stripMaasPrefix(model.name);
    const mine = (rows: Record<string, string | number>[]) =>
      rows.filter(r => String(r['model_name']) === baseName);
    const byPod = (rows: Record<string, string | number>[]) =>
      new Map(mine(rows).map(r => [String(r['pod'] ?? ''), Number(r['value']) || 0]));

    const runningByPod = byPod(running);
    const waitingByPod = byPod(waiting);
    const kvByPod = byPod(kvCache);
    const hitsByPod = byPod(cacheHits);
    const queriesByPod = byPod(cacheQueries);

    const pods = orderedPods(baseName, [...new Set([
      ...runningByPod.keys(), ...waitingByPod.keys(), ...kvByPod.keys(),
    ])].filter(Boolean));

    const perReplica = pods.map(pod => {
      const r = runningByPod.get(pod) ?? 0;
      const q = waitingByPod.get(pod) ?? 0;
      const kv = (kvByPod.get(pod) ?? 0) * 100;
      // Null rather than zero when nothing was looked up: an idle replica has no hit
      // rate, and drawing that as 0% would claim its cache is cold when it may be warm.
      const queries = queriesByPod.get(pod) ?? 0;
      const hitPercent = queries > 0
        ? Math.round(((hitsByPod.get(pod) ?? 0) / queries) * 100)
        : null;
      return {
        runningRequests: Math.round(r),
        queuedRequests: Math.round(q),
        kvCachePercent: Math.round(kv),
        cacheHitPercent: hitPercent,
        status: computeStatus(q, kv),
      };
    });

    // Model-level figures summarise the replicas rather than picking one of them, which
    // is what an earlier `.find()` did: every replica box showed the first replica's
    // numbers, so a cold new replica appeared as busy as the one it was meant to
    // relieve. Queued sums because the backlog is shared; KV takes the maximum because
    // one replica near full is pressure even if another is empty.
    const runningRequests = [...runningByPod.values()].reduce((a, b) => a + b, 0);
    const queuedRequests = [...waitingByPod.values()].reduce((a, b) => a + b, 0);
    const kvPercent = Math.max(0, ...[...kvByPod.values()].map(v => v * 100));
    const latVal = latency.find(r => String(r['model_name']) === baseName);
    const latP95 = (Number(latVal?.value) || 0) * 1000;

    broadcast({
      type: 'model_status',
      model: model.name,
      runningRequests: Math.round(runningRequests),
      queuedRequests: Math.round(queuedRequests),
      latencyP95Ms: Math.round(latP95),
      kvCachePercent: Math.round(kvPercent),
      status: computeStatus(queuedRequests, kvPercent),
      replicas: perReplica,
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
