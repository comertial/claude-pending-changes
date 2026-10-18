# pending-changes: behaviour spec

This file describes how the mod behaves **now**, and it is the source of truth for every feature, bug fix and research spec in [`docs/specs/`](specs/README.md). It is edited in place when a change ships, so it always describes the current product, not its history. Shipped changes are recorded in the [CHANGELOG](../CHANGELOG.md), and the reasoning behind them in [Design decisions](#design-decisions).

The [README](../README.md) is the user-facing summary of the same behaviour. It can be less detailed than this file, but it must never contradict it.

## Contents

- [Behaviour](#behaviour): the pane, the diff view, what gets tracked, across sessions, keeping Claude in sync, limitations
- [Under the hood](#under-the-hood): state, hooks, line counts, settling and refresh, shell tracking, accept and reject, temp files, persistence, file layout
- [Design decisions](#design-decisions): the lasting rules, and the ideas they rule out
- [Tests](#tests): what the suite covers

---

## Behaviour

### The pane

It opens on its own the first time Claude changes a file in the project, or any time with **`/changes`**.

| | Where it shows |
| --- | --- |
| **`/changes`** | At any width: docked beside the chat on a wide fullscreen terminal (110+ columns), otherwise below the chat, above the prompt. |
| **On its own** | Claude Code only seats a pane a mod opens unprompted from 144 columns (110 once you've opened it with `/changes`, until you close it by hand). On a narrower terminal it waits, and a toast tells you to run `/changes`: on the first change of a batch, and at session start when files are still pending. No toast is shown when the pane can be seated. |
| **At session start** | With files pending, `openOnStart` decides: `auto` (the default) opens the pane as above; `toast` only shows the "N files still pending review" toast, at any width. At most one toast per start: a change Claude makes while the list is still loading doesn't add the first-change toast. Entries arriving from other sessions never open the pane or toast, and the reload after `/clear` is quiet. |

| Element | What it does |
| --- | --- |
| **File row** | File name, then its status right after it: a green `added` (underlined name) for files Claude created, a yellow `modified` (italic name) for files Claude edited, or a red `deleted` (struck-through, dim name) for files Claude deleted. Then green `+added` and red `-removed` counts. The name style keeps the status readable without colour. |
| **File name (click)** | Opens the VS Code diff for that file. Without `code` on PATH, a toast says VS Code couldn't be opened. |
| **✓ on a file** | Accepts: removes it from the list. The change is already on disk, so nothing else happens, and Claude is told nothing. |
| **✗ on a file** | Rejects: restores the original, deletes a file Claude created (plus any now-empty folders Claude created), or recreates a file Claude deleted. Then Claude is told. |
| **Folder row** | Bold colored name with ▾ (expanded) or ▸ (collapsed), plus the combined counts of everything under it. |
| **Folder name (click)** | Collapses or expands it. The state survives mod reloads. |
| **✓ / ✗ on a folder** | Accepts or rejects every file under it, including subfolders, and nothing outside it. |
| **Accept all / Reject all** | The same for every file in the list. |
| **Hover** | The row under the mouse gets a grey background, so it's clear which ✓/✗ belongs to which file. |
| **Origin tag** | With persistence on, a dim `other session` after the status of a row owned by another live session, or `earlier` for one whose owner has ended. This session's rows have none. |
| **Branch tag** | A dim `other branch` on a row recorded while another branch was checked out. |
| **Footer** | A dim "N more pending outside this folder" when the worktree has pending entries outside this session's working directory. They can't be acted on from here. |

A ✓ or ✗ on a row another session recorded a change to since the pane drew it (a newer record, another owner, or a deletion) does nothing; the pane redraws and a toast says "`X` changed in another session; check it again." Line counts alone don't count, since the user's own edits move them.

**Layout:** folders come before files, each sorted by name. A folder containing only one other folder is merged into one row (`▾ demo/config/`), like VS Code's compact folders. Dim `├─` `└─` `│` guides show nesting below the top level. Long names are trimmed from the left with `…`.

### The diff view

Clicking a file runs `code --diff <original> <file>`:

- **Left (read-only):** a temp copy of the file before Claude touched it (empty for a new file).
- **Right (editable):** your real project file (an empty stand-in for a deleted file).

Revert single blocks with the gutter arrow between the sides (VS Code calls it "Revert Block"; it copies the original block back over Claude's version), edit the right side by hand, and save. Saves go straight to your project file. Within about 2 seconds:

- the pane's line counts update;
- if you reverted **every** block of an existing file, it matches its original, drops off the list, its temp copy is removed, and Claude is told you reverted it;
- if you reverted **every** block of a **new** file (leaving it empty), it counts as a reject: the file and any now-empty folders Claude created for it are deleted, and Claude is told. The exception is a file Claude itself created empty (an `__init__.py`, say), which stays listed.

### What gets tracked

Only files **inside the session's working directory**. Scratch scripts in temp folders and files elsewhere are ignored.

| Source of the change | How it's caught |
| --- | --- |
| Claude's **Edit**, **Write**, **NotebookEdit** | Directly: each call is hooked, the file's original is saved before the first touch, and the diff is recomputed after. |
| Claude's **Bash** / **PowerShell**, in a git work tree | `git status` before and after each command that might write. Edits, new files, deletions, renames (shown as delete + new), `git checkout`/`restore`, formatters, codegen, `npm install`, scripts. How the command is written doesn't matter. |
| Claude's shell commands, **outside** git | Only files already in the list, plus plain deletes of named files: `rm`, `del`, `erase`, `Remove-Item`, `ri`. |
| **Your own edits** to a listed file | The 2-second refresh updates the counts, and Claude is told on your next message. |

Not tracked: gitignored files (`node_modules`, build output, `.env`), files outside the project, and your edits to files that aren't listed.

**Multi-round changes.** The original is saved the **first** time Claude touches a file; later edits, in the same turn or later ones, add to the same diff. The pane always shows the **net** change from that first original, so a file Claude changes and then changes back disappears. Files stay listed across prompts until you resolve them. If you had already changed a file before Claude's shell command touched it, *your* version is its original.

### Across sessions

In a git work tree, the list is kept per **worktree** and shared by every session in it. Outside git, or with `persistAcrossSessions` off, the list is per session, as below in [Limitations](#limitations).

- **Resuming.** A new session, `/clear` and `--resume` load the worktree's list before their first writing tool call or prompt is handled; session start waits for it (about 3–4 git calls, once per session). Every entry is re-settled against its original: one back at it drops off and releases its original. Claude gets one note listing the files with unreviewed changes from earlier sessions.
- **Live sessions.** Whatever one session records, resolves or re-settles shows in the others within about one refresh (2 s).
- **First original.** An entry's original is the one recorded at the first Claude touch since the file was last resolved, whichever session recorded it. A later record can change its owner and counts, never its original. A file you accepted or rejected stays resolved in every session, including after the session that resolved it ended. Before Claude's writing tool picks an original, and before a prompt is handled, the session reads any other session's records that changed.
- **Ownership.** Each entry is owned by the last Claude session that changed it; the pane tags rows of other owners (see [The pane](#the-pane)).
- **Live, ended and busy.** Each session writes a heartbeat every 2 s. From the start of one of its Claude's writing tools until that change is in its record, including tools that are denied, fail or change nothing, the heartbeat says it's busy.
  - A session counts as **ended** when its record has an end marker newer than its heartbeat (or within 1 s of it), or its heartbeat is older than 30 s. A session whose own last heartbeat is older than 30 s (the machine slept) doesn't judge others on that tick. A `--resume`d session clears its end marker and is live again.
  - While another live session is busy, and for one refresh after, a session doesn't report hand edits or reverts and doesn't treat a file as reverted or emptied. It only updates counts.
  - An ended session's records are folded into a live session's only when it has an end marker, or its heartbeat (or, without one, its record) is older than 24 hours.
- **Shell commands beside other sessions.** A file another session recorded while this session's shell command ran, or that holds what another session's Claude last saw, stays that session's. A file accepted elsewhere during the command and then changed by it takes the accepted content as its new original.
- **One session in two windows.** If the same session id is open in two processes, the one started later runs session-only, never writes the shared record, and a toast says "This session is open in another window too; pending changes here aren't shared." It takes over once the first one's heartbeat is 30 s old, keeping what its Claude changed meanwhile.
- **Branches.** Each record notes the branch checked out (during a rebase, the branch being rebased). Rows recorded on another branch carry the `other branch` tag; ✗ still restores the original they were recorded against.
- **Failures.** A failed write (hashing, the record or the pin) is retried with backoff; the session stays live and keeps receiving other sessions' records. After five failures in a row its heartbeat says it's detached, and the others still treat it as a live owner. Only when it can't write its heartbeat does it turn session-only. In every case the refresh, counts and notes for its own list keep working.

**Settings** (`/config`):

| Field | Type | Default | Effect |
| --- | --- | --- | --- |
| `persistAcrossSessions` | boolean | on | Off: no persistence, no shared list, the per-session behaviour. Already persisted data is left in place; turning it back on picks it up, minus what this session resolved meanwhile. |
| `openOnStart` | `auto` \| `toast` | `auto` | Whether the pane opens on its own at session start when files are pending. |

### Keeping Claude in sync

Notes are delivered to Claude as hidden context (Claude reads them; your chat doesn't show them), at whichever comes first: **the next tool result** if Claude is mid-task, or **your next message**.

| Event | Note Claude receives |
| --- | --- |
| You reject a change | "The user rejected your changes to `X`: it is back to its content from before you edited it. Re-read it before editing it again." |
| You reject a new file | "The user rejected your new file `X`: it has been deleted." |
| You reject a deletion | "The user rejected your deletion of `X`: it has been restored." |
| You revert every block in the diff | "The user reverted all your changes to `X`…" (or the new-file rejection above) |
| You edit a listed file yourself | "The user modified `X` after your last edit; re-read it before editing it again." |
| You delete a listed file yourself | "The user deleted `X` after your last edit." |
| You accept | Nothing. |

Across sessions, a note always goes to the Claude whose change it is about, in whichever session it runs:

| Event | Who is told | Note |
| --- | --- | --- |
| A session starts with entries left by earlier sessions | that session's Claude, at the first tool result or prompt, once | "These files have unreviewed changes from an earlier session: `a`, `b`, … They are listed in the review pane." |
| Another session's Claude edits a file this session owns | this session's Claude | "`X` was since edited by another Claude session; the user's decisions on it go to that session now." |
| You reject, revert or hand-edit a file owned by another live session | that session's Claude | the reject, revert or edit note above |
| You reject a file whose owner has ended | the Claude of the session where you clicked | the reject note |
| You hand-edit, or revert in the diff, a file whose owner has ended | every live Claude that got the file in a resume or handover note | "`X`, changed in an earlier session, was modified by the user; re-read it before editing it." / "The user reverted `X`, changed in an earlier session, to its original; re-read it before editing it." |

These notes travel in the records themselves: a reject or revert is a resolve record naming its kind and owner, and a handover is a newer record with another owner. The owner's session tells its own Claude when it reads them, naming the file relative to its own working directory, so two sessions that see the same revert send one note. A reject recorded for a live owner that ends, or is folded away, without having read it is told once to the Claude of the session where you clicked.

"You modified" notes come from comparing each file's current content to `lastSeenByClaude` when you send a message; each change is reported once. A change Claude made itself, including a deletion, is never reported back as yours. As a backstop, Claude Code's Edit tool already refuses to edit a file that changed since Claude last read it.

### Limitations

- **Gitignored files** and files outside the project are never tracked, by design.
- **Non-git folders:** shell commands are tracked only for files already in the list and for plain `rm`/`del`/`Remove-Item` of named files. Edits and new files made by shell commands are missed, as are deletes using globs or variables, inside scripts, or of whole folders.
- **Committed inside one command:** a clean file that is changed **and committed** within a single command never shows in `git status`, so it's invisible.
- **Dirty-file snapshot cap:** at most 500 already-changed files are saved before a shell command. In a repo with more uncommitted changes than that, the rest have no "before" content.
- **Concurrent edits:** if you save a file in VS Code while one of Claude's shell commands is running, the change is attributed to Claude. It still shows up for review.
- **The 2-second refresh** reads every listed file each tick, plus the shard folder's listing and the shards that changed. Fine for normal use; hundreds of large files would make it heavier.
- **Collapsed folders are remembered by path:** a folder that disappears and later comes back reappears collapsed.
- **No persistence outside git**, or with `persistAcrossSessions` off: there a new session starts with an empty list, and pending changes from a previous session are just files on disk.
- **Large originals:** an original too large to come back through `git cat-file` (`process.run` returns at most 4 MiB) stays in its session only.
- **`$.state`'s cap:** the list holds at most about 4 M characters. Entries from other sessions that would pass it are left out of this session's pane, with one toast; they stay persisted and other sessions still list them.
- **Copying the whole repo:** `git push --mirror`, a `refs/*:refs/*` refspec, `git clone --mirror` and `git bundle create --all` copy `refs/pending-changes/*`, and the originals with it. `git fast-export --all` (and `git filter-repo`) warns about the ref. Ordinary push, `--all`, `--tags` and clone don't.
- **Non-UTF-8 files** stay lossy until [#3](https://github.com/comertial/claude-pending-changes/issues/3) is fixed.
- **Crashes:** a crashed session counts as ended only after 30 s, and is folded in after 24 hours.
- **One machine:** sessions on one worktree must share a machine and clock.
- **Branch switches:** pending changes outlive them. Rows from another branch are tagged, but ✗ still restores the original they were recorded against.
- **Shell commands beside other sessions:** if another session's Claude changes a file during this session's shell command and hasn't written its record by the time the command ends, this session claims the change as its own Claude's. It is still listed for review.
- **Other tools:** only VS Code's `.git` watcher was checked. Other watchers (JetBrains, `core.fsmonitor`) and history rewriters run with `--all` or `--everything` (`git filter-branch`, `git lfs migrate`) weren't, and may react to the shard folder or trip over a ref that points at a tree.
- **Untestable timing:** the fix for the refresh race (see [Settling and the 2-second refresh](#settling-and-the-2-second-refresh)) can't be covered by a test, because the test kit doesn't run the timer in the middle of a tool call. It's reasoned from the code.

---

## Under the hood

The mod is one hooks module (`hooks/register.tsx`) plus pure helper files. It runs inside Claude Code's plugin environment, which has no Node or DOM; everything outside the module is reached through the engine interface `$` (`$.fs`, `$.process`, `$.state`, `$.ui`, `$.clock` and so on).

### State

All state lives in `$.state` (the session's state, which survives a mod reload), declared in `types/index.d.ts`:

| Value | Type | Purpose |
| --- | --- | --- |
| `files` | `Record<key, Tracked>` | One entry per pending file, keyed by its normalized absolute path (lower-cased on Windows). |
| `notices` | `string[]` | Notes waiting to be delivered to Claude. |
| `collapsed` | `string[]` | Folders collapsed in the pane, by path relative to the working directory. |
| `outside` | `number` | Pending entries in the worktree outside the working directory, for the footer. |
| `sessions` | `Record<id, 'live' \| 'ended'>` | Other sessions in the worktree, for the origin tags and routing. |
| `loadedFor` | `string` | The session id the persisted list was last loaded for. |
| `resumeNoted` | `string[]` | Session ids whose Claude has had the resume note. |
| `knows` | `Record<key, string \| null>` | Files this Claude was told about in a resume or handover note, with the text it was told about. |
| `resolvedWhileOff` | `Record<gitKey, { at, rel }>` | Files resolved while persistence was off, tombstoned when it's turned back on. |
| `instance` | `string` | This process's id, telling a second process under the same session id apart; it encodes when it was made. |
| `branchNow` | `string` | The branch checked out now, for the `other branch` tag. |

`$.state` is reset by `/clear` (the new id starts empty) and survives a reload; module variables are the other way round. The persistence code keeps its runtime in one module object and rebuilds it from disk through `ensureLoaded`, which runs `load` when either the module or `loadedFor` doesn't match the current id.

A `Tracked` entry holds:

- `path`: the absolute path.
- `rel`: the path relative to the working directory.
- `original`: the text before Claude's first touch, or `null` if Claude created the file.
- `added` and `removed`: the line counts.
- `lastSeenByClaude`: the text right after Claude's last change, or `null` if that left the file deleted.
- `isDeleted`: set while the file is gone from disk.
- `createdDirs`: for a new file, the folders it caused to be created, outermost first.
- `review`: set once a diff has been opened; holds the temp original's path.
- With persistence: `owner` (the session whose Claude last changed it), `gitRel` (the path relative to the worktree root, case kept), `at` (when the record it reflects was made), `branch`, and `sessionOnly` (never persisted: too large, or a failed write).

The pane is drawn from this state, so any write to it redraws the pane automatically.

### Hooks

| Hook | Role |
| --- | --- |
| `session.start` | Registers `/changes`, starts the refresh timer, sweeps stale temp folders, waits for the persisted list to load, then opens the pane (or toasts, per `openOnStart`) if files are pending. |
| `session.end` | Writes this session's record with its end marker first, then, within the hook's time limit, the rest of the flush (skipping git work with under 500 ms left); then deletes this session's temp folder. A second window writes nothing. |
| `command.run` (`/changes`) | Opens and focuses the pane. |
| `tool.call` | The core. For Edit/Write/NotebookEdit it saves the original before the call and settles the entry after it. For Bash/PowerShell it takes a git snapshot before and compares after. A writing call first waits for the load, reads other sessions' changed records and marks the heartbeat busy; after it, it reads them again before settling. It also delivers queued notices to Claude alongside the tool result, and starts the flush without waiting for it. |
| `prompt.submit` | Waits for the load and reads other sessions' changed records, then delivers queued notices, plus "you modified X" notes for files you edited, as hidden context on your next message. |
| `command.run` (`__pending-changes-reload`) | A test seam, never registered as a command and inert unless `PENDING_CHANGES_TEST=1`: resets the module's state as a reload would, keeping `$.state`, and can change the settings. |
| `ui.render` (`Pane`) | Draws the tree. |

### Line counts

`countChanges(before, after)` in `hooks/diff.ts` runs a hand-written Myers O(ND) line diff:

1. It splits both texts into lines on `\r?\n`, so CRLF vs LF doesn't matter. A trailing newline doesn't count as an extra line.
2. It trims the common prefix and suffix.
3. It finds the edit distance D.
4. It reports `added = m - common` and `removed = n - common`, where `common = (n + m - D) / 2`.

It's written by hand because npm packages aren't available in the mod environment. Past 20,000 edits it falls back to treating all remaining lines as changed.

### Settling and the 2-second refresh

Every place that observes a file's current content calls `settle(key, base, current, seenByClaude)`:

- **If `current === original`**, the entry is dropped: nothing left to review.
- **Otherwise** the counts are recomputed and the entry is written, including `isDeleted` when `current === null`. If nothing visible changed, it skips the write, so the pane doesn't redraw for nothing.

`ensurePolling()` starts a `$.clock.every(2000)` timer. It's called from **every** hook, not just `session.start`, because a hot reload drops the old timer and doesn't always fire `session.start` again. On each tick, for each tracked file:

1. Re-read the file.
2. If it's a new file you emptied (and Claude didn't write it empty), treat it as **reject**.
3. Otherwise settle it. If it dropped (back at its original) and Claude didn't put it there, queue a "you reverted all changes" note for Claude.
4. A failure on one file skips just that file.

The refresh **pauses while any of Claude's writing tool calls is running** (the `toolsInFlight` counter). Otherwise it could see Claude's change half-done, for example a delete that landed before the after-command check, and report it as yours.

With persistence on, each tick first writes the heartbeat (before the `toolsInFlight` check, so a long command doesn't make the session look ended), then reads the shards that changed and applies other sessions' records, then runs the per-file loop above. The persistence steps have their own error handling, so a failure there never skips the per-file loop. While another live session is busy, and for one tick after, the loop only updates counts.

`settle` speaks for one of three sources: **Claude** (its tool: takes ownership and is recorded), **observed** (the refresh, a load, a prompt: keeps the owner and records only a drop), or **peer** (applies another session's record and records nothing). It keeps every persistence field of the entry it replaces.

### Tracking shell commands

For each Bash/PowerShell call, `tool.call` does this:

1. **Read-only check** (`hooks/commands.ts`, `isReadOnlyCommand`). If every part of the command (split on `&&`, `||`, `;`, `|`, newlines) starts with a known read-only verb (`ls`, `cat`, `grep`, `find`, `git log`/`diff`/`status`/`show`, `Get-Content`, `Get-ChildItem`, `Test-Path`, …) and nothing redirects (`>`), tees, `-exec`s or `-delete`s, nothing more is done.
2. **Before** (`beforeShell`):
   - Save the current content of every file already in the list.
   - Run `git status --porcelain -z --untracked-files=all` and save the content of every file it lists (capped at 500), i.e. the files that already differ from the last commit.
   - Outside git, save the targets of any delete commands instead (`deleteTargets`).
3. **Run the command.**
4. **After** (`afterShell`):
   - Run `git status` again.
   - The candidates are every file saved in step 2 plus every file in the new status.
   - Skip any file whose content is unchanged from the snapshot.
   - A file already in the list is settled with Claude as the author. If that puts it back at its original, its temp review copy is removed.
   - For any other changed file, take the original from the snapshot if one was saved. Otherwise read it from git with `git cat-file --filters HEAD:<path>`, which applies line-ending filters so it matches the working copy on Windows; a file git doesn't have counts as new.
   - For a new file, `shellCreatedDirs` works out which parent folders hold nothing git or the snapshot knows about, so a later reject can remove them.

Failed commands are still compared, because they may have changed files before failing.

### Accept and reject

- **Accept:** drop the entry and delete its temp review copy. The file on disk is already right.
- **Reject:**
  - If `original === null` (a new file), delete it, then delete the folders in `createdDirs`, deepest first, stopping at the first one that isn't empty.
  - Otherwise write `original` back. This also recreates a deleted file, and its folders.
  - Then drop the entry, clean up the temp copy and queue a note for Claude.
- **Folder ✓/✗:** run the same thing for every entry whose path starts with `folder/`.
- **With persistence:** every ✓ and ✗ first reads other sessions' changed records and skips a row whose record changed since it was drawn (see [The pane](#the-pane)). A resolve records a tombstone (`gone`, with `goneReason` `accepted` or `rejected`, the reject's kind and the owner) and releases the entry's originals. A reject of a file owned by another live session isn't noted here: that session tells its Claude when it reads the record.

`removePath` deletes through `$.process.run` (`cmd /c del`/`rmdir` on Windows, `rm -rf` elsewhere), because `$.fs` has no delete. It **refuses any path outside an allowed root**: the working directory for project files, the temp root for review copies.

**Folder ownership:** when Claude creates a file, the mod records which folders didn't exist yet. A folder created by an earlier pending write of Claude's also counts. So two new files in a new folder both "own" it, and rejecting both removes it. A folder that existed before is never removed.

### Temp files and cleanup

Review copies live in `%TEMP%\claude-pending-changes\<session id>\`, mirroring the project's folders:

- `<name>.original<ext>`: the left side of the diff.
- `<name>.deleted<ext>`: an empty right side for deleted files.

| When | What's deleted |
| --- | --- |
| A file is accepted, rejected, or drops off the list | Its `.original` copy and `.deleted` stand-in |
| The session ends (`/exit`, `/clear`) | The whole session folder |
| A session starts | Other sessions' folders older than 24 hours (in case of a crash) |

Persistence stages the texts it hashes in `%TEMP%\claude-pending-changes\<session id>.blobs\<flush>\`, outside the review copies (so a project folder named `blobs` can't collide), and deletes each flush's folder after hashing; `session.end` removes what's left.

A VS Code diff tab left open after its temp file is deleted shows the file as deleted.

### Persistence

Only in a git work tree, with `persistAcrossSessions` on, and with git new enough for `rev-parse --path-format=absolute`. One `git rev-parse --path-format=absolute --show-toplevel --git-dir --git-common-dir --show-object-format --show-prefix` names everything. `gitRel` is always the cwd's `--show-prefix` plus the cwd-relative path, never sliced from the top level, which may be the resolved form of a symlinked cwd.

**Originals** go into git's object store with one `git hash-object -w --no-filters --stdin-paths` over texts staged in temp files. **Pins:** one ref per worktree, `refs/pending-changes/main` or `refs/pending-changes/worktrees/<name>` (the name `%XX`-encoded outside `[A-Za-z0-9_-]`), points at a tree (`git mktree --missing`, never a commit) listing every original in use. `git gc` keeps what it reaches, and a rewritten tree releases what it no longer lists. Every update is a compare-and-swap (`update-ref <ref> <new> <old>`, the all-zero id to create it). A lost swap re-reads the tree and the shards and retries; after three, the update waits for the next tick. A stale `.lock` error backs off, and a `refs/pending-changes/*.lock` older than 5 minutes is deleted.

**Shards:** each session writes only its own record, in two alternating slots, `<git-dir>/pending-changes/<session id>.a.json` and `.b.json`, each write going to the other slot with `seq` one higher. A reader takes the parseable slot with the higher `seq`, so a write cut off half-way never leaves the only copy. A shard holds one event per path (keyed by `gitRel`, lower-cased on Windows):

- `at`, `by` (the session that wrote it), `owner`, `rel`, `branch`;
- a live event: `original` and `seen` blob SHAs (null = no file), the counts, `isDeleted`, `createdDirs`, and an optional `epoch`;
- a resolve: `gone`, `goneReason` (`accepted`, `rejected`, `reverted`, `settled`), the reject's kind, `rerouted`, and `unneededSince`.

**Heartbeat:** `<id>.alive` holds `{ busy, instance, detached? }`; its mtime is the beat. Heartbeat and shard files are created once per session and then only rewritten, which fires no event in VS Code's non-recursive `.git` watcher (creating or deleting one does).

**Merging, per path:** the latest resolve, or a live event's `epoch`, cuts off everything at or before it. Of the live events left, the latest gives the owner, `seen`, the counts and `rel`, and the earliest gives the original and `createdDirs`. A record that replaces this session's own resolve carries an `epoch` at it.

**Keeping shards consistent:**
- A session that reads another's resolve removes the path from its own shard (self-closing); a newer live record elsewhere doesn't, since the older one supplies the original.
- A session's own resolve is dropped once no other shard has held an older live event for that path for 24 hours.
- Folding: a shard with an end marker, or silent for 24 hours, is copied into a live session's (events still in use, and resolves still shadowing an older event; a path both hold takes the per-field merge), which is written first; then the folded files are deleted. A shard that disappears is never a resolve: its events stay until another shard or a resolve covers them. A shard that never parses ages by its listed mtime and is deleted after 24 hours.

**Flush** (single-flight, started after the hook's result, never awaited by a tool call): hash what's waiting (with backoff after a failure; a record waiting for a SHA is written as it was last written, or waits), write the shards (always, so resolves land even while hashing fails), then update the tree. Releases are taken before the tree step syncs the shards, so the merge already holds each one's resolve, and a release is skipped while any shard fails to parse. One lock keeps the slot and `seq` of concurrent writers apart.

**Load** (once per id and per load of the module): clear the list once per new id; seed this session's shard from disk (never rewritten from an empty list); spot a second window; clear an own end marker; tombstone what was resolved while persistence was off; read every shard; re-settle every entry; rebuild own records the disk lacks; count entries outside the cwd; queue the resume note. A sync failure leaves the load to run again at the next hook. **Reconcile**, never awaited, runs after every load: rebuild the tree, delete refs of worktrees whose git dir is gone, fold eligible shards, delete old heartbeats without a shard and stale locks.

**Blobs** that can't be fetched are retried only after 30 s. Peer entries enter the list only once their texts are fetched, and only while the list stays under `$.state`'s cap.

### File layout

```
pending-changes/
├─ .claude-plugin/
│  └─ plugin.json         # name, version, description, types, userConfig (persistAcrossSessions, openOnStart)
├─ assets/
│  └─ demo.gif            # the README demo
├─ docs/
│  ├─ SPEC.md             # this file
│  ├─ specs/              # specs for work in progress
│  └─ plans/              # plans for work in progress
├─ hooks/
│  ├─ hooks.json          # { "modules": ["./register.tsx"] }
│  ├─ register.tsx        # the hooks module: state, persistence, actions, polling, shell tracking, pane
│  ├─ persist.ts          # shard format, merge, liveness, folding, git text formats: pure, no host access
│  ├─ diff.ts             # Myers line diff: countChanges(), lines()
│  ├─ commands.ts         # isReadOnlyCommand(), deleteTargets(), words(): pure, no host access
│  ├─ ids.ts              # idOf(), folderId(): stable element keys for buttons
│  └─ pending-changes.test.ts  # tests run by `claude plugin test`
├─ types/
│  └─ index.d.ts          # the $.state contract: Tracked, Review, PluginState['pending-changes']
├─ CHANGELOG.md
├─ LICENSE               # GPL-3.0
├─ README.md
└─ ROADMAP.md
```

Inside `register.tsx` the sections are, in order:

1. context (cwd, OS, temp root, git root);
2. path helpers;
3. host I/O (`readOrNull`, `removePath`, `openInVsCode`);
4. state (`settle`, `forget`, notices);
5. persistence (records, hashing, shards, the tree, heartbeat, `syncPeers`, `applyMerged`, `ensureLoaded`/`load`, `reconcile`);
6. actions (`accept`, `reject`, `act`, `openReview`, folder helpers);
7. tree building (`treeRows`);
8. polling;
9. shell commands (`beforeShell`, `afterShell`, git helpers);
10. opening the pane (`openUnasked`, `startDecision`);
11. hooks.

---

## Design decisions

The lasting rules that every change must respect. Each one names the ideas it rules out, so they aren't proposed again. A change that breaks one must say so in its spec and get approval. Bugs fixed along the way belong in the CHANGELOG, not here.

1. **Changes go straight to disk.** Claude's edits are applied immediately, so builds, tests and Claude itself see them. ✓ only clears the record, and ✗ undoes the change. *Ruled out:* a staging area that holds changes until they're accepted, because Bash, grep and test runs would see stale files and Claude couldn't verify its own work.

2. **Standard diff orientation.** The original is on the left, your real file on the right, and reverting a block means rejecting it. Saves go straight to the file, so there's no separate "apply review" step. *Ruled out:* Claude's version on the left and the original on the right, so that pulling blocks in would feel like accepting them. VS Code's gutter button always says "Revert Block" and colours the sides by its own rules, and neither can be changed from outside.

3. **Claude never drifts.** Every reject, revert or hand edit queues a note for Claude, delivered at the next tool result or prompt. A change Claude made itself is never reported back as the user's. Across sessions, the note goes to the Claude whose change it is, in whichever session it runs.

4. **Scope: files under the working directory that git doesn't ignore.** A session reads the records of other sessions' entries outside its cwd only to count them for the footer, and to record that one dropped off when its file is back at its original; it never changes those files. *Ruled out:* tracking temp scripts Claude writes and then deletes (noise), and gitignored files or paths outside the project (slow and unpredictable).

5. **Net diffs only.** Every diff is measured from the original before Claude's first touch, so a file Claude changes and changes back drops off the list.

6. **Shell changes come from `git status` before and after.** It's fast because git keeps an index, it already skips ignored files, and it sees every change however it was made. *Ruled out:* copying the repo to compare (too slow on large repos) and parsing commands (misses scripts and tools). Outside git, only plain deletes of named files and already-listed files are caught.

7. **Stay fast.** No work on every refresh tick that scales with the size of the repo: the refresh only reads files already in the list, plus the shard folder's listing and the shards that changed (bounded by sessions, not the repo), and the read-only check skips `git status` for commands that can't write.

8. **Published through a shared marketplace.** This repository is the plugin alone. The catalog lives in [`comertial/comertial-mods`](https://github.com/comertial/comertial-mods), so later mods join the same `comertial-mods` marketplace and users add it only once.

9. **Every setting is a `userConfig` field** with a default, shown in `/config`, and covered by a test. Later settings (the snapshot cap, the diff tool) follow the same rule. *Ruled out:* settings in the mod's own store or in environment variables, which users can't find.

10. **Git work is batched and kept off the critical path.** One `hash-object --stdin-paths`, one `mktree` and one `update-ref` per flush, however many files, started after the tool result is returned. The only git calls a hook waits for are the one load per session and a fetch when a tool touches a file another session just recorded. *Ruled out:* git calls per file (about 77 ms each on Windows, 30 s for a command touching 200 files).

11. **The owner id is read at every write.** `/clear` switches the session id without raising `session.start`, so an id cached at start goes stale. *Ruled out:* caching the session id at start.

12. **One writer per shard; a merge never lets a later record replace an original.** Each session writes only its own record; readers merge them per path, taking the original from the earliest record since the last resolve and everything else from the latest, and a resolve is a record every shard closes against. *Ruled out:* latest-wins on the whole entry, which lets a session that hadn't seen another's record replace the real original; a shared file written by every session, which needs locks `$.fs` doesn't have.

13. **Originals are pinned by one tree ref per worktree in the shared `refs/pending-changes/` namespace.** *Ruled out:* `refs/worktree/*`, which gc from another worktree prunes, breaking the repo; one ref per blob, which costs a file per original and races on release; a commit, which shows in history views.

---

## Tests

`claude plugin test` runs `hooks/pending-changes.test.ts` against the real engine, with an in-memory host under the plugin. It mocks:

- **the file system:** files and folders with mtimes, a record of reads, and paths or listings that can be made to fail;
- **`process.run`:** `rm`, `code --diff`, and a fake **git** at `/repo` (by default; `outsideGit` opts out) whose HEAD you give per test, with an in-memory object store and refs: `hash-object`, `cat-file --batch` (with an output cap), `mktree`, `ls-tree`, `update-ref` with compare-and-swap (and lost swaps or a lock error on demand), `for-each-ref`, the combined `rev-parse`, and calls that can be held open;
- **the clock:** moved by hand;
- **the session:** a switchable id and `session.end`;
- **Edit/Write/Bash:** each Bash command runs a scripted change to the in-memory disk; a tool can be denied or fail, and a test can act in the middle of one.

Another session is simulated by what it leaves behind: its shard and heartbeat in the fake git dir and its blobs in the store. A hot reload goes through the mod's `__pending-changes-reload` test seam. Every pane, tree, folder, accept/reject, review and note test runs twice, in a git work tree (persistence on) and outside git.

This list is kept in sync with the suite by hand. What the tests cover:

- **Diff counts:** line counts; multi-round edits accumulating against the first original; a file edited back to its original dropping off.
- **Scope:** files outside the working directory are ignored.
- **Accept and reject:**
  - Reject all restores originals and deletes created files.
  - Accept all clears the list and sends no notes.
- **Diff view:**
  - It opens original-left, source-right, and saves update the counts.
  - Reverting every block drops the file and cleans its temp copy.
  - Emptying a new file rejects it, including its new folders.
  - A file Claude created empty is not rejected.
  - An existing file reverted to its original drops off and Claude is told.
  - Resolving a deleted file removes its empty stand-in too.
- **Notes to Claude:** the next prompt reports your edits, once.
- **Tree:** folders, merged chains and totals; tree guides; collapse and expand; a coloured status and matching name style on every file row.
- **Folder actions:**
  - Folder ✗ rejects its files and removes Claude-created folders, but keeps folders that already existed.
  - Folder ✓ accepts only that folder.
- **Refresh** runs even when `session.start` never fired.
- **Narrow terminals:** a toast says to run `/changes` when the pane can't be seated, once per batch and at session start; none when it is.
- **Shell tracking:**
  - read-only detection and delete-target parsing;
  - a committed file deleted by a command shows as deleted, and ✗ restores it;
  - a command that restores a listed file removes its review copy;
  - a command that rewrites a committed file and creates a new file in a new folder is fully caught;
  - a file you had already changed keeps *your* version as its original;
  - read-only commands run no `git status`;
  - outside git, `rm` is still caught;
  - Claude's own deletion is not reported back as yours.
- **Persistence, pure rules:** the merge (first original, latest everything else, resolves and epochs cut off); folding (a resolve that still shadows is kept, a collision keeps the folding owner); tombstones kept a day; worktree names made valid refs; `cat-file` output parsed to its last whole record.
- **Persistence, resuming:** an edit is listed after `/clear` with its counts, and ✗ restores the original from git; a new session lists an earlier one's entries; a file back at its original drops off and leaves the tree; `/clear` folds the old id's shard in; the resume note arrives once; a hand edit already reported isn't reported again after a resume.
- **Persistence, pinning:** hashing, a `mktree` tree and compare-and-swap with the zero id; lost swaps retry and keep every SHA; ✓/✗ release an original unless another entry shares it; one torn slot beside a good one doesn't block releases; a blob gc deleted doesn't stop new pins; a stale lock backs off, counts once, and an old lock is removed; worktree refs whose git dir is gone are deleted.
- **Persistence, other sessions:**
  - a new shard shows after one tick, and an unchanged one isn't read again; a half-written one keeps its last good content; one that never parses ages and is deleted after a day; entries of one that vanishes stay until covered;
  - a session in a subfolder lists only its entries, counts the rest, and Reject all leaves them;
  - origin and branch tags (a rebase keeps its branch);
  - ownership moves with a Claude edit, the old owner's Claude hears of the handover, and the first original is kept, including when the other session's record arrives mid-edit;
  - rejects of a live owner's file reach that owner; an ended owner's reach this Claude; a reject for an owner that ends or is folded away before reading it is told here once;
  - hand edits of an ended owner's file reach only a Claude that was told about it;
  - a file accepted in a session that ends and is folded stays resolved; after ✓, a new Claude edit keeps the accepted content as its original;
  - a file another session recorded during this session's shell command stays its; a file accepted elsewhere during the command takes the accepted content as its original;
  - while a peer is busy, the refresh neither rejects, drops nor reports; a half-written heartbeat doesn't change liveness;
  - a resumed session is live again; a silent session is folded only after a day; a missing own shard is rewritten;
  - a second window runs session-only, never writes the shared record (not even at its exit), takes over once the first stops keeping its Claude's changes, and isn't confused with a clean resume;
  - ✓ and ✗ on a row another session changed since it was drawn are refused with a toast;
  - entries that would pass `$.state`'s cap are left out with one toast; an unfetchable blob isn't asked for every tick.
- **Persistence, failures and lifecycle:** the tool call doesn't wait for git; the heartbeat says busy from a writing tool's start until its change is written, and clears after a denied, failed or no-op tool; failed hashing keeps the session live, still writes accepts and rejects, and reports itself detached after five; a failing shard folder doesn't stop the refresh; one failed listing at start still gives the resume note; an unreadable peer shard doesn't wipe the list; an edit during a held load after `/clear` takes the persisted original; `session.end` with git busy leaves a whole shard with the end marker; a hot reload never rewrites the shard from an empty list, keeps session-only entries, and still records a change made just before it; a large or multibyte file over the blob cap stays listed and session-only; a cwd reached through a link records paths from git's prefix.
- **Persistence, settings:** with persistence off nothing is written to the git dir or refs and a new session starts empty; off, ✓, back on keeps the file resolved; `openOnStart: toast` toasts without opening the pane; `auto` opens it, and `/clear` and other sessions' entries open nothing; an edit during the start load gives one toast; outside git nothing is persisted.

One quirk of the test kit: it hands the file-system hooks native Windows paths (`C:\repo\a.txt`), so the test host normalizes paths before using them.
