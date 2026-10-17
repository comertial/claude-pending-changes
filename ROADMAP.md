# Roadmap

Where **pending-changes** is headed. This is a direction, not a schedule: there are no dates, and items can move, change or be dropped as we learn more. Shipped work is recorded in the [CHANGELOG](CHANGELOG.md).

Have an idea or want to pick something up? [Open an issue](https://github.com/comertial/claude-pending-changes/issues) first so we can agree on the approach. Items marked **help wanted** are good places to start.

Before work on an item starts, it gets a short spec in [`docs/specs/`](docs/specs/README.md).

## Now

Being worked on, in priority order.

- **Keep pending changes across sessions.** Today a new session starts with an empty list, and anything left unreviewed is just files on disk. Persist the list (and the originals) per project so you can pick the review back up.
- **Lighter refresh.** The 2-second refresh re-reads every listed file on each tick. Check modification time and size first, and re-read only the files that moved.

## Next

Planned, after the items above.

- **Other diff tools.** A setting to open diffs in Cursor, a JetBrains IDE, `vimdiff` or any command that takes two paths, instead of only `code --diff`. **help wanted**

## Exploring

Ideas we like but haven't committed to. They need research or more demand before they're planned. Research gets a `research-` spec in [`docs/specs/`](docs/specs/README.md#research), which ends with each item either moving up to Next or down to Not planned.

- **Accept or reject single blocks in the pane.** Review hunk by hunk without opening an editor. Needs research into what the pane can render and how it should behave.
- **Close the diff when a change is resolved.** Accepting or rejecting a file closes its open VS Code diff. Resolving a folder closes the diffs of every file inside it, and accept all or reject all closes every diff opened from the list. `code --diff` can open a tab but not close one, so this needs research.
- **Keyboard navigation in the pane.** Move between files and accept or reject without the mouse.
- **Cross-session file locks.** When several Claude sessions work in one checkout, warn or block a session from editing a file that another live session has pending, so they don't overwrite each other. Claude Code has no file locks of its own; its advice is git worktrees, or giving each agent different files. Edit and Write could be blocked, but Bash can't (which files a command writes isn't known until it runs), and stale locks from crashed sessions need recovery. Needs research.
- **A configurable snapshot cap.** At most 500 already-changed files are saved before a shell command; in repos with more uncommitted changes than that, the rest have no "before" content. A setting could raise the cap, at the cost of slower commands.

## Not planned

Considered and decided against, for now. Open an issue if you have a strong case.

- **Holding changes in a staging area until accepted.** Builds, tests and Claude itself would see stale files. Changes go straight to disk; see design decision 1 in the [SPEC](docs/SPEC.md#design-decisions).
- **Tracking gitignored files or paths outside the working directory.** Keeping the scope to the project's tracked files is what keeps the mod fast and predictable.
- **Full shell tracking outside git.** `git status` is what lets the mod see every change a command makes, quickly and however it was made. Without git, only plain deletes and files already in the list are caught. Run Claude inside a git repo (`git init` is enough) for full tracking.
