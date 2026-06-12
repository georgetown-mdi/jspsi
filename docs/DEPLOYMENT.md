---
title: "PSI-Link Deployment"
---

# PSI-Link deployment

This document covers the deployment and operation of the supporting services required to run PSI-Link exchanges, including reference configurations for each service type and Docker deployment of the CLI. It does not cover the communication protocol those services support (see [COMMUNICATION.md](COMMUNICATION.md)) or the CLI commands used against them (see [CLI.md](CLI.md)). Intended readers are system administrators and IT staff.

## STUN/TURN

PSI-Link does not bundle a STUN or TURN server, and no reference configuration is provided in this release. Deployments needing NAT traversal for WebRTC typically either point at a commercial ICE-credential service (Twilio Network Traversal Service and equivalents return time-limited credentials on demand; see [COMMUNICATION.md#stunturn](COMMUNICATION.md#stunturn)) or operate a self-hosted coturn instance using its upstream documentation. Reference configurations for both are targeted for the 1.1 release; see [ROADMAP.md](ROADMAP.md).

## WebSocket-to-TCP proxy

A WebSocket-to-TCP proxy is required only when a browser-based party needs to reach an SFTP server, because browser runtimes cannot open raw TCP connections (see [COMMUNICATION.md#websocket-to-tcp-proxy](COMMUNICATION.md#websocket-to-tcp-proxy)). The CLI does not need this proxy. No reference configuration is provided in this release; deployment guidance is targeted for the 1.1 release (see [ROADMAP.md](ROADMAP.md)).

## Peer coordination server

The web application bundles a PeerJS-compatible peer-coordination server, served under its own `/api/` route, so deploying the web application is sufficient to obtain a coordination server for parties that use it. The public PeerJS service (`api.peerjs.com`) is also usable for evaluation but routes connection-establishment metadata through a third party.

Deploying a standalone peer-coordination server — for example, as a serverless WebSocket function on AWS Lambda or Cloudflare Workers — is not currently supported by configuration in the web application and is targeted for the 1.1 release (see [ROADMAP.md](ROADMAP.md)).

## SFTP server

PSI-Link does not include or require any particular SFTP server. In practice almost all deployments reuse an existing service: `sshd` on a standard Linux host, with a per-exchange directory whose Unix permissions restrict access to the two partner accounts, is sufficient. The two parties should agree out-of-band on the directory path and on which accounts have access; nothing more is required of the server beyond that.

For local development and integration testing, the project's test suite stands up its own SFTP server (an in-process `ssh2.Server` by default, or a native OpenSSH `sshd` child process). That setup is intended for testing the CLI's transport behavior against a known-good server and is not a production reference.

## Docker deployment

### Key file permissions in containers

Automated deployment tooling -- CI runners, container entrypoints, Kubernetes init containers, and orchestration scripts -- must not leave `.psilink.key` readable by other processes or users. Violating this rule defeats the application-layer authentication that protects recurring exchanges.

**Inject via a secrets manager, not the image.** Never copy `.psilink.key` into a container image layer; image layers are readable by anyone with pull access to the registry. Instead, mount the file at runtime:

- **Docker**: mount the key file as a named secret or a host-path bind mount with `--mount type=bind,src=/host/path/.psilink.key,dst=/work/.psilink.key`. Do not mount it read-only; the CLI must be able to write the rotated token after each successful exchange. Set the file's permissions to `0600` on the host before the container starts.
- **Kubernetes**: use a `Secret` volume with `defaultMode: 0600`. Do not use a `ConfigMap` for the key file.
- **CI runners**: write the token to a temporary file with `install -m 0600 /dev/stdin .psilink.key <<< "$TOKEN"` (bash) or `printf '%s' "$TOKEN" | install -m 0600 /dev/stdin .psilink.key` (POSIX sh) rather than `echo "$TOKEN" > .psilink.key`, which may leave a world-readable file depending on the runner's umask.

**Separate read-only config from read-write secrets.** If the working directory (containing `psilink.yaml` and input data) is mounted read-only - for example to prevent the container from modifying source data - mount a separate read-write volume for the key file and use `--key-file` to redirect the CLI:

```sh
# Docker
# /run/secrets must be read-write; the CLI writes the rotated token after each successful exchange
docker run \
  --mount type=bind,src=/data/config,dst=/work,readonly \
  --mount type=bind,src=/data/secrets,dst=/run/secrets \
  vdorie/psi-link exchange input.csv --key-file /run/secrets/.psilink.key
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
        mountPath: /work
        readOnly: true
      - name: secrets
        mountPath: /run/secrets
    args: ["exchange", "input.csv", "--key-file", "/run/secrets/.psilink.key"]
```

The `--key-file` flag is accepted by both `exchange` (reads the token on start and writes the rotated token back to the same path after a successful exchange) and `zero-setup` (specifies the output path when `--save` is used).

**Verify before first exchange.** After injecting the key file, verify its permissions before running `psilink exchange`:

```sh
stat -c "%a %n" .psilink.key   # Linux
stat -f "%Lp %N" .psilink.key  # macOS
```

The output must show `600`. If it does not, the CLI will emit a warning on load; correct the permissions before proceeding.

## See also

- [COMMUNICATION.md](COMMUNICATION.md) - the communication channels and services described here
- [CLI.md](CLI.md) - CLI configuration for connecting to the services described here
