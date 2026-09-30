import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = join(REPO_ROOT, '.github', 'scripts', 'no-op-merge-guard.sh');
const CI_YML = readFileSync(
  join(REPO_ROOT, '.github', 'workflows', 'ci.yml'),
  'utf8'
);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    {
      cwd,
      encoding: 'utf8',
    }
  ).trim();
}

/** Build a repo shaped like a `refs/pull/N/merge` checkout and run the guard in it. */
function runGuard(prContent: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'noop-guard-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'f.txt'), 'base\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');

  // The PR branch changes f.txt (or, for the no-op shape, changes it and reverts it).
  git(dir, 'checkout', '-q', '-b', 'pr');
  writeFileSync(join(dir, 'f.txt'), 'pr\n');
  git(dir, 'commit', '-q', '-am', 'pr change');
  const head = git(dir, 'rev-parse', 'HEAD');

  // main advances. For the #1008 shape, main lands the same content first.
  git(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'f.txt'), prContent ?? 'pr\n');
  writeFileSync(join(dir, 'g.txt'), 'other\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'main moves on');
  git(dir, 'checkout', '-q', '--detach', 'main');
  git(
    dir,
    'merge',
    '-q',
    '--no-ff',
    '-m',
    'merge',
    head,
    ...(prContent === null ? [] : ['-X', 'ours'])
  );

  const res = spawnSync('bash', [GUARD], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: 'pull_request',
      PR_HEAD_SHA: head,
      PR_BASE_REF: 'main',
      PR_NUMBER: '1',
      PR_CHANGED_FILES: '1',
      GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
    },
  });
  return { status: res.status, out: res.stdout + res.stderr };
}

describe('no-op merge guard', () => {
  it('fails a PR whose merge result changes zero files', () => {
    // main already carries the PR's exact content: main's f.txt is 'pr\n' too.
    const r = runGuard('pr\n');
    expect(r.status).toBe(1);
    expect(r.out).toContain('EMPTY commit');
  });

  it('passes a PR with a real diff', () => {
    // main's f.txt is 'pr\n' only in the no-op case; here it stays 'base\n'.
    const r = runGuard('base\n');
    expect(r.status).toBe(0);
    expect(r.out).toContain('changes');
  });

  it('passes plainly on a push event', () => {
    const res = spawnSync('bash', [GUARD], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_EVENT_NAME: 'push' },
    });
    expect(res.status).toBe(0);
  });
});

describe('ci.yml wiring', () => {
  it('has no reference to a toon-meta workflow', () => {
    expect(CI_YML).not.toMatch(/uses:\s*toon-protocol\/toon-meta/);
  });

  it('keeps the guard job name and feeds it to ci-ok', () => {
    expect(CI_YML).toMatch(/no-op-merge:\n\s+name: No-op merge guard/);
    expect(CI_YML).toMatch(/needs: \[[^\]]*no-op-merge[^\]]*\]/);
    expect(CI_YML).toContain('needs.no-op-merge.result');
  });
});
