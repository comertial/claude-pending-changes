---
name: review-impl
description: Review the implementation of this repo's approved spec-driven work (feat- or bug- spec and plan) in the impl-reviewer subagent. It reports missed spec and plan points, new bugs (confirmed with probe tests in a scratch copy) and regressions, and rules on every deviation the implementer reported. Run explicitly with /review-impl [implementer notes, paths or focus].
disable-model-invocation: true
context: fork
agent: impl-reviewer
argument-hint: "[implementer notes, paths or focus]"
---

Review the implementation on the current branch against its approved spec and plan, following your instructions.

What the user passed (the implementer's notes on deviations, untested criteria and bugs fixed, paths, decisions not written down yet, or a focus; may be empty): $ARGUMENTS

Treat the notes as claims to verify, not facts. If nothing was passed, find the spec, plan and change yourself and say that no deviations were reported.
