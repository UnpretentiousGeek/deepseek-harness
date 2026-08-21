---
name: done
description: Commit the current feature branch changes, merge the feature branch into master, and delete the merged local branch. Use when the user says "done", "finish", "merge this", "ship it", or asks to complete an implementation.
---

# Done

Commit, merge, and delete the current local feature branch.

1. Confirm the current branch is a feature branch, not `master`.
2. Commit the task changes.
   - Preserve unrelated changes. Stage only files that clearly belong to this task.
   - If task changes cannot be separated from unrelated work, stop and ask rather than guessing.
   - Use the repository's commit convention; otherwise use a concise imperative Conventional Commit-style subject.
3. Confirm a local `master` branch exists. If this repository uses `main` instead, ask before using it as a substitute. Switch to `master` with a clean working tree and merge the feature branch using the repository's established merge style (use `--no-ff` if none is documented).
4. Delete the merged **local** feature branch with a non-force delete. Do not delete a remote branch unless the user explicitly asks.
5. Report the commit, merge result, and deleted branch.

Do not reset, discard, stash, force-push, or overwrite existing work.
