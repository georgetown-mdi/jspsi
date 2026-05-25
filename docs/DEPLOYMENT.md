---
title: "PSI-Link Deployment"
---

# PSI-Link deployment

This document covers the deployment and operation of the supporting services
required to run PSI-Link exchanges, including reference configurations for each
service type and Docker deployment of the CLI. It does not cover the
communication protocol those services support (see
[COMMUNICATION.md](COMMUNICATION.md)) or the CLI commands used against them
(see [CLI.md](CLI.md)). Intended readers are system administrators and IT staff.

## STUN/TURN

## WebSocket-to-TCP proxy

## Peer coordination server

## SFTP server

## Docker deployment

### Key file permissions in containers

Automated deployment tooling -- CI runners, container entrypoints, Kubernetes
init containers, and orchestration scripts -- must not leave `.psilink.key`
readable by other processes or users. Violating this rule defeats the
application-layer authentication that protects recurring exchanges.

**Inject via a secrets manager, not the image.** Never copy `.psilink.key`
into a container image layer; image layers are readable by anyone with pull
access to the registry. Instead, mount the file at runtime:

- **Docker**: mount the key file as a named secret or a host-path bind mount
  with `--mount type=bind,src=/host/path/.psilink.key,dst=/app/.psilink.key`.
  Do not mount it read-only; the CLI must be able to write the rotated token
  after each successful exchange. Set the file's permissions to `0600` on the
  host before the container starts.
- **Kubernetes**: use a `Secret` volume with `defaultMode: 0600`. Do not use a
  `ConfigMap` for the key file.
- **CI runners**: write the token to a temporary file with `install -m 0600
  /dev/stdin .psilink.key <<< "$TOKEN"` (bash) or
  `printf '%s' "$TOKEN" | install -m 0600 /dev/stdin .psilink.key` (POSIX sh)
  rather than `echo "$TOKEN" > .psilink.key`, which may leave a world-readable
  file depending on the runner's umask.

**Separate read-only config from read-write secrets.** If the working
directory (containing `psilink.yaml` and input data) is mounted read-only --
for example to prevent the container from modifying source data -- mount a
separate read-write volume for the key file and use `--key-file` to redirect
the CLI:

```sh
# Docker
# /run/secrets must be read-write; the CLI writes the rotated token after each successful exchange
docker run \
  --mount type=bind,src=/data/config,dst=/app,readonly \
  --mount type=bind,src=/data/secrets,dst=/run/secrets \
  psilink exchange input.csv --key-file /run/secrets/.psilink.key
```

```yaml
# Kubernetes: separate secretsDir volume alongside a read-only configMap mount
volumes:
  - name: config
    configMap:
      name: psilink-config
      defaultMode: 0444
  - name: secrets
    secret:
      secretName: psilink-key
      defaultMode: 0600
containers:
  - name: psilink
    volumeMounts:
      - name: config
        mountPath: /app
        readOnly: true
      - name: secrets
        mountPath: /run/secrets
    args: ["exchange", "input.csv", "--key-file", "/run/secrets/.psilink.key"]
```

The `--key-file` flag is accepted by both `exchange` (reads the token on start
and writes the rotated token back to the same path after a successful exchange)
and `zero-setup` (specifies the output path when `--save` is used).

**Verify before first exchange.** After injecting the key file, verify its
permissions before running `psilink exchange`:

```sh
stat -c "%a %n" .psilink.key   # Linux
stat -f "%Lp %N" .psilink.key  # macOS
```

The output must show `600`. If it does not, the CLI will emit a warning on
load; correct the permissions before proceeding.

## See also

- [COMMUNICATION.md](COMMUNICATION.md) - the communication channels and services described here
- [CLI.md](CLI.md) - CLI configuration for connecting to the services described here
