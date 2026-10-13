/**
 * One model has several spellings depending on which system reports it:
 *
 *   MaaS /v1/models        publishers/llm/models/qwen3-8b-fp8
 *   vLLM metric label      qwen3-8b-fp8
 *   Kuadrant namespace     llm/qwen3-8b-fp8-kserve-route
 *   external model CR      gemini-3.1-flash-lite      (dots)
 *   ExternalProvider       gemini-3-1-flash-lite      ($safeName, dashes)
 *   OpenAI response        gpt-4.1-nano-2025-04-14    (date suffix)
 *
 * Anything that joins data across those sources has to fold them back to one
 * canonical name first, or the same model shows up as two rows. These helpers
 * are the single place that happens; they are pure so they can be tested
 * without a cluster.
 */

const MAAS_PREFIX = /^publishers\/llm\/models\//;
const NAMESPACE_PREFIX = /^llm\//;
const ROUTE_SUFFIX = /-kserve-route$/;

/** `publishers/llm/models/qwen3-8b-fp8` -> `qwen3-8b-fp8`, to match vLLM's `model_name` label. */
export function stripMaasPrefix(name: string): string {
  return name.replace(MAAS_PREFIX, '');
}

/**
 * Fold a reported model name onto one of `known`, tolerating the dots-vs-dashes
 * difference and trailing suffixes such as a release date.
 *
 * Note: matching walks `known` in order and takes the first hit, so if one known
 * name is a dash-prefix of another (`qwen3-8b` and `qwen3-8b-fp8`), order decides.
 * The current model set has no such pair.
 */
export function normalizeModelName(name: string, known: string[]): string {
  for (const candidate of known) {
    const dashed = candidate.replace(/\./g, '-');
    if (name === candidate || name === dashed) return candidate;
    if (name.startsWith(candidate + '-') || name.startsWith(dashed + '-')) return candidate;
  }
  return name;
}

/**
 * Recover the model from a Kuadrant `limitador_namespace`, e.g.
 * `llm/qwen3-8b-fp8-kserve-route` -> `qwen3-8b-fp8`. Falls back to the cleaned
 * namespace when nothing matches, so an unknown model still gets its own row
 * rather than being silently merged into another.
 */
export function extractModelFromNamespace(namespace: string, known: string[]): string {
  const cleaned = namespace.replace(NAMESPACE_PREFIX, '').replace(ROUTE_SUFFIX, '');
  return normalizeModelName(cleaned, known);
}

/**
 * Pick the model for a Prometheus series. `authorized_hits` carries a `model`
 * label; `authorized_calls` and `limited_calls` do not, and only have
 * `limitador_namespace`.
 */
export function resolveModel(labels: Record<string, string | number>, known: string[]): string {
  if (labels['model'] !== undefined && String(labels['model']) !== '') {
    return normalizeModelName(String(labels['model']), known);
  }
  if (labels['limitador_namespace']) {
    return extractModelFromNamespace(String(labels['limitador_namespace']), known);
  }
  return 'unknown';
}
