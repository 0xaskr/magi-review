import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, normalizeConfig, validateConfig, isFirstPartyProvider, resolveDefaultRoute, resolveSeatModels, resolveExecution, resolveDetail } from '../../lib/host/config.js';

const catalog = { providers: [
  { id: 'deepseek-official', models: [{ id: 'deepseek-flash' }] },
  { id: 'other', models: [{ id: 'second' }] },
] };

test('configuration defaults and deep merge do not alias caller or defaults', () => {
  assert.equal(DEFAULTS.execution.totalTimeoutMs, 1800000);
  assert.equal(DEFAULTS.execution.promptBudgetTokens, 16000);
  assert.equal(DEFAULTS.clerk.model, undefined);
  assert.deepEqual(DEFAULTS.seats.map(s => s.id), ['architect', 'engineer', 'adversary']);
  const raw = { execution: { concurrency: 2 }, clerk: { model: { provider: 'other', model: 'second' } } };
  const config = normalizeConfig(raw);
  assert.equal(config.execution.concurrency, 2);
  assert.equal(config.execution.ballotTimeoutMs, 60000);
  config.clerk.model.model = 'changed';
  config.seats[0].id = 'changed';
  assert.equal(raw.clerk.model.model, 'second');
  assert.equal(DEFAULTS.seats[0].id, 'architect');
  assert.deepEqual(validateConfig().errors, []);
});

test('invalid rosters, settings and unknown/prototype keys fall back safely', () => {
  for (const seats of [[], [{ id: 'x' }], [...DEFAULTS.seats, DEFAULTS.seats[0]],
    DEFAULTS.seats.map(s => ({ ...s, id: 'duplicate' })), DEFAULTS.seats.map(s => ({ ...s, perspective: ' ' }))]) {
    const result = validateConfig({ seats });
    assert.deepEqual(result.config.seats, DEFAULTS.seats);
    assert.ok(result.errors.some(e => e.includes('seats')));
  }
  const result = validateConfig(JSON.parse('{"__proto__":{"polluted":true},"alien":1,"execution":{"concurrency":9,"maxCostUsd":-1},"discussion":{"maxRounds":6},"policy":{"approval":"all","blockingSeverity":"none"}}'));
  assert.equal(result.errors.length, 5);
  assert.equal(result.warnings.length, 2);
  assert.equal(result.config.alien, undefined);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(result.config.policy, DEFAULTS.policy);
  for (const length of [3, 5, 7]) {
    const seats = Array.from({ length }, (_, i) => ({ id: `s${i}`, perspective: 'review' }));
    assert.equal(validateConfig({ seats }).errors.length, 0);
  }
});

test('seat routes prefer catalog pins and adversary model diversity', () => {
  const result = resolveSeatModels(DEFAULTS, catalog);
  assert.equal(result.homogeneous, false);
  assert.equal(result.pinned, false);
  assert.equal(result.assignments[2].provider, 'other');
  assert.equal(result.assignments[2].assignmentReason, 'adversary_model_diversity');
  const config = normalizeConfig();
  config.seats[2].model = { provider: 'deepseek-official', model: 'deepseek-flash' };
  const pinned = resolveSeatModels(config, catalog);
  assert.equal(pinned.homogeneous, true);
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.assignments[2].assignmentReason, 'explicit_pin');
});

test('unavailable routes never override a known catalog; empty catalogs are marked', () => {
  const config = normalizeConfig();
  config.seats[0].model = { provider: 'missing', model: 'missing' };
  const result = resolveSeatModels(config, { providers: [catalog.providers[1]] });
  assert.ok(result.assignments.every(a => a.provider === 'other'));
  assert.equal(result.assignments[0].assignmentReason, 'pin_unavailable_fallback');
  const empty = resolveSeatModels(config, { providers: [] });
  assert.ok(empty.assignments.every(a => a.available === false && a.fallback));
  assert.equal(empty.homogeneous, true);
  config.security.allowThirdPartyProviders = false;
  assert.ok(resolveSeatModels(config, catalog).assignments.every(a => a.provider === 'deepseek-official'));
});

test('execution validates limits, retains zero budget, and detail honors explicit args', () => {
  const execution = resolveExecution({ execution: { briefTimeoutMs: -1, concurrency: 0, maxCostUsd: 0, totalTimeoutMs: Infinity } });
  assert.equal(execution.briefTimeoutMs, 240000);
  assert.equal(execution.concurrency, 3);
  assert.equal(execution.totalTimeoutMs, 1800000);
  assert.equal(execution.maxCostUsd, 0);
  assert.equal(resolveDetail({}, { detail: 'full' }), 'full');
  assert.equal(resolveDetail({ output: { detail: 'full' } }, { detail: 'invalid' }), 'full');
});

