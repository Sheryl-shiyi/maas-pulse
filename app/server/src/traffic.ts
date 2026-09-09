import { randomUUID } from 'crypto';
import { setMaxListeners } from 'events';
import { broadcast } from './ws.js';
import { sendInference } from './maas-client.js';
import { getRandomQuestion } from './questions.js';
import type { TrafficConfig } from './types.js';

let running = false;
let abortController: AbortController | null = null;
const pending = new Set<Promise<void>>();
const rateLimitedUntil = new Map<string, number>();
const DEFAULT_COOLDOWN_MS = 60_000;

export function isRunning() {
  return running;
}

function cooldownKey(user: string, model: string): string {
  return `${user}\0${model}`;
}

function isModelCoolingDown(user: string, model: string): boolean {
  const key = cooldownKey(user, model);
  const until = rateLimitedUntil.get(key);
  if (!until) return false;
  if (Date.now() >= until) {
    rateLimitedUntil.delete(key);
    broadcast({ type: 'rate_limit_reset', user, model });
    console.log(`[traffic] ${user} cooldown for ${model} expired, resuming`);
    return false;
  }
  return true;
}

export async function startTraffic(config: TrafficConfig) {
  if (running) return;
  if (config.usersEnabled.length === 0 || config.modelsEnabled.length === 0) {
    console.error('[traffic] cannot start: no users or models enabled');
    return;
  }
  running = true;
  abortController = new AbortController();
  setMaxListeners(100, abortController.signal);

  broadcast({ type: 'traffic_started', pattern: config.pattern });
  console.log(`[traffic] started: pattern=${config.pattern}, rate=${config.ratePerSecond}/s, users=${config.usersEnabled.join(',')}, models=${config.modelsEnabled.join(',')}`);

  try {
    switch (config.pattern) {
      case 'concurrent':
        await runConcurrent(config);
        break;
      case 'sequential':
        await runSequential(config);
        break;
      case 'random_burst':
        await runRandomBurst(config);
        break;
    }
  } catch {
    // aborted
  } finally {
    await Promise.allSettled(pending);
    pending.clear();
    if (running) {
      running = false;
      broadcast({ type: 'traffic_stopped' });
    }
    console.log('[traffic] stopped');
  }
}

export function stopTraffic() {
  if (!running && !abortController) return;
  abortController?.abort();
  abortController = null;
  running = false;
  broadcast({ type: 'traffic_stopped' });
  console.log('[traffic] stop requested');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }, { once: true });
  });
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function launchRequest(user: string, model: string, signal: AbortSignal) {
  if (isModelCoolingDown(user, model)) return;
  const p = fireRequest(user, model, signal);
  pending.add(p);
  p.finally(() => pending.delete(p));
}

function formatRateLimit(limit: number, remaining: number): string {
  const fmt = (n: number) => n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
  return `${fmt(remaining)}/${fmt(limit)}`;
}

async function fireRequest(user: string, model: string, signal: AbortSignal) {
  if (signal.aborted || isModelCoolingDown(user, model)) return;

  const requestId = randomUUID();
  const question = getRandomQuestion();

  try {
    broadcast({ type: 'request_start', requestId, user, model, question });

    const result = await sendInference(user, model, question, signal);

    if (signal.aborted || isModelCoolingDown(user, model)) return;

    if (result.rateLimitInfo) {
      const rateLimit = formatRateLimit(result.rateLimitInfo.limit, result.rateLimitInfo.remaining);
      broadcast({ type: 'rate_limit_update', user, rateLimits: { [model]: rateLimit } });
    }

    if (result.rateLimited) {
      const cooldownMs = result.retryAfterMs || DEFAULT_COOLDOWN_MS;
      rateLimitedUntil.set(cooldownKey(user, model), Date.now() + cooldownMs);
      broadcast({ type: 'rate_limited', requestId, user, model });
      console.log(`[traffic] ${user} rate-limited on ${model}, pausing for ${Math.round(cooldownMs / 1000)}s`);
    } else if (result.error) {
      broadcast({ type: 'request_error', requestId, user, model, error: result.error });
    } else {
      broadcast({
        type: 'request_complete',
        requestId,
        user,
        model,
        latencyMs: result.latencyMs,
        tokensUsed: result.tokensUsed,
        answer: result.answer,
      });
    }
  } catch (err) {
    if (!signal.aborted) {
      console.error(`[traffic] fireRequest error: ${err}`);
    }
  }
}

// Concurrent: all users fire at once, repeat at rate interval
// Rate = batches per second (each batch = all enabled users)
async function runConcurrent(config: TrafficConfig) {
  const signal = abortController!.signal;
  const intervalMs = 1000 / config.ratePerSecond;

  while (!signal.aborted) {
    for (const user of config.usersEnabled) {
      const model = pickRandom(config.modelsEnabled);
      launchRequest(user, model, signal);
    }
    await sleep(intervalMs, signal);
  }
}

// Sequential: one user at a time, round-robin, at rate interval
// Rate = requests per second
async function runSequential(config: TrafficConfig) {
  const signal = abortController!.signal;
  const intervalMs = 1000 / config.ratePerSecond;
  let userIdx = 0;

  while (!signal.aborted) {
    const user = config.usersEnabled[userIdx % config.usersEnabled.length]!;
    const model = pickRandom(config.modelsEnabled);
    launchRequest(user, model, signal);
    userIdx++;
    await sleep(intervalMs, signal);
  }
}

// Random burst: 2-6 requests at once, random pause scaled by rate
async function runRandomBurst(config: TrafficConfig) {
  const signal = abortController!.signal;

  while (!signal.aborted) {
    const burstSize = Math.floor(Math.random() * 5) + 2;
    for (let i = 0; i < burstSize; i++) {
      const user = pickRandom(config.usersEnabled);
      const model = pickRandom(config.modelsEnabled);
      launchRequest(user, model, signal);
    }

    const basePauseMs = Math.floor(Math.random() * 3000) + 500;
    const pauseMs = basePauseMs / config.ratePerSecond;
    await sleep(pauseMs, signal);
  }
}
