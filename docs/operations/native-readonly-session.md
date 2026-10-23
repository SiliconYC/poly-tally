# Native collection without exporting the read credential

`python -m poly_tally.native_session` reuses the original collector, database,
first-parent history engine, exclusion rules, lineage aggregation, and publication
schemas. It does not run source repository programs. It never obtains a token
from `git credential fill`, reads a secret file, or exports a token into an environment.

## Inputs

- A fresh (under 24 hours), fully paginated metadata inventory from the existing
  authorized discovery connection. Metadata calls are allowed; source/history
  acquisition uses native Git exclusively. Inventory fields: schemaVersion=1,
  complete=true, generatedAt (UTC ISO timestamp), owners, repositories. Each
  repository needs GitHub id, full_name, owner.login, clone_url, default_branch,
  private, archived, fork, size. Do not infer missing fork/privacy fields.
- Current `config.json`, unchanged. A metadata manifest is **not** a permanent
  allow-list: regenerate discovery each scheduled run to include new repositories.
- Private state/cache directories (0700, outside tracked worktrees), and an external
  read-only Git wrapper. Private logs, Git objects, inventory and SQLite never belong
  in this public repository. Preserve state/cache across runs.

## Wrapper contract

`python readonly_git.py ls-remote REPO` returns one JSON object with `repository`
(full owner/repo), `defaultBranch`, `head`. Success with no refs may return nulls;
missing HEAD in a nonempty ref advertisement is not an empty repository.
`fetch REPO` additionally returns `path` to a complete local bare Git object store.
Only GitHub HTTPS read operations are allowed. No shallow fetch, pushes, token
URLs, credential output capture, API authorization using this PAT, or source execution.
A changed default branch between metadata and Git discovery fails closed: refresh
inventory and rerun. Fetch races also fail without replacing the last valid history.

The engine calls the object factory only after its unchanged-HEAD fast path.
Thus unchanged repos perform one HEAD check but no fetch, history traversal or blob
parsing. Changed repos fetch into persistent Git mirrors and reuse original SQLite
history/parser facts. A missing object cache can require a complete Git download
on the next changed HEAD; preserving statistics alone does not restore Git objects.

## Run

```sh
python -m poly_tally.native_session \
  --config config.json --inventory /private/runtime/inventory.json \
  --state /private/runtime/state --cache /private/runtime/cache \
  --wrapper /private/tools/readonly_git.py \
  --report /private/runtime/run.json --export-dir /private/runtime/sanitized
```

For recovery, `--restore-public-checkpoint FILE` imports the validated public
checkpoint into SQLite without overriding private rows. Sanitized private daily
metrics cannot reconstruct private per-file inventory, commit history or parser facts.
Rebuild those via native Git rather than manufacturing a cache from displayed totals.

`--public-only` is useful for independent recovery, but cannot use `--export-dir`.
Only a complete unified batch creates sanitized checkpoint/public-stats/private-metrics
outputs. No GitHub write or Pages deployment is performed by this entrypoint; validate
with the existing publication validators, then publish with separate write authority.
A failed run leaves its report and old successful state, and produces no new exports.
Use a fresh output directory per batch to distinguish it from old successful output.

## Persistence boundary

Filesystem permissions prevent access by other ordinary users, not the same-user
Agent. A helper is a behavioral/transport boundary, not a cryptographic vault.
Cross-session, restart and environment-recreation retention must be observed, not
assumed. Keep public sanitized checkpoints in `tally-state`; never publicly back up
private Git objects, SQLite or secrets. If private originals are lost, retain the last
published batch unchanged while reconstructing with authorized native Git.
