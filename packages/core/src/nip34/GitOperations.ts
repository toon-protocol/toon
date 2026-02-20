/**
 * Git Operations Helper
 *
 * Handles low-level Git operations like cloning, applying patches, and pushing.
 * Uses simple-git library for Git protocol operations.
 *
 * Note: This requires simple-git to be installed:
 *   npm install simple-git
 */

import { simpleGit, SimpleGit, SimpleGitOptions } from 'simple-git';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

export interface GitConfig {
  /** Working directory for temporary clones */
  workDir?: string;
  /** Git user name for commits */
  userName?: string;
  /** Git user email for commits */
  userEmail?: string;
}

export interface ApplyPatchOptions {
  /** Git clone URL */
  cloneUrl: string;
  /** Patch content (git format-patch output) */
  patchContent: string;
  /** Target branch to apply patch to */
  baseBranch?: string;
  /** New branch name for the patch */
  patchBranch: string;
  /** Commit message (extracted from patch if not provided) */
  commitMessage?: string;
}

export interface ApplyPatchResult {
  /** Branch where patch was applied */
  branch: string;
  /** Commit SHA after applying patch */
  commitSha: string;
  /** Working directory path (caller should clean up) */
  workDir: string;
}

/**
 * Git Operations Helper
 */
export class GitOperations {
  private workDir: string;
  private userName: string;
  private userEmail: string;

  constructor(config: GitConfig = {}) {
    this.workDir = config.workDir || tmpdir();
    this.userName = config.userName || 'Crosstown Node';
    this.userEmail = config.userEmail || 'crosstown@nostr.local';
  }

  /**
   * Create a temporary directory for Git operations
   */
  private async createTempDir(prefix: string): Promise<string> {
    return mkdtemp(join(this.workDir, `${prefix}-`));
  }

  /**
   * Initialize Git client with configuration
   */
  private getGit(workDir: string): SimpleGit {
    const options: Partial<SimpleGitOptions> = {
      baseDir: workDir,
      binary: 'git',
      maxConcurrentProcesses: 1,
    };

    const git = simpleGit(options);

    // Configure user for commits
    git.addConfig('user.name', this.userName);
    git.addConfig('user.email', this.userEmail);

    return git;
  }

  /**
   * Apply a patch to a repository
   *
   * Process:
   * 1. Clone repository
   * 2. Create new branch
   * 3. Apply patch
   * 4. Commit changes
   * 5. Push to remote
   *
   * Returns the branch name and commit SHA.
   * Caller is responsible for cleaning up the working directory.
   */
  async applyPatch(options: ApplyPatchOptions): Promise<ApplyPatchResult> {
    const workDir = await this.createTempDir('patch');
    const git = this.getGit(workDir);

    try {
      // Clone repository
      await git.clone(options.cloneUrl, workDir);

      // Checkout base branch
      const baseBranch = options.baseBranch || 'main';
      await git.checkout(baseBranch);

      // Create and checkout new branch
      await git.checkoutBranch(options.patchBranch, baseBranch);

      // Write patch to file
      const patchFile = join(workDir, 'patch.diff');
      await writeFile(patchFile, options.patchContent);

      // Apply patch using git am (preserves commit metadata)
      await git.raw(['am', patchFile]);

      // Get the commit SHA
      const log = await git.log({ maxCount: 1 });
      const commitSha = log.latest?.hash;
      if (!commitSha) {
        throw new Error('Failed to get commit SHA after applying patch');
      }

      // Push branch to remote
      await git.push('origin', options.patchBranch, ['--set-upstream']);

      return {
        branch: options.patchBranch,
        commitSha,
        workDir,
      };
    } catch (error) {
      // Clean up on error
      await this.cleanup(workDir);
      throw new Error(
        `Failed to apply patch: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Clone a repository to a temporary directory
   */
  async clone(cloneUrl: string): Promise<{ git: SimpleGit; workDir: string }> {
    const workDir = await this.createTempDir('clone');
    const git = this.getGit(workDir);

    try {
      await git.clone(cloneUrl, workDir);
      return { git, workDir };
    } catch (error) {
      await this.cleanup(workDir);
      throw new Error(
        `Failed to clone repository: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Add a remote repository
   */
  async addRemote(
    git: SimpleGit,
    remoteName: string,
    remoteUrl: string
  ): Promise<void> {
    await git.addRemote(remoteName, remoteUrl);
  }

  /**
   * Fetch from a remote
   */
  async fetch(git: SimpleGit, remoteName: string): Promise<void> {
    await git.fetch(remoteName);
  }

  /**
   * Clean up a working directory
   */
  async cleanup(workDir: string): Promise<void> {
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch (error) {
      console.error(`Failed to cleanup ${workDir}:`, error);
    }
  }

  /**
   * Generate a unique branch name for a patch
   */
  generatePatchBranchName(eventId: string): string {
    const shortId = eventId.substring(0, 8);
    return `nostr-patch-${shortId}`;
  }

  /**
   * Generate a unique branch name for a PR
   */
  generatePRBranchName(eventId: string): string {
    const shortId = eventId.substring(0, 8);
    return `nostr-pr-${shortId}`;
  }
}
