/**
 * Extra body fields sent with every chat completion for particular models.
 *
 * Some models need a knob that the other backends reject. Reasoning models are the
 * usual case: `reasoning_effort: "minimal"` is accepted by gpt-5-nano but refused by
 * vLLM, Gemini and even gpt-5.4-nano, so it cannot go on every request. It is set per
 * model instead, as JSON in MODEL_REQUEST_PARAMS:
 *
 *   {"gpt-5-nano": {"reasoning_effort": "minimal"}}
 *
 * Keys are the model names exactly as the generator sends them. Empty by default.
 *
 * Measured 2026-11-03: that setting did not rescue gpt-5-nano for this generator. On
 * every question in the pool it still spent all 100 tokens reasoning and returned an
 * empty (billed) answer, which is why the demo uses gpt-5.4-nano, which does not reason.
 */
export type RequestParams = Record<string, Record<string, unknown>>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse MODEL_REQUEST_PARAMS. Malformed input yields no extras rather than a crash. */
export function parseRequestParams(json: string | undefined): RequestParams {
  if (!json || !json.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    console.warn('[maas] MODEL_REQUEST_PARAMS is not valid JSON; sending no extra fields');
    return {};
  }
  if (!isPlainObject(parsed)) return {};
  const out: RequestParams = {};
  for (const [model, params] of Object.entries(parsed)) {
    if (isPlainObject(params)) out[model] = params;
  }
  return out;
}

/** The extra fields for one model; empty when it has none. */
export function paramsFor(model: string, params: RequestParams): Record<string, unknown> {
  return params[model] ?? {};
}
