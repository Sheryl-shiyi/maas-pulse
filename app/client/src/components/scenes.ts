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
  /** Which users send, and to which models. */
  users: (u: UserInfo) => boolean;
  models: (m: ModelInfo) => boolean;
  pattern: TrafficPattern;
  promptShape: PromptShape;
  /** Ticks per second (Concurrent: every selected user sends on each tick). */
  rate: number;
  watch: string[];
}

const isQwen = (m: ModelInfo) => m.name.toLowerCase().includes('qwen');
const tierIn = (...tiers: string[]) => (u: UserInfo) => tiers.includes((u.tier ?? '').toLowerCase());

export const SCENES: Scene[] = [
  {
    id: 'limits',
    title: 'Tiers and token limits',
    users: () => true,
    models: m => m.type === 'internal',
    pattern: 'concurrent',
    promptShape: 'short',
    rate: 2,
    watch: [
      'Within half a minute Free users hit their token limit: their requests bounce back from the gateway in red.',
      'Pro and Max keep going: same models, bigger budgets.',
      'Change the Free limit in the OpenShift AI console: the Free card updates within seconds.',
    ],
  },
  {
    id: 'batching',
    title: 'vLLM: one GPU, many requests',
    users: tierIn('pro', 'max'),
    models: isQwen,
    pattern: 'concurrent',
    promptShape: 'short',
    rate: 3,
    watch: [
      'One GPU, one vLLM server, twenty or more requests in flight at once: continuous batching.',
      'Nothing queues, and the KV cache stays low: short prompts barely use GPU memory.',
      'Click In flight or the Qwen3 card for what vLLM is doing.',
    ],
  },
  {
    id: 'autoscaling',
    title: 'Autoscaling under real load',
    users: tierIn('max'),
    models: isQwen,
    pattern: 'concurrent',
    promptShape: 'unique-prefix',
    rate: 1,
    watch: [
      'Long prompts nobody has sent before: vLLM must read every token, so a queue builds.',
      'The autoscaler adds a replica and the notice says why. A new GPU takes 2 to 10 minutes.',
      'Keep it running: once #2 is ready, llm-d splits the load about evenly.',
    ],
  },
  {
    id: 'cache',
    title: 'llm-d: cache-aware routing',
    users: tierIn('max'),
    models: isQwen,
    pattern: 'concurrent',
    promptShape: 'shared-prefix',
    rate: 1,
    watch: [
      'Every prompt starts with the same document: the replica that already has it cached answers fastest.',
      'llm-d keeps sending these to the warm replica, and its cache hit rate climbs towards 95%.',
      'Click llm-d for its scoreboard; Trace a request shows the replica it picked.',
    ],
  },
  {
    id: 'cloud',
    title: 'Cloud-hosted APIs and privacy',
    users: tierIn('pro', 'max'),
    models: m => m.type !== 'internal' || isQwen(m),
    pattern: 'concurrent',
    promptShape: 'short',
    rate: 1,
    watch: [
      'Same gateway, same sign-in, same limits: the gateway adds each provider’s API key itself.',
      'Prompts to the cloud APIs cross the boundary and leave your network; those to Qwen3 never do.',
      'Pay-per-token APIs get tighter limits, so Pro users soon hit theirs. Runs on the paid keys: stop it when done.',
    ],
  },
];
