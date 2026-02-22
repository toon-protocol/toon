/**
 * Forgejo API Client
 *
 * Wrapper around Forgejo REST API for repository and issue management.
 * Uses fetch API for HTTP requests (compatible with gitea-js SDK structure).
 */

export interface ForgejoConfig {
  /** Base URL of Forgejo instance (e.g., "http://forgejo:3000") */
  baseUrl: string;
  /** API token for authentication */
  token: string;
  /** Default owner/organization for repositories */
  defaultOwner?: string;
}

export interface CreateRepositoryOptions {
  name: string;
  description?: string;
  private?: boolean;
  auto_init?: boolean;
  default_branch?: string;
}

export interface CreatePullRequestOptions {
  owner: string;
  repo: string;
  title: string;
  head: string; // source branch
  base: string; // target branch
  body?: string;
}

export interface CreateIssueOptions {
  owner: string;
  repo: string;
  title: string;
  body?: string;
  labels?: number[]; // label IDs
}

export interface ForgejoRepository {
  id: number;
  name: string;
  full_name: string;
  description: string;
  html_url: string;
  clone_url: string;
  ssh_url: string;
}

export interface ForgejoPullRequest {
  id: number;
  number: number;
  title: string;
  html_url: string;
  state: 'open' | 'closed';
}

export interface ForgejoIssue {
  id: number;
  number: number;
  title: string;
  html_url: string;
  state: 'open' | 'closed';
}

export interface CreateOrUpdateFileOptions {
  owner: string;
  repo: string;
  filepath: string;
  content: string; // base64 encoded
  message: string;
  branch?: string;
  sha?: string; // required for updates
}

export interface ForgejoFileResponse {
  content: {
    name: string;
    path: string;
    sha: string;
  };
  commit: {
    sha: string;
  };
}

/**
 * Forgejo API Client
 */
export class ForgejoClient {
  private baseUrl: string;
  private token: string;
  private defaultOwner?: string;

  constructor(config: ForgejoConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.token = config.token;
    this.defaultOwner = config.defaultOwner;
  }

  /**
   * Make an authenticated API request
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path}`;
    const headers: Record<string, string> = {
      Authorization: `token ${this.token}`,
      'Content-Type': 'application/json',
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Forgejo API error (${response.status}): ${errorText}`
      );
    }

    return response.json() as Promise<T>;
  }

  /**
   * Create a new repository
   */
  async createRepository(
    options: CreateRepositoryOptions
  ): Promise<ForgejoRepository> {
    const owner = this.defaultOwner;
    if (!owner) {
      throw new Error('No default owner configured for repository creation');
    }

    return this.request<ForgejoRepository>('POST', '/user/repos', {
      name: options.name,
      description: options.description || '',
      private: options.private ?? false,
      auto_init: options.auto_init ?? true,
      default_branch: options.default_branch || 'main',
    });
  }

  /**
   * Create a pull request
   */
  async createPullRequest(
    options: CreatePullRequestOptions
  ): Promise<ForgejoPullRequest> {
    return this.request<ForgejoPullRequest>(
      'POST',
      `/repos/${options.owner}/${options.repo}/pulls`,
      {
        title: options.title,
        head: options.head,
        base: options.base,
        body: options.body || '',
      }
    );
  }

  /**
   * Create an issue
   */
  async createIssue(options: CreateIssueOptions): Promise<ForgejoIssue> {
    return this.request<ForgejoIssue>(
      'POST',
      `/repos/${options.owner}/${options.repo}/issues`,
      {
        title: options.title,
        body: options.body || '',
        labels: options.labels,
      }
    );
  }

  /**
   * Get repository information
   */
  async getRepository(
    owner: string,
    repo: string
  ): Promise<ForgejoRepository> {
    return this.request<ForgejoRepository>(
      'GET',
      `/repos/${owner}/${repo}`
    );
  }

  /**
   * Check if repository exists
   */
  async repositoryExists(owner: string, repo: string): Promise<boolean> {
    try {
      await this.getRepository(owner, repo);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get clone URL for internal use (within Docker network)
   */
  getInternalCloneUrl(owner: string, repo: string): string {
    // Use internal Docker network URL
    return `${this.baseUrl}/${owner}/${repo}.git`;
  }

  /**
   * Get clone URL for external use
   */
  getExternalCloneUrl(repo: ForgejoRepository): string {
    return repo.clone_url;
  }

  /**
   * Create or update a file in a repository
   */
  async createOrUpdateFile(
    options: CreateOrUpdateFileOptions
  ): Promise<ForgejoFileResponse> {
    const path = `/repos/${options.owner}/${options.repo}/contents/${options.filepath}`;
    const body: Record<string, unknown> = {
      content: options.content,
      message: options.message,
    };

    if (options.branch) {
      body['branch'] = options.branch;
    }
    if (options.sha) {
      body['sha'] = options.sha;
    }

    // Use PUT for updates (when SHA provided), POST for creates
    const method = options.sha ? 'PUT' : 'POST';
    return this.request<ForgejoFileResponse>(method, path, body);
  }

  /**
   * Create a new branch
   */
  async createBranch(
    owner: string,
    repo: string,
    branchName: string,
    fromBranch: string = 'main'
  ): Promise<void> {
    // Create the new branch from the source branch
    // Forgejo API: POST /repos/{owner}/{repo}/branches
    await this.request('POST', `/repos/${owner}/${repo}/branches`, {
      new_branch_name: branchName,
      old_branch_name: fromBranch,
    });
  }

  /**
   * Get file content from repository
   */
  async getFileContent(
    owner: string,
    repo: string,
    filepath: string,
    branch?: string
  ): Promise<{ content: string; sha: string } | null> {
    try {
      const path = `/repos/${owner}/${repo}/contents/${filepath}${branch ? `?ref=${branch}` : ''}`;
      const response = await this.request<{
        content: string;
        sha: string;
      }>('GET', path);
      return response;
    } catch {
      return null;
    }
  }
}
