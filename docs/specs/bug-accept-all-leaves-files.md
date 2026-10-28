# Bug: Accept all and folder ✓ can leave files behind

**Status:** Approved
**Issue:** [#7](https://github.com/comertial/claude-pending-changes/issues/7)
**Plan:** [`../plans/bug-accept-all-leaves-files.md`](../plans/bug-accept-all-leaves-files.md)
**Found in:** v1.0.0

---

### Symptom
Pressing **Accept all**, or ✓ on a folder, sometimes leaves some of the files in the list. Pressing it again clears them. In a git repo this happens with almost any press on three or more files.

**Reject all** and ✗ on a folder can bring a row back for one tick. Claude then gets a stray "you reverted all your changes" note for it, on top of the "rejected" note.

### Reproduction
There are two ways in.

**A. In a git repo, no refresh needed** (persistence on, the default; any OS):

1. Have Claude edit three or more files, e.g. `src/a.txt` to `src/e.txt`.
2. Press **Accept all**, or ✓ on `src/`, once.
3. One or two files stay listed. Pressing again clears them.

A probe with one press and no refresh left 1 of 3, 1 of 5 and 2 of 8 files listed in a git work tree. Outside git, nothing stayed.

**B. During a refresh** (in a git work tree and outside git): the press has to land while the 2-second refresh is partway through the list.

1. Have Claude edit several files, e.g. `src/a.txt` to `src/e.txt`.
2. Press **Accept all**, or ✓ on `src/`, while a refresh tick is reading the files. More files, a slower disk and the tick's git work all widen the window.
3. Some of the files come back in the pane, and stay after the next tick. Pressing the button again clears them.

Confirmed with probe tests in a scratch copy (see [#7](https://github.com/comertial/claude-pending-changes/issues/7)):
- **Held read:** the refresh's read of `src/b.txt` is held, the button is pressed, then the read is released. `b.txt` and `c.txt` are listed again. This fails in both modes, for Accept all and for folder ✓.
- **No forced timing:** in a git work tree with five edited files, pressing Accept all as a tick starts left `src/c.txt` listed in all 12 timings tried.
- **Reject, with the read answered before ✗ writes:** the refresh's read of `src/b.txt` gets Claude's content, but its answer is held until after Reject all. A row is listed again after the press, and it drops off at the next tick. Claude is then told about one revert on top of the five "rejected" notes. A first probe whose held read returned the content as it was *after* the press didn't show this. That's why [#7](https://github.com/comertial/claude-pending-changes/issues/7) first said reject was unaffected, and a comment there corrects it.

### Expected
[The pane](../SPEC.md#the-pane):
- "**✓ / ✗ on a folder** | Accepts or rejects every file under it, including subfolders, and nothing outside it."
- "**Accept all / Reject all** | The same for every file in the list."

[Accept and reject](../SPEC.md#accept-and-reject): "**Accept:** drop the entry and delete its temp review copy."

The SPEC doesn't say what the refresh does with an entry that was resolved while the tick was running. [Settling and the 2-second refresh](../SPEC.md#settling-and-the-2-second-refresh) describes the loop as "for each tracked file", which implies a file that is no longer tracked isn't touched. The fix states this explicitly.

### Actual
- **Accept, cause A:** a row re-added by the sync stays listed with its counts, through every later tick. Its resolve is already in the shard, so the row exists only in this session's memory, and nothing is said to Claude.
- **Accept, cause B:** every row that the tick had in its copy of the list, but hadn't yet settled when ✓ removed it, is added back. It stays listed with its counts, and nothing is said to Claude. Its tombstone is already recorded, so with persistence on, the row exists only in this session's memory.
- **Reject:** a row whose file the tick read before ✗ restored it, and that the tick settles after ✗ removed it, is added back with Claude's counts. At the next tick the file is at its original, so the row drops off as a revert. Claude gets "The user reverted all your changes to `X`" on top of "The user rejected your changes to `X`". With persistence on, a second resolve is recorded with `goneReason` `reverted`.

### Root cause
Two background tasks write back entries from a copy taken before ✓ or ✗ removed them. Line numbers are as of `80bf640`, before the fix.

**A. The flush's sync re-adds this session's own resolved entries** (git repo only):

- Each `accept` ends with `void flush($)`. The flush runs `updateTree`, which calls `syncPeers` (`hooks/register.tsx:786`) while `act` goes on to the next rows.
- `syncPeers` computes `rt.merged` from the shards, then `applyMerged` reads the list (`hooks/register.tsx:1000`), with awaits in between.
- `accept` removed the row (`forget`) before it recorded the resolve (`recordGone`), with awaits in between too (`hooks/register.tsx:1396`–`1399`).
- So a merge read before `recordGone` still has the row live, while the list read after `forget` lacks it. `applyMerged` treats that as a record it hasn't applied yet and adds the row back (`hooks/register.tsx:1111`), with no check against the resolve now in this session's own shard.

Reject isn't hit by this path, because ✗ restores the file first and `applyMerged` skips a record whose file is back at its original (`hooks/register.tsx:1077`).

**B. The refresh writes back entries it has an outdated copy of:**

- `hooks/register.tsx:1660`: `pollOnce` reads the list once, then awaits a file read for each entry in turn.
- `hooks/register.tsx:1672`: for each one it calls `settle(…, entry, current, …, { from: 'observed' })`, with the copied entry as the base.
- `hooks/register.tsx:216`–`280`: inside its `update`, `settle` doesn't check that the key is still listed. When `prev` is missing and `current !== base.original`, it builds a new entry from the base and sets `next[key] = written`.

`act` (`hooks/register.tsx:1433`) accepts rows one at a time, with awaits between them (`ensureLoaded`, `syncPeers`, and in each `accept` the `forget`, `cleanupReview` and `flush`). Nothing keeps it from running during a tick. Any row that the tick copied but hasn't settled yet when ✓ removes it comes back.

Reject is narrower, because ✗ writes the original to disk before it removes the row. A tick that reads the file after the write sees `current === original` and takes the drop branch, which removes nothing. But a tick whose read came back before the write still has 3–4 round trips to make before its `update` (`ctx`, `session.id`, `nextAt`; `hooks/register.tsx:224`–`229`). ✗ needs only `fs.write` and `forget` (`hooks/register.tsx:1403`–`1414`), so the tick can land after `forget` and add the row back with Claude's content.

`settle` has one observed caller: the refresh. The other callers are Claude's own changes (`hooks/register.tsx:1897`, `1909`, `2116`), which must still be able to add new entries.

### Affected behaviour

| SPEC section | Changes / must not change | Guarded by (existing tests) |
| --- | --- | --- |
| [Settling and the 2-second refresh](../SPEC.md#settling-and-the-2-second-refresh): an observed settle of an entry that is no longer listed | **Changes** (newly stated): it does nothing. It doesn't add the entry back, queue a note or record anything. | None (new regression test) |
| [The pane](../SPEC.md#the-pane): Accept all, folder ✓ | Must not change (now holds during a refresh too) | "accept all keeps the changes, clears the list and tells Claude nothing"; "accepting a folder accepts only the files under it" |
| [Settling and the 2-second refresh](../SPEC.md#settling-and-the-2-second-refresh): the refresh updates counts, drops files back at their original, reports hand edits and reverts, and rejects emptied new files | Must not change | "a review opens the original left and the source right; saves there update the counts"; "reverting every block in the review drops the file and its temp copy"; "emptying a new file in the diff rejects it…"; the hand-edit and revert note tests |
| [Settling and the 2-second refresh](../SPEC.md#settling-and-the-2-second-refresh): Claude's settles add new entries | Must not change | Every listing test, e.g. "an edit is listed with its counts…" |
| [Accept and reject](../SPEC.md#accept-and-reject): Reject all, folder ✗ | Must not change (now holds during a refresh too: one "rejected" note per file and no revert note) | "reject all restores originals, deletes created files and tells Claude"; "rejecting a folder rejects every file under it…" |
| [Design decisions](../SPEC.md#design-decisions) 3, "Claude never drifts": no note about a change the user didn't make | Must not change (the stray revert note after a reject breaks it today) | The revert note tests |
| [Accept and reject](../SPEC.md#accept-and-reject): with persistence, ✓ and ✗ record their resolve | **Changes** (newly stated): the resolve is recorded before the row is dropped | None (new regression test) |
| [Across sessions](../SPEC.md#across-sessions): applying merged records never brings back a row this session resolved after that record | **Changes** (newly stated) | None (new regression test) |
| [Across sessions](../SPEC.md#across-sessions): a peer's record is applied, a busy peer only updates counts, and a load after `/clear` or `--resume` restores every pending file | Must not change | The persistence, peer and resume tests |

### Acceptance criteria
1. Accept all pressed while a refresh tick is partway through the list clears every row, and the rows stay gone after the next tick. Claude is told nothing. A regression test proves it in both modes and fails before the fix.
2. The same holds for ✓ on a folder: every file under it is cleared and stays cleared, and files outside it are untouched.
3. Reject all pressed while a refresh tick has read a file but not yet settled it clears every row, and the rows stay gone. It restores every file and sends exactly one "rejected" note per file, with no revert notes. A regression test proves it in both modes and fails before the fix.
4. A tick that finishes reading a file after it was accepted doesn't queue a note to Claude for it or record anything for it.
5. In a git repo, Accept all with five files clears every row in one press with no refresh running, and the rows stay gone after the next tick. A regression test proves it in both modes and fails before the fix in a git work tree.
6. For entries that are still listed, the refresh behaves as before: counts update, a file back at its original drops off with its note, and an emptied new file is rejected. The existing suite passes unchanged.

### Decisions
- **Cause A:** ✓ and ✗ record their resolve before dropping the row, and `applyMerged` doesn't add a row whose own-shard record is a resolve at or after the merged record. Reordering alone isn't enough, because the merge can still be read before the resolve. The check alone isn't either, because the row could be dropped before the resolve is recorded.
- **Cause B:** an observed settle never adds back an entry that is no longer listed. For both, making the background tasks and ✓/✗ take turns (a lock) would also work, but it adds waiting to every press and has to cover every task that writes the list.
- Cause A was found while implementing, after the plan was approved; the user approved amending the spec in chat. The issue and the slug name Accept all, because that's what was reported. The same fix covers reject, and the CHANGELOG entry names both.
