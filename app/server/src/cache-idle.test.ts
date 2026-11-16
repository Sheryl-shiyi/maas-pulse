import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { replicaHitPercent } from './prometheus.js';

describe('replicaHitPercent', () => {
  it('shows the hit rate while the replica serves', () => {
    assert.equal(replicaHitPercent(98, 100, 3, 9), 98);
  });
  it('is idle when nothing was looked up', () => {
    assert.equal(replicaHitPercent(0, 0, 3, 9), null);
  });
  it('is idle when the replica no longer serves, however high the old 2-minute ratio', () => {
    assert.equal(replicaHitPercent(99, 100, 0, 0), null);
  });
  it('is not idle while a slow request is still running', () => {
    assert.equal(replicaHitPercent(10, 100, 0, 1), 10);
  });
});
