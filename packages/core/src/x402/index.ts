/**
 * x402 protocol support for Crosstown.
 *
 * Provides the shared `buildIlpPrepare()` function used by both the x402
 * HTTP on-ramp and the ILP-native rail to construct identical ILP PREPARE
 * packets.
 */

export {
  buildIlpPrepare,
  type BuildIlpPrepareParams,
  type IlpPreparePacket,
} from './build-ilp-prepare.js';
