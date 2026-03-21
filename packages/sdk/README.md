# @toon-protocol/sdk

The building blocks for creating services that participate in the TOON Protocol network. Events are encoded in [TOON format](https://github.com/toon-format/toon) and discovered via [Nostr](https://github.com/nostr-protocol/nips).

## What It Does

The SDK provides a framework for processing ILP-paid Nostr events. You register handlers for specific event kinds, and the SDK handles everything else: identity derivation, Schnorr signature verification, payment validation, and handler dispatch.

```
Incoming ILP packet
  → Size check (1MB max)
    → TOON parse (extract metadata)
      → Signature verification (Schnorr)
        → Payment validation (per-byte pricing)
          → Your handler (business logic)
```

## Install

```bash
npm install @toon-protocol/sdk
```

## Quick Example

```typescript
import { createNode, fromMnemonic } from '@toon-protocol/sdk';
import { ConnectorNode } from '@toon-protocol/connector';

// 1. Create an identity
const identity = fromMnemonic('your twelve word mnemonic phrase here');

// 2. Create an embedded ILP connector
const connector = new ConnectorNode({
  nodeId: 'my-node',
  btpServerPort: 3000,
  environment: 'development',
  deploymentMode: 'embedded',
  peers: [],
  routes: [],
});

// 3. Create a node with the connector
const node = createNode({
  secretKey: identity.secretKey,
  connector,
  basePricePerByte: 10n,
});

// 4. Register handlers for specific event kinds
node.on(1, async (ctx) => {
  const event = ctx.decode();
  console.log(`Received kind:${ctx.kind} from ${ctx.pubkey}`);
  console.log(`Paid: ${ctx.amount} units`);
  return ctx.accept({ eventId: event.id });
});

// 5. Start the node
const result = await node.start();
console.log(`Connected to ${result.peerCount} peers`);
```

> **Easier path:** If you just want to run a relay, use [`@toon-protocol/town`](../town) — it wraps the SDK with sensible defaults and runs out of the box. The SDK is for building custom services where you control the full pipeline.

## Where It Sits

```
┌─────────────────────────┐
│  Your Application       │  ← You write this
├─────────────────────────┤
│  @toon-protocol/sdk         │  ← Identity, verification, pricing, handlers
├─────────────────────────┤
│  @toon-protocol/core        │  ← Bootstrap, discovery, peering
├─────────────────────────┤
│  ILP Connector          │  ← Payment routing
└─────────────────────────┘
```

The SDK is the framework layer. You bring handlers; it handles the protocol.

## API Overview

| Export | Purpose |
|--------|---------|
| `createNode(config)` | Compose a full service node |
| `fromMnemonic(phrase)` | Derive identity from BIP-39 mnemonic |
| `fromSecretKey(key)` | Derive identity from raw secret key |
| `generateMnemonic()` | Generate a new 12-word mnemonic |
| `HandlerRegistry` | Kind-based handler routing |
| `createHandlerContext()` | Build handler context objects |
| `createVerificationPipeline()` | Schnorr signature verifier |
| `createPricingValidator()` | Payment amount validator |

## Key Concepts

| Concept | Description |
|---------|-------------|
| **Unified identity** | One secp256k1 key produces both a [Nostr](https://github.com/nostr-protocol/nips) pubkey and an EVM address |
| **Handler pattern** | `ctx.accept()` / `ctx.reject()` — handlers respond, not return |
| **Self-write bypass** | Events from your own pubkey skip pricing |
| **Dev mode** | Skip verification and pricing for testing |
| **[TOON](https://github.com/toon-format/toon) encoding** | Events encoded in compact text format, not JSON |
| **Address assignment** | ILP addresses are derived from peering topology — your upstream peer assigns your address automatically based on your pubkey. A node with multiple upstream peers has multiple addresses. See [Protocol — ILP Address Hierarchy](../../docs/protocol.md#ilp-address-hierarchy) |
| **Invisible fee calculation** | The SDK computes multi-hop fees internally. Each intermediary advertises a fee-per-byte; the SDK sums them along the route so `publishEvent()` callers pay one total amount |

## Full Documentation

See the [SDK Guide](../../docs/sdk-guide.md) for the complete API reference, handler patterns, verification pipeline details, publishing events, and error handling.

## Requirements

- Node.js >= 20
- `@toon-protocol/connector` >= 1.6.0 (peer dependency, optional)

## License

MIT
