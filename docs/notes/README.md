# Design notes

Tracked, citeable design records: the model behind a mechanism, the options
weighed, and the decisions taken. Nothing here is normative -- a note binds no
implementation, and points at the spec for the normative rows rather than
restating them. A note carries a status line stating where its subject stands,
from a direction still open to a decision taken and built.

## Index

| Note | Status |
| ---- | ------ |
| [app-shell-service-worker.md](app-shell-service-worker.md) | Decided and built. |
| [bound-transformed-value.md](bound-transformed-value.md) | Decided and built, by a 3-panelist design panel. |
| [cascade-fan-out.md](cascade-fan-out.md) | Directed; a spec item precedes the realization. |
| [cli-webrtc-stack.md](cli-webrtc-stack.md) | Decided and built. |
| [connection-per-poll-sftp.md](connection-per-poll-sftp.md) | Shipped. |
| [console-announce-and-focus.md](console-announce-and-focus.md) | Decided and built, by a 3-panelist design panel deciding 2-1. |
| [core-dist-cache-buildinfo.md](core-dist-cache-buildinfo.md) | Decided and built. |
| [cosign-keyless-signing.md](cosign-keyless-signing.md) | Decided and built. |
| [cross-workspace-test-material.md](cross-workspace-test-material.md) | Decided and built. |
| [deduplicate-matching-semantics.md](deduplicate-matching-semantics.md) | Specified, and run end to end: the one-sided cardinalities under both linkage strategies, the both-sided one under `cascade`. |
| [default-linkage-rule-set.md](default-linkage-rule-set.md) | Decided and built. |
| [fan-out-matching-resolution.md](fan-out-matching-resolution.md) | Built under `single-pass`; the cascade realization stays open work. |
| [fips-provider-surface.md](fips-provider-surface.md) | Measurement, plus two decisions taken on it; whether to pursue a FIPS claim at all remains open. |
| [fips-variant-image.md](fips-variant-image.md) | Decided, built, and published. |
| [key-establishment-fips-boundary.md](key-establishment-fips-boundary.md) | Decided and implemented. |
| [linkage-rule-grounding.md](linkage-rule-grounding.md) | Proposal, pending adoption -- nothing here is adopted or shipped. |
| [lockless-rendezvous-barrier.md](lockless-rendezvous-barrier.md) | Weighed and set aside; the shipped symmetric barrier stands. |
| [one-sided-disclosure.md](one-sided-disclosure.md) | Resolved - shipped as the opt-in `single-pass` linkage strategy (the cascade stays the default). |
| [one-sided-fuzzy-expansion.md](one-sided-fuzzy-expansion.md) | Decided and built, behind the flag the fuzzy expansion itself sits behind. |
| [operator-message-control-characters.md](operator-message-control-characters.md) | Decided and built. |
| [prebuild-provenance.md](prebuild-provenance.md) | Decided, built, and armed against a fork that attests. |
| [psi-c-count-only.md](psi-c-count-only.md) | Decided and built. |
| [receipt-run-binding.md](receipt-run-binding.md) | Resolved - built. |
| [receipt-signing-fips-boundary.md](receipt-signing-fips-boundary.md) | Decided. |
| [record-durability-point.md](record-durability-point.md) | Resolved - built. |
| [rule-set-citation-verdict.md](rule-set-citation-verdict.md) | Resolved - built. |
| [sftp-adapter-state-machine.md](sftp-adapter-state-machine.md) | Shipped. |
| [shared-consent-summary.md](shared-consent-summary.md) | Shipped. |
| [signing-identity-custody.md](signing-identity-custody.md) | Decided and built, by a 3-panelist design panel converging 3-0. |
| [web-server-runtime-role.md](web-server-runtime-role.md) | Direction recorded; no removal scheduled. |
| [webrtc-relay-deployment.md](webrtc-relay-deployment.md) | Measured, with a recommendation and a proposed epic; nothing here is ratified, scheduled, or built. |

Each note carries the full status statement at its own top; this table is a pointer, not a restatement.

The maturity ladder:

- `scratch/` (gitignored) - personal, throwaway thinking, no audience.
- `docs/notes/` (here) - tracked, citeable design records; non-normative.
- `docs/` proper - the formal, living documentation, in two tiers:
  - `docs/` (overview) - conceptual and operational documents for program
    officers, security reviewers, compliance officers, IT staff, and new
    contributors.
  - `docs/spec/` - the technical specification tier: wire formats, byte
    encodings, protocol internals, and implementation-level design, written for
    implementors and auditors. See [`docs/spec/README.md`](../spec/README.md)
    for the index and routing guide.

Naming: notes use lowercase-kebab filenames to distinguish them at a glance from
the SCREAMING_CASE formal specs in `docs/` and `docs/spec/`.
