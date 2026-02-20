/**
 * NIP-34: Git Stuff
 * https://github.com/nostr-protocol/nips/blob/master/34.md
 *
 * Event kinds for decentralized code collaboration via Nostr.
 */

/**
 * Repository Announcement (kind 30617)
 * Replaceable event announcing a Git repository's existence.
 * Contains clone URLs, maintainers, and metadata.
 */
export const REPOSITORY_ANNOUNCEMENT_KIND = 30617;

/**
 * Patch (kind 1617)
 * Direct patch submission for files under 60KB.
 * Contains git format-patch output and commit metadata.
 */
export const PATCH_KIND = 1617;

/**
 * Pull Request (kind 1618)
 * Larger submissions or branch-based changes.
 * References remote repository and commit range.
 */
export const PULL_REQUEST_KIND = 1618;

/**
 * Pull Request Status Update (kind 1619)
 * Updates to existing pull requests.
 */
export const PR_STATUS_UPDATE_KIND = 1619;

/**
 * Issue (kind 1621)
 * Bug reports and feature requests in Markdown format.
 */
export const ISSUE_KIND = 1621;

/**
 * Status: Open (kind 1630)
 */
export const STATUS_OPEN_KIND = 1630;

/**
 * Status: Applied/Merged (kind 1631)
 */
export const STATUS_APPLIED_KIND = 1631;

/**
 * Status: Closed (kind 1632)
 */
export const STATUS_CLOSED_KIND = 1632;

/**
 * Status: Draft (kind 1633)
 */
export const STATUS_DRAFT_KIND = 1633;

/**
 * All NIP-34 event kinds
 */
export const NIP34_EVENT_KINDS = [
  REPOSITORY_ANNOUNCEMENT_KIND,
  PATCH_KIND,
  PULL_REQUEST_KIND,
  PR_STATUS_UPDATE_KIND,
  ISSUE_KIND,
  STATUS_OPEN_KIND,
  STATUS_APPLIED_KIND,
  STATUS_CLOSED_KIND,
  STATUS_DRAFT_KIND,
] as const;

/**
 * Check if an event kind is a NIP-34 event
 */
export function isNIP34Event(kind: number): boolean {
  return NIP34_EVENT_KINDS.includes(kind as any);
}
