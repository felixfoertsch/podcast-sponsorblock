# podcast-sponsorblock

GPL-3.0 sidecar for stock Audiobookshelf. Node + Hono; sidecar-owned SQLite; no stable filesystem or database access. Source provenance: [PROVENANCE.md](PROVENANCE.md).

## Run

`mise install`, `mise exec -- bun install --frozen-lockfile`, `mise exec -- bun run check`, `mise exec -- bun run build`.

Required secrets: `PSB_STABLE_USERNAME`, `PSB_STABLE_PASSWORD`. Stable base defaults to `https://audiobookshelf.felixfoertsch.de`. `PSB_DATA_DIR` defaults to `/data`; `PORT` defaults to `3000`. `PSB_SCHEDULER_ENABLED=0` by default. `AD_ANALYSIS_PROXY_URL` stays unset for direct transport; configured proxy fails closed.

Browser sends bearer token; sidecar validates through stable `/api/me`. No browser tokens stored. Native playback/progress stays on stable. API contracts live in `contract/`; frontend proxy strips `/psb` before forwarding. Public sidecar hostname intended: `psb.foertsch.family`; repository does not configure routing.

Container runs as non-root `node`; listen on container port `3000` (override with `PORT`). Set `PSB_STABLE_USERNAME` and `PSB_STABLE_PASSWORD`; `PSB_STABLE_URL` defaults to `https://audiobookshelf.felixfoertsch.de`. `PSB_DATA_DIR` defaults to `/data`; mount persistent writable storage there for sidecar SQLite state. Mount bounded writable `/tmp` tmpfs (the image uses `/tmp/psb` for temporary work). Use read-only root filesystem, drop all capabilities, and set CPU/memory/PID limits. Health probe: `GET /healthz` on port `3000` returns `{"status":"ok"}`. Do not mount stable media/config/metadata or Docker socket.

Fresh schema only; legacy runtime databases are rejected. Stop sidecar and verify a backup before replacing development data. No experiment import or schema migration remains.

## Deployment (private staging only)

Persistent `/data` holds `sidecar.sqlite` (runtime results and corpus blobs) and package-owned debug SQLite. Provision directory writable by image user `node` (UID 1000). Secrets file must contain only `PSB_STABLE_USERNAME` and `PSB_STABLE_PASSWORD`, mode `0600`. No stable mounts, public routing, or cutover.

```fish
docker run --name podcast-sponsorblock --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --memory 2g --cpus 2 --env-file /secure/psb.env -e PSB_SCHEDULER_ENABLED=0 -p 127.0.0.1:3000:3000 -v /srv/psb:/data --tmpfs /tmp:rw,nosuid,nodev,size=512m git.felixfoertsch.de/felixfoertsch/podcast-sponsorblock:main
```

On shared Docker network, use `PSB_STABLE_URL=http://audiobookshelf:80`. Plain HTTP is accepted only for this fixed internal service and port; external feed/media SSRF protections remain unchanged. Stable URL is transport configuration, never a data key.

## Checks

`bun run check` runs strict TypeScript, Node tests and extracted Mocha suites. `node scripts/native-smoke.cjs` checks SQLite, ffmpeg and full-duration 125-second Chromaprint. `test-manifest.json` records source-suite dispositions; adaptation gaps remain explicit, not disguised by test counts.

Results use `(audio_sha256, detector_version)` only. Consent uses feed `podcast:guid` verbatim, otherwise normalized feed URL. Corpus uses this show key plus RSS guid, otherwise enclosure scheme/host/path. ABS IDs and file metadata live only in rebuildable local caches and job routing. A changed file identity hides results until hashing; identical bytes reuse results without detector work. The single worker hashes during download and rechecks content before analysis. Queue capacity is 32; explicit requests precede scheduler admissions, with one admission per show/pass. `GET /api/content/:sha256` requires stable authentication; item routes additionally prove requesting-user item access. Public sharing and federation remain deferred.
