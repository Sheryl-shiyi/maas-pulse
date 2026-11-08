import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ModelState, ReplicaStatus, Stats, EppWeights } from '../types';
import { providerOf } from './providerLogos';
import { formatSeconds } from './format';

/** What can be explained by clicking it in the topology. */
export type HelpTopic =
  | 'inflight' | 'cache' | 'speed' | 'replica' | 'external'
  | 'gw-auth' | 'gw-access' | 'gw-limit' | 'gw-route' | 'gw-meter'
  | 'llmd';

export interface HelpTarget {
  topic: HelpTopic;
  /** -1 for the gateway's stages, which belong to no model. */
  modelIdx: number;
  replicaIdx: number;
  /** The clicked area, in canvas pixels, to place the popover beside. */
  rect: { x: number; y: number; w: number; h: number };
}

interface HelpPopoverProps {
  target: HelpTarget;
  model: ModelState | undefined;
  stat: ReplicaStatus | undefined;
  stats: Stats;
  /** Every model, for summaries that span them (llm-d). */
  models: ModelState[];
  eppWeights: EppWeights | null;
  containerW: number;
  containerH: number;
  onClose: () => void;
}

const BASE_WIDTH = 330;

/**
 * Plain-language explanations for the parts of the topology an audience new to LLM
 * inference cannot be expected to read on sight. Shown only on click, so the view stays
 * clean for people who know it, and each one includes the live reading it explains.
 */
export function HelpPopover({ target, model, stat, stats, models, eppWeights, containerW, containerH, onClose }: HelpPopoverProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const { rect } = target;
  const gateway = target.topic.startsWith('gw-');
  // llm-d's panel holds a table per model, so it is wider than the other explanations.
  const WIDTH = target.topic === 'llmd' ? 440 : BASE_WIDTH;
  // Models sit at the right edge, so their help goes on the left. The gateway's goes on
  // its right, over the edges rather than over the users.
  const onLeft = rect.x - WIDTH - 14;
  const onRight = rect.x + rect.w + 14;
  let left = gateway ? onRight : onLeft;
  if (left + WIDTH > containerW - 8) left = onLeft;
  if (left < 8) left = Math.min(onRight, containerW - WIDTH - 8);
  // Kept inside the canvas by its real height, measured once it has rendered.
  const boxRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => { setHeight(boxRef.current?.offsetHeight ?? 0); });
  const top = Math.max(8, Math.min(rect.y - 12, containerH - height - 8));
  const content = target.topic === 'llmd' ? llmdContent(models, eppWeights)
    : gateway ? gatewayContent(target.topic, stats) : model ? modelContent(target, model, stat) : null;
  if (!content) return null;
  const accent = accentFor(target.topic, model?.name);

  return (
    <div ref={boxRef} style={{ ...styles.box, width: WIDTH, left, top, maxHeight: containerH - 16, borderColor: tint(accent.color, 0.6) }} role="dialog" aria-label={content.title}>
      <div style={{ ...styles.header, background: accent.headerBg ?? tint(accent.color, 0.2), borderBottom: `1px solid ${tint(accent.color, 0.45)}` }}>
        <span style={{ ...styles.title, color: accent.text }}>{content.title}</span>
        <button style={styles.close} onClick={onClose} aria-label="Close">×</button>
      </div>
      {content.body.map((p, i) => <div key={i} style={styles.p}>{p}</div>)}
      {content.now && <div style={styles.now}>{content.now}</div>}
    </div>
  );
}

interface Content { title: string; body: React.ReactNode[]; now?: React.ReactNode }

/**
 * Each explanation opens with a block of the colour of what was clicked, as on the
 * canvas: the gateway orange, llm-d yellow, our vLLM replicas green, cloud models purple.
 */
