# @psilink/peerjs-broker

The PeerJS-compatible WebSocket signaling broker two parties rendezvous through before their WebRTC data channel opens. It brokers only rendezvous-setup messages: no exchange payload crosses it, and the parties authenticate each other directly (see [docs/SECURITY_DESIGN.md](../../docs/SECURITY_DESIGN.md#channel-security)). Its upgrade-surface bounds -- inbound frame size, handshake parameter lengths, timeouts, the liveness reaper, and the relay queue caps -- are specified in [docs/spec/CHANNEL_SECURITY.md](../../docs/spec/CHANNEL_SECURITY.md).

`src/contrib/` is vendored from [peerjs-server](https://github.com/peers/peerjs-server) under the MIT license carried beside it, kept in upstream's file layout so review history stays traceable rather than kept as upstream wrote it: about a third of the directory's lines are this project's own hardening, concentrated in `services/webSocketServer/index.ts`, `models/realm.ts`, and `models/messageQueue.ts`. The files this project has not edited since the vendoring -- upstream's message routing, `messageHandler/` and `models/message.ts` -- are excluded from linting for that traceability; the rest of the directory is linted, as is the first-party remainder of this workspace.

The package ships TypeScript source and has no build step of its own, though it reads `@psilink/core/untrusted-text` from that workspace's `dist/`, so build core (`npm run build -w packages/core`) before running it. That subpath, rather than the package root, is the whole of its reach into core: this is a network-facing process, so the packages it can reach at run time are the packages an advisory can force a redeploy over. `scripts/broker-core-reach.test.mjs` holds both halves of that -- the source imports and the built subpath's own closure -- and [docs/notes/broker-runtime-closure.md](../../docs/notes/broker-runtime-closure.md) records why. The web app consumes the package as a workspace dependency and bundles it into the server it deploys; the CLI's signaling test harness spawns the standalone entry point below.

## Running it standalone

```sh
npm start -w packages/peerjs-broker
npm start -w packages/peerjs-broker -- --host 0.0.0.0 --port 9000
```

By default it listens on `127.0.0.1` on an ephemeral port, mounts the signaling server at `/api`, and accepts the PeerJS protocol's well-known `peerjs` realm key. It prints one line, `psilink-broker <port>`, on stdout once it is listening, then stays up until it is signalled; nothing else reaches stdout, so a parent process reads the port with a single match. That line reports the port alone -- the address is the operator's own instruction, while an ephemeral port is not known until the bind returns.

| Setting      | Flag               | Environment           | Default         |
| ------------ | ------------------ | --------------------- | --------------- |
| Bind address | `--host <address>` | `PSILINK_BROKER_HOST` | `127.0.0.1`     |
| Port         | `--port <number>`  | `PSILINK_BROKER_PORT` | `0` (ephemeral) |
| Mount path   | `--path <mount>`   | --                    | `/api`          |
| Realm key    | `--key <api-key>`  | --                    | `peerjs`        |

A flag takes precedence over the environment variable beside it, and an environment variable set to an empty value counts as unset. A port that is not a whole number from 0 to 65535, a blank value, a repeated flag, a flag with no value, a mount that does not begin with `/`, and any unrecognized argument are each refused before the broker starts, with a message naming the flag or the variable the value came from; the process exits 64, the same usage exit the CLI uses. A bind the operating system refuses -- an address that is not this host's, a port already taken -- is reported the same way and exits 69, as is a later fault on the listening socket.

The runner bounds the window before it has a request in hand: a 10-second header timeout, a 15-second request timeout, and a 10-second idle bound on a socket that has not begun -- or has stopped part-way through -- its request. A peer that connects and sends nothing, or dribbles its headers, is closed rather than held; an established WebSocket is outside all three, governed by the liveness reaper instead. The values are the ones [docs/spec/CHANNEL_SECURITY.md](../../docs/spec/CHANNEL_SECURITY.md) states for the signaling upgrade surface, held in `src/standaloneUpgradeBounds.ts`. The runner terminates no TLS, so a deployment reachable off the host still puts it behind a front that does.

## Readiness

The runner answers `GET` and `HEAD` on `<mount>/health` -- `/api/health` under the default mount -- with `200` and the body `ready`. It sits under the mount rather than at the root so one route rule in front of the broker covers the probe and the signaling endpoint together. Any other request, including another method on that path, is refused with `404`: the broker handles WebSocket upgrades and this one endpoint, and nothing else is part of any wire it serves.

The handler is installed and the signaling server mounted before the runner listens, so an answer means this process is accepting connections with its upgrade route attached. That is the whole of what the answer states: the body is a fixed line, since reporting registered peers or queued frames would put rendezvous metadata on an unauthenticated endpoint. What the probe does disclose -- that a broker is running here -- anyone who can reach the port already learns by opening a WebSocket, so it needs no gate of its own.

## Diagnostics

Every socket the broker releases without going on to serve it -- an upgrade no co-resident listener answered, an error caught while the socket was still nobody's, a client socket that faulted, a frame that did not parse, a fault raised dispatching one that did -- is written to the caller's diagnostic sink, naming the path that raised it, up to the volume the rate limit below admits. Past that the rest of the window is shed under a notice marking where the shedding started; the full count and which paths lost reports ride a second notice, written only once a later diagnostic arrives, so an operator can still tell a broker refusing what is dialed at it from one nobody is dialing.

The channel carries peer-controlled text (a parse failure quotes the bytes it choked on), so the sink escapes what it writes and caps its own volume; the escaping and the rate limit are specified in [docs/spec/CHANNEL_SECURITY.md](../../docs/spec/CHANNEL_SECURITY.md).

Where the lines go is the caller's: `CreatePeerServerWSOnly` takes a `SignalingDiagnosticSink` -- one function, taking one line of already-escaped text -- as a required argument ahead of its options, so no embedding builds a broker without saying where its reports go. The standalone runner writes to stderr, leaving stdout for its ready line; the web app's mount writes through a prefixed `@psilink/core` logger, where routing and verbosity are core's.
