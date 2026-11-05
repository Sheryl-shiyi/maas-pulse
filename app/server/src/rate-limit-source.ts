/**
 * Who refused a request with a 429: the MaaS gateway's own token rate limit, or the
 * external provider behind it.
 *
 * The gateway answers from Limitador with a plain-text "Too Many Requests", so the
 * OpenAI SDK has no error object for it. Providers answer with a JSON error, which the
 * SDK keeps on `err.error`: Google said "You exceeded your current quota", OpenAI says
 * "Rate limit reached". Measured on 2026-11-04, while the demo still used a free Gemini
 * key and its 429s were being shown as a MaaS block on every user, admin and Max
 * included. A paid key still has rate limits, so the distinction stays.
 */
export type LimitedBy = 'gateway' | 'provider';

export function limitedBy(errorBody: unknown): { by: LimitedBy; message?: string } {
  if (errorBody !== null && typeof errorBody === 'object') {
    const message = (errorBody as { message?: unknown }).message;
    return { by: 'provider', message: typeof message === 'string' ? message : undefined };
  }
  return { by: 'gateway' };
}
