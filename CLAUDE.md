# pending-changes

A Claude Code mod: a review pane for every file Claude creates, edits or deletes. The code is in `hooks/`, and the tests are in `hooks/pending-changes.test.ts`.

## The README is the spec

[README.md](README.md) describes how the mod behaves **now**, and it is the source of truth: The pane, The diff view, What gets tracked, Keeping Claude in sync, Limitations, Under the hood (including Design decisions) and the Tests list under Contributing. It is edited in place, so it always describes the current product, not its history.

- Before planning any change, read the README sections it touches.
- A change that contradicts documented behaviour or a Design decision must say so explicitly in its spec and get approval. Never change existing behaviour by accident.

## Workflow

Features (ROADMAP items) and bugs both follow the spec-driven loop in [docs/specs/](docs/specs/README.md). Each one has two files with the same name: a **spec** (what and why) in `docs/specs/`, and a **plan** (how) in `docs/plans/`. A feature is `feat-<slug>.md` and a bug is `bug-<slug>.md`.

1. **Spec.** Copy `docs/specs/_feature.md` or `_bug.md` and fill it in, then stop for approval.
   - Feature: what and why, the affected README behaviour (what *changes* and what *must not change*), and testable acceptance criteria.
   - Bug: the reproduction, the expected behaviour quoted from the README (or a note that the README is silent), the actual behaviour, and a confirmed root cause.
2. **Plan.** Write `docs/plans/<same name>.md` with the files, tests, README merge and commits, then stop for approval.
   - **Plan mode** writes here automatically (`plansDirectory` in `.claude/settings.json`) under a random name. As soon as the plan is approved, rename it to match its spec, before any other change.
   - **Without plan mode**, copy `docs/plans/_plan.md`.
   - A file in `docs/plans/` with no matching spec is an abandoned draft. Rename or delete it; don't commit it.
3. **Implement.** For a bug, write the regression test first and confirm it fails before the fix. Every acceptance criterion becomes a test, and the whole suite must pass.
4. **Ship.** In the same commit:
   - merge any behaviour change into the README;
   - add a Design decision if a lasting "why" came up;
   - update the README Tests list and `CHANGELOG.md` `[Unreleased]` (`Fixed` for bugs);
   - remove the item from `ROADMAP.md` (features only);
   - **delete the spec and its plan**.

**Research** (ROADMAP "Exploring" items, or open questions that block a spec) uses `docs/specs/_research.md` and becomes `research-<slug>.md`. It produces a decision, not code, so it has no plan file:
- Write the question and constraints.
- Record what was tried and what was found.
- Recommend go or no-go, then stop for the user's decision.
- Close it in one commit: on a go, the item moves up the ROADMAP and a `feat-` spec starts from the findings. On a no-go, the item moves to "Not planned" with its reason, plus a README Design decision if the reason will last. Then delete the file.
- Experiments never stay in `hooks/`.

Only typo-level fixes skip the spec. If one changes behaviour, it still updates the README, the tests and the CHANGELOG.

## Principles

These are the short version of the README [Design decisions](README.md#-under-the-hood). Read the full entries there.

- **Changes go straight to disk.** There's no staging area. ✓ clears the record and ✗ undoes the change.
- **Claude never drifts.** Every reject, revert or hand edit is reported back to Claude.
- **Scope:** git-tracked files under the working directory only.
- **Net diffs only.** A file changed and changed back drops off the list.
- **Stay fast.** No work on every tick that scales with repo size.
- **Every behaviour change has a test**, and the README Tests list stays in sync with the suite.

## Checks

```bash
claude plugin validate .
claude plugin test .
```
