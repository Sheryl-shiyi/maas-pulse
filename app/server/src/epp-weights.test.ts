import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseEppWeights } from './epp-weights.js';

describe('parseEppWeights', () => {
  it('reads the weights the chart renders from epp.weights', () => {
    assert.deepEqual(
      parseEppWeights('{"kvCacheUtilizationScorer":2,"noHitLruScorer":2,"prefixCacheScorer":3,"queueScorer":4}'),
      { queue: 4, kvCache: 2, prefixCache: 3, noHitLru: 2 },
    );
  });

  it('is null when unset, malformed, or missing a weight', () => {
    assert.equal(parseEppWeights(undefined), null);
    assert.equal(parseEppWeights(''), null);
    assert.equal(parseEppWeights('{not json'), null);
    assert.equal(parseEppWeights('{"queueScorer":4}'), null);
    assert.equal(parseEppWeights('{"queueScorer":"4","kvCacheUtilizationScorer":2,"prefixCacheScorer":3,"noHitLruScorer":2}'), null);
  });
});
