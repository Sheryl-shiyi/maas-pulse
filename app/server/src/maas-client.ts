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

export interface InferenceResult {
  answer: string;
  tokensUsed: number;
  latencyMs: number;
  rateLimited: boolean;
  retryAfterMs?: number;
  error?: string;
}

export async function sendInference(user: string, model: string, question: string, signal?: AbortSignal): Promise<InferenceResult> {
  const client = clients.get(user);
  if (!client) {
    return { answer: '', tokensUsed: 0, latencyMs: 0, rateLimited: false, error: `No API client for user ${user}` };
  }

  const start = performance.now();
  console.log(`[maas] ${user} → ${model}: sending request...`);
  try {
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: question }],
      max_tokens: 100,
    }, { signal });

    const latencyMs = Math.round(performance.now() - start);
    const answer = response.choices[0]?.message?.content ?? '';
    const tokensUsed = response.usage?.total_tokens ?? 0;

    console.log(`[maas] ${user} → ${model}: OK ${latencyMs}ms, ${tokensUsed} tokens`);
    return { answer, tokensUsed, latencyMs, rateLimited: false };
  } catch (err: unknown) {
    const latencyMs = Math.round(performance.now() - start);

    if (signal?.aborted) {
      return { answer: '', tokensUsed: 0, latencyMs, rateLimited: false, error: 'aborted' };
    }

    if (err instanceof OpenAI.APIError && err.status === 429) {
      const retryHeader = err.headers?.get?.('retry-after');
      const retryAfterMs = retryHeader ? parseFloat(retryHeader) * 1000 : undefined;
      return { answer: '', tokensUsed: 0, latencyMs, rateLimited: true, retryAfterMs };
    }

    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[maas] ${user} → ${model}: ${message}`);
    return { answer: '', tokensUsed: 0, latencyMs, rateLimited: false, error: message };
  }
}
