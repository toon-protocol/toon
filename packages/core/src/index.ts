/**
 * @agent-society/core
 *
 * Core library for Nostr-based ILP peer discovery and SPSP.
 */

export const VERSION = '0.1.0';

// Event kind constants
export {
  ILP_PEER_INFO_KIND,
  SPSP_INFO_KIND,
  SPSP_REQUEST_KIND,
  SPSP_RESPONSE_KIND,
} from './constants.js';

// TypeScript interfaces
export type { IlpPeerInfo, SpspInfo, SpspRequest, SpspResponse, Subscription } from './types.js';

// Error classes
export { AgentSocietyError, InvalidEventError, PeerDiscoveryError } from './errors.js';

// Event parsers and builders
export {
  parseIlpPeerInfo,
  parseSpspInfo,
  buildIlpPeerInfoEvent,
  buildSpspInfoEvent,
} from './events/index.js';

// Peer discovery
export { NostrPeerDiscovery } from './discovery/index.js';
