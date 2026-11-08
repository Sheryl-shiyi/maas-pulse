import type { ModelInfo, PromptShape, TrafficPattern, UserInfo } from '../types';

/**
 * The live demo's scenes, in the order the talk tells them: top-down, from what the
 * audience already knows (subscriptions and limits) to what they do not (vLLM, llm-d),
 * ending with the cloud-hosted APIs and privacy. One click sets up the traffic for a
 * scene and the sidebar says what to watch; the presenter tells the rest.
 */
export interface Scene {
  id: string;
  title: string;
  /** The label on its button, short enough for the five to share one row at 1280 px. */
  short: string;
  /** What to ring on the canvas while it runs (help topics, and a tier band). */
  focus: { topics: string[]; tier?: string };
  /** Which users send, and to which models. */
  users: (u: UserInfo) => boolean;
  models: (m: ModelInfo) => boolean;
  pattern: TrafficPattern;
  promptShape: PromptShape;
  /** Ticks per second (Concurrent: every selected user sends on each tick). */
  rate: number;
  /** Length of the shared or unique document before each question; default 1,500. */
  promptTokens?: number;
  watch: string[];
}

const isQwen = (m: ModelInfo) => m.name.toLowerCase().includes('qwen');
const tierIn = (...tiers: string[]) => (u: UserInfo) => tiers.includes((u.tier ?? '').toLowerCase());

export const SCENES: Scene[] = [
  {
    id: 'limits',
    title: 'Tiers and token limits',
    short: 'Tiers & limits',
    focus: { topics: ['gw-limit'], tier: 'free' },
    users: () => true,
    models: m => m.type === 'internal',
    pattern: 'concurrent',
    promptShape: 'short',
    rate: 2,
    watch: [
      'Within half a minute **Free users hit their token limit**: their requests bounce back from the gateway in red, and a countdown shows when they may try again.',
      '**Pro and Max keep going**: same models, bigger budgets.',
      'Change the Free limit in the OpenShift AI console: the **Free card updates** within seconds.',
    ],
  },
  {
    id: 'batching',
    title: 'vLLM: one GPU, many requests',
    short: 'vLLM batching',
    focus: { topics: ['inflight', 'speed'] },
    // Max only: at this rate Pro users spend their 10k tokens/min on Qwen3 within half a
    // minute, which halved the batch and put red "paused" tags on screen mid-scene, in a
    // scene about batching. Limits are scene 1's story.
    users: tierIn('max'),
    models: isQwen,
    pattern: 'concurrent',
    promptShape: 'short',
    rate: 5,
    watch: [
      'One GPU, one vLLM server, **about thirty requests in flight** at once: continuous batching.',
      'The speed line: **over 1,000 tokens/s once it warms up** (give it a minute), all from the one GPU, and the first token still comes within a fraction of a second.',
      '**Nothing queues**, and the KV cache stays low: short prompts barely use GPU memory. Click In flight or Speed for more.',
    ],
  },
  {
    id: 'autoscaling',
    title: 'Autoscaling under real load',
    short: 'Autoscaling',
    focus: { topics: ['inflight', 'replica'] },
    users: tierIn('max'),
    models: isQwen,
    pattern: 'concurrent',
    promptShape: 'unique-prefix',
    rate: 1,
    // Measured 2026-11-06 on vLLM 0.24, one A10G: ~1,500 tokens kept every request in the
    // batch (KV peaked at 78%, nothing queued) and never triggered; 3,000-4,000 triggered in
    // ~10 s but most requests then hit the 30 s client timeout; ~2,000 triggered in 18 s with
    // KV at 90-100% and 1 timeout in 155 requests.
    promptTokens: 2000,
    watch: [
      'Long prompts nobody has sent before: vLLM must read every token, and **the GPU memory fills up**.',
      'The **autoscaler adds a replica** and the notice says why. A new GPU takes 2 to 10 minutes.',
      'Keep it running: once #2 is ready, **llm-d splits the load** about evenly.',
    ],
  },
  {
    id: 'cache',
    title: 'llm-d: cache-aware routing',
    short: 'llm-d routing',
    focus: { topics: ['llmd', 'cache'] },
    users: tierIn('max'),
    models: isQwen,
    pattern: 'concurrent',
    // One document per user, not one shared by all: a single shared document is soon
    // cached on every replica, and then llm-d just balances load (both at 99%, measured
    // 2026-11-08), which shows nothing about where requests go.
    promptShape: 'per-user-prefix',
    promptTokens: 2000,
    rate: 1,
    watch: [
      'Each Max user brings **their own document** (~2,000 tokens): the first question reads it all, the next ones find it in cache.',
      'llm-d sends **each user to the replica holding their document**: in the Live Feed, each user stays on the same "served by #n".',
      'Both replicas stay **near 99% cache hits** while sharing the work. Click llm-d for its scoreboard; **Trace a request** shows its pick.',
    ],
  },
  {
    id: 'cloud',
    title: 'Cloud-hosted APIs and privacy',
    short: 'Cloud APIs',
    focus: { topics: ['external', 'gw-route'] },
    users: tierIn('pro', 'max'),
    models: m => m.type !== 'internal' || isQwen(m),
    pattern: 'concurrent',
    promptShape: 'short',
    rate: 1,
    watch: [
      'Same gateway, same sign-in, same limits: **the gateway adds each provider’s API key** itself.',
      'Prompts to the cloud APIs **cross the boundary** and leave your network; those to Qwen3 never do.',
      'Pay-per-token APIs get **tighter limits**, so Pro users soon hit theirs. Runs on the paid keys: stop it when done.',
    ],
  },
];
