import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  GRID_WIDTH, GRID_HEIGHT, LAND, TsunamiSimulation, decodeBathymetry,
  deriveEarthquake, magnitudeToMoment, formatSimTime, wrapLongitude,
} from '../public/simulation.js';

test('moment and rupture scale monotonically with magnitude', () => {
  const m8 = deriveEarthquake({ magnitude: 8, focalDepthKm: 20, dipDeg: 18, mechanism: 'subduction' });
  const m9 = deriveEarthquake({ magnitude: 9, focalDepthKm: 20, dipDeg: 18, mechanism: 'subduction' });
  assert.ok(magnitudeToMoment(9) > magnitudeToMoment(8) * 30);
  assert.ok(m9.areaKm2 > m8.areaKm2);
  assert.ok(m9.slipM > m8.slipM);
  assert.ok(m9.verticalDisplacementM > m8.verticalDisplacementM);
});

test('fault mechanism and depth alter vertical coupling', () => {
  const base = { magnitude: 8.5, dipDeg: 20 };
  const shallow = deriveEarthquake({ ...base, focalDepthKm: 10, mechanism: 'subduction' });
  const deep = deriveEarthquake({ ...base, focalDepthKm: 80, mechanism: 'subduction' });
  const strikeSlip = deriveEarthquake({ ...base, focalDepthKm: 10, mechanism: 'strike-slip' });
  assert.ok(shallow.verticalDisplacementM > deep.verticalDisplacementM);
  assert.ok(shallow.verticalDisplacementM > strikeSlip.verticalDisplacementM);
});

test('bathymetry asset has valid global dimensions and both land and ocean', async () => {
  const file = await readFile(new URL('../public/data/bathymetry.bin', import.meta.url));
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  const depths = decodeBathymetry(buffer);
  assert.equal(depths.length, GRID_WIDTH * GRID_HEIGHT);
  assert.ok(depths.some(value => value === LAND));
  assert.ok(depths.some(value => value > 1000 && value !== LAND));
});

test('wave solver remains finite and spreads over ocean', () => {
  const depths = new Uint16Array(GRID_WIDTH * GRID_HEIGHT).fill(4200);
  const simulation = new TsunamiSimulation(depths);
  simulation.trigger({
    longitude: -150, latitude: 10, magnitude: 9, focalDepthKm: 20,
    strikeDeg: 10, dipDeg: 18, mechanism: 'subduction',
  });
  const initiallyReached = simulation.maxAbs.reduce((count, value) => count + (value > 1e-7), 0);
  for (let i = 0; i < 180; i++) simulation.step();
  const eventuallyReached = simulation.maxAbs.reduce((count, value) => count + (value > 1e-7), 0);
  assert.equal(simulation.timeSeconds, 10800);
  assert.ok(eventuallyReached > initiallyReached);
  assert.ok(simulation.current.every(Number.isFinite));
  assert.ok(Math.max(...simulation.maxAbs) < 30);
});

test('land cannot be selected as an epicenter and remains dry', () => {
  const depths = new Uint16Array(100).fill(4000);
  const simulation = new TsunamiSimulation(depths, 10, 10);
  const source = simulation.cellFor(0, 0);
  depths[source.index] = LAND;
  assert.equal(simulation.isOcean(0, 0), false);
  assert.throws(() => simulation.trigger({
    longitude: 0, latitude: 0, magnitude: 8, focalDepthKm: 20,
    strikeDeg: 0, dipDeg: 20, mechanism: 'subduction',
  }), /ocean water/);
});

test('coordinate and time helpers handle boundaries', () => {
  assert.equal(wrapLongitude(181), -179);
  assert.equal(wrapLongitude(-181), 179);
  assert.equal(formatSimTime(93780), '1d 02:03');
});
