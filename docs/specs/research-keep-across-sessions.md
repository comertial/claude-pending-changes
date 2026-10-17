# Research: Keep pending changes across sessions

**Status:** Open
**Roadmap item:** Keep pending changes across sessions (listed under "Now"; researched first because the storage and multi-session design is an open question)
**Issue:** none

---

### Question
Can the pending list, and the originals it diffs against, be persisted per git worktree so that a new session, or a second live session, picks the review back up, using **git's object store for originals** and **per-session index shards in the git dir**, reliably, without leaking to remotes or bloating disk? Go or no-go, and if go, which of the open options below to take.

### Why it matters
Today `$.state` is per session ([Limitations](../SPEC.md#limitations): "State is per session"). Anything left unreviewed when a session ends, or after `/clear`, becomes plain files on disk with no record of the original, so ✗ is no longer possible. Two sessions in one checkout each see only their own changes. A go unblocks a `feat-keep-across-sessions` spec. The answer also sets the pattern for plugin settings and for any later cross-session feature, such as file locks.

### Constraints
- **Design decisions** ([SPEC](../SPEC.md#design-decisions)) that must hold:
  - 1, changes go straight to disk: persistence records reviews and never stages changes;
  - 3, Claude never drifts: across sessions too;
  - 4, scope: a session tracks, shows and acts on git-tracked files under its own cwd;
  - 5, net diffs: always measured from the original before Claude's *first* touch, whichever session made it;
  - 7, stay fast: nothing per tick that scales with repo size.
- **Behaviour that must not change** inside a single session: the pane, ✓/✗, the diff view, shell tracking, notes. A user who turns persistence off gets exactly today's behaviour.
- **Engine limits** (types for build 2.1.302):
  - `$.state` is per session; `$.store` persists but is one JSON file per plugin, capped at 4 MiB across all projects, with no compare-and-set.
  - `$.fs.read` rejects files over 4 MiB; `$.fs.write` creates folders; `$.fs` has no delete or atomic create.
  - `$.process.run` accepts `stdin`.
  - `tool.call` can `{ deny }`.
  - `userConfig` fields in `plugin.json` appear in `/config`, and changing one reloads the module with new `options`.
- **Persisted data stays private:** it is never committed, never pushed by ordinary git commands, and never visible in the working tree.
- **No persistence outside git.** Non-git folders keep today's per-session behaviour.

### Agreed direction
Decided with the user while opening this research. The experiments below check that it holds up.

- **Originals** go into the repo's object store with `git hash-object -w --stdin`: compressed and deduplicated by content. `lastSeenByClaude` is stored the same way, so the index holds only SHAs.
- **Pinning:** one ref per blob (`refs/pending-changes/<sha>`, or `refs/worktree/pending-changes/<sha>` if experiment 3 favours it), so `git gc` keeps it. The ref is deleted with `git update-ref -d` once no entry uses that SHA, and git's own gc reclaims the blob later. The mod never deletes objects itself.
- **Index** lives in the worktree's git dir (`git rev-parse --git-dir`), e.g. `<git-dir>/pending-changes/<session id>.json`. Each session writes only its own shard of timestamped events. Readers merge all shards, and the latest event per path wins. It dies with the repo, so no dead-project sweep is needed for git repos.
- **Project key:** the worktree root. Each session shows and acts only on entries under its cwd, plus a dim footer: "N more pending outside this folder".
- **Live sync:** the 2-second refresh checks whether any shard changed (cheap: stat the shard folder) and merges.
- **Staleness on resume:** re-settle every entry against its persisted original. Files back at their original drop off and their refs are released.
- **Ownership:** each entry has one owner, the last Claude session that changed it.
  - When another session's Claude edits it, ownership moves. The previous owner gets a handover note ("`X` was since edited by another Claude session; the user's decisions on it go to that session now") and no further notes about it.
  - A reject, revert or hand edit is reported to the owner, through a note queued in the index under its session id and delivered at its next tool result or prompt.
  - If the owner session has ended, the current session's Claude is told and becomes the owner.
- **Resume note:** at the first prompt or tool result, one hidden note lists the files with unreviewed changes from earlier sessions.
- **Pane:** rows owned by an earlier or another live session get a dim origin tag.
- **Settings**, through `userConfig`:
  - `persistAcrossSessions` (boolean, default on);
  - `openOnStart` (`auto` | `toast`, default `auto`).

  Proposed SPEC Design decision: every setting is a `userConfig` field with a default, shown in `/config`, and covered by a test. Later ROADMAP settings (snapshot cap, diff tool) follow the same rule.
- **Cleanup:**
  - re-settle on resume;
  - release refs on resolve;
  - reconcile on start: delete refs the index doesn't name, drop entries whose blob is missing;
  - compact shards of ended sessions;
  - files over 4 MiB stay session-only;
  - the README gets a one-line command to remove leftover refs after uninstalling.
- **Out of scope:** cross-session file locks, now a separate ROADMAP "Exploring" item. Claude Code has no built-in file locks: its guidance is worktrees, or giving each agent different files, and only agent-team task claiming uses file locking. Hard locks could cover Edit, Write and NotebookEdit through `{ deny }`, but not Bash, and would need lockfiles plus stale-lock recovery. The owner field above is what such a feature would build on.

### What was tried
Experiments, docs read and prototypes, each with what's needed to repeat it, and what came of it.

1. **Engine API survey.** Read `claude-code.d.ts` (build 2.1.302) for `$.fs`, `$.store`, `$.state`, `$.process`, `tool.call`, `userConfig`. Its findings are in Constraints.
2. **Built-in multi-session support.** Read the [agent teams docs](https://code.claude.com/docs/en/agent-teams): "Two teammates editing the same file leads to overwrites. Break the work so each teammate owns a different set of files"; "Task claiming uses file locking". Worktrees (`claude --worktree`, `isolation: "worktree"`) isolate sessions. No file-level locking exists. Third-party guides agree ([morphllm](https://www.morphllm.com/claude-code-worktrees), [verdent](https://www.verdent.ai/guides/claude/code-worktree)).
3. *To do:* **Ref privacy and visibility.** In a scratch repo with a bare remote, create blob refs under `refs/pending-changes/` and under `refs/worktree/pending-changes/`. Check `git push`, `push --all`, `push --tags`, `push --mirror`, a `refs/*:refs/*` refspec, `git log --all`, `git branch -a`, `git fsck`, `git gc --prune=now` (the blob must survive while its ref exists), and VS Code / GitLens graphs.
4. *To do:* **Worktrees.** With a linked worktree, confirm `rev-parse --git-dir` gives a per-worktree folder, objects are shared, and per-worktree refs stay separate.
5. *To do:* **Round trip from the mod.** Prototype on this branch: `$.process.run('git', ['hash-object','-w','--stdin'], { stdin })` and `git cat-file blob <sha>` with CRLF content and a non-UTF-8 file, on Windows and POSIX. The text must come back byte-identical to what `$.fs.read` returned. Time it per file.
6. *To do:* **Shards across processes.** Two sessions write shards while ticking. Confirm merges converge, no event is lost, and `$.fs.read` sees the other process's writes immediately.
7. *To do:* **Tick cost.** Measure the per-tick shard check (stat vs read) with 1, 5 and 20 shards against design decision 7.
8. *To do:* **Session lifecycle.** What `session.start`/`session.end` and the session id do on `/clear`, `--resume` and `--continue`, so shard ownership and "owner has ended" detection are sound (heartbeat in the shard vs `session.end` marker).
9. *To do:* **Test kit.** Can `claude plugin test` cover this? A fake git with objects and refs, two sessions in one test, and `options` for the settings.

### Findings
The facts the experiments established. Separate what was confirmed from what is only assumed.

- **Confirmed (docs/types):**
  - `$.store` is unsuitable for originals (4 MiB total).
  - `$.process.run` takes `stdin`.
  - `userConfig` gives settings in `/config` with a reload on change.
  - Claude Code has no file locks for parallel sessions.
- **Assumed, to verify (3–9):**
  - refs outside `refs/heads` and `refs/tags` are only pushed by `--mirror` or a catch-all refspec;
  - `refs/worktree/*` is never pushed;
  - blob refs don't disturb `git log --all` or IDE graphs;
  - object round trips are byte-exact;
  - shard writes are visible across processes at once;
  - the tick check is cheap enough.

### Recommendation
Pending experiments 3–9.

### Outcome
Filled in once the user agrees with the recommendation. Then this file is deleted.

- **Go:** start a `feat-keep-across-sessions.md` spec that carries the findings into its Context, on this branch. The item is already in ROADMAP "Now".
- **No-go:** tag the last commit that has this file `archive/keep-across-sessions`, then move the ROADMAP item to "Not planned" with a one-line reason and a link to this file at that tag (see [Archiving work that didn't ship](README.md#archiving-work-that-didnt-ship)). If the reason will matter later, add a SPEC Design decision.
