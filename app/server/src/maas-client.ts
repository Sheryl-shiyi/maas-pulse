import https from 'https';
import OpenAI from 'openai';
import type { UserInfo } from './types.js';
import { getIdentityToken, type IdentityRef } from './sa-token.js';

const clients = new Map<string, OpenAI>();
/** Users whose bearer is a minted ServiceAccount token rather than a stored key. */
const identities = new Map<string, IdentityRef>();
/** The token each ServiceAccount-backed client was built with, so it can be rebuilt. */
const clientTokens = new Map<string, string>();

let agent: https.Agent;
let baseUrl = '';

export function initMaasClients(gatewayUrl: string, users: UserInfo[]) {
  clients.clear();
  identities.clear();
  clientTokens.clear();
  baseUrl = `${gatewayUrl}/v1`;
  agent = new https.Agent({ keepAlive: false, rejectUnauthorized: false });

  let saCount = 0;
  for (const user of users) {
    if (user.serviceAccount) {
      identities.set(user.name, user.serviceAccount);
      saCount++;
      continue; // its client is built on first use, once a token exists
    }
    clients.set(user.name, buildClient(user.apiKey));
  }
  console.log(
    `[maas] initialized ${users.length} identities for ${gatewayUrl}` +
    ` (${saCount} ServiceAccount, ${users.length - saCount} API key)`,
  );
}

/** The `sub` claim of a JWT, for confirming which identity a bearer actually carries. */
function tokenSubject(token: string): string {
  try {
    const payload = token.split('.')[1];
    if (!payload) return '<not a jwt>';
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string };
    return json.sub ?? '<no sub>';
  } catch {
    return '<undecodable>';
  }
}

function buildClient(bearer: string): OpenAI {
  return new OpenAI({
    baseURL: baseUrl,
    apiKey: bearer,
    timeout: 30000,
    maxRetries: 1,
    httpAgent: agent,
  });
}

/**
 * The client for a user, with a current bearer.
 *
 * ServiceAccount-backed users get their client rebuilt whenever the minted token
 * changes. An earlier attempt passed the token as a per-request header instead and
 * produced intermittent 401s — the SDK does not reliably carry request headers through
 * its retry, so some attempts went out with the placeholder key. Letting the SDK own
 * the Authorization header is the path that actually works.
 */
async function clientFor(user: string): Promise<OpenAI | undefined> {
  const identity = identities.get(user);
  if (!identity) return clients.get(user);

  const token = await getIdentityToken(identity);
  if (clientTokens.get(user) !== token) {
    clients.set(user, buildClient(token));
    clientTokens.set(user, token);
    console.log(`[maas] ${user}: new token for ${identity}, sub=${tokenSubject(token)}, len=${token.length}`);
  }
  return clients.get(user);
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number;
}

export interface InferenceResult {
  answer: string;
  tokensUsed: number;
  latencyMs: number;
  rateLimited: boolean;
  retryAfterMs?: number;
  error?: string;
  /** HTTP status when the gateway rejected the call, so the UI can tell a revoked
   *  key (403) apart from a server fault (5xx) instead of showing a bare "ERR". */
  status?: number;
  rateLimitInfo?: RateLimitInfo;
}

function parseRateLimitHeaders(headers: { get(name: string): string | null }): RateLimitInfo | undefined {
  const limitStr = headers.get('ratelimit-limit');
  if (!limitStr) return undefined;

  const limit = parseInt(limitStr.split(',')[0]!.trim(), 10);
  if (isNaN(limit)) return undefined;

  const remainingStr = headers.get('ratelimit-remaining');
  const remaining = remainingStr ? parseInt(remainingStr, 10) : limit;

  const resetStr = headers.get('ratelimit-reset');
  const reset = resetStr ? parseInt(resetStr, 10) : 0;

  return { limit, remaining: isNaN(remaining) ? limit : remaining, reset: isNaN(reset) ? 0 : reset };
}

export async function sendInference(user: string, model: string, question: string, signal?: AbortSignal): Promise<InferenceResult> {
  let client: OpenAI | undefined;
  try {
    client = await clientFor(user);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[maas] ${user}: could not obtain a token: ${message}`);
    return { answer: '', tokensUsed: 0, latencyMs: 0, rateLimited: false, error: message };
  }
  if (!client) {
    return { answer: '', tokensUsed: 0, latencyMs: 0, rateLimited: false, error: `No client for user ${user}` };
  }

  const start = performance.now();
  console.log(`[maas] ${user} → ${model}: sending request...`);
  try {
    const { data: completion, response: rawResponse } = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: question }],
      max_tokens: 100,
    }, { signal }).withResponse();

    const latencyMs = Math.round(performance.now() - start);
    const answer = completion.choices[0]?.message?.content ?? '';
    const tokensUsed = completion.usage?.total_tokens ?? 0;
    const rateLimitInfo = parseRateLimitHeaders(rawResponse.headers);

    console.log(`[maas] ${user} → ${model}: OK ${latencyMs}ms, ${tokensUsed} tokens`);
    return { answer, tokensUsed, latencyMs, rateLimited: false, rateLimitInfo };
  } catch (err: unknown) {
    const latencyMs = Math.round(performance.now() - start);

    if (signal?.aborted) {
      return { answer: '', tokensUsed: 0, latencyMs, rateLimited: false, error: 'aborted' };
    }

    if (err instanceof OpenAI.APIError && err.status === 429) {
      const headers = err.headers;
      const retryHeader = typeof headers?.get === 'function' ? headers.get('retry-after') : null;
      const retryAfterMs = retryHeader ? parseFloat(retryHeader) * 1000 : undefined;
      const rateLimitInfo = headers && typeof headers.get === 'function' ? parseRateLimitHeaders(headers) : undefined;
      console.log(`[maas] ${user} → ${model}: 429 rate limited`);
      return { answer: '', tokensUsed: 0, latencyMs, rateLimited: true, retryAfterMs, rateLimitInfo };
    }

    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = err instanceof OpenAI.APIError ? err.status : undefined;
    console.error(`[maas] ${user} → ${model}: ${message}`);
    return { answer: '', tokensUsed: 0, latencyMs, rateLimited: false, error: message, status };
  }
}
