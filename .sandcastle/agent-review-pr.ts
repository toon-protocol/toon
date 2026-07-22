// Single-PR review runner — the entry point the `agent:review` label→runner
// workflow (.github/workflows/agent-review.yml) invokes when `agent:review` is
// applied to ONE pull request.
//
// This is the single-pass replacement for the old 4-round `review-round:*`
// reviewer loop. It runs the reviewer role (review-prompt.md — refactor for
// clarity while preserving behavior, enforce CODING_STANDARDS.md) against the
// PR's head branch, and pushes any refinement commits back to the PR. It NEVER
// merges the PR and NEVER closes anything — a human still merges.
//
// STANDALONE-REVIEW CAVEAT (verify on first run)
// ----------------------------------------------
// Sandcastle 0.12.0 exercises the reviewer only INSIDE the parallel loop's
// Phase 2, on a fresh `sandcastle/issue-*` branch it just created. Driving the
// same reviewer standalone against an already-existing PR head branch is our
// interpretation, not a documented engine feature. Two things to confirm on the
// first live run:
//   1. createSandbox({ branch: <existing PR head> }) checks out the EXISTING
//      branch (rather than failing because the ref already exists / creating a
//      divergent one). The workflow checks out the PR head first to help this.
//   2. The built-in {{TARGET_BRANCH}} inside review-prompt.md resolves to `main`
//      for a standalone sandbox. If the diff comes back empty, the base may be
//      resolving wrong — check the reviewer's logged `git diff` command.
//
// Required env:
//   SANDCASTLE_PR_NUMBER      the PR to review (github.event.pull_request.number)
//   CLAUDE_CODE_OAUTH_TOKEN   Claude Max-plan credential (org secret)
//   GH_TOKEN                  token with contents:write + pull-requests:write
//
// Usage:
//   SANDCASTLE_PR_NUMBER=42 npx tsx .sandcastle/agent-review-pr.ts
//   # or: pnpm sandcastle:review   (with SANDCASTLE_PR_NUMBER exported)

import { execFileSync } from "node:child_process";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { sandboxSecrets } from "./sandbox-secrets.ts";

const prNumber = process.env.SANDCASTLE_PR_NUMBER?.trim();
if (!prNumber || !/^\d+$/.test(prNumber)) {
  throw new Error(
    "SANDCASTLE_PR_NUMBER must be set to a numeric PR number " +
      `(got: ${JSON.stringify(process.env.SANDCASTLE_PR_NUMBER)}).`,
  );
}

// Resolve the PR's head branch on the host. `gh` authenticates via GH_TOKEN.
const headRef = execFileSync(
  "gh",
  ["pr", "view", prNumber, "--json", "headRefName", "--jq", ".headRefName"],
  { encoding: "utf8" },
).trim();

if (!headRef) {
  throw new Error(`Could not resolve head branch for PR #${prNumber}.`);
}

// toon is a pnpm workspace — install with the committed lockfile (mirrors
// main.ts). We do NOT copyToWorktree node_modules (pnpm's symlinked store
// breaks across the host->worktree bind-mount).
const hooks = {
  sandbox: {
    onSandboxReady: [
      // Wire `git push` auth deterministically inside the container. The engine
      // (@ai-hero/sandcastle@0.12.0) configures git identity + safe.directory
      // but NO credential helper, so the review-push step's in-sandbox
      // `git push` to the PR branch is unauthenticated and only succeeds by
      // luck. `gh auth setup-git` installs `gh` as git's credential helper
      // (reads GH_TOKEN at push time, stores no token in any file). Guarded on
      // GH_TOKEN so token-less local dev no-ops rather than aborting setup. See
      // ./agent-implement-issue.ts for the full root-cause note. Propagated from
      // store#51 (validated by store#52).
      { command: 'if [ -n "$GH_TOKEN" ]; then gh auth setup-git; fi' },
      { command: "pnpm install --frozen-lockfile" },
    ],
  },
};

console.log(
  `\n=== agent:review runner — PR #${prNumber} (head: ${headRef}) ===\n`,
);

