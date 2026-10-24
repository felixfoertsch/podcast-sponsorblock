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

## Apply rehearsal

`bin/migrate-experiment --apply` now validates all tar members before extraction (rejects links/devices/absolute/traversal paths; bounded member count and sizes), verifies evidence hashes, converts v1 audio to frame evidence, bridges runtime consent/results/corpus, maps debug paths, and archives unmapped records. Offline SQLite transaction includes runtime, archive, receipt, and attached debug database; collision test proves rollback. Default remains dry-run. Receipt binds archive hash, target catalog hash, and server identity.

Copied-backup apply against experiment catalog into fresh disposable SQLite files:

| Check | First apply | Second apply |
|---|---:|---:|
| Matched episodes | 3247 | 3247 |
| Conflicts / unmatched | 46 / 173 | 46 / 173 |
| Completed results imported | 1918 | 0 |
| Runtime corpus versions imported | 2124 | 0 |
| Corpus versions archived | 2182 | unchanged |
| Debug records imported / archived | 4 / 25 | 0 / 0 new |
| Repeated receipt | false | true |
| Integrity / foreign-key violations | ok / 0 | ok / 0 |

Migration digest `5de72cd1f0e7a306e8f2708463dcd7237503dde1300b242a95654df6ea73b94c`; archive SHA-256 unchanged from above. Imported results start with `applicable=0`. `/analysis` fetches stable source bytes before activation; different hash invalidates segments and queues reanalysis. Incomplete/failed legacy analyses remain archived, never promoted to `no_difference`. No stable import, public routing, or cutover performed.
