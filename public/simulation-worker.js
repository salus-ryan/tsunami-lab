import { LAND, TsunamiSimulation, buildEnsembleEvents } from './simulation.js';

let baseDepths;
let simulations = [];
let width;
let height;
let watchPoints = [];
let runId = 0;
let stableDtSeconds = 0;

function depthsAtTide(tideLevelM) {
  if (!tideLevelM) return baseDepths;
  const adjusted = baseDepths.slice();
  for (let index = 0; index < adjusted.length; index++) {
    if (adjusted[index] === LAND) continue;
    adjusted[index] = Math.max(5, Math.min(8000, Math.round(adjusted[index] + tideLevelM)));
  }
  return adjusted;
}

self.addEventListener('message', event => {
  const message = event.data;
  try {
    if (message.type === 'init') {
      width = message.width;
      height = message.height;
      baseDepths = new Uint16Array(message.depthBuffer);
      watchPoints = message.watchPoints || [];
      const probe = new TsunamiSimulation(baseDepths, width, height);
      stableDtSeconds = probe.stableDtSeconds;
      self.postMessage({ type: 'ready', stableDtSeconds });
      return;
    }
    if (!baseDepths) throw new Error('Simulation worker is not initialized');

    if (message.type === 'trigger') {
      runId = message.runId;
      const eventDepths = depthsAtTide(message.tideLevelM || 0);
      const events = buildEnsembleEvents(message.event, message.ensembleMembers);
      simulations = events.map(memberEvent => {
        const model = new TsunamiSimulation(eventDepths, width, height);
        model.trigger(memberEvent);
        return model;
      });
      const primary = simulations[0];
      self.postMessage({
        type: 'triggered', runId,
        derived: primary.event.derived,
        sourceAmplitudeM: primary.sourceAmplitudeM,
        stableDtSeconds: primary.stableDtSeconds,
        ensembleCount: simulations.length,
      });
      return;
    }
    if (message.type === 'reset') {
      runId = message.runId;
      simulations = [];
      self.postMessage({ type: 'reset', runId });
      return;
    }
    if (message.type === 'advance') {
      if (message.runId !== runId || !simulations.length) {
        self.postMessage({ type: 'stale', runId: message.runId });
        return;
      }
      for (const model of simulations) {
        for (let step = 0; step < message.steps; step++) model.step();
      }
      const primary = simulations[0];
      const samples = watchPoints.map(point => simulations.map(model => model.sampleMaximum(point.lon, point.lat)));
      const field = primary.current.slice();
      self.postMessage({
        type: 'frame', runId,
        timeSeconds: primary.timeSeconds,
        sourceAmplitudeM: primary.sourceAmplitudeM,
        samples,
        ensembleCount: simulations.length,
        fieldBuffer: field.buffer,
      }, [field.buffer]);
    }
  } catch (error) {
    self.postMessage({ type: 'error', runId: message.runId, message: error.message, stack: error.stack });
  }
});
