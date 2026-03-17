/**
 * @crosstown/sdk
 *
 * SDK for building ILP-gated Nostr services on the Crosstown protocol.
 */

// Identity module
export { generateMnemonic, fromMnemonic, fromSecretKey } from './identity.js';

export type { NodeIdentity, FromMnemonicOptions } from './identity.js';

// Error classes
export {
  IdentityError,
  NodeError,
  HandlerError,
  VerificationError,
  PricingError,
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

// Re-export types from core for convenience
export type { SkillDescriptor } from '@crosstown/core';

// Re-export bootstrap types for lifecycle event listeners
export type { BootstrapEvent, BootstrapEventListener } from '@crosstown/core';
