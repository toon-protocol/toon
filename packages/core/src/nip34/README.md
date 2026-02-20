# NIP-34: Git Stuff

ILP-gated Git infrastructure for Crosstown, implementing [NIP-34](https://github.com/nostr-protocol/nips/blob/master/34.md) for decentralized code collaboration.

## Overview

This module enables Crosstown to provide Git infrastructure alongside relay infrastructure, both gated by ILP micropayments. Users submit NIP-34 events (repository announcements, patches, pull requests, issues) via ILP payments, and Crosstown executes the corresponding Git operations on a Forgejo instance.

## Architecture

```
User creates NIP-34 event → Sends to Crosstown relay (with ILP payment)
→ BLS validates payment → Stores event → NIP34Handler processes event
→ Executes Git operation on Forgejo
```

**Git Reads:** Public, free (standard Git protocol)
**Git Writes:** Mediated through NIP-34 events → ILP payment → Crosstown → Forgejo

## Setup

### 1. Install Dependencies

```bash
cd packages/core
npm install simple-git
```

### 2. Deploy Forgejo

Forgejo is already configured in your `docker-compose-testnet.yml`:

```bash
docker compose -f docker-compose-testnet.yml up -d forgejo
```

Access Forgejo UI: http://localhost:3003

### 3. Create API Token

1. Log in to Forgejo: http://localhost:3003
2. Go to **Settings → Applications → Generate New Token**
3. Name: "Crosstown Integration"
4. Scopes: `write:repository`, `write:issue`, `write:user`
5. Save the token

### 4. Configure Environment

Add to your `.env`:

```bash
FORGEJO_URL=http://forgejo:3000
FORGEJO_TOKEN=your-api-token-here
FORGEJO_OWNER=crosstown
```

## Usage

### Initialize NIP-34 Handler

```typescript
import { NIP34Handler } from '@crosstown/core';

const nip34Handler = new NIP34Handler({
  forgejoUrl: process.env.FORGEJO_URL!,
  forgejoToken: process.env.FORGEJO_TOKEN!,
  defaultOwner: process.env.FORGEJO_OWNER!,
  gitConfig: {
    userName: 'Crosstown Node',
    userEmail: 'node@crosstown.nostr',
  },
  verbose: true,
});
```

### Integrate with BLS

```typescript
import { BusinessLogicServer } from '@crosstown/bls';

const bls = new BusinessLogicServer(
  {
    basePricePerByte: 10n,
    spspMinPrice: 0n,

    // NIP-34 integration
    onNIP34Event: async (event) => {
      const result = await nip34Handler.handleEvent(event);
      console.log(`${result.operation}: ${result.message}`);
    },
  },
  eventStore
);
```

## Supported Operations

### Repository Announcement (kind 30617)

**Nostr Event:**
```json
{
  "kind": 30617,
  "tags": [
    ["d", "my-repo"],
    ["name", "My Repository"],
    ["description", "A cool project"]
  ]
}
```

**Git Operation:**
- Creates repository: `http://forgejo:3003/crosstown/my-repo`

### Patch Submission (kind 1617)

**Nostr Event:**
```json
{
  "kind": 1617,
  "tags": [
    ["a", "30617:<pubkey>:my-repo"],
    ["commit", "<sha>"],
    ["parent-commit", "<parent-sha>"]
  ],
  "content": "<git format-patch output>"
}
```

**Git Operation:**
1. Clone repository
2. Apply patch via `git am`
3. Push to new branch `nostr-patch-<event-id>`
4. Create pull request

### Pull Request (kind 1618)

**Nostr Event:**
```json
{
  "kind": 1618,
  "tags": [
    ["a", "30617:<pubkey>:my-repo"],
    ["clone", "https://contributor.git"],
    ["c", "<commit-tip>"],
    ["subject", "Add feature X"]
  ]
}
```

**Git Operation:**
1. Clone main repository
2. Add contributor's repository as remote
3. Fetch contributor's commit
4. Create pull request

### Issue Creation (kind 1621)

**Nostr Event:**
```json
{
  "kind": 1621,
  "tags": [
    ["a", "30617:<pubkey>:my-repo"],
    ["subject", "Bug: Something broken"]
  ],
  "content": "## Description\n\nI found a bug..."
}
```

**Git Operation:**
- Creates issue in Forgejo with markdown body

## API Reference

### NIP34Handler

Main handler for processing NIP-34 events.

```typescript
class NIP34Handler {
  constructor(config: NIP34Config);
  async handleEvent(event: NostrEvent): Promise<HandleEventResult>;
}
```

**Config:**
```typescript
interface NIP34Config {
  forgejoUrl: string;        // e.g., "http://forgejo:3000"
  forgejoToken: string;       // API token
  defaultOwner: string;       // Default org/user
  gitConfig?: {
    userName?: string;
    userEmail?: string;
    workDir?: string;
  };
  verbose?: boolean;
}
```

**Result:**
```typescript
interface HandleEventResult {
  success: boolean;
  operation: 'repository' | 'patch' | 'pull_request' | 'issue' | 'status';
  message: string;
  metadata?: {
    repoId?: string;
    htmlUrl?: string;
    prNumber?: number;
    issueNumber?: number;
  };
}
```

### ForgejoClient

Low-level Forgejo API client.

```typescript
class ForgejoClient {
  async createRepository(options: CreateRepositoryOptions): Promise<ForgejoRepository>;
  async createPullRequest(options: CreatePullRequestOptions): Promise<ForgejoPullRequest>;
  async createIssue(options: CreateIssueOptions): Promise<ForgejoIssue>;
  async repositoryExists(owner: string, repo: string): Promise<boolean>;
}
```

### GitOperations

Git protocol operations (patch application, cloning).

```typescript
class GitOperations {
  async applyPatch(options: ApplyPatchOptions): Promise<ApplyPatchResult>;
  async clone(cloneUrl: string): Promise<{ git: SimpleGit; workDir: string }>;
  async cleanup(workDir: string): Promise<void>;
}
```

## Integration Pattern

The NIP-34 handler uses a **hybrid approach**:

- **REST API** for high-level operations:
  - Creating repositories
  - Creating pull requests
  - Creating issues

- **Git protocol** for low-level operations:
  - Applying patches
  - Cloning repositories
  - Pushing commits

This is necessary because Forgejo (like Gitea) doesn't expose a Git Database API for creating individual Git objects (blobs, trees, commits) via REST, unlike GitHub.

## Event Flow Example

1. **User creates repository:**
   ```bash
   # User publishes NIP-34 event (kind 30617) with ILP payment
   # Crosstown validates payment and stores event
   # NIP34Handler creates repo in Forgejo
   ```

2. **User submits patch:**
   ```bash
   git format-patch HEAD~1 > patch.diff
   # User publishes NIP-34 event (kind 1617) with patch content
   # Crosstown applies patch and creates PR in Forgejo
   ```

3. **User reads repository:**
   ```bash
   # Free, public access via standard Git protocol
   git clone http://localhost:3003/crosstown/my-repo.git
   ```

## Deployment

Your `docker-compose-testnet.yml` already includes Forgejo. Just ensure environment variables are set:

```bash
# .env
FORGEJO_URL=http://forgejo:3000
FORGEJO_TOKEN=<your-token>
FORGEJO_OWNER=crosstown
```

Then start the stack:

```bash
docker compose -f docker-compose-testnet.yml up -d
```

## Future Enhancements

- **Status events (1630-1633):** Sync PR/issue status between Nostr and Forgejo
- **Webhooks:** Publish Forgejo events back to Nostr
- **Git Database API:** Contribute to Forgejo upstream for pure REST-based patch application
- **Multi-owner support:** Map Nostr pubkeys to Forgejo users for attribution

## Resources

- [NIP-34 Specification](https://github.com/nostr-protocol/nips/blob/master/34.md)
- [Forgejo API Documentation](https://forgejo.org/docs/latest/user/api-usage/)
- [ngit-cli](https://codeberg.org/DanConwayDev/ngit-cli) - Reference NIP-34 client
- [GitWorkshop.dev](https://gitworkshop.dev/) - NIP-34 web UI
