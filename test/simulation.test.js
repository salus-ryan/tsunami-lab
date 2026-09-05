import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  GRID_WIDTH, GRID_HEIGHT, LAND, TsunamiSimulation, decodeBathymetry,
  deriveEarthquake, defaultRakeForMechanism, magnitudeToMoment, formatSimTime, wrapLongitude,
} from '../public/simulation.js';

const EVENT = {
  longitude: -150, latitude: 10, magnitude: 9, focalDepthKm: 20,
  strikeDeg: 10, dipDeg: 18, rakeDeg: 90, mechanism: 'subduction',
};

function allOcean(depth = 4200) {
  return new Uint16Array(GRID_WIDTH * GRID_HEIGHT).fill(depth);
}

test('moment, rupture, and patch count scale monotonically with magnitude', () => {
  const m8 = deriveEarthquake({ magnitude: 8, focalDepthKm: 20, dipDeg: 18, mechanism: 'subduction' });
  const m9 = deriveEarthquake({ magnitude: 9, focalDepthKm: 20, dipDeg: 18, mechanism: 'subduction' });
  assert.ok(magnitudeToMoment(9) > magnitudeToMoment(8) * 30);
  assert.ok(m9.areaKm2 > m8.areaKm2);
  assert.ok(m9.slipM > m8.slipM);
  assert.ok(m9.verticalDisplacementM > m8.verticalDisplacementM);
  assert.ok(m9.patchCount > m8.patchCount);
});

test('depth, mechanism, and rake alter vertical coupling', () => {
  const base = { magnitude: 8.5, dipDeg: 20 };
  const shallow = deriveEarthquake({ ...base, focalDepthKm: 10, mechanism: 'subduction', rakeDeg: 90 });
  const deep = deriveEarthquake({ ...base, focalDepthKm: 80, mechanism: 'subduction', rakeDeg: 90 });
  const oblique = deriveEarthquake({ ...base, focalDepthKm: 10, mechanism: 'subduction', rakeDeg: 30 });
  const strikeSlip = deriveEarthquake({ ...base, focalDepthKm: 10, mechanism: 'strike-slip', rakeDeg: 0 });
  assert.ok(shallow.verticalDisplacementM > deep.verticalDisplacementM);
  assert.ok(shallow.verticalDisplacementM > oblique.verticalDisplacementM);
  assert.ok(shallow.verticalDisplacementM > strikeSlip.verticalDisplacementM);
  assert.equal(defaultRakeForMechanism('normal'), -90);
  assert.equal(defaultRakeForMechanism('strike-slip'), 0);
});

test('bathymetry asset has one-degree global dimensions and both land and ocean', async () => {
  const file = await readFile(new URL('../public/data/bathymetry.bin', import.meta.url));
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  const depths = decodeBathymetry(buffer);
  assert.equal(GRID_WIDTH, 360);
  assert.equal(GRID_HEIGHT, 160);
  assert.equal(depths.length, GRID_WIDTH * GRID_HEIGHT);
  assert.ok(depths.some(value => value === LAND));
  assert.ok(depths.some(value => value > 1000 && value !== LAND));
});

test('finite fault creates heterogeneous patches and ruptures progressively', () => {
  const simulation = new TsunamiSimulation(allOcean());
  const derived = simulation.trigger(EVENT);
  assert.equal(simulation.rupturePatches.length, derived.patchCount);
  assert.equal(Math.max(...simulation.current), 0);
  simulation.step();
  const earlyPeak = Math.max(...simulation.current.map(Math.abs));
  for (let i = 0; i < 20; i++) simulation.step();
  const maturePeak = Math.max(...simulation.maxAbs);
  assert.ok(earlyPeak > 0);
  assert.ok(maturePeak >= earlyPeak);
  assert.ok(maturePeak <= derived.verticalDisplacementM * 1.25);
});

test('adaptive CFL step caps an oversized requested time step', () => {
  const simulation = new TsunamiSimulation(allOcean(8000));
  simulation.trigger(EVENT);
  const advanced = simulation.step(1000);
  assert.equal(advanced, simulation.stableDtSeconds);
  assert.ok(advanced >= 2 && advanced <= 30);
  assert.equal(simulation.timeSeconds, advanced);
});

test('staggered solver remains finite and spreads over ocean', () => {
  const simulation = new TsunamiSimulation(allOcean());
  simulation.trigger(EVENT);
  const initiallyReached = simulation.maxAbs.reduce((count, value) => count + (value > 1e-7), 0);
  let elapsed = 0;
  for (let i = 0; i < 180; i++) elapsed += simulation.step();
  const eventuallyReached = simulation.maxAbs.reduce((count, value) => count + (value > 1e-7), 0);
  assert.equal(simulation.timeSeconds, elapsed);
  assert.ok(eventuallyReached > initiallyReached + 20);
  assert.ok(simulation.current.every(Number.isFinite));
  assert.ok(simulation.qx.every(Number.isFinite));
  assert.ok(simulation.qy.every(Number.isFinite));
  assert.ok(Math.max(...simulation.maxAbs) < 30);
});

test('face-flux update conserves global water volume after rupture', () => {
  const simulation = new TsunamiSimulation(allOcean());
  simulation.trigger(EVENT);
  for (let i = 0; i < 25; i++) simulation.step();
  const before = simulation.current.reduce((sum, value) => sum + value, 0);
  for (let i = 0; i < 80; i++) simulation.step();
  const after = simulation.current.reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(after - before) < 0.02, `volume drift ${after - before}`);
});

test('land cannot be selected and land cells remain dry', () => {
  const depths = new Uint16Array(100).fill(4000);
  const simulation = new TsunamiSimulation(depths, 10, 10);
  const source = simulation.cellFor(0, 0);
  depths[source.index] = LAND;
  assert.equal(simulation.isOcean(0, 0), false);
  assert.throws(() => simulation.trigger({
    longitude: 0, latitude: 0, magnitude: 8, focalDepthKm: 20,
    strikeDeg: 0, dipDeg: 20, rakeDeg: 90, mechanism: 'subduction',
  }), /ocean water/);

  depths[source.index] = 4000;
  depths[source.index + 1] = LAND;
  simulation.trigger({ ...EVENT, longitude: 0, latitude: 0 });
  for (let i = 0; i < 20; i++) simulation.step();
  assert.equal(simulation.current[source.index + 1], 0);
});

test('nearest-ocean search returns a deterministic nearby water cell', () => {
  const depths = new Uint16Array(100).fill(LAND);
  const simulation = new TsunamiSimulation(depths, 10, 10);
  const origin = simulation.cellFor(0, 0);
  const oceanIndex = origin.row * 10 + ((origin.col + 1) % 10);
  depths[oceanIndex] = 1200;
  const result = simulation.nearestOceanCell(0, 0);
  assert.equal(result.index, oceanIndex);
});

test('coordinate and time helpers handle boundaries', () => {
  assert.equal(wrapLongitude(181), -179);
  assert.equal(wrapLongitude(-181), 179);
  assert.equal(formatSimTime(93780), '1d 02:03');
});
