# @psilink/peerjs-broker

The PeerJS-compatible WebSocket signaling broker two parties rendezvous through before their WebRTC data channel opens. It brokers only rendezvous-setup messages: no exchange payload crosses it, and the parties authenticate each other directly (see [docs/SECURITY_DESIGN.md](../../docs/SECURITY_DESIGN.md#channel-security)). Its upgrade-surface bounds -- inbound frame size, handshake parameter lengths, timeouts, the liveness reaper, and the relay queue caps -- are specified in [docs/spec/CHANNEL_SECURITY.md](../../docs/spec/CHANNEL_SECURITY.md).

`src/contrib/` is vendored from [peerjs-server](https://github.com/peers/peerjs-server) under the MIT license carried beside it, kept as upstream wrote it apart from this project's own hardening, so review history stays traceable. It is excluded from linting for that reason; everything else in this workspace is first-party.

The package ships TypeScript source and has no build step of its own, though it reads `@psilink/core` from that workspace's `dist/`, so build core (`npm run build -w packages/core`) before running it. The web app consumes it as a workspace dependency and bundles it into the server it deploys; the CLI's signaling test harness spawns the standalone entry point below.

## Running it standalone

```sh
npm start -w packages/peerjs-broker
```

It listens on an ephemeral loopback port and prints `psilink-broker <port>` once ready. `--path <mount>` and `--key <api-key>` override the mount path and the accepted API key.

## Diagnostics

Every socket the broker releases without going on to serve it -- an upgrade no co-resident listener answered, an error caught while the socket was still nobody's, a client socket that faulted, a frame that did not parse -- is written to the shared diagnostic logger at `warn`, naming the path that raised it. An operator can therefore tell a broker refusing what is dialed at it from one nobody is dialing.

The channel carries peer-controlled text (a parse failure quotes the bytes it choked on), so the sink escapes what it writes and caps its own volume; the escaping and the rate limit are specified in [docs/spec/CHANNEL_SECURITY.md](../../docs/spec/CHANNEL_SECURITY.md). Routing and verbosity are core's: an embedding host installs a `DiagnosticSink` or sets the log level, and left alone the output takes loglevel's own console routing.
