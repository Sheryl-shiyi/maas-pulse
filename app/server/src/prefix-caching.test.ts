import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prefixCachingByPod, kvCapacityByPod, instanceByPod } from './prometheus.js';

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

describe('kvCapacityByPod', () => {
  it('reads kv_cache_size_tokens per pod, as Qwen3 on an A10G reported it on 2026-11-05', () => {
    const m = kvCapacityByPod([
      { pod: 'qwen3-8b-fp8-kserve-6bb95dbd5c-lk786', block_size: '16', num_gpu_blocks: '4652', kv_cache_size_tokens: '74432', value: 1 },
    ]);
    assert.equal(m.get('qwen3-8b-fp8-kserve-6bb95dbd5c-lk786'), 74432);
  });

  it('leaves a pod out when the label is missing or not a positive number', () => {
    const m = kvCapacityByPod([{ pod: 'a', value: 1 }, { pod: 'b', kv_cache_size_tokens: 'None', value: 1 }, { pod: 'c', kv_cache_size_tokens: '0', value: 1 }]);
    assert.equal(m.size, 0);
  });
});

describe('instanceByPod', () => {
  it("maps a pod to the address the gateway reports in x-maas-upstream", () => {
    // Labels as vllm:num_requests_running carried them on 2026-11-06.
    const m = instanceByPod([
      { pod: 'qwen3-8b-fp8-kserve-57b688b697-2sjxj', instance: '10.131.18.21:8000', model_name: 'qwen3-8b-fp8', value: 0 },
    ]);
    assert.equal(m.get('qwen3-8b-fp8-kserve-57b688b697-2sjxj'), '10.131.18.21:8000');
  });

  it('skips rows without a pod or an instance', () => {
    assert.equal(instanceByPod([{ pod: 'a', value: 1 }, { instance: '1.2.3.4:8000', value: 1 }]).size, 0);
  });
});
