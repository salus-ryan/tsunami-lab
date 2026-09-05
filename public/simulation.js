export const GRID_WIDTH = 360;
export const GRID_HEIGHT = 160;
export const LAT_MIN = -80;
export const LAT_MAX = 80;
export const LAND = 65535;
export const G = 9.80665;
export const EARTH_ROTATION = 7.2921159e-5;
export const DEFAULT_DT_SECONDS = 20;

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function wrapLongitude(lon) {
  return ((lon + 540) % 360) - 180;
}

export function magnitudeToMoment(magnitude) {
  return 10 ** (1.5 * magnitude + 9.1);
}

export function defaultRakeForMechanism(mechanism) {
  if (mechanism === 'normal') return -90;
  if (mechanism === 'strike-slip') return 0;
  return 90;
}

export function deriveEarthquake({ magnitude, focalDepthKm, dipDeg, mechanism = 'subduction', rakeDeg }) {
  const resolvedRake = Number.isFinite(rakeDeg) ? rakeDeg : defaultRakeForMechanism(mechanism);
  const areaKm2 = 10 ** (-3.49 + 0.91 * magnitude);
  const aspectRatio = mechanism === 'strike-slip' ? 4 : 2.5;
  const lengthKm = Math.sqrt(areaKm2 * aspectRatio);
  const widthKm = areaKm2 / lengthKm;
  const momentNm = magnitudeToMoment(magnitude);
  const slipM = momentNm / (3e10 * areaKm2 * 1e6);
  const rakeCoupling = Math.max(mechanism === 'strike-slip' ? 0.035 : 0.08, Math.abs(Math.sin(resolvedRake * Math.PI / 180)));
  const mechanismCoupling = mechanism === 'strike-slip' ? 0.16 : mechanism === 'normal' ? 0.62 : 0.84;
  const verticalDisplacementM = clamp(
    slipM * Math.sin(dipDeg * Math.PI / 180) * rakeCoupling * mechanismCoupling * Math.exp(-focalDepthKm / 55),
    0,
    14,
  );
  const alongPatches = clamp(Math.ceil(lengthKm / 75), 2, 14);
  const acrossPatches = clamp(Math.ceil(widthKm / 60), 1, 6);
  return {
    areaKm2, lengthKm, widthKm, momentNm, slipM, verticalDisplacementM,
    rakeDeg: resolvedRake, alongPatches, acrossPatches, patchCount: alongPatches * acrossPatches,
  };
}

export function decodeBathymetry(buffer, expectedCells = GRID_WIDTH * GRID_HEIGHT) {
  if (buffer.byteLength !== expectedCells * 2) {
    throw new Error(`Bathymetry size mismatch: expected ${expectedCells * 2} bytes, got ${buffer.byteLength}`);
  }
  const view = new DataView(buffer);
  const depths = new Uint16Array(expectedCells);
  for (let i = 0; i < expectedCells; i++) depths[i] = view.getUint16(i * 2, true);
  return depths;
}

