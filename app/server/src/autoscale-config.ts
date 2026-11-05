/** One model the autoscaler may resize, and the range it may resize it within. */
export interface AutoscaleModelConfig {
  name: string;
  minReplicas: number;
  maxReplicas: number;
}

/**
 * Parse `AUTOSCALE_MODELS`: comma-separated `name:min:max` entries, rendered by the chart
 * from `autoscaling.models`. Each model carries its own range because each is bound by
 * its own hardware: Qwen3 has one spare A10G, so it may go to 2, while a second Nemotron
 * replica would wait forever for an L40S that does not exist. (The chart used to send one
 * maximum, taken from the first model, for all of them.)
 *
 * A bare `name` keeps the old behaviour: minimum 1, maximum `defaultMax`. An entry that
 * does not parse, or whose range is impossible, is skipped with a warning rather than
 * guessed at, so a typo can never let the autoscaler ask for GPUs nobody has.
 */
export function parseAutoscaleModels(spec: string | undefined, defaultMax: number): AutoscaleModelConfig[] {
  const out: AutoscaleModelConfig[] = [];
  for (const raw of (spec ?? '').split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const parts = entry.split(':').map(p => p.trim());
    const name = parts[0]!;
    const nums = parts.slice(1).map(p => (/^\d+$/.test(p) ? Number(p) : NaN));
    const [min, max] = nums.length === 0 ? [1, defaultMax]
      : nums.length === 1 ? [1, nums[0]!]
      : nums.length === 2 ? [nums[0]!, nums[1]!]
      : [NaN, NaN];
    if (!name || !Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) {
      console.warn(`[autoscaler] ignoring AUTOSCALE_MODELS entry "${entry}": expected name:min:max with 1 <= min <= max`);
      continue;
    }
    out.push({ name, minReplicas: min, maxReplicas: max });
  }
  return out;
}
