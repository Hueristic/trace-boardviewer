# Library database

`src/library-service/db/index.ts` exports `LibraryDb`, the utility-process database implementation of [schema v1](LIBRARY_SCHEMA.md). It imports `node:sqlite` and must stay out of renderer bundles. The store adds no application entry point or UI.

Open with `LibraryDb.open({ path: libraryDbPath(userData), decisionsPath })`. Obtain `userData` from the existing application profile configuration so portable mode and `--user-data-dir` isolate all three Library files. Main keeps the authoritative root list; send it to `syncRoots` after opening, finish `report.pendingRemovals`, and replay decisions after rescanning and regrouping.

## Scanner and indexer calls

- `beginScan`, `upsertFiles`, `linkContent`, `confirmHash`, `setSniff` and `setNameIdentifiers` record enumeration and identity. Public IDs are opaque random identifiers; integer row IDs stay internal. Quick-key matches alone never deduplicate simultaneous files. `resolveMoves` follows the one-to-one size/quick-key move policy; conflicting confirmed hashes block a move.
- `beginAttempt` commits before dispatch. `listPending`, `setStages`, `stageVersion` and `bumpStageVersion` maintain versioned stage work. Reader success resets the attempt counter. The scanner handles cancelled jobs and validates result correlation and summaries through the shared validators before calling `commitSummary`.
- `commitSummary` replaces derived summary outputs and stage state atomically. Refs, MinHash, component/passive summaries, page hashes and posting pages use the compact encodings in `codec.ts`. Decoding uses capped inflation. Full document bytes, thumbnails and passive-per-reference postings are never stored.

- `markMissing` runs only after a complete successful walk of an online root. Missing rows stay for 30 days. `purgeMissing`, `removeMissingNow`, `removeRoot` and `collectGarbage` remove derived rows and explicitly clean the contentless FTS tables. An interrupted root removal stays resumable.
- `putGroup`, `putRevisions`, `putDuplicateSet` and `putSuggestions` store grouping results. `applyDecisions` returns grouping constraints and materializes hide/role overrides. Persist durable targets returned by `resolveDecisionTargets`, and use `retargetDecisions` after an identity-confirmed move.

Search postings are capped at 96 per content, retaining the most reliable tiers first and marking `truncated: ['terms']` when entries are dropped. Component/passive and reference summaries retain their independently bounded data. Lower-ranked terms beyond the posting budget are unavailable to library-wide search; opening the original file still supplies its complete workspace model.

Bulk file writes commit at most 500 units at a time. A stage output is one indivisible unit. `transaction` joins nested operations and rejects a bulk file batch that exceeds its bound; callers should split bulk work outside an explicit transaction. Group/duplicate replacement is one logical relation update. Operations are synchronous; main enforces the bounded shutdown deadline around the utility process. `close` commits, sets the clean flag, checkpoints and closes; an interrupted shutdown is recovered through WAL.

## Query and consent policy

`query` supports every field, mode and sort in `query.ts`, AND terms, facets and paging of 1–200 rows. SQL values are bound; FTS phrases are escaped. Names use a contentless trigram index. One/two-character names use a literal fallback capped at 5,000 matching rows. Bare terms also search allowed page text; no document text or snippets are returned. Open originals on demand for previews.

Paging compares the full sort key and full label, then the stable ID. Opaque cursors are bound to the request, connection and index epoch. The connection retains at most 2,048 cursors; an expired cursor must restart paging. Full-text hit sets are capped at 50,000 rows per term, and at most eight parsed query terms are evaluated. Details cap files/members at 2,000 and summaries at 200 per kind; these caps do not promise complete large-group transport. The existing detail contract has no continuation field.

Full text is off by default per root. The store writes page text only while an associated root enables it, addresses pages through integer SQL arithmetic, filters searches by consent and requested roots, and purges text when the last enabled file/root disappears or changes. Quick integrity checks repair interrupted consent cleanup on reopening.

## Main-owned settings and corrections

Import `LibraryProfileStore` directly from `src/library-service/db/settings.ts` in main. Inject the existing `electron/store.cjs` `createJsonStore` configured with the profile directory, `trusted: true` and `maxBytes: 64 * 1024 * 1024`. This module does not import SQLite. It uses the existing queue, atomic rename/retry and shutdown drain.

`loadSettings`/`saveSettings` persist `{ version: 1, settings, roots }` in `library-settings.json`. `loadDecisions`/`appendDecision` persist `{ version: 1, decisions }` in `library-decisions.json`. Settings and registered roots use the shared validators; group decisions require durable member targets. Unsupported or invalid persisted shapes are refused before an update overwrites them. Concurrent appends do not lose accepted decisions.

Stop the utility process before deleting the database. `deleteIndex` removes only the database's named files and retains settings/corrections. Call main's `forgetData` only for explicit choices to forget roots or corrections; defaults preserve both. Include `beginShutdown` in the application's existing shutdown drain.

## Recovery and size

Migrations are forward-only, transactional and retain one pre-migration database copy. Newer schemas are probed read-only and refused. A failed migration or broken integrity check rebuilds the derived database, retaining at most one damaged copy. Roots and original files are never restored from the database: main resends roots, the scanner rescans originals, grouping runs, and decisions are replayed from their separate JSON.

`checkIntegrity` checks SQLite and FTS ownership; the full check adds foreign-key and FTS consistency checks. `ensureHealthy` repairs FTS drift and consent leftovers in place; other failures rebuild. `size` includes database, WAL and SHM, reports free pages and logical table sizes when `dbstat` is available, and extrapolates metadata bytes per loose file to the decimal 1 GB / 100,000-file budget. Archive members count against the containing files' footprint. Opt-in page text is reported separately when per-table accounting is available. Without `dbstat`, the total is conservatively charged to metadata.

The budget test creates 2,000 loose files plus 400 archive members with board/document/image summaries, shared parts, duplicates, identifiers, stages, groups and name FTS. It checkpoints and compacts before measuring, then requires the 100,000-file projection to stay below 1 GB. This is a synthetic extrapolation; the complete 100,000-file benchmark and operating-system runtime checks remain integration work.
