import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sdk from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sdkRoot = resolve(__dirname, '..');

function readJsonFile(relativePath: string): Record<string, unknown> {
  const content = readFileSync(resolve(sdkRoot, relativePath), 'utf-8');
  return JSON.parse(content) as Record<string, unknown>;
}

// T-1.11-01: All public APIs importable from @crosstown/sdk (P2, E1-R16)

describe('@crosstown/sdk public API exports', () => {
  it('[P2] exports createNode function (T-1.11-01)', () => {
    // Arrange & Act & Assert
    expect(typeof sdk.createNode).toBe('function');
  });

  it('[P2] exports generateMnemonic function (T-1.11-01)', () => {
    // Arrange & Act & Assert
    expect(typeof sdk.generateMnemonic).toBe('function');
  });

  it('[P2] exports fromMnemonic function (T-1.11-01)', () => {
    // Arrange & Act & Assert
    expect(typeof sdk.fromMnemonic).toBe('function');
  });

  it('[P2] exports fromSecretKey function (T-1.11-01)', () => {
    // Arrange & Act & Assert
    expect(typeof sdk.fromSecretKey).toBe('function');
  });

  it('[P2] exports HandlerContext type via createHandlerContext (T-1.11-01)', () => {
    // Arrange & Act & Assert
    // HandlerContext is a type -- we verify the factory function exists
    expect(typeof sdk.createHandlerContext).toBe('function');
  });

  it('[P2] exports HandlerRegistry class (T-1.11-01)', () => {
    // Arrange & Act & Assert
    expect(typeof sdk.HandlerRegistry).toBe('function');
  });

  it('[P2] exports createVerificationPipeline function (T-1.11-01)', () => {
    // Arrange & Act & Assert
    expect(typeof sdk.createVerificationPipeline).toBe('function');
  });

  it('[P2] exports createPricingValidator function (T-1.11-01)', () => {
    // Arrange & Act & Assert
    expect(typeof sdk.createPricingValidator).toBe('function');
  });

  it('[P2] exports createPaymentHandlerBridge function (T-1.11-01)', () => {
    // Arrange & Act & Assert
    expect(typeof sdk.createPaymentHandlerBridge).toBe('function');
  });

  // T-1.11-02: TypeScript types exported correctly (P3)
  // Type-only exports (HandlerContext, NodeConfig, ServiceNode, StartResult,
  // BootstrapEvent, BootstrapEventListener, etc.) are validated by tsc --noEmit.
  // Runtime verification of BootstrapEventListener-typed callback is tested
  // in create-node.test.ts via createNode().on('bootstrap', listener).

  it('[P2] exports all error classes (T-1.11-01)', () => {
    // Arrange & Act & Assert
    expect(typeof sdk.NodeError).toBe('function');
    expect(typeof sdk.IdentityError).toBe('function');
    expect(typeof sdk.HandlerError).toBe('function');
    expect(typeof sdk.VerificationError).toBe('function');
    expect(typeof sdk.PricingError).toBe('function');
  });

  it('[P2] exports event storage handler stub (T-1.11-01)', () => {
    // Arrange & Act & Assert
    expect(typeof sdk.createEventStorageHandler).toBe('function');
  });

  it('[P2] exports exactly the expected set of runtime symbols (T-1.11-01)', () => {
    // Arrange -- the complete set of runtime-visible exports from index.ts.
    // Type-only exports (interfaces, type aliases) are erased at runtime
    // and validated by tsc --noEmit instead.
    const expectedRuntimeExports = new Set([
      // Identity (Story 1.1)
      'generateMnemonic',
      'fromMnemonic',
      'fromSecretKey',
      // Errors (Story 1.0)
      'IdentityError',
      'NodeError',
      'HandlerError',
      'VerificationError',
      'PricingError',
      // Handler context (Story 1.3)
      'createHandlerContext',
      // Handler registry (Story 1.2)
      'HandlerRegistry',
      // Pricing validator (Story 1.5)
      'createPricingValidator',
      // Verification pipeline (Story 1.4)
      'createVerificationPipeline',
      // Payment handler bridge (Story 1.6)
      'createPaymentHandlerBridge',
      // Stubs (Story 1.7)
      'createEventStorageHandler',
      // Node composition (Story 1.7)
      'createNode',
    ]);

    // Act
    const actualExports = new Set(Object.keys(sdk));

    // Assert -- no missing exports
    for (const expected of expectedRuntimeExports) {
      expect(actualExports.has(expected), `missing export: ${expected}`).toBe(
        true
      );
    }

    // Assert -- no unexpected exports (guards against accidental leaks)
    for (const actual of actualExports) {
      expect(
        expectedRuntimeExports.has(actual),
        `unexpected export: ${actual}`
      ).toBe(true);
    }
  });
});

