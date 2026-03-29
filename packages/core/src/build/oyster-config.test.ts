/**
 * Tests for Oyster CVM Packaging (Story 4.1)
 *
 * GREEN PHASE -- all tests are enabled. The config files and attestation
 * server placeholder have been created.
 *
 * These tests validate that the Oyster CVM deployment configuration is
 * structurally correct: docker-compose-oyster.yml defines the right services,
 * ports, and images; supervisord.conf defines the right process priorities
 * and commands; Dockerfile.oyster extends the base image with supervisord
 * and attestation port; and the attestation-server.ts placeholder exists
 * with correct HTTP endpoints.
 *
 * Test pattern: Static analysis -- read config files as strings, parse,
 * and assert structural properties. This follows the same pattern used by
 * existing tests in this directory (nix-reproducibility.test.ts,
 * reproducibility.test.ts).
 *
 * Modules/files under test:
 *   - `docker/docker-compose-oyster.yml`   -- Oyster CVM deployment manifest
 *   - `docker/supervisord.conf`            -- Multi-process orchestration config
 *   - `docker/Dockerfile.oyster`           -- Extended Dockerfile for Oyster CVM
 *   - `docker/src/attestation-server.ts`   -- Minimal attestation HTTP server
 *
 * Pre-existing RED stubs in attestation-bootstrap.test.ts (T-4.1-01 to T-4.1-04)
 * contain structural inaccuracies (3 services instead of 2, wrong service names,
 * wrong port assignments). This file provides the corrected expectations per the
 * story specification. The pre-existing stubs remain for future integration/E2E.
 *
 * AC coverage:
 *   - T-4.1-01: AC #1, #4 (compose file structure, oyster-cvm compatibility)
 *   - T-4.1-02: AC #2 (supervisord process priorities)
 *   - T-4.1-05: AC #3 (Dockerfile.oyster structure)
 *   - T-4.1-06: AC #3 (attestation server placeholder)
 *   - T-4.1-07: AC #5 (no hardcoded localhost in entrypoints)
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import yaml from 'yaml';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Path to docker-compose-oyster.yml relative to the project root. */
const COMPOSE_PATH = 'docker/docker-compose-oyster.yml';

/** Path to supervisord.conf relative to the project root. */
const SUPERVISORD_PATH = 'docker/supervisord.conf';

/** Path to Dockerfile.oyster relative to the project root. */
const DOCKERFILE_OYSTER_PATH = 'docker/Dockerfile.oyster';

/** Path to attestation server source relative to the project root. */
const ATTESTATION_SERVER_PATH = 'docker/src/attestation-server.ts';

/** Expected service names in docker-compose-oyster.yml (2 services, NOT 3). */
const EXPECTED_SERVICES = ['toon', 'attestation-server'];

/** Expected supervisord program names and priorities (2 programs, NOT 3). */
const EXPECTED_PROGRAMS: Record<string, { priority: number; command: string }> =
  {
    toon: { priority: 10, command: 'node /app/entrypoint-sdk.js' },
    attestation: {
      priority: 20,
      command: 'node /app/attestation-server.js',
    },
  };

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Resolves a relative path to an absolute path from the project root.
 * In tests, process.cwd() should be the monorepo root or we navigate up.
 */
function resolveFromRoot(relativePath: string): string {
  // packages/core is 2 levels deep from project root
  return path.resolve(__dirname, '../../../../', relativePath);
}

// ===========================================================================
// T-4.1-01 [P1]: docker-compose-oyster.yml defines correct services, ports,
// and images (AC #1, #4)
// ===========================================================================

