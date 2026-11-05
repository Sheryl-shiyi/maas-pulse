import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scaleReason } from './autoscaler.js';

describe('scaleReason', () => {
  it('names the queue when a backlog fired the scale-up, and shows KV as not the cause', () => {
    const r = scaleReason('up', { model: 'qwen3-8b-fp8', queuedRequests: 7, kvCachePercent: 34 }, 900);
    assert.equal(r.summary, 'requests queued 7 > 5');
    assert.deepEqual(r.checks.map(c => [c.label, c.value, c.limit, c.tripped]), [
      ['Requests queued', 7, 5, true],
      ['KV cache in use', 34, 80, false],
    ]);
  });

  it('names both conditions when both fired', () => {
    const r = scaleReason('up', { model: 'm', queuedRequests: 12, kvCachePercent: 91 }, 900);
    assert.equal(r.summary, 'requests queued 12 > 5 and kv cache in use 91% > 80%');
  });

  it('does not count exactly the limit as over it', () => {
    const r = scaleReason('up', { model: 'm', queuedRequests: 5, kvCachePercent: 80 }, 900);
    assert.equal(r.checks.some(c => c.tripped), false);
  });

  it('explains a scale-down as sustained idleness, in minutes', () => {
    const r = scaleReason('down', { model: 'm', queuedRequests: 0, kvCachePercent: 3 }, 900);
    assert.equal(r.summary, 'idle for 15 min: nothing queued and KV cache under 20%');
  });
});
