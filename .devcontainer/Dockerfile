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

# Shared-library dependencies for the headless Chromium the web app's
# `test:browser` suite drives through Playwright. Only the apt libraries are baked
# here (they need root and are version-stable across Chromium builds); the browser
# BINARY is fetched in post-create.sh, after `npm ci`, so it always matches the
# lockfile's playwright -- whereas a version baked here would have to be hand-kept
# in lockstep, and a drift would make the runtime re-download a browser the egress
# firewall then blocks. `install-deps` only runs apt (no zip extraction), so it is
# unaffected by the Node 26 yauzl hang that the browser download hit before
# playwright 1.60. The version here is just what npx runs to emit the apt list; it
# is version-tolerant, so it need not track the lockfile exactly.
RUN npx --yes playwright@1.61.0 install-deps chromium \
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

# Infrastructure profile, built by .devcontainer/infra/devcontainer.json with
# PSILINK_INFRA=1: the AWS CLI, the Docker CLIENT, and a loopback CONNECT proxy
# that gates egress by hostname, for work against AWS, Cloudflare, Let's
# Encrypt, and a remote EC2 host -- destinations init-firewall.sh's IP allowlist
# cannot express (EC2 in us-west-2 alone is 169 shared-tenant prefixes).
#
# The build arg is declared HERE, below every layer the default profile uses, so
# a PSILINK_INFRA=0 build reproduces those layers from cache unchanged. The two
# files below are COPYed unconditionally -- a COPY cannot be made conditional --
# and the RUN deletes them again when the arg is 0, so a PSILINK_INFRA=0 image
# carries no path this block introduced.
#
# tinyproxy is GATED rather than installed unconditionally and left unused:
# absent from the image is checkable, inert is not, and "installed but nothing
# ever starts it" is exactly the runtime claim a comment cannot hold. The
# binary-only tinyproxy-bin is what is installed, rather than the tinyproxy
# metapackage over it, so the image gains no service unit, no default config
# listening on 8888, and no cron/logrotate dependency chain; the system user and
# the whole configuration are this profile's own.
#
# NO Docker daemon and NO socket mount, only the client, for `docker -H
# ssh://user@host` against a remote daemon. The host's Docker socket is root on
# the host, so mounting it would delete the container boundary that is layer 1
# of the security model in README.md.
COPY init-egress-proxy.sh /usr/local/bin/
COPY infra/egress-allowlist /usr/local/share/psilink-egress-allowlist

ARG PSILINK_INFRA=0
# Pinned, and both digests were taken from an archive whose detached signature
# verified against the AWS CLI Team key FB5D B77F D5C1 18B8 0511  ADA8 A631
# 0ACC 4672 475C. AWS publishes no checksum file, so the signature is the
# provenance and the digest is what the build re-checks; re-verify the same way
# when bumping the version (README.md beside this file, Infrastructure profile).
ARG AWSCLI_VERSION=2.36.38
ARG AWSCLI_SHA256_AARCH64=52b045f09058a8e9f54976ec136bb2085463f4ce6db3008980d62381bfeccff5
ARG AWSCLI_SHA256_X86_64=1056bc30b892f4a80e65b05eac856fbf175d0c5aeda051d782450d2218db6657

USER root
RUN set -eu; \
  if [ "$PSILINK_INFRA" != "1" ]; then \
  rm -f /usr/local/bin/init-egress-proxy.sh /usr/local/share/psilink-egress-allowlist; \
  else \
  case "$(dpkg --print-architecture)" in \
  arm64) awscli_arch=aarch64; awscli_sha="$AWSCLI_SHA256_AARCH64" ;; \
  amd64) awscli_arch=x86_64; awscli_sha="$AWSCLI_SHA256_X86_64" ;; \
  *) echo "PSILINK_INFRA: unsupported architecture $(dpkg --print-architecture)"; exit 1 ;; \
  esac; \
  curl -fsSL -o /tmp/awscliv2.zip "https://awscli.amazonaws.com/awscli-exe-linux-$awscli_arch-$AWSCLI_VERSION.zip"; \
  echo "$awscli_sha  /tmp/awscliv2.zip" | sha256sum -c -; \
  unzip -q /tmp/awscliv2.zip -d /tmp/awscliv2; \
  /tmp/awscliv2/aws/install; \
  rm -rf /tmp/awscliv2.zip /tmp/awscliv2; \
  install -m 0755 -d /etc/apt/keyrings; \
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc; \
  chmod go+r /etc/apt/keyrings/docker.asc; \
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list; \
  apt-get update; \
  apt-get install -y --no-install-recommends docker-ce-cli tinyproxy-bin netcat-openbsd; \
  apt-get clean; rm -rf /var/lib/apt/lists/*; \
  useradd --system --no-create-home --shell /usr/sbin/nologin tinyproxy; \
  chmod +x /usr/local/bin/init-egress-proxy.sh; \
  { \
  echo 'Defaults!/usr/local/bin/init-egress-proxy.sh env_keep += "PSILINK_EGRESS_EXTRA_HOSTS"'; \
  echo 'node ALL=(root) NOPASSWD: /usr/local/bin/init-egress-proxy.sh'; \
  } >> /etc/sudoers.d/node-firewall; \
  chmod 0440 /etc/sudoers.d/node-firewall; \
  visudo -c -f /etc/sudoers.d/node-firewall; \
  mkdir -p /etc/ssh/ssh_config.d; \
  { \
  echo '# Infra dev-container profile: every SSH destination is reached through the'; \
  echo '# loopback CONNECT proxy, so an SSH host is admitted by the same hostname'; \
  echo '# allowlist an HTTPS host is. Without this ssh opens a socket directly and'; \
  echo '# the egress firewall rejects it. First match wins in ssh_config, so the'; \
  echo '# loopback exemption -- the local sshd the SFTP test backend spawns -- has'; \
  echo '# to precede the catch-all.'; \
  echo 'Host localhost 127.0.0.1 ::1'; \
  echo '  ProxyCommand none'; \
  echo ''; \
  echo 'Host *'; \
  echo '  ProxyCommand nc -X connect -x 127.0.0.1:8888 %h %p'; \
  } > /etc/ssh/ssh_config.d/psilink-egress-proxy.conf; \
  chmod 0644 /etc/ssh/ssh_config.d/psilink-egress-proxy.conf; \
  fi
USER node
