# Plan: <title>

**Status:** Draft
**Spec:** [`<feat|bug>-<slug>.md`](../specs/<feat|bug>-<slug>.md)

The plan has the same file name as its spec. A plan written in plan mode gets a random name, so rename it to match the spec as soon as it's approved.

---

### Regression test first
*Bugs only. Delete this section for a feature.*

The test to add to `hooks/pending-changes.test.ts`. It must **fail before the fix** and pass after it. Run it against the unfixed code and record that it fails.

### Changes
The files to change and the existing helpers to reuse, with `file:line`. For a bug, keep the fix to the root cause.

### Tests
New tests in `hooks/pending-changes.test.ts`, one or more per acceptance criterion in the spec. List any existing tests that need to change, and why.

### README merge
The exact README sections to update, the Tests list entries to add, and any new Design decision. A bug fix usually changes nothing here, unless the README was wrong or silent, or the fix makes a Limitations or Troubleshooting entry obsolete.

### CHANGELOG / ROADMAP
- `CHANGELOG.md` `[Unreleased]`: `Added` / `Changed` for a feature, `Fixed` for a bug.
- `ROADMAP.md`: remove the item (features only).
- Delete this plan and its spec.

### Commits
Conventional Commits, and each one needs approval.

1.

### Verification
- For a bug: the regression test fails before the fix and passes after it.
- `claude plugin validate .` and `claude plugin test .`
- Manual check:
