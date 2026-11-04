import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { GatewayOpenAI, unwrapErrorBody } from './gateway-openai.js';

/** The body Gemini's OpenAI-compatible endpoint actually returns, read off the wire. */
const GEMINI_503 = [{ error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } }];

type APIError = InstanceType<typeof OpenAI.APIError>;
type MakeStatusError = (status: number, error: object | undefined, message: string | undefined, headers: object) => APIError;

function errorFor(body: object | undefined, message?: string): APIError {
  const client = new GatewayOpenAI({ apiKey: 'test', baseURL: 'http://localhost:1' });
  const make = (client as unknown as { makeStatusError: MakeStatusError }).makeStatusError.bind(client);
  return make(503, body, message, {});
}

describe('unwrapErrorBody', () => {
  it('takes the first element of an array body', () => {
    assert.deepEqual(unwrapErrorBody(GEMINI_503), GEMINI_503[0]);
  });

  it('leaves object bodies, empty arrays and absence alone', () => {
    const openaiStyle = { error: { message: 'x' } };
    assert.equal(unwrapErrorBody(openaiStyle), openaiStyle);
    assert.deepEqual(unwrapErrorBody([]), []);
    assert.equal(unwrapErrorBody(undefined), undefined);
  });
});

describe('GatewayOpenAI error messages', () => {
  it("shows Gemini's own message instead of 'no body'", () => {
    const err = errorFor(GEMINI_503);
    assert.ok(err instanceof OpenAI.APIError);
    assert.equal(err.status, 503);
    assert.equal(err.message, '503 The model is overloaded. Please try again later.');
  });

  it('still reads OpenAI-shaped bodies', () => {
    assert.equal(errorFor({ error: { message: 'Rate limit reached' } }).message, '503 Rate limit reached');
  });

  it('still shows a plain-text body, such as an Envoy 503', () => {
    const text = 'upstream connect error or disconnect/reset before headers';
    assert.equal(errorFor(undefined, text).message, `503 ${text}`);
  });
});
