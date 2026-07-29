// Guards the root vitest config against drifting out of sync with the
// per-package vitest configs (toon-protocol/toon#144).
//
// WHY THIS EXISTS
// ---------------
// CI's blocking test command is `pnpm -r --parallel test`, which runs each
// package under its OWN packages/<name>/vitest.config.ts. The root
// vitest.config.ts is what a developer gets from `pnpm test` at the repo
// root, and it is never the config CI runs a full suite under. That gap is
// how toon#144 happened: packages/sdk/vitest.config.ts sets
// `TOON_GENESIS_PEERS: '[]'` to keep zero-known-peer fixtures hermetic
// (toon#79), the root config never got the same setting, and so the root run
// accumulated 50 failures against the live devnet genesis seed while CI
// stayed green and nobody saw it (fixed in #146).
//
// Re-running all ~2300 tests a second time under the root config would close
// the gap with the highest possible fidelity, but it costs more CI wall-clock
// than the frozen .sandcastle/gate-baseline.json speed budget has headroom
// for. This guard targets the actual failure mode instead, for ~0 seconds:
// it asserts that every environment variable a package config sets is also in
// effect under the root config, so the next package-level `env` addition that
// the root config does not mirror fails the gate on the pull request that
// introduces it, rather than silently rotting the root run.
//
// HOW IT WORKS
// ------------
// This file is matched by the root config's `.sandcastle/*.test.ts` include
// glob, and CI runs it via `npx vitest run .sandcastle/`. That means the
// process executing these assertions is itself configured by the root
// vitest.config.ts, so `process.env` here IS the root config's effective
// environment. The check therefore compares real applied behaviour rather
// than parsing config syntax, and cannot be fooled by a config that defines
// the right key in a way vitest does not actually apply.

import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(repoRoot, 'packages');

/**
 * The per-package configs that back `pnpm -r --parallel test`, i.e. exactly
 * the ones CI's blocking test step uses. The `vitest.integration.config.ts` /
 * `vitest.e2e.config.ts` variants are deliberately excluded: they drive
 * opt-in suites that the root `pnpm test` does not include, so they are not
 * expected to be mirrored by the root config.
 */
function findPackageTestConfigs(): { name: string; configPath: string }[] {
  return readdirSync(packagesDir)
    .filter((entry) => statSync(join(packagesDir, entry)).isDirectory())
    .map((name) => ({ name, configPath: join(packagesDir, name, 'vitest.config.ts') }))
    .filter(({ configPath }) => {
      try {
        return statSync(configPath).isFile();
      } catch {
        return false;
      }
    });
}

interface VitestConfigModule {
  default?: { test?: { env?: Record<string, string> } };
}

const packageConfigs = findPackageTestConfigs();

describe('root vitest config / per-package vitest config parity', () => {
  // A rename or deletion that leaves this guard silently iterating over an
  // empty list would make every assertion below vacuously pass.
  it('discovers the per-package vitest configs it is meant to guard', () => {
    expect(packageConfigs.map((c) => c.name).sort()).toEqual([
      'core',
      'sdk',
      'settlement-digest',
    ]);
  });

  it.each(packageConfigs)(
    'root config applies every env var packages/$name/vitest.config.ts sets',
    async ({ name, configPath }) => {
      const module: VitestConfigModule = await import(configPath);
      const packageEnv = module.default?.test?.env ?? {};

      for (const [key, value] of Object.entries(packageEnv)) {
        expect(
          process.env[key],
          `packages/${name}/vitest.config.ts sets test.env.${key}=${JSON.stringify(value)}, ` +
            `but the root vitest.config.ts does not apply it. The root run and the ` +
            `per-package CI run would behave differently — add ${key} to the root ` +
            `config's test.env (see toon#144).`,
        ).toBe(value);
      }
    },
  );
});
