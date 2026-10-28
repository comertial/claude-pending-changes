# Changelog

All notable changes to this mod are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). The version in
`.claude-plugin/plugin.json` must match the latest entry.

## [Unreleased]

### Fixed

- Accept all and ✓ on a folder no longer leave some files behind, which happened in git repos with three or more files and whenever the 2-second refresh was running; and Reject all and ✗ on a folder no longer bring a row back for a moment and then tell Claude it was reverted ([#7](https://github.com/comertial/claude-pending-changes/issues/7)).

## [1.0.0] - 2026-10-18

The first stable release: the review pane, shell tracking and Claude sync of 0.x, now kept across sessions and shared between sessions in one checkout.

### Added

- Pending changes are kept across sessions in a git repo: a new session, `/clear` or `--resume` lists every file still pending, with its original, so ✓, ✗ and the diff work as before, and Claude is told which files have unreviewed changes from an earlier session. Originals are stored in git's object store, pinned by a hidden `refs/pending-changes/*` ref; nothing is committed or pushed by ordinary git commands.
- Sessions in one checkout share one list, in step within about 2 seconds. Each file belongs to the Claude that last changed it, and your decisions on it are reported to that Claude, wherever it runs. Rows from another session carry a dim `other session` or `earlier` tag, rows from another branch an `other branch` tag, and a footer counts pending files outside the session's folder.
- Two settings in `/config`: *Keep pending changes across sessions* (`persistAcrossSessions`, on by default) and *Open the pane at session start* (`openOnStart`: `auto`, or `toast` to only show the toast).

### Changed

- Every file row shows a coloured status (green `added`, yellow `modified`, red `deleted`), with the name styled to match (underline, italic, strikethrough). The `new` tag is renamed to `added`.

## [0.2.0] - 2026-10-11

### Added

- A toast saying to run `/changes` when Claude Code can't seat the pane on its own because the terminal is too narrow (under 144 columns, or 110 once you've opened the pane yourself): on the first change of a batch, and at session start when files are still pending.

### Fixed

- The empty `.deleted` stand-in opened as the right side of a deleted file's diff is now removed when the file is accepted, rejected or drops off the list, instead of lingering until the session ends.
- A shell command that puts a listed file back at its original (e.g. `git checkout`) now removes that file's temp review copy.

## [0.1.0] - 2026-10-10

### Added

- Docked pane listing changed files as a tree with `+added -removed` counts, `new` and `deleted` tags.
- Accept / reject per file, per folder and all at once; reject restores originals, deletes created files and the empty folders Claude created for them.
- VS Code side-by-side diff (`code --diff`) on click; saves and block reverts update the pane within ~2 seconds.
- Tracking of Edit, Write, NotebookEdit, and Bash/PowerShell commands (via `git status` before and after; plain deletes outside git).
- Notes to Claude on reject, revert and user edits, delivered at the next tool result or prompt.
- `/changes` command, collapsible and compact folders, hover highlight.
- Per-session temp review copies with cleanup on accept/reject, session end and a 24-hour sweep.

[Unreleased]: https://github.com/comertial/claude-pending-changes/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/comertial/claude-pending-changes/compare/v0.2.0...v1.0.0
[0.2.0]: https://github.com/comertial/claude-pending-changes/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/comertial/claude-pending-changes/releases/tag/v0.1.0
