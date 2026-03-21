/**
 * ILP address derivation and BTP prefix exchange utilities.
 *
 * @module
 */

export {
  isValidIlpAddressStructure,
  validateIlpAddress,
} from './ilp-address-validation.js';
export { deriveChildAddress } from './derive-child-address.js';

export {
  extractPrefixFromHandshake,
  buildPrefixHandshakeData,
  validatePrefixConsistency,
  checkAddressCollision,
} from './btp-prefix-exchange.js';
export type { BtpHandshakeExtension } from './btp-prefix-exchange.js';

export {
  assignAddressFromHandshake,
  isGenesisNode,
} from './address-assignment.js';
