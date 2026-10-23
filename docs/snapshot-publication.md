# Publish already-collected, sanitized snapshots

This is a publication-only path. Collection remains in the authorized execution
environment (including the dot cloud environment), using the original collector, configuration, state and accounting.
`publish-snapshot.yml` runs only on explicit dispatch, on standard
`ubuntu-latest` runners in this public repository. It does not collect, restore
caches, persist checkpoints, or upload source/Git/SQLite/scan records. It uses
only the workflow's existing `github.token`; no new credential is needed.

## Immutable contract

The dispatch selects three lowercase 40-character Git object IDs:

- `snapshot_commit`: a commit in **this repository** whose root tree binds both
  `public-stats.json` and `private-metrics.json` as normal files.
- `public_stats_blob_sha`: the exact blob at that commit's `public-stats.json`.
- `private_metrics_blob_sha`: the exact blob at that commit's
  `private-metrics.json`, also still the current
  `tally-state:private-metrics.json` blob.

The snapshot commit can be a new commit on `tally-state`, retaining every
existing unrelated tree entry. The publication workflow reads only those two
blobs, not the branch's checkpoint or other files. Hashes are recalculated from
the actual Git blob bytes. The current private path is checked when staging,
after building, and immediately before deployment. A superseded selection
fails; dispatch again only after selecting and validating the intended current
pair. Do not rewrite `tally-state` or start another external durable save while
an authorized publication is deploying.

`scripts/snapshot-policy.json` pins the approved config bytes, dataset epoch,
rules version, lineage version and collector version. A configuration change
requires explicit policy review and a compatible fresh collection; this path
never relabels older statistics. Public and private metrics are validated with
exact schemas. Private validation reuses the original
`validateCompletePrivateMetrics` and the original external-blob verifier.

Source completeness counts are **not display-row counts**: configured lineage
members are checked against the original config and represented source keys
must be unique across both inputs. The original full-scope private proof can
cover the joint source set; independently collected inputs can carry separate
proofs. A mixed-visibility lineage can include public source members inside the
private aggregate. Because those sanitized members do not carry per-member
visibility, the permitted public overlap is bounded by the sum of each private
group's member count minus one; a private group must contain a private member.
Source identity/visibility still comes from the original verified collection,
not an invented per-member classification. Group membership is not expanded
for statistics. Missing
members, failed/incomplete collections, duplicate sources and incompatible
proofs are rejected. No fixed repository count is encoded.

## Operator procedure (each production round)

1. Finish the authorized original collection and retain its complete local
   output. Verify the original rules/epoch/lineage and completeness. Never
   upload the raw database, inventory, Git objects, source files or run logs.
2. Project the **original public exporter JSON** locally:

   ```sh
   node scripts/publish-snapshot.mjs project /protected/public-export.json /tmp/public-stats.json
   ```

   This keeps every original history `timestamp`, `metrics` and `languages`
   entry in its original order. It removes runs, head and commit metadata;
   public URLs are generated only from validated names. The public update value
   is preserved exactly through the original `repositoryUpdatedAt` function
   (no same-day truncation); private update dates remain day-only. It does not downsample,
   recollect, recompute counts or change UI/model code.
3. Save the original sanitized private candidate through the existing
   `scripts/state.mjs save-private` flow and its existing authorized transport.
   Preserve its original anti-rollback, scope and completeness checks. Do not
   replace this with a direct contents write. Use the **returned actual durable
   blob SHA and its actual bytes**, not the candidate's guessed SHA. An
   unchanged data fingerprint may retain the previous durable blob and time.
4. Before publishing either input, validate the selected actual pair locally:

   ```sh
   node --input-type=module - /tmp/public-stats.json /protected/actual-durable-private-metrics.json <<'JS'
   import {readFile} from 'node:fs/promises';
   import {loadSnapshotPolicy, validateSnapshotPair} from './scripts/publish-snapshot.mjs';
   const [publicPath, privatePath] = process.argv.slice(2);
   const read = async path => JSON.parse(await readFile(path, 'utf8'));
   validateSnapshotPair(await read(publicPath), await read(privatePath), await loadSnapshotPolicy());
   console.log('Complete sanitized pair verified.');
   JS
   git hash-object --no-filters /tmp/public-stats.json
   git hash-object --no-filters /protected/actual-durable-private-metrics.json
   ```

5. Through the existing authorized repository transport, add only
   `/tmp/public-stats.json` as root `public-stats.json` on `tally-state` after
   step 3, preserving its existing private blob, checkpoint and other entries.
   Record and independently reread the resulting commit and both blob IDs.
   Do not add the local original public export (it contains run/commit detail).
6. For the first installation, merge the narrowly scoped implementation PR to
   `dev` with `[skip ci]` in that merge commit message. This skips only that
   push-triggered collection; it does not disable or modify the schedule.
   Explicitly dispatch **Publish verified snapshots only** on `dev` with the
   three IDs above. Subsequent rounds dispatch the same workflow with their
   newly verified inputs; no implementation change is necessary.
7. Observe the selected run until build and deployment both succeed. Read back
   the live `data/stats.json` and confirm the selected private blob provenance,
   complete proofs, repository identities, latest totals, daily/weekly/monthly
   net changes and historical-area ordering against the selected local model.
   Do not describe a queued or merely built artifact as a successful deployment.

## What reaches Pages

Staging removes all old `web/data` inputs, including rebuilt/retained fallbacks,
and writes only the selected public and private JSON. The unchanged
`build-site.mjs` runs with `POLY_TALLY_REQUIRE_PRIVATE=true` and the actual
`POLY_TALLY_EXTERNAL_PRIVATE_BLOB_SHA`. It performs the existing private merge
and display-window projection; the final artifact contains only the unchanged
web page and bundled assets plus **one** `data/stats.json`, favicon and
`.nojekyll`. The allowlist rejects source maps, SQLite, manifests, source files,
Git directories, extra data and symlinks. Pages artifact retention is one day.

## Existing schedule remains intact

`pages.yml` still runs at `0 7,15,23 * * *` and retains all its existing
collection/persistence logic. Its only edit is `queue: max`. Both workflows use
`poly-tally-publish`, `cancel-in-progress: false`, `queue: max` so pending
publications queue rather than replacing each other. The existing scheduled
workflow continues to use the durable sanitized private metrics; it **does
not** thereby perform a fresh private scan or prove a current private attempt.

## Verification

Run the repository's typecheck, Vitest, Python, legacy Node and Chromium suites.
`scripts/publish-snapshot.test.mjs` additionally tests unsafe/nested fields,
unknown languages and text, unsafe numbers, failed/incomplete/old snapshots,
missing lineage/scope, immutable commit/blob mismatch, durable-selection
changes, policy changes, fallback removal, original model equivalence and the
real production React build's minimal artifact. Failures never log input
contents. Actual production input equivalence must also be checked for each
round; synthetic fixtures are not a substitute for that acceptance check.
