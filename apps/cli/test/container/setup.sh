#!/bin/sh

mkdir -p apps/cli/test/container/sftp/srv

ssh-keygen -t ed25519 -f apps/cli/test/container/sftp/ssh_host_ed25519_key < /dev/null
ssh-keygen -t rsa -b 4096 -f apps/cli/test/container/sftp/ssh_host_rsa_key < /dev/null
