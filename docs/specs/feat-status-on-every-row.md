# Feature: A status on every row

**Status:** Approved
**Roadmap item:** A status on every row
**Issue:** none
**Plan:** [`feat-status-on-every-row.md`](../plans/feat-status-on-every-row.md)

---

### Context
Only new files (a dim `new` tag) and deleted files (a red `deleted` tag with a struck-through, dim name) are labelled today. Modified files have no label, so you can't tell at a glance which kind of change each row is.

### Goals
- Every file row carries a coloured status label.
- The file name is styled to match the status, so the status stays readable without colour.

### Non-goals
- Folder rows. They keep the bold `suggestion` style and get no label.
- Any change to counts, buttons, sorting or actions.

### Affected behaviour

| SPEC section | Changes / must not change | Guarded by (existing tests) |
| --- | --- | --- |
| README Highlights table, "Changes as a tree" | **changes**: `new`/`deleted` tags become a status on every file | — |
| README Highlights ASCII mock | **changes**: `new` → `added`, `modified` added to edited rows | — |
| The pane, "File row" | **changes**: three labels, colours and name styles | ` deleted` assertions in `hooks/pending-changes.test.ts` (around lines 442 and 501) |
| The pane, "Folder row" | **must not change** | Tree tests (folders, merged chains, totals) |
| The pane, Layout (trimming long names) | **must not change**, and nothing wraps at about 110 columns | — |
| The pane, "File row": the deleted file look | **must not change**: strikethrough + dim + red `deleted` stays | ` deleted` assertions |

There is no conflict with the Design decisions.

### New behaviour
Each file row shows its name, then its status label right after the name (where today's tags are), then the counts:

| Status | Condition (`Tracked` entry) | Label | Name style |
|---|---|---|---|
| added | `file.original === null` | ` added`, `color="success"` | `underline` |
| deleted | `file.isDeleted` | ` deleted`, `color="error"` | `strikethrough dimColor` (unchanged) |
| modified | otherwise | ` modified`, `color="warning"` | `italic` |

The three statuses never overlap. `settle()` (`hooks/register.tsx:128`) drops a new file that gets deleted, because `null === null`, so no row can be both added and deleted. The `new` tag is renamed to `added`.

### Acceptance criteria
1. A file Claude created shows ` added` in `success` colour, with an underlined name.
2. A file Claude edited shows ` modified` in `warning` colour, with an italic name.
3. A file Claude deleted shows ` deleted` in `error` colour, with a struck-through, dim name.
4. Folder rows have no status label and keep their style.
5. The counts and buttons don't wrap on a pane that is about 110 columns wide.

### Open questions
None.

### Decisions
- The label sits **right after the name**, where today's tags are.
- **Folder rows don't change.**
