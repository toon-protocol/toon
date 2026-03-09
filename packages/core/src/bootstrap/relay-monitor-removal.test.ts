/**
 * Verification-by-absence: RelayMonitor removal regression test.
 *
 * Asserts that RelayMonitor and RelayMonitorConfig references have been
 * removed from the codebase. Follows the pattern established by
 * spsp-removal-verification.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const monoRoot = resolve(__dirname, '../../../..');

function grepDirs(pattern: string, dirs: string[]): string[] {
  try {
    const output = execFileSync(
      'grep',
      [
        '-r',
        '--include=*.ts',
        '-l',
        pattern,
        ...dirs,
      ],
      { encoding: 'utf-8' }
    );
    return output
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter(
        (f) =>
          !f.includes('relay-monitor-removal.test.ts') &&
          !f.includes('spsp-removal-verification.test.ts') &&
          !f.includes('/archive/') &&
          !f.includes('/dist/')
      );
  } catch {
    // grep returns exit code 1 when no matches found
    return [];
  }
}

function grepPackages(pattern: string): string[] {
  return grepDirs(pattern, [
    resolve(monoRoot, 'packages'),
    resolve(monoRoot, 'docker/src'),
  ]);
}

describe('RelayMonitor removal verification', () => {
  it('zero imports of RelayMonitor in packages/', () => {
    const matches = grepPackages('import.*RelayMonitor');
    expect(
      matches,
      `Found RelayMonitor imports in:\n${matches.join('\n')}`
    ).toEqual([]);
  });

  it('zero imports of RelayMonitorConfig in packages/', () => {
    const matches = grepPackages('RelayMonitorConfig');
    expect(
      matches,
      `Found RelayMonitorConfig references in:\n${matches.join('\n')}`
    ).toEqual([]);
  });

  it('RelayMonitor.ts file does not exist', () => {
    const filePath = resolve(__dirname, 'RelayMonitor.ts');
    expect(existsSync(filePath)).toBe(false);
  });

  it('RelayMonitor.test.ts file does not exist', () => {
    const filePath = resolve(__dirname, 'RelayMonitor.test.ts');
    expect(existsSync(filePath)).toBe(false);
  });
});
