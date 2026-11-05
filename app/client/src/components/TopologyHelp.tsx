import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ModelState, ReplicaStatus, Stats } from '../types';

/** What can be explained by clicking it in the topology. */
export type HelpTopic =
  | 'inflight' | 'cache' | 'replica' | 'external'
  | 'gw-auth' | 'gw-access' | 'gw-limit' | 'gw-route' | 'gw-meter';

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
  containerW: number;
  containerH: number;
  onClose: () => void;
}

const WIDTH = 330;

/**
 * Plain-language explanations for the parts of the topology an audience new to LLM
 * inference cannot be expected to read on sight. Shown only on click, so the view stays
 * clean for people who know it, and each one includes the live reading it explains.
 */
export function HelpPopover({ target, model, stat, stats, containerW, containerH, onClose }: HelpPopoverProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const { rect } = target;
  const gateway = target.topic.startsWith('gw-');
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
  const content = gateway ? gatewayContent(target.topic, stats) : model ? modelContent(target, model, stat) : null;
  if (!content) return null;

  return (
    <div ref={boxRef} style={{ ...styles.box, left, top, maxHeight: containerH - 16 }} role="dialog" aria-label={content.title}>
      <div style={styles.header}>
        <span style={styles.title}>{content.title}</span>
        <button style={styles.close} onClick={onClose} aria-label="Close">×</button>
      </div>
      {content.body.map((p, i) => <p key={i} style={styles.p}>{p}</p>)}
      {content.now && <div style={styles.now}>{content.now}</div>}
    </div>
  );
}

interface Content { title: string; body: React.ReactNode[]; now?: React.ReactNode }

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
          <><b style={{ color: '#4caf50' }}>Green</b> healthy · <b style={{ color: '#ff9800' }}>orange</b> requests waiting or KV cache over 50% · <b style={{ color: '#f44336' }}>red</b> more than 5 waiting or KV cache over 80%: the autoscaler adds a replica.</>,
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
          <><b>Running</b>: in the batch now. <b style={{ color: '#ef4444' }}>Queued</b> (red): could not start yet, because the GPU is still reading earlier long prompts or its memory for context is full. Either way, that is real pressure.</>,
          <>Scaled to <b>50</b>, the most the generator ever has waiting for an answer. The autoscaler adds a replica at more than 5 queued or KV cache over 80%, never for running requests alone.</>,
        ],
        now: stat ? <>Now: {stat.runningRequests} running · {stat.queuedRequests} queued · {kvReading(stat)}</> : undefined,
      };
    case 'cache':
      return {
        title: "Cache hit rate: work vLLM didn't redo",
        body: [
          <>vLLM keeps each prompt it has read (its <b>KV cache</b>) in GPU memory. A new prompt that starts the same way, such as a shared system prompt or document, reuses it instead of recomputing: a <b>hit</b>. Faster first token, less GPU work.</>,
          <>The bar is the share of prompt tokens served from cache in the last 2 minutes. Each replica has its own cache.</>,
          <><b>llm-d</b>, the gateway's scheduler, sends a request to the replica likely to have its start cached, and requests nobody has seen to the least recently used one. So a <b>new replica starts low</b>: it gets the uncacheable work, and warms up as it serves.</>,
        ],
        now: stat?.prefixCaching === false
          ? <>This vLLM has prefix caching turned off, so there is nothing to hit.</>
          : stat?.cacheHitPercent === null || stat?.cacheHitPercent === undefined
            ? <>Idle: no requests in the last 2 minutes.</>
            : <>Now: {stat.cacheHitPercent}% of prompt tokens came from cache.</>,
      };
    default:
      return {
        title: `${name}: served by the provider`,
        body: [
          <>No GPU or vLLM of ours: the gateway forwards to the provider and adds the provider's API key itself, so users never hold it.</>,
          <>Same authentication, subscription limits and usage metering as the models on our GPUs.</>,
          <>A <b style={{ color: '#f59e0b' }}>429 in amber</b> is the provider's own rate limit, not a MaaS limit.</>,
        ],
      };
  }
}

function gatewayContent(topic: HelpTopic, stats: Stats): Content {
  switch (topic) {
    case 'gw-auth':
      return {
        title: '1 · Authenticate: who is calling?',
        body: [
          <>Every request must prove who it is: an <b>API key</b> created in the OpenShift AI dashboard, a Kubernetes <b>ServiceAccount token</b> (how this demo's users call), or an <b>OIDC</b> login such as Keycloak (see the OIDC tab).</>,
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
    position: 'absolute', width: WIDTH, zIndex: 6, background: 'rgba(15, 23, 42, 0.98)', overflowY: 'auto',
    border: '1px solid #334155', borderRadius: 8, padding: '10px 12px', color: '#cbd5e1',
    fontSize: 12, lineHeight: 1.5, boxShadow: '0 10px 28px rgba(0,0,0,0.5)',
  },
  header: { display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 4 },
  title: { flex: 1, fontWeight: 700, fontSize: 13, color: '#f1f5f9' },
  close: { background: 'transparent', border: 'none', color: '#94a3b8', fontSize: 18, lineHeight: 1, cursor: 'pointer', padding: 0 },
  p: { margin: '6px 0' },
  now: { marginTop: 8, paddingTop: 6, borderTop: '1px solid #1e293b', color: '#38bdf8', fontWeight: 600 },
};
