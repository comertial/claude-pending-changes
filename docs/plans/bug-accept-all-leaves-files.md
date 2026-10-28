# Plan: Accept all and folder ✓ can leave files behind

**Status:** Approved
**Spec:** [`bug-accept-all-leaves-files.md`](../specs/bug-accept-all-leaves-files.md)

---

### Regression test first

The test kit can't pause the refresh partway through its loop, so the harness gets a way to hold one file's read, like the existing `hold(sub)` does for `git <sub>` (`hooks/pending-changes.test.ts:335`):

- In `host()`, add `readHolds: Map<string, { promise: Promise<void>; reached: () => void }>` beside `holds` (`hooks/pending-changes.test.ts:218`).
- Make the `fs.read` handler (`hooks/pending-changes.test.ts:229`) async. When a hold is set for `norm(e.path)`:
  - It takes the file's text first, then signals `reached()` and awaits the hold, then returns that text.
  - So the read's answer is the content from before the hold, as if it were still in flight when ✓ or ✗ ran.
  - Failures (`fsFails`) and the `reads` record behave exactly as now. Without a hold, nothing changes.
- Return `holdRead(path)`. It returns `{ reached, release }`:
  - `reached` is a promise that resolves when the handler gets to the hold.
  - `release()` deletes the hold and resolves it.

Regression test, `both(…)` (git work tree and outside git):

> **accept all during a refresh clears every file, and they stay cleared**
> 1. Claude edits `src/a.txt`, `src/b.txt` and `src/c.txt`. Mount the pane.
> 2. `holdRead('/repo/src/b.txt')`, then start `clock.advance(2000)` without awaiting it. The tick copies the list, settles `a.txt`, and stops on `b.txt`. Await `reached`, not a timer, so the press can't land before the tick has copied the list.
> 3. Press `accept-all`, then release the read and await the tick.
> 4. Expect the pane to be empty. Run another `clock.advance(2000)` and expect it to be empty still. Expect the next prompt's context to be empty.

Before the fix, step 4's first check fails (`b.txt` and `c.txt` are listed again), as the probe showed. Run it against the unfixed code and record the failure in the implementation notes.

Cause A's regression test, `both(…)`, needs no hold:

> **accept all clears five files in one press, with no refresh running**
> Claude edits `src/a.txt` to `src/e.txt`. Mount the pane, press `accept-all`, and let pending work run with `clock.advance(0)`. Expect the pane to be empty, and still empty after `clock.advance(2000)`.

Before the fix it fails in a git work tree (a row stays listed) and passes outside git, where there is no flush.

### Changes

**Cause A** (found during implementation; the spec is amended):

- `accept` (`hooks/register.tsx:1392`) and `reject` (`hooks/register.tsx:1404`): with persistence on, call `recordGone` **before** `forget`. `reject` keeps restoring the file first, so a failed restore still records nothing. The note and `flush` stay where they are.
- `applyMerged` (`hooks/register.tsx:1111`): in the `changes` loop (which now keeps its `gitKey`), the `update` callback returns `all` unchanged when this session's own shard entry for that key is a resolve with `at >= m.at`. The check runs inside the callback, so it sees the shard as it is when the list is written.

Together: when a row is missing from the list because of ✓/✗, its resolve is already in `rt.shard`, and `applyMerged` sees it no matter when its merge was read. A load after `/clear` or `--resume` is unaffected: there the own record is live, not a resolve.

**Cause B:** `hooks/register.tsx`, in `settle` (`hooks/register.tsx:216`): inside the `update` callback, right after `const prev = all[key]`, add:

```ts
// The refresh read a copy of the list: an entry resolved since is not brought back.
if (from === 'observed' && !prev) return all
```

This covers both branches:
- **Add-back branch:** this is the bug.
- **Drop branch:** it already deleted nothing, but returning `all` avoids a needless write.

With `dropped` and `written` both left undefined, the code after the update records nothing, `noteResolvedWhileOff` isn't called, and `pollOnce` (`hooks/register.tsx:1673`) skips its note. That is AC4.

What's left unchanged, and why:
- **Claude's settles** (`from: 'claude'`, `hooks/register.tsx:1897`, `1909`, `2116`) still add new entries.
- **`peer` settles:** none exist today.
- **The refresh's emptied-new-file path** (`hooks/register.tsx:1667`) calls `reject`, which already returns early for a key that is gone (`hooks/register.tsx:1404`).

Nothing else changes. No lock between `act` and the background tasks; see the spec's Decisions.

