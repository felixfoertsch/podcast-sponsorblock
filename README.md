# podcast-sponsorblock

GPL-3.0 sidecar for stock Audiobookshelf. Node + Hono; sidecar-owned SQLite; no stable filesystem or database access. Source provenance: [PROVENANCE.md](PROVENANCE.md).

## 2026-10-26: first-pass review and frontend debug ownership

Read-only baseline: 3466 stable episodes; 3293 cached. All 173 omitted episodes have audio but lack local GUID/enclosure: 172 absent by normalized title from current feeds, one punctuation-only title mismatch recovered by unique title/date lookup. Another 90 cached episodes lacked a hash at review (18 failed, two cancelled, 70 awaiting fair one-per-show admissions); scheduler continued progressing, not stalled. Cancelled jobs now become eligible again after consent is re-enabled.

Failed jobs: 13 duration ≥14400 s, two <50 s, two source byte limits (256 MiB), one source timeout, one overlong analyzer error exceeding result status limit. Bounds stay unchanged; analyzer errors now bounded before storage. Detector remains byte-identical.

Twelve samples per unusable class span shows. Corpus counts: `no_matching_episode` 388 with zero copies / three with one; `no_safe_candidates` 147 with one; `insufficient_diversity` 37 with zero / one with one. RSS regex left XML entities encoded in titles and enclosure queries; proper existing XML parser fixes matching and signed/query URLs without changing detector logic. Unique decoded feed matches identify scoped retry candidates; no automatic periodic retry exists for completed unusable content. New feed variants could help, but current result cache otherwise short-circuits analysis. Job records contain enqueue times, not execution start/end, so exact throughput attribution from job timings is unavailable.

Removed sidecar debug source, mount, dependency, tests and contract entry. Frontend owns `/debug-api` and its database; old sidecar `debug-overlay.sqlite` remains untouched. Frontend tracked source has no `/psb/api/debug` call; obsolete prose in `compatibility.md` and unused contract/mock entries remain frontend-owned. Regression tests cover decoded XML entities, missing local RSS identity, punctuation-only title lookup, cancelled-job admission and bounded analyzer errors.

## 2026-10-25: browser write origins behind frontend proxy

Browser consent and episode-analysis writes previously compared public `Origin` with the proxy's internal request origin, returning `403 {"error":"origin_denied"}`. Set `PSB_ALLOWED_ORIGINS=https://podcast.foertsch.family` (comma-separated exact origins, no paths) to allow this frontend without trusting forwarded headers. Empty configuration preserves same-origin-only browser writes; missing Origin remains allowed. Authentication and admin access-token checks remain required. Regression coverage includes public allowlist, foreign/lookalike/scheme rejection, same-origin and non-browser writes. Debug integration source remains unchanged.

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
