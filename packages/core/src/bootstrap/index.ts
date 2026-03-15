/**
 * Bootstrap module - peer discovery, registration, and settlement negotiation.
 */

// Types
export type {
  KnownPeer,
  BootstrapResult,
  ConnectorAdminClient,
  BootstrapConfig,
  BootstrapServiceConfig,
  BootstrapPhase,
  BootstrapEvent,
  BootstrapEventListener,
  IlpClient,
  AgentRuntimeClient,
  IlpSendResult,
  DiscoveredPeer,
  SettlementConfig,
} from './types.js';

// Service and errors
export { BootstrapService, BootstrapError } from './BootstrapService.js';

// Discovery tracker
export {
  createDiscoveryTracker,
  type DiscoveryTracker,
  type DiscoveryTrackerConfig,
} from './discovery-tracker.js';

// ILP client factories
export {
  createHttpIlpClient,
  createHttpRuntimeClient,
  createAgentRuntimeClient,
} from './ilp-client.js';
export {
  createDirectIlpClient,
  createDirectRuntimeClient,
} from './direct-ilp-client.js';
export type {
  ConnectorNodeLike,
  SendPacketParams,
  SendPacketResult,
  DirectRuntimeClientConfig,
} from './direct-ilp-client.js';

// Connector admin client factories
export { createDirectConnectorAdmin } from './direct-connector-admin.js';
export type {
  ConnectorAdminLike,
  RegisterPeerParams,
} from './direct-connector-admin.js';

// Connector channel client factories
export { createDirectChannelClient } from './direct-channel-client.js';
export type { ConnectorChannelLike } from './direct-channel-client.js';

// HTTP-based connector clients (for deployed connectors)
export { createHttpConnectorAdmin } from './http-connector-admin.js';
export { createHttpIlpClient as createHttpRuntimeClientV2 } from './http-ilp-client.js';
export { createHttpChannelClient } from './http-channel-client.js';

// Direct BLS client (for bootstrap only - bypasses connector routing)
export {
  createDirectBlsClient,
  type DirectBlsClientConfig,
} from './direct-bls-client.js';

// Attestation verifier (Story 4.3)
export {
  AttestationVerifier,
  AttestationState,
  type VerificationResult,
  type PeerDescriptor,
  type AttestationVerifierConfig,
} from './AttestationVerifier.js';