// AC1: package.json has correct module type, engines, dependencies, and tooling config

describe('@crosstown/sdk package.json structure (AC1)', () => {
  const pkg = readJsonFile('package.json');

  it('[P2] has "type": "module" for ESM support (T-1.11-01)', () => {
    // Arrange & Act & Assert
    expect(pkg['type']).toBe('module');
  });

  it('[P2] has "engines" requiring Node.js >=20 (T-1.11-01)', () => {
    // Arrange & Act & Assert
    const engines = pkg['engines'] as Record<string, string> | undefined;
    expect(engines).toBeDefined();
    expect(engines?.['node']).toBe('>=20');
  });

  it('[P2] has @crosstown/connector as optional peer dependency (T-1.11-01)', () => {
    // Arrange
    const peerDeps = pkg['peerDependencies'] as
      | Record<string, string>
      | undefined;
    const peerDepsMeta = pkg['peerDependenciesMeta'] as
      | Record<string, Record<string, boolean>>
      | undefined;

    // Act & Assert
    expect(peerDeps).toBeDefined();
    expect(peerDeps?.['@crosstown/connector']).toBeDefined();
    expect(peerDepsMeta?.['@crosstown/connector']?.['optional']).toBe(true);
  });

  it('[P2] has correct runtime dependencies per NFR-SDK-7 (T-1.11-01)', () => {
    // Arrange
    const deps = pkg['dependencies'] as Record<string, string> | undefined;
    const requiredDeps = [
      '@crosstown/core',
      'nostr-tools',
      '@scure/bip39',
      '@scure/bip32',
      '@noble/curves',
      '@noble/hashes',
    ];

    // Act & Assert
    expect(deps).toBeDefined();
    for (const dep of requiredDeps) {
      expect(deps?.[dep], `missing dependency: ${dep}`).toBeDefined();
    }
  });

  it('[P2] has no unnecessary runtime dependencies beyond the required set (T-1.11-01)', () => {
    // Arrange
    const deps = pkg['dependencies'] as Record<string, string> | undefined;
    const allowedDeps = new Set([
      '@crosstown/core',
      'nostr-tools',
      '@scure/bip39',
      '@scure/bip32',
      '@noble/curves',
      '@noble/hashes',
    ]);

    // Act
    const actualDeps = Object.keys(deps ?? {});

    // Assert -- every actual dependency must be in the allowed set
    for (const dep of actualDeps) {
      expect(allowedDeps.has(dep), `unexpected dependency: ${dep}`).toBe(true);
    }
  });
});

// AC1: TypeScript strict mode is configured

describe('@crosstown/sdk TypeScript strict mode (AC1)', () => {
  it('[P2] SDK tsconfig extends root tsconfig which has strict: true (T-1.11-02)', () => {
    // Arrange
    const sdkTsconfig = readJsonFile('tsconfig.json');
    const rootTsconfig = readJsonFile('../../tsconfig.json');

    // Act & Assert
    // SDK tsconfig must extend root
    expect(sdkTsconfig['extends']).toBe('../../tsconfig.json');
    // Root tsconfig must have strict mode enabled
    const rootCompilerOptions = rootTsconfig['compilerOptions'] as
      | Record<string, unknown>
      | undefined;
    expect(rootCompilerOptions?.['strict']).toBe(true);
  });
});

