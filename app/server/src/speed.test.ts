import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { meanByPod } from './prometheus.js';

describe('meanByPod', () => {
  it('divides each pod\'s histogram sum rate by its count rate', () => {
    const sums = [{ pod: 'a', value: 1.2 }, { pod: 'b', value: 9 }];
    const counts = [{ pod: 'a', value: 4 }, { pod: 'b', value: 3 }];
    const m = meanByPod(sums, counts);
    assert.ok(Math.abs(m.get('a')! - 0.3) < 1e-9);
    assert.equal(m.get('b'), 3);
  });

  it('leaves out a pod that finished nothing, rather than reporting zero seconds', () => {
    const m = meanByPod([{ pod: 'a', value: 0 }], [{ pod: 'a', value: 0 }]);
    assert.equal(m.has('a'), false);
  });

  it('leaves out a pod with no count series, and Prometheus NaN values', () => {
    const m = meanByPod([{ pod: 'a', value: 1 }, { pod: 'b', value: NaN }], [{ pod: 'b', value: 2 }]);
    assert.equal(m.size, 0);
  });
});
