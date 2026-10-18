---
name: review-spec
description: Review this repo's spec-driven work (research, feat- or bug- spec, plan) in the spec-reviewer subagent, and report flaws, regressions and implementation risks sorted critical to low. Run explicitly with /review-spec [paths, slug or focus].
disable-model-invocation: true
context: fork
agent: spec-reviewer
argument-hint: "[paths, slug or focus]"
---

Review the spec-driven work on the current branch, following your instructions.

What the user passed (paths, a slug, decisions not written down yet, or a focus; may be empty): $ARGUMENTS

If it's empty, find the documents and the stage yourself, as your instructions describe.