describe('T-4.1-01: docker-compose-oyster.yml structure', () => {
  it('T-4.1-01a: defines exactly 2 services: toon and attestation-server', async () => {
    // Arrange
    const composePath = resolveFromRoot(COMPOSE_PATH);
    const composeContent = await fs.readFile(composePath, 'utf-8');
    const compose = yaml.parse(composeContent);

    // Act
    const serviceNames = Object.keys(compose.services);

    // Assert -- exactly 2 services with correct names
    expect(serviceNames).toHaveLength(2);
    expect(serviceNames).toContain('toon');
    expect(serviceNames).toContain('attestation-server');
  });

  it('T-4.1-01b: toon service uses network_mode host (ports exposed directly)', async () => {
    // Arrange
    const composePath = resolveFromRoot(COMPOSE_PATH);
    const composeContent = await fs.readFile(composePath, 'utf-8');
    const compose = yaml.parse(composeContent);

    // Act
    const toon = compose.services.toon;

    // Assert -- network_mode: host exposes all ports directly (no port mappings needed)
    expect(toon.network_mode).toBe('host');
    // BLS_PORT and WS_PORT set via environment
    const env = toon.environment || {};
    expect(env.BLS_PORT).toBe(3100);
    expect(env.WS_PORT).toBe(7100);
  });

  it('T-4.1-01c: attestation-server service uses network_mode host with ATTESTATION_PORT 1300', async () => {
    // Arrange
    const composePath = resolveFromRoot(COMPOSE_PATH);
    const composeContent = await fs.readFile(composePath, 'utf-8');
    const compose = yaml.parse(composeContent);

    // Act
    const attestation = compose.services['attestation-server'];

    // Assert -- network_mode: host, attestation port set via environment
    expect(attestation.network_mode).toBe('host');
    const env = attestation.environment || {};
    expect(env.ATTESTATION_PORT).toBe(1300);
  });

  it('T-4.1-01d: toon service uses GHCR oyster image', async () => {
    // Arrange
    const composePath = resolveFromRoot(COMPOSE_PATH);
    const composeContent = await fs.readFile(composePath, 'utf-8');
    const compose = yaml.parse(composeContent);

    // Act
    const toon = compose.services.toon;

    // Assert -- image references the GHCR oyster image
    expect(toon.image).toBe('ghcr.io/allidoizcode/toon:oyster');
  });

  it('T-4.1-01e: all services have image or build defined', async () => {
    // Arrange
    const composePath = resolveFromRoot(COMPOSE_PATH);
    const composeContent = await fs.readFile(composePath, 'utf-8');
    const compose = yaml.parse(composeContent);

    // Act & Assert -- each service has image or build
    for (const name of EXPECTED_SERVICES) {
      const service = compose.services[name];
      expect(
        service.image || service.build,
        `Service "${name}" must have image or build defined`
      ).toBeDefined();
    }
  });

  it('T-4.1-01f: toon service includes required environment variables', async () => {
    // Arrange
    const composePath = resolveFromRoot(COMPOSE_PATH);
    const composeContent = await fs.readFile(composePath, 'utf-8');
    const compose = yaml.parse(composeContent);

    // Act
    const toon = compose.services.toon;
    const env = toon.environment || {};
    // Environment can be an object or array of strings
    const envKeys = Array.isArray(env)
      ? env.map((e: string) => e.split('=')[0])
      : Object.keys(env);

    // Assert -- essential env vars present
    const requiredVars = [
      'NODE_ID',
      'NOSTR_SECRET_KEY',
      'ILP_ADDRESS',
      'BLS_PORT',
      'WS_PORT',
    ];
    for (const varName of requiredVars) {
      expect(envKeys).toContain(varName);
    }
  });

  it('T-4.1-01g: attestation-server includes ATTESTATION_PORT environment variable', async () => {
    // Arrange
    const composePath = resolveFromRoot(COMPOSE_PATH);
    const composeContent = await fs.readFile(composePath, 'utf-8');
    const compose = yaml.parse(composeContent);

    // Act
    const attestation = compose.services['attestation-server'];
    const env = attestation.environment || {};
    const envKeys = Array.isArray(env)
      ? env.map((e: string) => e.split('=')[0])
      : Object.keys(env);

    // Assert -- ATTESTATION_PORT present
    expect(envKeys).toContain('ATTESTATION_PORT');
  });

  it('T-4.1-01h: attestation-server has command override to run attestation-server.js', async () => {
    // Arrange
    const composePath = resolveFromRoot(COMPOSE_PATH);
    const composeContent = await fs.readFile(composePath, 'utf-8');
    const compose = yaml.parse(composeContent);

    // Act
    const attestation = compose.services['attestation-server'];

    // Assert -- attestation-server must have an explicit command override
    // because the base image (toon:optimized) CMD is entrypoint-sdk.js,
    // not attestation-server.js. Without this, the service would run the wrong
    // entrypoint.
    expect(attestation.command).toBeDefined();
    const commandStr = Array.isArray(attestation.command)
      ? attestation.command.join(' ')
      : String(attestation.command);
    expect(commandStr).toContain('attestation-server.js');
  });

  it('T-4.1-01i: each service configures the correct expected ports via environment', async () => {
    // Arrange
    const composePath = resolveFromRoot(COMPOSE_PATH);
    const composeContent = await fs.readFile(composePath, 'utf-8');
    const compose = yaml.parse(composeContent);

    // Assert -- with network_mode: host, ports are configured via environment variables
    const toonEnv = compose.services.toon.environment || {};
    expect(toonEnv.BLS_PORT).toBe(3100);
    expect(toonEnv.WS_PORT).toBe(7100);

    const attestationEnv =
      compose.services['attestation-server'].environment || {};
    expect(attestationEnv.ATTESTATION_PORT).toBe(1300);
  });

  it('T-4.1-01j: compose file is valid YAML parseable by oyster-cvm CLI', async () => {
    // Arrange
    const composePath = resolveFromRoot(COMPOSE_PATH);
    const composeContent = await fs.readFile(composePath, 'utf-8');

    // Act & Assert -- YAML parses without error
    expect(() => yaml.parse(composeContent)).not.toThrow();

    // Must have top-level 'services' key
    const compose = yaml.parse(composeContent);
    expect(compose).toHaveProperty('services');
  });
});

