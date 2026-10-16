import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeStatus, orderedPods, PRESSURE } from './prometheus.js';

/**
 * These tests exist because of a specific incident. On 2026-10-15 a replica was serving
 * 20 requests with nothing queued and 1.9% KV cache in use, and both the topology and
 * the autoscaler called it overloaded, because the signal was running + waiting. A GPU
 * was provisioned that was not needed.
 *
 * The numbers below are from that measurement. If someone reintroduces
 * `vllm:num_requests_running` as a pressure signal, the first test fails.
 */
describe('computeStatus', () => {
  it('calls a busy batch with an empty queue healthy — the case that cost us a GPU', () => {
    // 20 running, 0 queued, 1.9% KV: continuous batching working normally.
    assert.equal(computeStatus(0, 1.9), 'healthy');
  });

  it('is healthy at rest', () => {
    assert.equal(computeStatus(0, 0), 'healthy');
  });

  it('treats anything queued as at least busy, since nothing should wait', () => {
    assert.equal(computeStatus(PRESSURE.queuedBusy, 0), 'busy');
  });

  it('is overloaded once the queue is genuinely backing up', () => {
    assert.equal(computeStatus(PRESSURE.queuedOverloaded + 1, 0), 'overloaded');
  });

  it('is overloaded on KV pressure alone, with nothing queued yet', () => {
    // The batch is still absorbing requests but the cache is nearly full, so the
    // batch size is about to be forced down. That is real pressure.
    assert.equal(computeStatus(0, PRESSURE.kvOverloadedPercent + 1), 'overloaded');
  });

  it('is busy on moderate KV use', () => {
    assert.equal(computeStatus(0, PRESSURE.kvBusyPercent + 1), 'busy');
  });

  it('matches the thresholds RHOAI ships for its own autoscaler', () => {
    // WVA defaults: queueLengthThreshold 5, kvCacheThreshold 0.80.
    assert.equal(PRESSURE.queuedOverloaded, 5);
    assert.equal(PRESSURE.kvOverloadedPercent, 80);
  });
});

describe('orderedPods', () => {
  it('keeps an existing replica in place when a new one appears', () => {
    // The UI numbers boxes from this order. If a new pod could take position 1, the
    // incumbent would appear to reset, which is exactly what a scale-up must not look
    // like.
    assert.deepEqual(orderedPods('m1', ['pod-a']), ['pod-a']);
    assert.deepEqual(orderedPods('m1', ['pod-b', 'pod-a']), ['pod-a', 'pod-b']);
  });

  it('drops a replica that has gone and leaves the rest in order', () => {
    orderedPods('m2', ['pod-a', 'pod-b', 'pod-c']);
    assert.deepEqual(orderedPods('m2', ['pod-c', 'pod-a']), ['pod-a', 'pod-c']);
  });

  it('tracks each model separately', () => {
    orderedPods('m3', ['x']);
    orderedPods('m4', ['y']);
    assert.deepEqual(orderedPods('m3', ['x']), ['x']);
  });
});
