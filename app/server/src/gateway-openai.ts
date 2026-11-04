import OpenAI from 'openai';

type ErrorHeaders = Record<string, string | null | undefined>;

/**
 * The OpenAI client, tolerant of providers that wrap their error body in an array.
 *
 * Gemini's OpenAI-compatible endpoint answers errors with `[{"error": {...}}]`, and the
 * MaaS gateway passes that through unchanged. The SDK only looks for `error` on an
 * object, so it found nothing; and because the body was valid JSON it did not fall back
 * to the raw text either. Every Gemini 503 or 429 therefore reached the live feed as
 * "503 status code (no body)", which reads like a gateway fault. Handing the SDK the
 * first element gives it the shape it expects, so the feed shows Google's own words
 * ("The model is overloaded", a quota message, ...).
 */
export class GatewayOpenAI extends OpenAI {
  protected override makeStatusError(
    status: number | undefined,
    error: object | undefined,
    message: string | undefined,
    headers: ErrorHeaders | undefined,
  ) {
    return super.makeStatusError(status, unwrapErrorBody(error), message, headers);
  }
}

/** `[{"error": {...}}]` becomes `{"error": {...}}`; anything else is left alone. */
export function unwrapErrorBody(body: object | undefined): object | undefined {
  if (Array.isArray(body) && body.length > 0 && typeof body[0] === 'object' && body[0] !== null) {
    return body[0] as object;
  }
  return body;
}
