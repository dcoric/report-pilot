---
name: commit
description: Create a clean commit for the current staged or unstaged changes, optionally using a provided ticket or ticket summary for context
---

Create a git commit for the current repo changes.

Read `AGENTS.md` first. It is the canonical project guide for this repository.

Inputs:

- Optional ticket identifier such as `#123` or `ABC-123`
- Optional short ticket summary or description

Workflow:

1. Run `git status --short` and inspect the relevant diff before staging anything
2. If there are unrelated changes, stage only the files that belong in this commit
3. If there are no changes to commit, stop and say so
4. Write a single clear commit message for the actual change
5. Commit without adding extra trailers or AI attribution

Commit message rules:

- If a Jira-style ticket identifier such as `ABC-123` is provided, use `ABC-123 <description>`
- If no Jira-style ticket identifier is provided, use Conventional Commits format: `<type>[optional scope]: <description>`
- Keep the description imperative and without a trailing period
- Prefer a concise single-line message unless the user explicitly asks for a body
- Do not invent ticket IDs or details that were not provided

Examples:

- `ABC-123 add saved query rename action`
- `feat(query): add saved query rename action`
- `fix(rag): reindex notes after schema import`
- `docs: update local runtime instructions`

Hard rules:

- Do not include `codex`, `claude`, `chatgpt`, or similar agent branding in the branch name or commit message
- Do not add `Co-authored-by`
- Do not add `Signed-off-by`
- Do not add AI-generated disclaimers, attribution, or signature text
- Do not amend existing commits unless the user explicitly asks
- Do not use `git add -A` unless the full working tree is intentionally part of the commit

If the current branch name contains agent branding, warn the user before committing and recommend renaming the branch first.
