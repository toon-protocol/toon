/**
 * Bootstrap module - peer discovery, registration, and ILP-first handshake.
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
  AgentRuntimeClient,
  IlpSendResult,
  RelayMonitorConfig,
  DiscoveredPeer,
} from './types.js';

// Service and errors
export { BootstrapService, BootstrapError } from './BootstrapService.js';

// Relay monitor
export { RelayMonitor } from './RelayMonitor.js';

// Agent-runtime client factories
export { createHttpRuntimeClient, createAgentRuntimeClient } from './agent-runtime-client.js';
export { createDirectRuntimeClient } from './direct-runtime-client.js';
export type {
  ConnectorNodeLike,
  SendPacketParams,
  SendPacketResult,
  DirectRuntimeClientConfig,
} from './direct-runtime-client.js';

// Connector admin client factories
export { createDirectConnectorAdmin } from './direct-connector-admin.js';
export type {
  ConnectorAdminLike,
  RegisterPeerParams,
} from './direct-connector-admin.js';

// Connector channel client factories
export { createDirectChannelClient } from './direct-channel-client.js';
export type {
  ConnectorChannelLike,
} from './direct-channel-client.js';
