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
- **Pinning:** one ref per worktree, `refs/pending-changes/<worktree id>`, pointing at a tree (built with `git mktree`, never a commit) that lists every blob the worktree's index uses, so `git gc` keeps them. Experiment 4 rules out `refs/worktree/*`; experiment 5 replaced the earlier one-ref-per-blob idea.
  - When the set of SHAs changes, build a new tree and move the ref with a compare-and-swap (`update-ref <ref> <new> <old>`). A session that loses the swap re-reads and retries.
  - Released blobs and old trees become unreachable, and git's own gc reclaims them. The mod never deletes objects itself.
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
  - reconcile on start: rebuild the worktree's tree from its index, which drops SHAs no entry uses, and drop entries whose blob is missing;
  - reconcile worktrees on start: delete `refs/pending-changes/<worktree id>` refs whose worktree no longer appears in `git worktree list`. `git worktree remove`/`prune` deletes the worktree's git dir, and its index with it, but not its ref in the shared namespace. A new worktree reusing the name would otherwise inherit it;
  - compact shards of ended sessions;
  - files over 4 MiB stay session-only;
  - the README gets a one-line command to remove leftover refs after uninstalling.
- **Out of scope:** cross-session file locks, now a separate ROADMAP "Exploring" item. Claude Code has no built-in file locks: its guidance is worktrees, or giving each agent different files, and only agent-team task claiming uses file locking. Hard locks could cover Edit, Write and NotebookEdit through `{ deny }`, but not Bash, and would need lockfiles plus stale-lock recovery. The owner field above is what such a feature would build on.

### What was tried
Experiments, docs read and prototypes, each with what's needed to repeat it, and what came of it.

