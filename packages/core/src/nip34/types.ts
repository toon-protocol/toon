import type { Event as NostrEvent } from 'nostr-tools/pure';

/**
 * Helper to get tag value by name
 */
export function getTag(event: NostrEvent, tagName: string): string | undefined {
  return event.tags.find((t) => t[0] === tagName)?.[1];
}

/**
 * Helper to get all tag values by name
 */
export function getTags(event: NostrEvent, tagName: string): string[] {
  return event.tags.filter((t) => t[0] === tagName).map((t) => t[1]).filter((v): v is string => v !== undefined);
}

/**
 * Repository Announcement Event (Kind 30617)
 */
export interface RepositoryAnnouncement extends NostrEvent {
  kind: 30617;
  tags: Array<
    | ['d', string] // repository identifier
    | ['name', string] // human-readable name
    | ['description', string] // repository description
    | ['web', string] // browsing URL
    | ['clone', string] // clone URL
    | ['relays', ...string[]] // preferred relays
    | ['r', string, 'euc'] // earliest unique commit
    | ['maintainers', ...string[]] // maintainer pubkeys
  >;
}

/**
 * Patch Event (Kind 1617)
 */
export interface PatchEvent extends NostrEvent {
  kind: 1617;
  content: string; // git format-patch output
  tags: Array<
    | ['a', string] // repository reference (30617:pubkey:repo-id)
    | ['r', string] // earliest unique commit
    | ['p', string] // repository owner pubkey
    | ['commit', string] // current commit SHA
    | ['parent-commit', string] // parent commit SHA
    | ['commit-pgp-sig', string] // optional PGP signature
    | ['committer', string] // optional committer info
    | ['t', 'root' | 'reply'] // thread type
  >;
}

/**
 * Pull Request Event (Kind 1618)
 */
export interface PullRequestEvent extends NostrEvent {
  kind: 1618;
  tags: Array<
    | ['a', string] // repository reference (30617:pubkey:repo-id)
    | ['r', string] // earliest unique commit
    | ['p', string] // repository owner pubkey
    | ['clone', string] // contributor's clone URL
    | ['c', string] // commit tip SHA
    | ['merge-base', string] // merge base commit
    | ['subject', string] // PR title
    | ['t', 'root' | 'reply'] // thread type
  >;
}

/**
 * Issue Event (Kind 1621)
 */
export interface IssueEvent extends NostrEvent {
  kind: 1621;
  content: string; // Markdown issue body
  tags: Array<
    | ['a', string] // repository reference (30617:pubkey:repo-id)
    | ['p', string] // repository owner pubkey
    | ['subject', string] // issue title
    | ['t', string] // labels
  >;
}

/**
 * Status Event (Kinds 1630-1633)
 */
export interface StatusEvent extends NostrEvent {
  kind: 1630 | 1631 | 1632 | 1633; // open, applied, closed, draft
  tags: Array<
    | ['e', string] // event being updated (patch, PR, issue)
    | ['p', string] // pubkey
  >;
}

/**
 * Union type of all NIP-34 events
 */
export type NIP34Event =
  | RepositoryAnnouncement
  | PatchEvent
  | PullRequestEvent
  | IssueEvent
  | StatusEvent;

/**
 * Parse repository reference from 'a' tag
 * Format: "30617:pubkey:repo-id"
 */
export interface RepositoryReference {
  kind: 30617;
  pubkey: string;
  repoId: string;
}

export function parseRepositoryReference(aTag: string): RepositoryReference {
  const parts = aTag.split(':');
  if (parts.length !== 3 || parts[0] !== '30617' || !parts[1] || !parts[2]) {
    throw new Error(`Invalid repository reference format: ${aTag}`);
  }
  return {
    kind: 30617,
    pubkey: parts[1],
    repoId: parts[2],
  };
}

/**
 * Extract commit message from git format-patch content
 */
export function extractCommitMessage(patchContent: string): string {
  const lines = patchContent.split('\n');
  const subjectLine = lines.find((line) => line.startsWith('Subject:'));
  if (!subjectLine) {
    return 'Applied patch from Nostr';
  }
  // Remove "Subject: [PATCH]" prefix
  return subjectLine
    .replace(/^Subject:\s*\[PATCH\]\s*/, '')
    .replace(/^Subject:\s*/, '');
}
