# pending-changes

A Claude Code mod that adds a GitHub Copilot-style review flow for the files Claude changes. A docked pane lists the changed files as a tree with green/red line counts. You accept (✓) or reject (✗) changes per file, per folder or all at once. Clicking a file opens VS Code's side-by-side diff, where you can revert single blocks or edit by hand. Whatever you decide, Claude is told, so its picture of the code never drifts from what's actually on disk.

```
▾ demo/config/                        +4 -0  [ ✓ ] [ ✗ ]
└─ settings.json  new                 +4 -0  [ ✓ ] [ ✗ ]
▾ testFolder/                        +11 -1  [ ✓ ] [ ✗ ]
├─ ▾ sub/                             +7 -0  [ ✓ ] [ ✗ ]
│  ├─ deeper.json  new                +4 -0  [ ✓ ] [ ✗ ]
│  └─ notes.md  new                   +3 -0  [ ✓ ] [ ✗ ]
└─ test.txt                           +1 -1  [ ✓ ] [ ✗ ]
t̶e̶s̶t̶.̶j̶s̶o̶n̶  deleted                     +0 -3  [ ✓ ] [ ✗ ]

5 files  +15 -4                 [ Accept all ]  [ Reject all ]
```

---

## Contents

1. [Installation](#installation)
2. [Using it](#using-it)
3. [What gets tracked](#what-gets-tracked)
4. [How it works](#how-it-works)
5. [Keeping Claude in sync](#keeping-claude-in-sync)
6. [Temp files and cleanup](#temp-files-and-cleanup)
7. [Design decisions](#design-decisions)
8. [Limitations](#limitations)
9. [File layout](#file-layout)
10. [Development](#development)
11. [Tests](#tests)
12. [Troubleshooting](#troubleshooting)

---

## Installation

The mod is published through the [`comertial-mods`](https://github.com/comertial/comertial-mods) marketplace. In a Claude Code session:

```
/plugin install pending-changes --marketplace comertial/comertial-mods
```

Or from a shell, in two steps:

```bash
claude plugin marketplace add comertial/comertial-mods
claude plugin install pending-changes@comertial-mods --scope user
```

`--scope user` loads it in every session, in any project. Check it with `claude plugin list`, which should show `pending-changes@comertial-mods` with `Status: ✔ enabled`.

To update to a newer release: `claude plugin marketplace update comertial-mods`, then `claude plugin update pending-changes@comertial-mods`. To remove it: `claude plugin uninstall pending-changes@comertial-mods`.

Requirements:

- **VS Code's `code` command on PATH**, to open the diff view. Without it, clicking a file shows a toast.
- **git**, for tracking changes made by shell commands. Without it, only plain delete commands are tracked.
- **A terminal at least 110 columns wide** for the pane to dock beside the chat. It opens on its own once the terminal is 144 columns or wider. Below that it waits, and `/changes` opens it at any width.

---

## Using it

### The pane

The pane opens on its own the first time Claude changes a file in the project. You can also open it any time with:

```
/changes
```

| Element | What it does |
| --- | --- |
| **File row** | Shows the file name, a `new` tag for files Claude created, or a red `deleted` tag (struck-through name) for files Claude deleted, then its green `+added` and red `-removed` line counts. |
| **File name (click)** | Opens the VS Code diff for that file (see below). |
| **✓ on a file** | Accepts the change: removes the file from the list. The change is already on disk, so nothing else happens. |
| **✗ on a file** | Rejects the change: restores the original content, deletes a file Claude created (and any folders Claude created that are now empty), or recreates a file Claude deleted. Then Claude is told. |
| **Folder row** | Folder name in bold color with ▾ (expanded) or ▸ (collapsed), plus the combined counts of everything under it. |
| **Folder name (click)** | Collapses or expands the folder. The collapsed state survives mod reloads. |
| **✓ / ✗ on a folder** | Accepts or rejects every file under that folder, including subfolders. |
| **Accept all / Reject all** | The same for every file in the list. |
| **Hover** | The row under the mouse gets a grey background, so it's clear which ✓/✗ belongs to which file. |

Layout details:

- **Order:** folders come before files, each sorted by name.
- **Compact folders:** a folder that contains only one other folder is merged into a single row (`▾ demo/config/`), like VS Code's compact folders.
- **Tree guides:** dim `├─`, `└─` and `│` lines show nesting below the top level.
- **Long names** are trimmed from the left with `…`.

### The diff view

Clicking a file runs `code --diff <original> <file>`:

- **Left (read-only):** a temp copy of the file as it was before Claude touched it. For a new file it's empty.
- **Right (editable):** the real file in your project. For a deleted file it's an empty stand-in.

In VS Code you can:

- **Revert single blocks** with the arrow in the gutter between the two sides (VS Code calls it "Revert Block"). This copies the original block back over Claude's version.
- **Edit the right side by hand.**
- **Save.** Saves go straight to your project file.

Then, within about 2 seconds:

- the line counts in the pane update;
- if you reverted **every** block of an existing file, it matches its original again and drops off the list, and Claude is told you reverted it;
- if you reverted **every** block of a **new** file (leaving it empty), that counts as rejecting it: the file is deleted along with any now-empty folders Claude created for it, and Claude is told.

---

## What gets tracked

Only files **inside the session's working directory** are tracked. Scratch scripts in temp folders and files elsewhere are ignored.

| Source of the change | How it's caught |
| --- | --- |
| Claude's **Edit**, **Write**, **NotebookEdit** tools | Directly: the mod hooks each call, saves the file's original before the first touch, and recomputes the diff after. |
| Claude's **Bash** / **PowerShell** commands, in a git work tree | `git status` before and after each command that might write. Anything that moved is tracked: edits, new files, deletions, renames (shown as a delete plus a new file), `git checkout`/`restore`, formatters, codegen, `npm install`, scripts. How the command is written doesn't matter. |
| Claude's shell commands, **outside** git | Only plain delete commands on files: `rm`, `del`, `erase`, `Remove-Item`, `ri`. |
| **Your own edits** to a file that's already listed | The 2-second refresh updates the counts, and Claude is told on your next message. |

Not tracked: files git ignores (`node_modules`, build output, `.env`), files outside the project, and your edits to files that aren't in the list.

### Multi-round changes

The original is saved the **first** time Claude touches a file. Later edits, in the same turn or later turns, add to the same diff. The pane always shows the **net** change from that first original. If Claude edits a file and later changes it back, the file disappears from the list, because there's nothing left to review.

Files stay listed across prompts until you resolve them.

---

## How it works

The mod is one hooks module (`hooks/register.tsx`) plus pure helper files. It runs inside Claude Code's plugin environment, which has no Node or DOM. Everything outside the module is reached through the engine interface `$` (`$.fs`, `$.process`, `$.state`, `$.ui`, `$.clock` and so on).

### State

All state lives in `$.state` (the session's state, which survives a mod reload). It's declared in `types/index.d.ts`:

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

### The line counts (`hooks/diff.ts`)

`countChanges(before, after)` runs a Myers O(ND) line diff:

1. It splits both texts into lines on `\r?\n`, so CRLF vs LF doesn't matter. A trailing newline doesn't count as an extra line.
2. It trims the common prefix and suffix.
3. It finds the edit distance D.
4. It reports `added = m - common` and `removed = n - common`, where `common = (n + m - D) / 2`.

It's written by hand because npm packages aren't available in the mod environment. Past 20,000 edits it falls back to treating all remaining lines as changed.

### "Settling" an entry

Every place that observes a file's current content calls `settle(key, base, current, seenByClaude)`:

- **If `current === original`**, the entry is dropped: nothing left to review.
- **Otherwise** the counts are recomputed and the entry is written, including `isDeleted` when `current === null`. If nothing visible changed, it skips the write, so the pane doesn't redraw for nothing.

### The 2-second refresh

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
   - A file already in the list is settled with Claude as the author.
   - For any other changed file, take the original from the snapshot if one was saved. Otherwise read it from git with `git cat-file --filters HEAD:<path>`, which applies line-ending filters so it matches the working copy on Windows; a file git doesn't have counts as new.
   - For a new file, `shellCreatedDirs` works out which parent folders hold nothing git or the snapshot knows about, so a later reject can remove them.

Failed commands are still compared, because they may have changed files before failing.

Why this design: a full copy of the repo would be too slow for large repos, and parsing commands misses scripts and tools. `git status` is fast because git keeps an index, it already skips ignored files, and it sees every change regardless of how it was made.

### Accept and reject

- **Accept:** drop the entry and delete its temp review copy. The file on disk is already right.
- **Reject:**
  - If `original === null` (a new file), delete it, then delete the folders in `createdDirs`, deepest first, stopping at the first one that isn't empty.
  - Otherwise write `original` back. This also recreates a deleted file, and its folders.
  - Then drop the entry, clean up the temp copy and queue a note for Claude.
- **Folder ✓/✗:** run the same thing for every entry whose path starts with `folder/`.

`removePath` deletes through `$.process.run` (`cmd /c del`/`rmdir` on Windows, `rm -rf` elsewhere), because `$.fs` has no delete. It **refuses any path outside an allowed root**: the working directory for project files, the temp root for review copies.

**Folder ownership:** when Claude creates a file, the mod records which folders didn't exist yet. A folder created by an earlier pending write of Claude's also counts. So two new files in a new folder both "own" it, and rejecting both removes it. A folder that existed before is never removed.

---

## Keeping Claude in sync

Each note queued for Claude is delivered as hidden context. Claude reads it but it isn't shown in your chat. It goes out at whichever comes first:

- **the next tool result** in the current turn, if Claude is mid-task;
- **your next message.**

| Event | Note Claude receives |
| --- | --- |
| You reject a change | "The user rejected your changes to `X`: it is back to its content from before you edited it. Re-read it before editing it again." |
| You reject a new file | "The user rejected your new file `X`: it has been deleted." |
| You reject a deletion | "The user rejected your deletion of `X`: it has been restored." |
| You revert every block in the diff | "The user reverted all your changes to `X`…" (or the new-file rejection above) |
| You edit a listed file yourself | "The user modified `X` after your last edit; re-read it before editing it again." |
| You delete a listed file yourself | "The user deleted `X` after your last edit." |
| You accept | Nothing. |

The "you modified" notes come from comparing each file's current content to `lastSeenByClaude` when you send a message. Each change is reported once. As a backstop, Claude Code's Edit tool already refuses to edit a file that changed since Claude last read it.

---

## Temp files and cleanup

Review copies live in `%TEMP%\claude-pending-changes\<session id>\`, mirroring the project's folders:

- `<name>.original<ext>`: the left side of the diff.
- `<name>.deleted<ext>`: an empty right side for deleted files.

| When | What's deleted |
| --- | --- |
| A file is accepted, rejected, or drops off the list | Its `.original` copy |
| The session ends (`/exit`, `/clear`) | The whole session folder |
| A session starts | Other sessions' folders older than 24 hours (in case of a crash) |

A VS Code diff tab left open after its temp file is deleted shows the file as deleted; close the tab.

---

## Design decisions

Why the mod works the way it does, including the approaches that were tried and dropped.

1. **Changes on disk, Copilot-style.** Claude's edits are applied immediately, so builds and tests see them. ✓ only clears the record, and ✗ undoes the change. We considered holding changes in a staging area until accepted, and rejected it: Bash, grep and test runs would see stale files, and Claude couldn't verify its own work.

2. **Diff orientation.** We first tried Claude's version as the read-only left side and the original as the editable right side, so "pulling in" blocks would feel like accepting them. VS Code's gutter button always says **"Revert Block"**, colors the sides by its own rules, and none of that can be relabeled from outside. So we went back to the standard orientation: original on the left, your real file on the right, revert means reject. Saves go straight to the file, which made an extra "Apply review" step unnecessary.

3. **Claude must never drift.** Every reject, revert or hand edit queues a note, delivered at the next tool result or prompt.

4. **Only files under the working directory.** Temp scripts Claude writes and then deletes are noise.

5. **Net diffs only.** A file Claude changes and changes back disappears.

6. **Temp cleanup** is done per file, per session and by a 24-hour sweep.

7. **Tree view.** First a flat list. Then:
   - folders with combined totals and their own ✓/✗;
   - compact single-child folder chains;
   - collapse and expand by clicking the folder name, remembered in `$.state`;
   - bold colored folder names and dim tree guides, to tell folders from files.

8. **Empty-folder cleanup.** Rejecting new files removes the folders Claude created for them, once empty. This needed ownership shared across files in the same new folder (a bug caught by tests).

9. **Reverting a new file in the diff = reject.** Emptying a new file in VS Code used to leave it listed as `+0 -0`. Now it's deleted like a ✗, unless Claude itself created it empty (an `__init__.py`, say).

10. **Row highlight on hover.** We tried dim dot leaders from the name to the buttons and found them too busy. The hover highlight alone was enough.

11. **Refresh robustness.** The refresh stopped after a hot reload because only `session.start` started the timer. Now every hook starts it if it isn't running, and one bad file no longer stops it for the others.

12. **Deletions and shell commands.** Deleting a file with a command was invisible at first. Copying the repo to compare was too slow, and parsing commands is too fragile, so we compare `git status` before and after (see [Tracking shell commands](#tracking-shell-commands)). Deleted files got their own look: struck through, red `deleted` tag.

13. **Two attribution bugs fixed:**
    - When Claude deleted a file, the next message told Claude that the *user* had deleted it. `lastSeenByClaude` couldn't represent "deleted"; it's now `string | null`.
    - A refresh landing in the middle of Claude's delete command reported the delete as the user's revert. The refresh now pauses while Claude's writing tools run.

14. **Published through a shared marketplace.** This repository is the plugin alone. The catalog lives in [`comertial/comertial-mods`](https://github.com/comertial/comertial-mods), so later mods join the same `comertial-mods` marketplace and users add it only once.

---

## Limitations

- **Gitignored files** and files outside the project are never tracked, by design.
- **Non-git folders:** only plain `rm`/`del`/`Remove-Item` of named files is caught. Deletes built from variables, inside scripts, or of whole folders are missed.
- **Committed inside one command:** a file that was clean, then changed **and committed** within a single command, is invisible, because it never shows in `git status`.
- **Dirty-file snapshot cap:** at most 500 already-changed files are saved before a shell command. In a repo with more uncommitted changes than that, the rest have no "before" content.
- **Concurrent edits:** if you save a file in VS Code while one of Claude's shell commands is running, the change is attributed to Claude. It still shows up for review.
- **VS Code's labels:** the per-block button says "Revert Block" and can't be renamed.
- **The 2-second refresh** reads every listed file each tick. Fine for normal use; a list of hundreds of large files would make it heavier.
- **Collapsed folders are remembered by path:** a folder that disappears and later comes back reappears collapsed.
- **State is per session:** a new session starts with an empty list. Pending changes from a previous session are just files on disk, no longer listed.
- **Untestable timing:** the fix for the refresh race couldn't be covered by a test, because the test kit doesn't run the timer in the middle of a tool call. It's reasoned from the code.

---

## File layout

```
pending-changes/
├─ .claude-plugin/
│  └─ plugin.json         # name, version, description, "types": "./types/index.d.ts"
├─ hooks/
│  ├─ hooks.json          # { "modules": ["./register.tsx"] }
│  ├─ register.tsx        # the hooks module: state, actions, polling, shell tracking, pane
│  ├─ diff.ts             # Myers line diff: countChanges(), lines()
│  ├─ commands.ts         # isReadOnlyCommand(), deleteTargets(), words(): pure, no host access
│  ├─ ids.ts              # idOf(), folderId(): stable element keys for buttons
│  └─ pending-changes.test.ts  # 25 tests run by `claude plugin test`
├─ types/
│  └─ index.d.ts          # the $.state contract: Tracked, Review, PluginState['pending-changes']
├─ CHANGELOG.md
├─ LICENSE               # GPL-3.0
└─ README.md
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

## Development

Clone the repository and load the clone directly. If you installed the mod from the marketplace, uninstall it first.

For a single session:

```bash
git clone https://github.com/comertial/claude-pending-changes.git
claude --plugin-dir ./claude-pending-changes
```

To load it in every session, put the clone's absolute path in `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`. Separate several folders with `;` on Windows and `:` elsewhere:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-pending-changes" } }
```

Saves then reload the module on their own, after the current turn ends. Don't run both the installed copy and a `--plugin-dir` copy in one session, or the hooks run twice.

Checks:

```bash
# manifest + module: what it hooks and calls, and anything the engine would refuse
claude plugin validate ./claude-pending-changes

# the test suite
claude plugin test ./claude-pending-changes
```

Type-checking: once the engine has loaded the mod from a folder it watches, it writes `.claude-plugin/types/` and a `tsconfig.json`, so `tsc -p <folder>` works. Otherwise use a `tsconfig.json` kept **outside** the mod folder. Its `include` names the engine's `claude-code.d.ts` (written by the plugin-authoring skill) plus this folder's `hooks` and `types`, with `"jsx": "react", "jsxFactory": "h"`.

Debugging: run `claude --debug`. A hook that throws is skipped and logged. A pane tree that doesn't validate is logged as `ui.render (Pane): a hook returned a tree that does not validate`, with the reason.

---

## Tests

`claude plugin test` runs `hooks/pending-changes.test.ts` against the real engine, with an in-memory host under the plugin. It mocks:

- **the file system:** files and folders;
- **`process.run`:** `rm`, `code --diff`, and a fake **git** whose HEAD you give per test;
- **the clock:** moved by hand;
- **Edit/Write/Bash:** each Bash command runs a scripted change to the in-memory disk.

What the 25 tests cover:

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
- **Notes to Claude:** the next prompt reports your edits, once.
- **Tree:**
  - folders, merged chains and totals;
  - tree guides;
  - collapse and expand.
- **Folder actions:**
  - Folder ✗ rejects its files and removes Claude-created folders, but keeps folders that already existed.
  - Folder ✓ accepts only that folder.
- **Refresh** runs even when `session.start` never fired.
- **Shell tracking:**
  - read-only detection and delete-target parsing;
  - a committed file deleted by a command shows as deleted, and ✗ restores it;
  - a command that rewrites a committed file and creates a new file in a new folder is fully caught;
  - a file you had already changed keeps *your* version as its original;
  - read-only commands run no `git status`;
  - outside git, `rm` is still caught;
  - Claude's own deletion is not reported back as yours.

One quirk of the test kit: it hands the file-system hooks native Windows paths (`C:\repo\a.txt`), so the test host normalizes paths before using them.

---

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| The pane doesn't appear | The terminal is under 110 columns (the pane waits). Widen it or run `/changes`. |
| Clicking a file does nothing / toast "Could not open VS Code" | `code` isn't on PATH. In VS Code: *Command Palette → Shell Command: Install 'code' command in PATH*. |
| Counts don't update after saving in VS Code | The refresh timer isn't running. Any tool call, prompt or `/changes` restarts it. If it persists, check `claude --debug` for `pending-changes` lines. |
| A shell change wasn't listed | The file is gitignored, outside the project, or the folder isn't a git repo (only plain deletes are caught there). Or the command matched the read-only list. |
| The hook seems to run twice | The installed copy and a `--plugin-dir` / session dev copy are both loaded. Use one. |
| A diff tab shows "deleted" | Its temp file was cleaned up after accept/reject. Close the tab. |
| `test.json` shows `+3 -2` after a PowerShell edit | Windows PowerShell 5.1's `-Encoding utf8` adds a byte-order mark to the first line. That's the command, not the mod. |

---

## Releasing

1. Bump `version` in `.claude-plugin/plugin.json` (semver).
2. Move the `[Unreleased]` notes in `CHANGELOG.md` under the new version.
3. Commit, tag `vX.Y.Z`, push the tag and create a GitHub release.

Installed users pick up the new version with `claude plugin marketplace update comertial-mods`, then `claude plugin update pending-changes@comertial-mods`. If the marketplace entry in `comertial/comertial-mods` pins a `ref`, bump it there as well.

---

## License

[GPL-3.0](LICENSE). This is an independent project, not affiliated with or endorsed by Anthropic. Claude and Claude Code are products of Anthropic.
