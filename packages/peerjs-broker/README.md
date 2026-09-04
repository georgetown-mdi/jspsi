# @psilink/peerjs-broker

The PeerJS-compatible WebSocket signaling broker two parties rendezvous through before their WebRTC data channel opens. It brokers only rendezvous-setup messages: no exchange payload crosses it, and the parties authenticate each other directly (see [docs/SECURITY_DESIGN.md](../../docs/SECURITY_DESIGN.md#channel-security)). Its upgrade-surface bounds -- inbound frame size, handshake parameter lengths, timeouts, the liveness reaper, and the relay queue caps -- are specified in [docs/spec/CHANNEL_SECURITY.md](../../docs/spec/CHANNEL_SECURITY.md).

`src/contrib/` is vendored from [peerjs-server](https://github.com/peers/peerjs-server) under the MIT license carried beside it, kept in upstream's file layout so review history stays traceable rather than kept as upstream wrote it: about a third of the directory's lines are this project's own hardening, concentrated in `services/webSocketServer/index.ts`, `models/realm.ts`, and `models/messageQueue.ts`. The files this project has not edited since the vendoring -- upstream's message routing, `messageHandler/` and `models/message.ts` -- are excluded from linting for that traceability; the rest of the directory is linted, as is the first-party remainder of this workspace.

The package ships TypeScript source and has no build step of its own, though it reads `@psilink/core` from that workspace's `dist/`, so build core (`npm run build -w packages/core`) before running it. The web app consumes it as a workspace dependency and bundles it into the server it deploys; the CLI's signaling test harness spawns the standalone entry point below.

## Running it standalone

```sh
npm start -w packages/peerjs-broker
```

It listens on an ephemeral loopback port and prints `psilink-broker <port>` once ready. `--path <mount>` and `--key <api-key>` override the mount path and the accepted API key.

## Diagnostics

Every socket the broker releases without going on to serve it -- an upgrade no co-resident listener answered, an error caught while the socket was still nobody's, a client socket that faulted, a frame that did not parse, a fault raised dispatching one that did -- is written to the shared diagnostic logger at `warn`, naming the path that raised it, up to the volume the rate limit below admits. Past that the rest of the window is shed under a notice marking where the shedding started; the full count and which paths lost reports ride a second notice, written only once a later diagnostic arrives, so an operator can still tell a broker refusing what is dialed at it from one nobody is dialing.

The channel carries peer-controlled text (a parse failure quotes the bytes it choked on), so the sink escapes what it writes and caps its own volume; the escaping and the rate limit are specified in [docs/spec/CHANNEL_SECURITY.md](../../docs/spec/CHANNEL_SECURITY.md). Routing and verbosity are core's: an embedding host installs a `DiagnosticSink` or sets the log level, and left alone the output takes loglevel's own console routing.
