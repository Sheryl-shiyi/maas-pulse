import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prefixCachingByPod } from './prometheus.js';

/**
 * `vllm:cache_config_info` exactly as the demo cluster reported it on 2026-11-04. Note
 * there is no `model_name` label on this series; an earlier version filtered on it and
 * matched nothing, so Nemotron kept reading "idle".
 */
const ROWS = [
  { enable_prefix_caching: 'False', engine: '0', namespace: 'llm', pod: 'nemotron-3-nano-30b-a3b-kserve-5c5b55dcf8-zczz2', prefix_caching_hash_algo: 'sha256', value: 1 },
  { enable_prefix_caching: 'True', engine: '0', namespace: 'llm', pod: 'qwen3-8b-fp8-kserve-ffffddb9b-fzngf', prefix_caching_hash_algo: 'sha256', value: 1 },
];

describe('prefixCachingByPod', () => {
  it('reports Nemotron off and Qwen3 on, keyed by pod', () => {
    const m = prefixCachingByPod(ROWS);
    assert.equal(m.get('nemotron-3-nano-30b-a3b-kserve-5c5b55dcf8-zczz2'), false);
    assert.equal(m.get('qwen3-8b-fp8-kserve-ffffddb9b-fzngf'), true);
  });

  it('leaves a pod out when the label is missing or unexpected, so it reads as unknown', () => {
    const m = prefixCachingByPod([{ pod: 'p1', value: 1 }, { pod: 'p2', enable_prefix_caching: 'maybe', value: 1 }]);
    assert.equal(m.size, 0);
  });
});