// ===========================================================================
// T-4.1-02 [P1]: supervisord.conf defines correct process priorities
// (AC #2)
// ===========================================================================

describe('T-4.1-02: supervisord.conf structure', () => {
  it('T-4.1-02a: defines exactly 2 programs: toon and attestation', async () => {
    // Arrange
    const confPath = resolveFromRoot(SUPERVISORD_PATH);
    const confContent = await fs.readFile(confPath, 'utf-8');

    // Act -- find all [program:*] sections
    const programMatches = confContent.match(/\[program:(\w+)\]/g) || [];
    const programNames = programMatches.map((m: string) =>
      m.replace(/\[program:/g, '').replace(/\]/g, '')
    );

    // Assert -- exactly 2 programs
    expect(programNames).toHaveLength(2);
    expect(programNames).toContain('toon');
    expect(programNames).toContain('attestation');
  });

  it('T-4.1-02b: toon program has priority=10', async () => {
    // Arrange
    const confPath = resolveFromRoot(SUPERVISORD_PATH);
    const confContent = await fs.readFile(confPath, 'utf-8');

    // Act -- extract priority from [program:toon] section
    const toonMatch = confContent.match(
      /\[program:toon\][\s\S]*?priority=(\d+)/
    );

    // Assert
    expect(toonMatch).not.toBeNull();
    expect(Number(toonMatch![1])).toBe(10);
  });

  it('T-4.1-02c: attestation program has priority=20', async () => {
    // Arrange
    const confPath = resolveFromRoot(SUPERVISORD_PATH);
    const confContent = await fs.readFile(confPath, 'utf-8');

    // Act -- extract priority from [program:attestation] section
    const attestationMatch = confContent.match(
      /\[program:attestation\][\s\S]*?priority=(\d+)/
    );

    // Assert
    expect(attestationMatch).not.toBeNull();
    expect(Number(attestationMatch![1])).toBe(20);
  });

  it('T-4.1-02d: toon starts before attestation (lower priority number)', async () => {
    // Arrange
    const confPath = resolveFromRoot(SUPERVISORD_PATH);
    const confContent = await fs.readFile(confPath, 'utf-8');

    // Act
    const toonMatch = confContent.match(
      /\[program:toon\][\s\S]*?priority=(\d+)/
    );
    const attestationMatch = confContent.match(
      /\[program:attestation\][\s\S]*?priority=(\d+)/
    );

    // Assert -- toon priority < attestation priority
    expect(toonMatch).not.toBeNull();
    expect(attestationMatch).not.toBeNull();
    const toonPriority = Number(toonMatch![1]);
    const attestationPriority = Number(attestationMatch![1]);
    expect(toonPriority).toBeLessThan(attestationPriority);
  });

  it('T-4.1-02e: toon command is node /app/entrypoint-sdk.js', async () => {
    // Arrange
    const confPath = resolveFromRoot(SUPERVISORD_PATH);
    const confContent = await fs.readFile(confPath, 'utf-8');

    // Act -- extract command from [program:toon] section
    const toonMatch = confContent.match(/\[program:toon\][\s\S]*?command=(.+)/);

    // Assert -- esbuild bundles output directly to /app/ (no dist/ subdirectory)
    expect(toonMatch).not.toBeNull();
    expect(toonMatch![1]!.trim()).toBe('node /app/entrypoint-sdk.js');
  });

  it('T-4.1-02f: attestation command is node /app/attestation-server.js', async () => {
    // Arrange
    const confPath = resolveFromRoot(SUPERVISORD_PATH);
    const confContent = await fs.readFile(confPath, 'utf-8');

    // Act -- extract command from [program:attestation] section
    const attestationMatch = confContent.match(
      /\[program:attestation\][\s\S]*?command=(.+)/
    );

    // Assert -- esbuild bundles output directly to /app/ (no dist/ subdirectory)
    expect(attestationMatch).not.toBeNull();
    expect(attestationMatch![1]!.trim()).toBe(
      'node /app/attestation-server.js'
    );
  });

  it('T-4.1-02g: both programs run as toon user', async () => {
    // Arrange
    const confPath = resolveFromRoot(SUPERVISORD_PATH);
    const confContent = await fs.readFile(confPath, 'utf-8');

    // Act -- extract user= from both program sections
    const toonUserMatch = confContent.match(
      /\[program:toon\][\s\S]*?user=(\w+)/
    );
    const attestationUserMatch = confContent.match(
      /\[program:attestation\][\s\S]*?user=(\w+)/
    );

    // Assert -- both must be 'toon' user
    expect(toonUserMatch).not.toBeNull();
    expect(attestationUserMatch).not.toBeNull();
    expect(toonUserMatch![1]).toBe('toon');
    expect(attestationUserMatch![1]).toBe('toon');
  });

  it('T-4.1-02h: supervisord runs in nodaemon mode', async () => {
    // Arrange
    const confPath = resolveFromRoot(SUPERVISORD_PATH);
    const confContent = await fs.readFile(confPath, 'utf-8');

    // Act -- check for nodaemon=true in [supervisord] section
    const supervisordMatch = confContent.match(
      /\[supervisord\][\s\S]*?nodaemon=true/
    );

    // Assert
    expect(supervisordMatch).not.toBeNull();
  });

  it('T-4.1-02i: log output goes to stdout/stderr with maxbytes=0', async () => {
    // Arrange
    const confPath = resolveFromRoot(SUPERVISORD_PATH);
    const confContent = await fs.readFile(confPath, 'utf-8');

    // Act -- check both programs have stdout_logfile=/dev/stdout and
    // stderr_logfile=/dev/stderr with maxbytes=0
    const stdoutMatches =
      confContent.match(/stdout_logfile=\/dev\/stdout/g) || [];
    const stderrMatches =
      confContent.match(/stderr_logfile=\/dev\/stderr/g) || [];
    const maxbytesMatches =
      confContent.match(/stdout_logfile_maxbytes=0/g) || [];

    // Assert -- both programs (2 each)
    expect(stdoutMatches.length).toBeGreaterThanOrEqual(2);
    expect(stderrMatches.length).toBeGreaterThanOrEqual(2);
    expect(maxbytesMatches.length).toBeGreaterThanOrEqual(2);
  });

  it('T-4.1-02j: all programs match EXPECTED_PROGRAMS spec (priority + command)', async () => {
    // Arrange
    const confPath = resolveFromRoot(SUPERVISORD_PATH);
    const confContent = await fs.readFile(confPath, 'utf-8');

    // Act & Assert -- verify each expected program has correct priority and command
    for (const [programName, spec] of Object.entries(EXPECTED_PROGRAMS)) {
      const priorityMatch = confContent.match(
        new RegExp(`\\[program:${programName}\\][\\s\\S]*?priority=(\\d+)`)
      );
      const commandMatch = confContent.match(
        new RegExp(`\\[program:${programName}\\][\\s\\S]*?command=(.+)`)
      );

      expect(
        priorityMatch,
        `Program "${programName}" must have a priority`
      ).not.toBeNull();
      expect(Number(priorityMatch![1])).toBe(spec.priority);

      expect(
        commandMatch,
        `Program "${programName}" must have a command`
      ).not.toBeNull();
      expect(commandMatch![1]!.trim()).toBe(spec.command);
    }
  });

  it('T-4.1-02k: attestation has startsecs=5 for relay startup delay', async () => {
    // Arrange
    const confPath = resolveFromRoot(SUPERVISORD_PATH);
    const confContent = await fs.readFile(confPath, 'utf-8');

    // Act -- extract startsecs from [program:attestation] section
    const attestationMatch = confContent.match(
      /\[program:attestation\][\s\S]*?startsecs=(\d+)/
    );

    // Assert
    expect(attestationMatch).not.toBeNull();
    expect(Number(attestationMatch![1])).toBe(5);
  });
});

