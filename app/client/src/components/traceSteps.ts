import type { ModelState } from '../types';
import { providerOf } from './providerLogos';

/** What the BFF returns for one traced request (POST /api/trace). */
export interface TraceResponse {
  user: { name: string; displayName: string; tier: string | null; method: string; identity: string };
  model: { name: string; displayName: string; type: 'internal' | 'external' };
  question: string;
  limit: string | null;
  result: {
    ok: boolean;
    status: number | null;
    limitedBy: 'gateway' | 'provider' | null;
    message: string | null;
    upstream: string | null;
    promptTokens: number | null;
    cachedTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    latencyMs: number;
    answer: string | null;
  };
}

/** Where the replay is looking at a given step. */
export type TraceFocus = 'user' | 'gw-auth' | 'gw-access' | 'gw-limit' | 'gw-route' | 'gw-meter' | 'llmd' | 'replica' | 'external' | 'answer';

export interface TraceStep {
  focus: TraceFocus;
  title: string;
  lines: string[];
  /** blocked: MaaS refused here; provider: the external provider refused. */
  tone?: 'blocked' | 'provider';
}

/**
 * The replay of one real request, step by step through the stack: the user, the
 * gateway's checks, llm-d's choice, vLLM's work, metering, the answer. Every figure is
 * from the request itself or, for llm-d's view of the replicas, from a snapshot taken
 * when it was sent. A refused request stops at the step that refused it.
 */