### Tests

New tests in `hooks/pending-changes.test.ts`, placed after "accept all keeps the changes, clears the list and tells Claude nothing" (`hooks/pending-changes.test.ts:456`). All use `both(…)`; the refresh ones await `reached` before pressing.

| AC | Test |
| --- | --- |
| 5 | Cause A's regression test above. |
| 1, 4 | Cause B's regression test above. |
| 2 | **folder ✓ during a refresh clears that folder for good and leaves the rest.** Claude edits `src/a.txt`, `src/b.txt`, `src/c.txt` and `top.txt`. Hold `src/b.txt`, start the tick, press `accept-dir-${folderId('src')}`, release and await. Then no `src/` row is listed and `top.txt` still is. After one more tick, the same holds. |
| 3, 4 | **reject all during a refresh restores every file and tells Claude once per file.** Same setup as the regression test, pressing `reject-all`. Right after the tick, the pane is empty and `src/a.txt` to `src/c.txt` hold their originals. After one more tick, it's still empty, and the next prompt's context has exactly three "rejected your changes" notes and no "reverted" or "modified" note. Before the fix it fails: `b.txt` is listed again after the press, and a revert note follows. |
| 6 | The existing suite, unchanged. |

No existing test changes.

### SPEC merge

- **[Settling and the 2-second refresh](../SPEC.md#settling-and-the-2-second-refresh):** in the paragraph on `settle`'s three sources, add after "**observed** (the refresh, a load, a prompt: keeps the owner and records only a drop)": "An observed settle only touches an entry that is still listed: one accepted or rejected while the refresh was reading its file isn't brought back." The SPEC was silent on this.
- **[Accept and reject](../SPEC.md#accept-and-reject), "With persistence":** "A resolve records a tombstone (…)" becomes "A resolve records a tombstone, before its row is dropped (…)".
- **[Persistence](../SPEC.md#persistence), "Merging, per path":** add at the end: "A record isn't applied over a resolve this session recorded at or after it, so a sync read before a ✓ or ✗ can't bring its row back."
- **[Tests](../SPEC.md#tests), the harness description (`docs/SPEC.md:392`):** "paths or listings that can be made to fail" becomes "paths or listings that can be made to fail, and reads that can be held".
- **Tests list, "Accept and reject":** add "Accept all clears several files in one press in a git repo; Accept all, folder ✓ and Reject all pressed while a refresh is reading the files clear every row for good; reject tells Claude once per file, with no revert note."
- **[Limitations](../SPEC.md#limitations), "Untestable timing" (`docs/SPEC.md:147`):** unchanged. It's about the refresh during a tool call, which `holdRead` doesn't reach (the tick returns early while `toolsInFlight > 0`).
- **Design decisions:** none. This is a bug fix, not a lasting rule.

### README check

None. The README's Accept all row ("The same for every file in the list.") already describes the fixed behaviour. No Limitations or Troubleshooting entry mentions pressing twice.

### CHANGELOG / ROADMAP

- `CHANGELOG.md` `[Unreleased]`, new `### Fixed`: "Accept all and ✓ on a folder no longer leave some files behind, which happened in git repos with three or more files and whenever the 2-second refresh was running; and Reject all and ✗ on a folder no longer bring a row back for a moment and then tell Claude it was reverted ([#7](https://github.com/comertial/claude-pending-changes/issues/7))."
- `ROADMAP.md`: nothing (bug).
- Delete this plan and its spec in the ship commit.

### Commits

Each one needs approval.

1. `docs(specs): plan the fix for accept all leaving files behind`: this plan, plus the spec's and plan's status set to `Approved` after review.
2. `docs(specs): add the sync cause to accept-all-leaves-files`: the spec and plan amended for cause A.
3. `fix(pane): keep accepted and rejected files from coming back`: the `settle` guard, the resolve order in `accept` and `reject`, the `applyMerged` check, `holdRead` in the harness, and the four tests. Body: "Fixes #7".
4. `docs(spec): merge accept-all-leaves-files into the SPEC`: the SPEC merge, the CHANGELOG entry, and deleting the spec and plan.

### Verification

- Against the unfixed code: the three refresh tests fail in both modes, and the five-file test fails in a git work tree. With the fix, all pass.
- `claude plugin validate .` and `claude plugin test .`: the whole suite passes.
- Manual check: in a git repo, have Claude edit about 10 files, then press Accept all a few times right after a tick (counts visibly refresh). One press clears the list every time.
