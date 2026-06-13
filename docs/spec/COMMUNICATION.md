---
title: "Communication Transport Contract"
---

# Communication transport contract

This document is the transport-contract complement to the
[Communication](../COMMUNICATION.md) overview. It specifies the
implementation-level classification decisions behind the core library's terminal
`ConnectionErrorKind` taxonomy -- the deferred-decision rationale for how a
clean remote close and a non-attributable local runtime fault are tagged, and
the conditions under which each would be revisited. `ConnectionErrorKind` is a
transport-contract concern spanning every channel (SFTP, file-drop, WebRTC) and
is part of the core library's public API, which is why these decisions live in
the spec tier rather than in the overview.

It does not cover the channels, synchronization, message-delivery contract, or
supporting services (see [COMMUNICATION.md](../COMMUNICATION.md)), the
channel-security construction (see [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md)),
the file-sync state machine and its `UsageError` -> exit-code mapping (see
[FILE_SYNC.md](FILE_SYNC.md)), or the PSI and key-exchange protocol (see
[PROTOCOL.md](PROTOCOL.md)). Intended readers are developers extending the core
library's transport layer.

# ConnectionErrorKind classification

Terminal failures are tagged with a `ConnectionErrorKind` (the kinds and their meanings are documented on that type in the core library) so a consumer can branch on the cause. Two classification choices are worth recording, each a deferred decision with the condition that would reopen it.

## Clean remote close versus local close

A deliberate *local* close - a signal-driven `MessageConnection.close()` - cancels any parked operation with kind `"closed"`, signaling that nothing went wrong on this side. A clean *remote* close instead surfaces as `"transport"`: WebRTC tags its `close` event `"transport"` in `apps/web/src/psi/peerMessageConnection.ts`, the same kind a dropped link or peer timeout carries. These are deliberately kept distinct rather than unified under `"closed"`. A local `close()` is an intent this side knows; a remote channel-close event is not - an orderly peer shutdown and a killed peer process close the channel identically - so the local side cannot honestly report "nothing went wrong" about the other end, and `"transport"` ("the link ended; a retry is reasonable") is the safe reading. This is not only a label: `packages/core/src/kex.ts` relies on a `"transport"` error from the handshake receive to report a vanished peer as a handshake timeout. This would only need revisiting if a consumer arises that must act on a clean peer close - one that has to tell a peer ending the session apart from a link that dropped. The resolution then is to give the clean-close path its own `ConnectionErrorKind` (for example `"peer-closed"`), rather than reusing `"closed"` (which would conflate a peer's close with a deliberate local one) or leaving it as `"transport"` (which conflates it with an abnormal drop). The change would be small and contained: the WebRTC transport already routes a clean close through `finish()` and an abnormal drop through `fail()` (`apps/web/src/psi/peerMessageConnection.ts`), so only the kind stamped on the clean-close path would change - the mechanism that separates the two cases already exists.

## Non-attributable local runtime faults

A failure to encrypt our *own* outbound data - or any comparable local crypto/runtime fault, such as resource exhaustion or a crypto-subsystem error - is tagged `"transport"`, not `"security"` and not `"usage"`. It is not tampering (nothing the peer did caused it) and it is not caller misuse (no API was used incorrectly); like a dropped link it is not the caller's fault and a retry is reasonable, which is exactly `"transport"`'s contract. A dedicated kind for non-attributable runtime faults (for example `"system"`) was considered and deferred: today it would have a single call site (the AEAD send path's `crypto.subtle.encrypt` catch in `packages/core/src/connection/encryptedMessageConnection.ts`) and no consumer reaction distinct from `"transport"`, and `ConnectionErrorKind` is part of the core library's public API, so a new value is not free. This would only need revisiting if a consumer arises that must report an internal runtime fault differently from a link failure - for example a kind-to-exit-code table that maps `"security"` to a distinct tampering code. The resolution then is to add the `"system"` kind in the same change that adds that consumer, rather than reusing `"transport"` (which conflates it with a link drop) or `"usage"` (which would misreport it as a configuration error).

# See also

- [COMMUNICATION.md](../COMMUNICATION.md) - the channels, synchronization, message-delivery contract, error-handling overview, and supporting services this document complements
- [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md) - the application-layer AEAD and the transport memory/liveness bounds, whose terminal errors use this taxonomy
- [FILE_SYNC.md](FILE_SYNC.md) - the file-sync transport state machine and its `UsageError` -> exit-code mapping
