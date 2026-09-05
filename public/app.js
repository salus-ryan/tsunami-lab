import {
  GRID_WIDTH, GRID_HEIGHT, LAT_MIN, LAT_MAX, LAND,
  TsunamiSimulation, decodeBathymetry, deriveEarthquake, formatSimTime, wrapLongitude,
} from './simulation.js';

const $ = (selector) => document.querySelector(selector);
const canvas = $('#mapCanvas');
const ctx = canvas.getContext('2d');
const waveCanvas = document.createElement('canvas');
waveCanvas.width = GRID_WIDTH;
waveCanvas.height = GRID_HEIGHT;
const waveCtx = waveCanvas.getContext('2d');
let waveImage = waveCtx.createImageData(GRID_WIDTH, GRID_HEIGHT);

const controls = {
  magnitude: $('#magnitude'), depth: $('#depth'), strike: $('#strike'), dip: $('#dip'),
  mechanism: $('#mechanism'), preset: $('#presetSelect'), speed: $('#speedSelect'),
};
const outputs = {
  magnitude: $('#magnitudeOutput'), depth: $('#depthOutput'), strike: $('#strikeOutput'), dip: $('#dipOutput'),
};

const PRESETS = {
  tohoku: { latitude: 38.3, longitude: 143.1, magnitude: 9.1, focalDepthKm: 29, strikeDeg: 193, dipDeg: 14, mechanism: 'subduction' },
  chile: { latitude: -39.5, longitude: -74.5, magnitude: 9.5, focalDepthKm: 33, strikeDeg: 8, dipDeg: 18, mechanism: 'subduction' },
  sumatra: { latitude: 3.3, longitude: 95.9, magnitude: 9.2, focalDepthKm: 25, strikeDeg: 330, dipDeg: 12, mechanism: 'subduction' },
  aleutian: { latitude: 51.1, longitude: -173.2, magnitude: 8.8, focalDepthKm: 24, strikeDeg: 255, dipDeg: 16, mechanism: 'subduction' },
};

const WATCH_POINTS = [
  { name: 'Honolulu', lat: 21.30, lon: -157.92 },
  { name: 'Sendai', lat: 39.00, lon: 143.00 },
  { name: 'Valparaíso', lat: -33.05, lon: -72.10 },
  { name: 'Lima', lat: -12.08, lon: -77.25 },
  { name: 'San Francisco', lat: 37.72, lon: -122.72 },
  { name: 'Anchorage', lat: 59.85, lon: -149.70 },
  { name: 'Wellington', lat: -41.00, lon: 177.00 },
  { name: 'Jakarta', lat: -7.00, lon: 109.00 },
  { name: 'Lisbon', lat: 39.00, lon: -11.00 },
  { name: 'Cape Town', lat: -35.00, lon: 19.00 },
];

let simulation;
let landGeoJson;
let selected = null;
let running = false;
let ready = false;
let lastTick = 0;
let lastWatchUpdate = 0;
let toastTimer;
let deferredInstallPrompt;
let watchState = [];

function currentEvent() {
  return {
    latitude: selected?.latitude ?? 0,
    longitude: selected?.longitude ?? 0,
    magnitude: Number(controls.magnitude.value),
    focalDepthKm: Number(controls.depth.value),
    strikeDeg: Number(controls.strike.value),
    dipDeg: Number(controls.dip.value),
    mechanism: controls.mechanism.value,
  };
}

function syncOutputs() {
  outputs.magnitude.value = Number(controls.magnitude.value).toFixed(1);
  outputs.depth.value = `${controls.depth.value} km`;
  outputs.strike.value = `${controls.strike.value}°`;
  outputs.dip.value = `${controls.dip.value}°`;
  const derived = deriveEarthquake(currentEvent());
  const metrics = $('#sourceMetrics').children;
  metrics[0].querySelector('strong').textContent = `${Math.round(derived.lengthKm)} × ${Math.round(derived.widthKm)} km`;
  metrics[1].querySelector('strong').textContent = `${derived.slipM.toFixed(1)} m`;
  metrics[2].querySelector('strong').textContent = selected ? `≈ ${derived.verticalDisplacementM.toFixed(2)} m` : 'select ocean';
}

