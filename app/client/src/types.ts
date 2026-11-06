export interface ModelInfo {
  name: string;
  displayName: string;
  type: 'internal' | 'external';
}

export interface UserInfo {
  name: string;
  displayName: string;
  rateLimit: string;
  /** Subscription tier, used to band users together in the topology. */
  tier?: string;
}

export type ModelStatus = 'healthy' | 'busy' | 'overloaded';

/** Per-replica figures, ordered so a replica keeps its number across polls. */
export interface ReplicaStatus {
  runningRequests: number;
  queuedRequests: number;
  kvCachePercent: number;
  /** Prefix cache hit rate over the last couple of minutes, or null when this replica
   *  has served nothing recently and so has no hit rate to report. */
  cacheHitPercent: number | null;
  /** Whether this replica's vLLM has prefix caching enabled at all; null when unknown.
   *  False means the hit rate is not "idle" but simply not applicable. */
  prefixCaching: boolean | null;
  /** Tokens of context this replica's KV cache can hold; null when not reported. */
  kvCapacityTokens: number | null;
  /** Requests this replica finished per second over the last minute: where llm-d
   *  actually sent traffic, since responses do not name the replica that answered. */
  requestsPerSecond: number;
  /** ip:port, matching the gateway's `x-maas-upstream` for requests this replica served. */
  instance: string | null;
  status: ModelStatus;
}
export type PromptShape = 'short' | 'shared-prefix' | 'unique-prefix';
export type TrafficPattern = 'concurrent' | 'sequential' | 'random_burst';

export type ServerEvent =
  | { type: 'config'; models: ModelInfo[]; users: UserInfo[]; trafficRunning: boolean; eppWeights?: EppWeights | null }
  | { type: 'request_start'; requestId: string; user: string; model: string; question: string }
  | { type: 'request_complete'; requestId: string; user: string; model: string; latencyMs: number; tokensUsed: number; answer: string; upstream?: string; promptTokens?: number; cachedTokens?: number }
  /** `source`: the MaaS gateway's own limit, or the external provider's own rate limit. */
  | { type: 'rate_limited'; requestId: string; user: string; model: string; source?: LimitSource; message?: string }
  | { type: 'request_error'; requestId: string; user: string; model: string; error: string; status?: number }
  | { type: 'model_status'; model: string; runningRequests: number; queuedRequests: number; latencyP95Ms: number; kvCachePercent: number; status: ModelStatus; replicas: ReplicaStatus[] }
  | { type: 'rate_limit_reset'; user: string; model: string }
  | { type: 'rate_limit_update'; user: string; rateLimits: Record<string, string> }
  | { type: 'scale_update'; model: string; replicas: number; desiredReplicas: number }
  | { type: 'scale_event'; model: string; direction: 'up' | 'down'; from: number; to: number; summary: string; checks: ScaleCheck[]; at: number }
  | { type: 'traffic_started'; pattern: TrafficPattern }
  | { type: 'traffic_stopped' };

export type ClientEvent =
  | { type: 'start_traffic'; pattern: TrafficPattern; usersEnabled: string[]; modelsEnabled: string[]; ratePerSecond: number; promptShape?: PromptShape; promptTokens?: number }
  | { type: 'stop_traffic' };

export interface ActiveRequest {
  requestId: string;
  user: string;
  model: string;
  question: string;
  startTime: number;
  phase: 'to_gateway' | 'to_model' | 'returning';
  progress: number;
  /** Set when the gateway turned the request away, at which of its stages: the dot then
   *  bounces back from the gateway instead of going on to a model. */
  rejectedAt?: GatewayStage;
  /** Once answered: the replica that really served it (from the gateway's
   *  `x-maas-upstream`), and the share of its prompt vLLM took from the prefix cache. */
  servedReplica?: number;
  cachedFraction?: number;
}

export type LimitSource = 'gateway' | 'provider';

/** llm-d's scorer weights, from the chart's `epp.weights`. */
export interface EppWeights { queue: number; kvCache: number; prefixCache: number; noHitLru: number }

/** One condition the autoscaler checked, with the reading it compared. */
export interface ScaleCheck { label: string; value: number; limit: number; unit: string; tripped: boolean }

/** A scaling decision shown to the audience until someone dismisses it. */
export interface ScaleNotice {
  id: string;
  model: string;
  modelDisplayName: string;
  direction: 'up' | 'down';
  from: number;
  to: number;
  summary: string;
  checks: ScaleCheck[];
  /** Client clock (Date.now()) when the notice arrived. */
  at: number;
}

/** The checks the MaaS gateway applies to every request, in order. */
export type GatewayStage = 'auth' | 'access' | 'limit' | 'route' | 'meter';

export interface FeedEntry {
  id: string;
  user: string;
  model: string;
  question: string;
  answer: string;
  latencyMs: number;
  tokensUsed: number;
  timestamp: number;
  rateLimited?: boolean;
  /** A 429 from the external provider (its own rate limit), not from MaaS. */
  providerLimited?: boolean;
  /** Who served it, e.g. "Qwen3 8B #1", and how much of the prompt came from cache. */
  servedBy?: string;
  promptTokens?: number;
  cachedTokens?: number;
  providerMessage?: string;
  error?: string;
  status?: number;
}

export interface ModelState {
  name: string;
  displayName: string;
  type: 'internal' | 'external';
  status: ModelStatus;
  /** In the current continuous batch. Informative, not pressure. */
  runningRequests: number;
  /** Could not get into the batch. This is the back-pressure signal. */
  queuedRequests: number;
  latencyP95Ms: number;
  kvCachePercent: number;
  replicas: number;
  desiredReplicas: number;
  /** When the current scale-up was first seen (Date.now()), while a replica is starting. */
  scalingSince?: number;
  /** One entry per live replica, in display order. Empty until the first poll. */
  replicaStats: ReplicaStatus[];
}

export interface UserState {
  name: string;
  displayName: string;
  rateLimit: string;
  tier?: string;
  rateLimits: Record<string, string>;
  /** Models this user is paused on, and who imposed the pause. */
  rateLimitedModels: Record<string, LimitSource>;
  activeRequests: number;
}

export interface Stats {
  totalRequests: number;
  completedRequests: number;
  /** 429s from the MaaS gateway's own token limits. */
  rateLimitedRequests: number;
  errorRequests: number;
  /** Turned away by the gateway: 401 (not authenticated), 403 (no access to the model). */
  authRejected: number;
  accessDenied: number;
  /** Passed every check and was sent on to a model, whatever the model then answered. */
  routedRequests: number;
  totalTokens: number;
  avgLatencyMs: number;
}
