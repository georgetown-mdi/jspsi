# @psilink/peerjs-broker

The PeerJS-compatible WebSocket signaling broker two parties rendezvous through before their WebRTC data channel opens. It brokers only rendezvous-setup messages: no exchange payload crosses it, and the parties authenticate each other directly (see [docs/SECURITY_DESIGN.md](../../docs/SECURITY_DESIGN.md#channel-security)). Its upgrade-surface bounds -- inbound frame size, handshake parameter lengths, timeouts, the liveness reaper, and the relay queue caps -- are specified in [docs/spec/CHANNEL_SECURITY.md](../../docs/spec/CHANNEL_SECURITY.md).

`src/contrib/` is vendored from [peerjs-server](https://github.com/peers/peerjs-server) under the MIT license carried beside it, kept as upstream wrote it apart from this project's own hardening, so review history stays traceable. It is excluded from linting for that reason; everything else in this workspace is first-party.

The package ships TypeScript source and has no build step. The web app consumes it as a workspace dependency and bundles it into the server it deploys; the CLI's signaling test harness spawns the standalone entry point below.

## Running it standalone

```sh
npm start -w packages/peerjs-broker
```

It listens on an ephemeral loopback port and prints `psilink-broker <port>` once ready. `--path <mount>` and `--key <api-key>` override the mount path and the accepted API key.
