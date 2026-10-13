import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripMaasPrefix,
  normalizeModelName,
  extractModelFromNamespace,
  resolveModel,
} from './model-names.js';

/**
 * The model set the demo cluster actually serves, in the spelling used as the
 * canonical name (the keys of the chargeback rate table).
 */
const KNOWN = [
  'nemotron-3-nano-30b-a3b',
  'qwen3-8b-fp8',
  'gemini-3.1-flash-lite',
  'gpt-4.1-nano',
];

describe('stripMaasPrefix', () => {
  it('strips the MaaS prefix so the name matches the vLLM model_name label', () => {
    assert.equal(
      stripMaasPrefix('publishers/llm/models/qwen3-8b-fp8'),
      'qwen3-8b-fp8',
    );
    assert.equal(
      stripMaasPrefix('publishers/llm/models/nemotron-3-nano-30b-a3b'),
      'nemotron-3-nano-30b-a3b',
    );
  });

  it('leaves external model names alone — they carry no prefix', () => {
    assert.equal(stripMaasPrefix('gemini-3.1-flash-lite'), 'gemini-3.1-flash-lite');
    assert.equal(stripMaasPrefix('gpt-4.1-nano'), 'gpt-4.1-nano');
  });
});

describe('normalizeModelName', () => {
  // Observed on the cluster as the `model` label of authorized_hits.
  it('passes through names already in canonical form', () => {
    for (const name of KNOWN) {
      assert.equal(normalizeModelName(name, KNOWN), name);
    }
  });

  it('folds the dated model id OpenAI returns back onto the base name', () => {
    assert.equal(normalizeModelName('gpt-4.1-nano-2025-04-14', KNOWN), 'gpt-4.1-nano');
  });

  it('folds the dashed $safeName spelling back onto the dotted name', () => {
    assert.equal(normalizeModelName('gemini-3-1-flash-lite', KNOWN), 'gemini-3.1-flash-lite');
  });

  it('keeps an unknown model under its own name instead of merging it', () => {
    assert.equal(normalizeModelName('llama-4-scout', KNOWN), 'llama-4-scout');
  });

  it('does not fold a name that merely shares a prefix without a separator', () => {
    // `qwen3-8b-fp8x` is a different model, not a suffixed `qwen3-8b-fp8`.
    assert.equal(normalizeModelName('qwen3-8b-fp8x', KNOWN), 'qwen3-8b-fp8x');
  });
});

describe('extractModelFromNamespace', () => {
  // Every value below was read off the cluster from authorized_calls.
  const cases: Array<[string, string]> = [
    ['llm/qwen3-8b-fp8-kserve-route', 'qwen3-8b-fp8'],
    ['llm/nemotron-3-nano-30b-a3b-kserve-route', 'nemotron-3-nano-30b-a3b'],
    ['llm/gpt-4.1-nano', 'gpt-4.1-nano'],
    ['llm/gemini-3.1-flash-lite', 'gemini-3.1-flash-lite'],
    ['llm/gemini-3-1-flash-lite', 'gemini-3.1-flash-lite'],
  ];

  for (const [namespace, expected] of cases) {
    it(`maps ${namespace} to ${expected}`, () => {
      assert.equal(extractModelFromNamespace(namespace, KNOWN), expected);
    });
  }

  it('collapses both Gemini spellings onto one name', () => {
    // This is the duplicate-row bug: the gateway reports the external model
    // under both the dotted CR name and the dashed provider name.
    const dotted = extractModelFromNamespace('llm/gemini-3.1-flash-lite', KNOWN);
    const dashed = extractModelFromNamespace('llm/gemini-3-1-flash-lite', KNOWN);
    assert.equal(dotted, dashed);
  });
});

describe('resolveModel', () => {
  it('prefers the model label when the series has one (authorized_hits)', () => {
    assert.equal(
      resolveModel({ user: 'admin', model: 'gpt-4.1-nano-2025-04-14', value: 82 }, KNOWN),
      'gpt-4.1-nano',
    );
  });

  it('falls back to limitador_namespace when there is no model label (authorized_calls)', () => {
    assert.equal(
      resolveModel({ user: 'user1', limitador_namespace: 'llm/qwen3-8b-fp8-kserve-route' }, KNOWN),
      'qwen3-8b-fp8',
    );
  });

  it('ignores an empty model label rather than reporting an empty model', () => {
    assert.equal(
      resolveModel({ model: '', limitador_namespace: 'llm/gpt-4.1-nano' }, KNOWN),
      'gpt-4.1-nano',
    );
  });

  it('reports unknown when the series identifies no model at all', () => {
    assert.equal(resolveModel({ user: 'admin', value: 1 }, KNOWN), 'unknown');
  });

  it('resolves a hits series and a calls series for one model to the same key', () => {
    // If these disagree, chargeback shows two rows per user per model: one with
    // tokens and no requests, one with requests and no tokens.
    const fromHits = resolveModel({ user: 'admin', model: 'qwen3-8b-fp8' }, KNOWN);
    const fromCalls = resolveModel(
      { user: 'admin', limitador_namespace: 'llm/qwen3-8b-fp8-kserve-route' },
      KNOWN,
    );
    assert.equal(fromHits, fromCalls);
  });
});
