# Migration rehearsal

Approved copied backup: `ffunraid:/mnt/user/appdata/audiobookshelf-experiment-backups/home-feed-rollout-8pqwac0e/config-metadata.tar`, 4,067,870,720 bytes. SHA-256 `2d319a88e8a9143f7f29d8589724ec2167f638df6ee48d1386099f4c98c520bb`. Local immutable input copy: `/private/tmp/opencode/migration-input/config-metadata.tar`. No live experiment DB/file access; never called `ComparisonCorpus.load()` on source. Disk checked before copy.

Read-only API catalogs: stable service login and experiment `ABS_URL`/`ABS_API_KEY`; secrets read inside processes, never printed. Public API metadata feed field is `media.metadata.feedUrl`, not `media.feedURL`; initial scratch snapshot had empty feeds and was corrected before final matching.

| Count | Stable | Experiment stand-in |
|---|---:|---:|
| Source shows / episodes | 21 / 3466 | 21 / 3466 |
| Target shows / episodes | 0 / 0 | 21 / 3466 |
| Matched shows | 0 | 21 |
| Matched episodes | 0 | 3247 |
| Ambiguous/conflicting episodes | 0 | 46 |
| Unmatched episodes | 3466 | 173 |
| Corpus versions archived | 2182 | 2182 |
| Debug records archived | 29 | 29 |
| Applicable imported results | 0 | 0 |
| Receipts after second run | 1 | 1 |
| Second run idempotent | true | true |
| SQLite integrity | ok | ok |
| Foreign-key violations | 0 | 0 |

Stand-in match rate: 3247/3466 = 93.68%; conflicts remain archived rather than guessed. All 21 shows uniquely match. Zero stable matches expected: podcasts not provisioned yet. Rehearsals import into disposable sidecar SQLite only, with all source results non-applicable. Scratch reports: `/private/tmp/opencode/migration-input/{stable,experiment}-report.json`.

Open migration gaps: production CLI still requires hardening for tar member/symlink validation and complete v1/v2 hash validation; migration tables currently archive records but do not bridge mapped consent/results/corpus into runtime tables or rewrite/import debug routes. No cutover import performed. `scripts/rehearse-migration.cjs` reproduces measured archive/idempotency evidence; `bin/migrate-experiment` remains dry-run-only until those gaps close.
