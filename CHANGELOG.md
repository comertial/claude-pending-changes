# Changelog

All notable changes to this mod are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). The version in
`.claude-plugin/plugin.json` must match the latest entry.

## [Unreleased]

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

[Unreleased]: https://github.com/comertial/claude-pending-changes/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/comertial/claude-pending-changes/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/comertial/claude-pending-changes/releases/tag/v0.1.0
