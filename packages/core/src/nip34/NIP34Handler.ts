/**
 * NIP-34 Handler
 *
 * Processes NIP-34 events (Git stuff on Nostr) and executes corresponding
 * Git operations on a Forgejo instance.
 *
 * Flow:
 * 1. Crosstown receives NIP-34 event via ILP payment
 * 2. BLS validates payment and stores event
 * 3. BLS calls NIP34Handler.handleEvent()
 * 4. Handler maps event to Git operation
 * 5. Operation executes on Forgejo
 */

import type { Event as NostrEvent } from 'nostr-tools/pure';
import { ForgejoClient, type CreateRepositoryOptions } from './ForgejoClient.js';
import {
  isNIP34Event,
  REPOSITORY_ANNOUNCEMENT_KIND,
  PATCH_KIND,
  PULL_REQUEST_KIND,
  ISSUE_KIND,
} from './constants.js';
import {
  getTag,
  parseRepositoryReference,
  extractCommitMessage,
  type NIP34Event,
} from './types.js';

export interface NIP34Config {
  /** Forgejo base URL (e.g., "http://forgejo:3000") */
  forgejoUrl: string;
  /** Forgejo API token */
  forgejoToken: string;
  /** Default owner/org for repositories */
  defaultOwner: string;
  /** Enable verbose logging */
  verbose?: boolean;
}

export interface HandleEventResult {
  success: boolean;
  operation: 'repository' | 'patch' | 'pull_request' | 'issue' | 'status' | 'unsupported';
  message: string;
  metadata?: Record<string, unknown>;
}

/**
 * NIP-34 Event Handler
 *
 * Maps Nostr events to Git operations on Forgejo.
 */
export class NIP34Handler {
  private forgejo: ForgejoClient;
  private verbose: boolean;
  private defaultOwner: string;

  constructor(config: NIP34Config) {
    this.forgejo = new ForgejoClient({
      baseUrl: config.forgejoUrl,
      token: config.forgejoToken,
      defaultOwner: config.defaultOwner,
    });

    this.defaultOwner = config.defaultOwner;
    this.verbose = config.verbose ?? false;
  }

