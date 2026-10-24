# podcast-sponsorblock

GPL-3.0 sidecar for stock Audiobookshelf. Node + Hono; sidecar-owned SQLite; no stable filesystem or database access. Source provenance: [PROVENANCE.md](PROVENANCE.md).

## Run

`mise install`, `mise exec -- bun install --frozen-lockfile`, `mise exec -- bun run check`, `mise exec -- bun run build`.

Required secrets: `PSB_STABLE_USERNAME`, `PSB_STABLE_PASSWORD`. Stable base defaults to `https://audiobookshelf.felixfoertsch.de`. `PSB_DATA_DIR` defaults to `/data`; `PORT` defaults to `3000`. `PSB_SCHEDULER_ENABLED=0` by default. `AD_ANALYSIS_PROXY_URL` stays unset for direct transport; configured proxy fails closed.

Browser sends bearer token; sidecar validates through stable `/api/me`. No browser tokens stored. Native playback/progress stays on stable. API contracts live in `contract/`; frontend proxy strips `/psb` before forwarding. Public sidecar hostname intended: `psb.foertsch.family`; repository does not configure routing.

Container runs as non-root `node`; listen on container port `3000` (override with `PORT`). Set `PSB_STABLE_USERNAME` and `PSB_STABLE_PASSWORD`; `PSB_STABLE_URL` defaults to `https://audiobookshelf.felixfoertsch.de`. `PSB_DATA_DIR` defaults to `/data`; mount persistent writable storage there for sidecar SQLite state. Mount bounded writable `/tmp` tmpfs (the image uses `/tmp/psb` for temporary work). Use read-only root filesystem, drop all capabilities, and set CPU/memory/PID limits. Health probe: `GET /healthz` on port `3000` returns `{"status":"ok"}`. Do not mount stable media/config/metadata or Docker socket.

Import backups with `bin/migrate-experiment --input BACKUP-TAR --stable-catalog JSON --database SQLITE`; add `--apply` only after reviewing dry-run results, and use `--debug-database SQLITE` when importing debug data. Keep `PSB_DATA_DIR` pointed at persistent volume. Back up sidecar data before upgrade; SQLite store upgrades schema on startup. Build-only extraction: no cutover or running-container changes.

## Deployment (private staging only)

Persistent `/data` holds `sidecar.sqlite` (runtime results and corpus blobs) and package-owned debug SQLite. Provision directory writable by image user `node` (UID 1000). Secrets file must contain only `PSB_STABLE_USERNAME` and `PSB_STABLE_PASSWORD`, mode `0600`. No stable mounts, public routing, or cutover.

```fish
docker run --name podcast-sponsorblock --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --memory 2g --cpus 2 --env-file /secure/psb.env -e PSB_SCHEDULER_ENABLED=0 -p 127.0.0.1:3000:3000 -v /srv/psb:/data --tmpfs /tmp:rw,nosuid,nodev,size=512m git.felixfoertsch.de/felixfoertsch/podcast-sponsorblock:main
```

Offline migration needs Node, installed project dependencies, and Python 3. Stop sidecar before apply; back up both SQLite files. Default dry-run leaves destination untouched. Set `PSB_STABLE_URL` identically for migration and runtime (default stable URL above).

```fish
mise exec -- bin/migrate-experiment --input /backup/config-metadata.tar --stable-catalog /backup/catalog.json --database /srv/psb/sidecar.sqlite --debug-database /srv/psb/debug-overlay.sqlite --apply
```

## Checks

`bun run check` runs strict TypeScript, Node tests and extracted Mocha suites. `node scripts/native-smoke.cjs` checks SQLite, ffmpeg and full-duration 125-second Chromaprint. `test-manifest.json` records source-suite dispositions; adaptation gaps remain explicit, not disguised by test counts.

Migration consumes copied backup only; see `bin/migrate-experiment` and `migration-report.md`. `GET /analysis` never fetches audio: its existing ACL item response supplies `audioFile.ino`, `audioFile.metadata.size`, and `audioFile.metadata.mtimeMs`. Changed or unknown identity clears applicability and schedules durable low-priority `verify` work. Unchanged verified identity needs no download. Single worker verifies source hashes once per identity; mismatch schedules reanalysis only with consent. Queue holds at most 32 admitted jobs; analyses run first and may displace queued verification, which remains discoverable from stored pending results. Imported results drain through this queue even before a page view. Missing file identity fails closed. Post-analysis source re-download check remains enabled. Imported segments remain non-applicable until stable source SHA-256 matches. Never call `ComparisonCorpus.load()` on experiment source.
