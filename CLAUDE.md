# pending-changes

A Claude Code mod: a review pane for every file Claude creates, edits or deletes. The code is in `hooks/`, and the tests are in `hooks/pending-changes.test.ts`.

## docs/SPEC.md is the spec

[docs/SPEC.md](docs/SPEC.md) describes how the mod behaves **now**, and it is the source of truth: Behaviour, Under the hood, Design decisions and the Tests list. It is edited in place, so it always describes the current product, not its history.

[README.md](README.md) is for users: a friendlier summary of the same behaviour, plus installation, troubleshooting and contributing. It may be less detailed than the SPEC, but it must never contradict it.

- Before planning any change, read the SPEC sections it touches.
- A change that contradicts documented behaviour or a Design decision must say so explicitly in its spec and get approval. Never change existing behaviour by accident.

## Workflow

Features (ROADMAP items) and bugs both follow the spec-driven loop in [docs/specs/](docs/specs/README.md). Each one has two files with the same name: a **spec** (what and why) in `docs/specs/`, and a **plan** (how) in `docs/plans/`. A feature is `feat-<slug>.md` and a bug is `bug-<slug>.md`.

0. **Branch.** One branch per piece of work, named after the slug alone (`<slug>`, no type prefix), from an up-to-date `main`. Create it before writing the first spec, which is the branch's first commit. Research, the feature it leads to, and fixes made along the way all stay on that one branch. A bug found while building a feature is fixed there without a bug spec, because it never reached `main`. Never commit spec-driven work to `main`; the user merges the branch when the work is done.
1. **Spec.** Copy `docs/specs/_feature.md` or `_bug.md` and fill it in, then stop for approval.
   - Feature: what and why, the affected SPEC behaviour (what *changes* and what *must not change*), and testable acceptance criteria.
   - Bug: the reproduction, the expected behaviour quoted from the SPEC (or a note that the SPEC is silent), the actual behaviour, and a confirmed root cause.
2. **Plan.** Write `docs/plans/<same name>.md` with the files, tests, SPEC merge, README check and commits, then review it (step 3) before asking for approval.
   - **Plan mode** writes here automatically (`plansDirectory` in `.claude/settings.json`) under a random name. As soon as the plan is approved, rename it to match its spec, before any other change.
   - **Without plan mode**, copy `docs/plans/_plan.md`.
   - A file in `docs/plans/` with no matching spec is an abandoned draft. Rename or delete it; don't commit it.
3. **Review.** Before the plan is approved, spawn the `spec-reviewer` agent (`.claude/agents/spec-reviewer.md`) to review the spec and plan. Don't review them in the main session, which keeps its context free for implementing, and don't use the `/review-spec` skill: it's for me to run by hand.
   - Brief it with the document paths, the commit of any closed research, and any decisions agreed in chat that aren't in the documents yet. Don't add your own suspected findings; an unprimed reviewer is the point.
   - Show me its findings, sorted critical to low, with any you can refute from context it lacked and why. Fold in only the ones I pick, then ask for approval of the plan.
4. **Implement.** For a bug, write the regression test first and confirm it fails before the fix. Every acceptance criterion becomes a test, and the whole suite must pass.
5. **Verify.** Before the ship commit, spawn the `impl-reviewer` agent (`.claude/agents/impl-reviewer.md`) to check the implementation against the approved spec and plan: missed points, new bugs, regressions, and a verdict on each deviation. As in step 3, don't review it in the main session, and don't use the `/review-impl` skill: it's for me to run by hand.
   - Brief it with the spec and plan paths and your implementation notes: every deviation from the plan with its reason, every acceptance criterion without a test, and the bugs you fixed along the way. Don't add your own suspected findings.
   - Show me its findings, sorted critical to low, with any you can refute from context it lacked and why. Fix only the ones I pick, and rerun it if the fixes were substantial.
   - A deviation that contradicts an approved acceptance criterion, a spec rule or a SPEC Design decision is amended in the spec and needs my approval before shipping.
6. **Ship.** In one commit on the branch, before it's merged into `main`:
   - merge any behaviour change into `docs/SPEC.md`;
   - add a SPEC Design decision if a lasting rule came up, naming any idea it rules out;
   - update the SPEC Tests list and `CHANGELOG.md` `[Unreleased]` (`Fixed` for bugs);
   - **check the README**: update any user-facing part the change touched (Highlights, Using it, What gets tracked, Keeping Claude in sync, Limitations, Troubleshooting) so it doesn't contradict the SPEC. Leave internals out of it;
   - remove the item from `ROADMAP.md` (features only);
   - **delete the spec and its plan**.

**Research** (ROADMAP "Exploring" items, or open questions that block a spec) uses `docs/specs/_research.md` and becomes `research-<slug>.md`. It produces a decision, not code, so it has no plan file:
- Work on a `<slug>` branch from `main`. Prototypes may be committed there for reference, but are reverted before the close commit.
- Write the question and constraints.
- Record what was tried and what was found.
- Recommend go or no-go, then stop for the user's decision.
- Close it in one commit: delete the research spec. On a go, the item moves to ROADMAP "Now" and a `feat-<slug>.md` spec starts from the findings **on the same branch**, which is merged when the feature ships. On a no-go, the item moves to "Not planned" with its reason, plus a SPEC Design decision if the reason will last, and the branch is merged with only those docs.
- **Archive work that didn't ship.** Before the commit that deletes a no-go research spec or a dropped feature spec, tag the last commit that still has it `archive/<slug>`, and link the "Not planned" entry to the spec at that tag (see [Archiving work that didn't ship](docs/specs/README.md#archiving-work-that-didnt-ship)). This works with squash merges too. The tag needs my approval like any tag, and I push it.
- Experiments never stay in `hooks/`.

Only typo-level fixes skip the spec. If one changes behaviour, it still updates the SPEC, the README where users would notice, the tests and the CHANGELOG.

## Principles

These are the short version of the SPEC [Design decisions](docs/SPEC.md#design-decisions). Read the full entries there.

- **Changes go straight to disk.** There's no staging area. ✓ clears the record and ✗ undoes the change.
- **Claude never drifts.** Every reject, revert or hand edit is reported back to Claude.
- **Scope:** git-tracked files under the working directory only.
- **Net diffs only.** A file changed and changed back drops off the list.
- **Stay fast.** No work on every tick that scales with repo size.
- **Every behaviour change has a test**, and the SPEC Tests list stays in sync with the suite.

## Checks

```bash
claude plugin validate .
claude plugin test .
```
