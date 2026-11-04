import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { GatewayOpenAI } from './gateway-openai.js';
import { limitedBy } from './rate-limit-source.js';

type APIError = InstanceType<typeof OpenAI.APIError>;
type MakeStatusError = (status: number, error: object | undefined, message: string | undefined, headers: object) => APIError;

/** A 429 as the SDK would build it from the given parsed body and raw text. */
function error429(body: object | undefined, text?: string): APIError {
  const client = new GatewayOpenAI({ apiKey: 'test', baseURL: 'http://localhost:1' });
  const make = (client as unknown as { makeStatusError: MakeStatusError }).makeStatusError.bind(client);
  return make(429, body, text, {});
}

// Bodies read off the wire through the MaaS gateway on 2026-11-04.
const GOOGLE_429 = [{ error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details.', status: 'RESOURCE_EXHAUSTED' } }];
const OPENAI_429 = { error: { message: 'Rate limit reached for gpt-5.4-nano', type: 'requests', code: 'rate_limit_exceeded' } };

describe('limitedBy', () => {
  it("attributes the gateway's plain-text 429 to MaaS", () => {
    // content-type text/plain, body "Too Many Requests": the SDK parses no JSON.
    assert.deepEqual(limitedBy(error429(undefined, 'Too Many Requests').error), { by: 'gateway' });
  });

  it("attributes Google's quota 429 to the provider, with its message", () => {
    const r = limitedBy(error429(GOOGLE_429).error);
    assert.equal(r.by, 'provider');
    assert.match(r.message ?? '', /exceeded your current quota/);
  });

  it("attributes OpenAI's 429 to the provider", () => {
    assert.deepEqual(limitedBy(error429(OPENAI_429).error), { by: 'provider', message: 'Rate limit reached for gpt-5.4-nano' });
  });

  it('treats a missing or non-object body as the gateway', () => {
    assert.deepEqual(limitedBy(undefined), { by: 'gateway' });
    assert.deepEqual(limitedBy(null), { by: 'gateway' });
    assert.deepEqual(limitedBy('Too Many Requests'), { by: 'gateway' });
  });
});
