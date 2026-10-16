import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, getQuestionPool } from './questions.js';

/** The preamble is everything before the question marker buildPrompt appends. */
function preambleOf(prompt: string): string {
  const marker = '\n\nGiven the context above, answer: ';
  const i = prompt.indexOf(marker);
  return i === -1 ? '' : prompt.slice(0, i);
}

describe('buildPrompt', () => {
  it('returns the bare question for the short shape', () => {
    const p = buildPrompt('short', 1500);
    assert.ok(getQuestionPool().includes(p), 'short prompts should come straight from the pool');
  });

  it('gives every shared-prefix request a byte-identical preamble', () => {
    // This is the whole point of the shape: if the preambles differ at all, the prefix
    // cache cannot hit and the cache-aware routing demo shows nothing.
    const a = preambleOf(buildPrompt('shared-prefix', 1500));
    const b = preambleOf(buildPrompt('shared-prefix', 1500));
    assert.equal(a, b);
    assert.ok(a.length > 0);
  });

  it('gives every unique-prefix request a different preamble', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) seen.add(preambleOf(buildPrompt('unique-prefix', 800)));
    assert.equal(seen.size, 20, 'a repeated preamble would be served from cache and create no load');
  });

  it('still varies the question within a shared preamble', () => {
    const questions = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const p = buildPrompt('shared-prefix', 400);
      questions.add(p.slice(preambleOf(p).length));
    }
    assert.ok(questions.size > 1, 'the suffix should vary even when the prefix does not');
  });

  it('scales the preamble with the requested token count', () => {
    const small = preambleOf(buildPrompt('unique-prefix', 300)).length;
    const large = preambleOf(buildPrompt('unique-prefix', 3000)).length;
    assert.ok(large > small * 5, `expected roughly 10x, got ${small} then ${large}`);
  });

  it('lands within a reasonable distance of the requested length', () => {
    // Four characters per token is a rule of thumb, not a promise; the loop also
    // overshoots by up to one sentence. Being in the right order of magnitude is
    // what matters, since the point is filling KV cache, not exact accounting.
    const chars = preambleOf(buildPrompt('unique-prefix', 1000)).length;
    assert.ok(chars >= 4000 && chars < 4000 + 200, `got ${chars} characters`);
  });
});
