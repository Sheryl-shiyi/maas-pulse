import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAutoscaleModels } from './autoscale-config.js';

describe('parseAutoscaleModels', () => {
  it('reads each model with its own range, as the chart renders it', () => {
    assert.deepEqual(parseAutoscaleModels('qwen3-8b-fp8:1:2,nemotron-3-nano-30b-a3b:1:1', 2), [
      { name: 'qwen3-8b-fp8', minReplicas: 1, maxReplicas: 2 },
      { name: 'nemotron-3-nano-30b-a3b', minReplicas: 1, maxReplicas: 1 },
    ]);
  });

  it('gives a bare name the old defaults, and name:max a minimum of 1', () => {
    assert.deepEqual(parseAutoscaleModels('qwen3-8b-fp8', 2), [{ name: 'qwen3-8b-fp8', minReplicas: 1, maxReplicas: 2 }]);
    assert.deepEqual(parseAutoscaleModels(' m:3 ', 2), [{ name: 'm', minReplicas: 1, maxReplicas: 3 }]);
  });

  it('skips entries it cannot trust instead of guessing a range', () => {
    assert.deepEqual(parseAutoscaleModels('a:2:1,b:0:2,c:x,d:1:2:3,:1:2,ok:1:2', 2), [
      { name: 'ok', minReplicas: 1, maxReplicas: 2 },
    ]);
  });

  it('is empty when nothing is configured', () => {
    assert.deepEqual(parseAutoscaleModels(undefined, 2), []);
    assert.deepEqual(parseAutoscaleModels(' , ', 2), []);
  });
});
