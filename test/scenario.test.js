import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeScenarioHash, encodeScenarioHash, normalizeScenario } from '../public/scenario.js';

const SCENARIO = {
  event: {
    latitude: 38.3,
    longitude: 143.1,
    magnitude: 9.1,
    focalDepthKm: 29,
    strikeDeg: 193,
    dipDeg: 14,
    rakeDeg: 90,
    mechanism: 'subduction',
  },
  tideLevelM: 1.5,
  ensembleMembers: 5,
  speed: 12,
};

test('shared scenario hashes round-trip all reproducibility settings', () => {
  const normalized = normalizeScenario(SCENARIO);
  const hash = encodeScenarioHash(SCENARIO);
  assert.match(hash, /^#scenario=[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeScenarioHash(hash), normalized);
});

test('scenario normalization rejects unsafe numeric values and bounds', () => {
  assert.throws(() => normalizeScenario({ ...SCENARIO, event: { ...SCENARIO.event, magnitude: 99 } }), /magnitude/);
  assert.throws(() => normalizeScenario({ ...SCENARIO, event: { ...SCENARIO.event, latitude: Number.NaN } }), /latitude/);
  assert.equal(decodeScenarioHash('#scenario=not-valid-json'), null);
  assert.equal(decodeScenarioHash('#other=value'), null);
});

test('unknown safe options fall back without mutating the source event', () => {
  const source = { ...SCENARIO, event: { ...SCENARIO.event, mechanism: 'mystery' }, ensembleMembers: 2, speed: 99 };
  const normalized = normalizeScenario(source);
  assert.equal(normalized.event.mechanism, 'subduction');
  assert.equal(normalized.ensembleMembers, 3);
  assert.equal(normalized.speed, 4);
  assert.equal(source.event.mechanism, 'mystery');
});
