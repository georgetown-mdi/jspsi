---
title: "Narrowing the signaling broker's runtime closure"
---

# Narrowing the signaling broker's runtime closure

_Status: decided and built. The broker reads `@psilink/core/untrusted-text`
rather than the package root, and takes the sink its diagnostics are written to
from whoever builds it. This note records what the wide closure cost, why the
logger did not ride the subpath with the escaping helpers, and what holds the
narrowing in place. See [docs/notes/README.md](README.md)._

This is design rationale. The escaping, capping and rate-limiting the sink
applies are specified in
[docs/spec/CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md), and this note does
not restate them.

## What the wide closure cost

`packages/peerjs-broker` is the one process here that listens on the internet
with no application around it: the standalone runner is a broker and nothing
else. Its runtime closure was `ws` alone until it took a `@psilink/core`
dependency for the display and redaction helpers its diagnostics write through.

The package root reaches everything core declares, so the broker's closure
became core's: the schema validator, the regex engine, the CSV and YAML parsers,
the date library, the id generator, the event emitter and the PSI bindings. None
of that is an exploitable path -- the broker calls none of it -- and that is the
point. A closure is the set of packages an advisory can force a redeploy of a
network-facing service over, and whether the advisory is reachable through the
service does not enter into it.

## The subpath

`@psilink/core/untrusted-text` is a third published entry point beside `.` and
`./testing`, holding the two chokepoints the broker calls: escaping untrusted
text for an operator, and parsing untrusted JSON under structural bounds. The
mechanism has precedent in `./testing`, so it is a third entry rather than a new
pattern.

Two properties make it worth having rather than a cosmetic rename.

- The entry is only as narrow as its module graph. Re-exporting from a barrel
  that imports the schema validator would buy nothing, so what is held is the
  BUILT graph rather than the import list: `scripts/broker-core-reach.test.mjs`
  walks the emitted chunks of both published conditions and fails when either
  reaches a package at all. Its canary walks the package root the same way and
  fails if that one comes back empty.
- The entry points build together, with code splitting, so a module more than
  one of them reaches exists once at run time. Built separately, a consumer
  taking both entries would hold two copies of `JsonStructureBoundError` and an
  `instanceof` across them would be false.

## Why the logger stayed behind

The obvious third passenger was the logger the diagnostics are written through,
and it is not on the subpath. The broker takes an injected sink instead: a
function that writes one already-escaped line, handed in by whoever builds the
server.

What decided it is where the broker is going rather than what the subpath would
have cost. Its trajectory is a provisioned service whose production embedding is
the standalone runner shipped in this package, so the on-by-default writing
moves into that runner without being lost, and the library itself becomes
logging-agnostic -- the boundary a provisioned deployment and any first-party
rewrite of the vendored server both want. The closure narrows further as a side
effect: `loglevel` is not in it either.

The property this could have cost is the one the diagnostics were built for. An
unattended broker is exactly the case the reports exist for, so an opt-in nobody
sets would not be a remedy for it. Two things hold it now that the policy is the
caller's:

- The sink is a required argument of the single builder every embedding goes
  through, not an option with a default. A wiring that supplies none does not
  typecheck.
- Both shipped wirings pass one with no flag in front of it -- the web app's
  mount a prefixed core logger, the standalone runner a stderr writer -- and the
  CLI's WebRTC integration suite spawns the runner with no configuration at all,
  drives a real parse failure at it, and reads the attributed line off stderr.

## What is still open

- The subpath's surface is what the broker calls and nothing more. A second
  consumer wanting a helper from it is the event that decides whether the entry
  is "what the broker uses" or "the untrusted-input chokepoints" as a published
  surface of its own.
- The vendored server subset still reaches `ws`, which is a runtime dependency
  rather than a helper, and no narrowing here touches it.
