# @psilink/peerjs-broker

The PeerJS-compatible WebSocket signaling broker two parties rendezvous through before their WebRTC data channel opens. It brokers only rendezvous-setup messages: no exchange payload crosses it, and the parties authenticate each other directly (see [docs/SECURITY_DESIGN.md](../../docs/SECURITY_DESIGN.md#channel-security)). Its upgrade-surface bounds -- inbound frame size, handshake parameter lengths, timeouts, the liveness reaper, and the relay queue caps -- are specified in [docs/spec/CHANNEL_SECURITY.md](../../docs/spec/CHANNEL_SECURITY.md).

`src/contrib/` is vendored from [peerjs-server](https://github.com/peers/peerjs-server) under the MIT license carried beside it, kept in upstream's file layout so review history stays traceable rather than kept as upstream wrote it: about a third of the directory's lines are this project's own hardening, concentrated in `services/webSocketServer/index.ts`, `models/realm.ts`, and `models/messageQueue.ts`. The files this project has not edited since the vendoring -- upstream's message routing, `messageHandler/` and `models/message.ts` -- are excluded from linting for that traceability; the rest of the directory is linted, as is the first-party remainder of this workspace.

The package ships TypeScript source and has no build step of its own, though it reads `@psilink/core/untrusted-text` from that workspace's `dist/`, so build core (`npm run build -w packages/core`) before running it. That subpath, rather than the package root, is the whole of its reach into core: this is a network-facing process, so the packages it can reach at run time are the packages an advisory can force a redeploy over. `scripts/broker-core-reach.test.mjs` holds both halves of that -- the source imports and the built subpath's own closure -- and [docs/notes/broker-runtime-closure.md](../../docs/notes/broker-runtime-closure.md) records why. The web app consumes the package as a workspace dependency and bundles it into the server it deploys; the CLI's signaling test harness spawns the standalone entry point below.

## Running it standalone

```sh
npm start -w packages/peerjs-broker
```

It listens on an ephemeral loopback port and prints `psilink-broker <port>` once ready. `--path <mount>` and `--key <api-key>` override the mount path and the accepted API key.

## Diagnostics

Every socket the broker releases without going on to serve it -- an upgrade no co-resident listener answered, an error caught while the socket was still nobody's, a client socket that faulted, a frame that did not parse, a fault raised dispatching one that did -- is written to the caller's diagnostic sink, naming the path that raised it, up to the volume the rate limit below admits. Past that the rest of the window is shed under a notice marking where the shedding started; the full count and which paths lost reports ride a second notice, written only once a later diagnostic arrives, so an operator can still tell a broker refusing what is dialed at it from one nobody is dialing.

The channel carries peer-controlled text (a parse failure quotes the bytes it choked on), so the sink escapes what it writes and caps its own volume; the escaping and the rate limit are specified in [docs/spec/CHANNEL_SECURITY.md](../../docs/spec/CHANNEL_SECURITY.md).

Where the lines go is the caller's: `CreatePeerServerWSOnly` takes a `SignalingDiagnosticSink` -- one function, taking one line of already-escaped text -- as a required argument ahead of its options, so no embedding builds a broker without saying where its reports go. The standalone runner writes to stderr, leaving stdout for its ready line; the web app's mount writes through a prefixed `@psilink/core` logger, where routing and verbosity are core's.
