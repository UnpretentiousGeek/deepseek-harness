---
name: go
description: Create a Git feature branch and begin implementing an agreed change. Use when the user says "go", "go ahead", "start implementation", "create a branch", or otherwise authorizes moving from discussion into code changes.
---

# Go

Turn the agreed approach into an implementation branch and begin the work.

1. Locate the repository and read its `AGENTS.md` or contributor guidance. Inspect the current branch, working tree, recent commits, and available test commands.
2. Preserve all pre-existing uncommitted changes. Do not stash, reset, discard, or include them in the task without the user's explicit direction.
3. Create a descriptive branch using the repository's required prefix. If none is documented, use `codex/<concise-topic>`.
   - Branch from the current branch when it is the intended base.
   - If the intended base is unclear or the current branch is already an unrelated feature branch, explain the ambiguity and ask before branching.
   - If a matching branch already exists, switch to it only when it clearly belongs to this work; otherwise ask.
4. Announce the branch name, then implement the agreed scope. Make focused changes, keep process boundaries and local conventions intact, and add or update tests for behavior changes.
5. Run the narrowest relevant verification before reporting progress. State what was changed, what was tested, and anything remaining.

Do not create a pull request, merge, or delete branches as part of this skill. Use `$done` after implementation is complete.
