// Internal constants for fileSyncConnection. This module is deliberately NOT
// re-exported by the package barrel (main.ts barrels fileSyncConnection.ts via
// `export *`, but not this file), so an `@internal` export here can be read by
// the unit test through a deep import without entering the package's public
// runtime surface. Mirrors the utils/crypto bytesEqual pattern. Do not fold
// these back into fileSyncConnection.ts: that file IS barrelled, so any export
// there leaks into the published API.

// Bounded retry budget for the lock-joiner fast-path mismatch advertisement --
// the single mismatch site that must write a NEW hello at detection time so the
// lockless peer reads it and fast-fails symmetrically (the lockless ack-barrier
// and lock two-hellos mismatch branches wrote their hello BEFORE their loop, so
// they have no write at throw time and are unaffected). A transient put failure
// there would otherwise leave no durable advertisement, degrading the peer to
// the legacy peer-timeout (exit 69) instead of a fast-fail (exit 64). Five
// attempts at this.options.pollingFrequency -- four inter-attempt delays, ~400 ms
// at the 100 ms default -- is small and stays far under peerTimeoutMs (default 1
// hour): the peer polls concurrently, so the advertisement only has to land
// before the peer would otherwise time out, not on the first try. Internal-only
// constant (not a user-facing config option): this hardens 193901017's
// documented best-effort floor and changes no detection behavior. See the use
// site in synchronize()'s joiner fast-path.
/** @internal */
export const ADVERTISE_HELLO_RETRY_ATTEMPTS = 5;
