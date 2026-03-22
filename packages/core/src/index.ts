/**
 * @toon-protocol/core
 *
 * Core library for Nostr-based ILP peer discovery.
 */

export const VERSION = '0.1.0';

// Event kind constants
export {
  ILP_PEER_INFO_KIND,
  SERVICE_DISCOVERY_KIND,
  SEED_RELAY_LIST_KIND,
  TEE_ATTESTATION_KIND,
  JOB_REQUEST_KIND_BASE,
  JOB_RESULT_KIND_BASE,
  JOB_FEEDBACK_KIND,
  TEXT_GENERATION_KIND,
  IMAGE_GENERATION_KIND,
  TEXT_TO_SPEECH_KIND,
  TRANSLATION_KIND,
  ILP_ROOT_PREFIX,
} from './constants.js';

// ILP address derivation and BTP prefix exchange
export { deriveChildAddress } from './address/index.js';
export {
  isValidIlpAddressStructure,
  validateIlpAddress,
  extractPrefixFromHandshake,
  buildPrefixHandshakeData,
  validatePrefixConsistency,
  checkAddressCollision,
  assignAddressFromHandshake,
  isGenesisNode,
  AddressRegistry,
} from './address/index.js';
export type { BtpHandshakeExtension } from './address/index.js';

// TypeScript interfaces
export type {
  IlpPeerInfo,
  TeeAttestation,
  Subscription,
  OpenChannelParams,
  OpenChannelResult,
  ChannelState,
  ConnectorChannelClient,
} from './types.js';

// Error classes
export { ToonError, InvalidEventError, PeerDiscoveryError } from './errors.js';

// Event parsers and builders
export {
  parseIlpPeerInfo,
  validateChainId,
  buildIlpPeerInfoEvent,
  buildSeedRelayListEvent,
  parseSeedRelayList,
  type SeedRelayEntry,
  buildServiceDiscoveryEvent,
  parseServiceDiscovery,
  type ServiceDiscoveryContent,
  type SkillDescriptor,
  buildAttestationEvent,
  parseAttestation,
  type AttestationEventOptions,
  type ParsedAttestation,
  buildJobRequestEvent,
  buildJobResultEvent,
  buildJobFeedbackEvent,
  parseJobRequest,
  parseJobResult,
  parseJobFeedback,
  type DvmJobStatus,
  type JobRequestParams,
  type JobResultParams,
  type JobFeedbackParams,
  type ParsedJobRequest,
  type ParsedJobResult,
  type ParsedJobFeedback,
  buildWorkflowDefinitionEvent,
  parseWorkflowDefinition,
  WORKFLOW_CHAIN_KIND,
  type WorkflowStep,
  type WorkflowDefinitionParams,
  type ParsedWorkflowDefinition,
  buildSwarmRequestEvent,
  buildSwarmSelectionEvent,
  parseSwarmRequest,
  parseSwarmSelection,
  type SwarmRequestParams,
  type SwarmSelectionParams,
  type ParsedSwarmRequest,
  type ParsedSwarmSelection,
  AttestedResultVerifier,
  hasRequireAttestation,
  type AttestedResultVerificationOptions,
  type AttestedResultVerificationResult,
  buildJobReviewEvent,
  parseJobReview,
  buildWotDeclarationEvent,
  parseWotDeclaration,
  ReputationScoreCalculator,
  hasMinReputation,
  JOB_REVIEW_KIND,
  WEB_OF_TRUST_KIND,
  type JobReviewParams,
  type ParsedJobReview,
  type WotDeclarationParams,
  type ParsedWotDeclaration,
  type ReputationSignals,
  type ReputationScore,
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
  SeedRelayDiscovery,
  publishSeedRelayEntry,
  type SeedRelayDiscoveryConfig,
  type SeedRelayDiscoveryResult,
  type PublishSeedRelayConfig,
} from './discovery/index.js';

// Fee calculation utilities
export {
  calculateRouteAmount,
  type CalculateRouteAmountParams,
  resolveRouteFees,
  type ResolveRouteFeesParams,
  type ResolveRouteFeesResult,
} from './fee/index.js';

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
  createHttpIlpClient,
  createHttpRuntimeClient,
  createAgentRuntimeClient,
  createDirectIlpClient,
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
  type IlpClient,
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
  AttestationVerifier,
  AttestationState,
  type VerificationResult,
  type PeerDescriptor,
  type AttestationVerifierConfig,
  AttestationBootstrap,
  type AttestationBootstrapConfig,
  type AttestationBootstrapResult,
  type AttestationBootstrapEvent,
  type AttestationBootstrapEventListener,
} from './bootstrap/index.js';

// Compose - embedded connector orchestration
export {
  createToonNode,
  type ToonNodeConfig,
  type ToonNode,
  type ToonNodeStartResult,
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
  ToonDecodeError,
  shallowParseToon,
  type ToonRoutingMeta,
} from './toon/index.js';

// Chain configuration
export {
  MOCK_USDC_ADDRESS,
  USDC_DECIMALS,
  USDC_SYMBOL,
  USDC_NAME,
  MOCK_USDC_CONFIG,
  type MockUsdcConfig,
} from './chain/usdc.js';

// Chain presets and multi-environment configuration
export {
  resolveChainConfig,
  buildEip712Domain,
  CHAIN_PRESETS,
  type ChainPreset,
  type ChainName,
} from './chain/chain-config.js';

// x402 protocol support (shared ILP PREPARE construction)
export {
  buildIlpPrepare,
  type BuildIlpPrepareParams,
  type IlpPreparePacket,
} from './x402/index.js';

// KMS Identity (TEE enclave-bound key derivation)
export {
  deriveFromKmsSeed,
  KmsIdentityError,
  type KmsKeypair,
  type DeriveFromKmsSeedOptions,
} from './identity/index.js';

// Nix reproducible builds (TEE deployment)
export {
  NixBuilder,
  type NixBuildResult,
  type NixBuilderConfig,
  verifyPcrReproducibility,
  readDockerfileNix,
  analyzeDockerfileForNonDeterminism,
  PcrReproducibilityError,
  type PcrReproducibilityResult,
  type VerifyOptions,
  type DeterminismReport,
  type Violation,
  type ForbiddenPattern,
} from './build/index.js';

// Structured logging
export {
  createLogger,
  type Logger,
  type LoggerConfig,
  type LogLevel,
  type LogEntry,
} from './logger.js';

// NIP-34: Git stuff
// NOTE: Import from '@toon-protocol/core/nip34' to use Git integration
// This avoids loading simple-git dependency when not needed
