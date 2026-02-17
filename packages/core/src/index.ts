/**
 * @crosstown/core
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
  OpenChannelParams,
  OpenChannelResult,
  ChannelState,
  ConnectorChannelClient,
  SettlementNegotiationConfig,
  SettlementNegotiationResult,
} from './types.js';

// Error classes
export {
  CrosstownError,
  InvalidEventError,
  PeerDiscoveryError,
  SpspError,
  SpspTimeoutError,
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
  negotiateAndOpenChannel,
  type NegotiateAndOpenChannelParams,
} from './spsp/index.js';

// Bootstrap service
export {
  BootstrapService,
  BootstrapError,
  RelayMonitor,
  createHttpRuntimeClient,
  createAgentRuntimeClient,
  createDirectRuntimeClient,
  createDirectConnectorAdmin,
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
  type ConnectorNodeLike,
  type SendPacketParams,
  type SendPacketResult,
  type DirectRuntimeClientConfig,
  type ConnectorAdminLike,
  type RegisterPeerParams,
  createDirectChannelClient,
  type ConnectorChannelLike,
  type DiscoveredPeer,
} from './bootstrap/index.js';

// Compose - embedded connector orchestration
export {
  createCrosstownNode,
  type CrosstownNodeConfig,
  type CrosstownNode,
  type CrosstownNodeStartResult,
  type EmbeddableConnectorLike,
  type PacketHandler,
  type HandlePacketRequest,
  type HandlePacketAcceptResponse,
  type HandlePacketRejectResponse,
  type HandlePacketResponse,
} from './compose.js';
