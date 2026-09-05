import { test, expect } from '@playwright/test';

async function waitForEarthData(page) {
  await page.goto('./');
  await expect(page.locator('#statusText')).toHaveText('Ready—select an ocean');
  await expect(page.locator('#mapCanvas')).toBeVisible();
}

async function choosePreset(page, preset = 'tohoku') {
  await page.locator('#presetSelect').selectOption(preset);
  await expect(page.getByRole('button', { name: 'Trigger quake' })).toBeEnabled();
}

test.beforeEach(async ({ page }) => {
  await waitForEarthData(page);
});

test('loads the responsive application shell and Earth data', async ({ page }) => {
  await expect(page).toHaveTitle('Tsunami Lab');
  await expect(page.getByRole('heading', { name: 'Tsunami Lab', exact: true })).toBeVisible();
  await expect(page.getByText('Global earthquake wave sandbox')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Trigger quake' })).toBeDisabled();
  await expect(page.locator('#simTime')).toHaveText('00:00');
  const backingWidth = await page.locator('#mapCanvas').evaluate(element => element.width);
  const canvasBox = await page.locator('#mapCanvas').boundingBox();
  expect(backingWidth).toBeGreaterThan(0);
  expect(canvasBox.width).toBeGreaterThan(300);
  expect(canvasBox.height).toBeGreaterThan(130);
});

test('runs the upgraded one-degree model in a Web Worker', async ({ page }) => {
  await expect(page.locator('body')).toHaveAttribute('data-simulation-backend', 'worker');
  await expect(page.locator('#mapCanvas')).toHaveAttribute('data-grid', '360x160');
  const stableDt = Number(await page.locator('body').getAttribute('data-stable-dt'));
  expect(stableDt).toBeGreaterThanOrEqual(2);
  expect(stableDt).toBeLessThanOrEqual(30);
});

test('loads an earthquake preset and derives source metrics', async ({ page }) => {
  await choosePreset(page, 'tohoku');

  await expect(page.locator('#coordinateLabel')).toHaveText('38.3°N, 143.1°E');
  await expect(page.locator('#magnitudeOutput')).toHaveText('9.1');
  await expect(page.locator('#depthOutput')).toHaveText('29 km');
  await expect(page.locator('#mechanism')).toHaveValue('subduction');

  const metrics = page.locator('#sourceMetrics strong');
  await expect(metrics).toHaveCount(4);
  await expect(metrics.nth(0)).toContainText('km');
  await expect(metrics.nth(1)).toContainText('m');
  await expect(metrics.nth(2)).toContainText('m');
});

test('builds a multi-patch source and responds physically to rake', async ({ page }) => {
  await choosePreset(page, 'tohoku');
  const metrics = page.locator('#sourceMetrics strong');
  await expect(metrics.nth(3)).toHaveText(/\d+ \(\d+×\d+\)/);
  const thrustWave = Number((await metrics.nth(2).textContent()).replace(/[^0-9.]/g, ''));

  await page.locator('#rake').fill('0');
  await expect(page.locator('#rakeOutput')).toHaveText('0°');
  const strikeParallelWave = Number((await metrics.nth(2).textContent()).replace(/[^0-9.]/g, ''));
  expect(strikeParallelWave).toBeLessThan(thrustWave);
});

test('runs, pauses, resumes, and resets a tsunami simulation', async ({ page }) => {
  await choosePreset(page, 'tohoku');
  await page.getByRole('button', { name: 'Trigger quake' }).click();

  await expect(page.locator('#statusText')).toContainText('M9.1 wave propagating');
  await expect(page.getByRole('button', { name: 'Pause' })).toBeEnabled();
  await expect.poll(() => page.locator('#simTime').textContent()).not.toBe('00:00');
  await expect(page.locator('.watch-item')).toHaveCount(10);
  await expect(page.locator('#sourceMetrics strong').nth(2)).not.toHaveText('0.00 m');

  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.locator('#statusText')).toHaveText('Simulation paused');
  // Allow the already-dispatched worker batch to settle, then verify no new batch starts.
  await page.waitForTimeout(300);
  const pausedAt = await page.locator('#simTime').textContent();
  await page.waitForTimeout(300);
  await expect(page.locator('#simTime')).toHaveText(pausedAt);

  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.locator('#statusText')).toHaveText('Wave propagating');
  await expect.poll(() => page.locator('#simTime').textContent()).not.toBe(pausedAt);

  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(page.locator('#simTime')).toHaveText('00:00');
  await expect(page.locator('#statusText')).toHaveText('Epicenter ready');
  await expect(page.getByText('Run a scenario to populate coastal estimates.')).toBeVisible();
});

