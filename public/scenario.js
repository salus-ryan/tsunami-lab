const MECHANISMS = new Set(['subduction', 'normal', 'strike-slip']);
const ENSEMBLE_SIZES = new Set([1, 3, 5]);
const SPEEDS = new Set([1, 4, 12]);

function finiteNumber(value, name, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`Invalid ${name}`);
  }
  return number;
}

export function normalizeScenario(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid scenario');
  const source = input.event || input;
  const mechanism = MECHANISMS.has(source.mechanism) ? source.mechanism : 'subduction';
  const ensembleMembers = Number(input.ensembleMembers ?? 3);
  const speed = Number(input.speed ?? 4);
  return {
    version: 1,
    event: {
      latitude: finiteNumber(source.latitude, 'latitude', -80, 80),
      longitude: finiteNumber(source.longitude, 'longitude', -180, 180),
      magnitude: finiteNumber(source.magnitude, 'magnitude', 6, 9.5),
      focalDepthKm: finiteNumber(source.focalDepthKm, 'focal depth', 5, 100),
      strikeDeg: finiteNumber(source.strikeDeg, 'strike', 0, 359),
      dipDeg: finiteNumber(source.dipDeg, 'dip', 5, 80),
      rakeDeg: finiteNumber(source.rakeDeg, 'rake', -180, 180),
      mechanism,
    },
    tideLevelM: finiteNumber(input.tideLevelM ?? 0, 'tidal stage', -3, 3),
    ensembleMembers: ENSEMBLE_SIZES.has(ensembleMembers) ? ensembleMembers : 3,
    speed: SPEEDS.has(speed) ? speed : 4,
  };
}

function encodeUtf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeUtf8(value) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeScenarioHash(input) {
  return `#scenario=${encodeUtf8(JSON.stringify(normalizeScenario(input)))}`;
}

export function decodeScenarioHash(hash) {
  if (typeof hash !== 'string' || !hash.startsWith('#scenario=') || hash.length > 4096) return null;
  try {
    const encoded = hash.slice('#scenario='.length);
    return normalizeScenario(JSON.parse(decodeUtf8(encoded)));
  } catch {
    return null;
  }
}
