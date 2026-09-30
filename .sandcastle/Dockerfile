FROM node:22-bookworm

# Links the published GHCR package (ghcr.io/toon-protocol/toon:sandcastle-agent, see the
# pull step in .github/workflows/agent-implement.yml) to this repo.
LABEL org.opencontainers.image.source="https://github.com/toon-protocol/toon"

# Install system dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# Enable pnpm via corepack (run as root, before the USER switch — corepack
# writes shims into a root-owned prefix). Pin matches toon's package.json
# `packageManager` field (pnpm@8.15.9).
RUN corepack enable && corepack prepare pnpm@8.15.9 --activate

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Matt Pocock's skills, the same plugin used interactively. The runner starts each agent
# session with `/mattpocock-skills:implement` or `/mattpocock-skills:code-review`, so they
# must be installed here. A fresh install doesn't know the official marketplace yet, so add
# it first. This takes the plugin's latest release when the image is built; rebuild the
# image to pick up a newer one.
RUN /home/agent/.local/bin/claude plugin marketplace add anthropics/claude-plugins-official \
  && /home/agent/.local/bin/claude plugin install mattpocock-skills@claude-plugins-official

# Solana CLI, for `solana-test-validator`: ci.yml's `solana-settlement-proof` job runs the
# SDK's redemption proof against one, and the runner's gate runs that proof for a change that
# touches the Solana settlement surface. Pinned to the version ci.yml installs, v2.1.21, and
# not the v3.x line: v3's validator hard-requires io_uring, which some sandboxed runtimes,
# this container's included, do not permit. If you bump one, bump the other.
RUN curl -sSfL https://release.anza.xyz/v2.1.21/install | sh

# Add Claude and the Solana CLI to PATH
ENV PATH="/home/agent/.local/bin:/home/agent/.local/share/solana/install/active_release/bin:$PATH"

# ENV PATH covers the engine, which execs non-login shells. claude-code spawns its own
# shells for the agent's commands, and a LOGIN shell sources /etc/profile, which rebuilds
# PATH from scratch and drops anything set only via ENV. The Solana installer appends itself
# to ~/.profile but not ~/.bashrc, so do both explicitly.
RUN printf '\n# Solana CLI (solana-test-validator) — see .sandcastle/Dockerfile\nexport PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"\n' \
  | tee -a /home/agent/.profile >> /home/agent/.bashrc

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at /home/agent/workspace
# and overrides the working directory to /home/agent/workspace at container start.
# Structure your Dockerfile so that /home/agent/workspace can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
