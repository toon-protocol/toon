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
} from './types.js';

// Service and errors
export { BootstrapService, BootstrapError } from './BootstrapService.js';

// Relay monitor
export { RelayMonitor } from './RelayMonitor.js';

// Agent-runtime client factory
export { createAgentRuntimeClient } from './agent-runtime-client.js';