// AC1: ESLint 9.x flat config and Prettier 3.x are configured

describe('@crosstown/sdk tooling configuration (AC1)', () => {
  const rootPkg = readJsonFile('../../package.json');
  const rootDevDeps = rootPkg['devDependencies'] as
    | Record<string, string>
    | undefined;

  it('[P2] has ESLint 9.x configured at root (T-1.11-02)', () => {
    // Arrange & Act & Assert
    const eslintVersion = rootDevDeps?.['eslint'];
    expect(
      eslintVersion,
      'eslint should be in root devDependencies'
    ).toBeDefined();
    // Version should start with ^9 (ESLint 9.x)
    expect(eslintVersion).toMatch(/^\^9/);
  });

  it('[P2] has Prettier 3.x configured at root (T-1.11-02)', () => {
    // Arrange & Act & Assert
    const prettierVersion = rootDevDeps?.['prettier'];
    expect(
      prettierVersion,
      'prettier should be in root devDependencies'
    ).toBeDefined();
    // Version should start with ^3 (Prettier 3.x)
    expect(prettierVersion).toMatch(/^\^3/);
  });
});

// AC3: package is configured for correct npm publish

describe('@crosstown/sdk npm publish readiness (AC3)', () => {
  const pkg = readJsonFile('package.json');

  it('[P2] has publishConfig with "access": "public" (T-1.11-01)', () => {
    // Arrange & Act & Assert
    const publishConfig = pkg['publishConfig'] as
      | Record<string, string>
      | undefined;
    expect(publishConfig).toBeDefined();
    expect(publishConfig?.['access']).toBe('public');
  });

  it('[P2] has "files" field restricted to dist/ only (T-1.11-01)', () => {
    // Arrange & Act & Assert
    const files = pkg['files'] as string[] | undefined;
    expect(files).toBeDefined();
    expect(files).toEqual(['dist']);
  });

  it('[P2] has ESM exports map with types condition (T-1.11-01)', () => {
    // Arrange & Act & Assert
    const exports = pkg['exports'] as
      | Record<string, Record<string, string>>
      | undefined;
    expect(exports).toBeDefined();
    expect(exports?.['.']?.['types']).toBe('./dist/index.d.ts');
    expect(exports?.['.']?.['import']).toBe('./dist/index.js');
  });

  it('[P2] has main, module, and types fields for legacy resolver compatibility (T-1.11-01)', () => {
    // Arrange & Act & Assert
    // These fields are fallbacks for tools that don't support the "exports" map
    expect(pkg['main']).toBe('./dist/index.js');
    expect(pkg['module']).toBe('./dist/index.js');
    expect(pkg['types']).toBe('./dist/index.d.ts');
  });

  it('[P2] has correct package name for npm scope (T-1.11-01)', () => {
    // Arrange & Act & Assert
    expect(pkg['name']).toBe('@crosstown/sdk');
  });

  it('[P2] has license field set to MIT (T-1.11-01)', () => {
    // Arrange & Act & Assert
    expect(pkg['license']).toBe('MIT');
  });

  it('[P2] has description and keywords for npm discoverability (T-1.11-01)', () => {
    // Arrange & Act & Assert
    expect(pkg['description']).toBeDefined();
    expect(typeof pkg['description']).toBe('string');
    expect((pkg['description'] as string).length).toBeGreaterThan(0);

    const keywords = pkg['keywords'] as string[] | undefined;
    expect(keywords).toBeDefined();
    expect(keywords?.length).toBeGreaterThan(0);
  });

  it('[P2] has repository field pointing to packages/sdk (T-1.11-01)', () => {
    // Arrange & Act & Assert
    const repo = pkg['repository'] as Record<string, string> | undefined;
    expect(repo).toBeDefined();
    expect(repo?.['directory']).toBe('packages/sdk');
  });
});
