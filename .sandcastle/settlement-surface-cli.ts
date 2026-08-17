#!/usr/bin/env node
// CLI wiring for the Solana-settlement-surface decision (see
// ./settlement-surface.ts for what the surface is and why the decision is a
// tested module rather than a workflow `paths:` filter).
//
// usage: settlement-surface-cli.ts <changedFilesTxt>
//
// <changedFilesTxt> is one repo-relative path per line, as ci.yml's
// "Decide whether this change touches the Solana settlement surface" step
// produces it from the GitHub API. The single line `__UNKNOWN__` means the
// change set could not be enumerated.
//
// Writes `touched=true|false` to $GITHUB_OUTPUT when set, so the ci.yml
// `build` job can expose it as a job output. Exits 0 on a decision either way:
// "no" is a legitimate answer, and the `CI OK` aggregate -- not this CLI --
// is what turns the answer into a pass or a block.

import { existsSync, appendFileSync, readFileSync } from 'node:fs';

import { decideSettlementSurface, UNKNOWN_CHANGE_SET } from './settlement-surface.ts';

function readChangedFiles(path: string): string[] {
  // A missing input file is a wiring failure, not evidence of irrelevance:
  // fall through to the sentinel so the decision fails safe and the proof runs.
  if (!existsSync(path)) {
    console.log(
      `[settlement-surface] WARNING: ${path} does not exist — treating the change set as unknown`,
    );
    return [UNKNOWN_CHANGE_SET];
  }

  return readFileSync(path, 'utf8').split('\n');
}

function main(): void {
  const changedFilesPath = process.argv[2];
  if (changedFilesPath === undefined) {
    console.log('usage: settlement-surface-cli.ts <changedFilesTxt>');
    process.exit(1);
  }

  const decision = decideSettlementSurface(readChangedFiles(changedFilesPath));

  console.log(
    `[settlement-surface] touched=${String(decision.touched)}: ${decision.reason}`,
  );
  for (const match of decision.matches) {
    console.log(`[settlement-surface]   matched: ${match}`);
  }
  if (decision.touched) {
    console.log(
      '[settlement-surface] the Solana settlement redemption proof will run, and CI OK requires it to pass.',
    );
  } else {
    console.log(
      '[settlement-surface] the Solana settlement redemption proof will be skipped; CI OK requires that skip to be paired with this false.',
    );
  }

  const githubOutput = process.env['GITHUB_OUTPUT'];
  if (githubOutput !== undefined && githubOutput !== '') {
    appendFileSync(githubOutput, `touched=${String(decision.touched)}\n`);
  }
}

main();
