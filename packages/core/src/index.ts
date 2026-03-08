/**
 * @crosstown/core
 *
 * Core library for Nostr-based ILP peer discovery.
 */

export const VERSION = '0.1.0';

// Event kind constants
export { ILP_PEER_INFO_KIND } from './constants.js';

// TypeScript interfaces
export type {
  IlpPeerInfo,
  Subscription,
  OpenChannelParams,
  OpenChannelResult,
  ChannelState,
  ConnectorChannelClient,
} from './types.js';

// Error classes
export {
  CrosstownError,
  InvalidEventError,
  PeerDiscoveryError,
} from './errors.js';

// Event parsers and builders
export {
  parseIlpPeerInfo,
  validateChainId,
  buildIlpPeerInfoEvent,
} from './events/index.js';

// Peer discovery
export {
  NostrPeerDiscovery,
  GenesisPeerLoader,
  type GenesisPeer,
  ArDrivePeerRegistry,
  SocialPeerDiscovery,
  type SocialPeerDiscoveryConfig,
  type SocialDiscoveryEvent,
  type SocialDiscoveryEventListener,
} from './discovery/index.js';

// Settlement utilities
export {
  negotiateSettlementChain,
  resolveTokenForChain,
} from './settlement/index.js';

// Bootstrap service
export {
  BootstrapService,
  BootstrapError,
  createDiscoveryTracker,
  type DiscoveryTracker,
  type DiscoveryTrackerConfig,
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
  type ConnectorNodeLike,
  type SendPacketParams,
  type SendPacketResult,
  type DirectRuntimeClientConfig,
  type ConnectorAdminLike,
  type RegisterPeerParams,
  createDirectChannelClient,
  type ConnectorChannelLike,
  type DiscoveredPeer,
  type SettlementConfig,
  createHttpConnectorAdmin,
  createHttpRuntimeClientV2,
  createHttpChannelClient,
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

// TOON codec
export {
  encodeEventToToon,
  encodeEventToToonString,
  ToonEncodeError,
  decodeEventFromToon,
  ToonError,
  shallowParseToon,
  type ToonRoutingMeta,
} from './toon/index.js';

// NIP-34: Git stuff
// NOTE: Import from '@crosstown/core/nip34' to use Git integration
// This avoids loading simple-git dependency when not needed
