import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeAuth, limitFor, cleanQuestion } from './trace.js';

describe('describeAuth', () => {
  it('calls it a credential, without saying the demo mints ServiceAccount tokens', () => {
    const d = describeAuth({ serviceAccount: 'maas-tier-max/user7' });
    assert.equal(d.method, 'credential');
    assert.ok(!/serviceaccount|namespace|maas-tier/i.test(JSON.stringify(d)));
  });
  it('describes an API key the same way, never printing it', () => {
    const d = describeAuth({ apiKey: 'sk-oai-secret' });
    assert.equal(d.method, 'credential');
    assert.ok(!JSON.stringify(d).includes('secret'));
  });
  it('says so when a user has no credential at all', () => {
    assert.equal(describeAuth({}).method, 'unknown');
  });
});

describe('limitFor', () => {
  const limits = { 'qwen3-8b-fp8': '800k/1m', 'gemini-3.1-flash-lite': '20k/1m' };
  it('matches internal models by their base name and external ones exactly', () => {
    assert.equal(limitFor(limits, 'publishers/llm/models/qwen3-8b-fp8'), '800k/1m');
    assert.equal(limitFor(limits, 'gemini-3.1-flash-lite'), '20k/1m');
  });
  it('is undefined when unknown', () => {
    assert.equal(limitFor(limits, 'nemotron-3-nano-30b-a3b'), undefined);
    assert.equal(limitFor(undefined, 'x'), undefined);
  });
});

describe('cleanQuestion', () => {
  it('trims and bounds what was typed, and falls back when empty', () => {
    assert.equal(cleanQuestion('  hi  ', () => 'pool'), 'hi');
    assert.equal(cleanQuestion('x'.repeat(900), () => 'pool').length, 500);
    assert.equal(cleanQuestion('   ', () => 'pool'), 'pool');
    assert.equal(cleanQuestion(42, () => 'pool'), 'pool');
  });
});