test('execution overrides validate independently, including the prompt budget', () => {
  const execution = { concurrency: 2, briefTimeoutMs: 20, discussionRoundTimeoutMs: 30,
    ballotTimeoutMs: 40, totalTimeoutMs: 500, promptBudgetTokens: 200 };
  const checked = validateConfig({ execution });
  assert.deepEqual(checked.errors, []);
  for (const [key, value] of Object.entries(execution)) assert.equal(checked.config.execution[key], value);
  for (const value of [-1, 0, 1.5, Infinity, '16000']) {
    const invalid = validateConfig({ execution: { promptBudgetTokens: value } });
    assert.equal(invalid.config.execution.promptBudgetTokens, 16000);
    assert.ok(invalid.errors.some(e => e.startsWith('execution.promptBudgetTokens:')));
  }
});

test('identical models across providers are homogeneous; a different first-party id gets the adversary', () => {
  const routes = { providers: [structuredClone(catalog.providers[0]), { id: 'deepseek-account', models: [{ id: 'deepseek-flash' }] }] };
  const same = resolveSeatModels({}, routes);
  assert.equal(same.homogeneous, true);
  assert.ok(same.assignments.every(a => a.provider === 'deepseek-official'));
  const pinned = normalizeConfig(); pinned.seats[2].model = { provider: 'deepseek-account', model: 'deepseek-flash' };
  assert.equal(resolveSeatModels(pinned, routes).homogeneous, true);
  routes.providers[0].models = [...routes.providers[0].models, { id: 'deepseek-v4-pro' }];
  const diverse = resolveSeatModels({ security: { allowThirdPartyProviders: false } }, routes);
  assert.deepEqual(diverse.assignments.map(a => a.model), ['deepseek-flash', 'deepseek-flash', 'deepseek-v4-pro']);
  assert.equal(diverse.homogeneous, false);
  assert.equal(diverse.assignments[2].assignmentReason, 'adversary_model_diversity');
  assert.equal(resolveSeatModels({ execution: { maxCostUsd: 0 } }, routes).homogeneous, true);
});

test('first-party provider detection accepts DeepSeek routes only', () => {
  for (const provider of ['deepseek-official', 'deepseek-account', 'deepseek-private']) assert.equal(isFirstPartyProvider(provider), true);
  for (const provider of ['openrouter', 'other', 'deepseek', 'fake-deepseek-official', '', undefined]) assert.equal(isFirstPartyProvider(provider), false);
});

test('third-party prohibition fails closed when all catalog routes or the fallback are forbidden', () => {
  const config = normalizeConfig({ security: { allowThirdPartyProviders: false }, models: { defaultRoute: { provider: 'openrouter', model: 'third' } } });
  for (const routes of [{ providers: [{ id: 'openrouter', models: [{ id: 'third' }] }] }, { providers: [] }, undefined]) {
    const result = resolveSeatModels(config, routes);
    assert.deepEqual(result.assignments, []); assert.deepEqual(result.errors, ['no_allowed_providers']);
    assert.equal(resolveDefaultRoute(config, routes), undefined);
  }
  assert.deepEqual(resolveSeatModels({ security: { allowThirdPartyProviders: false } }, { providers: [catalog.providers[1]] }).assignments, []);
});

test('mixed catalogs select only allowed first-party models, including account and prefixed providers', () => {
  for (const provider of ['deepseek-official', 'deepseek-account', 'deepseek-private']) {
    const routes = { providers: [catalog.providers[1], { id: provider, models: [{ id: 'allowed' }] }] };
    const config = normalizeConfig({ security: { allowThirdPartyProviders: false }, models: { defaultRoute: { provider: 'other', model: 'second' } } });
    const result = resolveSeatModels(config, routes);
    assert.equal(result.assignments.length, 3); assert.ok(result.assignments.every(a => a.provider === provider));
    assert.deepEqual(result.errors, []);
    assert.deepEqual(resolveDefaultRoute(config, routes), { provider, model: 'allowed' });
  }
});

test('forbidden pins are ignored with warnings, while enabled third-party pins remain usable', () => {
  const config = normalizeConfig({ security: { allowThirdPartyProviders: false } });
  config.seats[0].model = { provider: 'other', model: 'second' };
  const forbidden = resolveSeatModels(config, catalog);
  assert.ok(forbidden.assignments.every(a => a.provider === 'deepseek-official'));
  assert.equal(forbidden.pinned, false); assert.ok(forbidden.warnings.some(w => /architect.*other/.test(w)));
  config.security.allowThirdPartyProviders = true;
  const enabled = resolveSeatModels(config, { providers: [catalog.providers[1]] });
  assert.ok(enabled.assignments.every(a => a.provider === 'other')); assert.equal(enabled.pinned, true);
  assert.deepEqual(enabled.errors, []);
  assert.deepEqual(resolveDefaultRoute(config, { providers: [catalog.providers[1]] }), { provider: 'other', model: 'second' });
});
