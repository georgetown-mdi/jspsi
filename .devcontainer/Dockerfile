# Development container for psilink. Node 26 (the shipped runtime and the version
# .nvmrc, CI, and the product image pin), running as the non-root `node` user.
# It carries the OpenSSH server the native SFTP test backend spawns and the
# iptables/ipset stack the egress firewall installs at startup, so the full suite
# -- build, unit, lint, typecheck, web dev server, and both SFTP integration
# backends -- runs inside with no Docker present.
FROM node:26-bookworm

ARG TZ
ENV TZ="$TZ"

ARG CLAUDE_CODE_VERSION=latest

# Base development tools, the OpenSSH server/client the native SFTP test backend
# spawns and keygens against, and the iptables/ipset/dns toolchain the egress
# firewall uses (aggregate collapses the GitHub CIDR list, jq parses the meta
# feed, dnsutils provides dig, iproute2 provides ip).
RUN apt-get update && apt-get install -y --no-install-recommends \
  less \
  git \
  procps \
  sudo \
  fzf \
  zsh \
  man-db \
  unzip \
  gnupg2 \
  openssh-server \
  openssh-client \
  iptables \
  ipset \
  iproute2 \
  dnsutils \
  aggregate \
  jq \
  nano \
  vim \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# The GitHub CLI is not in Debian's repositories; add its official signed apt
# source, then install it. (The reference devcontainer's bare `apt-get install
# gh` only works where this source is already configured.)
RUN mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# The headless Chromium the web app's `test:browser` suite drives through
# Playwright, baked into the image at build time -- the browser binary plus its
# apt shared libraries (`--with-deps`) -- so the container starts ready with no
# per-create download. (Fetching the browser in post-create instead blocked the
# postCreate step, and with it the VS Code remote connection, on a ~180 MB
# download.) Installed under a fixed PLAYWRIGHT_BROWSERS_PATH owned by the node
# user, rather than the per-user ~/.cache default, so the non-root user that runs
# the tests finds the browser this root build step downloaded. Pinned to the
# lockfile's playwright (apps/web depends on ^1.55.0, resolved to 1.59.1); bump
# this together with that dependency -- a mismatch makes Playwright error loudly
# asking for `playwright install`, so it cannot pass silently.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx --yes playwright@1.59.1 install --with-deps chromium \
  && chown -R node:node /ms-playwright \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# The native sshd test backend spawns an unprivileged sshd, which still fatally
# checks for the privilege-separation directory at startup even when run as a
# normal user; create it at build time so the backend needs no root at test time
# (CI creates the same directory before its native leg).
RUN mkdir -p /run/sshd

# Give the non-root node user a writable global npm prefix (so claude-code can be
# installed -- and self-update -- without root), and put its bin on PATH for login
# shells too: a Dockerfile ENV PATH is rebuilt from scratch by Debian's
# /etc/profile, which both bash and zsh login shells re-source, so the npm-global
# bin (where the `claude` launcher lives) would otherwise drop off an interactive
# terminal's PATH.
RUN mkdir -p /usr/local/share/npm-global && \
  chown -R node:node /usr/local/share/npm-global && \
  echo 'export PATH="$PATH:/usr/local/share/npm-global/bin"' > /etc/profile.d/npm-global-path.sh

# Marks the environment as a dev container for orientation/tooling.
ENV DEVCONTAINER=true

# Create the workspace and Claude config mount points owned by the node user.
# /workspace/node_modules is pre-created and owned by node so the named volume
# mounted there in devcontainer.json (which isolates Linux-built dependencies,
# including the native cpu-features, from the bind-mounted host tree) is writable
# by the non-root user on first creation.
RUN mkdir -p /workspace/node_modules /home/node/.claude && \
  chown -R node:node /workspace /home/node/.claude

WORKDIR /workspace

USER node

ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin

ENV SHELL=/bin/zsh
ENV EDITOR=vim
ENV VISUAL=vim

# Claude Code itself, so an agent session runs inside the container.
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Install the egress firewall script and grant the node user passwordless sudo
# for that one command only, so devcontainer.json can apply it on start.
COPY init-firewall.sh /usr/local/bin/
USER root
RUN chmod +x /usr/local/bin/init-firewall.sh && \
  echo "node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" > /etc/sudoers.d/node-firewall && \
  chmod 0440 /etc/sudoers.d/node-firewall
USER node
