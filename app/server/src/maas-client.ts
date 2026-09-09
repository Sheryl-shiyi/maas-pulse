import https from 'https';
import OpenAI from 'openai';
import type { UserInfo } from './types.js';

const clients = new Map<string, OpenAI>();

export function initMaasClients(gatewayUrl: string, users: UserInfo[]) {
  clients.clear();
  const agent = new https.Agent({ keepAlive: false, rejectUnauthorized: false });
  for (const user of users) {
    clients.set(user.name, new OpenAI({
      baseURL: `${gatewayUrl}/v1`,
      apiKey: user.apiKey,
      timeout: 30000,
      maxRetries: 1,
      httpAgent: agent,
    }));
  }
  console.log(`[maas] initialized ${clients.size} API clients for ${gatewayUrl}`);
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
  const client = clients.get(user);
  if (!client) {
    return { answer: '', tokensUsed: 0, latencyMs: 0, rateLimited: false, error: `No API client for user ${user}` };
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
    console.error(`[maas] ${user} → ${model}: ${message}`);
    return { answer: '', tokensUsed: 0, latencyMs, rateLimited: false, error: message };
  }
}