function setStatus(text, mode = 'ready') {
  $('#statusText').textContent = text;
  $('#statusLight').className = mode;
}

function showToast(message) {
  clearTimeout(toastTimer);
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function resetWatchState() {
  watchState = WATCH_POINTS.map(point => ({ ...point, maxCoastalM: 0, arrivalSeconds: null }));
  renderWatchList(false);
}

function hazardClass(meters) {
  if (meters >= 3) return 'severe';
  if (meters >= 1) return 'warning';
  if (meters >= 0.3) return 'advisory';
  return 'low';
}

function renderWatchList(active = true) {
  const list = $('#watchList');
  if (!active) {
    list.innerHTML = '<div class="empty-state">Run a scenario to populate coastal estimates.</div>';
    return;
  }
  list.innerHTML = watchState.map(point => {
    const level = hazardClass(point.maxCoastalM);
    const arrival = point.arrivalSeconds == null ? 'No arrival yet' : `First signal ${formatSimTime(point.arrivalSeconds)}`;
    const value = point.maxCoastalM < 0.01 ? '&lt;0.01 m' : `${point.maxCoastalM.toFixed(point.maxCoastalM < 1 ? 2 : 1)} m`;
    const width = Math.min(100, Math.max(1, point.maxCoastalM / 5 * 100));
    return `<div class="watch-item ${level}"><div><div class="place">${point.name}</div><div class="arrival">${arrival}</div></div><div class="height">${value}</div><div class="bar"><i style="width:${width}%"></i></div></div>`;
  }).join('');
}

function updateWatchPoints() {
  if (!simulation.event) return;
  for (const point of watchState) {
    const sample = simulation.sampleMaximum(point.lon, point.lat);
    if (!sample.cell) continue;
    // Green's-law-inspired shoaling proxy to a nominal 20 m nearshore depth.
    const shoaling = Math.min(4.2, Math.max(1.15, (Math.max(20, sample.depthM) / 20) ** 0.25));
    point.maxCoastalM = Math.max(point.maxCoastalM, sample.maxM * shoaling);
    if (point.arrivalSeconds == null && point.maxCoastalM >= 0.05) point.arrivalSeconds = simulation.timeSeconds;
  }
  renderWatchList(true);
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  renderMap();
}

function colorMix(a, b, amount) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * amount),
    Math.round(a[1] + (b[1] - a[1]) * amount),
    Math.round(a[2] + (b[2] - a[2]) * amount),
  ];
}

function updateWaveTexture() {
  if (!simulation) return;
  const pixels = waveImage.data;
  const visualScale = Math.max(0.025, simulation.sourceAmplitudeM * 0.12);
  for (let i = 0; i < simulation.depths.length; i++) {
    const offset = i * 4;
    const depth = simulation.depths[i];
    if (depth === LAND) {
      pixels[offset] = 31; pixels[offset + 1] = 50; pixels[offset + 2] = 52; pixels[offset + 3] = 255;
      continue;
    }
    const depthRatio = Math.min(1, depth / 6500);
    const base = colorMix([13, 73, 101], [3, 26, 48], depthRatio);
    const elevation = simulation.current[i];
    const strength = Math.min(1, Math.sqrt(Math.abs(elevation) / visualScale));
    const target = elevation >= 0 ? (strength > .76 ? [225, 255, 255] : [44, 228, 225]) : [170, 76, 231];
    const color = colorMix(base, target, strength * .92);
    pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2]; pixels[offset + 3] = 255;
  }
  waveCtx.putImageData(waveImage, 0, 0);
}