  /**
   * Handle a NIP-34 event
   *
   * This is the main entry point called by the BLS after storing an event.
   */
  async handleEvent(event: NostrEvent): Promise<HandleEventResult> {
    // Check if this is a NIP-34 event
    if (!isNIP34Event(event.kind)) {
      return {
        success: false,
        operation: 'unsupported',
        message: `Not a NIP-34 event (kind ${event.kind})`,
      };
    }

    this.log(`Handling NIP-34 event: kind=${event.kind} id=${event.id.substring(0, 8)}`);

    try {
      switch (event.kind) {
        case REPOSITORY_ANNOUNCEMENT_KIND:
          return await this.handleRepositoryAnnouncement(event as NIP34Event);

        case PATCH_KIND:
          return await this.handlePatch(event as NIP34Event);

        case PULL_REQUEST_KIND:
          return await this.handlePullRequest(event as NIP34Event);

        case ISSUE_KIND:
          return await this.handleIssue(event as NIP34Event);

        default:
          // Status events (1630-1633) - not yet implemented
          return {
            success: true,
            operation: 'status',
            message: `Status event kind ${event.kind} received (not yet implemented)`,
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log(`Error handling event: ${message}`);
      return {
        success: false,
        operation: this.getOperationType(event.kind),
        message: `Failed to process event: ${message}`,
      };
    }
  }

  /**
   * Handle Repository Announcement (kind 30617)
   *
   * Creates a new repository in Forgejo.
   */
  private async handleRepositoryAnnouncement(
    event: NIP34Event
  ): Promise<HandleEventResult> {
    const repoId = getTag(event, 'd');
    const name = getTag(event, 'name') || repoId;
    const description = getTag(event, 'description');

    if (!repoId) {
      return {
        success: false,
        operation: 'repository',
        message: 'Missing required "d" tag (repository identifier)',
      };
    }

    // Extract just the repository name (remove owner prefix if present)
    // e.g., "admin/repo-name" -> "repo-name"
    const repoName = repoId.includes('/') ? repoId.split('/').pop()! : repoId;

    this.log(`Creating repository: ${repoName}`);

    const options: CreateRepositoryOptions = {
      name: repoName,
      description: description || name,
      private: false,
      auto_init: true,
    };

    const repo = await this.forgejo.createRepository(options);

    this.log(`Repository created: ${repo.html_url}`);

    return {
      success: true,
      operation: 'repository',
      message: `Repository "${repoName}" created`,
      metadata: {
        repoId: repoName,
        htmlUrl: repo.html_url,
        cloneUrl: repo.clone_url,
      },
    };
  }

  /**
   * Handle Patch (kind 1617)
   *
   * Applies a patch to a repository via Forgejo API and creates a pull request.
   */
  private async handlePatch(event: NIP34Event): Promise<HandleEventResult> {
    const aTag = getTag(event, 'a');
    const patchContent = event.content;

    if (!aTag) {
      return {
        success: false,
        operation: 'patch',
        message: 'Missing required "a" tag (repository reference)',
      };
    }

    const repoRef = parseRepositoryReference(aTag);
    const owner = this.defaultOwner;
    const repoName = repoRef.repoId;

    // Check if repository exists
    const exists = await this.forgejo.repositoryExists(owner, repoName);
    if (!exists) {
      return {
        success: false,
        operation: 'patch',
        message: `Repository ${owner}/${repoName} does not exist`,
      };
    }

    this.log(`Applying patch to ${owner}/${repoName}`);

    // Parse patch to extract file changes
    const patchInfo = this.parsePatch(patchContent);
    if (!patchInfo) {
      return {
        success: false,
        operation: 'patch',
        message: 'Failed to parse patch content',
      };
    }

    const patchBranch = `patch-${event.id.substring(0, 8)}`;
    const commitMessage = extractCommitMessage(patchContent);

    try {
      // Create a new branch via API
      await this.forgejo.createBranch(owner, repoName, patchBranch, 'main');

      // Apply each file change via API
      for (const file of patchInfo.files) {
        const content = Buffer.from(file.content).toString('base64');
        await this.forgejo.createOrUpdateFile({
          owner,
          repo: repoName,
          filepath: file.path,
          content,
          message: commitMessage,
          branch: patchBranch,
        });
      }

      // Create pull request via API
      const pr = await this.forgejo.createPullRequest({
        owner,
        repo: repoName,
        title: commitMessage,
        head: patchBranch,
        base: 'main',
        body: `Patch from Nostr event: ${event.id}\n\nAuthor: ${event.pubkey}`,
      });

      this.log(`Pull request created: ${pr.html_url}`);

      return {
        success: true,
        operation: 'patch',
        message: `Patch applied and PR #${pr.number} created`,
        metadata: {
          branch: patchBranch,
          prNumber: pr.number,
          prUrl: pr.html_url,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        operation: 'patch',
        message: `Failed to apply patch: ${message}`,
      };
    }
  }

  /**
   * Handle Pull Request (kind 1618)
   *
   * Creates an issue documenting the pull request (simplified approach without git).
   */
  private async handlePullRequest(
    event: NIP34Event
  ): Promise<HandleEventResult> {
    const aTag = getTag(event, 'a');
    const cloneUrl = getTag(event, 'clone');
    const commitTip = getTag(event, 'c');
    const subject = getTag(event, 'subject');

    if (!aTag || !cloneUrl || !commitTip) {
      return {
        success: false,
        operation: 'pull_request',
        message: 'Missing required tags: a, clone, c',
      };
    }

    const repoRef = parseRepositoryReference(aTag);
    const owner = this.defaultOwner;
    const repoName = repoRef.repoId;

    this.log(`Creating PR issue for ${owner}/${repoName} from ${cloneUrl}`);

    // Create an issue documenting the pull request
    const issueBody = `
**Pull Request from Nostr**

A pull request was submitted via NIP-34 event.

**Details:**
- Source Repository: ${cloneUrl}
- Commit: ${commitTip}
- Nostr Event: ${event.id}
- Author: ${event.pubkey}

**To apply this pull request:**
1. Clone the source repository: \`git clone ${cloneUrl}\`
2. Fetch the specific commit: \`git fetch origin ${commitTip}\`
3. Create a branch: \`git checkout -b pr-${event.id.substring(0, 8)} ${commitTip}\`
4. Push to this repository and create a PR manually

${event.content}
`;

    const issue = await this.forgejo.createIssue({
      owner,
      repo: repoName,
      title: subject || `Pull Request from ${event.pubkey.substring(0, 8)}`,
      body: issueBody,
    });

    this.log(`PR issue created: ${issue.html_url}`);

    return {
      success: true,
      operation: 'pull_request',
      message: `PR documented as issue #${issue.number}`,
      metadata: {
        issueNumber: issue.number,
        issueUrl: issue.html_url,
      },
    };
  }

  /**
   * Handle Issue (kind 1621)
   *
   * Creates an issue in Forgejo.
   */
  private async handleIssue(event: NIP34Event): Promise<HandleEventResult> {
    const aTag = getTag(event, 'a');
    const subject = getTag(event, 'subject');
    const body = event.content;

    if (!aTag || !subject) {
      return {
        success: false,
        operation: 'issue',
        message: 'Missing required tags: a, subject',
      };
    }

    const repoRef = parseRepositoryReference(aTag);
    const owner = this.forgejo['defaultOwner']!;
    const repoName = repoRef.repoId;

    this.log(`Creating issue in ${owner}/${repoName}`);

    const issue = await this.forgejo.createIssue({
      owner,
      repo: repoName,
      title: subject,
      body: `${body}\n\n---\nSubmitted via Nostr event: ${event.id}\nAuthor: ${event.pubkey}`,
    });

    this.log(`Issue created: ${issue.html_url}`);

    return {
      success: true,
      operation: 'issue',
      message: `Issue #${issue.number} created`,
      metadata: {
        issueNumber: issue.number,
        issueUrl: issue.html_url,
      },
    };
  }

  /**
   * Get operation type from event kind
   */
  private getOperationType(
    kind: number
  ): 'repository' | 'patch' | 'pull_request' | 'issue' | 'status' | 'unsupported' {
    switch (kind) {
      case REPOSITORY_ANNOUNCEMENT_KIND:
        return 'repository';
      case PATCH_KIND:
        return 'patch';
      case PULL_REQUEST_KIND:
        return 'pull_request';
      case ISSUE_KIND:
        return 'issue';
      case 1630:
      case 1631:
      case 1632:
      case 1633:
        return 'status';
      default:
        return 'unsupported';
    }
  }

  /**
   * Parse git format-patch output to extract file changes
   */
  private parsePatch(patchContent: string): { files: Array<{ path: string; content: string }> } | null {
    try {
      const files: Array<{ path: string; content: string }> = [];

      // Simple parser for git format-patch
      // Look for diff --git lines to identify files
      const diffPattern = /diff --git a\/(.*?) b\/(.*?)$/gm;
      const matches = [...patchContent.matchAll(diffPattern)];

      if (matches.length === 0) {
        return null;
      }

      for (const match of matches) {
        const filePath = match[2]; // Use the "b/" path (new file)
        if (!filePath) continue; // Skip if no path found

        // Extract the patch content for this file
        // For simplicity, we'll extract everything after the diff header
        // In a full implementation, we'd properly parse hunks and apply them
        const fileStart = match.index!;
        const nextMatch = matches[matches.indexOf(match) + 1];
        const fileEnd = nextMatch ? nextMatch.index! : patchContent.length;
        const filePatch = patchContent.substring(fileStart, fileEnd);

        // For now, extract content lines (lines starting with +)
        // This is a simplified approach - a full parser would handle hunks properly
        const contentLines = filePatch
          .split('\n')
          .filter(line => line.startsWith('+') && !line.startsWith('+++'))
          .map(line => line.substring(1));

        if (contentLines.length > 0) {
          files.push({
            path: filePath,
            content: contentLines.join('\n'),
          });
        }
      }

      return files.length > 0 ? { files } : null;
    } catch (error) {
      this.log(`Error parsing patch: ${error instanceof Error ? error.message : 'Unknown'}`);
      return null;
    }
  }

  /**
   * Log message if verbose mode is enabled
   */
  private log(message: string): void {
    if (this.verbose) {
      console.log(`[NIP34] ${message}`);
    }
  }
}
