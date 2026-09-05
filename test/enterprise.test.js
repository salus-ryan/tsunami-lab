import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(`../public/${relativePath}`, import.meta.url), 'utf8'));
}

test('model metadata pins verifiable digests for every bundled dataset', async () => {
  const metadata = await readJson('model-metadata.json');
  assert.equal(metadata.schemaVersion, 1);
  assert.equal(metadata.modelId, 'tsunami-lab-swe-1deg');
  assert.equal(metadata.sourceModel.elasticDislocation, false);
  assert.match(metadata.prohibitedUse, /Operational forecasting/);
  assert.equal(metadata.datasets.length, 2);
  for (const dataset of metadata.datasets) {
    const file = await readFile(new URL(`../public/${dataset.path}`, import.meta.url));
    assert.equal(file.byteLength, dataset.bytes, `${dataset.path} byte size`);
    assert.equal(createHash('sha256').update(file).digest('hex'), dataset.sha256, `${dataset.path} sha256`);
    assert.ok(dataset.provenance.length > 10);
  }
});

test('model metadata version matches the application package version', async () => {
  const metadata = await readJson('model-metadata.json');
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(metadata.modelVersion, packageJson.version);
});

test('default deployment configuration is safe: no telemetry, client-only data', async () => {
  const config = await readJson('config.json');
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.telemetryEnabled, false);
  assert.equal(config.dataResidency, 'client-only');
  assert.match(config.supportUrl, /^https:\/\//);
});

test('published JSON Schemas describe scenarios and reports consistently', async () => {
  const scenarioSchema = await readJson('schemas/scenario.schema.json');
  const reportSchema = await readJson('schemas/report.schema.json');
  assert.equal(scenarioSchema.properties.version.const, 1);
  assert.deepEqual(scenarioSchema.properties.ensembleMembers.enum, [1, 3, 5]);
  assert.equal(scenarioSchema.properties.event.properties.magnitude.maximum, 9.5);
  assert.equal(reportSchema.properties.reportFormatVersion.const, 1);
  assert.equal(reportSchema.properties.scenario.$ref, './scenario.schema.json');
  assert.ok(reportSchema.required.includes('deployment'));
  assert.ok(reportSchema.required.includes('model'));
});

test('index page enforces a strict Content Security Policy without inline code', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /object-src 'none'/);
  assert.doesNotMatch(html, /'unsafe-inline'/);
  assert.doesNotMatch(html, /'unsafe-eval'/);
  assert.doesNotMatch(html, /style="/);
  assert.doesNotMatch(html, /\son[a-z]+="/);
});
