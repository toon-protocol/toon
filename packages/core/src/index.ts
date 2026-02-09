/**
 * @agent-society/core
 *
 * Core library for Nostr-based ILP peer discovery and SPSP.
 */

export const VERSION = '0.1.0';

// Event kind constants
export {
  ILP_PEER_INFO_KIND,
  SPSP_REQUEST_KIND,
  SPSP_RESPONSE_KIND,
} from './constants.js';

// TypeScript interfaces
export type {
  IlpPeerInfo,
  SpspInfo,
  SpspRequest,
  SpspResponse,
  Subscription,
  TrustConfig,
  TrustBreakdown,
  TrustScore,
  CreditLimitConfig,
  OpenChannelParams,
  OpenChannelResult,
  ChannelState,
  ConnectorChannelClient,
  SettlementNegotiationConfig,
  SettlementNegotiationResult,
} from './types.js';

// Error classes
export {
  AgentSocietyError,
  InvalidEventError,
  PeerDiscoveryError,
  SpspError,
  SpspTimeoutError,
  TrustCalculationError,
} from './errors.js';

// Event parsers and builders
export {
  parseIlpPeerInfo,
  parseSpspRequest,
  parseSpspResponse,
  validateChainId,
  buildIlpPeerInfoEvent,
  buildSpspRequestEvent,
  buildSpspResponseEvent,
  type SpspRequestEventResult,
  type SpspRequestSettlementInfo,
} from './events/index.js';

// Peer discovery
export {
  NostrPeerDiscovery,
  GenesisPeerLoader,
  type GenesisPeer,
  ArDrivePeerRegistry,
  SocialPeerDiscovery,
  type SocialPeerDiscoveryConfig,
} from './discovery/index.js';

// SPSP client and server
export {
  NostrSpspClient,
  NostrSpspServer,
  IlpSpspClient,
  type IlpSpspClientConfig,
  type IlpSpspRequestOptions,
  negotiateSettlementChain,
  resolveTokenForChain,
} from './spsp/index.js';

// Trust calculation
export {
  SocialTrustManager,
  DEFAULT_TRUST_CONFIG,
  calculateCreditLimit,
  DEFAULT_CREDIT_LIMIT_CONFIG,
} from './trust/index.js';

// Bootstrap service
export {
  BootstrapService,
  BootstrapError,
  RelayMonitor,
  createAgentRuntimeClient,
  type KnownPeer,
  type BootstrapConfig,
  type BootstrapServiceConfig,
  type BootstrapResult,
  type ConnectorAdminClient,
  type BootstrapPhase,
  type BootstrapEvent,
  type BootstrapEventListener,
  type AgentRuntimeClient,
  type IlpSendResult,
  type RelayMonitorConfig,
} from './bootstrap/index.js';
