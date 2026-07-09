# Integration Tests

This directory contains integration tests that exercise the TOON protocol
stack end-to-end within a single test process — no external services
required.

## Running

```bash
# From packages/core
pnpm test:integration

# Or directly
pnpm exec vitest run --config vitest.integration.config.ts
```

## Available Integration Tests

### `five-peer-bootstrap.test.ts`

Exercises the full 3-phase bootstrap (discover → register → announce) across
5 peers with peer0 as genesis:

- Each peer runs a real `NostrRelayServer` bound to an ephemeral local port
  (`127.0.0.1:0`) — no fixed ports, no Docker infrastructure.
- ILP packet routing between peers is simulated with an in-memory router
  (`InMemoryIlpRouter`) rather than a live connector.
- Peer identities, EVM addresses, and settlement chain config come from the
  fixture wallets in `testnet-wallets.json`.

No environment setup, RPC endpoints, or `docker`/infra scripts are needed —
the whole suite runs in-process via `vitest`.

## Troubleshooting

### Tests Timeout

- Check for port exhaustion if running many suites concurrently.
- `vitest.integration.config.ts` runs tests with `pool: 'forks'` and
  `singleFork: true` to avoid ephemeral-port collisions between peers.

### Unexpected Failures

- Ensure `pnpm -r build` has been run so workspace package types are current.
- Re-run with `pnpm exec vitest run --config vitest.integration.config.ts --reporter=verbose`
  for more detail on which bootstrap phase failed.
