/**
 * "Trace a request": one real request sent on demand, with what the UI needs to replay
 * its trip step by step: who sent it and how they authenticated, the limit their tier
 * gives them on that model, and what came back (status, serving pod, cache use, timing).
 */

/**
 * How a demo user proves who they are, in words for the audience: a credential the
 * gateway checks. Deliberately not how this demo mints it (ServiceAccount tokens): the
 * story MaaS tells is self-service API keys, and the mechanism is a distraction on stage.
 */
export function describeAuth(user: { serviceAccount?: string; apiKey?: string }): { method: string; identity: string } {
  if (user.serviceAccount || user.apiKey) return { method: 'credential', identity: 'checked by the gateway' };
  return { method: 'unknown', identity: 'no credentials configured' };
}

/** The user's limit on a model, as the subscription watcher reports it ("800k/1m"). */
export function limitFor(limits: Record<string, string> | undefined, modelName: string): string | undefined {
  if (!limits) return undefined;
  const hit = Object.entries(limits).find(([k]) => modelName === k || modelName.endsWith(`/${k}`) || modelName.endsWith(k));
  return hit?.[1];
}

/** A question the presenter typed, made safe to send: trimmed, bounded, never empty. */
export function cleanQuestion(q: unknown, fallback: () => string): string {
  const s = typeof q === 'string' ? q.trim().slice(0, 500) : '';
  return s || fallback();
}
