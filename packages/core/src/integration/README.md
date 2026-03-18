# Integration Tests

This directory contains integration tests that verify the complete TOON protocol stack with real services running.

## Prerequisites

Before running integration tests, you need to have the following services running:

### 1. Genesis Node

```bash
# From repository root
docker compose -p toon-genesis -f docker-compose-genesis.yml up -d
```

This starts:

- Genesis BLS: `http://localhost:3100`
- Genesis Relay: `ws://localhost:7100`
- Genesis Connector: `http://localhost:8080` (API), `http://localhost:8081` (Admin)
- Anvil (local Ethereum): `http://localhost:8545`
- Forgejo: `http://localhost:3004`

### 2. Peer Nodes

Deploy peer nodes using the deploy script:

```bash
# From repository root — deploys N peer nodes with auto-funding and bootstrap
./deploy-peers.sh 3
```

Alternatively, for SDK E2E tests with a controlled 2-peer setup:

```bash
./scripts/sdk-e2e-infra.sh up
```

### 3. Wait for Bootstrap

After starting all services, wait 10-15 seconds for:

- All peers to bootstrap and discover each other
- ILP connections to establish
- Payment channels to open (if settlement is enabled)

You can verify connectivity:

```bash
# Check genesis routing table
curl http://localhost:8081/admin/peers | jq

# Check peer health
curl http://localhost:3110/health | jq  # Peer 1
curl http://localhost:3120/health | jq  # Peer 2
curl http://localhost:3130/health | jq  # Peer 3
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

- Genesis node running
- Peer1, Peer2, Peer3 all running and bootstrapped
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
# Genesis
docker compose -p toon-genesis -f docker-compose-genesis.yml down

# Peers (if using deploy-peers.sh)
# Stop individual peer stacks as needed

# SDK E2E infrastructure
./scripts/sdk-e2e-infra.sh down
```

Remove volumes (clears all data):

```bash
docker compose -p toon-genesis -f docker-compose-genesis.yml down -v
```
