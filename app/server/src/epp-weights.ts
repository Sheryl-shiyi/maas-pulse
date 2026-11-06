/** llm-d's scorer weights, as the chart configures the endpoint picker (`epp.weights`). */
export interface EppWeights {
  queue: number;
  kvCache: number;
  prefixCache: number;
  noHitLru: number;
}

/**
 * Parse `EPP_WEIGHTS`, the chart's `epp.weights` rendered as JSON, so the UI can show the
 * weights llm-d really uses instead of a copy that drifts. Null when absent or malformed:
 * the UI then leaves the weights out rather than show wrong ones.
 */
export function parseEppWeights(json: string | undefined): EppWeights | null {
  if (!json || !json.trim()) return null;
  try {
    const w = JSON.parse(json) as Record<string, unknown>;
    const num = (k: string) => (typeof w[k] === 'number' && Number.isFinite(w[k]) ? (w[k] as number) : NaN);
    const out = {
      queue: num('queueScorer'),
      kvCache: num('kvCacheUtilizationScorer'),
      prefixCache: num('prefixCacheScorer'),
      noHitLru: num('noHitLruScorer'),
    };
    return Object.values(out).every(v => !Number.isNaN(v)) ? out : null;
  } catch {
    return null;
  }
}
