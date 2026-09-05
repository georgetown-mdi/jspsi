import { expect, test } from "vitest";

import {
  probeDiagnosisJsonLine,
  probeHostKeyLines,
} from "../../../src/commands/probeHostKey";
import { peerIdentificationDiagnosisOf } from "../../../src/connection/sftpPeerIdentification";
import { establishHostKeyTrust } from "../../../src/hostKeyTrust";
import {
  countingPeer,
  diagnosisCount,
  displayLinks,
  expectNonSshAnswerDiagnosis,
  HTTP_ERROR_PAGE,
} from "../peerIdentification";

// The non-SSH-answer diagnosis on the two host-key probe entry points --
// `probe-host-key` and the first-use trust prompt -- driven against a peer
// that answers with a proxy's error page. Both dial a peer of their own
// rather than the test SFTP server, so no SFTP backend has any bearing on
// them and they run once per pull request. The dial paths that reach a real
// server, and the control cases, are in ../dialPeerIdentification.test.ts.
//
// These cases COUNT what the endpoint saw, because the diagnosis is a TCP
// connection of its own: the adapter is the only layer that runs it, so a
// diagnosed probe opens exactly one connection that sends nothing and the
// operator is told once. A second diagnosis wrapped around a probe caller
// would read the peer twice over -- invisible in the rendered copy (the gate
// walks the cause chain to the same host-key message) but plain in the count.
//
// The peer is a real listener rather than a stub because what is asserted is
// what arrives on a socket.

const TEST_TIMEOUT_MS = 120_000;

test(
  "probe-host-key names what answered the port, reading it once",
  async () => {
    // The command's own path, deps and all: it builds the probe connection from
    // the URL and dials it through the adapter, which is where the diagnosis
    // lives. Core keeps the diagnosed rejection under its host-key message, so
    // the operator reads what answered on the line the command fails with.
    const peer = await countingPeer((socket) => socket.end(HTTP_ERROR_PAGE));
    try {
      const raised = await probeHostKeyLines({
        sftpUrl: `sftp://${peer.host}:${peer.port}`,
        connectTimeoutSeconds: 10,
        json: true,
        verbosity: -1,
      }).then(
        () => undefined,
        (err: unknown) => err,
      );
      const links = displayLinks(raised);
      expect(links[0]).toContain("could not read the server's host key");
      expectNonSshAnswerDiagnosis(links, peer);
      // One diagnosis, and one connection holding no bytes at all: the peer
      // was read once, whatever the dial itself spent on retries.
      expect(diagnosisCount(links)).toBe(1);
      expect(peer.accepted().silent).toBe(1);
    } finally {
      await peer.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "the first-use trust prompt names what answered the port, reading it once",
  async () => {
    // The other probe entry point: the interactive first-use flow, which probes
    // before it prompts. The prompt is never reached -- the probe fails -- so the
    // TTY gate is all this needs of a terminal.
    const peer = await countingPeer((socket) => socket.end(HTTP_ERROR_PAGE));
    const wasTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    try {
      const raised = await establishHostKeyTrust(
        {
          channel: "sftp",
          server: { host: peer.host, port: peer.port, username: "unused" },
        },
        {
          verbosity: -1,
          loggerName: "host-key-probe-peer-identification",
          persistence: { mode: "ephemeral" },
        },
      ).then(
        () => undefined,
        (err: unknown) => err,
      );
      const links = displayLinks(raised);
      expectNonSshAnswerDiagnosis(links, peer);
      expect(diagnosisCount(links)).toBe(1);
      expect(peer.accepted().silent).toBe(1);
    } finally {
      process.stdin.isTTY = wasTTY;
      await peer.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

// The bytes the `--json` machine route puts on a caller's stdout, read off a
// real socket rather than handed to the composer: the peer writes DEL, a C1
// control, and a PEM private-key marker, and the assertion is on the line the
// handler would print. The handler's two emission steps -- read the diagnosis,
// compose the line -- are re-implemented here rather than invoked through the
// handler itself, so this drives the wire-to-diagnosis path, not its own gate
// on whether to print at all.
test(
  "the --json diagnosis line prints as ASCII whatever the peer answered with",
  async () => {
    const answer = Buffer.concat([
      Buffer.from("GET / HTTP/1.0\r\nX-Trap: "),
      Buffer.from([0x7f, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x9b]),
      Buffer.from("\r\n-----BEGIN RSA PRIVATE KEY-----\r\nMIIEowIBAAKC\r\n"),
    ]);
    const peer = await countingPeer((socket) => socket.end(answer));
    try {
      const raised = await probeHostKeyLines({
        sftpUrl: `sftp://${peer.host}:${peer.port}`,
        connectTimeoutSeconds: 10,
        json: true,
        verbosity: -1,
      }).then(
        () => undefined,
        (err: unknown) => err,
      );
      const diagnosis = peerIdentificationDiagnosisOf(raised);
      expect(diagnosis?.kind).toBe("non-ssh");
      const line = probeDiagnosisJsonLine(diagnosis!);

      // Safe to print as it stands.
      expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
      expect(line).toContain("\\u007f");
      expect(line).toContain("\\u009b");
      // Still one line of JSON with the keys and value types it has always had.
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(parsed)).toEqual(["diagnosis", "shape", "excerpt"]);
      expect(parsed["diagnosis"]).toBe("non_ssh");
      // The key marker the peer planted is redacted, as it is on the human
      // route the same run rendered.
      expect(parsed["excerpt"]).toContain("[redacted private key]");
      expect(line).not.toContain("MIIEowIBAAKC");
      expect(displayLinks(raised).join("")).not.toContain("MIIEowIBAAKC");
    } finally {
      await peer.stop();
    }
  },
  TEST_TIMEOUT_MS,
);