export function formatSimTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  return `${days ? `${days}d ` : ''}${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function smoothStep(value) {
  const x = clamp(value, 0, 1);
  return x * x * (3 - 2 * x);
}

export class TsunamiSimulation {
  constructor(depths, width = GRID_WIDTH, height = GRID_HEIGHT) {
    if (depths.length !== width * height) throw new Error('Depth grid dimensions do not match');
    this.width = width;
    this.height = height;
    this.depths = depths;
    this.current = new Float32Array(width * height);
    this.next = new Float32Array(width * height);
    // qx and qy are depth-integrated transports on each cell's right and lower faces.
    this.qx = new Float32Array(width * height);
    this.qy = new Float32Array(width * height);
    this.maxAbs = new Float32Array(width * height);
    this.dxByRow = new Float64Array(height);
    this.dyM = (LAT_MAX - LAT_MIN) / height * 111195;
    this.timeSeconds = 0;
    this.event = null;
    this.source = null;
    this.sourceAmplitudeM = 0;
    this.rupturePatches = [];
    this.stableDtSeconds = this.#calculateStableTimeStep();
  }

  #calculateStableTimeStep() {
    const lonStepM = 360 / this.width * 111195;
    let stable = Infinity;
    for (let row = 0; row < this.height; row++) {
      const lat = this.latForRow(row) * Math.PI / 180;
      const dx = Math.max(5000, lonStepM * Math.cos(lat));
      this.dxByRow[row] = dx;
      for (let col = 0; col < this.width; col++) {
        const depth = this.depths[row * this.width + col];
        if (depth === LAND) continue;
        const c = Math.sqrt(G * Math.min(depth, 8000));
        const candidate = 0.44 / (c * Math.sqrt(1 / (dx * dx) + 1 / (this.dyM * this.dyM)));
        if (candidate < stable) stable = candidate;
      }
    }
    return Number.isFinite(stable) ? clamp(stable, 2, 30) : DEFAULT_DT_SECONDS;
  }

  clear() {
    this.current.fill(0);
    this.next.fill(0);
    this.qx.fill(0);
    this.qy.fill(0);
    this.maxAbs.fill(0);
    this.timeSeconds = 0;
    this.event = null;
    this.source = null;
    this.sourceAmplitudeM = 0;
    this.rupturePatches = [];
  }

  lonForColumn(col) {
    return -180 + (col + 0.5) / this.width * 360;
  }

  latForRow(row) {
    return LAT_MAX - (row + 0.5) / this.height * (LAT_MAX - LAT_MIN);
  }

  cellFor(lon, lat) {
    const col = clamp(Math.floor((wrapLongitude(lon) + 180) / 360 * this.width), 0, this.width - 1);
    const row = clamp(Math.floor((LAT_MAX - clamp(lat, LAT_MIN, LAT_MAX)) / (LAT_MAX - LAT_MIN) * this.height), 0, this.height - 1);
    return { col, row, index: row * this.width + col };
  }

  isOcean(lon, lat) {
    return this.depths[this.cellFor(lon, lat).index] !== LAND;
  }

  nearestOceanCell(lon, lat, maxRadius = 12) {
    const origin = this.cellFor(lon, lat);
    if (this.depths[origin.index] !== LAND) return origin;
    for (let radius = 1; radius <= maxRadius; radius++) {
      let best = null;
      let bestDistance = Infinity;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
          const row = origin.row + dy;
          const col = (origin.col + dx + this.width) % this.width;
          if (row < 0 || row >= this.height) continue;
          const index = row * this.width + col;
          const distance = dx * dx * Math.cos(lat * Math.PI / 180) ** 2 + dy * dy;
          if (this.depths[index] !== LAND && distance < bestDistance) {
            best = { row, col, index };
            bestDistance = distance;
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  trigger(event) {
    const sourceCell = this.cellFor(event.longitude, event.latitude);
    if (this.depths[sourceCell.index] === LAND) throw new Error('The epicenter must be in ocean water');
    this.clear();
    const derived = deriveEarthquake(event);
    this.event = { ...event, rakeDeg: derived.rakeDeg, derived };
    this.source = sourceCell;
    this.sourceAmplitudeM = derived.verticalDisplacementM;
    this.#buildFiniteFaultPatches(derived);
    return derived;
  }

  #buildFiniteFaultPatches(derived) {
    const event = this.event;
    const strike = event.strikeDeg * Math.PI / 180;
    const lat0 = event.latitude * Math.PI / 180;
    const patchLength = derived.lengthKm / derived.alongPatches;
    const patchWidth = derived.widthKm / derived.acrossPatches;
    const target = new Float64Array(this.width * this.height);
    const patches = [];

    for (let a = 0; a < derived.alongPatches; a++) {
      const alongCenter = ((a + 0.5) / derived.alongPatches - 0.5) * derived.lengthKm;
      for (let b = 0; b < derived.acrossPatches; b++) {
        const acrossCenter = ((b + 0.5) / derived.acrossPatches - 0.5) * derived.widthKm;
        const eastCenter = alongCenter * Math.sin(strike) + acrossCenter * Math.cos(strike);
        const northCenter = alongCenter * Math.cos(strike) - acrossCenter * Math.sin(strike);
        const centerLat = event.latitude + northCenter / 111.195;
        const centerLon = wrapLongitude(event.longitude + eastCenter / (111.195 * Math.max(0.2, Math.cos(lat0))));
        const sigmaAlong = Math.max(28, patchLength * 0.72);
        const sigmaAcross = Math.max(24, patchWidth * 0.78);
        const taper = Math.sin(Math.PI * (a + 0.5) / derived.alongPatches) ** 0.35;
        const asperity = 1 + 0.28 * Math.sin((a + 1) * 2.17 + (b + 1) * 1.31);
        const slipWeight = taper * asperity;
        const indices = [];
        const values = [];

        for (let row = 0; row < this.height; row++) {
          const lat = this.latForRow(row);
          const northKm = (lat - centerLat) * 111.195;
          if (Math.abs(northKm) > (sigmaAlong + sigmaAcross) * 4) continue;
          for (let col = 0; col < this.width; col++) {
            const index = row * this.width + col;
            if (this.depths[index] === LAND) continue;
            const lon = this.lonForColumn(col);
            const eastKm = wrapLongitude(lon - centerLon) * 111.195 * Math.cos(lat0);
            const localAlong = eastKm * Math.sin(strike) + northKm * Math.cos(strike);
            const localAcross = eastKm * Math.cos(strike) - northKm * Math.sin(strike);
            if (Math.abs(localAlong) > sigmaAlong * 3.2 || Math.abs(localAcross) > sigmaAcross * 3.2) continue;
            const sourceEast = wrapLongitude(lon - event.longitude) * 111.195 * Math.cos(lat0);
            const sourceNorth = (lat - event.latitude) * 111.195;
            const globalAcross = sourceEast * Math.cos(strike) - sourceNorth * Math.sin(strike);
            const polarity = Math.tanh(globalAcross / Math.max(18, derived.widthKm * 0.2));
            const envelope = Math.exp(-0.5 * ((localAlong / sigmaAlong) ** 2 + (localAcross / sigmaAcross) ** 2));
            const raw = slipWeight * envelope * polarity;
            if (Math.abs(raw) < 1e-4) continue;
            indices.push(index);
            values.push(raw);
            target[index] += raw;
          }
        }

        const ruptureDistance = Math.hypot(alongCenter + derived.lengthKm * 0.18, acrossCenter);
        patches.push({
          indices: Int32Array.from(indices),
          values: Float32Array.from(values),
          activationSeconds: ruptureDistance / 2.6,
          riseSeconds: clamp(Math.hypot(patchLength, patchWidth) / 2.8, 20, 90),
          progress: 0,
        });
      }
    }

    let peak = 0;
    for (let i = 0; i < target.length; i++) peak = Math.max(peak, Math.abs(target[i]));
    const scale = peak > 0 ? derived.verticalDisplacementM / peak : 0;
    for (const patch of patches) {
      for (let i = 0; i < patch.values.length; i++) patch.values[i] *= scale;
    }
    this.rupturePatches = patches;
  }

  #applyProgressiveRupture(endTime) {
    for (const patch of this.rupturePatches) {
      const progress = smoothStep((endTime - patch.activationSeconds) / patch.riseSeconds);
      const delta = progress - patch.progress;
      if (delta <= 0) continue;
      for (let i = 0; i < patch.indices.length; i++) {
        const index = patch.indices[i];
        this.current[index] += patch.values[i] * delta;
      }
      patch.progress = progress;
    }
  }

  step(requestedDtSeconds = DEFAULT_DT_SECONDS) {
    if (!this.event) return 0;
    const dt = Math.min(requestedDtSeconds, this.stableDtSeconds);
    const w = this.width;
    const h = this.height;
    this.#applyProgressiveRupture(this.timeSeconds + dt);

    // Forward-backward staggered-grid update. Face transports enforce zero normal
    // flow at land while the center update conserves water volume across faces.
    for (let row = 0; row < h; row++) {
      const dx = this.dxByRow[row];
      for (let col = 0; col < w; col++) {
        const i = row * w + col;
        const right = row * w + (col + 1) % w;
        const down = row < h - 1 ? i + w : -1;
        const depth = this.depths[i];

        if (depth === LAND || this.depths[right] === LAND) this.qx[i] = 0;
        else {
          const faceDepth = 2 * depth * this.depths[right] / (depth + this.depths[right]);
          this.qx[i] -= G * faceDepth * dt * (this.current[right] - this.current[i]) / dx;
        }

        if (down < 0 || depth === LAND || this.depths[down] === LAND) this.qy[i] = 0;
        else {
          const faceDepth = 2 * depth * this.depths[down] / (depth + this.depths[down]);
          this.qy[i] -= G * faceDepth * dt * (this.current[down] - this.current[i]) / this.dyM;
        }
      }
    }

    for (let row = 0; row < h; row++) {
      const coriolis = 2 * EARTH_ROTATION * Math.sin(this.latForRow(row) * Math.PI / 180);
      const angle = coriolis * dt;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      for (let col = 0; col < w; col++) {
        const i = row * w + col;
        const depth = this.depths[i];
        if (depth === LAND) continue;
        const oldX = this.qx[i];
        const oldY = this.qy[i];
        const rotatedX = oldX * cosine + oldY * sine;
        const rotatedY = oldY * cosine - oldX * sine;
        const speed = Math.hypot(rotatedX, rotatedY) / Math.max(25, depth);
        const frictionRate = G * 0.025 ** 2 * speed / Math.max(25, depth) ** (4 / 3);
        const attenuation = 1 / (1 + dt * frictionRate);
        this.qx[i] = rotatedX * attenuation;
        this.qy[i] = rotatedY * attenuation;
      }
    }

    for (let row = 0; row < h; row++) {
      const dx = this.dxByRow[row];
      const polarSponge = row < 4 || row > h - 5 ? 0.9985 : 1;
      for (let col = 0; col < w; col++) {
        const i = row * w + col;
        if (this.depths[i] === LAND) {
          this.next[i] = 0;
          continue;
        }
        const leftFace = row * w + (col + w - 1) % w;
        const upFace = row > 0 ? i - w : -1;
        const divergenceX = (this.qx[i] - this.qx[leftFace]) / dx;
        const divergenceY = (this.qy[i] - (upFace >= 0 ? this.qy[upFace] : 0)) / this.dyM;
        const value = (this.current[i] - dt * (divergenceX + divergenceY)) * polarSponge;
        this.next[i] = Number.isFinite(value) ? value : 0;
      }
    }

    const old = this.current;
    this.current = this.next;
    this.next = old;
    for (let i = 0; i < this.current.length; i++) {
      const absolute = Math.abs(this.current[i]);
      if (absolute > this.maxAbs[i]) this.maxAbs[i] = absolute;
    }
    this.timeSeconds += dt;
    return dt;
  }

  sampleMaximum(lon, lat) {
    const cell = this.nearestOceanCell(lon, lat);
    if (!cell) return { maxM: 0, depthM: 0, cell: null };
    return { maxM: this.maxAbs[cell.index], depthM: this.depths[cell.index], cell };
  }
}
