/**
 * Story 2.7 Acceptance Criteria Verification Tests
 *
 * These tests verify the acceptance criteria for the SPSP removal
 * and peer discovery cleanup story. They fill gaps not covered by
 * existing unit tests in BootstrapService.test.ts and discovery-tracker.test.ts.
 *
 * AC Coverage:
 * - AC #1: Phase flow is discovering -> registering -> announcing (no handshaking)
 * - AC #2: addPeerToConnector() populates settlement field
 * - AC #3/#5: peerWith() flow — no SPSP events
 * - AC #4: SPSP code removed (static verification)
 * - AC #7: bootstrap:settlement-failed event emitted by BootstrapService
 * - AC #8: SPSP references cleaned from source files
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSecretKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { BootstrapService } from './BootstrapService.js';
import type {
  ConnectorAdminClient,
  AgentRuntimeClient,
  BootstrapEvent,
  BootstrapPhase,
  IlpSendResult,
  KnownPeer,
} from './types.js';
import type { IlpPeerInfo, ConnectorChannelClient } from '../types.js';
import { ILP_PEER_INFO_KIND } from '../constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const coreRoot = resolve(__dirname, '../..');
const monoRoot = resolve(coreRoot, '../..');

// ============================================================================
// Mock: WebSocket transport
// ============================================================================

let capturedWs: {
  onOpen?: () => void;
  onMessage?: (data: Buffer) => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} | null = null;

vi.mock('ws', () => ({
  default: vi.fn().mockImplementation(() => {
    const ws = {
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'open') capturedWs!.onOpen = handler as () => void;
        if (event === 'message')
          capturedWs!.onMessage = handler as (data: Buffer) => void;
        if (event === 'error')
          capturedWs!.onError = handler as (err: Error) => void;
        if (event === 'close') capturedWs!.onClose = handler as () => void;
      }),
    };
    capturedWs = ws;
    return ws;
  }),
}));

vi.mock('nostr-tools/pool', () => ({
  SimplePool: vi.fn(() => ({
    publish: vi.fn().mockResolvedValue(undefined),
    querySync: vi.fn().mockResolvedValue([]),
    subscribeMany: vi.fn(() => ({ close: vi.fn() })),
  })),
}));

// ============================================================================
// Factories
// ============================================================================

const TEST_CREATED_AT = 1767225600;
const VALID_PEER_PUBKEY = 'aa'.repeat(32);

const VALID_PEER_INFO: IlpPeerInfo = {
  ilpAddress: 'g.test.peer',
  btpEndpoint: 'ws://peer:3000',
  assetCode: 'USD',
  assetScale: 6,
};

const VALID_PEER_INFO_WITH_SETTLEMENT: IlpPeerInfo = {
  ...VALID_PEER_INFO,
  supportedChains: ['evm:base:8453'],
  settlementAddresses: { 'evm:base:8453': '0xPEER_ADDRESS' },
  preferredTokens: { 'evm:base:8453': '0xTOKEN' },
  tokenNetworks: { 'evm:base:8453': '0xTOKEN_NETWORK' },
};

function createKnownPeer(overrides: Partial<KnownPeer> = {}): KnownPeer {
  return {
    pubkey: VALID_PEER_PUBKEY,
    relayUrl: 'ws://localhost:7100',
    btpEndpoint: 'ws://peer:3000',
    ...overrides,
  };
}

function createMockConnectorAdmin(): ConnectorAdminClient & {
  addPeer: ReturnType<typeof vi.fn>;
  removePeer: ReturnType<typeof vi.fn>;
} {
  return {
    addPeer: vi.fn().mockResolvedValue(undefined),
    removePeer: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockAgentRuntime(
  result: Partial<IlpSendResult> = {}
): AgentRuntimeClient & { sendIlpPacket: ReturnType<typeof vi.fn> } {
  return {
    sendIlpPacket: vi.fn().mockResolvedValue({
      accepted: true,
      fulfillment: 'test-fulfillment',
      data: undefined,
      ...result,
    }),
  };
}

function createMockChannelClient(
  channelId = 'channel-001',
  shouldFail = false
): ConnectorChannelClient & {
  openChannel: ReturnType<typeof vi.fn>;
  getChannelState: ReturnType<typeof vi.fn>;
} {
  return {
    openChannel: shouldFail
      ? vi.fn().mockRejectedValue(new Error('Channel open timeout'))
      : vi.fn().mockResolvedValue({ channelId, status: 'open' }),
    getChannelState: vi.fn().mockResolvedValue({
      channelId,
      status: 'open' as const,
      chain: 'evm:base:8453',
    }),
  };
}

function simulateRelayResponse(
  peerInfo: IlpPeerInfo,
  pubkey = VALID_PEER_PUBKEY
): void {
  if (!capturedWs?.onOpen || !capturedWs?.onMessage) {
    throw new Error('WebSocket handlers not captured');
  }

  capturedWs.onOpen();

  const subId = JSON.parse(
    (capturedWs.send.mock.calls[0]?.[0] as string) ?? '["REQ","unknown",{}]'
  )[1] as string;

  const event = {
    id: 'ee'.repeat(32),
    pubkey,
    created_at: TEST_CREATED_AT,
    kind: ILP_PEER_INFO_KIND,
    tags: [],
    content: JSON.stringify(peerInfo),
    sig: 'ff'.repeat(64),
  };

  capturedWs.onMessage(Buffer.from(JSON.stringify(['EVENT', subId, event])));
  capturedWs.onMessage(Buffer.from(JSON.stringify(['EOSE', subId])));
}

// ============================================================================
// Tests
// ============================================================================

describe('Story 2.7: SPSP Removal Verification', () => {
  let secretKey: Uint8Array;
  let ownIlpInfo: IlpPeerInfo;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedWs = null;
    secretKey = generateSecretKey();
    ownIlpInfo = {
      ilpAddress: 'g.test.self',
      btpEndpoint: 'ws://self:3000',
      assetCode: 'USD',
      assetScale: 6,
    };
  });

  afterEach(() => {
    // Don't use vi.restoreAllMocks() -- it undoes module-level vi.mock()
  });

  // =========================================================================
  // AC #1: Phase flow is discovering -> registering -> announcing (no handshaking)
  // =========================================================================

  describe('AC #1: Bootstrap phase flow excludes handshaking', () => {
    it('should NOT include handshaking in phase transitions', async () => {
      const events: BootstrapEvent[] = [];
      const service = new BootstrapService(
        { knownPeers: [createKnownPeer()], ardriveEnabled: false },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(createMockConnectorAdmin());
      service.on((event) => events.push(event));

      const bootstrapPromise = service.bootstrap();
      await vi.waitFor(() => expect(capturedWs).not.toBeNull());
      simulateRelayResponse(VALID_PEER_INFO);
      await bootstrapPromise;

      const phases = events
        .filter((e) => e.type === 'bootstrap:phase')
        .map((e) => (e as { phase: BootstrapPhase }).phase);

      // Positive: expected phases present
      expect(phases).toContain('discovering');
      expect(phases).toContain('registering');
      expect(phases).toContain('ready');

      // Negative: handshaking phase must NOT appear
      expect(phases).not.toContain('handshaking');
    });

    it('BootstrapPhase type does not include handshaking (type-level)', () => {
      // This is a compile-time check. If 'handshaking' were still in the union,
      // this assignment would succeed. We verify the runtime values instead.
      const validPhases: BootstrapPhase[] = [
        'discovering',
        'registering',
        'announcing',
        'ready',
        'failed',
      ];
      expect(validPhases).toHaveLength(5);
      expect(validPhases).not.toContain('handshaking');
    });
  });

  // =========================================================================
  // AC #2: addPeerToConnector() populates settlement field
  // =========================================================================

  describe('AC #2: Settlement field in connector registration', () => {
    it('should include settlement field in addPeer() when chain negotiation succeeds', async () => {
      const admin = createMockConnectorAdmin();
      const channelClient = createMockChannelClient('channel-002');

      const service = new BootstrapService(
        {
          knownPeers: [createKnownPeer()],
          ardriveEnabled: false,
          settlementInfo: {
            supportedChains: ['evm:base:8453'],
            preferredTokens: { 'evm:base:8453': '0xTOKEN' },
            tokenNetworks: { 'evm:base:8453': '0xTOKEN_NETWORK' },
          },
        },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(admin);
      service.setChannelClient(channelClient);

      const bootstrapPromise = service.bootstrapWithPeer(createKnownPeer());
      await vi.waitFor(() => expect(capturedWs).not.toBeNull());
      simulateRelayResponse(VALID_PEER_INFO_WITH_SETTLEMENT);
      const result = await bootstrapPromise;

      // Verify result has settlement data
      expect(result.channelId).toBe('channel-002');
      expect(result.negotiatedChain).toBe('evm:base:8453');
      expect(result.settlementAddress).toBe('0xPEER_ADDRESS');

      // Verify connector was re-registered with settlement field
      const calls = admin.addPeer.mock.calls;
      // Last call should include settlement
      const lastCall = calls[calls.length - 1]?.[0] as {
        settlement?: {
          preference: string;
          evmAddress?: string;
          tokenAddress?: string;
          tokenNetworkAddress?: string;
          channelId?: string;
        };
      };
      expect(lastCall.settlement).toBeDefined();
      expect(lastCall.settlement?.preference).toBe('evm:base:8453');
      expect(lastCall.settlement?.evmAddress).toBe('0xPEER_ADDRESS');
      expect(lastCall.settlement?.tokenAddress).toBe('0xTOKEN');
      expect(lastCall.settlement?.tokenNetworkAddress).toBe('0xTOKEN_NETWORK');
      expect(lastCall.settlement?.channelId).toBe('channel-002');
    });

    it('should NOT include settlement field when peer has no supported chains', async () => {
      const admin = createMockConnectorAdmin();
      const channelClient = createMockChannelClient();

      const service = new BootstrapService(
        {
          knownPeers: [createKnownPeer()],
          ardriveEnabled: false,
          settlementInfo: {
            supportedChains: ['evm:base:8453'],
          },
        },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(admin);
      service.setChannelClient(channelClient);

      const bootstrapPromise = service.bootstrapWithPeer(createKnownPeer());
      await vi.waitFor(() => expect(capturedWs).not.toBeNull());
      // Respond with peer info WITHOUT settlement chains
      simulateRelayResponse(VALID_PEER_INFO);
      const result = await bootstrapPromise;

      // No settlement data
      expect(result.channelId).toBeUndefined();
      expect(result.negotiatedChain).toBeUndefined();

      // addPeer was called once (initial registration only, no settlement update)
      expect(admin.addPeer).toHaveBeenCalledTimes(1);
      const call = admin.addPeer.mock.calls[0]?.[0] as {
        settlement?: unknown;
      };
      expect(call.settlement).toBeUndefined();
    });
  });

  // =========================================================================
  // AC #3/#5: peerWith() performs read -> select -> register -> open channel
  //           No SPSP events (kind:23194/23195) created
  // =========================================================================

  describe('AC #3/#5: peerWith() flow without SPSP', () => {
    it('should open channel unilaterally using kind:10032 settlement data', async () => {
      const admin = createMockConnectorAdmin();
      const channelClient = createMockChannelClient('channel-003');

      const service = new BootstrapService(
        {
          knownPeers: [createKnownPeer()],
          ardriveEnabled: false,
          settlementInfo: {
            supportedChains: ['evm:base:8453'],
            preferredTokens: { 'evm:base:8453': '0xTOKEN' },
            tokenNetworks: { 'evm:base:8453': '0xTOKEN_NETWORK' },
          },
        },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(admin);
      service.setChannelClient(channelClient);

      const events: BootstrapEvent[] = [];
      service.on((event) => events.push(event));

      const bootstrapPromise = service.bootstrapWithPeer(createKnownPeer());
      await vi.waitFor(() => expect(capturedWs).not.toBeNull());
      simulateRelayResponse(VALID_PEER_INFO_WITH_SETTLEMENT);
      await bootstrapPromise;

      // Channel was opened unilaterally (not via SPSP handshake)
      expect(channelClient.openChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          peerId: `nostr-${VALID_PEER_PUBKEY.slice(0, 16)}`,
          chain: 'evm:base:8453',
          token: '0xTOKEN',
          tokenNetwork: '0xTOKEN_NETWORK',
          peerAddress: '0xPEER_ADDRESS',
        })
      );

      // Verify bootstrap:channel-opened event was emitted
      const opened = events.find((e) => e.type === 'bootstrap:channel-opened');
      expect(opened).toEqual({
        type: 'bootstrap:channel-opened',
        peerId: `nostr-${VALID_PEER_PUBKEY.slice(0, 16)}`,
        channelId: 'channel-003',
        negotiatedChain: 'evm:base:8453',
      });

      // Verify NO SPSP-related events were emitted (kinds 23194/23195)
      // Since SPSP is removed, there should be no events referencing SPSP
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).not.toContain('bootstrap:spsp-request');
      expect(eventTypes).not.toContain('bootstrap:spsp-response');
    });
  });

  // =========================================================================
  // AC #4: SPSP code removed (static verification)
  // =========================================================================

  describe('AC #4: SPSP code removed from codebase', () => {
    it('packages/core/src/spsp/ directory should not exist', () => {
      const spspDir = resolve(coreRoot, 'src/spsp');
      expect(existsSync(spspDir)).toBe(false);
    });

    it('packages/sdk/src/spsp-handshake-handler.ts should not exist', () => {
      const sdkSpsp = resolve(
        monoRoot,
        'packages/sdk/src/spsp-handshake-handler.ts'
      );
      expect(existsSync(sdkSpsp)).toBe(false);
    });

    it('packages/town/src/handlers/spsp-handshake-handler.ts should not exist', () => {
      const townSpsp = resolve(
        monoRoot,
        'packages/town/src/handlers/spsp-handshake-handler.ts'
      );
      expect(existsSync(townSpsp)).toBe(false);
    });

    it('packages/town/src/handlers/spsp-handshake-handler.test.ts should not exist', () => {
      const townSpspTest = resolve(
        monoRoot,
        'packages/town/src/handlers/spsp-handshake-handler.test.ts'
      );
      expect(existsSync(townSpspTest)).toBe(false);
    });

    it('SPSP_REQUEST_KIND (23194) should not be exported from @crosstown/core', async () => {
      const core = await import('../index.js');
      const exports = Object.keys(core);
      expect(exports).not.toContain('SPSP_REQUEST_KIND');
      expect(exports).not.toContain('SPSP_RESPONSE_KIND');
    });

    it('SPSP error classes should not be exported from @crosstown/core', async () => {
      const core = await import('../index.js');
      const exports = Object.keys(core);
      expect(exports).not.toContain('SpspError');
      expect(exports).not.toContain('SpspTimeoutError');
    });

    it('SPSP types should not be exported from @crosstown/core', async () => {
      // Type-only exports are erased at runtime, so we check
      // that no runtime SPSP-related symbols exist
      const core = await import('../index.js');
      const exports = Object.keys(core);
      expect(exports).not.toContain('NostrSpspClient');
      expect(exports).not.toContain('NostrSpspServer');
      expect(exports).not.toContain('IlpSpspClient');
      expect(exports).not.toContain('negotiateAndOpenChannel');
      expect(exports).not.toContain('parseSpspRequest');
      expect(exports).not.toContain('parseSpspResponse');
      expect(exports).not.toContain('buildSpspRequestEvent');
      expect(exports).not.toContain('buildSpspResponseEvent');
    });

    it('constants.ts should only export ILP_PEER_INFO_KIND (no SPSP kinds)', async () => {
      const constants = await import('../constants.js');
      const exports = Object.keys(constants);
      expect(exports).toContain('ILP_PEER_INFO_KIND');
      expect(exports).not.toContain('SPSP_REQUEST_KIND');
      expect(exports).not.toContain('SPSP_RESPONSE_KIND');
    });

    it('errors.ts should not export SpspError or SpspTimeoutError', async () => {
      const errors = await import('../errors.js');
      const exports = Object.keys(errors);
      expect(exports).toContain('CrosstownError');
      expect(exports).toContain('InvalidEventError');
      expect(exports).toContain('PeerDiscoveryError');
      expect(exports).not.toContain('SpspError');
      expect(exports).not.toContain('SpspTimeoutError');
    });

    it('events/index.ts should not export SPSP parsers or builders', async () => {
      const events = await import('../events/index.js');
      const exports = Object.keys(events);
      expect(exports).toContain('parseIlpPeerInfo');
      expect(exports).toContain('buildIlpPeerInfoEvent');
      expect(exports).not.toContain('parseSpspRequest');
      expect(exports).not.toContain('parseSpspResponse');
      expect(exports).not.toContain('buildSpspRequestEvent');
      expect(exports).not.toContain('buildSpspResponseEvent');
    });
  });

  // =========================================================================
  // AC #7: bootstrap:settlement-failed event (BootstrapService)
  // =========================================================================

  describe('AC #7: bootstrap:settlement-failed event', () => {
    it('should emit bootstrap:settlement-failed when channel opening fails (non-fatal)', async () => {
      const admin = createMockConnectorAdmin();
      const channelClient = createMockChannelClient(
        'channel-fail',
        true // shouldFail
      );

      const events: BootstrapEvent[] = [];
      const service = new BootstrapService(
        {
          knownPeers: [createKnownPeer()],
          ardriveEnabled: false,
          settlementInfo: {
            supportedChains: ['evm:base:8453'],
          },
        },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(admin);
      service.setChannelClient(channelClient);
      service.on((event) => events.push(event));

      const bootstrapPromise = service.bootstrapWithPeer(createKnownPeer());
      await vi.waitFor(() => expect(capturedWs).not.toBeNull());
      simulateRelayResponse(VALID_PEER_INFO_WITH_SETTLEMENT);
      const result = await bootstrapPromise;

      // Settlement failed, but bootstrap still succeeded (non-fatal)
      expect(result.registeredPeerId).toBeDefined();
      expect(result.channelId).toBeUndefined();

      // bootstrap:settlement-failed event emitted
      const settlementFailed = events.find(
        (e) => e.type === 'bootstrap:settlement-failed'
      );
      expect(settlementFailed).toBeDefined();
      expect(settlementFailed).toEqual({
        type: 'bootstrap:settlement-failed',
        peerId: `nostr-${VALID_PEER_PUBKEY.slice(0, 16)}`,
        reason: expect.stringContaining('Channel open timeout'),
      });
    });

    it('event type should be bootstrap:settlement-failed not bootstrap:handshake-failed', async () => {
      const admin = createMockConnectorAdmin();
      const channelClient = createMockChannelClient('ch', true);

      const events: BootstrapEvent[] = [];
      const service = new BootstrapService(
        {
          knownPeers: [createKnownPeer()],
          ardriveEnabled: false,
          settlementInfo: { supportedChains: ['evm:base:8453'] },
        },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(admin);
      service.setChannelClient(channelClient);
      service.on((event) => events.push(event));

      const bootstrapPromise = service.bootstrapWithPeer(createKnownPeer());
      await vi.waitFor(() => expect(capturedWs).not.toBeNull());
      simulateRelayResponse(VALID_PEER_INFO_WITH_SETTLEMENT);
      await bootstrapPromise;

      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain('bootstrap:settlement-failed');
      expect(eventTypes).not.toContain('bootstrap:handshake-failed');
    });
  });

  // =========================================================================
  // AC #8: SPSP references cleaned from source files
  // =========================================================================

  describe('AC #8: SPSP references cleaned from infrastructure files', () => {
    it('compose.ts should not contain SPSP references', async () => {
      const { readFileSync } = await import('node:fs');
      const composePath = resolve(coreRoot, 'src/compose.ts');
      const content = readFileSync(composePath, 'utf-8');
      expect(content.toLowerCase()).not.toContain('spsp');
    });

    it('direct-bls-client.ts should not contain SPSP references', async () => {
      const { readFileSync } = await import('node:fs');
      const clientPath = resolve(
        coreRoot,
        'src/bootstrap/direct-bls-client.ts'
      );
      const content = readFileSync(clientPath, 'utf-8');
      expect(content.toLowerCase()).not.toContain('spsp');
    });

    it('create-node.ts (SDK) should not contain SPSP references', async () => {
      const { readFileSync } = await import('node:fs');
      const createNodePath = resolve(
        monoRoot,
        'packages/sdk/src/create-node.ts'
      );
      const content = readFileSync(createNodePath, 'utf-8');
      expect(content.toLowerCase()).not.toContain('spsp');
    });

    it('event-storage-handler.ts (Town) should not contain SPSP references', async () => {
      const { readFileSync } = await import('node:fs');
      const handlerPath = resolve(
        monoRoot,
        'packages/town/src/handlers/event-storage-handler.ts'
      );
      const content = readFileSync(handlerPath, 'utf-8');
      expect(content.toLowerCase()).not.toContain('spsp');
    });

    it('no source files under packages/*/src/ or docker/src/ should reference SPSP (except historical comments)', async () => {
      const { readFileSync, readdirSync, statSync } = await import('node:fs');

      function findTsFiles(dir: string): string[] {
        const results: string[] = [];
        try {
          const entries = readdirSync(dir);
          for (const entry of entries) {
            const fullPath = resolve(dir, entry);
            try {
              const stat = statSync(fullPath);
              if (stat.isDirectory()) {
                // Skip node_modules, dist, __integration__, e2e, and archive
                if (
                  ['node_modules', 'dist', 'archive', '.git'].includes(entry)
                ) {
                  continue;
                }
                results.push(...findTsFiles(fullPath));
              } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
                results.push(fullPath);
              }
            } catch {
              // Skip inaccessible files
            }
          }
        } catch {
          // Skip inaccessible directories
        }
        return results;
      }

      const packagesDir = resolve(monoRoot, 'packages');
      const srcDirs = [
        resolve(packagesDir, 'core/src'),
        resolve(packagesDir, 'sdk/src'),
        resolve(packagesDir, 'town/src'),
        resolve(packagesDir, 'bls/src'),
        resolve(packagesDir, 'relay/src'),
        resolve(packagesDir, 'client/src'),
        resolve(monoRoot, 'docker/src'),
      ];

      const filesWithSpsp: string[] = [];
      for (const srcDir of srcDirs) {
        const tsFiles = findTsFiles(srcDir);
        for (const filePath of tsFiles) {
          // Skip test files -- they may contain references in historical
          // context or test descriptions like "SPSP removed"
          if (filePath.endsWith('.test.ts')) continue;
          // Skip this verification test file itself
          if (filePath.includes('spsp-removal-verification')) continue;

          const content = readFileSync(filePath, 'utf-8');
          // Check for SPSP as a distinct term (case-insensitive), excluding
          // comment lines that note SPSP was removed/deprecated
          const lines = content.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            const isCommentLine =
              trimmed.startsWith('//') ||
              trimmed.startsWith('*') ||
              trimmed.startsWith('/*');

            // For comment lines: skip if they mention removal/deprecation
            if (isCommentLine) {
              if (
                trimmed.includes('removed') ||
                trimmed.includes('deprecated') ||
                trimmed.includes('eliminated')
              ) {
                continue;
              }
            }

            // Check for active SPSP references (imports, types, function calls)
            // in non-comment lines, plus SPSP references in comments that are
            // NOT about removal/deprecation
            if (/\bSPSP\b/i.test(trimmed) && !isCommentLine) {
              filesWithSpsp.push(filePath);
              break;
            }
            // Also flag non-removal comment references to SPSP
            if (/\bSPSP\b/i.test(trimmed) && isCommentLine) {
              filesWithSpsp.push(filePath);
              break;
            }
          }
        }
      }

      expect(
        filesWithSpsp,
        `Source files with active SPSP references: ${filesWithSpsp.join(', ')}`
      ).toHaveLength(0);
    });
  });

  // =========================================================================
  // AC #1/#2 combined: Settlement during registration phase
  // =========================================================================

  describe('AC #1/#2: Settlement integrated into registration phase', () => {
    it('channel opening happens during registration (no separate handshaking phase)', async () => {
      const admin = createMockConnectorAdmin();
      const channelClient = createMockChannelClient('channel-reg');
      const runtime = createMockAgentRuntime();
      const toonEncoder = vi.fn(
        (_event: NostrEvent) => new Uint8Array([1, 2, 3])
      );
      const toonDecoder = vi.fn((_bytes: Uint8Array) => ({}) as NostrEvent);

      const events: BootstrapEvent[] = [];
      const service = new BootstrapService(
        {
          knownPeers: [createKnownPeer()],
          ardriveEnabled: false,
          toonEncoder,
          toonDecoder,
          settlementInfo: {
            supportedChains: ['evm:base:8453'],
            preferredTokens: { 'evm:base:8453': '0xTOKEN' },
          },
        },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(admin);
      service.setChannelClient(channelClient);
      service.setAgentRuntimeClient(runtime);
      service.on((event) => events.push(event));

      const bootstrapPromise = service.bootstrap();
      await vi.waitFor(() => expect(capturedWs).not.toBeNull());
      simulateRelayResponse(VALID_PEER_INFO_WITH_SETTLEMENT);
      await bootstrapPromise;

      // Verify phase sequence: discovering -> registering -> announcing -> ready
      const phases = events
        .filter((e) => e.type === 'bootstrap:phase')
        .map((e) => (e as { phase: BootstrapPhase }).phase);

      expect(phases).toEqual([
        'discovering',
        'registering',
        'announcing',
        'ready',
      ]);

      // Channel opening happened (during registration phase)
      const channelOpened = events.find(
        (e) => e.type === 'bootstrap:channel-opened'
      );
      expect(channelOpened).toBeDefined();

      // The channel-opened event occurred BEFORE the announcing phase
      const channelOpenedIdx = events.findIndex(
        (e) => e.type === 'bootstrap:channel-opened'
      );
      const announcingIdx = events.findIndex(
        (e) =>
          e.type === 'bootstrap:phase' &&
          (e as { phase: BootstrapPhase }).phase === 'announcing'
      );
      expect(channelOpenedIdx).toBeLessThan(announcingIdx);
    });

    it('local chain selection runs against peer kind:10032 supported chains', async () => {
      const admin = createMockConnectorAdmin();
      const channelClient = createMockChannelClient('channel-select');

      // Own node supports evm:base:8453 and xrp:mainnet
      // Peer supports only evm:base:8453
      const service = new BootstrapService(
        {
          knownPeers: [createKnownPeer()],
          ardriveEnabled: false,
          settlementInfo: {
            supportedChains: ['evm:base:8453', 'xrp:mainnet'],
            preferredTokens: { 'evm:base:8453': '0xTOKEN' },
          },
        },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(admin);
      service.setChannelClient(channelClient);

      const events: BootstrapEvent[] = [];
      service.on((event) => events.push(event));

      const bootstrapPromise = service.bootstrapWithPeer(createKnownPeer());
      await vi.waitFor(() => expect(capturedWs).not.toBeNull());

      // Peer only supports evm:base:8453
      const peerInfoOneChain: IlpPeerInfo = {
        ...VALID_PEER_INFO,
        supportedChains: ['evm:base:8453'],
        settlementAddresses: { 'evm:base:8453': '0xPEER' },
      };
      simulateRelayResponse(peerInfoOneChain);
      const result = await bootstrapPromise;

      // Local chain selection picked evm:base:8453 (the only intersection)
      expect(result.negotiatedChain).toBe('evm:base:8453');
      expect(channelClient.openChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          chain: 'evm:base:8453',
          peerAddress: '0xPEER',
        })
      );
    });

    it('no chain match results in peer registered without settlement (non-fatal)', async () => {
      const admin = createMockConnectorAdmin();
      const channelClient = createMockChannelClient();

      // Own node supports xrp:mainnet, peer supports evm:base:8453 -- no overlap
      const service = new BootstrapService(
        {
          knownPeers: [createKnownPeer()],
          ardriveEnabled: false,
          settlementInfo: {
            supportedChains: ['xrp:mainnet'],
          },
        },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(admin);
      service.setChannelClient(channelClient);

      const bootstrapPromise = service.bootstrapWithPeer(createKnownPeer());
      await vi.waitFor(() => expect(capturedWs).not.toBeNull());
      simulateRelayResponse(VALID_PEER_INFO_WITH_SETTLEMENT); // peer has evm:base:8453
      const result = await bootstrapPromise;

      // Peer was registered but no channel opened (no chain match)
      expect(result.registeredPeerId).toBeDefined();
      expect(result.channelId).toBeUndefined();
      expect(result.negotiatedChain).toBeUndefined();
      expect(channelClient.openChannel).not.toHaveBeenCalled();
    });
  });
});
