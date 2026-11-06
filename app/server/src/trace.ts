/**
 * "Trace a request": one real request sent on demand, with what the UI needs to replay
 * its trip step by step: who sent it and how they authenticated, the limit their tier
 * gives them on that model, and what came back (status, serving pod, cache use, timing).
 */

/** How a demo user proves who they are to the gateway, in words for the audience. */
export function describeAuth(user: { serviceAccount?: string; apiKey?: string }): { method: string; identity: string } {
  if (user.serviceAccount) {
    const [ns, name] = user.serviceAccount.split('/');
    return { method: 'Kubernetes ServiceAccount token', identity: `${name} in namespace ${ns}` };
  }
  if (user.apiKey) return { method: 'API key', identity: 'an API key issued by MaaS' };
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
