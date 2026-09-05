# Security policy

## Supported versions

Only the latest release on `main` (currently v1.1.x) receives security fixes.

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub Security Advisories:
<https://github.com/salus-ryan/tsunami-lab/security/advisories/new>

Do not open public issues for unpatched vulnerabilities. You should receive an
acknowledgement within 7 days.

## Architecture and data handling

- All simulation runs entirely in the browser; there is no application backend,
  account system, telemetry, or third-party network dependency at runtime.
- Saved scenarios use browser `localStorage`; shared links encode settings in
  the URL fragment; exports are generated locally.
- Bundled datasets (`data/bathymetry.bin`, `data/land.geojson`) are verified at
  startup against SHA-256 digests pinned in `model-metadata.json`. Startup
  fails closed if verification fails.
- Pages are served with a strict Content Security Policy (no inline script or
  style, no third-party origins), `no-referrer`, and `nosniff`. The hardened
  container adds `frame-ancestors 'none'`, COOP/CORP, and a Permissions-Policy
  that disables camera, microphone, geolocation, payment, and USB.

## Automated controls

- CodeQL static analysis on pushes, pull requests, and a weekly schedule.
- `npm audit --audit-level=high` gate and CycloneDX SBOM artifact in CI.
- Dependabot updates for npm, Docker, and GitHub Actions.
- Unit, physics, integrity, and 36 desktop/mobile Playwright tests gate every
  deployment; the container job verifies health checks and security headers.
