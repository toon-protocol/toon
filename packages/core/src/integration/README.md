# Integration Tests

This directory contains integration tests that verify the complete TOON protocol stack with real services running.

## Prerequisites

Before running integration tests, you need to have the following services running:

### 1. SDK E2E Infrastructure

```bash
# From repository root
./scripts/sdk-e2e-infra.sh up
```

This starts:

- Anvil (local Ethereum): `http://localhost:18545`
- Peer 1 BLS: `http://localhost:19100`
- Peer 1 Relay: `ws://localhost:19700`
- Peer 2 BLS: `http://localhost:19110`
- Peer 2 Relay: `ws://localhost:19710`

### 2. Wait for Bootstrap

After starting all services, wait for the infrastructure script to complete. You can verify connectivity:

```bash
# Check peer health
curl http://localhost:19100/health | jq  # Peer 1
curl http://localhost:19110/health | jq  # Peer 2
```

## Running Tests

### All Integration Tests

```bash
cd packages/core
pnpm test:integration
```

### Specific Test File

```bash
cd packages/core
pnpm vitest run src/integration/multi-hop-relay-sync.test.ts
```

### Watch Mode

```bash
cd packages/core
pnpm vitest --config vitest.integration.config.ts
```

## Available Integration Tests

### `multi-hop-relay-sync.test.ts`

Tests complete relay network functionality:

- Multi-hop ILP routing (Peer1 → Genesis → Peer2)
- Cross-relay event propagation
- Event synchronization with micropayments
- Decentralized relay network

**Prerequisites:**

- SDK E2E infrastructure running (`./scripts/sdk-e2e-infra.sh up`)
- Peer1 and Peer2 running and bootstrapped
- All peers connected via ILP

## Troubleshooting

### Tests Timeout

- Ensure all required services are running
- Check that peers have completed bootstrap (run health checks)
- Verify no port conflicts

### Connection Refused

- Services may still be starting up — wait 15 seconds after starting infrastructure
- Check container logs: `docker logs <container-name>`

### Event Not Found

- Verify BLS is accepting packets: Check `/handle-packet` endpoint
- Check relay WebSocket is accessible: `wscat -c ws://localhost:7100`
- Ensure TOON encoding/decoding is working correctly

### Payment Rejected

- Check peer has sufficient balance (if settlement enabled)
- Verify payment amount meets minimum (default: 5000 units)
- Check connector routing table includes destination

## Clean Up

Stop all services:

```bash
./scripts/sdk-e2e-infra.sh down
```
