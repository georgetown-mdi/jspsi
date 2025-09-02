#!/bin/bash

mkdir -p test/container/sftp/srv

ssh-keygen -t ed25519 -f test/container/sftp/ssh_host_ed25519_key < /dev/null
ssh-keygen -t rsa -b 4096 -f test/container/sftp/ssh_host_rsa_key < /dev/null
