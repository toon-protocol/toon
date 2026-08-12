// Guards the reviewer's Spec axis against silently losing its acceptance
// criteria (toon-meta#248, review finding on toon#189).
//
// WHY THIS EXISTS
// ---------------
// The reviewer runs INSIDE the sandcastle container. The container's GH_TOKEN
// is baked in at `docker run -e` time (./sandbox-secrets.ts) and cannot be
// updated afterwards, while a GitHub App installation token expires ONE HOUR
// after it is minted. Raising the runner step's wall clock 50 -> 170 minutes
// made runs that cross that hour possible for the first time, so an
// in-container `gh issue view` — which is how the reviewer used to obtain the
// issue body — starts returning `Bad credentials` on exactly the long runs the
// new clock exists to allow.
//
// The failure is silent and worse than a crash: the reviewer still emits a
// verdict, just one that never read the acceptance criteria. A green-looking
// review with no Spec axis is indistinguishable from a real one downstream.
//
// The fix is to remove the dependency: the HOST (whose `gh` credential
// pushBranch() re-mints) fetches the body and hands it to the reviewer through
// promptArgs. These assertions pin that arrangement in place, because the
// regression's only symptom is a review that looks fine.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sandcastleDir = resolve(dirname(fileURLToPath(import.meta.url)));

function read(name: string): string {
  return readFileSync(join(sandcastleDir, name), "utf8");
}

describe("reviewer Spec-axis context", () => {
  it("passes the issue body to the reviewer through promptArgs", () => {
    expect(read("review-verdict.ts")).toContain("ISSUE_BODY:");
  });

  it("renders the issue body into the review prompt", () => {
    expect(read("review-prompt.md")).toContain("{{ISSUE_BODY}}");
  });

  it("does not tell the reviewer to fetch the issue with `gh` in-container", () => {
    // The container's credential dies an hour into a run that may now last
    // 170 minutes, so this instruction would degrade the Spec axis to nothing
    // on precisely the long runs the raised clock permits.
    expect(read("review-prompt.md")).not.toMatch(/^\s*gh issue view/m);
  });

  it("fetches title AND body on the host, in both runners' issue lookups", () => {
    // agent-implement-issue.ts resolves the issue from SANDCASTLE_ISSUE_NUMBER;
    // review-verdict.ts's resolveIssueFromPrBody resolves it from the PR body.
    // Either path can feed the reviewer, so neither may drop the body.
    for (const file of ["agent-implement-issue.ts", "review-verdict.ts"]) {
      expect(read(file)).toContain('"title,body"');
    }
  });
});
