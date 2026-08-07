# TASK

Fix issue {{TASK_ID}}: {{ISSUE_TITLE}}

Pull in the issue using `gh issue view <ID>`. If it has a parent PRD, pull that in too.

Only work on the issue specified.

Work on branch {{BRANCH}}. Make commits and run tests.

# CONTEXT

Here are the last 10 commits:

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

# EXPLORATION

Explore the repo and fill your context window with relevant information that will allow you to complete the task.

Pay extra attention to test files that touch the relevant parts of the code.

# EXECUTION

If applicable, use RGR to complete the task.

1. RED: write one test
2. GREEN: write the implementation to pass that test
3. REPEAT until done
4. REFACTOR the code

# FEEDBACK LOOPS

toon is a pnpm workspace. Before committing, run toon's real gate and make sure every command passes:

- lint: `eslint . --max-warnings 940`
- typecheck: `pnpm run typecheck`
- test: `vitest run`
- build: `pnpm -r run build`

Rules for the gate:

- **lint** and **test** and **build** must pass cleanly. The lint budget
  (`--max-warnings 940`) is a hard ceiling: do NOT introduce new warnings.
- **typecheck** is a hard gate at ZERO errors, blocking in CI (toon#144). You
  must build BEFORE typechecking: run `pnpm -r run build` first, then
  `pnpm run typecheck` — cross-package imports resolve through each package's
  built `dist/`, so typechecking a clean checkout without `dist/` produces
  ~90 phantom TS2307 errors. `pnpm run typecheck` must pass cleanly with no
  errors.

Do not commit until lint, test, build, and typecheck all pass cleanly.

# COMMIT

Make a git commit. The commit message must:

1. Start with `RALPH:` prefix
2. Include task completed + PRD reference
3. Key decisions made
4. Files changed
5. Blockers or notes for next iteration

Keep it concise.

# THE ISSUE

If the task is not complete, leave a comment on the issue with what was done.

Do not close the issue - this will be done later.

Once complete, output <promise>COMPLETE</promise>.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.

## Context budget

Operate as if your context is capped at **~200k tokens**, whatever your model's actual window
is (org policy: toon-meta's `CLAUDE.md` → *Context budget policy* — the cap is absolute, not a
percentage of the window, because a percentage means different things on different models).
Treat ~200k as a hard ceiling, not a target, and do the real work well below it.

Start preparing a handoff at roughly **120k** tokens of context, and hand off no later than
roughly **160k** — never run to the ceiling. Handing off means: write a structured handoff note
(goal and remaining work as a concrete task list; what has been done and where — files,
branches, commits; key decisions and why; exact paths/line numbers instead of "see above") to
`.sandcastle/logs/handoff-<task-id>.md`, **commit it on this branch** (use `git add -f` —
`.sandcastle/.gitignore` ignores `logs/`, and the sandbox is destroyed when the run ends, so an
uncommitted note is lost), and end your turn so a fresh agent continues. Small, resumable units
beat one degraded run.
