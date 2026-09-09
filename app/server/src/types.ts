export interface ModelInfo {
  name: string;
  displayName: string;
  type: 'internal' | 'external';
}

export interface UserInfo {
  name: string;
  displayName: string;
  apiKey: string;
  rateLimit: string;
  group: string;
}

export type ModelStatus = 'healthy' | 'busy' | 'overloaded';
export type TrafficPattern = 'concurrent' | 'sequential' | 'random_burst';

export type ServerEvent =
  | { type: 'config'; models: ModelInfo[]; users: Omit<UserInfo, 'apiKey' | 'group'>[] }

  | { type: 'request_start'; requestId: string; user: string; model: string; question: string }
  | { type: 'request_complete'; requestId: string; user: string; model: string; latencyMs: number; tokensUsed: number; answer: string }
  | { type: 'rate_limited'; requestId: string; user: string; model: string }
  | { type: 'request_error'; requestId: string; user: string; model: string; error: string }
  | { type: 'model_status'; model: string; queueDepth: number; latencyP95Ms: number; kvCachePercent: number; status: ModelStatus }
  | { type: 'rate_limit_reset'; user: string }
  | { type: 'rate_limit_update'; user: string; rateLimits: Record<string, string> }
  | { type: 'traffic_started'; pattern: TrafficPattern }
  | { type: 'traffic_stopped' };

export type ClientEvent =
  | { type: 'start_traffic'; pattern: TrafficPattern; usersEnabled: string[]; modelsEnabled: string[]; ratePerSecond: number }
  | { type: 'stop_traffic' };

export interface TrafficConfig {
  pattern: TrafficPattern;
  usersEnabled: string[];
  modelsEnabled: string[];
  ratePerSecond: number;
}

export interface AppConfig {
  maasGatewayUrl: string;
  prometheusUrl: string;
  models: ModelInfo[];
  users: UserInfo[];
}
