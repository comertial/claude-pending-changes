# Plan: Keep pending changes across sessions

**Status:** Draft
**Spec:** [`feat-keep-across-sessions.md`](../specs/feat-keep-across-sessions.md)

---

### Context
Today the pending list lives in `$.state`, so a new session, or `/clear`, loses every unreviewed change and its original, and ✗ is no longer possible. The research (`git show 3f1aaeb:docs/specs/research-keep-across-sessions.md`) settled the design: originals in git's object store, pinned by one tree ref per worktree, and the list in per-session shard files in the worktree's git dir. This plan builds it behind two `userConfig` settings, with today's behaviour unchanged when persistence is off or outside git.

**Decided while planning** (they go into the spec in commit 1):
- **Heartbeat:** a session counts as ended after **30 s** with no heartbeat (15 ticks), or as soon as its shard has a `session.end` marker.
  - **Sleep guard:** a session whose own last tick is older than 30 s skips the "ended" check for one tick, so waking from sleep doesn't mark live peers as ended.
  - Notes queued for an owner that has since ended are re-routed to the current session, which then becomes the owner.
- **Wording:** the origin tags, footer and three notes stay exactly as the spec proposes.
- **Turning `persistAcrossSessions` off** stops all reading and writing but leaves the shards and the ref in place. Turning it back on picks the list up again.
- **Ref name:** `refs/pending-changes/main` for the main worktree and `refs/pending-changes/worktrees/<name>` for a linked one. A linked worktree named `main` then can't collide with the main one.
- **At most one toast per session start.** While `load` is running, a Claude change neither toasts nor opens the pane. When `load` finishes, the start logic decides once over the whole list: `auto` opens the pane (toasting only if it can't be seated), `toast` shows the single start toast. After that, the "Claude changed files" toast works as today.
- **Peer entries are silent.** An entry that reaches an empty list from another session never toasts or opens the pane. It shows when the pane is open, or the next time it's opened.
- **`/clear` reloads quietly.** No start toast, and the pane isn't reopened. Claude still gets the resume note.
- **"Worktree gone"** (criterion 16) means `<common-dir>/worktrees/<name>` no longer exists. That's what `git worktree list` reads, and porcelain output doesn't give names.

### Changes

**`.claude-plugin/plugin.json`**: add `userConfig`, copied from the research kit `pc-kit/.claude-plugin/plugin.json`:
- `persistAcrossSessions`: boolean, default `true`, title "Keep pending changes across sessions";
- `openOnStart`: string, options `auto` / `toast`, default `auto`, title "Open the pane at session start".

**`types/index.d.ts`**:
- `Tracked` gains these optional fields:
  - `owner`: the session id that last changed it through Claude;
  - `originalSha` and `seenSha`: blob SHAs, `null` for "no file";
  - `gitRel`: the path relative to the worktree root, the persisted key.
- `PluginState` gains:
  - `outside: number`, for the footer;
  - `sessions: Record<string, 'live' | 'ended'>`, for the origin tags;
  - `loadedFor: string`, the session id the list was last loaded for;
  - `resumeNoted: string[]`, session ids that have had their resume note.

**`hooks/persist.ts`** (new, pure, no host access, like `commands.ts`). It holds:
- the shard type:
  - `Shard = { v: 1, session, ended?, entries: Record<gitKey, Event>, notes: Record<toSession, Note[]>, delivered: string[] }`;
  - `Event = { at, owner, gone?, original: sha|null, seen: sha|null, added, removed, isDeleted?, createdDirs?: gitRel[] }`;
- `mergeShards(shards)`: the latest `at` wins per path, ties broken by session id; `gone` means resolved;
- `isEnded(shard, aliveMtime, now, ownLastTick)`: the end marker, or a heartbeat older than 30 s, with the sleep guard;
- `noteId(gitKey, kind, event)`: deterministic, so two sessions that see the same revert send one note;
- `treeInput(shas)`: `mktree` stdin lines `100644 blob <sha>\t<sha>`;
- `parseCatFileBatch(stdout)`: walks `<sha> blob <size>\n<bytes>\n` using UTF-8 byte lengths (`TextEncoder` is available), and `<sha> missing`;
- `worktreeId(gitDir, commonDir)`.

**`hooks/register.tsx`**: a new **persistence** section between *state* and *actions*:
- **Context:** `ctx` replaces `findGitRoot` with one `git rev-parse --show-toplevel --git-dir --git-common-dir` call, which adds `gitDir`, `commonDir`, `worktreeId` and `shardDir = <gitDir>/pending-changes`. `persistOn = options.persistAcrossSessions !== false && gitRoot !== null`. `register(on, options)` keeps `options` in a module variable.
- **Recording:** `settle()` (`:125`) and `forget()` (`:170`) take a `from: 'self' | 'peer'` flag. On `self`, they set `owner = await $.session.id()` (read at every write) and add the path to `dirty`. On `peer`, they apply a merged change without recording it.
- **`schedulePersist($)`:** started with `void` after the hook's result is built, never awaited (criterion 17). One flush runs at a time, and another follows if more changed meanwhile. A flush:
  1. **Hash.** Write every text with no SHA yet (originals and `lastSeenByClaude`) to `<sessionDir>/blobs/<n>`, run `git hash-object -w --no-filters --stdin-paths` once, then remove the folder. Texts over 4 MiB (UTF-8 bytes) are skipped, and their entries stay session-only (criterion 15).
  2. **Shard.** Write this session's shard.
  3. **Tree.** Update it as a delta: the cached tree list plus new SHAs, minus SHAs this session released that no merged entry still uses (criterion 4). Run `git mktree`, then `git update-ref <ref> <new> <old>`. If the swap is lost, `git ls-tree <ref>`, re-merge the shards and retry, up to 3 times (criterion 3). Writing the shard before the tree means a full rebuild always sees a fresh SHA. The research's two-week `gc.pruneExpire` covers the window in between.
- **`load($)`** runs on `session.start` and whenever `$.session.id()` differs from `loadedFor` (which covers `/clear`, since that doesn't fire `session.start`). It is started with `void`, and the pane opens or toasts once it finishes. It:
  1. lists the shards and reads every one;
  2. merges them;
  3. fetches the texts with one `git cat-file --batch`, or more if `isStdoutTruncated`;
  4. drops entries whose blob is missing;
  5. re-settles each entry against the disk; a drop records `gone` and releases its SHA (criterion 2);
  6. puts entries under the cwd in `files`, and counts the rest in `outside`;
  7. queues the resume note for entries owned by ended sessions, once per session id (criterion 8);
  8. then **reconciles**: rebuilds the tree from the merged SHAs (CAS), deletes `refs/pending-changes/worktrees/<name>` refs whose git dir is gone (`git for-each-ref` plus `$.fs.list(<commonDir>/worktrees)`, criterion 16), and compacts the shards of ended sessions. Their live events and notes are copied into this session's shard as they are, then their files are removed through `removePath` with `shardDir` as the allowed root.
- **`session.end`:** writes `ended: reason` into the shard of the ending id (criterion 7).
- **Poll** (`:386`), before today's per-file loop, when persistence is on:
  1. write `<shardDir>/<id>.alive`, the heartbeat;
  2. call `load` if the id changed;
  3. `$.fs.list(shardDir)`, and re-read only the shards whose `mtimeMs` or `size` moved (criterion 5);
  4. apply what changed through `settle`/`forget` with `from: 'peer'`, fetching any unknown SHAs with one `cat-file --batch`;
  5. update `sessions` (live or ended);
  6. deliver notes addressed to this session that aren't in `delivered`;
  7. re-route notes queued for ended owners.
- **Note routing:** `noteFor($, entry, text, kind)` replaces the direct `queueNotice` calls in `reject()` (`:207`), the poll's revert note (`:403`) and its empty-new-file reject.
  - If the owner is this session, ended, or unknown, it queues locally and takes ownership.
  - Otherwise it appends `{ id, text }` to `notes[owner]` in this session's shard (criterion 10).
  - `prompt.submit` (`:679`) reports user edits only for entries this session owns, or adopts from an ended owner.
- **Handover:** when Claude's tool call settles an entry owned by another live session, the owner becomes this session and the previous owner gets the handover note (criterion 9).
- **Opening and toasts:**
  - a module flag `loading` is set while `load` runs. While it's set, the `wasEmpty && !dropped` branches in `tool.call` (`:666`) and `afterShell` (`:559`) skip `openUnasked`;
  - `settle` with `from: 'peer'` never triggers `openUnasked`;
  - `load` started from `session.start` ends with the start decision: with `openOnStart === 'toast'`, only the existing "still pending" toast; otherwise `openUnasked` as today (criterion 13). `load` started by an id change (`/clear`) makes no start decision.
- **Settings:**
  - persistence off, or no git dir: none of the steps above run (criteria 12 and 14).
- **Pane** (`:707`):
  - after the status, a dim `other session` tag when `sessions[owner] === 'live'` and the owner isn't this session, or a dim `earlier` tag when it has ended (criterion 11);
  - under the summary row, a dim "N more pending outside this folder" footer when `outside > 0` (criterion 6). Accept all and reject all already act only on `files`.

**Reuse:** `removePath` (`:92`) for shard and blob-folder deletes; `readOrNull`, `settle` and `cleanupReview` unchanged in spirit; `ctxPromise` caching; the `isInside` and `keyOf` path helpers.

### Tests
Extend the `hooks/pending-changes.test.ts` host, seeded from `pc-kit/hooks/kit.test.ts`:
- a disk with `mtimeMs` per file, and `fs.list`/`fs.stat` that report real kind, size and mtime;
- a switchable `session.id` (`h.session.id = 's2'`) and a fake `session.end`;
- a fake **git object store**: `hash-object -w --no-filters --stdin-paths` (paths read from `e.init.stdin`), `cat-file --batch`, `mktree`, `update-ref` with CAS and `-d`, `ls-tree`, `for-each-ref`, the combined `rev-parse`, plus `h.gate` to hold git calls open;
- helpers: `peerShard(h, id, entries, { ended, aliveAt })` and `seedBlob(h, text)`;
- a record of `fs.read` calls by path.

New tests, one or more per acceptance criterion:

| # | Test |
| --- | --- |
| 1 | an edit in s1 is listed after `/clear` → s2 with the same counts, and also in a fresh engine seeded with its shard and blobs; ✗ restores from the blob |
| 2 | on resume, a file back at its original drops off and its SHA leaves the tree |
| 3 | originals go through `hash-object -w`, the ref points at a `mktree` tree, every `update-ref` passes an old value; a lost swap retries and keeps both sessions' SHAs |
| 4 | ✓ and ✗ remove the SHA from the tree, except when another entry shares the content |
| 5 | a peer shard with a new mtime appears after one tick; an unchanged shard isn't read again |
| 6 | a subfolder cwd lists only its entries and shows the footer; Reject all leaves the outside entry alone |
| 7 | `/clear` writes `ended: 'clear'` to s1's shard, and later writes are owned by s2 |
| 8 | the resume note arrives with the first tool result and isn't repeated |
| 9 | a Claude edit of a peer-owned file moves the owner and queues the handover note in this session's shard for the peer |
| 10 | rejecting a live peer's file queues the note for the peer, not locally; with the peer stale (30 s) or ended, it's local and ownership moves; notes already queued for a now-ended peer are re-routed |
| 10b | sleep guard: after a 60 s clock jump with this session's own tick stale too, the peer isn't marked ended on the first tick |
| 11 | origin tags `other session` and `earlier` show on peer rows only |
| 12 | `{ options: { persistAcrossSessions: false } }`: no `hash-object`/`update-ref` runs, nothing under `.git/pending-changes`, a new id starts empty |
| 13 | `openOnStart: 'toast'` toasts and doesn't open the pane; `auto` keeps today's open |
| 13b | a Claude edit while `load` is held (`h.gate`) gives exactly one toast once it finishes, and with `toast` no pane; a peer entry reaching an empty list gives no toast and no pane; `/clear` with entries pending gives no toast |
| 14 | outside git, nothing is persisted |
| 15 | an over-4 MiB original is listed but not in the shard |
| 16 | session start deletes the ref of a worktree whose git dir is gone and keeps the live ones |
| 17 | with `h.gate` holding git, `$.tool.call` resolves, and the shard appears once the gate opens |

**Existing tests** all run with persistence on (the default), and the ones that use `head` now go through the fake git store. They must pass unchanged: they are the guard for "this session's rows must not change". A test that counts `process.run` calls (`a read-only command runs no git status`) only filters for `status`, so it stays as it is.

### SPEC merge
- **Behaviour › The pane:**
  - the origin tags and the outside-cwd footer in the element table;
  - the "on its own" row mentions `openOnStart`, at most one toast per start, silent peer entries and the quiet `/clear` reload.
- **Behaviour:** a new **Across sessions** subsection covering resuming, live sessions, ownership and settings (both fields with their defaults).
- **Keeping Claude in sync:** the three new note rows, plus the routing rule (owner, or the current session when the owner has ended).
- **Limitations:**
  - replace "State is per session" with:
    - no persistence outside git or over 4 MiB;
    - `push --mirror`, `refs/*:refs/*` and `clone --mirror` copy the ref;
    - non-UTF-8 files stay lossy (#3);
    - a crashed session counts as ended only after 30 s;
  - extend the 2-second refresh entry with shard reads.
- **Under the hood:**
  - State: the new atoms and `Tracked` fields;
  - Hooks: `session.start` loads and reconciles, `session.end` writes the marker;
  - Settling and refresh: the heartbeat, shard merge and note delivery;
  - Accept and reject: release and routing;
  - Temp files: the `blobs/` folder;
  - File layout: `persist.ts`, `userConfig`, the `register.tsx` section list;
  - a new **Persistence** section: shard format, ref and tree, flush order, CAS, load and reconcile, heartbeat and sleep guard.
- **Design decisions:**
  - 9: every setting is a `userConfig` field with a default, shown in `/config` and covered by a test;
  - 10: git work is batched and kept off the critical path (rules out per-file git calls);
  - 11: the owner id is read at every write (rules out caching the session id at start);
  - pins live in the shared `refs/pending-changes/` namespace (rules out `refs/worktree/*` and one ref per blob).
- **Tests list:** a "Persistence" group mirroring the table above, plus the host additions under the mocks list.

### README check
- **Highlights:** reviews survive `/clear`, `/exit` and new sessions, and live sessions in one checkout share a list.
- **Using it:** the two settings in `/config`, and what the origin tags and the footer mean.
- **What gets tracked:** unchanged, plus one line saying the scope is still the cwd.
- **Keeping Claude in sync:** notes reach the Claude that made the change, in whichever session.
- **Limitations:** the new list from the SPEC merge.
- **Troubleshooting:** a one-line cleanup after uninstalling, `git for-each-ref --format="delete %(refname)" refs/pending-changes/ | git update-ref --stdin`, plus deleting the `pending-changes` folders in the git dirs.

### CHANGELOG / ROADMAP
- `CHANGELOG.md` `[Unreleased]` › `Added`: pending changes kept across sessions per git worktree, live sessions sharing one list, the two settings.
- `ROADMAP.md`: remove "Keep pending changes across sessions" from Now.
- Delete this plan and the spec in the ship commit.

### Commits
Each one needs your approval.

1. `docs(plans): plan keep-across-sessions`: this plan, renamed, plus the spec updated (Status Approved, the plan link, the open questions resolved, the criterion 16 wording, the ref names).
2. `feat(persist): keep pending changes across sessions`: `plugin.json`, `types/index.d.ts`, `hooks/persist.ts`, `hooks/register.tsx`, `hooks/pending-changes.test.ts`.
3. `docs(spec): merge keep-across-sessions into the SPEC`: `docs/SPEC.md`, `README.md`, `CHANGELOG.md`, `ROADMAP.md`, with the spec and plan deleted.

### Verification
- `claude plugin validate .` (accepts the `userConfig`) and `claude plugin test .` (the whole suite, old and new).
- Manual, on Windows, in this repo:
  1. edit a file through Claude, `/exit`, `claude` again: it's listed with an `earlier` tag, Claude gets the resume note, and ✗ restores it;
  2. two sessions side by side: an edit in one shows in the other within about 2 s with `other session`, and a ✗ there reaches the first session's Claude;
  3. `/clear`: the list survives;
  4. `git for-each-ref refs/pending-changes/` shows one tree ref, `git log --all` and `git status` are clean, and after ✓ all plus `git gc --prune=now` the tree is empty;
  5. `/config`: with `openOnStart` set to `toast`, a restart toasts instead of opening the pane; with persistence off, a restart starts empty.
- After approval, offer to delete the throwaway research mods `pc-probe` and `pc-kit` in `C:\Users\Haris\.claude\dev-mods\ac355c16-8166-4991-9b11-6fd377482565\`.