function accentFor(topic: HelpTopic, modelName?: string): { color: string; text: string; headerBg?: string } {
  if (topic.startsWith('gw-')) return { color: '#876fd4', text: '#d0c5f4' };
  if (topic === 'llmd') return { color: '#ffcc17', text: '#ffe072' };
  if (topic === 'external') {
    // The colours of the card that was clicked: OpenAI green, Gemini's blue-to-purple.
    const p = modelName ? providerOf(modelName) : null;
    if (p === 'openai') return { color: '#10a37f', text: '#7fdcc2' };
    if (p === 'gemini') return { color: '#7b7fe0', text: '#c3cdfb', headerBg: 'linear-gradient(90deg, rgba(66, 133, 244, 0.3), rgba(155, 114, 203, 0.3))' };
    return { color: '#a3a3a3', text: '#e0e0e0' };
  }
  return { color: '#4caf50', text: '#a5d6a7' };
}
function tint(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** "KV cache 1% of room for 74,432 tokens", or just the percentage when the size is unknown. */
function kvReading(stat: ReplicaStatus): string {
  const room = stat.kvCapacityTokens ? ` of room for ${stat.kvCapacityTokens.toLocaleString()} tokens` : '';
  return `KV cache ${stat.kvCachePercent}%${room}`;
}

function modelContent(target: HelpTarget, model: ModelState, stat: ReplicaStatus | undefined): Content {
  const name = model.displayName;
  const replica = model.replicas > 1 || model.desiredReplicas > 1 ? ` #${target.replicaIdx + 1}` : '';
  switch (target.topic) {
    case 'replica':
      return {
        title: `${name}${replica}: one vLLM server, one GPU`,
        body: [
          <>One <b>vLLM</b> server, the engine of Red Hat AI Inference Server, running <b>{name}</b> on one GPU. OpenShift AI deploys it from an <i>LLMInferenceService</i>; each extra replica is another GPU.</>,
          <><b>KV cache</b> is the GPU memory vLLM keeps for the requests it is working on: every token of each prompt and of each answer so far. What is left after the model's weights decides how much it can hold. Short questions barely touch it; long documents and long chats fill it.</>,
          <><b style={{ color: '#4caf50' }}>Green</b> healthy · <b style={{ color: '#f5921b' }}>orange</b> requests waiting or KV cache over 50% · <b style={{ color: '#ee0000' }}>red</b> more than 5 waiting or KV cache over 80%: the autoscaler adds a replica.</>,
        ],
        now: stat
          ? <>Now: {stat.runningRequests} generating · {stat.queuedRequests} waiting · {kvReading(stat)} · {stat.requestsPerSecond} requests/s served</>
          : <>Waiting for this replica's first metrics.</>,
      };
    case 'inflight':
      return {
        title: 'In flight: requests inside this vLLM server',
        body: [
          <>vLLM generates tokens for many requests together, in one <b>continuous batch</b>. A full batch is the GPU working well, not a problem.</>,
          <><b>Running</b>: in the batch now. <b style={{ color: '#ee0000' }}>Queued</b> (red): could not start yet, because the GPU is still reading earlier long prompts or its memory for context is full. Either way, that is real pressure.</>,
          <>Scaled to <b>50</b>, the most the generator ever has waiting for an answer. The autoscaler adds a replica at more than 5 queued or KV cache over 80%, never for running requests alone.</>,
        ],
        now: stat ? <>Now: {stat.runningRequests} running · {stat.queuedRequests} queued · {kvReading(stat)}</> : undefined,
      };
    case 'cache':
      return {
        title: "Cache hit rate: work vLLM didn't redo",
        body: [
          <>vLLM keeps each prompt it has read (its <b>KV cache</b>) in GPU memory. A new prompt that starts the same way, such as a shared system prompt or document, reuses it instead of recomputing: a <b>hit</b>. Faster first token, less GPU work.</>,
          <>The bar is the share of prompt tokens served from cache in the last 2 minutes. Each replica has its own cache. A returning dot with a <b style={{ color: '#f2f2f2' }}>white ring</b> was answered mostly from cache.</>,
          <><b>llm-d</b>, the gateway's scheduler, sends a request to the replica likely to have its start cached, and requests nobody has seen to the least recently used one. So a <b>new replica starts low</b>: it gets the uncacheable work, and warms up as it serves.</>,
        ],
        now: stat?.prefixCaching === false
          ? <>This vLLM has prefix caching turned off, so there is nothing to hit.</>
          : stat?.cacheHitPercent === null || stat?.cacheHitPercent === undefined
            ? <>Idle: no requests in the last 2 minutes.</>
            : <>Now: {stat.cacheHitPercent}% of prompt tokens came from cache.</>,
      };
    case 'speed':
      return {
        title: 'Speed: how fast this vLLM answers',
        body: [
          <><b>First token</b>: the average wait, over the last 30 seconds, from a request reaching vLLM to the first word of its answer. Time spent queued and time spent reading the prompt both count, so a queue or long new prompts push it up, and <b>cache hits</b> bring it down: vLLM skips the part of the prompt it already holds.</>,
          <><b>tok/s</b>: answer tokens this replica produces per second, all its requests together. With <b>continuous batching</b> one GPU generates for many requests at once, so the total grows with the batch while each answer keeps a steady pace of its own.</>,
        ],
        now: stat?.firstTokenSeconds == null
          ? <>Idle: no requests finished in the last 30 seconds.</>
          : <>Now: first token in {formatSeconds(stat.firstTokenSeconds)} · {stat.outputTokensPerSecond.toLocaleString()} tokens/s in total{stat.perRequestTokensPerSecond != null ? <> · each answer about {Math.round(stat.perRequestTokensPerSecond)} tokens/s</> : null} · {stat.runningRequests} running</>,
      };
    default:
      return {
        title: `${name}: served by the provider`,
        body: [
          <>No GPU or vLLM of ours: the gateway forwards to the provider and adds the provider's API key itself, so users never hold it.</>,
          <>Same authentication, subscription limits and usage metering as the models on our GPUs.</>,
          <>A <b style={{ color: '#f8ae54' }}>429 in orange</b> is the provider's own rate limit, not a MaaS limit.</>,
        ],
      };
  }
}

/**
 * llm-d's panel: what it scores, with the chart's real weights, then per model what each
 * replica looks like to it right now and the share of traffic each one won. The picker
 * does not publish its per-request scores, so these are its inputs, not its arithmetic;
 * the reading line says in words why traffic splits the way it does.
 */
function llmdContent(models: ModelState[], w: EppWeights | null): Content {
  const internal = models.filter(m => m.type === 'internal');
  const rules: { label: string; hint: string; weight?: number }[] = [
    { label: 'Queue', hint: 'fewest requests waiting', weight: w?.queue },
    { label: 'Prefix cache', hint: 'already holds the start of this prompt', weight: w?.prefixCache },
    { label: 'KV cache free', hint: 'most GPU memory left', weight: w?.kvCache },
    { label: 'Cold-replica bonus', hint: "if no one has it cached: the replica idle longest", weight: w?.noHitLru },
  ];
  return {
    title: 'llm-d: picks the replica for every request',
    body: [
      <>For each request, <b>llm-d</b> scores every replica of the model and sends it to the best one. Same vLLM underneath; llm-d makes the distribution smarter. External models do not go through it.</>,
      <table style={styles.table}>
        <tbody>
          {rules.map(r => (
            <tr key={r.label}>
              <td style={styles.ruleName}>{r.label}{r.weight !== undefined ? <span style={styles.weight}> ×{r.weight}</span> : null}</td>
              <td style={styles.ruleHint}>{r.hint}</td>
            </tr>
          ))}
        </tbody>
      </table>,
      ...internal.map(m => <ModelScoreboard key={m.name} model={m} />),
    ],
    now: <>Share: requests each replica finished in the last minute. The picker does not publish its per-request scores; these are what it looks at.</>,
  };
}

function ModelScoreboard({ model }: { model: ModelState }) {
  const reps = model.replicaStats;
  const total = reps.reduce((a, r) => a + (r.requestsPerSecond ?? 0), 0);
  return (
    <div style={styles.model}>
      <div style={styles.modelName}>{model.displayName}</div>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Replica</th><th style={styles.th}>Waiting</th><th style={styles.th}>KV used</th>
            <th style={styles.th}>Cache hits</th><th style={styles.th}>Share</th>
          </tr>
        </thead>
        <tbody>
          {reps.map((r, i) => {
            const share = total > 0 ? Math.round(((r.requestsPerSecond ?? 0) / total) * 100) : 0;
            return (
              <tr key={i}>
                <td style={styles.td}>#{i + 1}</td>
                <td style={{ ...styles.td, color: r.queuedRequests > 0 ? '#f56e6e' : '#c7c7c7' }}>{r.queuedRequests}</td>
                <td style={styles.td}><MiniBar pct={r.kvCachePercent} color="#a3a3a3" />{r.kvCachePercent}%</td>
                <td style={styles.td}>
                  {r.prefixCaching === false ? 'off'
                    : r.cacheHitPercent === null ? '–'
                    : <><MiniBar pct={r.cacheHitPercent} color="#f2f2f2" />{r.cacheHitPercent}%</>}
                </td>
                <td style={styles.td}><MiniBar pct={share} color="#ffcc17" />{total > 0 ? `${share}%` : '–'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={styles.reading}>{readingFor(model)}</div>
    </div>
  );
}

function MiniBar({ pct, color }: { pct: number; color: string }) {
  return (
    <span style={styles.barTrack}>
      <span style={{ ...styles.barFill, width: `${Math.min(Math.max(pct, 0), 100)}%`, background: color }} />
    </span>
  );
}

/** Why traffic splits the way it does, in one line, from what llm-d can see. */
function readingFor(m: ModelState): string {
  const reps = m.replicaStats;
  if (reps.length <= 1) return 'One replica, so every request goes to it: there is nothing to choose between yet.';
  const busiest = reps.reduce((b, r, i) => (r.queuedRequests > reps[b]!.queuedRequests ? i : b), 0);
  if (reps[busiest]!.queuedRequests > 0) {
    return `#${busiest + 1} has ${reps[busiest]!.queuedRequests} waiting. Queue outweighs cache, so new requests go to the others.`;
  }
  const total = reps.reduce((a, r) => a + (r.requestsPerSecond ?? 0), 0);
  if (total < 0.05) return 'No recent traffic, so nothing to choose between yet.';
  const top = reps.reduce((b, r, i) => ((r.requestsPerSecond ?? 0) > (reps[b]!.requestsPerSecond ?? 0) ? i : b), 0);
  if ((reps[top]!.requestsPerSecond ?? 0) / total >= 0.7) {
    const hit = reps[top]!.cacheHitPercent;
    return `#${top + 1} is warm${hit !== null ? ` (${hit}% cache hits)` : ''} and not queueing, so it wins most requests; the others get prompts nobody has cached.`;
  }
  const hits = reps.map(r => r.cacheHitPercent);
  if (hits.every(h => h !== null && h >= 80)) {
    return `Every replica is warm (${hits.join('% / ')}% cache hits): each keeps the prompts it already holds, and the work is shared.`;
  }
  return 'Traffic is spread: no replica has a clear cache advantage (long, unique prompts, for example), so load decides.';
}

function gatewayContent(topic: HelpTopic, stats: Stats): Content {
  switch (topic) {
    case 'gw-auth':
      return {
        title: '1 · Authenticate: who is calling?',
        body: [
          <>Every request must prove who it is, usually with an <b>API key</b>: developers create their own in the OpenShift AI dashboard, scoped to their subscription and revocable at any time. Tokens and <b>OIDC</b> logins such as Keycloak work too (see the OIDC tab).</>,
          <>The gateway checks it before anything else. A request that fails is turned away here with <b>401</b> and never reaches a model or uses a GPU.</>,
        ],
        now: <>Since this page opened: {stats.authRejected} rejected.</>,
      };
    case 'gw-access':
      return {
        title: '2 · Subscription: what may they use?',
        body: [
          <>The caller's group decides its <b>subscription</b>: here the free, pro and max tiers on the left. A subscription lists the models it may use and its token limits for each.</>,
          <>Asking for a model the subscription does not include is refused with <b>403</b>. Changing a tier in the OpenShift AI console moves every user in it at once.</>,
        ],
        now: <>Since this page opened: {stats.accessDenied} denied.</>,
      };
    case 'gw-limit':
      return {
        title: '3 · Token limits: how much may they use?',
        body: [
          <>Each tier gets a budget of <b>tokens per minute</b>, per user and per model, shown on the tier cards. Tokens, not requests: a long prompt and a long answer cost more than a short one, as they do on the GPU.</>,
          <>The gateway counts the tokens each answer actually used. Over budget, the next request gets <b>429</b> until the minute rolls over: the red dots bouncing back, and the red model names on the user rows.</>,
        ],
        now: <>Since this page opened: {stats.rateLimitedRequests} limited.</>,
      };
    case 'gw-route':
      return {
        title: '4 · Route by model: where does it go?',
        body: [
          <>The request names a model, and the gateway sends it there. One endpoint serves every model.</>,
          <>For models on our GPUs, <b>llm-d</b> picks the replica: one that has the prompt's beginning cached and no queue. For external models, the gateway adds the provider's API key and forwards the request to OpenAI or Google.</>,
        ],
        now: <>Since this page opened: {stats.routedRequests} routed.</>,
      };
    default:
      return {
        title: '5 · Meter usage: who used what?',
        body: [
          <>Every answer's token count is recorded with who asked, which model answered and under which subscription.</>,
          <>That is what the <b>Cost & Chargeback</b> tab and OpenShift AI's own usage dashboard show: usage, and its cost, per user, model and tier.</>,
        ],
        now: <>Since this page opened: {stats.totalTokens.toLocaleString()} tokens metered.</>,
      };
  }
}

const styles: Record<string, React.CSSProperties> = {
  box: {
    position: 'absolute', zIndex: 6, background: 'rgba(26, 26, 26, 0.98)', overflowY: 'auto',
    border: '1px solid #383838', borderRadius: 8, padding: '0 12px 10px', color: '#c7c7c7',
    fontSize: 12, lineHeight: 1.5, boxShadow: '0 10px 28px rgba(0,0,0,0.5)',
  },
  header: { display: 'flex', alignItems: 'flex-start', gap: 8, margin: '0 -12px 6px', padding: '9px 12px 8px' },
  title: { flex: 1, fontWeight: 700, fontSize: 13, color: '#f2f2f2' },
  close: { background: 'transparent', border: 'none', color: '#a3a3a3', fontSize: 18, lineHeight: 1, cursor: 'pointer', padding: 0 },
  p: { margin: '6px 0' },
  now: { marginTop: 8, paddingTop: 6, borderTop: '1px solid #1f1f1f', color: '#f2f2f2', fontWeight: 600 },
  table: { borderCollapse: 'collapse', width: '100%', fontSize: 11.5 },
  ruleName: { padding: '2px 8px 2px 0', color: '#f2f2f2', fontWeight: 600, whiteSpace: 'nowrap' },
  weight: { color: '#ffcc17', fontWeight: 700 },
  ruleHint: { padding: '2px 0', color: '#a3a3a3' },
  model: { marginTop: 10, paddingTop: 8, borderTop: '1px solid #1f1f1f' },
  modelName: { color: '#f2f2f2', fontWeight: 700, marginBottom: 4 },
  th: { textAlign: 'left', color: '#8a8a8a', fontWeight: 600, padding: '2px 6px 2px 0', fontSize: 10.5 },
  td: { padding: '3px 6px 3px 0', color: '#c7c7c7', whiteSpace: 'nowrap' },
  reading: { marginTop: 4, color: '#ffe072', fontSize: 11.5 },
  barTrack: { display: 'inline-block', width: 34, height: 5, background: 'rgba(163,163,163,0.18)', borderRadius: 3, marginRight: 5, verticalAlign: 'middle', overflow: 'hidden' },
  barFill: { display: 'block', height: '100%', borderRadius: 3 },
};
