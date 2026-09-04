---
title: "The Web Server's Runtime Role"
---

# The web server's runtime role, and how much framework it needs

_Status: direction recorded; no removal scheduled. The public web app's exchange
runs in the browser, so the server's runtime role there is delivering code and
hosting the peer-coordination broker. The console profile of the same app is the
standing exception -- its server drives the CLI -- and is recorded here beside
it. This note records the standing constraint that follows and the end state it
points at; it schedules no work and binds no implementation. The app's own
runtime description is in [DESIGN.md](../DESIGN.md#web-application). See
[docs/notes/README.md](README.md)._

## What the server still does at runtime

In the public deployment, a web exchange is conducted entirely between the two
browsers. Files are read, the linkage keys derived, the authenticated key
exchange run, and the PSI frames sent peer to peer over WebRTC; nothing leaves
the machine except that exchange's own traffic. The server delivers the code
that does it.

The one runtime service it provides is the peer-coordination (PeerJS) broker
mounted under `/api/`, which introduces the two browsers to each other and sees
no exchange content -- the rendezvous ids derive from the invitation secret, and
the data channel is confidential against it under DTLS
([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security)).

## The console profile, where the server does run an exchange

The same application also builds as the console -- one party's own machine,
one operator, one exchange at a time -- and there the server's runtime role is a
larger one: it drives that party's `psilink` CLI as a subprocess. The job
API is what does it (`apps/web/src/routes/api/jobs/`, specified in
[SERVER_JOB_API.md](../spec/SERVER_JOB_API.md)). A create request composes the
CLI's inputs from a typed intent, the server spawns the run, owns a workdir on
disk, relays the CLI's event stream to the page, and serves the result, the
exchange record and keys, a receipt, and the recurring-run hand-off back from
that workdir. That is file handling, subprocess supervision, and on-disk state
-- none of which the public deployment's server does.

Which channel goes there is the profile's decision rather than the API's. On a
console build a filedrop or SFTP exchange runs as a server job, while a WebRTC
exchange still runs in the tab exactly as it does on the hosted build
(`apps/web/src/bench/exchangeDriverSelection.ts`). The console does not move the
browser-to-browser exchange onto the server; it adds the channels a browser
cannot open a socket for.

The two profiles do not blur. The job API is dark unless the build is a console
build (`VITE_DEPLOYMENT_PROFILE=console`) and a data root is configured, and a
hosted build answers every job route `404` whatever the data root says
(`apps/web/src/jobs/gate.ts`), so the public deployment cannot serve the
server-side driver at all. The single-operator trust boundary the API's design
rests on is the console's alone
([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#single-party-appliance-trust-boundary)).

## Why the framework's server half is not required

TanStack entered `apps/web` as a full-stack solution, on the expectation that
the server would take part in coordinating an exchange. It does not: the
protocol is peer to peer, and the coordination that remains is the broker's.

The broker is not the framework's either. It is a workspace of its own,
`packages/peerjs-broker`, with an entry point that runs it as a standalone
service with no web app around it -- the CLI's signaling tests spawn exactly
that ([TESTING.md](../TESTING.md)) -- and the web app imports that workspace
(`apps/web/src/peerServer.ts`) rather than implementing signaling. That isolation
boundary is the critical one in this picture; the framework's server half
sits above it, delivering an app shell that anything able to serve static assets
and one WebSocket mount could deliver.

The client half is a different question and is not settled here. The router,
form, and query libraries are client libraries a code-delivering server still
serves, and the router's build-time codegen is a real coupling of the app's own
route layer ([apps/web/README.md](../../apps/web/README.md#generated-route-tree)).
Whether the direction below reaches them has not been decided.

## The standing constraint

New server-side work in `apps/web` does not deepen framework-specific coupling
where a framework-neutral shape costs the same. That is a tie-breaker, not a
prohibition: it asks for no abstraction layer, no migration, and no work bought
solely to keep the option open. Where a server-side capability needs the
framework, it uses it.

The job API is what that constraint has bound so far, and it holds there without
having cost anything. Its machinery is a set of plain modules under
`apps/web/src/jobs/` that import nothing from the framework -- the job manager,
the CLI driver, the gate, the workdir and the event relay -- and the files under
`apps/web/src/routes/api/jobs/` are the adapters that mount them on the
framework's route mechanism. The console's server half therefore rests on the
framework only where it is served from.

## The end state this points at

The public deployment's exchange runs in the browser; its server delivers code
and hosts the broker. Provisioning that broker on demand for an exchange, rather
than hosting it alongside the app, would remove the last server-side runtime
need there and leave a server whose whole job is delivery. That end state is the
public deployment's only: the console's server runs the CLI whatever becomes of
the broker, so the same codebase keeps a build whose server has a real runtime
job. That provisioning is separate work with its own design; this note records
only where it leads, and neither it nor a removal is scheduled by anything
here.

## A second-order consequence

The `crossws` peer conflict that blocks the release SBOM originates entirely in
the framework's server stack -- `@tanstack/start-server-core` ->
`h3-v2` -> `crossws`, against `nitropack` and `h3@1.x` on the 0.3 line -- and
goes with it. The mechanism, why the obvious local fixes are wrong, and the
upstream path that clears it are in
[DEPENDENCY_PINS.md](../spec/DEPENDENCY_PINS.md#the-crossws-peer-conflict-blocks-the-release-sbom).
It is a further reason the per-invocation `--legacy-peer-deps` on that release
step is the right weight of response, rather than machinery built around one
dependency edge.
