# Bug: Accept all and folder ✓ can leave files behind when a refresh is running

**Status:** Draft
**Issue:** [#7](https://github.com/comertial/claude-pending-changes/issues/7)
**Plan:** [`../plans/bug-accept-all-leaves-files.md`](../plans/) (written once this spec is approved)
**Found in:** v1.0.0

---

### Symptom
Pressing **Accept all**, or ✓ on a folder, sometimes leaves some of the files in the list. Pressing it again clears them.

### Reproduction
This depends on timing: the press has to land while the 2-second refresh is partway through the list. It happens in a git work tree and outside git, on any OS.

1. Have Claude edit several files, e.g. `src/a.txt` to `src/e.txt`.
2. Press **Accept all**, or ✓ on `src/`, while a refresh tick is reading the files. More files, a slower disk and the tick's git work all widen the window.
3. Some of the files come back in the pane, and stay after the next tick. Pressing the button again clears them.

Confirmed with probe tests in a scratch copy (see [#7](https://github.com/comertial/claude-pending-changes/issues/7)):
- **Held read:** the refresh's read of `src/b.txt` is held, the button is pressed, then the read is released. `b.txt` and `c.txt` are listed again. This fails in both modes, for Accept all and for folder ✓.
- **No forced timing:** in a git work tree with five edited files, pressing Accept all as a tick starts left `src/c.txt` listed in all 12 timings tried.
- **Reject is unaffected:** the same probes for Reject all (24 timings plus the held read) always clear every row, restore every file and send one "rejected" note per file, with no stray revert notes.

### Expected
[The pane](../SPEC.md#the-pane):
- "**✓ / ✗ on a folder** | Accepts or rejects every file under it, including subfolders, and nothing outside it."
- "**Accept all / Reject all** | The same for every file in the list."

[Accept and reject](../SPEC.md#accept-and-reject): "**Accept:** drop the entry and delete its temp review copy."

The SPEC doesn't say what the refresh does with an entry that was resolved while the tick was running. [Settling and the 2-second refresh](../SPEC.md#settling-and-the-2-second-refresh) describes the loop as "for each tracked file", which implies a file that is no longer tracked isn't touched. The fix states this explicitly.

### Actual
Every row that the tick had in its copy of the list, but hadn't yet settled when ✓ removed it, is added back. It stays listed with its counts, and nothing is said to Claude. Its tombstone is already recorded, so with persistence on, the row exists only in this session's memory.

### Root cause
The refresh writes back entries it has an outdated copy of:

- `hooks/register.tsx:1660`: `pollOnce` reads the list once, then awaits a file read for each entry in turn.
- `hooks/register.tsx:1672`: for each one it calls `settle(…, entry, current, …, { from: 'observed' })`, with the copied entry as the base.
- `hooks/register.tsx:216`–`280`: inside its `update`, `settle` doesn't check that the key is still listed. When `prev` is missing and `current !== base.original`, it builds a new entry from the base and sets `next[key] = written`.

`act` (`hooks/register.tsx:1433`) accepts rows one at a time, with awaits between them (`ensureLoaded`, `syncPeers`, and in each `accept` the `forget`, `cleanupReview` and `flush`). Nothing keeps it from running during a tick. Any row that the tick copied but hasn't settled yet when ✓ removes it comes back.

Reject escapes because ✗ writes the original to disk before it removes the row. A tick that reads the file after that sees `current === original` and takes the drop branch, which deletes nothing that's still there. A tick that read the file before the write still sees `prev`, because `forget` comes after the write.

`settle` has one observed caller: the refresh. The other callers are Claude's own changes (`hooks/register.tsx:1897`, `1909`, `2116`), which must still be able to add new entries.

### Affected behaviour

| SPEC section | Changes / must not change | Guarded by (existing tests) |
| --- | --- | --- |
| [Settling and the 2-second refresh](../SPEC.md#settling-and-the-2-second-refresh): an observed settle of an entry that is no longer listed | **Changes** (newly stated): it does nothing. It doesn't add the entry back, queue a note or record anything. | None (new regression test) |
| [The pane](../SPEC.md#the-pane): Accept all, folder ✓ | Must not change (now holds during a refresh too) | "accept all keeps the changes, clears the list and tells Claude nothing"; "accepting a folder accepts only the files under it" |
| [Settling and the 2-second refresh](../SPEC.md#settling-and-the-2-second-refresh): the refresh updates counts, drops files back at their original, reports hand edits and reverts, and rejects emptied new files | Must not change | "a review opens the original left and the source right; saves there update the counts"; "reverting every block in the review drops the file and its temp copy"; "emptying a new file in the diff rejects it…"; the hand-edit and revert note tests |
| [Settling and the 2-second refresh](../SPEC.md#settling-and-the-2-second-refresh): Claude's settles add new entries | Must not change | Every listing test, e.g. "an edit is listed with its counts…" |
| [Accept and reject](../SPEC.md#accept-and-reject): Reject all, folder ✗ | Must not change | "reject all restores originals, deletes created files and tells Claude"; "rejecting a folder rejects every file under it…" |
| [Across sessions](../SPEC.md#across-sessions): a peer's record is applied, and a busy peer only updates counts | Must not change | The persistence and peer tests |

### Acceptance criteria
1. Accept all pressed while a refresh tick is partway through the list clears every row, and the rows stay gone after the next tick. Claude is told nothing. A regression test proves it in both modes and fails before the fix.
2. The same holds for ✓ on a folder: every file under it is cleared and stays cleared, and files outside it are untouched.
3. Reject all pressed while a refresh tick is partway through the list still clears every row, restores every file and sends exactly one "rejected" note per file, with no revert notes. A test guards this in both modes.
4. A tick that finishes reading a file after it was accepted doesn't queue a note to Claude for it or record anything for it.
5. For entries that are still listed, the refresh behaves as before: counts update, a file back at its original drops off with its note, and an emptied new file is rejected. The existing suite passes unchanged.

### Decisions
- The fix is that an observed settle never adds back an entry that is no longer listed. Making the refresh and ✓/✗ take turns (a lock) would also work, but it adds waiting to every press and doesn't cover any other path that removes an entry during a tick.
- Reject gets a guard test even though it isn't affected, so a later change to the order of `reject`'s steps (for example forgetting the row before restoring the file) can't bring the race back unnoticed.
