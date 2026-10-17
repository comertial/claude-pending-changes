# Feature: Keep pending changes across sessions

**Status:** Draft
**Roadmap item:** Keep pending changes across sessions
**Issue:** none
**Plan:** [`../plans/feat-keep-across-sessions.md`](../plans/) (written once this spec is approved)

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

### Goals
- A session started in a git worktree picks up every unreviewed change left by earlier or other sessions in that worktree, with its original, so ✓, ✗ and the diff view work as if the change were made in this session.
- Live sessions in one worktree share one list, in step within about one refresh.
- Every Claude whose change the user resolves is told, wherever that Claude is running.
- Nothing persisted is committed, visible in the working tree, or pushed by ordinary git commands, and nothing piles up on disk.
- Settings that are easy to find and to extend: two `userConfig` fields now, and a rule for later ones.

### Non-goals
- Persistence outside git. Non-git folders keep today's per-session behaviour.
- Cross-session file locks or blocking edits (separate ROADMAP item).
- Byte-exact handling of non-UTF-8 files ([#3](https://github.com/comertial/claude-pending-changes/issues/3); persistence keeps today's behaviour).
- Persisting files over 4 MiB (`$.fs.read` limit). They stay session-only.
- Protecting against `push --mirror` and similar. Documented, not prevented.

### Affected behaviour

| SPEC section | Changes / must not change | Guarded by (existing tests) |
| --- | --- | --- |
| Behaviour › The pane: rows, ✓/✗, folders, accept/reject all, layout | **must not change** for this session's rows. **Changes:** rows owned by another or an earlier session get a dim origin tag, and a dim footer counts pending files outside the cwd | tree, folder, status-row, accept/reject tests |
| Behaviour › The pane: opens on its own when files are pending at session start | **changes:** governed by `openOnStart` (`auto`, the default, keeps today's behaviour; `toast` only shows the toast) | narrow-terminal toast tests |
| Behaviour › The diff view | **must not change** (a resumed entry opens the same way, its original read from git) | review tests |
| Behaviour › What gets tracked, incl. multi-round changes and net diffs | **must not change**: same scope, same first-original rule across sessions | diff-count, scope and shell-tracking tests |
| Behaviour › Keeping Claude in sync | **changes:** new notes (resume, handover, resolve by another session); existing notes unchanged | the note tests |
| Behaviour › Limitations: "State is per session" | **changes:** replaced by the new limits (non-git, >4 MiB, mirror pushes) | none |
| Under the hood › State, Hooks, Settling and refresh, Accept and reject, Temp files | **changes:** persisted index and tree ref beside `$.state`; refresh merges other shards; resolve releases originals | refresh tests |
| Design decision 1, straight to disk | **must not change**: persistence records reviews, never stages changes | n/a |
| Design decision 3, Claude never drifts | **extended** across sessions | note tests |
| Design decision 4, scope | **must not change**: a session tracks, shows and acts on git-tracked files under its own cwd only | scope test |
| Design decision 5, net diffs | **must not change** | diff-count tests |
| Design decision 7, stay fast | **must not change**: per-tick work is bounded by sessions, not repo size; git work is off the critical path | n/a |

With `persistAcrossSessions` off, every row above behaves exactly as today. No Design decision is contradicted.

### New behaviour
**Resuming.** In a git work tree, a new session (including after `/clear` or `--resume`) loads the worktree's persisted list.
- Every entry is re-settled against its persisted original. A file that is back at its original drops off, and its original is released.
- Entries under the session's cwd are listed as usual. A dim footer reads "N more pending outside this folder" when the worktree holds entries outside it; they can't be acted on from here.
- With `openOnStart: auto` the pane opens on its own as today. With `toast` it doesn't; the existing toast says files are pending and to run `/changes`.

**Live sessions.** Every change one session records, resolves or re-settles shows in other sessions' panes within about one refresh (2 s).

**Ownership.** Each entry is owned by the last Claude session that changed it. Rows owned by another live session, or by an ended one, carry a dim origin tag (`other session` / `earlier`). This session's rows look as today.

**What Claude is told.** In addition to today's notes:

| Event | Who is told | Note |
| --- | --- | --- |
| A session starts with entries left by earlier sessions | that session's Claude, at the first tool result or prompt | "These files have unreviewed changes from an earlier session: `a`, `b`, … They are listed in the review pane." |
| Another session's Claude edits a file this session owns | the previous owner's Claude | "`X` was since edited by another Claude session; the user's decisions on it go to that session now." |
| The user rejects, reverts or hand-edits a file owned by a live session other than the current one | the owner's Claude (delivered by its own session at its next tool result or prompt) | today's reject/revert/edit note |
| The same, for a file whose owner session has ended | the current session's Claude, which becomes the owner | today's note |

**Settings** (`/config`):

| Field | Type | Default | Effect |
| --- | --- | --- | --- |
| `persistAcrossSessions` | boolean | on | Off: no persistence, no shared list, today's behaviour. |
| `openOnStart` | `auto` \| `toast` | `auto` | Whether the pane opens on its own at session start when files are pending. |

**Cleanup.**
- Resolving or re-settling a file releases its original.
- At session start, the worktree's tree is rebuilt from its list, entries whose original is missing are dropped, refs of worktrees that no longer exist are deleted, and the files of ended sessions are compacted.
- The README gives a one-line command to remove all `refs/pending-changes/*` after uninstalling.

### Acceptance criteria
1. In a git work tree, a file Claude changed in one session is listed in a later session (a new id) with the same counts, and ✗ there restores the original from git.
2. On resume, an entry whose file is back at its original drops off, and its SHA is no longer in the worktree's tree.
3. Persisted originals are written with `git hash-object -w`, pinned only through `refs/pending-changes/<worktree id>` pointing at a tree, and every ref update is a compare-and-swap. A lost swap is retried after re-reading, and no original is dropped.
4. Accepting or rejecting a file removes its SHA from the tree, unless another entry uses the same content.
5. A shard written by another session (fake disk, new mtime) appears in this session's list after the next tick. An unchanged shard is not re-read.
6. A session started in a subfolder lists only entries under its cwd and shows "N more pending outside this folder". Accept all and reject all touch only the listed entries.
7. After `/clear` (`session.end` reason `clear`, then a new id), the old id is marked ended, and later writes are owned by the new id.
8. The first tool result or prompt of a session that resumed entries carries the resume note listing them, once.
9. When session B's Claude edits a file owned by session A, the entry's owner becomes B and A's shard receives the handover note.
10. Rejecting, from session B, a file owned by live session A queues the reject note for A, not for B. When A's heartbeat is stale or A has ended, B's Claude is told and becomes the owner.
11. Rows owned by another or an ended session show the dim origin tag; this session's rows don't.
12. With `persistAcrossSessions: false`, nothing is written to the git dir or refs, and a new session starts with an empty list.
13. With `openOnStart: 'toast'`, pending entries at session start show the toast and don't open the pane. With `auto`, today's behaviour holds.
14. Outside git, behaviour is today's: nothing is persisted.
15. A file over 4 MiB is tracked in the session as today but not persisted.
16. Session start deletes `refs/pending-changes/<id>` for a worktree that is gone from `git worktree list`.
17. The tool call that records a change doesn't wait for the persistence git calls (they run after its result).

### Open questions
- How long a heartbeat may be silent before its session counts as ended. Proposed: 3 ticks (6 s) without an update, plus no `session.end` marker.
- The exact wording of the origin tags, the footer and the three new notes. Proposed above; final text in the plan.

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