function project(lon, lat, width, height) {
  return { x: (lon + 180) / 360 * width, y: (LAT_MAX - lat) / (LAT_MAX - LAT_MIN) * height };
}

function traceRing(context, ring, width, height) {
  let started = false;
  let previousX = null;
  for (const coordinate of ring) {
    const lon = coordinate[0];
    const lat = Math.max(LAT_MIN, Math.min(LAT_MAX, coordinate[1]));
    const { x, y } = project(lon, lat, width, height);
    if (!started || (previousX != null && Math.abs(x - previousX) > width * .5)) {
      context.moveTo(x, y);
      started = true;
    } else context.lineTo(x, y);
    previousX = x;
  }
  context.closePath();
}

function drawLand(context, width, height) {
  if (!landGeoJson) return;
  context.beginPath();
  for (const feature of landGeoJson.features) {
    const geometry = feature.geometry;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    for (const polygon of polygons) for (const ring of polygon) traceRing(context, ring, width, height);
  }
  context.fillStyle = '#193b3d';
  context.fill('evenodd');
  context.strokeStyle = 'rgba(122, 185, 177, .48)';
  context.lineWidth = .65;
  context.stroke();
}

function renderMap() {
  if (!simulation || !canvas.width) return;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  ctx.clearRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(waveCanvas, 0, 0, width, height);

  ctx.save();
  ctx.strokeStyle = 'rgba(142, 197, 213, .10)';
  ctx.lineWidth = .5;
  for (let lon = -120; lon <= 120; lon += 60) {
    const x = project(lon, 0, width, height).x;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = project(0, lat, width, height).y;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }
  drawLand(ctx, width, height);
  ctx.restore();

  if (selected) {
    const p = project(selected.longitude, selected.latitude, width, height);
    const pulse = running ? 5 + Math.sin(performance.now() / 180) * 2 : 6;
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = '#ff756b';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(p.x, p.y, pulse, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(p.x, p.y, pulse + 5, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,117,107,.5)'; ctx.stroke();
    ctx.restore();
  }
}

function selectEpicenter(longitude, latitude, fromPreset = false) {
  if (!ready) return;
  longitude = wrapLongitude(longitude);
  if (!simulation.isOcean(longitude, latitude)) {
    showToast('Choose ocean water—the selected cell is on land.');
    return;
  }
  running = false;
  simulation.clear();
  selected = { longitude, latitude };
  if (!fromPreset) controls.preset.value = 'custom';
  $('#coordinateLabel').textContent = `${Math.abs(latitude).toFixed(1)}°${latitude >= 0 ? 'N' : 'S'}, ${Math.abs(longitude).toFixed(1)}°${longitude >= 0 ? 'E' : 'W'}`;
  $('#mapHint').classList.add('dismissed');
  $('#startButton').disabled = false;
  $('#pauseButton').disabled = true;
  $('#pauseButton').textContent = 'Pause';
  $('#simTime').textContent = '00:00';
  setStatus('Epicenter ready');
  resetWatchState();
  syncOutputs();
  updateWaveTexture();
  renderMap();
}

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  controls.magnitude.value = preset.magnitude;
  controls.depth.value = preset.focalDepthKm;
  controls.strike.value = preset.strikeDeg;
  controls.dip.value = preset.dipDeg;
  controls.mechanism.value = preset.mechanism;
  selectEpicenter(preset.longitude, preset.latitude, true);
  syncOutputs();
}

function triggerQuake() {
  if (!selected || !ready) return;
  try {
    const derived = simulation.trigger(currentEvent());
    resetWatchState();
    running = true;
    lastTick = performance.now();
    lastWatchUpdate = 0;
    $('#pauseButton').disabled = false;
    $('#pauseButton').textContent = 'Pause';
    $('#startButton span').textContent = 'Restart quake';
    setStatus(`M${Number(controls.magnitude.value).toFixed(1)} wave propagating`, 'running');
    const metrics = $('#sourceMetrics').children;
    metrics[0].querySelector('strong').textContent = `${Math.round(derived.lengthKm)} × ${Math.round(derived.widthKm)} km`;
    metrics[1].querySelector('strong').textContent = `${derived.slipM.toFixed(1)} m`;
    metrics[2].querySelector('strong').textContent = `${simulation.sourceAmplitudeM.toFixed(2)} m`;
    updateWaveTexture();
    renderMap();
  } catch (error) {
    showToast(error.message);
  }
}

