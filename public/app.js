import {
  GRID_WIDTH, GRID_HEIGHT, LAT_MIN, LAT_MAX, LAND,
  TsunamiSimulation, decodeBathymetry, deriveEarthquake, defaultRakeForMechanism,
  formatSimTime, wrapLongitude,
} from './simulation.js';
import { decodeScenarioHash, encodeScenarioHash, normalizeScenario } from './scenario.js';

const $ = selector => document.querySelector(selector);
const APP_VERSION = '1.1.0';
const SCENARIO_STORAGE_KEY = 'tsunami-lab-scenarios-v1';
const canvas = $('#mapCanvas');
const ctx = canvas.getContext('2d');
const waveCanvas = document.createElement('canvas');
waveCanvas.width = GRID_WIDTH;
waveCanvas.height = GRID_HEIGHT;
const waveCtx = waveCanvas.getContext('2d');
const waveImage = waveCtx.createImageData(GRID_WIDTH, GRID_HEIGHT);

const controls = {
  magnitude: $('#magnitude'), depth: $('#depth'), strike: $('#strike'), dip: $('#dip'), rake: $('#rake'), tide: $('#tide'),
  mechanism: $('#mechanism'), ensemble: $('#ensemble'), preset: $('#presetSelect'), speed: $('#speedSelect'),
};
const outputs = {
  magnitude: $('#magnitudeOutput'), depth: $('#depthOutput'), strike: $('#strikeOutput'),
  dip: $('#dipOutput'), rake: $('#rakeOutput'), tide: $('#tideOutput'),
};

