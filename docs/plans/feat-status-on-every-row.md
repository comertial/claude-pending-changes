# Plan: A status on every row

**Status:** Approved
**Spec:** [`feat-status-on-every-row.md`](../specs/feat-status-on-every-row.md)

---

### Changes
`hooks/register.tsx`:
- Next to the other pane helpers (`fit`, `treeRows`), add:
  ```ts
  type Status = 'added' | 'modified' | 'deleted'
  const statusOf = (f: Tracked): Status => f.original === null ? 'added' : f.isDeleted ? 'deleted' : 'modified'
  ```
  Also add const tables from each status to its label colour (`STATUS_COLOR`) and to its name's Text props (`NAME_STYLE`): `{ underline: true }`, `{ italic: true }` and `{ strikethrough: true, dimColor: true }`.
- Replace the name and tag Text elements in the file row (around lines 771-772) with:
  ```tsx
  <Text {...NAME_STYLE[status]}>{fit(row.name, room)}</Text>
  <Text color={STATUS_COLOR[status]}>{` ${status}`}</Text>
  ```
- In the `room` calculation (around line 725), the fixed `- 24` budget was sized for ` deleted` (8 columns). ` modified` takes 9, so change it to `- 25`.

`success`, `warning` and `error` are all valid `ThemeKey`s (`.claude-plugin/types/claude-code/index.d.ts:12598`).

### Tests
`hooks/pending-changes.test.ts`:
- Add one test that writes a new file, edits a tracked file and deletes a committed one, then mounts the pane. Through `ui.find(...)` and its `props`, assert criteria 1–4: the label text, colour and name style for each status, and no label on folder rows.
- The existing ` deleted` assertions must keep passing. Check whether any test matches ` new`: a grep found none, but confirm before removing it.

### SPEC merge
- The pane, "File row": describe the three labels, their colours and the matching name styles.
- Tests list, "Tree": add "a coloured status and matching name style on every file row".

### README check
- Highlights table, "Changes as a tree": "`new` and `deleted` tags" becomes "a coloured `added` / `modified` / `deleted` status on every file".
- Highlights ASCII mock: `new` becomes `added`, and add `modified` to the edited rows.
- The pane, "File row": the same three labels, colours and name styles as the SPEC.

### CHANGELOG / ROADMAP
- `CHANGELOG.md` `[Unreleased]` → `### Changed`: every file row shows a coloured status (green `added`, yellow `modified`, red `deleted`), with the name styled to match (underline, italic, strikethrough). The `new` tag is renamed to `added`.
- `ROADMAP.md`: remove the item from "Now".
- Delete this plan and its spec.

### Commits
1. `feat(pane): show a coloured status on every file row`. Covers `register.tsx`, the test, SPEC, README, CHANGELOG and ROADMAP, and deletes this spec and plan.

### Verification
- `claude plugin validate .` and `claude plugin test .`: the new test and the existing pane tests pass.
- Manual check, in a git repo:
  - Have Claude create a file, edit a file and `rm` a committed file.
  - Confirm the labels and colours are right and the underline, italic and strikethrough names show.
  - Confirm nothing wraps at about 110 columns.
