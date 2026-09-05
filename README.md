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

The E2E suite covers initial loading, responsive canvas layout, Web Worker startup, one-degree grid metadata, finite-fault patches, rake/mechanism coupling, presets, ocean/land selection, wave start/pause/resume/reset, high-speed responsiveness, coastal-watch updates, scenario saving/sharing/export, privacy disclosures, PWA assets, service-worker installation, and a fully offline reload. Every browser scenario runs in desktop Chromium and a Pixel 7 viewport.

Run the same suite against the deployed site without starting a local server:

```bash
PLAYWRIGHT_BASE_URL=https://salus-ryan.github.io/tsunami-lab/ npm run test:e2e
```

## Gameplay

1. Tap ocean water or choose a historical-event-inspired preset.
2. Set moment magnitude, focal depth, strike, dip, rake, fault mechanism, tidal stage, and ensemble size.
3. Trigger the earthquake and watch crest/trough propagation.
4. Change simulation speed, pause, or reset.
5. Review maximum coastal-wave proxies and first-signal times at watch points.
6. Save scenarios locally, share reproducible URL links, or export a JSON result report.

Saved scenarios never leave the device. Shared settings live in the URL fragment, and exports are generated entirely in the browser. See the in-app [privacy notice](https://salus-ryan.github.io/tsunami-lab/privacy.html).

The included presets are **inspired by** historical source regions. They are not event reconstructions.

## Model

The solver uses a 360 × 160 one-degree equirectangular grid from 80°S to 80°N. A staggered forward-backward scheme advances linear shallow-water mass and momentum:

```text
∂η/∂t + ∇·q = 0
∂q/∂t + gH∇η + f k×q = friction
```

where `η` is sea-surface displacement, `H` is local water depth, `q` is depth-integrated transport, `f` is the Coriolis parameter, and `g` is gravity. Face transports conserve global water volume, land faces enforce zero normal flow, harmonic face depths handle bathymetric transitions, and an adaptive CFL limit keeps each time step stable. Manning-style bottom friction and polar damping remove unresolved energy. The solver runs in a Web Worker so high-speed simulation does not block mobile controls.

Earthquake moment follows:

```text
M₀ = 10^(1.5 Mw + 9.1)
```

An empirical magnitude-to-rupture-area relation estimates fault dimensions. Mean slip is derived from seismic moment and nominal crustal rigidity. Dip, rake, mechanism, and focal depth control vertical coupling. The rupture is divided into tapered, heterogeneous subfault patches that activate progressively at approximately 2.6 km/s rather than displacing the entire source instantaneously.

Optional 3- and 5-member deterministic ensembles perturb magnitude, depth, strike, dip, and rake within bounded source-uncertainty ranges. Every member runs through the full propagation solver; coastal cards report the central result and the resulting range. Tidal stage adjusts wet-cell depth before propagation.

Coastal watch values apply a capped Green's-law-inspired shoaling factor to the nearest coarse offshore cell. Ensemble ranges represent source sensitivity only and are not statistical confidence intervals. They are hazard indicators—not predictions of local run-up, inundation, damage, or casualties.

## Data

- **Bathymetry:** a bundled, downsampled grid derived from Mapzen Terrarium global elevation tiles. Terrarium combines elevation sources including NASA SRTM and ocean bathymetry datasets.
- **Coastline:** Natural Earth 1:110m land polygons (public domain).

The app shell and datasets are cached by a service worker, so the simulator works offline after the first successful load. Production updates are offered in-app and activate only when the user accepts them.

## Enterprise self-hosting

A hardened container (unprivileged nginx, strict security headers, `/healthz` probe), per-deployment `config.json`, dataset integrity pinning in `model-metadata.json`, exported-report JSON Schemas, SBOM/audit/CodeQL/Dependabot supply-chain gates, and air-gap guidance are documented in [`deploy/README.md`](deploy/README.md). Vulnerability reporting is described in [`SECURITY.md`](SECURITY.md).

## Deployment

The production site is deployed to GitHub Pages after unit and Playwright tests pass on `main`:

<https://salus-ryan.github.io/tsunami-lab/>

The workflow in `.github/workflows/test.yml` publishes the `public/` directory. All browser assets use relative URLs so the PWA works correctly beneath the `/tsunami-lab/` project path.

## Critical limitations

This is **not an operational forecast**. Its one-degree cells cannot resolve bays, harbors, local topography, nonlinear inundation, regional tide forecasts, dispersion, wetting/drying, or elastic Okada displacement. The empirical finite fault is not an event reconstruction. Do not use it for emergency planning or safety decisions. Follow official national authorities and tsunami warning centers.

For research-grade modeling, replace the solver with a validated package such as NOAA MOST, GeoClaw, or COMCOT; use high-resolution bathymetry/topography; calibrate against gauges; and have domain experts validate every scenario.
