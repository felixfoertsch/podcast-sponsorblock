# podcast-sponsorblock

GPL-3.0 sidecar for stock Audiobookshelf. Node + Hono; sidecar-owned SQLite; no stable filesystem or database access. Source provenance: [PROVENANCE.md](PROVENANCE.md).

## Run

`mise install`, `mise exec -- bun install --frozen-lockfile`, `mise exec -- bun run check`, `mise exec -- bun run build`.

Required secrets: `PSB_STABLE_USERNAME`, `PSB_STABLE_PASSWORD`. Stable base defaults to `https://audiobookshelf.felixfoertsch.de`. `PSB_DATA_DIR` defaults to `/data`; `PORT` defaults to `3000`. `PSB_SCHEDULER_ENABLED=0` by default. `AD_ANALYSIS_PROXY_URL` stays unset for direct transport; configured proxy fails closed.

Browser sends bearer token; sidecar validates through stable `/api/me`. No browser tokens stored. Native playback/progress stays on stable. API contracts live in `contract/`; frontend proxy strips `/psb` before forwarding. Public sidecar hostname intended: `psb.foertsch.family`; repository does not configure routing.

Container runs as non-root `node`. Mount writable `/data`, bounded `/tmp` tmpfs; use read-only rootfs, dropped capabilities, resource limits. Do not mount stable media/config/metadata or Docker socket. Build-only extraction: no cutover or running-container changes.

## Checks

`bun run check` runs strict TypeScript, Node tests and extracted Mocha suites. `node scripts/native-smoke.cjs` checks SQLite, ffmpeg and full-duration 125-second Chromaprint. `test-manifest.json` records source-suite dispositions; adaptation gaps remain explicit, not disguised by test counts.

Migration consumes copied backup only; see `bin/migrate-experiment` and `migration-report.md`. Imported segments remain non-applicable until stable source SHA-256 matches. Never call `ComparisonCorpus.load()` on experiment source.
