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
import { GitOperations, type ApplyPatchOptions } from './GitOperations.js';
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
  /** Git user configuration */
  gitConfig?: {
    userName?: string;
    userEmail?: string;
    workDir?: string;
  };
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
  private git: GitOperations;
  private verbose: boolean;

  constructor(config: NIP34Config) {
    this.forgejo = new ForgejoClient({
      baseUrl: config.forgejoUrl,
      token: config.forgejoToken,
      defaultOwner: config.defaultOwner,
    });

    this.git = new GitOperations(config.gitConfig);
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

    this.log(`Creating repository: ${repoId}`);

    const options: CreateRepositoryOptions = {
      name: repoId,
      description: description || name,
      private: false,
      auto_init: true,
    };

    const repo = await this.forgejo.createRepository(options);

    this.log(`Repository created: ${repo.html_url}`);

    return {
      success: true,
      operation: 'repository',
      message: `Repository "${repoId}" created`,
      metadata: {
        repoId,
        htmlUrl: repo.html_url,
        cloneUrl: repo.clone_url,
      },
    };
  }

  /**
   * Handle Patch (kind 1617)
   *
   * Applies a patch to a repository and creates a pull request.
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
    const owner = this.forgejo['defaultOwner']!; // Type assertion - we know it's set
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

    // Apply patch via Git protocol
    const cloneUrl = this.forgejo.getInternalCloneUrl(owner, repoName);
    const patchBranch = this.git.generatePatchBranchName(event.id);
    const commitMessage = extractCommitMessage(patchContent);

    const patchOptions: ApplyPatchOptions = {
      cloneUrl,
      patchContent,
      patchBranch,
      baseBranch: 'main',
      commitMessage,
    };

    const result = await this.git.applyPatch(patchOptions);

    // Clean up working directory
    await this.git.cleanup(result.workDir);

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
        commitSha: result.commitSha,
        prNumber: pr.number,
        prUrl: pr.html_url,
      },
    };
  }

  /**
   * Handle Pull Request (kind 1618)
   *
   * Creates a pull request from a remote repository.
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
    const owner = this.forgejo['defaultOwner']!;
    const repoName = repoRef.repoId;

    this.log(`Creating PR for ${owner}/${repoName} from ${cloneUrl}`);

    // Clone the main repository
    const mainCloneUrl = this.forgejo.getInternalCloneUrl(owner, repoName);
    const { git, workDir } = await this.git.clone(mainCloneUrl);

    try {
      // Add contributor's repository as remote
      await this.git.addRemote(git, 'contributor', cloneUrl);
      await this.git.fetch(git, 'contributor');

      // Create local branch tracking contributor's commit
      const prBranch = this.git.generatePRBranchName(event.id);
      await git.checkout(commitTip, ['-b', prBranch]);

      // Push branch to origin
      await git.push('origin', prBranch, ['--set-upstream']);

      // Create pull request via API
      const pr = await this.forgejo.createPullRequest({
        owner,
        repo: repoName,
        title: subject || 'Pull request from Nostr',
        head: prBranch,
        base: 'main',
        body: `Pull request from Nostr event: ${event.id}\n\nAuthor: ${event.pubkey}\nSource: ${cloneUrl}`,
      });

      this.log(`Pull request created: ${pr.html_url}`);

      return {
        success: true,
        operation: 'pull_request',
        message: `PR #${pr.number} created`,
        metadata: {
          branch: prBranch,
          prNumber: pr.number,
          prUrl: pr.html_url,
        },
      };
    } finally {
      await this.git.cleanup(workDir);
    }
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
   * Log message if verbose mode is enabled
   */
  private log(message: string): void {
    if (this.verbose) {
      console.log(`[NIP34] ${message}`);
    }
  }
}
