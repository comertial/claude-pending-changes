# pending-changes: behaviour spec

This file describes how the mod behaves **now**, and it is the source of truth for every feature, bug fix and research spec in [`docs/specs/`](specs/README.md). It is edited in place when a change ships, so it always describes the current product, not its history. Shipped changes are recorded in the [CHANGELOG](../CHANGELOG.md), and the reasoning behind them in [Design decisions](#design-decisions).

The [README](../README.md) is the user-facing summary of the same behaviour. It can be less detailed than this file, but it must never contradict it.

## Contents

- [Behaviour](#behaviour): the pane, the diff view, what gets tracked, keeping Claude in sync, limitations
- [Under the hood](#under-the-hood): state, hooks, line counts, settling and refresh, shell tracking, accept and reject, temp files, file layout
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

| Element | What it does |
| --- | --- |
| **File row** | File name, a `new` tag for files Claude created or a red `deleted` tag (struck-through, dim name) for files Claude deleted, then green `+added` and red `-removed` counts. |
| **File name (click)** | Opens the VS Code diff for that file. Without `code` on PATH, a toast says VS Code couldn't be opened. |
| **✓ on a file** | Accepts: removes it from the list. The change is already on disk, so nothing else happens, and Claude is told nothing. |
| **✗ on a file** | Rejects: restores the original, deletes a file Claude created (plus any now-empty folders Claude created), or recreates a file Claude deleted. Then Claude is told. |
| **Folder row** | Bold colored name with ▾ (expanded) or ▸ (collapsed), plus the combined counts of everything under it. |
| **Folder name (click)** | Collapses or expands it. The state survives mod reloads. |
| **✓ / ✗ on a folder** | Accepts or rejects every file under it, including subfolders, and nothing outside it. |
| **Accept all / Reject all** | The same for every file in the list. |
| **Hover** | The row under the mouse gets a grey background, so it's clear which ✓/✗ belongs to which file. |

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

"You modified" notes come from comparing each file's current content to `lastSeenByClaude` when you send a message; each change is reported once. A change Claude made itself, including a deletion, is never reported back as yours. As a backstop, Claude Code's Edit tool already refuses to edit a file that changed since Claude last read it.

### Limitations

- **Gitignored files** and files outside the project are never tracked, by design.
- **Non-git folders:** shell commands are tracked only for files already in the list and for plain `rm`/`del`/`Remove-Item` of named files. Edits and new files made by shell commands are missed, as are deletes using globs or variables, inside scripts, or of whole folders.
- **Committed inside one command:** a clean file that is changed **and committed** within a single command never shows in `git status`, so it's invisible.
- **Dirty-file snapshot cap:** at most 500 already-changed files are saved before a shell command. In a repo with more uncommitted changes than that, the rest have no "before" content.
- **Concurrent edits:** if you save a file in VS Code while one of Claude's shell commands is running, the change is attributed to Claude. It still shows up for review.
- **The 2-second refresh** reads every listed file each tick. Fine for normal use; hundreds of large files would make it heavier.
- **Collapsed folders are remembered by path:** a folder that disappears and later comes back reappears collapsed.
- **State is per session:** a new session starts with an empty list. Pending changes from a previous session are just files on disk, no longer listed.
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

A `Tracked` entry holds:

- `path`: the absolute path.
- `rel`: the path relative to the working directory.
- `original`: the text before Claude's first touch, or `null` if Claude created the file.
- `added` and `removed`: the line counts.
- `lastSeenByClaude`: the text right after Claude's last change, or `null` if that left the file deleted.
- `isDeleted`: set while the file is gone from disk.
- `createdDirs`: for a new file, the folders it caused to be created, outermost first.
- `review`: set once a diff has been opened; holds the temp original's path.

The pane is drawn from this state, so any write to it redraws the pane automatically.

### Hooks

| Hook | Role |
| --- | --- |
| `session.start` | Registers `/changes`, starts the refresh timer, sweeps stale temp folders, reopens the pane if files are pending. |
| `session.end` | Deletes this session's temp folder. |
| `command.run` (`/changes`) | Opens and focuses the pane. |
| `tool.call` | The core. For Edit/Write/NotebookEdit it saves the original before the call and settles the entry after it. For Bash/PowerShell it takes a git snapshot before and compares after. It also delivers queued notices to Claude alongside the tool result. |
| `prompt.submit` | Delivers queued notices, plus "you modified X" notes for files you edited, as hidden context on your next message. |
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

A VS Code diff tab left open after its temp file is deleted shows the file as deleted.

### File layout

```
pending-changes/
├─ .claude-plugin/
│  └─ plugin.json         # name, version, description, "types": "./types/index.d.ts"
├─ assets/
│  └─ demo.gif            # the README demo
├─ docs/
│  ├─ SPEC.md             # this file
│  ├─ specs/              # specs for work in progress
│  └─ plans/              # plans for work in progress
├─ hooks/
│  ├─ hooks.json          # { "modules": ["./register.tsx"] }
│  ├─ register.tsx        # the hooks module: state, actions, polling, shell tracking, pane
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
5. actions (`accept`, `reject`, `openReview`, folder helpers);
6. tree building (`treeRows`);
7. polling;
8. shell commands (`beforeShell`, `afterShell`, git helpers);
9. hooks.

---

## Design decisions

The lasting rules that every change must respect. Each one names the ideas it rules out, so they aren't proposed again. A change that breaks one must say so in its spec and get approval. Bugs fixed along the way belong in the CHANGELOG, not here.

1. **Changes go straight to disk.** Claude's edits are applied immediately, so builds, tests and Claude itself see them. ✓ only clears the record, and ✗ undoes the change. *Ruled out:* a staging area that holds changes until they're accepted, because Bash, grep and test runs would see stale files and Claude couldn't verify its own work.

2. **Standard diff orientation.** The original is on the left, your real file on the right, and reverting a block means rejecting it. Saves go straight to the file, so there's no separate "apply review" step. *Ruled out:* Claude's version on the left and the original on the right, so that pulling blocks in would feel like accepting them. VS Code's gutter button always says "Revert Block" and colours the sides by its own rules, and neither can be changed from outside.

3. **Claude never drifts.** Every reject, revert or hand edit queues a note for Claude, delivered at the next tool result or prompt. A change Claude made itself is never reported back as the user's.

4. **Scope: files under the working directory that git doesn't ignore.** *Ruled out:* tracking temp scripts Claude writes and then deletes (noise), and gitignored files or paths outside the project (slow and unpredictable).

5. **Net diffs only.** Every diff is measured from the original before Claude's first touch, so a file Claude changes and changes back drops off the list.

6. **Shell changes come from `git status` before and after.** It's fast because git keeps an index, it already skips ignored files, and it sees every change however it was made. *Ruled out:* copying the repo to compare (too slow on large repos) and parsing commands (misses scripts and tools). Outside git, only plain deletes of named files and already-listed files are caught.

7. **Stay fast.** No work on every refresh tick that scales with the size of the repo: the refresh only reads files already in the list, and the read-only check skips `git status` for commands that can't write.

8. **Published through a shared marketplace.** This repository is the plugin alone. The catalog lives in [`comertial/comertial-mods`](https://github.com/comertial/comertial-mods), so later mods join the same `comertial-mods` marketplace and users add it only once.

---

## Tests

`claude plugin test` runs `hooks/pending-changes.test.ts` against the real engine, with an in-memory host under the plugin. It mocks:

- **the file system:** files and folders;
- **`process.run`:** `rm`, `code --diff`, and a fake **git** whose HEAD you give per test;
- **the clock:** moved by hand;
- **Edit/Write/Bash:** each Bash command runs a scripted change to the in-memory disk.

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
- **Tree:** folders, merged chains and totals; tree guides; collapse and expand.
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

One quirk of the test kit: it hands the file-system hooks native Windows paths (`C:\repo\a.txt`), so the test host normalizes paths before using them.