const PRESETS = {
  tohoku: { latitude: 38.3, longitude: 143.1, magnitude: 9.1, focalDepthKm: 29, strikeDeg: 193, dipDeg: 14, rakeDeg: 90, mechanism: 'subduction' },
  chile: { latitude: -39.5, longitude: -74.5, magnitude: 9.5, focalDepthKm: 33, strikeDeg: 8, dipDeg: 18, rakeDeg: 90, mechanism: 'subduction' },
  sumatra: { latitude: 3.3, longitude: 95.9, magnitude: 9.2, focalDepthKm: 25, strikeDeg: 330, dipDeg: 12, rakeDeg: 90, mechanism: 'subduction' },
  aleutian: { latitude: 51.1, longitude: -173.2, magnitude: 8.8, focalDepthKm: 24, strikeDeg: 255, dipDeg: 16, rakeDeg: 90, mechanism: 'subduction' },
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
let simulationWorker;
let workerReadyResolve;
let landGeoJson;
let selected = null;
let running = false;
let ready = false;
let workerBusy = false;
let runId = 0;
let lastTick = 0;
let lastWatchUpdate = 0;
let toastTimer;
let deferredInstallPrompt;
let watchState = [];
let deploymentConfig = {
  deploymentId: 'default', productName: 'Tsunami Lab', organizationName: null,
  supportUrl: 'https://github.com/salus-ryan/tsunami-lab/issues', privacyUrl: './privacy.html',
  telemetryEnabled: false, dataResidency: 'client-only',
};
let modelMetadata;

function currentEvent() {
  return {
    latitude: selected?.latitude ?? 0,
    longitude: selected?.longitude ?? 0,
    magnitude: Number(controls.magnitude.value),
    focalDepthKm: Number(controls.depth.value),
    strikeDeg: Number(controls.strike.value),
    dipDeg: Number(controls.dip.value),
    rakeDeg: Number(controls.rake.value),
    mechanism: controls.mechanism.value,
  };
}

function safeLink(value, fallback) {
  try {
    const url = new URL(value, location.href);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : fallback;
  } catch {
    return fallback;
  }
}

function applyDeploymentConfig(input) {
  if (!input || input.schemaVersion !== 1 || input.telemetryEnabled !== false) {
    throw new Error('Deployment configuration is invalid');
  }
  deploymentConfig = {
    deploymentId: String(input.deploymentId || 'default').slice(0, 80),
    productName: String(input.productName || 'Tsunami Lab').slice(0, 80),
    organizationName: input.organizationName ? String(input.organizationName).slice(0, 80) : null,
    supportUrl: safeLink(input.supportUrl, deploymentConfig.supportUrl),
    privacyUrl: safeLink(input.privacyUrl, new URL('./privacy.html', location.href).href),
    telemetryEnabled: false,
    dataResidency: input.dataResidency === 'client-only' ? 'client-only' : 'client-only',
  };
  $('[data-product-name]').textContent = deploymentConfig.productName;
  $('[data-product-version]').textContent = `${deploymentConfig.productName} v${APP_VERSION.slice(0, 3)}`;
  document.title = deploymentConfig.productName;
  $('#supportLink').href = deploymentConfig.supportUrl;
  $('#privacyLink').href = deploymentConfig.privacyUrl;
  const organization = $('#organizationName');
  if (deploymentConfig.organizationName) {
    organization.textContent = `Managed by ${deploymentConfig.organizationName}`;
    organization.classList.remove('hidden');
  }
  document.body.dataset.deploymentId = deploymentConfig.deploymentId;
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function verifyDataset(metadata, path, buffer) {
  const record = metadata.datasets?.find(dataset => dataset.path === path);
  if (!record || record.bytes !== buffer.byteLength || await sha256Hex(buffer) !== record.sha256) {
    throw new Error(`Integrity verification failed for ${path}`);
  }
}

function currentScenario() {
  if (!selected) return null;
  return normalizeScenario({
    event: currentEvent(),
    tideLevelM: Number(controls.tide.value),
    ensembleMembers: Number(controls.ensemble.value),
    speed: Number(controls.speed.value),
  });
}

function scenarioName(scenario) {
  const { event } = scenario;
  const latitude = `${Math.abs(event.latitude).toFixed(1)}°${event.latitude >= 0 ? 'N' : 'S'}`;
  const longitude = `${Math.abs(event.longitude).toFixed(1)}°${event.longitude >= 0 ? 'E' : 'W'}`;
  return `M${event.magnitude.toFixed(1)} · ${latitude}, ${longitude}`;
}

function loadSavedScenarios() {
  try {
    const saved = JSON.parse(localStorage.getItem(SCENARIO_STORAGE_KEY) || '[]');
    if (!Array.isArray(saved)) return [];
    return saved.flatMap(item => {
      try {
        return [{ ...normalizeScenario(item), id: String(item.id), name: String(item.name), savedAt: String(item.savedAt) }];
      } catch {
        return [];
      }
    }).slice(0, 25);
  } catch {
    return [];
  }
}

function storeSavedScenarios(scenarios) {
  localStorage.setItem(SCENARIO_STORAGE_KEY, JSON.stringify(scenarios));
}

function saveCurrentScenario() {
  const scenario = currentScenario();
  if (!scenario) return;
  const saved = loadSavedScenarios();
  saved.unshift({
    ...scenario,
    id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    name: scenarioName(scenario),
    savedAt: new Date().toISOString(),
  });
  try {
    storeSavedScenarios(saved.slice(0, 25));
    renderScenarioLibrary();
    showToast('Scenario saved on this device.');
  } catch {
    showToast('This browser could not save the scenario.');
  }
}

function applyScenario(scenario) {
  const normalized = normalizeScenario(scenario);
  const { event } = normalized;
  controls.magnitude.value = event.magnitude;
  controls.depth.value = event.focalDepthKm;
  controls.strike.value = event.strikeDeg;
  controls.dip.value = event.dipDeg;
  controls.rake.value = event.rakeDeg;
  controls.mechanism.value = event.mechanism;
  controls.tide.value = normalized.tideLevelM;
  controls.ensemble.value = normalized.ensembleMembers;
  controls.speed.value = normalized.speed;
  controls.preset.value = 'custom';
  selectEpicenter(event.longitude, event.latitude);
  syncOutputs();
}

function renderScenarioLibrary() {
  const list = $('#scenarioList');
  const saved = loadSavedScenarios();
  list.replaceChildren();
  if (!saved.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No saved scenarios yet.';
    list.append(empty);
    return;
  }
  for (const scenario of saved) {
    const item = document.createElement('article');
    item.className = 'saved-scenario';
    const summary = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = scenario.name;
    const details = document.createElement('span');
    details.textContent = `${scenario.ensembleMembers} member${scenario.ensembleMembers === 1 ? '' : 's'} · tide ${scenario.tideLevelM >= 0 ? '+' : ''}${scenario.tideLevelM.toFixed(1)} m`;
    summary.append(title, details);
    const actions = document.createElement('div');
    const load = document.createElement('button');
    load.type = 'button'; load.className = 'secondary'; load.textContent = 'Load';
    load.addEventListener('click', () => {
      applyScenario(scenario);
      $('#scenarioDialog').close();
      showToast('Saved scenario loaded.');
    });
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'text-button'; remove.textContent = 'Delete';
    remove.setAttribute('aria-label', `Delete ${scenario.name}`);
    remove.addEventListener('click', () => {
      storeSavedScenarios(saved.filter(item => item.id !== scenario.id));
      renderScenarioLibrary();
    });
    actions.append(load, remove);
    item.append(summary, actions);
    list.append(item);
  }
}

async function shareCurrentScenario() {
  const scenario = currentScenario();
  if (!scenario) return;
  history.replaceState(null, '', `${location.pathname}${location.search}${encodeScenarioHash(scenario)}`);
  const shareData = { title: 'Tsunami Lab scenario', text: scenarioName(scenario), url: location.href };
  if (navigator.share) {
    try {
      await navigator.share(shareData);
      showToast('Scenario shared.');
      return;
    } catch (error) {
      if (error.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(location.href);
    showToast('Share link copied.');
  } catch {
    showToast('Share link is ready in the address bar.');
  }
}

function exportResults() {
  const scenario = currentScenario();
  if (!scenario || !simulation?.event) return;
  const report = {
    $schema: new URL('./schemas/report.schema.json', location.href).href,
    reportFormatVersion: 1,
    product: deploymentConfig.productName,
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    disclaimer: 'Educational model—not an operational forecast.',
    deployment: deploymentConfig,
    model: modelMetadata,
    scenario,
    simulationTimeSeconds: simulation.timeSeconds,
    coastalWatch: watchState.map(({ name, lat, lon, maxCoastalM, lowCoastalM, highCoastalM, arrivalSeconds }) => ({
      name, latitude: lat, longitude: lon, centralWaveM: maxCoastalM,
      ensembleMinimumM: lowCoastalM ?? maxCoastalM,
      ensembleMaximumM: highCoastalM ?? maxCoastalM,
      firstSignalSeconds: arrivalSeconds,
    })),
  };
  const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `tsunami-lab-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  showToast('Results exported as JSON.');
}

function updateSourceMetrics(derived, initialWave = null) {
  const metrics = $('#sourceMetrics').children;
  metrics[0].querySelector('strong').textContent = `${Math.round(derived.lengthKm)} × ${Math.round(derived.widthKm)} km`;
  metrics[1].querySelector('strong').textContent = `${derived.slipM.toFixed(1)} m`;
  metrics[2].querySelector('strong').textContent = selected
    ? `${initialWave == null ? '≈ ' : ''}${(initialWave ?? derived.verticalDisplacementM).toFixed(2)} m`
    : 'select ocean';
  metrics[3].querySelector('strong').textContent = `${derived.patchCount} (${derived.alongPatches}×${derived.acrossPatches})`;
}

function syncOutputs() {
  outputs.magnitude.value = Number(controls.magnitude.value).toFixed(1);
  outputs.depth.value = `${controls.depth.value} km`;
  outputs.strike.value = `${controls.strike.value}°`;
  outputs.dip.value = `${controls.dip.value}°`;
  outputs.rake.value = `${controls.rake.value}°`;
  const tide = Number(controls.tide.value);
  outputs.tide.value = `${tide >= 0 ? '+' : ''}${tide.toFixed(1)} m`;
  $('#tideBadge').textContent = `Tide ${tide >= 0 ? '+' : ''}${tide.toFixed(1)} m`;
  updateSourceMetrics(deriveEarthquake(currentEvent()));
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
    const range = point.ensembleCount > 1
      ? `<div class="ensemble-range">range ${point.lowCoastalM.toFixed(2)}–${point.highCoastalM.toFixed(2)} m</div>`
      : '';
    const scaleValue = Math.min(5, Math.max(0.01, point.maxCoastalM));
    return `<div class="watch-item ${level}"><div><div class="place">${point.name}</div><div class="arrival">${arrival}</div>${range}</div><div class="height">${value}</div><progress class="bar" max="5" value="${scaleValue}" aria-label="${point.name} wave scale"></progress></div>`;
  }).join('');
}

function updateWatchPoints(samples, timeSeconds) {
  for (let index = 0; index < watchState.length; index++) {
    const point = watchState[index];
    const members = samples[index] || [];
    const coastalValues = members.filter(sample => sample?.cell).map(sample => {
      const shoaling = Math.min(4.2, Math.max(1.15, (Math.max(20, sample.depthM) / 20) ** 0.25));
      return sample.maxM * shoaling;
    });
    if (!coastalValues.length) continue;
    point.ensembleCount = coastalValues.length;
    point.maxCoastalM = Math.max(point.maxCoastalM, coastalValues[0]);
    point.lowCoastalM = Math.min(...coastalValues);
    point.highCoastalM = Math.max(...coastalValues);
    if (point.arrivalSeconds == null && point.maxCoastalM >= 0.05) point.arrivalSeconds = timeSeconds;
  }
  renderWatchList(true);
}

function handleWorkerMessage(event) {
  const message = event.data;
  if (message.type === 'ready') {
    workerBusy = false;
    document.body.dataset.simulationBackend = 'worker';
    document.body.dataset.stableDt = message.stableDtSeconds.toFixed(2);
    workerReadyResolve?.();
    return;
  }
  if (message.type === 'error') {
    if (message.runId !== runId) return;
    workerBusy = false;
    running = false;
    setStatus('Simulation worker error');
    showToast(message.message);
    console.error(message.stack || message.message);
    return;
  }
  if (message.runId !== runId) return;
  if (message.type === 'triggered') {
    simulation.sourceAmplitudeM = message.sourceAmplitudeM;
    document.body.dataset.ensembleCount = String(message.ensembleCount);
    updateSourceMetrics(message.derived, message.sourceAmplitudeM);
    return;
  }
  if (message.type === 'frame') {
    workerBusy = false;
    simulation.current = new Float32Array(message.fieldBuffer);
    simulation.timeSeconds = message.timeSeconds;
    simulation.sourceAmplitudeM = message.sourceAmplitudeM;
    $('#simTime').textContent = formatSimTime(message.timeSeconds);
    if (message.timeSeconds - lastWatchUpdate >= 600) {
      updateWatchPoints(message.samples, message.timeSeconds);
      lastWatchUpdate = message.timeSeconds;
    }
    if (message.timeSeconds >= 172800) {
      running = false;
      setStatus('48-hour simulation complete');
      $('#pauseButton').textContent = 'Resume';
    }
    updateWaveTexture();
    renderMap();
  }
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

function resetWorkerState() {
  runId++;
  workerBusy = false;
  simulationWorker?.postMessage({ type: 'reset', runId });
}

function selectEpicenter(longitude, latitude, fromPreset = false) {
  if (!ready) return false;
  longitude = wrapLongitude(longitude);
  const selectedCell = simulation.cellFor(longitude, latitude);
  const selectedDepth = simulation.depths[selectedCell.index];
  canvas.dataset.selectedCell = `${selectedCell.col},${selectedCell.row},${selectedCell.index}`;
  canvas.dataset.selectedDepth = selectedDepth === LAND ? 'land' : String(selectedDepth);
  if (selectedDepth === LAND) {
    showToast('Choose ocean water—the selected cell is on land.');
    return false;
  }
  running = false;
  resetWorkerState();
  simulation.clear();
  selected = { longitude, latitude };
  if (!fromPreset) controls.preset.value = 'custom';
  $('#coordinateLabel').textContent = `${Math.abs(latitude).toFixed(1)}°${latitude >= 0 ? 'N' : 'S'}, ${Math.abs(longitude).toFixed(1)}°${longitude >= 0 ? 'E' : 'W'}`;
  $('#mapHint').classList.add('dismissed');
  $('#startButton').disabled = false;
  $('#startButton span').textContent = 'Trigger quake';
  $('#pauseButton').disabled = true;
  $('#pauseButton').textContent = 'Pause';
  $('#saveButton').disabled = false;
  $('#shareButton').disabled = false;
  $('#exportButton').disabled = true;
  $('#simTime').textContent = '00:00';
  setStatus('Epicenter ready');
  resetWatchState();
  syncOutputs();
  updateWaveTexture();
  renderMap();
  return true;
}

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  controls.magnitude.value = preset.magnitude;
  controls.depth.value = preset.focalDepthKm;
  controls.strike.value = preset.strikeDeg;
  controls.dip.value = preset.dipDeg;
  controls.rake.value = preset.rakeDeg;
  controls.mechanism.value = preset.mechanism;
  selectEpicenter(preset.longitude, preset.latitude, true);
  syncOutputs();
}

function triggerQuake() {
  if (!selected || !ready) return;
  const event = currentEvent();
  const derived = deriveEarthquake(event);
  runId++;
  simulation.clear();
  simulation.event = { ...event, derived };
  simulation.sourceAmplitudeM = derived.verticalDisplacementM;
  resetWatchState();
  running = true;
  workerBusy = false;
  lastTick = performance.now();
  lastWatchUpdate = 0;
  simulationWorker.postMessage({
    type: 'trigger', runId, event,
    tideLevelM: Number(controls.tide.value),
    ensembleMembers: Number(controls.ensemble.value),
  });
  $('#pauseButton').disabled = false;
  $('#pauseButton').textContent = 'Pause';
  $('#startButton span').textContent = 'Restart quake';
  $('#exportButton').disabled = false;
  setStatus(`M${event.magnitude.toFixed(1)} wave propagating`, 'running');
  updateSourceMetrics(derived, derived.verticalDisplacementM);
  updateWaveTexture();
  renderMap();
}

function resetSimulation() {
  running = false;
  resetWorkerState();
  simulation?.clear();
  $('#simTime').textContent = '00:00';
  $('#pauseButton').disabled = true;
  $('#pauseButton').textContent = 'Pause';
  $('#startButton span').textContent = 'Trigger quake';
  $('#exportButton').disabled = true;
  setStatus(selected ? 'Epicenter ready' : 'Ready—select an ocean');
  resetWatchState();
  syncOutputs();
  updateWaveTexture();
  renderMap();
}

function animationLoop(now) {
  if (running && !workerBusy && now - lastTick >= 80) {
    workerBusy = true;
    const steps = Number(controls.speed.value) * 3;
    simulationWorker.postMessage({ type: 'advance', runId, steps });
    lastTick = now;
  }
  if (running) renderMap();
  requestAnimationFrame(animationLoop);
}

canvas.addEventListener('pointerup', event => {
  const rect = canvas.getBoundingClientRect();
  const longitude = (event.clientX - rect.left) / rect.width * 360 - 180;
  const latitude = LAT_MAX - (event.clientY - rect.top) / rect.height * (LAT_MAX - LAT_MIN);
  selectEpicenter(longitude, latitude);
});

for (const [name, control] of Object.entries(controls)) {
  if (name === 'preset' || name === 'speed' || name === 'mechanism' || name === 'ensemble') continue;
  control.addEventListener('input', syncOutputs);
}
controls.mechanism.addEventListener('change', () => {
  controls.rake.value = defaultRakeForMechanism(controls.mechanism.value);
  syncOutputs();
});
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
$('#scenarioButton').addEventListener('click', () => {
  renderScenarioLibrary();
  $('#scenarioDialog').showModal();
});
$('#saveButton').addEventListener('click', saveCurrentScenario);
$('#shareButton').addEventListener('click', shareCurrentScenario);
$('#exportButton').addEventListener('click', exportResults);
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
    const [bathymetryResponse, landResponse, configResponse, metadataResponse] = await Promise.all([
      fetch('./data/bathymetry.bin'), fetch('./data/land.geojson'), fetch('./config.json'), fetch('./model-metadata.json'),
    ]);
    if (![bathymetryResponse, landResponse, configResponse, metadataResponse].every(response => response.ok)) {
      throw new Error('Required simulation assets could not be loaded');
    }
    const [bathymetryBuffer, landBuffer, config, metadata] = await Promise.all([
      bathymetryResponse.arrayBuffer(), landResponse.arrayBuffer(), configResponse.json(), metadataResponse.json(),
    ]);
    if (metadata.modelId !== 'tsunami-lab-swe-1deg' || metadata.modelVersion !== APP_VERSION) {
      throw new Error('Model metadata is incompatible with this application build');
    }
    await Promise.all([
      verifyDataset(metadata, 'data/bathymetry.bin', bathymetryBuffer),
      verifyDataset(metadata, 'data/land.geojson', landBuffer),
    ]);
    modelMetadata = metadata;
    applyDeploymentConfig(config);
    document.body.dataset.dataIntegrity = 'verified';
    document.body.dataset.modelId = metadata.modelId;
    const depths = decodeBathymetry(bathymetryBuffer);
    simulation = new TsunamiSimulation(depths);
    landGeoJson = JSON.parse(new TextDecoder().decode(landBuffer));
    simulationWorker = new Worker(new URL('./simulation-worker.js', import.meta.url), { type: 'module' });
    simulationWorker.addEventListener('message', handleWorkerMessage);
    const workerReady = new Promise((resolve, reject) => {
      workerReadyResolve = resolve;
      setTimeout(() => reject(new Error('Simulation worker startup timed out')), 8000);
    });
    const workerDepths = depths.slice();
    simulationWorker.postMessage({
      type: 'init', width: GRID_WIDTH, height: GRID_HEIGHT,
      depthBuffer: workerDepths.buffer, watchPoints: WATCH_POINTS,
    }, [workerDepths.buffer]);
    await workerReady;
    ready = true;
    canvas.dataset.grid = `${GRID_WIDTH}x${GRID_HEIGHT}`;
    setStatus('Ready—select an ocean');
    $('#statusLight').className = 'ready';
    updateWaveTexture();
    resizeCanvas();
    syncOutputs();
    const sharedScenario = decodeScenarioHash(location.hash);
    if (sharedScenario) {
      applyScenario(sharedScenario);
      showToast('Shared scenario loaded.');
    } else if (location.hash.startsWith('#scenario=')) {
      showToast('That shared scenario link is invalid.');
    }
    requestAnimationFrame(animationLoop);
  } catch (error) {
    console.error(error);
    setStatus('Failed to load simulation engine');
    showToast('Could not load simulation data. Reload the app.');
  }
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', async () => {
    try {
      let reloading = false;
      const hadController = Boolean(navigator.serviceWorker.controller);
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloading) return;
        reloading = true;
        location.reload();
      });
      const registration = await navigator.serviceWorker.register('./sw.js');
      const offerUpdate = () => $('#updateButton').classList.remove('hidden');
      if (registration.waiting && navigator.serviceWorker.controller) offerUpdate();
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate();
        });
      });
      $('#updateButton').addEventListener('click', () => registration.waiting?.postMessage({ type: 'skipWaiting' }));
    } catch (error) {
      console.warn('Service worker registration failed', error);
    }
  });
}
window.addEventListener('appinstalled', () => {
  $('#installButton').classList.add('hidden');
  showToast('Tsunami Lab installed.');
});
initialize();