function resetSimulation() {
  running = false;
  simulation?.clear();
  $('#simTime').textContent = '00:00';
  $('#pauseButton').disabled = true;
  $('#pauseButton').textContent = 'Pause';
  $('#startButton span').textContent = 'Trigger quake';
  setStatus(selected ? 'Epicenter ready' : 'Ready—select an ocean');
  resetWatchState();
  syncOutputs();
  updateWaveTexture();
  renderMap();
}

function animationLoop(now) {
  if (running && now - lastTick >= 80) {
    const steps = Number(controls.speed.value);
    for (let i = 0; i < steps; i++) simulation.step();
    lastTick = now;
    $('#simTime').textContent = formatSimTime(simulation.timeSeconds);
    if (simulation.timeSeconds - lastWatchUpdate >= 600) {
      updateWatchPoints();
      lastWatchUpdate = simulation.timeSeconds;
    }
    if (simulation.timeSeconds >= 172800) {
      running = false;
      setStatus('48-hour simulation complete');
      $('#pauseButton').textContent = 'Resume';
    }
    updateWaveTexture();
    renderMap();
  } else if (running) renderMap();
  requestAnimationFrame(animationLoop);
}

canvas.addEventListener('pointerup', event => {
  const rect = canvas.getBoundingClientRect();
  const longitude = (event.clientX - rect.left) / rect.width * 360 - 180;
  const latitude = LAT_MAX - (event.clientY - rect.top) / rect.height * (LAT_MAX - LAT_MIN);
  selectEpicenter(longitude, latitude);
});

for (const [name, control] of Object.entries(controls)) {
  if (name === 'preset' || name === 'speed') continue;
  control.addEventListener('input', syncOutputs);
}
controls.preset.addEventListener('change', () => applyPreset(controls.preset.value));
$('#startButton').addEventListener('click', triggerQuake);
$('#resetButton').addEventListener('click', resetSimulation);
$('#pauseButton').addEventListener('click', () => {
  if (!simulation.event) return;
  running = !running;
  lastTick = performance.now();
  $('#pauseButton').textContent = running ? 'Pause' : 'Resume';
  setStatus(running ? 'Wave propagating' : 'Simulation paused', running ? 'running' : 'ready');
});
$('#aboutButton').addEventListener('click', () => $('#aboutDialog').showModal());
window.addEventListener('resize', resizeCanvas);
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  $('#installButton').classList.remove('hidden');
});
$('#installButton').addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  $('#installButton').classList.add('hidden');
});

async function initialize() {
  try {
    const [bathymetryResponse, landResponse] = await Promise.all([
      fetch('./data/bathymetry.bin'), fetch('./data/land.geojson'),
    ]);
    if (!bathymetryResponse.ok || !landResponse.ok) throw new Error('Earth data could not be loaded');
    const [bathymetryBuffer, land] = await Promise.all([bathymetryResponse.arrayBuffer(), landResponse.json()]);
    simulation = new TsunamiSimulation(decodeBathymetry(bathymetryBuffer));
    landGeoJson = land;
    ready = true;
    setStatus('Ready—select an ocean');
    $('#statusLight').className = 'ready';
    updateWaveTexture();
    resizeCanvas();
    syncOutputs();
    requestAnimationFrame(animationLoop);
  } catch (error) {
    console.error(error);
    setStatus('Failed to load Earth data');
    showToast('Could not load simulation data. Reload the app.');
  }
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(console.warn));
}
initialize();