// Resolve the repo once so the host-side push verification can query the remote
// branch ref via the authenticated `gh`.
const nwo = execFileSync(
  "gh",
  ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
  { encoding: "utf8" },
).trim();

// Read the current tip sha of the PR head branch on origin via the authenticated
// host `gh`. Returns null if the branch does not exist on the remote.
function remoteHeadSha(): string | null {
  try {
    return execFileSync(
      "gh",
      ["api", `repos/${nwo}/git/ref/heads/${headRef}`, "--jq", ".object.sha"],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return null;
  }
}

const sandbox = await sandcastle.createSandbox({
  branch: headRef,
  // Forward CLAUDE_CODE_OAUTH_TOKEN + GH_TOKEN into the container (the engine's
  // env resolver does not — see ./sandbox-secrets.ts). GH_TOKEN is what the
  // review-push step's in-sandbox `git push` to the PR branch authenticates with.
  sandbox: docker({ env: sandboxSecrets() }),
  hooks,
});

// Set to a non-null message below when the reviewer produced commits but the
// push did NOT advance the remote PR branch. Recorded (rather than exiting
// inside the try) so the `finally` still closes the sandbox before we fail
// non-zero.
let reviewPushError: string | null = null;

try {
  const review = await sandbox.run({
    name: "reviewer",
    maxIterations: 1,
    agent: sandcastle.claudeCode("claude-sonnet-5"),
    promptFile: "./.sandcastle/review-prompt.md",
    promptArgs: { BRANCH: headRef },
  });

  if (review.commits.length > 0) {
    // Snapshot the remote tip BEFORE pushing so we can prove the push landed.
    const remoteHeadBefore = remoteHeadSha();

    // Push the reviewer's refinement commits back onto the PR branch. No merge,
    // no close, no new PR — the existing PR just gets updated.
    console.log(
      `\nReviewer made ${review.commits.length} commit(s) — pushing to the PR branch.`,
    );
    await sandbox.run({
      name: "push-review",
      maxIterations: 1,
      agent: sandcastle.claudeCode("claude-sonnet-5"),
      promptFile: "./.sandcastle/review-push-prompt.md",
      promptArgs: { BRANCH: headRef },
    });

    // FAIL LOUD. review-push-prompt.md logs COMPLETE regardless of whether the
    // in-sandbox `git push` actually landed. Verify from the HOST that origin's
    // PR-branch tip ADVANCED past its pre-push value. If it did not, the push
    // failed silently (same class as store#50) and the reviewer's refinements
    // never reached the PR — fail the Actions job instead of green-lying.
    const remoteHeadAfter = remoteHeadSha();
    if (remoteHeadAfter === null || remoteHeadAfter === remoteHeadBefore) {
      reviewPushError =
        `\nERROR: the push-review phase reported COMPLETE, but origin's tip ` +
        `for PR branch '${headRef}' did not advance ` +
        `(before: ${remoteHeadBefore ?? "<missing>"}, after: ` +
        `${remoteHeadAfter ?? "<missing>"}).\n` +
        `  The reviewer made ${review.commits.length} commit(s) but the ` +
        `in-sandbox \`git push\` failed silently, so the PR did NOT pick them ` +
        `up. Inspect the push-review phase logs above. The Actions job is ` +
        `failing deliberately so this is not mistaken for success.`;
    } else {
      console.log(
        `\nVerified: origin/${headRef} advanced ` +
          `${remoteHeadBefore ?? "<new>"} → ${remoteHeadAfter}. ` +
          `The PR picked up the reviewer's commits.`,
      );
    }
  } else {
    console.log(
      "\nReviewer made no changes — the code was already clean. Nothing to push.",
    );
  }
} finally {
  await sandbox.close();
}

// Fail loud AFTER the sandbox is closed: a silently-failed review push must turn
// the Actions job red, never green.
if (reviewPushError) {
  console.error(reviewPushError);
  process.exit(1);
}

console.log("\nReview complete. The PR was NOT merged — a human still merges.");
