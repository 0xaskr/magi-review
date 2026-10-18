import { it } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, redactValue } from '../../lib/core/redact.js';
import { frozen } from '../fixtures/core-fixtures.js';

const fixtures = [
  ['private_key', '-----BEGIN RSA PRIVATE KEY-----\nvery private material\n-----END RSA PRIVATE KEY-----'],
  ['private_key', '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----'],
  ['private_key', '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----'],
  ['openai_key', 'sk-abcdefghijklmnop0123'], ['aws_key', 'AKIA1234567890ABCDEF'],
  ['github_token', 'ghp_abcdefghijklmnopqrstuvwxyz'], ['github_token', 'gho_abcdefghijklmnopqrstuvwxyz'],
  ['slack_token', 'xoxb-1234567890-abcdef'], ['credential_assignment', 'api_key: value123'],
  ['credential_assignment', 'API-KEY = value123'], ['credential_assignment', 'secret: value123'],
  ['credential_assignment', 'token: value123'], ['credential_assignment', 'password: "value with spaces"'],
  ['bearer', 'Bearer abcdefghijklmnop.123'], ['url_credentials', '://alice:password@'],
  ['env_assignment', 'DATABASE_URL=postgres://localhost/mydb'], ['env_assignment', 'export CUSTOM_VALUE="private value"'],
];
for (const [index, [rule, secret]] of fixtures.entries()) it(`redacts ${rule} fixture ${index}`, () => {
  const result = redactSecrets(secret); assert.equal(result.text, `[REDACTED:${rule}]`); assert.equal(result.count, 1);
  assert.deepEqual(result.hits, [{ rule, index: 0 }]); assert.ok(!JSON.stringify(result.hits).includes(secret));
});
it('redacts private keys through end of input if the end marker is absent', () => {
  assert.equal(redactSecrets('-----BEGIN EC PRIVATE KEY-----\nsecret').text, '[REDACTED:private_key]');
});
it('URL credential replacement retains host and resource', () => {
  assert.equal(redactSecrets('https://alice:s3cr3t@example.com/path').text, 'https[REDACTED:url_credentials]example.com/path');
});
it('hits use original offsets across multiple rules', () => {
  const a = 'sk-abcdefghijklmnop', b = 'AKIA1234567890ABCDEF';
  const result = redactSecrets(`prefix ${a} suffix ${b}`);
  assert.deepEqual(result.hits, [{ rule: 'openai_key', index: 7 }, { rule: 'aws_key', index: 7 + a.length + 8 }]); assert.equal(result.count, 2);
});
it('overlaps do not leak tails or double count a secret', () => {
  const result = redactSecrets('token=sk-abcdefghijklmnop0123');
  assert.equal(result.count, 1); assert.ok(!result.text.includes('abcdefghijkl')); assert.equal(redactSecrets(result.text).count, 0);
});
it('an existing placeholder does not bypass redaction of trailing env content', () => {
  assert.equal(redactSecrets('CUSTOM=[REDACTED:env_assignment] still-private').text, '[REDACTED:env_assignment]');
});
it('redacts lowercase env and diff-prefixed env assignments', () => {
  assert.equal(redactSecrets('+CUSTOM_VALUE=hidden\r\nusername=hidden').count, 2);
});
it('ordinary words, short token-like text, public keys and URLs are unchanged', () => {
  const input = 'The password and token are documented. A secret remains private.\nexport function login() {}\nhttps://example.com/x\nsk-short\nBearer small\n-----BEGIN PUBLIC KEY-----\npublic\n-----END PUBLIC KEY-----';
  assert.deepEqual(redactSecrets(input), { text: input, count: 0, hits: [] });
});
it('recursively redacts string values without mutating keys or scalar values', () => {
  const input = frozen({ nested: ['token: hidden', { password: 'sk-abcdefghijklmnop' }], count: 3, ok: true, nil: null });
  const result = redactValue(input);
  assert.match(result.nested[0], /REDACTED/); assert.match(result.nested[1].password, /REDACTED/);
  assert.equal(result.count, 3); assert.equal(result.ok, true); assert.equal(result.nil, null); assert.equal(input.nested[0], 'token: hidden');
});
it('retains dangerous-looking JSON keys as own properties without prototype changes', () => {
  const input = JSON.parse('{"__proto__":{"value":"token: hidden"}}');
  const result = redactValue(input); assert.ok(Object.hasOwn(result, '__proto__')); assert.equal(Object.getPrototypeOf(result), Object.prototype);
});
