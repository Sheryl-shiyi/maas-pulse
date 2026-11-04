import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequestParams, paramsFor } from './request-params.js';

describe('parseRequestParams', () => {
  it('reads per-model extras', () => {
    const p = parseRequestParams('{"gpt-5-nano":{"reasoning_effort":"minimal"}}');
    assert.deepEqual(p, { 'gpt-5-nano': { reasoning_effort: 'minimal' } });
  });

  it('treats unset or blank as no extras', () => {
    assert.deepEqual(parseRequestParams(undefined), {});
    assert.deepEqual(parseRequestParams(''), {});
    assert.deepEqual(parseRequestParams('  '), {});
    // Helm renders an empty map as "{}".
    assert.deepEqual(parseRequestParams('{}'), {});
  });

  it('survives malformed input instead of taking the generator down', () => {
    assert.deepEqual(parseRequestParams('{not json'), {});
    assert.deepEqual(parseRequestParams('["gpt-5-nano"]'), {});
    assert.deepEqual(parseRequestParams('"minimal"'), {});
  });

  it('passes nested fields through untouched (Qwen3 enable_thinking)', () => {
    const p = parseRequestParams('{"publishers/llm/models/qwen3-8b-fp8":{"chat_template_kwargs":{"enable_thinking":false}}}');
    assert.deepEqual(paramsFor('publishers/llm/models/qwen3-8b-fp8', p), { chat_template_kwargs: { enable_thinking: false } });
  });

  it('drops entries whose value is not an object', () => {
    const p = parseRequestParams('{"a":{"x":1},"b":"minimal","c":[1],"d":null}');
    assert.deepEqual(p, { a: { x: 1 } });
  });
});

describe('paramsFor', () => {
  const p = parseRequestParams('{"gpt-5-nano":{"reasoning_effort":"minimal"}}');

  it('returns the extras for a configured model', () => {
    assert.deepEqual(paramsFor('gpt-5-nano', p), { reasoning_effort: 'minimal' });
  });

  it('sends nothing extra to every other model', () => {
    // The reason this is per model: vLLM, Gemini and gpt-5.4-nano reject "minimal".
    assert.deepEqual(paramsFor('publishers/llm/models/qwen3-8b-fp8', p), {});
    assert.deepEqual(paramsFor('gemini-3.1-flash-lite', p), {});
    assert.deepEqual(paramsFor('gpt-5.4-nano', p), {});
  });
});