export function buildTraceSteps(t: TraceResponse, snapshot: ModelState | undefined): { steps: TraceStep[]; replicaIdx: number | null } {
  const user = t.user.displayName;
  const model = t.model.displayName;
  const tier = t.user.tier ? capitalise(t.user.tier) : null;
  const tierText = tier ? `${tier} subscription` : 'Its subscription';
  const limit = t.limit ? limitText(t.limit) : null;
  const r = t.result;
  const external = t.model.type !== 'internal';
  const provider = providerName(t.model.name);
  const steps: TraceStep[] = [];

  steps.push({
    focus: 'user',
    title: `${user} asks ${model}`,
    lines: [`“${truncate(t.question, 160)}”`, tier ? `${tier} tier` : 'No tier'],
  });

  if (r.status === 401) {
    steps.push({ focus: 'gw-auth', tone: 'blocked', title: '① Authenticate: rejected', lines: [
      `The credential for ${t.user.displayName} was not accepted.`,
      'The gateway answers 401 at once. Nothing reaches a model.',
    ] });
    return { steps, replicaIdx: null };
  }
  steps.push({ focus: 'gw-auth', title: '① Authenticate: who is calling?', lines: [
    `Signed in as ${t.user.displayName}: the gateway checks the credential before anything else.`,
    'Valid, so the request goes on. A bad one stops here with 401.',
  ] });

  if (r.status === 403) {
    steps.push({ focus: 'gw-access', tone: 'blocked', title: '② Subscription: no access', lines: [
      `${tierText} does not include ${model}.`,
      'The gateway answers 403. Nothing reaches a model.',
    ] });
    return { steps, replicaIdx: null };
  }
  steps.push({ focus: 'gw-access', title: '② Subscription: may they use this model?', lines: [
    `${tierText} includes ${model}.`,
    'A model it does not include would stop here with 403.',
  ] });

  if (r.status === 429 && r.limitedBy !== 'provider') {
    steps.push({ focus: 'gw-limit', tone: 'blocked', title: '③ Token limits: over budget', lines: [
      limit ? `${tier ?? 'The'} tier allows ${limit} tokens per minute on ${model}, and ${user} has used it up.` : `${user} has used up this minute's token budget.`,
      'The gateway answers 429 at once: the request never reaches a GPU.',
    ] });
    return { steps, replicaIdx: null };
  }
  steps.push({ focus: 'gw-limit', title: '③ Token limits: within budget?', lines: [
    limit ? `${tier ?? 'This'} tier allows ${limit} tokens per minute on ${model}, per user.` : 'Each tier has a token budget per minute.',
    'Within budget, so it goes on. Over budget, the gateway would answer 429.',
  ] });

  let replicaIdx: number | null = null;
  if (external) {
    steps.push({ focus: 'external', title: `④ Route by model: to ${provider}`, lines: [
      `${model} is external: the gateway adds the provider's API key and sends the request to ${provider}, outside our cluster.`,
      'llm-d and our GPUs are not involved.',
    ] });
  } else {
    const reps = snapshot?.replicaStats ?? [];
    const idx = r.upstream ? reps.findIndex(x => x.instance === r.upstream) : -1;
    replicaIdx = idx >= 0 ? idx : reps.length === 1 ? 0 : null;
    const lines = reps.map((x, i) =>
      `#${i + 1}: ${x.queuedRequests} waiting · ${x.prefixCaching === false ? 'cache off' : x.cacheHitPercent === null ? 'no recent hits' : `${x.cacheHitPercent}% cache hits`}${i === replicaIdx ? '  ← chosen' : ''}`);
    if (reps.length <= 1) lines.push('Only one replica, so it is the one.');
    else lines.push('The gateway reports which pod served it: that is the one marked.');
    steps.push({ focus: 'llmd', title: '④ llm-d picks the replica', lines });
  }

  if (!r.ok) {
    const where: TraceFocus = external ? 'external' : 'replica';
    if (r.status === 429 && r.limitedBy === 'provider') {
      steps.push({ focus: where, tone: 'provider', title: `${provider} refused: its own rate limit`, lines: [
        r.message ? truncate(r.message, 160) : 'The provider answered 429.',
        'A 429 from the provider, not a MaaS limit.',
      ] });
    } else {
      steps.push({ focus: where, tone: 'blocked', title: 'The model failed', lines: [
        `${r.status ?? ''} ${r.message ? truncate(r.message, 160) : 'No answer.'}`.trim(),
      ] });
    }
    return { steps, replicaIdx };
  }

  const secs = (r.latencyMs / 1000).toFixed(1);
  if (external) {
    steps.push({ focus: 'external', title: `${provider} answers`, lines: [
      `Prompt ${r.promptTokens ?? '?'} tokens · answer ${r.completionTokens ?? '?'} tokens · ${secs} s for the whole trip.`,
    ] });
  } else {
    const replicaName = `${model}${(snapshot?.replicaStats.length ?? 0) > 1 && replicaIdx !== null ? ` #${replicaIdx + 1}` : ''}`;
    const p = r.promptTokens, c = r.cachedTokens;
    steps.push({ focus: 'replica', title: `vLLM on ${replicaName} answers`, lines: [
      p !== null && c !== null
        ? `Prompt: ${p} tokens. ${c} reused from the prefix cache, ${p - c} computed.`
        : `Prompt: ${p ?? '?'} tokens.`,
      `Answer: ${r.completionTokens ?? '?'} tokens. Whole trip: ${secs} s.`,
    ] });
  }

  steps.push({ focus: 'gw-meter', title: '⑤ Meter usage', lines: [
    `${r.totalTokens ?? '?'} tokens recorded for ${user} on ${model}${tier ? ` (${tier} tier)` : ''}.`,
    'That is what Cost & Chargeback shows.',
  ] });
  steps.push({ focus: 'answer', title: 'The answer', lines: [`“${truncate(r.answer ?? '', 220)}”`] });
  return { steps, replicaIdx };
}

function limitText(raw: string): string {
  const m = /^(.+)\/1m$/.exec(raw);
  return m ? m[1]! : raw;
}

function providerName(model: string): string {
  const p = providerOf(model);
  return p === 'gemini' ? 'Google' : p === 'openai' ? 'OpenAI' : 'the provider';
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : one.slice(0, n - 1) + '…';
}

/** What the topology needs to draw the replay: whose request, where it is, what to light. */
export interface TraceView {
  user: string;
  model: string;
  /** The replica that served it, when known. */
  replicaIdx: number | null;
  focus: TraceFocus;
  tone?: 'blocked' | 'provider';
  /** Every focus reached so far, to light the path behind the dot. */
  reached: TraceFocus[];
}
