export const GRID_WIDTH = 180;
export const GRID_HEIGHT = 80;
export const LAT_MIN = -80;
export const LAT_MAX = 80;
export const LAND = 65535;
export const G = 9.80665;
export const DEFAULT_DT_SECONDS = 60;

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function wrapLongitude(lon) {
  return ((lon + 540) % 360) - 180;
}

export function magnitudeToMoment(magnitude) {
  return 10 ** (1.5 * magnitude + 9.1);
}

export function deriveEarthquake({ magnitude, focalDepthKm, dipDeg, mechanism = 'subduction' }) {
  const areaKm2 = 10 ** (-3.49 + 0.91 * magnitude);
  const aspectRatio = mechanism === 'strike-slip' ? 4 : 2.5;
  const lengthKm = Math.sqrt(areaKm2 * aspectRatio);
  const widthKm = areaKm2 / lengthKm;
  const momentNm = magnitudeToMoment(magnitude);
  const slipM = momentNm / (3e10 * areaKm2 * 1e6);
  const coupling = mechanism === 'strike-slip' ? 0.08 : mechanism === 'normal' ? 0.58 : 0.82;
  const verticalDisplacementM = clamp(
    slipM * Math.sin(dipDeg * Math.PI / 180) * coupling * Math.exp(-focalDepthKm / 55),
    0,
    14,
  );
  return { areaKm2, lengthKm, widthKm, momentNm, slipM, verticalDisplacementM };
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

export class TsunamiSimulation {
  constructor(depths, width = GRID_WIDTH, height = GRID_HEIGHT) {
    if (depths.length !== width * height) throw new Error('Depth grid dimensions do not match');
    this.width = width;
    this.height = height;
    this.depths = depths;
    this.current = new Float64Array(width * height);
    this.previous = new Float64Array(width * height);
    this.next = new Float64Array(width * height);
    this.maxAbs = new Float64Array(width * height);
    this.timeSeconds = 0;
    this.event = null;
    this.source = null;
    this.sourceAmplitudeM = 0;
  }

  clear() {
    this.current.fill(0);
    this.previous.fill(0);
    this.next.fill(0);
    this.maxAbs.fill(0);
    this.timeSeconds = 0;
    this.event = null;
    this.sourceAmplitudeM = 0;
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

  nearestOceanCell(lon, lat, maxRadius = 8) {
    const origin = this.cellFor(lon, lat);
    if (this.depths[origin.index] !== LAND) return origin;
    for (let radius = 1; radius <= maxRadius; radius++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
          const row = origin.row + dy;
          const col = (origin.col + dx + this.width) % this.width;
          if (row < 0 || row >= this.height) continue;
          const index = row * this.width + col;
          if (this.depths[index] !== LAND) return { row, col, index };
        }
      }
    }
    return null;
  }

  trigger(event) {
    const sourceCell = this.cellFor(event.longitude, event.latitude);
    if (this.depths[sourceCell.index] === LAND) throw new Error('The epicenter must be in ocean water');
    this.clear();
    this.event = { ...event };
    this.source = sourceCell;
    const derived = deriveEarthquake(event);
    this.event.derived = derived;

    const lat0 = event.latitude * Math.PI / 180;
    const strike = event.strikeDeg * Math.PI / 180;
    const sigmaAlong = Math.max(70, derived.lengthKm * 0.42);
    const sigmaAcross = Math.max(45, derived.widthKm * 0.52);
    let peak = 0;

    for (let row = 0; row < this.height; row++) {
      const lat = this.latForRow(row);
      const northKm = (lat - event.latitude) * 111.195;
      for (let col = 0; col < this.width; col++) {
        const index = row * this.width + col;
        if (this.depths[index] === LAND) continue;
        const eastKm = wrapLongitude(this.lonForColumn(col) - event.longitude) * 111.195 * Math.cos(lat0);
        const along = eastKm * Math.sin(strike) + northKm * Math.cos(strike);
        const across = eastKm * Math.cos(strike) - northKm * Math.sin(strike);
        if (Math.abs(along) > sigmaAlong * 3.5 || Math.abs(across) > sigmaAcross * 3.5) continue;
        const envelope = Math.exp(-0.5 * ((along / sigmaAlong) ** 2 + (across / sigmaAcross) ** 2));
        const polarity = Math.tanh(across / Math.max(20, sigmaAcross * 0.38));
        const displacement = derived.verticalDisplacementM * 1.55 * envelope * polarity;
        this.current[index] = displacement;
        this.previous[index] = displacement;
        this.maxAbs[index] = Math.abs(displacement);
        peak = Math.max(peak, Math.abs(displacement));
      }
    }
    this.sourceAmplitudeM = peak;
    return derived;
  }

  step(dtSeconds = DEFAULT_DT_SECONDS) {
    if (!this.event) return;
    const w = this.width;
    const h = this.height;
    const lonStepM = 360 / w * 111195;
    const latStepM = (LAT_MAX - LAT_MIN) / h * 111195;
    const dt2g = dtSeconds * dtSeconds * G;

    for (let row = 0; row < h; row++) {
      const lat = this.latForRow(row) * Math.PI / 180;
      const dx = Math.max(30000, lonStepM * Math.cos(lat));
      const dx2 = dx * dx;
      const dy2 = latStepM * latStepM;
      const polarDamping = row < 3 || row > h - 4 ? 0.992 : 0.9994;
      for (let col = 0; col < w; col++) {
        const i = row * w + col;
        const rawDepth = this.depths[i];
        if (rawDepth === LAND) {
          this.next[i] = 0;
          continue;
        }
        const center = this.current[i];
        const hc = Math.min(rawDepth, 7000);
        const leftI = row * w + (col + w - 1) % w;
        const rightI = row * w + (col + 1) % w;
        const upI = row > 0 ? i - w : i;
        const downI = row < h - 1 ? i + w : i;

        const hl = this.depths[leftI] === LAND ? hc : Math.min(this.depths[leftI], 7000);
        const hr = this.depths[rightI] === LAND ? hc : Math.min(this.depths[rightI], 7000);
        const hu = this.depths[upI] === LAND ? hc : Math.min(this.depths[upI], 7000);
        const hd = this.depths[downI] === LAND ? hc : Math.min(this.depths[downI], 7000);
        const left = this.depths[leftI] === LAND ? center : this.current[leftI];
        const right = this.depths[rightI] === LAND ? center : this.current[rightI];
        const up = this.depths[upI] === LAND ? center : this.current[upI];
        const down = this.depths[downI] === LAND ? center : this.current[downI];

        const fluxX = (0.5 * (hc + hr) * (right - center) - 0.5 * (hl + hc) * (center - left)) / dx2;
        const fluxY = (0.5 * (hc + hd) * (down - center) - 0.5 * (hu + hc) * (center - up)) / dy2;
        const value = (2 * center - this.previous[i] + dt2g * (fluxX + fluxY)) * polarDamping;
        this.next[i] = Number.isFinite(value) ? value : 0;
      }
    }

    const oldPrevious = this.previous;
    this.previous = this.current;
    this.current = this.next;
    this.next = oldPrevious;
    for (let i = 0; i < this.current.length; i++) {
      const absolute = Math.abs(this.current[i]);
      if (absolute > this.maxAbs[i]) this.maxAbs[i] = absolute;
    }
    this.timeSeconds += dtSeconds;
  }

  sampleMaximum(lon, lat) {
    const cell = this.nearestOceanCell(lon, lat);
    if (!cell) return { maxM: 0, depthM: 0, cell: null };
    return { maxM: this.maxAbs[cell.index], depthM: this.depths[cell.index], cell };
  }
}
