# Library device database: known limits and accepted risks

The device database is hidden in this release (`DEVICE_DATABASE_ENABLED=false`). Nothing here is reachable from the interface. This page lists what the hidden code does not do, or does only within stated limits, so that enabling it later is a decision made with these in view.

## Accepted risks

- **Directory listing window (TOCTOU, TB-038).** The walker checks every folder's real location before and after listing it, and checks every entry again after the listing: a link or a reparse point is resolved, and one whose real place is outside the chosen root is refused and recorded with the code `ADAPTER_ESCAPES_ROOT`. A cloud placeholder that is online only is never resolved. A residual window remains: a swap made and undone between the ancestor check and the listing, or between the listing and the entry check, is not seen, and names from outside the root could then be listed in that window. Accepted because the root is chosen by the user, only names, kinds and sizes are returned, and no file content is ever read or written. Closing the window fully needs a handle-based listing that the runtime does not provide; a native helper is a later item. (`electron/library/directory-adapter.cjs`)
- **Children of an unreadable folder.** A folder whose listing fails is recorded as unreadable with its code, and its siblings are walked. Its children cannot be listed, so they are unknown and the map is incomplete. (`src/lib/library/devices/folder-map.ts`)

## Behaviour limits

- **Reparse points.** Links and junctions are not followed. Other Windows reparse points (dedup files, app execution links, unknown tags, volume mounts and placeholder folders) are recorded as skipped and not read; the map is incomplete. A cloud placeholder file is listed by name and size and marked online only; its content is never read. Whether a file is online only is read from its metadata (no allocated blocks, at least one cluster), because Node cannot read the reparse tag.
- **Board presence.** A board is confirmed from the names of its boardview files. Until the board database is bound, presence is not a measurement of the board's contents.
- **Corrections of a removed root.** The corrections are kept in the corrections file. The next load shows them with a fresh id, and an edit through that id is stored under the removed root's path. The correction applies again when the folder is added back.
- **Undo.** Undo restores the whole corrections document as it was before the last save, so a correction written by another writer after that point is lost too. A snapshot is dropped only when the store answers that the file is unknown or the request invalid. Any other refusal keeps the snapshot, so the same undo can succeed on a later try.
- **File ids** are issued per process. After a restart the renderer must list again.
- **Darwin.** A legacy root that is removed and added again gets a new id, and its earlier corrections are not inherited.
- **Search postings** are capped per content (96). Lower-ranked postings are dropped first and the summary says so.

## Not yet built

- The board database is not bound to the scan: anchors come from file names, and the board list reads memory.
- Storage is not durable across restarts for the index.
- The device view is not mounted in the interface, and the quarantine signal and the count of entries needing manual work are not shown.
- The root list written by the first hidden release is not guaranteed to load in an earlier version: downgrading to 1.3.1 drops roots created on 1.3.2. (release decision)
- Recall of the seed grouping is 92.46% against a 95% target.
- The native runtime on macOS and Linux and the 100,000-file memory budget are not measured.
