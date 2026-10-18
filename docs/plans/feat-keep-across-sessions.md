# Plan: Keep pending changes across sessions

**Status:** Approved
**Spec:** [`feat-keep-across-sessions.md`](../specs/feat-keep-across-sessions.md)

---

### Context
Today the pending list lives in `$.state`, so a new session, or `/clear`, loses every unreviewed change and its original, and ✗ is no longer possible. The research (`git show 3f1aaeb:docs/specs/research-keep-across-sessions.md`) settled the design: originals in git's object store, pinned by one tree ref per worktree, and the list in per-session shard files in the worktree's git dir. This plan builds it behind two `userConfig` settings, with today's behaviour unchanged when persistence is off or outside git.

An independent review of the first draft (commit `64274f8`) found that it carried single-session rules over to many sessions unchanged: "latest write wins", the `toolsInFlight` pause and "the current session". The **Multi-session model** below replaces them. A second review found that much of the persistence state was assumed to last as long as the session when it doesn't. A probe then showed that `$.state` is reset on `/clear` while module variables survive it, and that a hot reload is the opposite. **Lifetimes** below handles both. A third review found 25 more issues, mostly between live sessions: busy, liveness, attribution during shell commands, note paths and folding. They are folded in where each one belongs and tagged "review 3 #n". Every decision agreed in chat is in the spec's Decisions.

### Lifetimes
| State | Survives a reload (`/config`) | Survives `/clear` | Where it lives |
| --- | --- | --- | --- |
| `files`, `notices`, `collapsed`, `outside`, `sessions`, `loadedFor`, `resumeNoted`, `knows` | yes | no (new id, empty) | `$.state` |
| in-memory shard, tree cache, seen shard `mtimeMs`/`size`, `dirty`, `canRead`/`canWrite`, `loadPromise`, `loadedForModule` | no | yes | module |
| this session's shard, heartbeat, blobs, tree ref | yes | yes | git dir and object store |

