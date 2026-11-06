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

/**
 * Whether each replica of a model has prefix caching enabled, from vLLM's own
 * `vllm:cache_config_info` gauge (label `enable_prefix_caching`, "True"/"False").
 *
 * Without this a replica with caching off was indistinguishable from an idle one: both
 * have no hit rate, so Nemotron, which is a hybrid Mamba model that vLLM before 0.26 does
 * not prefix-cache by default, sat captioned "idle" while serving 30 requests. Absent from
 * the map means unknown (older vLLM, or not scraped yet).
 *
 * Keyed by pod alone: unlike the other vLLM series, this gauge carries no `model_name`
 * label (it has `pod`, `namespace`, `engine` and the cache settings). Pod names are
 * unique, and the caller looks up the pods it already attributed to a model.
 */
export function prefixCachingByPod(rows: Record<string, string | number>[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const r of rows) {
    const flag = String(r['enable_prefix_caching'] ?? '').toLowerCase();
    if (flag === 'true' || flag === 'false') out.set(String(r['pod'] ?? ''), flag === 'true');
  }
  return out;
}

/**
 * How many tokens of context each replica's KV cache can hold, from the same
 * `vllm:cache_config_info` gauge (label `kv_cache_size_tokens`, set by vLLM after it has
 * sized the cache: GPU memory left after the weights, in tokens). It turns "KV cache 1%"
 * into something an audience can picture: 1% of room for 74,432 tokens. Keyed by pod;
 * absent when this vLLM does not report it.
 */
export function kvCapacityByPod(rows: Record<string, string | number>[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const n = Number(r['kv_cache_size_tokens']);
    if (Number.isFinite(n) && n > 0) out.set(String(r['pod'] ?? ''), n);
  }
  return out;
}

/**
 * Each pod's address as vLLM's metrics label it (`instance`, ip:port). The gateway names
 * the backend that served a response in the same form (`x-maas-upstream`), so this is how
 * a response is matched to the replica that produced it, without asking Kubernetes.
 */
export function instanceByPod(rows: Record<string, string | number>[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    const pod = String(r['pod'] ?? '');
    const instance = String(r['instance'] ?? '');
    if (pod && instance) out.set(pod, instance);
  }
  return out;
}

/**
 * Window for the speed readings. Shorter than the others on purpose: in the demo the
 * audience watches the first-token time climb as long prompts arrive and fall again as
 * the cache warms, and a one-minute average lags that by most of a scene. vLLM pods are
 * scraped every 5 s, so 30 s still holds six samples.
 */
const SPEED_WINDOW = '30s';

/**
 * Average of a vLLM histogram per pod over the window: rate of its `_sum` divided by
 * rate of its `_count`. Exact, unlike `histogram_quantile`, which interpolates inside
 * vLLM's coarse buckets (0.25 s to 0.5 s is one bucket for the first-token time).
 * A pod that finished nothing in the window is absent rather than zero: it has no
 * speed to report, and zero would read as instant.
 */
export function meanByPod(
  sums: Record<string, string | number>[],
  counts: Record<string, string | number>[],
): Map<string, number> {
  const countByPod = new Map(counts.map(r => [String(r['pod'] ?? ''), Number(r['value'])]));
  const out = new Map<string, number>();
  for (const r of sums) {
    const pod = String(r['pod'] ?? '');
    const n = countByPod.get(pod) ?? 0;
    const total = Number(r['value']);
    if (pod && n > 0 && Number.isFinite(total)) out.set(pod, total / n);
  }
  return out;
}

async function pollModelMetrics(models: ModelInfo[]) {
  const [running, waiting, kvCache, latency, cacheHits, cacheQueries, cacheConfig, served] = await Promise.all([
    query('vllm:num_requests_running'),
    query('vllm:num_requests_waiting'),
    query('vllm:kv_cache_usage_perc'),
    query('histogram_quantile(0.95, rate(vllm:e2e_request_latency_seconds_bucket[1m]))'),
    query(`rate(vllm:prefix_cache_hits_total[${CACHE_RATE_WINDOW}])`),
    query(`rate(vllm:prefix_cache_queries_total[${CACHE_RATE_WINDOW}])`),
    query('vllm:cache_config_info'),
    // Requests each replica actually finished in the last minute. The only record of
    // where llm-d sent traffic: responses do not say which replica answered.
    query('sum by (pod, model_name) (rate(vllm:request_success_total[1m]))'),
  ]);
  // How fast each replica answers: time to the first token, the pace of each answer
  // once it is going, and all the answer tokens the replica produces together.
  const [ttftSum, ttftCount, itlSum, itlCount, generated] = await Promise.all([
    query(`sum by (pod, model_name) (rate(vllm:time_to_first_token_seconds_sum[${SPEED_WINDOW}]))`),
    query(`sum by (pod, model_name) (rate(vllm:time_to_first_token_seconds_count[${SPEED_WINDOW}]))`),
    query(`sum by (pod, model_name) (rate(vllm:inter_token_latency_seconds_sum[${SPEED_WINDOW}]))`),
    query(`sum by (pod, model_name) (rate(vllm:inter_token_latency_seconds_count[${SPEED_WINDOW}]))`),
    query(`sum by (pod, model_name) (rate(vllm:generation_tokens_total[${SPEED_WINDOW}]))`),
  ]);

  const scaleMetrics: { model: string; queuedRequests: number; kvCachePercent: number }[] = [];
  const cachingByPod = prefixCachingByPod(cacheConfig);
  const capacityByPod = kvCapacityByPod(cacheConfig);

  for (const model of models) {
    if (model.type === 'external') continue;

    const baseName = stripMaasPrefix(model.name);
    const mine = (rows: Record<string, string | number>[]) =>
      rows.filter(r => String(r['model_name']) === baseName);
    const byPod = (rows: Record<string, string | number>[]) =>
      new Map(mine(rows).map(r => [String(r['pod'] ?? ''), Number(r['value']) || 0]));

    const runningByPod = byPod(running);
    const instances = instanceByPod(mine(running));
    const waitingByPod = byPod(waiting);
    const kvByPod = byPod(kvCache);
    const hitsByPod = byPod(cacheHits);
    const queriesByPod = byPod(cacheQueries);
    const servedByPod = byPod(served);
    const ttftByPod = meanByPod(mine(ttftSum), mine(ttftCount));
    const itlByPod = meanByPod(mine(itlSum), mine(itlCount));
    const generatedByPod = byPod(generated);

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
        prefixCaching: cachingByPod.get(pod) ?? null,
        kvCapacityTokens: capacityByPod.get(pod) ?? null,
        requestsPerSecond: Math.round((servedByPod.get(pod) ?? 0) * 100) / 100,
        instance: instances.get(pod) ?? null,
        firstTokenSeconds: roundOrNull(ttftByPod.get(pod), 100),
        // One token every N seconds per answer, turned into answer tokens per second.
        perRequestTokensPerSecond: roundOrNull(itlByPod.has(pod) && itlByPod.get(pod)! > 0 ? 1 / itlByPod.get(pod)! : undefined, 1),
        outputTokensPerSecond: Math.round(generatedByPod.get(pod) ?? 0),
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

function roundOrNull(v: number | undefined, scale: number): number | null {
  return v === undefined || !Number.isFinite(v) ? null : Math.round(v * scale) / scale;
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
