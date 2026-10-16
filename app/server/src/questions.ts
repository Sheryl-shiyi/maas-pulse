const QUESTIONS = [
  "Explain the concept of containerization in one paragraph.",
  "What is the difference between a process and a thread?",
  "Write a Python function to find the nth Fibonacci number.",
  "Explain how DNS resolution works step by step.",
  "What are the SOLID principles in software engineering?",
  "Describe the CAP theorem and its implications for distributed systems.",
  "Write a SQL query to find the second highest salary in a table.",
  "What is the difference between TCP and UDP?",
  "Explain how a hash table works internally.",
  "What are the main differences between REST and GraphQL?",
  "Write a function to check if a string is a valid palindrome.",
  "Explain the concept of eventual consistency.",
  "What is a mutex and when would you use one?",
  "Describe the observer design pattern with an example.",
  "What are Kubernetes pods and how do they differ from containers?",
  "Explain the difference between optimistic and pessimistic locking.",
  "Write a function to merge two sorted arrays.",
  "What is a load balancer and what algorithms can it use?",
  "Explain how TLS/SSL handshake works.",
  "What are the advantages of microservices over monolithic architecture?",
  "Write a function to detect a cycle in a linked list.",
  "Explain the concept of database sharding.",
  "What is the difference between symmetric and asymmetric encryption?",
  "Describe the strategy design pattern.",
  "What is a message queue and when should you use one?",
  "Explain the difference between horizontal and vertical scaling.",
  "Write a function to implement binary search.",
  "What are WebSockets and how do they differ from HTTP?",
  "Explain the concept of idempotency in API design.",
  "What is a reverse proxy and how does it work?",
  "Write a function to flatten a nested array.",
  "Explain the concept of circuit breaker pattern.",
  "What are the different types of database indexes?",
  "Describe the factory method design pattern.",
  "What is rate limiting and how can it be implemented?",
  "Explain the difference between authentication and authorization.",
  "Write a function to find all permutations of a string.",
  "What is a CDN and how does it improve performance?",
  "Explain the concept of blue-green deployment.",
  "What are environment variables and why are they important?",
  "Write a regular expression to validate an email address.",
  "Explain how garbage collection works in managed languages.",
  "What is the difference between SQL and NoSQL databases?",
  "Describe the adapter design pattern.",
  "What is observability and how does it differ from monitoring?",
  "Explain the concept of immutable infrastructure.",
  "Write a function to implement a basic LRU cache.",
  "What is service mesh and what problems does it solve?",
  "Explain the concept of canary deployment.",
  "What are the benefits of infrastructure as code?",
];

export function getRandomQuestion(): string {
  return QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)]!;
}

export function getQuestionPool(): string[] {
  return [...QUESTIONS];
}

/**
 * How much context each generated request carries. Orthogonal to the traffic pattern,
 * which only decides timing.
 *
 * - `short`         the question on its own. Cheap, and every user asks from the same
 *                   small pool, so the prefix cache hits constantly.
 * - `shared-prefix` one long preamble, identical for every request, then the question.
 *                   Maximises prefix cache reuse, which is what makes cache-aware
 *                   routing worth having — and what makes a per-replica cache hit rate
 *                   move on screen.
 * - `unique-prefix` a long preamble unique to each request. Nothing to reuse, so every
 *                   request pays full prefill and occupies KV cache of its own. This is
 *                   the only shape that produces genuine back-pressure, and therefore
 *                   the only one that can demonstrate autoscaling now that scaling
 *                   reacts to queue depth and KV usage rather than batch occupancy.
 */
export type PromptShape = 'short' | 'shared-prefix' | 'unique-prefix';

/** Roughly four characters per token for English prose. */
const CHARS_PER_TOKEN = 4;

/**
 * Sentences with enough variety that a preamble built from them tokenises like real
 * prose rather than like repeated filler, which would compress and defeat the point.
 */
const CORPUS = [
  'The service mesh terminates TLS at the gateway and forwards the decrypted request to the selected backend.',
  'Capacity planning for inference differs from stateless web serving because the key-value cache dominates memory.',
  'A rolling upgrade drains each node in turn, waiting for in-flight requests to complete before eviction.',
  'Token budgets are enforced per subscription and reset on a sliding window rather than at a fixed hour.',
  'The scheduler scores every candidate replica and routes to the one with the warmest matching prefix.',
  'Observability data is sampled at the gateway, aggregated per tenant, and retained for ninety days.',
  'Quantised weights reduce the memory footprint but shift some of the cost into dequantisation at runtime.',
  'When the batch cannot grow further, additional requests wait in a queue and latency rises sharply.',
  'Cold replicas serve their first requests slowly because no prefix of the prompt is cached yet.',
  'Egress to an external provider is proxied so that credentials never leave the cluster boundary.',
  'Audit records link every inference call back to the identity that issued it and the policy that allowed it.',
  'Throughput and tail latency pull in opposite directions once the accelerator is saturated.',
  'A request that exceeds its token allowance is rejected before it reaches the model server.',
  'Model weights are distributed as container images so that the usual registry controls apply.',
  'Autoscaling on concurrency alone is misleading, because a healthy batch looks identical to a backlog.',
];

/** Deterministic PRNG, so a given seed always rebuilds the identical preamble. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildPreamble(seed: number, approxTokens: number): string {
  const rand = mulberry32(seed);
  const target = approxTokens * CHARS_PER_TOKEN;
  const parts: string[] = [];
  let length = 0;
  while (length < target) {
    const sentence = CORPUS[Math.floor(rand() * CORPUS.length)]!;
    parts.push(sentence);
    length += sentence.length + 1;
  }
  return parts.join(' ');
}

/** Fixed seed: every caller gets byte-identical text, so the prefix cache can hit. */
const SHARED_SEED = 0x5ea5ed;
let uniqueCounter = 0;

export function buildPrompt(shape: PromptShape, approxPrefixTokens: number): string {
  const question = getRandomQuestion();
  if (shape === 'short') return question;

  const seed = shape === 'shared-prefix' ? SHARED_SEED : (Date.now() ^ (uniqueCounter++ << 16)) >>> 0;
  const preamble = buildPreamble(seed, approxPrefixTokens);
  return `${preamble}\n\nGiven the context above, answer: ${question}`;
}