**`ensureLoaded($)`** is the only entry point to persisted state. It is single-flight and runs `load` when `loadedForModule !== id` **or** `$.state.loadedFor !== id`, with `id = await $.session.id()`.
- Every hook calls it, and so do the pane's ✓/✗ actions, before they pick a base or change a record (review 2 #1). The ✓/✗ actions also run `syncPeers` first. If the entry changed since the pane drew it, they redraw and leave it unresolved, and a toast says "`X` changed in another session; check it again." (review 3 #18).
- After seeding, it rebuilds own events from `files` for every entry this session owns, under the size cap, that the disk shard lacks or holds an older event for, and marks the shard dirty (review 3 #11).
- On a fresh module it seeds the in-memory shard from this session's shard file on disk, so a reload never rewrites the record from empty.
- `flush` refuses to run until `ensureLoaded` has finished for the current id.
- **The `/clear` switch:** `session.end` freezes the old id's shard object with its end marker and flushes it. The next `ensureLoaded` sees the new id, starts a fresh shard object for it, and loads. The old object is dropped after its flush.

### Multi-session model
**Shard**: two alternating slots, `<gitDir>/pending-changes/<session id>.a.json` and `.b.json`, written only by that session. Each write goes to the slot not written last, with `seq` one higher. A reader takes the parseable slot with the higher `seq`, so a write cut off by an abort or caught half-way is never the only copy (review 2 #4, review 1 #9). Both slots are created once, at the first write.
```
{ v: 1, seq, session, endedAt?, endReason?,
  entries: { [gitKey]: Event },            // gitKey: gitRel, lower-cased on Windows
  instance,                                // per process, kept in $.state (review 3 #14)
  notes: { [toSession]: Note[] },          // Note = { id, gitRel, kind, fromClick }; text rendered at delivery (review 3 #5)
  delivered: string[] }                    // ids of notes this session delivered
Event = { at, by, owner, rel /* gitRel, case kept */, branch /* <gitDir>/HEAD contents */, gone?, goneReason?: 'accepted'|'rejected'|'reverted'|'settled',
          original: sha|null, seen: sha|null, added, removed, isDeleted?, createdDirs?: gitRel[] }
```
**Heartbeat** `<gitDir>/pending-changes/<session id>.alive` holds `{ at, busy }`. It is created once per session and then only rewritten, which fires no VS Code event (checked while planning). It is written only when persistence is on (`canRead`, see **Failures** below), and never for an id with `endedAt` (review 2 #9).
- **Reading it** (review 3 #6): `at` comes from the `mtimeMs` that `$.fs.list` already returns, never from the file's content. `busy` is read from the content. On an empty or unparseable read, the reader keeps the last good `busy` and doesn't mark the mtime as seen.
- **Leftovers:** reconcile deletes heartbeats older than 24 h that have no shard (review 3 #19).

**Branch** (review 2 #6) is read through `$.fs.read(<gitDir>/HEAD)`: `ref: refs/heads/x`, or a detached SHA. That's no git call, so it is cheap enough for every record and every tick. A merged entry whose `branch` differs from the current one gets the `other branch` tag. Commits on the same branch don't change it. During a rebase, `HEAD` is detached, so the branch is read from `rebase-merge/head-name` or `rebase-apply/head-name` when either exists (review 3 #21).

**Merge, per path** (`mergeShards`, pure):
- `G` is the latest `gone` event across all shards. The live events are those with `at > G.at`.
- With no live events the path is resolved. Otherwise the merged entry takes `owner`, `seen`, the counts, `isDeleted` and `rel` from the **latest** live event, and `original` and `createdDirs` from the **earliest** one (review 1).
- Ties are broken by session id.

**Keeping shards consistent:**
- **Self-closing** (review 2). When a session applies another session's `gone` for a path, it removes that path from its own shard at its next flush. A newer live event from another session doesn't remove it: the older event is what supplies the original.
- **Tombstone pruning.** A session drops its own `gone` only after no other shard has held an older live event for that path for 24 h (review 2 #5). The time it was first seen unneeded is kept on the event.
- **Notes.** The recipient adds a note's id to `delivered` when it **queues** the note, not when it delivers it (review 2 #10). The author drops a note once its id is in the recipient's `delivered`. The recipient drops an id from `delivered` once the note is gone from the author's shard (review 21).
- **Folding in** (compaction). A shard is folded in only if its end marker is newer than its heartbeat, or its heartbeat is older than 24 h (review 5). The folding session copies the shard's events verbatim (keeping `by` and `owner`) except those shadowed by a newer `gone`, copies `gone` events that still shadow an older live event elsewhere, and copies notes that are still undelivered.
  - **Order** (review 3 #7): write and **await** the folding session's own shard, then delete the folded shard and its heartbeat.
  - **A shard that disappears** is never a resolve. Readers keep its last known events until they appear in another shard or a newer `gone` shadows them. Entries leave only through a `gone`.
  - **On collision** with an event the folding shard already has for that path, the per-field merge rule applies: the earliest `original`/`createdDirs`, and the latest of everything else (review 3 #13).
  - Two sessions folding at once copy the same events, and the merge doesn't mind duplicates.
  - **When:** in reconcile, which now also runs after a `/clear` reload, quietly (review 3 #19).

**Live, ended, busy** (`liveness`, pure):
- **Live:** a heartbeat within 30 s, and no end marker newer than it.
- **Sleep guard:** a session whose own previous heartbeat is over 30 s old doesn't judge others on that tick.
- **Resume:** `load` clears its own end marker (review 4).
- **Busy** (review 3, review 2 #2): set and written, awaited (one plain file write, no git), when `toolsInFlight` goes 0→1, inside the `try`.
  - **Clearing** (review 3 #1): the `finally` of **every** writing call, including denied, erroring, no-op and throwing ones (the `return ran` at `:651` and the `.catch` at `:677` both pass through it), runs `void flush().then(clearBusyIfIdle)`. With nothing dirty, `flush` returns at once.
  - `clearBusyIfIdle` writes `busy: false` only when `toolsInFlight` is 0 and no flush is pending: shard first, then the heartbeat. Overlapping tools keep it set until the last flush is done.
  - Nothing here sits on the tool result's path.
  - A peer whose whole busy period falls between two ticks is therefore harmless. By the next tick its shard is written, and `syncPeers` runs before the per-file loop, so the loop compares against the peer's new `seen`.
  - The heartbeat is written **before** the `toolsInFlight` early return in `poll` (review 5).
  - While any live peer is busy, and for one tick after, `poll` only updates counts. It doesn't drop entries, reject emptied new files or queue revert notes.
  - `prompt.submit` runs `syncPeers` first. While a peer is busy, it holds back "user modified" notes until the next prompt and leaves `lastSeenByClaude` unchanged.

**Three kinds of settle** (review 11). `settle` keeps every field of the previous entry (`owner`, `originalSha`, `seenSha`, `gitRel`, `review`) and takes a `from`:
- `claude`: Claude's tool. Sets `owner = await $.session.id()` and records an event.
- `observed`: the poll, `load`, a user edit, or `prompt.submit`. Keeps the owner, and records an event only when the entry drops, as a `gone` with `goneReason: 'reverted'` or `'settled'`.
- `peer`: applies a merged change and records nothing, apart from self-closing.

**Notes** (`routeNote`):
- **Owner is this session:** the note is queued locally.
- **Owner is another live session:** the note goes into `notes[owner]` in this session's shard, with a deterministic id (`gitKey:kind:<at of the owner's last live event>`, the same in every session that sees it), so two sessions that see the same revert send one note. The owner delivers it once.
- **Owner has ended:**
  - for a ✗ click, the note goes to this session's Claude. Nothing is recorded after the `gone 'rejected'`, which carries `by` = this session. The entry is resolved, so there is nothing left to own (review 3 #8);
  - for a hand edit or a diff revert, every live session whose Claude **knows** the path gets the earlier-session note. Each session decides this for itself: it keeps `knows: Record<gitKey, seenText>`, filled when it delivers a resume or handover note. `prompt.submit` compares the file against the `knows` text, and when it applies a `gone` with `goneReason: 'reverted'` it sends the revert note.
- **A queued note whose owner has since ended** is re-routed only by its author, and only when `fromClick` is set: to the author's own Claude. Other queued notes are dropped, because the `knows` rule covers them (review 12).

**Concurrency inside one session:**
- `load`, `poll` and `flush` are each single-flight, and the `loading` flag is cleared in `finally` (review 10).
- Writing `tool.call`s and `prompt.submit` await `ensureLoaded` (review 7). This costs one load per session, about 3 to 4 git calls.
- Before a writing tool picks its base, `syncPeers()` lists the shards and reads the changed ones, a few ms (review 1). When the tool's targets include a peer entry whose original text isn't loaded yet, one `cat-file --batch` fetches it.

### Changes

**`.claude-plugin/plugin.json`**: add `userConfig`, copied from the research kit `pc-kit/.claude-plugin/plugin.json`:
- `persistAcrossSessions`: boolean, default `true`;
- `openOnStart`: string, options `auto` / `toast`, default `auto`.

**`types/index.d.ts`**:
- `Tracked` gains these optional fields: `owner`, `gitRel`, `originalSha`, `seenSha`, `branch`.
- `PluginState` gains:
  - `outside: number`;
  - `sessions: Record<string, 'live' | 'ended'>`;
  - `loadedFor: string`;
  - `resumeNoted: string[]`;
  - `knows: Record<string, string | null>`.

**`hooks/persist.ts`** (new, pure, like `commands.ts`):
- the `Shard`, `Event` and `Note` types;
- `mergeShards`, `liveness`, `selfClose` and `pruneShard` (tombstones, notes, delivered);
- `foldIn(ended, others)`;
- `noteId`;
- `treeInput(shas)`, de-duplicated (review 19);
- `parseCatFileBatch(stdout)`: walks UTF-8 byte lengths with `TextEncoder` and returns the complete records plus the unread SHAs. It stops at the last complete record (review 17);
- `encodeWorktreeName`: `%XX` for anything outside `[A-Za-z0-9_-]` (review 13);
- `refFor(gitDir, commonDir)`: `refs/pending-changes/main`, or `refs/pending-changes/worktrees/<encoded>`;
- `zeroId(format)` (review 19).

**`hooks/register.tsx`**: a new **persistence** section between *state* and *actions*.
- **Context.** `ctx` replaces `findGitRoot` (`:431`) with one call: `git rev-parse --path-format=absolute --show-toplevel --git-dir --git-common-dir --show-object-format --show-prefix` (review 13).
  - `gitRel` is always `<prefix><rel>`, where `rel` is relative to the cwd as today. It's never sliced from `--show-toplevel`, which may be the resolved form of a symlinked or junction cwd (review 3 #16).
  - A peer's path is rebuilt as `<gitRoot>/<gitRel>`.
  - It adds `gitDir`, `commonDir`, `ref`, `objectFormat` and `shardDir`.
  - If the call fails (git older than 2.31, say), `gitRoot` falls back to plain `--show-toplevel` and persistence is off.
  - `register(on, options)` keeps `options` in a module variable.
- **`canRead` / `canWrite`.** Both start true when persistence is on (`options.persistAcrossSessions !== false`) and there is a git dir. Every persistence step has its **own** try/catch, separate from today's poll loop, so a failure never stops today's behaviour (review 6). How each one changes on a failure is in **Failures** below.
- **`flush($)`**, started with `void` after the hook's result is built (criterion 17), single-flight, re-run while `dirty`. In order:
  1. **Hash.** Write every text with no SHA yet to `<tmpRoot>/<session id>.blobs/<flush n>/<i>`, run one `git hash-object -w --no-filters --stdin-paths`, and remove that flush's folder. It sits outside `sessionDir`, so a project folder named `blobs/` can't collide with review copies, and each flush has its own folder (review 3 #15 and #10). Texts over 4 MiB less 1 KiB are skipped, and their entries stay session-only (criterion 15).
  2. **Shard.** Write the shard from the in-memory object, which also carries `endedAt`/`endReason` (review 8).
  3. **Tree.** Run `syncPeers()` first, so releases use a fresh view (review 18). The new tree is `ls-tree` (or the cache), plus **every** SHA this session's own shard references, minus released SHAs that no merged entry uses (review 2 #3). Run `git mktree`, then `git update-ref <ref> <new> <old | zeroId>`.
     - A lost swap runs `syncPeers` and `git ls-tree <ref>` again and recomputes.
     - After three lost attempts, the tree update waits for the next tick rather than re-running at once, and nothing is dropped (review 19, review 2 #12).
     - A release is skipped while any shard failed to parse.
- **`load($)`**, single-flight, run on `session.start` and whenever `$.session.id() !== loadedFor`:
  1. `syncPeers` over every shard;
  2. clear its own end marker;
  3. fetch texts with `cat-file --batch`, continuing from the unread SHAs. A blob that can't fit on its own is dropped from the persisted view;
  4. drop entries whose blob is missing;
  5. re-settle each entry with `from: 'observed'`;
  6. **merge** entries under the cwd into `files` and count the rest in `outside`. An entry already in `files` with no record in any shard and no `gone` (session-only: too large, or a failed write) is kept (review 2 #8);
  7. queue the resume note for entries owned by ended sessions, and fill `knows`.
  8. When persistence was just turned back on, rewrite its own shard from memory. Tombstone only the paths under the cwd that this session resolved while it was off, stamped with the time of each resolve. `resolvedWhileOff: Record<gitKey, at>` in `$.state` records them (review 15, review 3 #12).
- **`reconcile($)`**, started with `void` after `load` on `session.start` only, never awaited:
  - rebuild the tree from the merged SHAs (CAS). If any shard failed to parse, it only adds and never removes (review 2 #3);
  - delete the refs of worktrees whose git dir is gone: `for-each-ref refs/pending-changes/worktrees/`, against `$.fs.list(<commonDir>/worktrees)`;
  - fold in eligible shards, deleting through `removePath` with `shardDir` as the allowed root. A session whose slots are both unparseable and whose heartbeat is over 24 h old is deleted without folding, and its SHAs are released at the next rebuild;
  - rewrite its own shard if it's missing (criterion 22).
- **`syncPeers($)`:**
  - `$.fs.list(shardDir)`, then re-read only the slots whose `mtimeMs` or `size` moved, taking each session's parseable slot with the higher `seq`;
  - on a JSON parse failure, keep the last good copy and don't record the new `mtimeMs`/`size` as seen (review 9);
  - apply the changes with `from: 'peer'`, fetching unknown SHAs in one batch. Self-closing marks this session's shard dirty;
  - a peer entry enters `files` only once its texts are fetched. If a fetch fails, or a blob is missing, the entry stays out until a later tick. An unknown original never becomes `null`, which `reject` (`:199`) would take for a new file and delete (review 3 #9);
  - a note addressed to this session is rendered at delivery from `gitRel` and `kind`, relative to this session's cwd (review 3 #5);
  - update `sessions`, deliver notes addressed to this session, and run the `knows` revert notes.
- **Poll** (`:386`):
  1. if `canRead` and the id has no `endedAt`, write the heartbeat, before line 387's `toolsInFlight` check;
  2. if `canRead`: `ensureLoaded`, then `syncPeers` and read the branch, in its own try/catch;
  3. today's per-file loop, with the busy-peer rule;
  4. failures in step 2 never skip step 3 (criterion 23).
- **`tool.call`** (`:613`):
  - decide `isWriting` **first**, from the tool name, the path and `isReadOnlyCommand`, before the base is computed. Today that's at `:622-633`, ahead of `:647` (review 2 #1);
  - for writing calls, await `ensureLoaded` and `syncPeers`, set busy (awaited write), and only then compute `tracked` and the shell snapshot;
  - Claude settles use `from: 'claude'`. A settle of a peer-owned entry moves the owner and routes the handover note into `notes[previous owner]`. An ended previous owner gets no handover;
  - `void flush`, which clears busy after it writes the shard;
  - **before every `claude` settle**, `tool.call` and `afterShell` run `syncPeers` again (review 3 #3, #4):
    - **A peer recorded the path during the command** (its event `at` falls within the command, or its busy period overlapped it), or the file's current content equals a peer's latest `seen` text: the change is the peer's. It's settled as `peer`, with no handover note.
    - **A `gone` for the path is newer than the moment the base was picked:** the base is re-picked. The new original is the content before the tool: `had.text` from the shell snapshot, or, for Edit/Write/NotebookEdit, the text read before the call. With persistence on, that text is now always read, which is one `$.fs.read`.
    - **Residual:** a peer whose shard hasn't landed by the end of the command can still be claimed. The spec's Limits document it.
  - `syncPeers` also fetches the `seen` texts it needs for that comparison.
- **`session.end`** (`:596`), all within `next.budget.remainingMs` (review 8, review 2 #4):
  1. set `endedAt`/`endReason` on the ending id's shard object;
  2. write the shard at once with the SHAs already known; entries still waiting to be hashed keep their previous event;
  3. with the budget left, the rest of `flush` (hash, shard again, tree);
  4. today's `removePath(sessionDir)` (`:599`) runs last, after the flush, together with `<tmpRoot>/<id>.blobs/`;
  5. `update-ref` is skipped when under 500 ms of the budget is left. The next session's reconcile pins what's missing (review 3 #17).

**One writer lock** (review 3 #10). `writeShard(obj)` is the only way to write a shard. It allocates the slot and `seq` at the start, under a lock it shares with `flush`, so a `session.end` write and an in-flight flush can't pick the same slot, and the higher `seq` always holds the newer content. The `flush` guard is keyed by shard object, not the current id, so a frozen old shard can still flush after `/clear`.

**Failures** (review 3 #2). `persistOk` is split in two:
- `canRead`: the heartbeat, `syncPeers`, delivering notes and `load`.
- `canWrite`: hash, shard and tree writes.

A failed write step sets `canWrite` false for that step, retries it after 1, 2, 4… ticks (at most 1 min apart), and leaves `canRead` alone, so the session stays live and keeps receiving notes. Only a failed heartbeat write or a failed `syncPeers` (the folder unreadable) turns the whole session session-only. After 5 failed write attempts in a row, the heartbeat gets `detached: true`, and peers route to that session like a live owner.

**Second process, same id** (review 3 #14). `instance` is a random id stored in `$.state` the first time a session loads, so it survives a reload and differs per process. A session that finds its own shard written by another `instance` with a live heartbeat goes session-only for its id. A toast says: "This session is open in another window too; pending changes here aren't shared."

**Ref lock** (review 3 #17). An `update-ref` that fails with `Unable to create '….lock'` isn't a lost swap. The tree step backs off like a failed write. A `refs/pending-changes/*.lock` older than 5 minutes is deleted from `commonDir` with `removePath`.

**`mktree`** (review 3 #25) runs with `--missing`, so a blob deleted by a user's gc doesn't fail every session's tree step. Load then drops entries whose blob is missing, as before.

**Torn slots** (review 3 #20). Every parse rule (releases skipped, a shard counted unparseable) is judged per session, by its better slot. One torn slot is never enough.

**`seen` persisted** (review 3 #24). When `prompt.submit` updates `lastSeenByClaude`, it records an `observed` event carrying the new `seen`, keeping the owner. A hand edit is therefore not reported again after a resume.
- **Routing.** `routeNote` replaces the direct `queueNotice` calls in `reject()` (`:207`), the poll's revert note (`:403`) and its emptied-file reject. `prompt.submit` (`:679`) reports only entries this session owns, plus the `knows` comparison.
- **Opening and toasts.** While `loading` is set, the `wasEmpty && !dropped` branches in `tool.call` (`:666`) and `afterShell` (`:559`) skip `openUnasked`. `peer` settles never trigger it. `load` from `session.start` ends with the start decision: `openOnStart === 'toast'` gives only the existing toast, otherwise `openUnasked`. `load` after an id change makes no start decision.
- **Pane** (`:707`):
  - after the status, a dim `other session` tag for a live peer owner, or `earlier` for an ended one, then a dim `other branch` tag when the entry's `branch` isn't the current one;
  - under the summary, a dim "N more pending outside this folder" when `outside > 0`.

**Reuse:** `removePath` (`:92`), `readOrNull`, `cleanupReview`, the `ctxPromise` caching, `isInside`, `keyOf`.

### Tests
Extend the `hooks/pending-changes.test.ts` host, seeded from `pc-kit/hooks/kit.test.ts`:
- **Disk:** `mtimeMs` per file, real `fs.list`/`fs.stat`, a record of `fs.read` calls, and `h.failFs(pathPrefix)` to make reads or lists throw.
- **Session:** a switchable `session.id`, a fake `session.end` with a `budget`, and `h.reload()`, which re-imports the module with `$.state` kept (or, if the kit can't reload, a test-only reset of the module variables exported from `register.tsx`).
- **Git store:**
  - `hash-object -w --no-filters --stdin-paths`, reading from `e.init.stdin`;
  - `cat-file --batch`, with an output cap `h.stdoutCap` to test truncation;
  - `mktree`, `ls-tree`, and `update-ref` with CAS, `-d` and the zero id;
  - `for-each-ref` and the combined `rev-parse`;
  - `h.gate` to hold git calls open, and `h.loseSwaps(n)`.
- **Peers:**
  - `peerShard(h, id, entries, opts)` writes a shard with a new mtime;
  - `peerAlive(h, id, { at, busy })` writes a heartbeat;
  - `h.onToolRun(fn)` injects a peer write partway through a tool call (review: one engine is one session).

New tests, one or more per acceptance criterion:

| # | Test |
| --- | --- |
| 1 | an edit is listed after `/clear` → s2, and in a fresh engine seeded with the shard and blobs; ✗ restores from the blob |
| 2 | on resume, a file back at its original drops off and its SHA leaves the tree |
| 3 | `hash-object -w`, a `mktree` tree, CAS on every `update-ref`, creation from the zero id; two lost swaps retry, a third re-queues, and both sessions' SHAs survive |
| 4 | ✓ and ✗ release the SHA unless another entry shares it; a peer entry with that SHA arriving just before the release keeps it pinned |
| 5 | a peer shard with a new mtime appears after one tick; an unchanged one isn't read again |
| 6 | a subfolder cwd lists only its entries and shows the footer; Reject all leaves the outside entry |
| 7 | `/clear` marks s1 ended in its shard, and later writes are owned by s2 |
| 8 | the resume note arrives with the first tool result, once |
| 9 | a Claude edit of a peer-owned file moves the owner and puts the handover note in this shard for the peer; a peer-addressed note in a peer shard is delivered here once |
| 10 | a ✗ on a live peer's file routes the note to the peer; with the peer stale or ended, it goes local and adopts; a queued click note for a peer that then ends is re-routed by its author |
| 10b | sleep guard: after a 60 s clock jump with its own heartbeat stale too, the peer isn't judged ended on the first tick |
| 11 | origin tags on peer and earlier rows only |
| 12 | persistence off: no `hash-object`/`update-ref`, nothing under `.git/pending-changes`, a new id starts empty |
| 13 | `toast` toasts without opening the pane; `auto` keeps today; an edit during a held load gives one toast; a peer entry gives none; `/clear` gives none |
| 14 | outside git, nothing is persisted |
| 15 | with `h.stdoutCap` small, the batch continues to the end; a blob larger than the cap is dropped from the persisted view and stays listed in the session that has it |
| 16 | the ref of a worktree whose git dir is gone is deleted, and the others are kept; a worktree name with a space gets an encoded, valid ref |
| 17 | with `h.gate` held, `$.tool.call` resolves, and the shard appears once it opens |
| 18 | a peer shard injected mid-tool (`h.onToolRun`) with the same path and an earlier `at` keeps the peer's original; the reverse order keeps this session's |
| 19 | A records, B accepts, B ends and is folded in, C starts: X stays resolved, and Reject all in C leaves the file alone |
| 20 | with a busy peer heartbeat, an emptied new file isn't rejected and no revert or edit note is queued, for that tick and one more |
| 21 | a peer shard with an end marker older than its heartbeat counts as live: not folded in, notes still routed to it; `load` for the same id clears the marker |
| 22 | a peer heartbeat 31 s old isn't folded in; one 25 h old is; a missing own shard is rewritten |
| 23 | with `h.failFs('/repo/.git/pending-changes')`, counts still refresh and a revert is still detected |
| 24 | after `/clear`, an Edit arriving during a held load gets the persisted original, not the disk content |
| 25 | `session.end` with a held flush waits for it within the budget, and the end marker is in the written shard |
| 26 | a half-written peer shard is ignored, its last good content kept, and it's re-read at the next tick |
| 27 | a hand edit to an ended owner's file is reported to a session that got it in a resume note, and not to one that didn't |
| 28 | persistence off, ✓, back on: the file stays resolved |
| 29 | reload: `h.reload()` resets module state; with `h.gate` holding the load, a ✓ and an Edit wait for it, and the own shard never shrinks |
| 30 | `h.onToolRun` lets a peer's busy period start and end between two ticks, and its shard lands after; no note and no reject on the next tick |
| 31 | reconcile while a peer slot is unparseable keeps the peer's SHAs; a peer flush after a rebuild that lost a swap re-pins its older SHAs |
| 32 | `session.end` with a held `hash-object` still leaves a parseable slot with the end marker, and `sessionDir` is removed after the flush |
| 33 | a peer entry recorded with `ref: refs/heads/other` shows `other branch` when `.git/HEAD` says `main`; one from `main` doesn't |
| 34 | a session-only entry (over the cap) survives `h.reload()` and a second `load` |
| 35 | test 19's fold, injected between this session's `fs.list` and its reads, doesn't bring X back while the tombstone is under 24 h old |
| 12+ | persistence off: the test also asserts that `.git/pending-changes/` doesn't exist |
| 36 | a denied Edit, an erroring Edit, a no-op Bash and a hook that throws each end with `busy: false` once the flush settles (review 3 #1) |
| 37 | a failing `hash-object` leaves the heartbeat advancing and a peer-addressed note still delivered; after 5 failures the heartbeat says `detached` (review 3 #2) |
| 38 | `h.onToolRun` injects a peer shard recording `x.ts` during a Bash that also sees `x.ts` change: the owner stays the peer and no handover note is queued (review 3 #3) |
| 39 | a peer `gone 'accepted'` injected during a Bash that then touches the file: ✗ restores the accepted content, not the old original (review 3 #4) |
| 40 | a session with cwd `/repo/sub` rejects a root session's `sub/a.ts`; the root session's Claude is told `sub/a.ts` (review 3 #5) |
| 41 | a truncated `.alive` file doesn't change liveness or busy (review 3 #6) |
| 42 | a list between a fold's delete and the folding shard's write leaves the entry listed (review 3 #7) |
| 43 | ✗ of an ended owner's file: the merged view has no live event for it afterwards, and no second note follows (review 3 #8) |
| 44 | a failing `cat-file` for a peer SHA keeps the entry unlisted, and Reject all leaves the file alone (review 3 #9) |
| 45 | with a held hash in flight, `session.end` leaves the higher-`seq` slot holding the end marker (review 3 #10) |
| 46 | a reload between a settle and its flush: the shard later holds the entry (review 3 #11) |
| 47 | off → on in a subfolder session keeps a folded entry outside the cwd (extends 28, review 3 #12) |
| 48 | folding an ended session's `X` into a shard with its own newer `X` keeps the folding session as owner (review 3 #13) |
| 49 | a shard of this id written by another `instance` with a live heartbeat turns this process session-only with the toast (review 3 #14) |
| 50 | a review of `blobs/a.txt` survives a flush (review 3 #15) |
| 51 | a host whose top level is the resolved form of the cwd still records the right `gitRel` (review 3 #16) |
| 52 | a fake `update-ref` failing with a lock error backs off instead of retrying every tick, and an old `.lock` is removed (review 3 #17) |
| 53 | ✓ on an entry a peer changed after the pane drew it leaves it unresolved and shows the toast (review 3 #18) |
| 54 | reconcile deletes an orphan heartbeat older than 24 h, and folds an ended shard after a `/clear` reload (review 3 #19) |
| 55 | one torn slot with a good sibling slot doesn't block releases (review 3 #20) |
| 56 | an edit during a rebase (`rebase-merge/head-name` present) isn't tagged `other branch` afterwards (review 3 #21) |
| 57 | a hand edit reported at a prompt isn't reported again after a resume (review 3 #24) |
| 58 | `mktree` with a missing blob still pins the rest (review 3 #25) |

**Existing tests** (review 2 #7). The host now defaults to a git work tree with the fake git store and an empty `head`, so persistence is **on** for the existing tests. Outside-git tests opt in with `{ outsideGit: true }`. Each existing pane, tree, folder, accept/reject, review and note test runs twice through a `for (const mode of ['git', 'outside-git'])` loop, and must pass unchanged in both modes: they are the guard for "this session's rows must not change". `a read-only command runs no git status` filters only for `status`. `resolving a deleted file's review…` asserts `ran.at(-1)` is `code --diff` (`pending-changes.test.ts:542`). In git mode it changes to find the last `code` call, because background flushes can run git after it (review 3 #23).

### SPEC merge
- **Behaviour › The pane:** the origin and `other branch` tags and the footer; the "on its own" row mentions `openOnStart`, one toast per start, silent peer entries and the quiet `/clear` reload.
- **Behaviour:** a new **Across sessions** subsection covering resuming, live sessions, the first-original rule, ownership, live/ended/busy, the settings and failures.
- **Keeping Claude in sync:** the new note rows and the routing rules, including `knows`.
- **Limitations:** replace "State is per session" with the spec's Limits list, and extend the 2-second refresh entry with shard reads.
- **Under the hood:**
  - a new **Persistence** section: the shard and heartbeat format, the merge rule, self-closing, pruning and folding in, the ref and tree, the flush order, CAS and re-queue, load and reconcile, the VS Code rule (per-tick writes only rewrite);
  - State, Hooks, Settling and refresh (heartbeat, busy, three kinds of settle), Accept and reject (release, routing), Temp files (`<tmpRoot>/<id>.blobs/`), File layout (`persist.ts`, `userConfig`, the `register.tsx` sections).
- **Design decisions:**
  - 9: every setting is a `userConfig` field with a default, shown in `/config` and covered by a test;
  - 10: git work is batched and kept off the critical path (rules out per-file git calls);
  - 11: the owner id is read at every write (rules out caching the session id);
  - 12: one writer per shard. A merge never lets a later record replace an original, and a resolve is a record that every shard closes against (rules out latest-wins on the whole entry);
  - 13: pins live in the shared `refs/pending-changes/` namespace (rules out `refs/worktree/*` and one ref per blob);
  - amend 4 with the outside-cwd note from the spec;
  - amend 7: the refresh reads the files in the list, plus the shard folder listing and the shards that changed. That's bounded by sessions, not the repo (review 3 #22).
- **Tests list:** a "Persistence" group mirroring the table above, plus the host additions under the mocks list.

### README check
- **Highlights:** reviews survive `/clear`, `/exit` and new sessions, and live sessions in one checkout share a list.
- **Using it:** the two settings in `/config`, and what the origin tags and the footer mean.
- **What gets tracked:** unchanged, plus a line saying the scope is still the cwd.
- **Keeping Claude in sync:** notes reach the Claude that made the change, in whichever session.
- **Limitations:** the spec's Limits list.
- **Troubleshooting:** the cleanup after uninstalling, `git for-each-ref --format="delete %(refname)" refs/pending-changes/ | git update-ref --stdin`, plus deleting the `pending-changes` folders in the git dirs.

### CHANGELOG / ROADMAP
- `CHANGELOG.md` `[Unreleased]` › `Added`: pending changes kept across sessions per git worktree, live sessions sharing one list, the two settings.
- `ROADMAP.md`: remove "Keep pending changes across sessions" from Now.
- Delete this plan and the spec in the ship commit.

### Commits
Each one needs your approval.

1. `docs(plans): plan keep-across-sessions`: done (`64274f8`).
2. `docs(specs): address the plan review for keep-across-sessions`: this plan and the spec, revised.
3. `feat(persist): keep pending changes across sessions`: `plugin.json`, `types/index.d.ts`, `hooks/persist.ts`, `hooks/register.tsx`, `hooks/pending-changes.test.ts`.
4. `docs(spec): merge keep-across-sessions into the SPEC`: `docs/SPEC.md`, `README.md`, `CHANGELOG.md`, `ROADMAP.md`, with the spec and plan deleted.

### Verification
- `claude plugin validate .` and `claude plugin test .` (the whole suite).
- Manual, on Windows, in this repo with VS Code open on it:
  1. edit through Claude, `/exit`, start again: listed with `earlier`, the resume note arrives, ✗ restores;
  2. two sessions: an edit shows in the other within about 2 s with `other session`; a ✗ there reaches the first session's Claude; a long `npm test` in one doesn't make the other report notes;
  3. `/clear`: the list survives, quietly;
  4. `/exit` then `--resume`: the other session still tags the rows `other session`;
  5. VS Code's Git output channel shows no status run every 2 s;
  5a. criterion 28's "on" half, which a test can't drive (options are fixed per test): turn `persistAcrossSessions` off in `/config`, ✓ a file another session also lists, turn it back on, and check the file stays resolved in both sessions;
  5b. hot reload, which the test kit can't drive (criteria 29 and 34, plan test 46). With two files pending, one of them a session-only entry (over 4 MiB in UTF-8), change a setting in `/config` mid-session, then ✓ the other file. Check that:
     - the shard on disk keeps every other entry and never shrinks (29);
     - the session-only file is still listed (34);
     - a file Claude changed just before the reload appears in the shard after the next refresh (46);
  5c. `git switch` to another branch: rows from the first branch show `other branch`;
  5d. assumptions the third review couldn't verify, each checked once against the design's fallback:
     - two processes, one rewriting `.alive` every 2 s while the other reads it in a loop: count the empty reads (#6);
     - `claude --resume <id>` of a session still open in another terminal: compare `$.session.id()` in both (#14);
     - a session started in a junction or symlinked folder: compare `git rev-parse --show-toplevel` with the cwd (#16);
     - kill `git update-ref` mid-run on Windows and check for a `.lock` (#17);
  6. `git for-each-ref refs/pending-changes/` shows one tree ref, `log --all` and `status` are clean, and after ✓ all plus `gc --prune=now` the tree is empty;
  7. `/config`: `toast` gives a toast on restart; persistence off starts empty.
- After approval, offer to delete the throwaway mods `pc-probe` and `pc-kit` (`C:\Users\Haris\.claude\dev-mods\ac355c16-8166-4991-9b11-6fd377482565\`), plus `pc-gitdir` and `pc-state` (`C:\Users\Haris\AppData\Local\Temp\claude\D--github-claude-pending-changes\c2bf5436-2878-47b0-bd79-0e3b20e945b6\scratchpad\`).
