# Tsunami Lab

A mobile-first, installable educational game for exploring how underwater earthquakes generate and propagate tsunamis across real-world oceans.

## Run

```bash
npm install
npm start
```

Open <http://localhost:4173>. On a phone, serve it over HTTPS (or use localhost) and choose **Install** when the browser offers it.

```bash
npm test             # physics/data unit tests
npm run test:e2e     # Playwright desktop + Pixel 7 browser tests
npm run test:e2e:mobile
npm run test:e2e:headed
npm run test:all
npm run check        # JavaScript syntax checks
npm run dev          # restart server when files change
```

Before the first E2E run on a supported desktop host, install Chromium:

```bash
npx playwright install chromium
```

Playwright starts the app server automatically. Failure traces, screenshots, and videos are saved under `test-results/`; the HTML report is written to `playwright-report/`.

The E2E suite covers initial loading, responsive canvas layout, presets, source controls, ocean/land selection, wave start/pause/resume/reset, coastal-watch updates, scientific disclosures, PWA assets, service-worker installation, and a fully offline reload. Every browser scenario runs in desktop Chromium and a Pixel 7 viewport.

## Gameplay

1. Tap ocean water or choose a historical-event-inspired preset.
2. Set moment magnitude, focal depth, strike, dip, and fault mechanism.
3. Trigger the earthquake and watch crest/trough propagation.
4. Change simulation speed, pause, or reset.
5. Review maximum coastal-wave proxies and first-signal times at watch points.

The included presets are **inspired by** historical source regions. They are not event reconstructions.

## Model

The solver uses a 180 × 80 equirectangular grid from 80°S to 80°N. Each one-minute step advances a linear, depth-varying shallow-water wave equation:

```text
∂²η/∂t² = g ∇·(H ∇η)
```

where `η` is sea-surface displacement, `H` is local water depth, and `g` is gravity. The finite-difference solver includes spherical east-west cell scaling, reflective land boundaries, and mild numerical damping.

Earthquake moment follows:

```text
M₀ = 10^(1.5 Mw + 9.1)
```

An empirical magnitude-to-rupture-area relation estimates fault dimensions. Mean slip is derived from seismic moment and a nominal crustal rigidity. Dip, mechanism, and focal depth control vertical coupling. An idealized two-lobed finite source initializes sea-surface displacement.

Coastal watch values apply a capped Green's-law-inspired shoaling factor to the nearest coarse offshore cell. They are hazard indicators—not predictions of local run-up, inundation, damage, or casualties.

## Data

- **Bathymetry:** a bundled, downsampled grid derived from Mapzen Terrarium global elevation tiles. Terrarium combines elevation sources including NASA SRTM and ocean bathymetry datasets.
- **Coastline:** Natural Earth 1:110m land polygons (public domain).

The app shell and datasets are cached by a service worker, so the simulator works offline after the first successful load.

## Deployment

The production site is deployed to GitHub Pages after unit and Playwright tests pass on `main`:

<https://salus-ryan.github.io/tsunami-lab/>

The workflow in `.github/workflows/test.yml` publishes the `public/` directory. All browser assets use relative URLs so the PWA works correctly beneath the `/tsunami-lab/` project path.

## Critical limitations

This is **not an operational forecast**. Its two-degree cells cannot resolve bays, harbors, local topography, nonlinear inundation, tides, dispersion, bottom friction, or detailed finite-fault rupture. Do not use it for emergency planning or safety decisions. Follow official national authorities and tsunami warning centers.

For research-grade modeling, replace the solver with a validated package such as NOAA MOST, GeoClaw, or COMCOT; use high-resolution bathymetry/topography; calibrate against gauges; and have domain experts validate every scenario.
