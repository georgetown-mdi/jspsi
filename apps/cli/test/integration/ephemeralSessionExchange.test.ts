import { test } from "vitest";

// PENDING end-to-end proof for connection-per-poll (ephemeral-session) SFTP mode.
//
// The mode is unit-tested at the adapter boundary (releaseForIdle/ensureConnected,
// the non-terminal release, transient-vs-fatal dial handling) and at the core poll
// loop and close()/drain seam. What it CANNOT yet be proved against is a real
// server that forces the very failure it exists for: a max-session/idle cap that
// drops a held session mid-exchange. Proving that needs a capability the
// integration SFTP server does not have -- force a session drop after N ops or N
// seconds, and enforce a max-session/idle cap that drops after a bound -- which is
// being built in parallel as a separate test-infrastructure item.
//
// It is deliberately NOT stubbed with a fake server: a fake would not exercise the
// real ssh2 re-dial handshake, the pinned-host-key re-verification, the retained
// credentials, or the drain-across-reconnect teardown this is meant to prove.
//
// Once the drop/cap harness lands, this asserts:
//   - a full exchange completes across repeated cap-forced drops with a fresh
//     session per poll cycle, where a single held session would thrash a reconnect
//     every cycle;
//   - later cycles re-dial with no host-key re-prompt and no credential re-prompt
//     (the pinned fingerprint and stored credentials are reused);
//   - a failed dial in one cycle is retried on the next tick rather than aborting
//     the exchange, while a genuinely fatal condition still terminates;
//   - close() still writes the authenticated abort marker and drains the terminal
//     frame when the prior cycle's connection was already released, and a waiting
//     peer still fast-fails on the marker (see docs/spec/CHANNEL_SECURITY.md).
test.skip(
  "connection-per-poll SFTP survives a server-forced max-session drop " +
    "(awaits the integration server's force-drop / max-session-cap capability)",
  () => {
    // Intentionally unimplemented: awaits the parallel test-infrastructure work
    // that adds a force-drop / max-session-cap capability to the integration SFTP
    // server. See docs/notes/connection-per-poll-sftp.md ("Test harness").
  },
);
