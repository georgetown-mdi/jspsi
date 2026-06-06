#!/bin/sh

dir=apps/cli/test/container

mkdir -p "$dir/sftp/srv"

ssh-keygen -t ed25519 -f "$dir/sftp/ssh_host_ed25519_key" < /dev/null
ssh-keygen -t rsa -b 4096 -f "$dir/sftp/ssh_host_rsa_key" < /dev/null

# Container env: Compose project name and host port. Created only if absent so a
# per-worktree override (written by the make-worktree command with a unique
# project and a free port) is not clobbered. The main checkout keeps 2222.
if [ ! -f "$dir/.env" ]; then
  cat > "$dir/.env" <<'EOF'
COMPOSE_PROJECT_NAME=psilink-sftp
SFTP_PORT=2222
EOF
fi
