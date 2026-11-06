export interface ModelInfo {
  name: string;
  displayName: string;
  type: 'internal' | 'external';
}

export interface UserInfo {
  name: string;
  displayName: string;
  /** Empty when the user authenticates with a ServiceAccount token instead. */
  apiKey: string;
  /** `namespace/name` of the ServiceAccount backing this user, if any. */
  serviceAccount?: string;
  rateLimit: string;
  group: string;
  /** Subscription tier, used to group users in the UI. */
  tier?: string;
}

import type { PromptShape } from './questions.js';

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
  /** This replica's address as vLLM's metrics label it (ip:port), the value the gateway puts
   *  in `x-maas-upstream` for requests it served. */
  instance: string | null;
  status: ModelStatus;
}
export type TrafficPattern = 'concurrent' | 'sequential' | 'random_burst';

export type ServerEvent =
  | { type: 'config'; models: ModelInfo[]; users: Omit<UserInfo, 'apiKey' | 'group'>[]; trafficRunning: boolean }

  | { type: 'request_start'; requestId: string; user: string; model: string; question: string }
  /** `upstream`: the pod that served it (ip:port); `cachedTokens` of `promptTokens` came from
   *  vLLM's prefix cache. Absent when the gateway or model did not report them. */
  | { type: 'request_complete'; requestId: string; user: string; model: string; latencyMs: number; tokensUsed: number; answer: string;
      upstream?: string; promptTokens?: number; cachedTokens?: number }
  /** `source`: the MaaS gateway's own limit, or the external provider's own rate limit. */
  | { type: 'rate_limited'; requestId: string; user: string; model: string; source: 'gateway' | 'provider'; message?: string }
  | { type: 'request_error'; requestId: string; user: string; model: string; error: string; status?: number }
  | { type: 'model_status'; model: string; runningRequests: number; queuedRequests: number; latencyP95Ms: number; kvCachePercent: number; status: ModelStatus; replicas: ReplicaStatus[] }
  | { type: 'rate_limit_reset'; user: string; model: string }
  | { type: 'rate_limit_update'; user: string; rateLimits: Record<string, string> }
  | { type: 'scale_update'; model: string; replicas: number; desiredReplicas: number }
  /** The autoscaler changed replicas, and why: each condition it checked and its reading. */
  | { type: 'scale_event'; model: string; direction: 'up' | 'down'; from: number; to: number; summary: string;
      checks: { label: string; value: number; limit: number; unit: string; tripped: boolean }[]; at: number }
  | { type: 'traffic_started'; pattern: TrafficPattern }
  | { type: 'traffic_stopped' };

export type ClientEvent =
  | { type: 'start_traffic'; pattern: TrafficPattern; usersEnabled: string[]; modelsEnabled: string[]; ratePerSecond: number; promptShape?: PromptShape; promptTokens?: number }
  | { type: 'stop_traffic' };

export interface TrafficConfig {
  pattern: TrafficPattern;
  usersEnabled: string[];
  modelsEnabled: string[];
  ratePerSecond: number;
  /** How much context each request carries; see PromptShape in questions.ts. */
  promptShape: PromptShape;
  /** Approximate prompt length in tokens for the two long shapes. */
  promptTokens: number;
}

export interface AppConfig {
  maasGatewayUrl: string;
  prometheusUrl: string;
  models: ModelInfo[];
  users: UserInfo[];
}