test('accepts ocean taps and rejects land taps', async ({ page }) => {
  const canvas = page.locator('#mapCanvas');
  const box = await canvas.boundingBox();

  // 10°E, 50°N is an inland cell in the bundled terrain grid.
  await canvas.click({ position: { x: box.width * (190 / 360), y: box.height * (30 / 160) } });
  await expect(page.locator('#toast')).toContainText('selected cell is on land');
  await expect(page.getByRole('button', { name: 'Trigger quake' })).toBeDisabled();

  // 140°W, equator is open Pacific Ocean.
  await canvas.click({ position: { x: box.width * (40 / 360), y: box.height * 0.5 } });
  await expect(page.locator('#coordinateLabel')).toHaveText('0.0°N, 140.0°W');
  await expect(page.getByRole('button', { name: 'Trigger quake' })).toBeEnabled();
  await expect(page.locator('#presetSelect')).toHaveValue('custom');
});

test('updates magnitude, fault geometry, and mechanism controls', async ({ page }) => {
  await choosePreset(page, 'aleutian');
  await page.locator('#magnitude').fill('7.4');
  await page.locator('#depth').fill('65');
  await page.locator('#strike').fill('270');
  await page.locator('#dip').fill('45');
  await page.locator('#mechanism').selectOption('strike-slip');

  await expect(page.locator('#magnitudeOutput')).toHaveText('7.4');
  await expect(page.locator('#depthOutput')).toHaveText('65 km');
  await expect(page.locator('#strikeOutput')).toHaveText('270°');
  await expect(page.locator('#dipOutput')).toHaveText('45°');
  await expect(page.locator('#rakeOutput')).toHaveText('0°');
  await expect(page.locator('#mechanism')).toHaveValue('strike-slip');
  await expect(page.locator('#sourceMetrics strong').nth(0)).toContainText('km');
});

test('fault mechanisms choose physically conventional default rake', async ({ page }) => {
  await page.locator('#mechanism').selectOption('normal');
  await expect(page.locator('#rakeOutput')).toHaveText('-90°');
  await page.locator('#mechanism').selectOption('strike-slip');
  await expect(page.locator('#rakeOutput')).toHaveText('0°');
  await page.locator('#mechanism').selectOption('subduction');
  await expect(page.locator('#rakeOutput')).toHaveText('90°');
});

test('high-speed worker simulation keeps controls responsive', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await choosePreset(page, 'chile');
  await page.locator('#speedSelect').selectOption('12');
  await page.getByRole('button', { name: 'Trigger quake' }).click();
  await expect.poll(() => page.locator('#simTime').textContent()).not.toBe('00:00');
  await page.getByRole('button', { name: 'About the model' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Understood' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(errors).toEqual([]);
});

test('explains scientific limitations in an accessible modal', async ({ page }) => {
  await page.getByRole('button', { name: 'About the model' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'About Tsunami Lab' })).toBeVisible();
  await expect(dialog).toContainText('mass and momentum on a staggered');
  await expect(dialog).toContainText('not an Okada elastic-dislocation solution');
  await dialog.getByRole('button', { name: 'Understood' }).click();
  await expect(dialog).toBeHidden();
});

test('installs its service worker and reloads its complete app shell offline', async ({ page, context }) => {
  const workerState = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const worker = registration.active || registration.waiting || registration.installing;
    if (worker?.state !== 'activated') {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Service worker activation timed out')), 5000);
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'activated') {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
    }
    return worker?.state;
  });
  expect(workerState).toBe('activated');

  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#statusText')).toHaveText('Ready—select an ocean');
    await expect(page.locator('#mapCanvas')).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});

test('serves the PWA manifest and simulation datasets', async ({ request }) => {
  const manifestResponse = await request.get('./manifest.webmanifest');
  expect(manifestResponse.ok()).toBeTruthy();
  const manifest = await manifestResponse.json();
  expect(manifest.name).toContain('Tsunami Lab');
  expect(manifest.display).toBe('standalone');

  const bathymetry = await request.get('./data/bathymetry.bin');
  expect(bathymetry.ok()).toBeTruthy();
  expect((await bathymetry.body()).byteLength).toBe(360 * 160 * 2);

  const coastline = await request.get('./data/land.geojson');
  expect(coastline.ok()).toBeTruthy();
  expect((await coastline.json()).type).toBe('FeatureCollection');
});
