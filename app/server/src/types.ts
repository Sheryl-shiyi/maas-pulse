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
  status: ModelStatus;
}
export type TrafficPattern = 'concurrent' | 'sequential' | 'random_burst';

export type ServerEvent =
  | { type: 'config'; models: ModelInfo[]; users: Omit<UserInfo, 'apiKey' | 'group'>[]; trafficRunning: boolean }

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
