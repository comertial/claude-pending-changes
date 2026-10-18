# Feature: Keep pending changes across sessions

**Status:** Approved
**Roadmap item:** Keep pending changes across sessions
**Issue:** none
**Plan:** [`../plans/feat-keep-across-sessions.md`](../plans/feat-keep-across-sessions.md)

---

### Context
Today the pending list lives in `$.state`, which is per session ([Limitations](../SPEC.md#limitations): "State is per session"). When a session ends, or after `/clear`, anything left unreviewed becomes plain files on disk. Its original is gone, so ✗ is no longer possible. Two sessions in one checkout each see only their own changes.

The `research-keep-across-sessions` research settled the design with experiments. Its full record, with every command to repeat them, is `docs/specs/research-keep-across-sessions.md` at commit `3f1aaeb` on this branch (`git show 3f1aaeb:docs/specs/research-keep-across-sessions.md`). In short:

- **Originals in git's object store.** `git hash-object -w` stores them compressed and deduplicated. UTF-8 text of any line ending or BOM round-trips byte-exact.
- **Pinned by one tree ref per worktree**, `refs/pending-changes/<worktree id>`: a tree (never a commit) listing every original the worktree's list uses.
  - `git gc` keeps everything it reaches. Rewriting the tree releases what it no longer lists, and git's own gc reclaims it.
  - It is updated with compare-and-swap, so two sessions can't drop each other's originals.
  - It doesn't show in `git log --all`, `git branch -a` or `git fsck`, and costs 2 git calls however many files.
  - `refs/worktree/*` was ruled out: gc from another worktree prunes what it pins and breaks the repo.
- **Ordinary pushes never carry it.** `git push`, `--all`, `--tags` and `git clone` don't copy the ref. `git push --mirror`, a `refs/*:refs/*` refspec and `git clone --mirror` do.
- **The list lives in per-session files in the worktree's git dir** (`<git-dir>/pending-changes/<session id>.json`), merged on read. Another session's writes are visible at the next 2 s tick, for a few ms per tick; the cost scales with sessions, not repo size.
- **Git calls cost ~77 ms each on Windows.** All git work is batched (`hash-object --stdin-paths`, one `mktree`, one `update-ref`) and runs after the tool result is returned.
- **Session ids:**
  - `/clear` switches the id without firing `session.start`, so the owner id must be read at every write;
  - `session.end` fires on `/clear` and `/exit`, and a crash is only visible as a stale heartbeat;
  - `--resume` keeps the id.
- **Testable:** `claude plugin test` covers settings through `options`, other sessions through the fake disk, `/clear` through a switchable `session.id`, and git through an extended fake `process.run`.
  - A fake `process.run` finds the git stdin at `e.init.stdin`, not `e.stdin`.
  - One engine is one session: another session is simulated by writing its shard into the fake disk with a new `mtimeMs`.
- **Claude Code has no file locks** for parallel sessions. Locks are a separate ROADMAP "Exploring" item; the owner recorded here is what they would build on.

Checks run while planning (scratch repo, git 2.45.2, Windows, build 2.1.302):
- **Writing into the git dir works from a real session.** `$.fs.write` creates, rewrites, lists and stats files in `.git/pending-changes/` and `.git/worktrees/<name>/pending-changes/`, creating the folder on demand, and `git status` stays clean. `$.fs.write` rewrites a file in place, so a reader can see a half-written file.
- **VS Code.** Its git extension runs `git status` on any change to a first-level entry of `.git`, watched non-recursively. Rewriting an existing file in `.git/pending-changes/` fires no such event. Creating or deleting a file there fires one for the `pending-changes` folder. Per-tick writes must therefore only rewrite files; creating and deleting them is rare (once per session, and at compaction).
- **`$.state` and module variables have opposite lifetimes.** After `/clear`, `$.state` is empty under the new id while module variables keep their values. A hot reload, which every `/config` change triggers, keeps `$.state` and resets module variables.
- **Other `--all` commands.** `git bundle create --all` includes the ref, and with it the originals. `git fast-export --all` skips it with a warning (`Unexpected object of type tree, skipping`), and `git filter-repo`, which is built on fast-export, is expected to warn the same way. `git rev-list --all --objects` lists the pinned blobs. `rev-list --all`, `log --all` and `describe --all` are unaffected.

### Goals
- A session started in a git worktree picks up every unreviewed change left by earlier or other sessions in that worktree, with its original, so ✓, ✗ and the diff view work as if the change were made in this session.
- Live sessions in one worktree share one list, in step within about one refresh.
- Every Claude whose change the user resolves is told, wherever that Claude is running.
- The first-original rule holds across sessions: no race between sessions can replace an original, or bring back a change the user resolved.
- Nothing persisted is committed, visible in the working tree, or pushed by ordinary git commands, and nothing piles up on disk.
- A failure in persistence never breaks today's single-session behaviour.
- Settings that are easy to find and to extend: two `userConfig` fields now, and a rule for later ones.

### Non-goals
- Persistence outside git. Non-git folders keep today's per-session behaviour.
- Cross-session file locks or blocking edits (separate ROADMAP item).
- Byte-exact handling of non-UTF-8 files ([#3](https://github.com/comertial/claude-pending-changes/issues/3); persistence keeps today's behaviour).
- Persisting files too large to read back through git. They stay session-only (see Limits).
- Protecting against `push --mirror`, `bundle create --all` and similar. Documented, not prevented.

### Affected behaviour

| SPEC section | Changes / must not change | Guarded by (existing tests) |
| --- | --- | --- |
| Behaviour › The pane: rows, ✓/✗, folders, accept/reject all, layout | **must not change** for this session's rows. **Changes:** rows owned by another or an earlier session get a dim origin tag, rows recorded on another branch an `other branch` tag, and a dim footer counts pending files outside the cwd | tree, folder, status-row, accept/reject tests |
| Behaviour › The pane: opens on its own when files are pending at session start | **changes:** governed by `openOnStart` (`auto`, the default, keeps today's behaviour; `toast` only shows the toast). At most one toast per session start; entries from other sessions and the reload after `/clear` never toast or open the pane | narrow-terminal toast tests |
| Behaviour › The diff view | **must not change** (a resumed entry opens the same way, its original read from git) | review tests |
| Behaviour › What gets tracked, incl. multi-round changes and net diffs | **must not change**: same scope, same first-original rule across sessions | diff-count, scope and shell-tracking tests |
| Behaviour › Keeping Claude in sync | **changes:** new notes (resume, handover, resolve by another session, change from an earlier session); existing notes unchanged | the note tests |
| Behaviour › Limitations: "State is per session" | **changes:** replaced by the new limits (see Limits) | none |
| Under the hood › State, Hooks, Settling and refresh, Accept and reject, Temp files | **changes:** persisted index and tree ref beside `$.state`; refresh merges other shards and writes a heartbeat; resolve releases originals | refresh tests |
| Design decision 1, straight to disk | **must not change**: persistence records reviews, never stages changes | n/a |
| Design decision 3, Claude never drifts | **extended** across sessions | note tests |
| Design decision 4, scope | **must not change**: a session tracks, shows and acts on git-tracked files under its own cwd only. It reads the records of entries outside its cwd only to count them for the footer, and to record that one dropped off when its file is back at its original; it never reads, writes or deletes those files' content beyond that check | scope test |
| Design decision 5, net diffs | **must not change**, across sessions too: an entry's original is always the one recorded before any Claude's first touch since it was last resolved | diff-count tests |
| Design decision 7, stay fast | **must not change**: per-tick work is bounded by sessions, not repo size; git work is off the critical path, except one load per session and a fetch when a tool touches a file another session just recorded | n/a |

With `persistAcrossSessions` off, every row above behaves exactly as today. No Design decision is contradicted.

### New behaviour
**Resuming.** In a git work tree, a new session (including after `/clear` or `--resume`) loads the worktree's persisted list before its first writing tool call or prompt is handled.
- Every entry is re-settled against its persisted original. A file that is back at its original drops off, and its original is released.
- Entries under the session's cwd are listed as usual. A dim footer reads "N more pending outside this folder" when the worktree holds entries outside it; they can't be acted on from here.
- At session start, with `openOnStart: auto` the pane opens on its own as today; with `toast` it doesn't, and the existing toast says files are pending and to run `/changes`. Either way, at most one toast is shown.
- After `/clear`, the list reloads quietly: no toast, and the pane isn't reopened.

**Live sessions.** Every change one session records, resolves or re-settles shows in other sessions' panes within about one refresh (2 s). Entries arriving from other sessions never toast or open the pane.

**One record per change, across sessions.**
- An entry's original is the one recorded at the first Claude touch since the entry was last resolved, whichever session recorded it. A later record from another session can change its owner and counts, never its original.
- A file the user accepted or rejected stays resolved in every session, including after the session that resolved it has ended.
- Before Claude's writing tool picks an original, and before a prompt is handled, the session reads any other session's records that changed since its last refresh.
- A resolve record is kept for 24 hours after no other record needs it.
- Entries that were never persisted (too large, or a failed write) stay listed in their own session, including across a hot reload.

**Branches.** Each record notes the branch checked out when it was made. A row recorded on a different branch from the one now checked out carries a dim `other branch` tag, so Reject all after a checkout is a visible choice.

**Ownership.** Each entry is owned by the last Claude session that changed it. Rows owned by another live session, or by an ended one, carry a dim origin tag (`other session` / `earlier`). This session's rows look as today.

**Live or ended.** Each session writes a heartbeat every 2 s. From the start of one of its Claude's writing tools until that change is written to its record, the heartbeat says so (busy). This includes tools that are denied, fail or change nothing, which clear busy as soon as they end. With persistence off, or once a session has ended, it writes no heartbeat.
- A session counts as **ended** when its record has an end marker newer than its heartbeat, or its heartbeat is older than 30 s. A session whose own last heartbeat is older than 30 s (the machine slept) doesn't judge others on that tick.
- A `--resume`d session clears its end marker when it loads, and is live again.
- While another live session is busy, and for one refresh after, a session doesn't report hand edits or reverts and doesn't treat a file as reverted or emptied. It only updates counts.
- An ended session's records are folded into a live session's only when it has an end marker, or its heartbeat is older than 24 hours.

**What Claude is told.** In addition to today's notes:

| Event | Who is told | Note |
| --- | --- | --- |
| A session starts with entries left by earlier sessions | that session's Claude, at the first tool result or prompt | "These files have unreviewed changes from an earlier session: `a`, `b`, … They are listed in the review pane." |
| Another session's Claude edits a file this session owns | the previous owner's Claude | "`X` was since edited by another Claude session; the user's decisions on it go to that session now." |
| The user rejects, reverts or hand-edits a file owned by a live session other than the current one | the owner's Claude (delivered by its own session at its next tool result or prompt) | today's reject/revert/edit note |
| The user rejects a file whose owner session has ended | the Claude of the session where the user rejected it (the file is resolved, so it has no owner afterwards) | today's reject note |
| The user hand-edits, or reverts in the diff, a file whose owner session has ended | every live Claude that knows the file: it got it in a resume note or a handover note | "`X`, changed in an earlier session, was modified by the user; re-read it before editing it." / "The user reverted `X`, changed in an earlier session, to its original; re-read it before editing it." |

Notes between sessions travel in the records themselves: a reject or revert is a resolve record naming its kind and the owner, and a handover is a newer record with another owner. The owner's session reads them at its next refresh and tells its own Claude, naming the file relative to its own cwd. No separate note is stored, so two sessions that see the same revert send one note.

A reject recorded for a live owner that ends, or is folded away by another session, without having read it (its record still predates the reject) is told to the Claude of the session where the user clicked, once. A revert or hand edit in that case follows the last row.

Every note names the file relative to the cwd of the Claude that receives it.

**Shell commands beside other sessions.** A file another session's Claude changed while this session's shell command ran stays that session's: this session doesn't claim it or send a handover. If the user accepted a file in another session while this session's command ran and the command then changes it, the accepted content becomes the new original, so a later ✗ never undoes the accept.

**Acting on a row that just changed.** If another session changed an entry after the pane drew it, ✓ or ✗ on it does nothing, the pane redraws, and a toast says "`X` changed in another session; check it again."

**One session in two windows.** If the same session id is open in two Claude Code windows (`--resume` of a session still running), the second one runs session-only and a toast says: "This session is open in another window too; pending changes here aren't shared."

**Settings** (`/config`):

| Field | Type | Default | Effect |
| --- | --- | --- | --- |
| `persistAcrossSessions` | boolean | on | Off: no persistence, no shared list, today's behaviour. Already persisted data is left in place, and turning it back on picks it up, minus what this session resolved meanwhile. |
| `openOnStart` | `auto` \| `toast` | `auto` | Whether the pane opens on its own at session start when files are pending. |

**Failures.**
- If a write fails (hashing, the record or the tree), the session stays live for other sessions and keeps receiving their notes, and it retries the write later. After repeated failures it tells the others it is detached. They still treat it as a live owner.
- Only when it can't read the shared folder, or write its heartbeat, does it fall back to today's session-only behaviour.
- In every case, the refresh, counts and notes for its own list keep working.

**Cleanup.**
- Resolving or re-settling a file releases its original.
- At session start, the worktree's tree is rebuilt from its list, entries whose original is missing are dropped, refs of worktrees whose git dir is gone are deleted, and the records of ended sessions are folded in.
- Delivered notes and resolved records are pruned once no session needs them.
- `/exit` waits, within its time limit, for the last changes to be written. The record with its end marker is written first, and git work only with the time left.
- The README gives a one-line command to remove all `refs/pending-changes/*` after uninstalling.

**Limits** (for the SPEC and README Limitations):
- No persistence outside git.
- An original too large to read back through git (`process.run` returns at most 4 MiB) stays session-only.
- `git push --mirror`, a `refs/*:refs/*` refspec, `git clone --mirror` and `git bundle create --all` copy the ref and the originals. `git fast-export --all` (and `git filter-repo`) prints a warning about it.
- Non-UTF-8 files stay lossy until #3 is fixed.
- A crashed session counts as ended only after 30 s.
- Sessions on one worktree must share a machine and clock.
- `$.state` holds at most about 4 M characters for the list. Entries from other sessions that would pass that are left out of this session's pane, with one toast; they stay persisted and other sessions still list them.
- Pending changes outlive branch switches. Rows from another branch are tagged, but ✗ still restores the original they were recorded against.
- If another session's Claude changes a file during this session's shell command and hasn't written its record by the time the command ends, this session claims the change as its own Claude's. It is still listed for review.
- Only VS Code's watcher was checked. Other `.git` watchers (JetBrains, `core.fsmonitor`) and history rewriters run with `--all` or `--everything` (`git filter-branch`, `git lfs migrate`) weren't, and may react to the shard folder or trip over a ref that points at a tree.

### Acceptance criteria
1. In a git work tree, a file Claude changed in one session is listed in a later session (a new id) with the same counts, and ✗ there restores the original from git.
2. On resume, an entry whose file is back at its original drops off, and its SHA is no longer in the worktree's tree.
3. Persisted originals are written with `git hash-object -w`, pinned only through `refs/pending-changes/<worktree id>` pointing at a tree, and every ref update is a compare-and-swap (creating the ref swaps from the all-zero id). A lost swap is retried after re-reading every changed record. After three lost attempts the update waits for the next tick, and no original is dropped.
4. Accepting or rejecting a file removes its SHA from the tree, unless another entry uses the same content. The release is computed after re-reading changed records.
5. A shard written by another session (fake disk, new mtime) appears in this session's list after the next tick. An unchanged shard is not re-read.
6. A session started in a subfolder lists only entries under its cwd and shows "N more pending outside this folder". Accept all and reject all touch only the listed entries.
7. After `/clear` (`session.end` reason `clear`, then a new id), the old id is marked ended, and later writes are owned by the new id.
8. The first tool result or prompt of a session that resumed entries carries the resume note listing them, once.
9. When session B's Claude edits a file owned by session A, the entry's owner becomes B in B's record, and A, reading it, tells its Claude the handover note.
10. Rejecting, from session B, a file owned by live session A records the reject for A, and A tells its Claude; B's Claude isn't told. When A's heartbeat is stale or A has ended, B's Claude is told, and the file stays resolved: nothing recorded afterwards brings it back. When A ends without reading the reject, B's Claude is told, once.
11. Rows owned by another or an ended session show the dim origin tag; this session's rows don't.
12. With `persistAcrossSessions: false`, nothing is written to the git dir or refs (no record, no heartbeat), and a new session starts with an empty list.
13. With `openOnStart: 'toast'`, pending entries at session start show the toast and don't open the pane. With `auto`, today's behaviour holds. A Claude change while the list is still loading gives exactly one toast at start; an entry from another session, or the reload after `/clear`, gives none.
14. Outside git, behaviour is today's: nothing is persisted.
15. An original too large to come back through `cat-file` is tracked in its session but not persisted. A `cat-file` batch cut off at the output limit is parsed up to its last complete record and continued from there, and always finishes.
16. Session start deletes `refs/pending-changes/worktrees/<name>` for a worktree whose git dir is gone, and keeps the others.
17. The tool call that records a change doesn't wait for the persistence git calls (they run after its result).
18. When another session's record of a file arrives after this session already recorded it (or the other way round), the original stays the one recorded first.
19. Session A records X, session B accepts it, B ends and is folded in, session C starts: X stays resolved, and Reject all in C doesn't touch it.
20. While another live session's heartbeat says busy, and for one tick after, this session's refresh reports no hand edit or revert, and doesn't reject an emptied new file.
21. A session that `/exit`s and is `--resume`d with the same id is live for other sessions again: they don't adopt its entries or fold in its shard.
22. A session whose heartbeat is between 30 s and 24 h old is not folded in. If a live session finds its own shard missing, it rewrites it.
23. If listing or reading the shards throws, the refresh still updates counts and detects reverts, and the session carries on session-only.
24. A writing tool call or prompt that arrives while the list is loading waits for the load, so it never takes the current disk content as an original for a file that has a persisted record.
25. `session.end` waits, within `next.budget`, for the pending write, and the end marker is part of that write.
26. A shard that fails to parse is read again at the next tick, and its last good content is kept meanwhile; its entries are never treated as resolved.
27. A hand edit to a file owned by an ended session is reported to the Claude of every live session that got the file in a resume or handover note, and to no other.
28. Turning `persistAcrossSessions` off, accepting a file and turning it back on doesn't bring the file back.
29. After a hot reload (a `/config` change), the session's own record keeps every entry it had: a ✓ or an Edit made before the reload finishes loading waits for it, and never rewrites the record from an empty list.
30. A peer whose writing tool starts and finishes between two of this session's ticks causes no note and no reject: its change is read before the per-file check.
31. Rebuilding the tree while a record can't be parsed never removes a SHA. A session that loses a swap after a rebuild pins every SHA its own record uses again.
32. `session.end` with a slow git call still leaves a parseable record with its end marker.
33. A row recorded on another branch than the one checked out carries the `other branch` tag.
34. A reload keeps entries that were never persisted (over the size cap, or a failed write).
35. A resolve record whose 24 hours haven't passed keeps the file resolved even when another session folds a record holding the file in between this session's list and its read.
36. A writing tool that is denied, fails, changes nothing or throws leaves the heartbeat not busy once it ends.
37. A failed write keeps the session live for other sessions: its heartbeat advances and notes addressed to it are delivered. After repeated failures it reports itself detached, and peers still route to it.
38. A file another session recorded during this session's shell command keeps that session as its owner, and no handover note is sent.
39. If the user accepts a file in another session during this session's shell command, and the command then changes it, a later ✗ restores the accepted content.
40. A note routed between sessions with different cwds names the file relative to the receiving session's cwd.
41. A half-written heartbeat doesn't change whether a session counts as live or busy.
42. While a session folds in an ended one, other sessions keep listing its entries throughout.
43. An entry from another session is listed only once its original can be read. If it can't, the entry isn't listed, and Reject all leaves the file alone.
44. A second window on the same session id runs session-only and shows the toast.
45. ✓ or ✗ on an entry another session changed after the pane drew it leaves it unresolved and shows the toast.
46. A cwd reached through a symlink or junction records the same path as the resolved one.
47. Files edited during a rebase aren't tagged `other branch` once it finishes.
48. A hand edit already reported to Claude isn't reported again after a resume.
49. Heartbeats with no record that are older than 24 h are deleted, and a session ended by `/clear` is folded in without waiting for a new process.

### Decisions
Choices agreed with the user while opening the research:
- Originals in git's object store with no persistence outside git, pinned by one tree ref per worktree; the list in per-session files in the worktree's git dir.
- The project is the git worktree; each session's scope stays its cwd, with a footer for entries outside it.
- Live sync on the 2 s refresh. Stale entries are re-settled against their original on resume.
- Owner = last Claude to change it, with a handover note to the previous owner. Notes go to the owner, or to the current session when the owner has ended.
- Resume note at the first prompt or tool result. Dim origin tags on rows from other or earlier sessions.
- `persistAcrossSessions` (default on) and `openOnStart` (`auto`, default) as `userConfig` fields. New SPEC Design decision: every setting is a `userConfig` field with a default, shown in `/config`, and covered by a test.
- Further SPEC Design decisions: git work is batched and kept off the critical path; the owner id is read at every write.
- Cross-session locks are out of scope (ROADMAP "Exploring").

Agreed while planning:
- A session counts as ended after 30 s without a heartbeat, or with an end marker newer than its heartbeat. A session that itself missed 30 s (sleep) doesn't judge others on that tick. Records are folded in only with an end marker or after 24 h.
- The origin tags, footer and the first three notes use the wording above.
- Turning `persistAcrossSessions` off leaves persisted data in place.
- Refs are `refs/pending-changes/main` for the main worktree and `refs/pending-changes/worktrees/<name>` for a linked one, the name encoded to be a valid ref.
- At most one toast per session start; entries from other sessions are silent; `/clear` reloads quietly.
- Hand edits and diff reverts of a file whose owner has ended go to every live Claude that knows the file (resume or handover note), not to every session.
- Heartbeats and shards stay in the git dir; per-tick writes only rewrite existing files.
- From the second review: rows from another branch get an `other branch` tag (the branch is recorded per change); a resolve record is kept 24 h after it's no longer needed.
- From implementation: notes between sessions travel in the records (resolve and ownership records) instead of a note queue in each shard; session start waits for the load (about 3–4 git calls, once per session). The test kit can't reload a module, so the mod has a test seam: a `command.run` hook for `__pending-changes-reload`, never registered as a command and inert unless `PENDING_CHANGES_TEST=1`, which resets the module's state (keeping `$.state`) and can change the settings. It makes criteria 28 (both halves), 29 and 34 and the plan's test 46 automated tests.
- From the third review: live sharing stays in v1 (the alternative, one live session per worktree with the rest session-only, was considered and declined). All 25 findings are folded in.
