/**
 * @toon-protocol/sdk
 *
 * SDK for building ILP-gated Nostr services on the TOON protocol.
 */

// Identity module
export {
  generateMnemonic,
  fromMnemonic,
  fromMnemonicFull,
  fromSecretKey,
  generateSolanaKeypair,
  base58Encode,
  base58Decode,
} from './identity.js';

export type {
  NodeIdentity,
  ToonIdentity,
  SolanaIdentity,
  MinaIdentity,
  FromMnemonicOptions,
} from './identity.js';

// Error classes
export {
  IdentityError,
  NodeError,
  HandlerError,
  VerificationError,
  PricingError,
  GiftWrapError,
  SwapHandlerError,
  SettlementTxError,
} from './errors.js';

// Handler context
export { createHandlerContext } from './handler-context.js';
export type {
  HandlerContext,
  HandlePacketAcceptResponse,
  HandlePacketRejectResponse,
  CreateHandlerContextOptions,
} from './handler-context.js';

// Handler registry
export { HandlerRegistry } from './handler-registry.js';
export type { Handler, HandlerResponse } from './handler-registry.js';

// Pricing validator
export { createPricingValidator } from './pricing-validator.js';
export type {
  PricingValidatorConfig,
  PricingValidationResult,
} from './pricing-validator.js';

// Verification pipeline
export { createVerificationPipeline } from './verification-pipeline.js';
export type {
  VerificationResult,
  VerificationPipelineConfig,
} from './verification-pipeline.js';

// Payment handler bridge
export { createPaymentHandlerBridge } from './payment-handler-bridge.js';
export type {
  PaymentHandlerBridgeConfig,
  PaymentRequest,
  PaymentResponse,
} from './payment-handler-bridge.js';

// Event storage handler (stub)
export { createEventStorageHandler } from './event-storage-handler.js';

// Node composition
export { createNode } from './create-node.js';
export type {
  NodeConfig,
  ServiceNode,
  StartResult,
  PublishEventResult,
} from './create-node.js';

// Skill descriptor builder (Story 5.4)
export { buildSkillDescriptor } from './skill-descriptor.js';
export type { BuildSkillDescriptorConfig } from './skill-descriptor.js';

// Workflow orchestrator (Story 6.1)
export { WorkflowOrchestrator } from './workflow-orchestrator.js';
export type {
  WorkflowState,
  WorkflowEventStore,
  WorkflowOrchestratorOptions,
} from './workflow-orchestrator.js';

// Swarm coordinator (Story 6.2)
export { SwarmCoordinator } from './swarm-coordinator.js';
export type {
  SwarmState,
  SwarmCoordinatorOptions,
} from './swarm-coordinator.js';

// Prefix claim handler (Story 7.6)
export { createPrefixClaimHandler } from './prefix-claim-handler.js';
export type { PrefixClaimHandlerOptions } from './prefix-claim-handler.js';

// Arweave DVM (Story 8.0)
export {
  createArweaveDvmHandler,
  TurboUploadAdapter,
  ChunkManager,
  uploadBlob,
  uploadBlobChunked,
} from './arweave/index.js';
export type {
  ArweaveDvmConfig,
  ArweaveUploadAdapter,
  ChunkManagerConfig,
  AddChunkResult,
  PublishableNode,
  UploadBlobOptions,
  UploadBlobChunkedOptions,
} from './arweave/index.js';

// Gift wrap (Story 12.2)
export {
  wrapSwapPacket,
  unwrapSwapPacket,
  wrapSwapPacketToToon,
  unwrapSwapPacketFromToon,
  encryptFulfillClaim,
  decryptFulfillClaim,
} from './gift-wrap.js';

export type {
  WrapSwapPacketParams,
  WrapSwapPacketResult,
  UnwrapSwapPacketParams,
  UnwrapSwapPacketResult,
  WrapSwapPacketToToonParams,
  WrapSwapPacketToToonResult,
  UnwrapSwapPacketFromToonParams,
  EncryptFulfillClaimParams,
  EncryptFulfillClaimResult,
  DecryptFulfillClaimParams,
} from './gift-wrap.js';

