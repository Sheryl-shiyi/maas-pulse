import { query } from './prometheus.js';

export interface ModelRate {
  model: string;
  displayName: string;
  inputPer1M: number;
  outputPer1M: number;
}

export interface ChargebackRow {
  user: string;
  model: string;
  tokens: number;
  requests: number;
  rateLimited: number;
  costUsd: number;
}

export interface ChargebackResponse {
  rows: ChargebackRow[];
  totalTokens: number;
  totalRequests: number;
  totalRateLimited: number;
  totalCostUsd: number;
  modelRates: ModelRate[];
  timeRange: string;
}

const DEFAULT_RATES: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  'nemotron-3-nano-30b-a3b': { inputPer1M: 0.20, outputPer1M: 0.20 },
  'qwen3-8b-fp8': { inputPer1M: 0.10, outputPer1M: 0.10 },
  'gemini-3.1-flash-lite': { inputPer1M: 0.075, outputPer1M: 0.30 },
  'gpt-4.1-nano': { inputPer1M: 0.10, outputPer1M: 0.40 },
};

let modelRatesConfig: Record<string, { inputPer1M: number; outputPer1M: number }> = { ...DEFAULT_RATES };
let modelDisplayNames: Record<string, string> = {};
let knownModelNames: string[] = [];

export function initChargeback(models: Array<{ name: string; displayName: string }>) {
  for (const m of models) {
    modelDisplayNames[m.name] = m.displayName;
  }
  knownModelNames = Object.keys(modelRatesConfig);
  const envRates = process.env['MODEL_COST_RATES'];
  if (envRates) {
    try {
      const parsed = JSON.parse(envRates);
      modelRatesConfig = { ...DEFAULT_RATES, ...parsed };
      knownModelNames = Object.keys(modelRatesConfig);
    } catch {
      console.log('[chargeback] invalid MODEL_COST_RATES, using defaults');
    }
  }
}

export function updateModelRate(model: string, inputPer1M: number, outputPer1M: number) {
  modelRatesConfig[model] = { inputPer1M, outputPer1M };
}

function extractModelFromNamespace(ns: string): string {
  const stripped = ns.replace(/^llm\//, '');
  const cleaned = stripped.replace(/-kserve-route$/, '');
  for (const known of knownModelNames) {
    const knownDashed = known.replace(/\./g, '-');
    if (cleaned === known || cleaned === knownDashed) return known;
    if (cleaned.startsWith(knownDashed + '-') || cleaned.startsWith(known + '-')) return known;
  }
  return cleaned;
}

function resolveModel(result: Record<string, string | number>): string {
  if (result['model'] && String(result['model']) !== '') {
    return String(result['model']);
  }
  if (result['limitador_namespace']) {
    return extractModelFromNamespace(String(result['limitador_namespace']));
  }
  return 'unknown';
}

export async function getChargebackData(timeRange: string): Promise<ChargebackResponse> {
  const hitsQuery = timeRange === 'all'
    ? 'sum by (user, model) (authorized_hits)'
    : `sum by (user, model) (increase(authorized_hits[${timeRange}]))`;

  const callsQuery = timeRange === 'all'
    ? 'authorized_calls'
    : `increase(authorized_calls[${timeRange}])`;

  const limitedQuery = timeRange === 'all'
    ? 'limited_calls'
    : `increase(limited_calls[${timeRange}])`;

  const [hitsData, callsData, limitedData] = await Promise.all([
    query(hitsQuery),
    query(callsQuery),
    query(limitedQuery),
  ]);

  const rowMap = new Map<string, ChargebackRow>();

  for (const h of hitsData) {
    const user = String(h['user'] || 'unknown');
    const model = resolveModel(h as Record<string, string | number>);
    const key = `${user}|${model}`;
    const tokens = Math.round(Number(h['value']) || 0);
    const rate = modelRatesConfig[model];
    const costPer1M = rate ? (rate.inputPer1M + rate.outputPer1M) / 2 : 0.10;
    const costUsd = tokens * costPer1M / 1_000_000;

    rowMap.set(key, { user, model, tokens, requests: 0, rateLimited: 0, costUsd });
  }

  for (const c of callsData) {
    const user = String(c['user'] || 'unknown');
    const model = resolveModel(c as Record<string, string | number>);
    const key = `${user}|${model}`;
    const requests = Math.round(Number(c['value']) || 0);
    const existing = rowMap.get(key);
    if (existing) {
      existing.requests += requests;
    } else {
      rowMap.set(key, { user, model, tokens: 0, requests, rateLimited: 0, costUsd: 0 });
    }
  }

  for (const l of limitedData) {
    const user = String(l['user'] || 'unknown');
    const model = resolveModel(l as Record<string, string | number>);
    const key = `${user}|${model}`;
    const rateLimited = Math.round(Number(l['value']) || 0);
    const existing = rowMap.get(key);
    if (existing) {
      existing.rateLimited += rateLimited;
    }
  }

  const rows = Array.from(rowMap.values()).sort((a, b) => b.costUsd - a.costUsd);

  const totalTokens = rows.reduce((s, r) => s + r.tokens, 0);
  const totalRequests = rows.reduce((s, r) => s + r.requests, 0);
  const totalRateLimited = rows.reduce((s, r) => s + r.rateLimited, 0);
  const totalCostUsd = rows.reduce((s, r) => s + r.costUsd, 0);

  const modelRates: ModelRate[] = Object.entries(modelRatesConfig).map(([model, rate]) => ({
    model,
    displayName: modelDisplayNames[model] || model,
    inputPer1M: rate.inputPer1M,
    outputPer1M: rate.outputPer1M,
  }));

  return { rows, totalTokens, totalRequests, totalRateLimited, totalCostUsd, modelRates, timeRange };
}
