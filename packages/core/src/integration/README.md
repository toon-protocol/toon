# Integration Tests

This directory contains integration tests that verify the complete Crosstown protocol stack with real services running.

## Prerequisites

Before running integration tests, you need to have the following services running:

### 1. Genesis Node
```bash
# From repository root
docker compose up -d
```

This starts:
- Genesis BLS: `http://localhost:3100`
- Genesis Relay: `ws://localhost:7100`
- Genesis Connector: `http://localhost:8080` (API), `http://localhost:8081` (Admin)
- Anvil (local Ethereum): `http://localhost:8545`
- Forgejo: `http://localhost:3004`

### 2. Peer Nodes

#### Peer 1
```bash
docker compose -p crosstown-peer1 -f docker-compose-peer1.yml up -d
```

Services:
- BLS: `http://localhost:3110`
- Relay: `ws://localhost:7110`
- Connector: `http://localhost:3010` (API), `http://localhost:8091` (Admin)

#### Peer 2
```bash
docker compose -p crosstown-peer2 -f docker-compose-peer2.yml up -d
```

Services:
- BLS: `http://localhost:3120`
- Relay: `ws://localhost:7120`
- Connector: `http://localhost:3020` (API), `http://localhost:8101` (Admin)

#### Peer 3
```bash
docker compose -p crosstown-peer3 -f docker-compose-peer3.yml up -d
```

Services:
- BLS: `http://localhost:3130`
- Relay: `ws://localhost:7130`
- Connector: `http://localhost:3030` (API), `http://localhost:8111` (Admin)

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

### `crosstown-spsp-integration.test.ts`
Tests the SPSP handshake flow:
- Peer discovery via Nostr (kind:10032 events)
- SPSP parameter negotiation
- Payment channel creation
- Routing table updates

**Prerequisites:**
- Genesis node running
- Docker services (Anvil, Connector, Relay)

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
- Services may still be starting up - wait 15 seconds after `docker compose up`
- Check container logs: `docker logs <container-name>`

### Event Not Found
- Verify BLS is accepting packets: Check `/handle-packet` endpoint
- Check relay WebSocket is accessible: `curl http://localhost:7100/health`
- Ensure TOON encoding/decoding is working correctly

### Payment Rejected
- Check peer has sufficient balance (if settlement enabled)
- Verify payment amount meets minimum (default: 5000 units)
- Check connector routing table includes destination

## Clean Up

Stop all services:
```bash
# Genesis
docker compose down

# Peers
docker compose -p crosstown-peer1 -f docker-compose-peer1.yml down
docker compose -p crosstown-peer2 -f docker-compose-peer2.yml down
docker compose -p crosstown-peer3 -f docker-compose-peer3.yml down
```

Remove volumes (clears all data):
```bash
docker compose down -v
docker compose -p crosstown-peer1 -f docker-compose-peer1.yml down -v
docker compose -p crosstown-peer2 -f docker-compose-peer2.yml down -v
docker compose -p crosstown-peer3 -f docker-compose-peer3.yml down -v
```
