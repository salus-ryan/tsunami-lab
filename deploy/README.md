# Enterprise deployment

Tsunami Lab is a fully static, client-side application. Enterprise deployments
self-host the `public/` directory behind any web server or run the hardened
container. There is no backend, database, telemetry, or external runtime
dependency, so the app operates in air-gapped networks after assets are copied.

## Hardened container

```bash
docker build -t tsunami-lab:1.1.0 .
docker run --rm -p 8080:8080 --read-only --cap-drop=ALL tsunami-lab:1.1.0
```

- Based on `nginxinc/nginx-unprivileged` (runs as UID 101, listens on 8080).
- Ships strict security headers: CSP (no inline code, no third-party origins),
  `frame-ancestors 'none'`, COOP/CORP, Permissions-Policy, Referrer-Policy,
  `nosniff`, and `X-Frame-Options: DENY`.
- `GET /healthz` returns `{"status":"ok"}` for liveness/readiness probes; a
  Docker `HEALTHCHECK` is prewired.
- `sw.js` and `config.json` are served with no-cache so updates and
  configuration changes propagate promptly.

## Per-deployment configuration (`public/config.json`)

```json
{
  "schemaVersion": 1,
  "deploymentId": "acme-internal",
  "productName": "Tsunami Lab",
  "organizationName": "ACME Geoscience",
  "supportUrl": "https://intranet.example.com/help",
  "privacyUrl": "./privacy.html",
  "telemetryEnabled": false,
  "dataResidency": "client-only"
}
```

- `organizationName` renders a "Managed by …" badge in the header.
- `supportUrl`/`privacyUrl` must be http(s) URLs; anything else falls back to
  defaults.
- `telemetryEnabled` must remain `false`; the client refuses to start
  otherwise. `dataResidency` is forced to `client-only`.
- The deployment id is embedded in exported result reports for traceability.

## Integrity and provenance

- `public/model-metadata.json` pins the model id/version, solver description,
  dataset SHA-256 digests, sizes, provenance, and intended/prohibited use.
- The client verifies both datasets against these digests at startup and fails
  closed on mismatch, then stamps `data-data-integrity="verified"`.
- Exported reports embed the deployment config, model metadata, and reference
  the published JSON Schemas (`public/schemas/*.schema.json`) so downstream
  systems can validate them.

## Supply chain

- CI publishes a CycloneDX SBOM artifact on every build and gates on
  `npm audit --audit-level=high`.
- CodeQL scanning and Dependabot (npm, Docker, GitHub Actions) are enabled.
- The container CI job builds the image and verifies the health endpoint and
  security headers before any deployment proceeds.

## Limitations

This remains an educational model. Enterprise hardening covers hosting,
integrity, and supply chain—it does not change the scientific limitations
documented in the README and in-app disclosures.
