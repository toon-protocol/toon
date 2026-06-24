/**
 * NIP-on-TOON UI renderer resolution primitives.
 *
 * Pure parse/select helpers for resolving an event's `ui` tag to an
 * addressable `kind:31036` renderer event. Resolution (relay query + cache)
 * stays client-local; core only provides the parse + select-latest primitives.
 */

export {
  UI_RENDERER_KIND,
  UI_TAG,
  parseUiCoordinate,
  buildUiCoordinate,
  getUiCoordinate,
  selectLatestAddressable,
  type UiCoordinate,
} from './coordinate.js';
