/mattpocock-skills:implement {{ISSUE_URL}}

You are running AFK in a sandbox, on branch `{{BRANCH}}`, which is already checked out.
Nobody will answer a question, so do not ask one. Treat the issue, its comments and its
parent spec (if it has one) as settled. Read them with `gh issue view {{ISSUE_NUMBER}} --comments`.

Commit to `{{BRANCH}}`, and reference `#{{ISSUE_NUMBER}}` in each commit message. Do not
push, open a PR or close the issue. The runner does all three once you finish.

## This repository

- `CLAUDE.md` covers how to build and test. This repo is the shared library layer, `@toon-protocol/core`
  and `@toon-protocol/sdk`, in a pnpm workspace. It has no image and no CLI. All payment-claim
  validation lives in toon-protocol/connector, so never re-implement it here. Shared decisions live in
  `toon-protocol/toon-meta`, which is not checked out, so read the ticket and its parent for them.
- Dependencies are already installed. Build before you typecheck: cross-package imports resolve through
  each package's built `dist/`, so a typecheck on a clean tree reports about 90 phantom `TS2307` errors.
- After you finish, the runner runs CI's `build` job itself and won't open a PR while it is red:
  `pnpm lint`, `pnpm -r build`, `pnpm typecheck`, `pnpm format:check`,
  `npx tsx .sandcastle/gate-guard-cli.ts lint-ceiling`, `pnpm -r --parallel test --if-present`,
  `npx vitest run .sandcastle/` and the SDK's connector-contract canary. When you touch the Solana
  settlement surface (`.sandcastle/settlement-surface.ts` lists it) it also runs the Solana redemption proof.
  Run them yourself before you commit. Never weaken, skip or delete a test, and never loosen a lint
  (the `--max-warnings 940` ceiling included), to get green.
- A change to a published package needs a changeset (`pnpm changeset`), as `.changeset/` shows. Never
  run `npm publish`: it ships unresolved `workspace:*` ranges.
- `solana-test-validator` (Solana CLI 2.1.21) is in the sandbox image, so the Solana proof genuinely runs. `SDK_REQUIRE_SOLANA=1` turns
  a missing validator from a skip into a failure. A test that reports zero duration skipped, so treat that
  as a failure.

## When you cannot finish

Stop only when a genuinely new decision is needed and neither the ticket nor its parent settles it, the action is
irreversible, it touches mainnet or real funds, or it needs a credential that no workflow
exposes. In that case, commit nothing and explain what blocks you in a comment on the issue
(`gh issue comment {{ISSUE_NUMBER}}`). The runner moves an issue with no commits to
`needs-triage`.

If your context is getting full (around 150k tokens) before you are done, commit what works,
write the remaining steps to `.sandcastle/logs/handoff-{{ISSUE_NUMBER}}.md`, commit it with
`git add -f`, and end your turn. A fresh session continues from your commits.

When the ticket is done and committed, output <promise>COMPLETE</promise>.