// ===========================================================================
// T-4.1-05 [P1]: Dockerfile.oyster extends base image correctly (AC #3, #5)
// ===========================================================================

describe('T-4.1-05: Dockerfile.oyster structure', () => {
  it('T-4.1-05a: installs supervisor package via apk', async () => {
    // Arrange
    const dockerfilePath = resolveFromRoot(DOCKERFILE_OYSTER_PATH);
    const content = await fs.readFile(dockerfilePath, 'utf-8');

    // Assert -- must use apk add supervisor (not pip install)
    expect(content).toMatch(/apk add.*supervisor/);
    // Must NOT use pip to install supervisor
    expect(content).not.toMatch(/pip\s+install.*supervisor/);
  });

  it('T-4.1-05b: copies supervisord.conf into image', async () => {
    // Arrange
    const dockerfilePath = resolveFromRoot(DOCKERFILE_OYSTER_PATH);
    const content = await fs.readFile(dockerfilePath, 'utf-8');

    // Assert -- COPY supervisord.conf to /etc/supervisord.conf
    expect(content).toMatch(
      /COPY.*supervisord\.conf.*\/etc\/supervisord\.conf/
    );
  });

  it('T-4.1-05c: CMD uses supervisord (not node directly)', async () => {
    // Arrange
    const dockerfilePath = resolveFromRoot(DOCKERFILE_OYSTER_PATH);
    const content = await fs.readFile(dockerfilePath, 'utf-8');

    // Assert -- CMD references supervisord
    expect(content).toMatch(/CMD.*supervisord/);
    // Must reference the config file
    expect(content).toMatch(/supervisord.*-c.*\/etc\/supervisord\.conf/);
  });

  it('T-4.1-05d: exposes attestation port 1300', async () => {
    // Arrange
    const dockerfilePath = resolveFromRoot(DOCKERFILE_OYSTER_PATH);
    const content = await fs.readFile(dockerfilePath, 'utf-8');

    // Assert -- EXPOSE includes 1300
    expect(content).toMatch(/EXPOSE.*1300/);
  });

  it('T-4.1-05e: preserves HEALTHCHECK targeting BLS port via BLS_PORT env var', async () => {
    // Arrange
    const dockerfilePath = resolveFromRoot(DOCKERFILE_OYSTER_PATH);
    const content = await fs.readFile(dockerfilePath, 'utf-8');

    // Assert -- HEALTHCHECK instruction exists
    expect(content).toMatch(/HEALTHCHECK/);
    // Assert -- HEALTHCHECK uses BLS_PORT env var (default 3100) and /health path
    // The actual HEALTHCHECK CMD uses ${BLS_PORT} variable, not a literal port
    expect(content).toMatch(
      /HEALTHCHECK[\s\S]*?CMD[\s\S]*?BLS_PORT[\s\S]*?\/health/
    );
    // Assert -- BLS_PORT default is 3100
    expect(content).toMatch(/ENV\s+BLS_PORT=3100/);
  });

  it('T-4.1-05f: uses Alpine base image (node:20-alpine)', async () => {
    // Arrange
    const dockerfilePath = resolveFromRoot(DOCKERFILE_OYSTER_PATH);
    const content = await fs.readFile(dockerfilePath, 'utf-8');

    // Assert -- FROM uses alpine
    expect(content).toMatch(/FROM.*node:20-alpine/);
  });
});

