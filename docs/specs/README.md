# Specs

Features and bug fixes are specified before they're built, and open questions are researched before they become features. There are two layers:

| | Living spec | Change docs |
| --- | --- | --- |
| **Where** | [`docs/SPEC.md`](../SPEC.md) | A spec here, plus a plan with the same name in [`docs/plans/`](../plans/README.md) |
| **Describes** | How the mod behaves **now**, its internals, Design decisions and Tests list | One change: what and why (spec), and how (plan) |
| **Lifetime** | Permanent, edited in place | Deleted when the change ships |

The SPEC stays as large as the product needs, because shipped behaviour replaces old text instead of being added to it. The project [README](../../README.md) is for users: a friendlier summary of the same behaviour, checked and updated when a change ships so it never contradicts the SPEC. `docs/specs/` and `docs/plans/` only hold work in progress. The tests in `hooks/pending-changes.test.ts` are what actually enforce the behaviour: every acceptance criterion becomes a test, so a later change that breaks it fails the suite.

## Three kinds of spec

| | Feature | Bug | Research |
| --- | --- | --- | --- |
| **Template** | [`_feature.md`](_feature.md) | [`_bug.md`](_bug.md) | [`_research.md`](_research.md) |
| **File** | `feat-<slug>.md` | `bug-<slug>.md` | `research-<slug>.md` |
| **Plan** | `docs/plans/feat-<slug>.md` | `docs/plans/bug-<slug>.md` | None |
| **Comes from** | A [ROADMAP](../../ROADMAP.md) item, or research that ended in a go | A GitHub issue, or a bug found in shipped behaviour | A ROADMAP "Exploring" item, or an open question in a feature spec |
| **The spec answers** | What should be different, and why | How to reproduce it, what the SPEC says should happen, and the root cause | One question: is it feasible, and which option to take |
| **Tests** | One or more per acceptance criterion | A regression test that **fails before the fix** | None. Throwaway experiments only |
| **SPEC** | New behaviour merged in | Usually unchanged. Fixed if it was wrong or silent, and obsolete Limitations entries removed | A Design decision, only for a lasting no-go reason |
| **README** | User-facing parts updated to match | Only if the fix changes what users see, or makes a Limitations or Troubleshooting entry obsolete | Usually unchanged |
| **CHANGELOG** | `Added` / `Changed` | `Fixed` | None |
| **Commit** | `feat(...)` | `fix(...)` | `docs(roadmap): ...` for the outcome |

## Branches

One branch per piece of work, named after its slug alone (e.g. `status-on-every-row`), and created from an up-to-date `main` before the first spec is written. Everything for that work happens on it: research, the feature it leads to, and fixes along the way. Spec and plan files keep their type prefix (`research-`, `feat-`, `bug-`), and that prefix is what says what kind of work the branch is doing. The first spec is the branch's first commit, so ongoing work can be pushed and shared from the start. Nothing is committed to `main` directly. When the work is done, the branch is merged into `main`, and the merge already includes the commit that deletes the specs and plans.

- **Research that ends in a go** continues on the same branch. The research spec is replaced by a `feat-` spec and its plan.
- **A bug found while building a feature** never reached `main`, so it's fixed on the branch without a bug spec. `bug-` specs are only for bugs in shipped behaviour, and each one gets its own slug branch.

## The loop for features and bugs

0. **Branch.** Create `<slug>` from `main`, unless the work is already on its branch after research.
1. **Spec.** Copy the template to `docs/specs/` and fill it in. For a feature, read the SPEC sections it touches first. For a bug, confirm the reproduction and the root cause first. Its status is `Draft` until the user approves it.
2. **Plan.** Write `docs/plans/<same name>.md`, either:
   - **in plan mode:** it's written to `docs/plans/` automatically under a random name. Once the plan is approved, rename it to match the spec before doing anything else; or
   - **without plan mode:** copy [`_plan.md`](../plans/_plan.md) and stop for approval.

   Then set both statuses to `Approved`.
3. **Implement.** For a bug, write the regression test first and watch it fail. Every acceptance criterion gets a test, and the whole suite must pass.
4. **Ship.** In one commit on the branch:
   - merge any behaviour change into the SPEC;
   - add a SPEC Design decision if a lasting rule came up, naming any idea it rules out;
   - update the SPEC Tests list and the CHANGELOG;
   - check the README, and update any user-facing part the change touched so it doesn't contradict the SPEC;
   - remove the ROADMAP item (features only);
   - delete the spec and its plan.

   Then merge the branch into `main`.

## Research

Research produces a decision, not code, so it has no plan. It still gets its own `<slug>` branch, so the open question and its findings can be pushed while the work is ongoing. Prototypes can be committed there for reference, but must be reverted before the close commit.

1. **Open.** Create `<slug>` from `main`, copy `_research.md`, write the question and constraints, and get them agreed.
2. **Investigate.** Fill in "What was tried" and "Findings" as you go.
3. **Recommend.** Write a go or no-go recommendation and stop for the user's decision.
4. **Close.** In one commit, record the outcome and delete the research spec:
   - **Go:** move the ROADMAP item to Now, and start `feat-<slug>.md` from the findings **on the same branch**. The feature loop continues from step 1, and the branch is merged when the feature ships.
   - **No-go:** first [archive](#archiving-work-that-didnt-ship) the research spec. Then move the item to "Not planned" with a one-line reason and the archive link, plus a SPEC Design decision if the reason will matter later. Then merge the branch, which brings only those docs to `main`.

## Archiving work that didn't ship

A research spec that ends in a no-go, and a feature spec dropped before it ships, leave only a one-line "Not planned" entry on `main`. So the full findings stay reachable, the last commit that still has the spec gets a tag before the commit that deletes it:

```bash
git tag archive/<slug>
```

The "Not planned" entry then links to the spec at that tag:

```
- **<Item>.** <One-line reason.> ([research](https://github.com/comertial/claude-pending-changes/blob/archive/<slug>/docs/specs/research-<slug>.md))
```

The tag keeps the commit alive whatever the merge strategy, squash included, and after the slug branch is deleted. `archive/` tags are never releases; `git tag -l 'v*'` lists releases only. Shipped features and bug fixes, research that ends in a go, and plans get no tag: the SPEC, the CHANGELOG and git history cover them. Like every tag, an archive tag needs the user's approval, and the user pushes it.

## Finding old specs

Shipped and dropped specs and plans are deleted too. To list every removed one:

```bash
git log --diff-filter=D --name-only -- docs/specs/ docs/plans/
```

Typo-level fixes to code or docs don't need a spec. If one changes behaviour, it still updates the SPEC, the README where users would notice, the tests and the CHANGELOG.
