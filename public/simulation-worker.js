import { TsunamiSimulation } from './simulation.js';

let simulation;
let watchPoints = [];
let runId = 0;

self.addEventListener('message', event => {
  const message = event.data;
  try {
    if (message.type === 'init') {
      simulation = new TsunamiSimulation(new Uint16Array(message.depthBuffer), message.width, message.height);
      watchPoints = message.watchPoints || [];
      self.postMessage({ type: 'ready', stableDtSeconds: simulation.stableDtSeconds });
      return;
    }
    if (!simulation) throw new Error('Simulation worker is not initialized');

    if (message.type === 'trigger') {
      runId = message.runId;
      const derived = simulation.trigger(message.event);
      self.postMessage({
        type: 'triggered', runId, derived,
        sourceAmplitudeM: simulation.sourceAmplitudeM,
        stableDtSeconds: simulation.stableDtSeconds,
      });
      return;
    }
    if (message.type === 'reset') {
      runId = message.runId;
      simulation.clear();
      self.postMessage({ type: 'reset', runId });
      return;
    }
    if (message.type === 'advance') {
      if (message.runId !== runId || !simulation.event) {
        self.postMessage({ type: 'stale', runId: message.runId });
        return;
      }
      for (let step = 0; step < message.steps; step++) simulation.step();
      const samples = watchPoints.map(point => simulation.sampleMaximum(point.lon, point.lat));
      const field = simulation.current.slice();
      self.postMessage({
        type: 'frame', runId,
        timeSeconds: simulation.timeSeconds,
        sourceAmplitudeM: simulation.sourceAmplitudeM,
        samples,
        fieldBuffer: field.buffer,
      }, [field.buffer]);
    }
  } catch (error) {
    self.postMessage({ type: 'error', runId: message.runId, message: error.message, stack: error.stack });
  }
});