// ===========================================================================
// T-4.1-06 [P1]: Attestation server placeholder exists (AC #2, #3)
// ===========================================================================

describe('T-4.1-06: attestation-server.ts placeholder', () => {
  it('T-4.1-06a: attestation-server.ts exists', async () => {
    // Arrange
    const serverPath = resolveFromRoot(ATTESTATION_SERVER_PATH);

    // Act
    const stat = await fs.stat(serverPath);

    // Assert -- file exists and is a regular file
    expect(stat.isFile()).toBe(true);
  });

  it('T-4.1-06b: serves GET /attestation/raw endpoint', async () => {
    // Arrange
    const serverPath = resolveFromRoot(ATTESTATION_SERVER_PATH);
    const content = await fs.readFile(serverPath, 'utf-8');

    // Assert -- defines /attestation/raw route
    expect(content).toMatch(/\/attestation\/raw/);
    // Must be a GET handler
    expect(content).toMatch(/\.get\s*\(\s*['"`]\/attestation\/raw/);
  });

  it('T-4.1-06c: serves GET /health endpoint', async () => {
    // Arrange
    const serverPath = resolveFromRoot(ATTESTATION_SERVER_PATH);
    const content = await fs.readFile(serverPath, 'utf-8');

    // Assert -- defines /health route
    expect(content).toMatch(/\.get\s*\(\s*['"`]\/health/);
  });

  it('T-4.1-06d: uses Hono HTTP framework', async () => {
    // Arrange
    const serverPath = resolveFromRoot(ATTESTATION_SERVER_PATH);
    const content = await fs.readFile(serverPath, 'utf-8');

    // Assert -- imports Hono
    expect(content).toMatch(/import.*Hono.*from\s+['"]hono['"]/);
  });

  it('T-4.1-06e: listens on ATTESTATION_PORT with default 1300', async () => {
    // Arrange
    const serverPath = resolveFromRoot(ATTESTATION_SERVER_PATH);
    const content = await fs.readFile(serverPath, 'utf-8');

    // Assert -- references ATTESTATION_PORT env var and 1300 default
    expect(content).toMatch(/ATTESTATION_PORT/);
    expect(content).toMatch(/1300/);
  });

  it('T-4.1-06f: detects TEE via TEE_ENABLED environment variable', async () => {
    // Arrange
    const serverPath = resolveFromRoot(ATTESTATION_SERVER_PATH);
    const content = await fs.readFile(serverPath, 'utf-8');

    // Assert -- references TEE_ENABLED env var
    expect(content).toMatch(/TEE_ENABLED/);
  });

  it('T-4.1-06g: exports app for testability', async () => {
    // Arrange
    const serverPath = resolveFromRoot(ATTESTATION_SERVER_PATH);
    const content = await fs.readFile(serverPath, 'utf-8');

    // Assert -- exports app for use in tests (e.g., Hono testClient)
    expect(content).toMatch(/export\s+\{.*app.*\}/);
  });

  it('T-4.1-06h: guards against VITEST import (no server start in tests)', async () => {
    // Arrange
    const serverPath = resolveFromRoot(ATTESTATION_SERVER_PATH);
    const content = await fs.readFile(serverPath, 'utf-8');

    // Assert -- VITEST guard prevents server from starting during tests
    expect(content).toMatch(/VITEST/);
    // The serve() call should be inside the VITEST guard
    expect(content).toMatch(/if\s*\(process\.env\['VITEST'\]/);
  });
});

// ===========================================================================
// T-4.1-07 [P2]: No hardcoded localhost in entrypoints (AC #5)
// ===========================================================================

describe('T-4.1-07: vsock proxy compatibility', () => {
  it('T-4.1-07c: attestation-server.ts binds to 0.0.0.0, not localhost', async () => {
    // Arrange
    const serverPath = resolveFromRoot(ATTESTATION_SERVER_PATH);
    const content = await fs.readFile(serverPath, 'utf-8');

    // Act -- check for localhost in server listen/serve calls
    const lines = content.split('\n');
    const codeLines = lines.filter(
      (line) =>
        !line.trim().startsWith('//') &&
        !line.trim().startsWith('*') &&
        !line.includes('console.')
    );
    const serverListenLines = codeLines.filter(
      (line) => line.includes('listen') || line.includes('serve')
    );

    // Assert -- no localhost in server binding (Hono serve() defaults to 0.0.0.0)
    for (const line of serverListenLines) {
      expect(line).not.toMatch(/['"]localhost['"]/);
      expect(line).not.toMatch(/['"]127\.0\.0\.1['"]/);
    }
  });

  it('T-4.1-07d: shared.ts external URLs come from env vars, not hardcoded external hosts', async () => {
    // Arrange
    const sharedPath = resolveFromRoot('docker/src/shared.ts');
    const content = await fs.readFile(sharedPath, 'utf-8');

    // Assert -- CONNECTOR_URL and CONNECTOR_ADMIN_URL are read from env vars
    expect(content).toMatch(/env\['CONNECTOR_URL'\]/);
    expect(content).toMatch(/env\['CONNECTOR_ADMIN_URL'\]/);

    // The BTP_ENDPOINT and CONNECTOR_ADMIN_URL defaults use the nodeId
    // (container name), not hardcoded external addresses
    expect(content).toMatch(/BTP_ENDPOINT.*\$\{nodeId\}/);
    expect(content).toMatch(/CONNECTOR_ADMIN_URL.*\$\{nodeId\}/);
  });
});

// ===========================================================================
// T-4.1-11 [P1]: supervisord.conf process reliability (AC #2)
// ===========================================================================

describe('T-4.1-11: supervisord.conf process reliability', () => {
  it('T-4.1-11a: toon program has autorestart=true', async () => {
    // Arrange
    const confPath = resolveFromRoot(SUPERVISORD_PATH);
    const confContent = await fs.readFile(confPath, 'utf-8');

    // Act -- extract autorestart from [program:toon] section
    const toonMatch = confContent.match(
      /\[program:toon\][\s\S]*?autorestart=(\w+)/
    );

    // Assert -- autorestart must be enabled for CVM reliability
    expect(toonMatch).not.toBeNull();
    expect(toonMatch![1]).toBe('true');
  });

  it('T-4.1-11b: attestation program has autorestart=true', async () => {
    // Arrange
    const confPath = resolveFromRoot(SUPERVISORD_PATH);
    const confContent = await fs.readFile(confPath, 'utf-8');

    // Act -- extract autorestart from [program:attestation] section
    const attestationMatch = confContent.match(
      /\[program:attestation\][\s\S]*?autorestart=(\w+)/
    );

    // Assert -- autorestart must be enabled for CVM reliability
    expect(attestationMatch).not.toBeNull();
    expect(attestationMatch![1]).toBe('true');
  });

  it('T-4.1-11c: stderr logs go to /dev/stderr with maxbytes=0 for both programs', async () => {
    // Arrange
    const confPath = resolveFromRoot(SUPERVISORD_PATH);
    const confContent = await fs.readFile(confPath, 'utf-8');

    // Act -- count stderr log directives
    const stderrLogMatches =
      confContent.match(/stderr_logfile=\/dev\/stderr/g) || [];
    const stderrMaxbytesMatches =
      confContent.match(/stderr_logfile_maxbytes=0/g) || [];

    // Assert -- both programs must have stderr log configuration
    expect(stderrLogMatches.length).toBeGreaterThanOrEqual(2);
    expect(stderrMaxbytesMatches.length).toBeGreaterThanOrEqual(2);
  });
});

// ===========================================================================
// T-4.1-12 [P1]: Dockerfile.oyster build and security properties (AC #3, #5)
// ===========================================================================

describe('T-4.1-12: Dockerfile.oyster build and security', () => {
  it('T-4.1-12a: uses multi-stage build (builder + runtime stages)', async () => {
    // Arrange
    const dockerfilePath = resolveFromRoot(DOCKERFILE_OYSTER_PATH);
    const content = await fs.readFile(dockerfilePath, 'utf-8');

    // Act -- count FROM directives
    const fromMatches = content.match(/^FROM\s+/gm) || [];

    // Assert -- at least 2 FROM directives (builder + runtime)
    expect(fromMatches.length).toBeGreaterThanOrEqual(2);
  });

  it('T-4.1-12b: has a named builder stage', async () => {
    // Arrange
    const dockerfilePath = resolveFromRoot(DOCKERFILE_OYSTER_PATH);
    const content = await fs.readFile(dockerfilePath, 'utf-8');

    // Assert -- FROM ... AS builder
    expect(content).toMatch(/FROM.*AS\s+builder/i);
  });

  it('T-4.1-12c: creates non-root toon user (UID 1001)', async () => {
    // Arrange
    const dockerfilePath = resolveFromRoot(DOCKERFILE_OYSTER_PATH);
    const content = await fs.readFile(dockerfilePath, 'utf-8');

    // Assert -- adduser for toon with UID 1001
    expect(content).toMatch(/adduser.*toon/);
    expect(content).toMatch(/1001/);
  });

  it('T-4.1-12d: creates /data volume for persistent storage', async () => {
    // Arrange
    const dockerfilePath = resolveFromRoot(DOCKERFILE_OYSTER_PATH);
    const content = await fs.readFile(dockerfilePath, 'utf-8');

    // Assert -- VOLUME directive for /data
    expect(content).toMatch(/VOLUME\s+\/data/);
  });

  it('T-4.1-12e: does NOT set USER directive (supervisord needs root)', async () => {
    // Arrange
    const dockerfilePath = resolveFromRoot(DOCKERFILE_OYSTER_PATH);
    const content = await fs.readFile(dockerfilePath, 'utf-8');

    // Act -- find USER directives in runtime stage (after second FROM)
    const stages = content.split(/^FROM\s+/m);
    // Stage 0 is before first FROM (empty or comments)
    // Stage 1 is the builder stage
    // Stage 2+ is the runtime stage(s)
    const runtimeStage = stages[2] || '';

    // Assert -- runtime stage should NOT have USER directive
    // supervisord must run as root to switch users via user= directive
    expect(runtimeStage).not.toMatch(/^USER\s+/m);
  });

  it('T-4.1-12f: sets NODE_ENV=production', async () => {
    // Arrange
    const dockerfilePath = resolveFromRoot(DOCKERFILE_OYSTER_PATH);
    const content = await fs.readFile(dockerfilePath, 'utf-8');

    // Assert -- ENV NODE_ENV=production
    expect(content).toMatch(/ENV\s+NODE_ENV=production/);
  });
});

// ===========================================================================
// T-4.1-13 [P1]: Compose file oyster-cvm CLI compatibility (AC #4)
// ===========================================================================

describe('T-4.1-13: compose file oyster-cvm compatibility', () => {
  it('T-4.1-13a: does not use deprecated "version" key', async () => {
    // Arrange
    const composePath = resolveFromRoot(COMPOSE_PATH);
    const composeContent = await fs.readFile(composePath, 'utf-8');
    const compose = yaml.parse(composeContent);

    // Assert -- no "version" top-level key (deprecated in Compose Specification,
    // and oyster-cvm uses the modern format)
    expect(compose).not.toHaveProperty('version');
  });

  it('T-4.1-13b: services key is the only required top-level key', async () => {
    // Arrange
    const composePath = resolveFromRoot(COMPOSE_PATH);
    const composeContent = await fs.readFile(composePath, 'utf-8');
    const compose = yaml.parse(composeContent);

    // Act -- get top-level keys
    const topLevelKeys = Object.keys(compose);

    // Assert -- must have 'services', may have optional compose keys
    // but should NOT have keys that oyster-cvm cannot process
    expect(topLevelKeys).toContain('services');
    // Only allow standard compose keys
    const allowedKeys = [
      'services',
      'volumes',
      'networks',
      'configs',
      'secrets',
      'name',
    ];
    for (const key of topLevelKeys) {
      expect(
        allowedKeys,
        `Unexpected top-level key "${key}" may not be compatible with oyster-cvm CLI`
      ).toContain(key);
    }
  });

  it('T-4.1-13c: all services use network_mode host (no explicit port mappings)', async () => {
    // Arrange
    const composePath = resolveFromRoot(COMPOSE_PATH);
    const composeContent = await fs.readFile(composePath, 'utf-8');
    const compose = yaml.parse(composeContent);

    // Act & Assert -- with network_mode: host, no explicit port mappings needed
    for (const name of EXPECTED_SERVICES) {
      const service = compose.services[name];
      expect(service.network_mode).toBe('host');
    }
  });

  it('T-4.1-13d: both services use the same base image', async () => {
    // Arrange
    const composePath = resolveFromRoot(COMPOSE_PATH);
    const composeContent = await fs.readFile(composePath, 'utf-8');
    const compose = yaml.parse(composeContent);

    // Act
    const toonImage = compose.services.toon.image;
    const attestationImage = compose.services['attestation-server'].image;

    // Assert -- both use the same GHCR oyster image
    expect(toonImage).toBe('ghcr.io/allidoizcode/toon:oyster');
    expect(attestationImage).toBe('ghcr.io/allidoizcode/toon:oyster');
  });

  it('T-4.1-13e: no port conflicts between services (environment-configured ports are unique)', async () => {
    // Arrange
    const composePath = resolveFromRoot(COMPOSE_PATH);
    const composeContent = await fs.readFile(composePath, 'utf-8');
    const compose = yaml.parse(composeContent);

    // Act -- collect configured ports from environment variables
    const toonEnv = compose.services.toon.environment || {};
    const attestationEnv =
      compose.services['attestation-server'].environment || {};
    const allPorts = [
      toonEnv.BLS_PORT,
      toonEnv.WS_PORT,
      attestationEnv.ATTESTATION_PORT,
    ];

    // Assert -- no duplicate ports
    const uniquePorts = new Set(allPorts);
    expect(uniquePorts.size).toBe(allPorts.length);
  });

  it('T-4.1-13f: all three required ports are configured (3100, 7100, 1300)', async () => {
    // Arrange
    const composePath = resolveFromRoot(COMPOSE_PATH);
    const composeContent = await fs.readFile(composePath, 'utf-8');
    const compose = yaml.parse(composeContent);

    // Act -- collect configured ports from environment variables
    const toonEnv = compose.services.toon.environment || {};
    const attestationEnv =
      compose.services['attestation-server'].environment || {};
    const allPorts = [
      toonEnv.BLS_PORT,
      toonEnv.WS_PORT,
      attestationEnv.ATTESTATION_PORT,
    ];

    // Assert -- all required ports present
    expect(allPorts).toContain(3100);
    expect(allPorts).toContain(7100);
    expect(allPorts).toContain(1300);
  });
});
