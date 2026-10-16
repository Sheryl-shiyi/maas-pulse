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
  status: ModelStatus;
}
export type PromptShape = 'short' | 'shared-prefix' | 'unique-prefix';
export type TrafficPattern = 'concurrent' | 'sequential' | 'random_burst';

export type ServerEvent =
  | { type: 'config'; models: ModelInfo[]; users: UserInfo[]; trafficRunning: boolean }
  | { type: 'request_start'; requestId: string; user: string; model: string; question: string }
  | { type: 'request_complete'; requestId: string; user: string; model: string; latencyMs: number; tokensUsed: number; answer: string }
  | { type: 'rate_limited'; requestId: string; user: string; model: string }
  | { type: 'request_error'; requestId: string; user: string; model: string; error: string; status?: number }
  | { type: 'model_status'; model: string; runningRequests: number; queuedRequests: number; latencyP95Ms: number; kvCachePercent: number; status: ModelStatus; replicas: ReplicaStatus[] }
  | { type: 'rate_limit_reset'; user: string; model: string }
  | { type: 'rate_limit_update'; user: string; rateLimits: Record<string, string> }
  | { type: 'scale_update'; model: string; replicas: number; desiredReplicas: number }
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
}

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
  /** One entry per live replica, in display order. Empty until the first poll. */
  replicaStats: ReplicaStatus[];
}

export interface UserState {
  name: string;
  displayName: string;
  rateLimit: string;
  tier?: string;
  rateLimits: Record<string, string>;
  rateLimitedModels: Record<string, boolean>;
  activeRequests: number;
}

export interface Stats {
  totalRequests: number;
  completedRequests: number;
  rateLimitedRequests: number;
  errorRequests: number;
  totalTokens: number;
  avgLatencyMs: number;
}
