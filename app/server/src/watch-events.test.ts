import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyWatchEvent } from './watch-events.js';

describe('classifyWatchEvent', () => {
  it('turns the in-stream 410 into a re-list, as the API server really sends it', () => {
    const e = classifyWatchEvent({ type: 'ERROR', object: { kind: 'Status', status: 'Failure', message: 'too old resource version: 1 (1308731)', reason: 'Expired', code: 410 } });
    assert.equal(e.kind, 'relist');
    assert.equal((e as any).code, 410);
  });
  it('re-lists on any other ERROR too', () => {
    assert.equal(classifyWatchEvent({ type: 'ERROR', object: { code: 500 } }).kind, 'relist');
  });
  it('keeps the resourceVersion of a bookmark, so an idle watch stays fresh', () => {
    assert.deepEqual(classifyWatchEvent({ type: 'BOOKMARK', object: { metadata: { resourceVersion: '42' } } }), { kind: 'bookmark', resourceVersion: '42' });
  });
  it('passes deployments on with their resourceVersion', () => {
    const e = classifyWatchEvent({ type: 'MODIFIED', object: { metadata: { name: 'qwen3-8b-fp8-kserve', resourceVersion: '7' } } });
    assert.equal(e.kind, 'deployment');
    assert.equal((e as any).resourceVersion, '7');
  });
  it('ignores deletions and junk', () => {
    assert.equal(classifyWatchEvent({ type: 'DELETED', object: {} }).kind, 'ignore');
    assert.equal(classifyWatchEvent(null).kind, 'ignore');
  });
});