1. **Engine API survey.** Read `claude-code.d.ts` (build 2.1.302) for `$.fs`, `$.store`, `$.state`, `$.process`, `tool.call`, `userConfig`. Its findings are in Constraints.
2. **Built-in multi-session support.** Read the [agent teams docs](https://code.claude.com/docs/en/agent-teams): "Two teammates editing the same file leads to overwrites. Break the work so each teammate owns a different set of files"; "Task claiming uses file locking". Worktrees (`claude --worktree`, `isolation: "worktree"`) isolate sessions. No file-level locking exists. Third-party guides agree ([morphllm](https://www.morphllm.com/claude-code-worktrees), [verdent](https://www.verdent.ai/guides/claude/code-worktree)).
3. **Ref visibility and gc** (git 2.45.2.windows.1, scratch repo). Blobs were written with `printf … | git hash-object -w --stdin` and pinned with `git update-ref refs/pending-changes/<sha> <sha>` and `git update-ref refs/worktree/pending-changes/<sha> <sha>`. Then `for-each-ref`, `log --all [--graph]`, `branch -a`, `fsck` and `gc --prune=now` were run.
   - Both kinds of ref are stored inside `.git/refs/…`. After gc, `refs/pending-changes/*` moves into `.git/packed-refs`, while `refs/worktree/*` stays a loose file.
   - `git log --all`, `log --all --graph` and `branch -a` show only `main`, and `fsck` is clean. Blob refs don't appear in history views.
   - A pinned blob survives `gc --prune=now`. An unpinned blob is pruned at once, and so is a blob whose ref was deleted with `update-ref -d`. Releasing works as intended.
   - `hash-object --stdin` keeps CRLF bytes as given, with no filters applied.
   - **Push and clone** (run by the user, since pushing is theirs: `scratchpad/exp3push/push-test.sh`, a repo with a commit, tag `v1` and a ref `refs/pending-changes/main/<sha>`, pushed to fresh local bare repos):

     | Command | `refs/pending-changes/*` copied? |
     | --- | --- |
     | `git push <remote> main` | no |
     | `git push --all` | no |
     | `git push --tags` | no |
     | `git clone` | no |
     | `git push --mirror` | **yes** |
     | `git push <remote> 'refs/*:refs/*'` | **yes** |
     | `git clone --mirror` | **yes** |
   - *Not yet checked:* VS Code and GitLens graphs.
4. **Worktrees.** `git worktree add ../wt` in the same scratch repo.
   - `rev-parse --git-dir` in the linked worktree is `.git/worktrees/wt`, and `--git-common-dir` is `.git`. Each worktree has its own git dir for the index shards, and files written there don't show in either worktree's `git status`.
   - Objects are shared. `refs/pending-changes/*` made in one worktree is visible from the other. `refs/worktree/*` is private to each worktree.
   - **`refs/worktree/*` does not protect against gc from another worktree.** A blob pinned only by `refs/worktree/pending-changes/<sha>` in the linked worktree survived gc run from that worktree. It was **pruned by `gc --prune=now` run from the main worktree**. The dangling ref then broke the linked worktree: its `git gc` failed (`fatal: bad object refs/worktree/…`, `failed to run repack`) and `fsck` reported `invalid sha1 pointer`. A blob pinned by `refs/pending-changes/*` survived gc from both worktrees. Reproduce with the commands above, plus `git -C ../wt update-ref refs/worktree/pending-changes/$W $W`, then `git gc --prune=now` in the main worktree.
5. **Round trip from the mod** (Windows; throwaway probe mod `pc-probe` in the session's dev-mods folder, command `/probe-roundtrip`, fixtures in `scratchpad/exp5/repo` with `core.autocrlf=true`). For each file it did four things: read with `$.fs.read`, `hash-object -w --stdin` that text, compare with `hash-object --no-filters <file>`, then `cat-file blob` it back and `$.fs.write` it to a copy. Results:

   | File | stdin SHA = disk SHA | cat-file = read text | rewritten copy = disk |
   | --- | --- | --- | --- |
   | CRLF, LF, mixed, no final newline, UTF-8 BOM, UTF-8 (Greek, emoji), empty | yes | yes | yes |
   | Latin-1 (`caf\xe9`) | **no** | yes | **no** |

   - Every UTF-8 text file round-trips byte-exact, line endings and BOM included.
   - Non-UTF-8 bytes are lost **before** git is involved: `$.fs.read` decodes as UTF-8 and `$.fs.write` writes UTF-8. This is not specific to persistence. Today's ✗ follows the same read-text, write-text path, so rejecting a change to a Latin-1 file rewrites its bytes (`hooks/register.tsx:88` reads text, `:203` writes it back). This is a bug in shipped behaviour, tracked in its own GitHub issue (link to be added once it is opened).
   - **Cost:** about 77 ms per git call on Windows (process start dominates), and 225 ms for hash + pin + release. One call per file per step is too slow for shell commands that touch many files, as the batching finding below explains.
   - *Not yet run:* POSIX.
   - **Batching** (shell, same repo, 200 CRLF files):
     - `ls … | git hash-object -w --no-filters --stdin-paths` took 1001 ms, byte-exact, against ~113 ms per single call;
     - pinning 200 per-blob refs in one `git update-ref --stdin` transaction took 987 ms, and releasing them 593 ms. That's ~5 ms per ref, because every loose ref is its own file.
   - **One tree ref per worktree instead of one ref per blob** (same repo):
     - `git mktree` builds a tree listing every pinned blob, then `git update-ref refs/pending-changes/<worktree id> <tree>`. That's 2 calls, 295 ms for 200 blobs;
     - the blobs survive `gc --prune=now`;
     - `log --all`, `branch -a` and `fsck` show nothing;
     - releasing is a rewrite without the released blobs, then gc removed them and kept the rest;
     - `update-ref <ref> <new> <old>` is compare-and-swap: a writer holding a stale `<old>` is rejected (`cannot lock ref … is at … but expected …`).
6. *To do:* **Shards across processes.** Two sessions write shards while ticking. Confirm merges converge, no event is lost, and `$.fs.read` sees the other process's writes immediately.
7. *To do:* **Tick cost.** Measure the per-tick shard check (stat vs read) with 1, 5 and 20 shards against design decision 7.
8. *In progress:* **Session lifecycle.** From the types (`SessionEndInput.reason`): "`clear` is how a hook sees a `/clear`: the conversation ends, the process goes on under a new session id, and no `session.start` fires for it." So the owner id must be read with `$.session.id()` at every write, never cached at start, and a `session.end` with reason `clear` marks the old id's shard as ended. Still to confirm with the probe (`/probe-id` around `/clear` and `--resume`, logged to `scratchpad/probe/lifecycle.jsonl`): What `session.start`/`session.end` and the session id do on `/clear`, `--resume` and `--continue`, so shard ownership and "owner has ended" detection are sound (heartbeat in the shard vs `session.end` marker).
9. *To do:* **Test kit.** Can `claude plugin test` cover this? A fake git with objects and refs, two sessions in one test, and `options` for the settings.

### Findings
The facts the experiments established. Separate what was confirmed from what is only assumed.

- **Confirmed (experiments 3–4):**
  - Blob refs pin originals against gc, deleting the ref releases them, and they don't show in `log --all`, `branch -a` or `fsck`.
  - `refs/worktree/*` is **ruled out**: gc from another worktree prunes what it pins and leaves the repo with broken refs. Pins must live in the shared `refs/pending-changes/` namespace, scoped by worktree (`refs/pending-changes/<worktree id>`; worktree id: `main`, or the name under `.git/worktrees/`). Each worktree then manages its own pins from its own index alone.
  - Index shards in `<git-dir>/pending-changes/` are per worktree and invisible to `git status`.
- **Confirmed (experiment 5):**
  - UTF-8 originals, any line endings or BOM, survive `$.fs.read` → `hash-object --stdin` → `cat-file` → `$.fs.write` byte-exact.
  - A git call costs ~77 ms on Windows. **Git work must be batched and kept off the critical path:**
    - `git hash-object -w --stdin-paths` hashes any number of files from disk in one call (exact bytes, no stdin text);
    - `git mktree` plus one `update-ref` pins and releases any number of blobs (295 ms for 200);
    - persistence runs after the tool result is returned, so Claude's tool calls don't wait on it.

    Per-file calls would add ~150 ms per new file, which is 30 s for a command touching 200 files.
  - **Pinning changed to one tree ref per worktree** (`refs/pending-changes/<worktree id>` → a tree of every pinned blob; agreed with the user). Compared with one ref per blob:
    - its cost is constant, 2 git calls however many files;
    - one ref per worktree means one orphan to delete when a worktree is removed;
    - the update is compare-and-swap, so the release race inside a worktree goes away: a session that loses the swap re-reads and retries;
    - it is just as invisible to history views and just as safe under gc.
  - Non-UTF-8 files are already lossy through `$.fs` text reads and writes; that's parity with today, not a new limit. Batched `--stdin-paths` would store the exact bytes, but restoring them still goes through text. Exact-byte restore (e.g. `checkout-index` with a temporary `GIT_INDEX_FILE`) is a possible follow-up, not a blocker.
- **Issues these raise, with the planned handling:**
  - **Orphaned ref after a worktree is removed.** The worktree's git dir goes, its `refs/pending-changes/<worktree id>` ref stays. Handled by the worktree reconcile under Cleanup.
  - **Release race inside one worktree.** With per-blob refs, session A could delete a ref just as session B started using the same content. Solved by the tree ref's compare-and-swap: every tree is built from the merged shards, and a swap based on a stale tree is rejected and retried.
  - **Two writes between hashing and pinning.** A blob written by `hash-object -w` is unreferenced until the tree swap lands. A `gc --prune=now` in that window could remove it. The default `gc.pruneExpire` (2 weeks) makes this practically impossible, so it is accepted.
  - **Push leaks.** Confirmed: `git push --mirror`, a `refs/*:refs/*` refspec and `git clone --mirror` copy the refs, and the originals with them. Ordinary push, `--all`, `--tags` and clone don't. The mod can't prevent this without installing a git hook in the user's repo, which is ruled out as too invasive. The README Limitations documents it, together with the one-line cleanup command.
- **Confirmed (docs/types):**
  - `$.store` is unsuitable for originals (4 MiB total).
  - `$.process.run` takes `stdin`.
  - `userConfig` gives settings in `/config` with a reload on change.
  - Claude Code has no file locks for parallel sessions.
- **Assumed, to verify (3–9):**
  - blob refs don't disturb IDE graphs (VS Code, GitLens);
  - the batched calls cost the same from `$.process.run` as from the shell (measured from the shell so far);
  - POSIX behaves the same;
  - shard writes are visible across processes at once;
  - the tick check is cheap enough.

### Recommendation
Pending experiments 6–9 and the batching check.

### Outcome
Filled in once the user agrees with the recommendation. Then this file is deleted.

- **Go:** start a `feat-keep-across-sessions.md` spec that carries the findings into its Context, on this branch. The item is already in ROADMAP "Now".
- **No-go:** tag the last commit that has this file `archive/keep-across-sessions`, then move the ROADMAP item to "Not planned" with a one-line reason and a link to this file at that tag (see [Archiving work that didn't ship](README.md#archiving-work-that-didnt-ship)). If the reason will matter later, add a SPEC Design decision.