// Rate conversion (toon#210, toon#211): `applyRate` / `ApplyRateParams` were
// relocated out of the legacy handler so the rolling path
// (adaptive-controller.ts, and @toon-protocol/swap's rolling-engine.ts) keeps
// depending on them after toon#211 withdrew that handler. The exported names
// are unchanged.
export { applyRate } from './apply-rate.js';
export type { ApplyRateParams } from './apply-rate.js';

// Claim issuance (toon#210): `IssueClaimParams` / `IssueClaimResult` are the
// leg-B claim-issuance shapes that @toon-protocol/swap's rolling
// `IssueRollingClaimParams` / `RollingIssueClaimResult` extend, so they too
// live outside the legacy handler. The exported names are unchanged.
export type { IssueClaimParams, IssueClaimResult } from './claim-issuance.js';

// Adaptive δ/W controller (issue #83, rolling-swap spec §6)
export {
  AdaptiveDeltaController,
  InMemorySwapControllerStateStore,
  JsonFileSwapControllerStateStore,
  SwapControllerError,
  isSwapControllerState,
  swapControllerStateKey,
} from './adaptive-controller.js';

export type {
  AdaptiveDeltaControllerConfig,
  PacketObservation,
  PacketResolution,
  StreamSwapAdaptiveController,
  SwapControllerState,
  SwapControllerStateStore,
} from './adaptive-controller.js';

// rfc-0039 stream receipts (issue #84, rolling-swap spec §7.2)
export {
  signStreamReceipt,
  verifyStreamReceipt,
  parseStreamReceipt,
  encodeReceiptSigningPayload,
  serializeReceiptChain,
  isValidStreamNonce,
  issueSessionReceipt,
  ReceiptChainTracker,
  BoundedReceiptSessions,
  STREAM_RECEIPT_VERSION,
  STREAM_RECEIPT_SIGNING_TAG,
  DEFAULT_RECEIPT_SESSIONS_CAP,
} from './stream-receipts.js';

export type {
  StreamReceipt,
  StreamReceiptFields,
  StreamReceiptChain,
  ReceiptAddResult,
  ReceiptSessionState,
  ReceiptSessionStoreLike,
} from './stream-receipts.js';

// toon#210: `AccumulatedClaim` is a settlement type shared by the rolling
// path; it moved out of the legacy `stream-swap.ts` sender (withdrawn by
// toon#211) but is exported under the same name.
export type { AccumulatedClaim } from './settlement/accumulated-claim.js';

// Settlement (Story 12.6)
export {
  buildSettlementTx,
  verifyAccumulatedClaim,
  verifyEd25519Signature,
  verifyMinaSignature,
  loadMinaSignerClient,
  fillEvmSettlementTxGas,
  balanceProofHashEvm,
  coopCloseHashEvm,
  eip712DomainSeparatorEvm,
  // toon#214: `balanceProofMessageSolana` is the Solana balance proof the
  // deployed program verifies; `patchSolanaRecentBlockhash` is what a submitter
  // needs to make a Solana bundle broadcastable. `balanceProofHashSolana` is the
  // legacy digest no program checks, kept for recognition only.
  balanceProofMessageSolana,
  patchSolanaRecentBlockhash,
  balanceProofHashSolana,
  balanceProofFieldsMina,
  minaHashToField,
  bigintToBytes32BE,
  concatBytes,
  hexToBytes,
} from './settlement/index.js';

export type {
  SettlementBundle,
  BuildSettlementTxParams,
  BuildSettlementTxResult,
  SwapSignerConfig,
  MinaSignerClientLike,
} from './settlement/index.js';

// Store health response type (canonical shape for the Store /health endpoint)
export type {
  StoreHealthResponse,
  StoreJobsRecent,
  StoreJobsByKindEntry,
  StoreJobsByStatus,
} from './store-health.js';

// Re-export types from core for convenience
export type { SkillDescriptor } from '@toon-protocol/core';

// Re-export transport config from connector for convenience
export type { TransportConfig } from '@toon-protocol/connector';

// Re-export bootstrap types for lifecycle event listeners
export type {
  BootstrapEvent,
  BootstrapEventListener,
} from '@toon-protocol/core';
