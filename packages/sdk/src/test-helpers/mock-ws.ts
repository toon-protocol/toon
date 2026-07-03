/**
 * Shared `vi.mock('ws', ...)` factory for SDK unit tests.
 *
 * `BootstrapService.bootstrap()` (packages/core/src/bootstrap/BootstrapService.ts)
 * always merges in the bundled genesis peer (wss://relay-ws.devnet.toonprotocol.dev)
 * via `GenesisPeerLoader.loadAllPeers()`, even when a suite passes `knownPeers: []`,
 * then opens a real `new WebSocket(...)` per peer independent of any
 * `vi.mock('nostr-tools')` already in place. That live dial is the flake source
 * behind #59 — mirrors the transport-boundary mock in
 * packages/core/src/bootstrap/BootstrapService.test.ts, but resolves the socket
 * closed immediately (rather than simulating a full handshake) since these
 * suites don't assert on bootstrap peer results.
 */
import { vi } from 'vitest';

export function mockWs() {
  return {
    default: vi.fn().mockImplementation(() => {
      return {
        send: vi.fn(),
        close: vi.fn(),
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          if (event === 'close') {
            queueMicrotask(() => handler());
          }
        }),
      };
    }),
  };
}
