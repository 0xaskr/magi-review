import { it } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, stableStringify, sha256Hex } from '../../lib/core/json.js';

it('prefers the last JSON fence over prose and earlier fences', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```\n```JSON\n{"a":2}\n```\n{"a":3}'), { a: 2 });
});
it('invalid last fence fails closed rather than reusing old valid output', () => {
  assert.equal(extractJson('```json\n{"a":1}\n```\n```json\n{oops}\n```'), null);
});
it('finds the last balanced object, respecting nested objects and escaped strings', () => {
  const value = { nested: { text: 'brace } and quote " and slash \\' }, values: [1, { ok: true }] };
  assert.deepEqual(extractJson(`prose {"old":true} next ${JSON.stringify(value)} tail`), value);
});
it('does not confuse braces inside JSON strings or unfinished trailing objects', () => {
  assert.deepEqual(extractJson('{"brace":"{ }"} trailing {"unfinished":'), { brace: '{ }' });
});
it('finds the last balanced object even after an unmatched prose brace', () => {
  assert.deepEqual(extractJson('prose { incomplete then {"valid":true}'), { valid: true });
});
it('invalid JSON, scalars, arrays, empty input and non-string input return null', () => {
  for (const text of ['{no}', '```json\n[]\n```', '```json\nnull\n```', '```json\n12\n```', '', null]) assert.equal(extractJson(text), null);
});
it('stableStringify sorts keys recursively and preserves array order', () => {
  assert.equal(stableStringify({ z: [3, { z: 2, a: 1 }], a: 0 }), '{"a":0,"z":[3,{"a":1,"z":2}]}');
  assert.equal(stableStringify({ 2: true, 10: false }), '{"10":false,"2":true}');
});
it('stableStringify follows undefined, sparse-array, NaN and toJSON semantics', () => {
  assert.equal(stableStringify({ b: undefined, c: NaN, a: [undefined, , Infinity] }), '{"a":[null,null,null],"c":null}');
  assert.equal(stableStringify(new Date('2026-10-18T00:00:00Z')), '"2026-10-18T00:00:00.000Z"');
  assert.equal(stableStringify(undefined), undefined);
});
it('shared references work, cycles and BigInt throw', () => {
  const shared = { x: 1 }; assert.equal(stableStringify([shared, shared]), '[{"x":1},{"x":1}]');
  const cyclic = {}; cyclic.self = cyclic; assert.throws(() => stableStringify(cyclic), TypeError); assert.throws(() => stableStringify(1n), TypeError);
});
it('hashes exact UTF-8 text with SHA-256', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});
