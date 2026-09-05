import net from "node:net";

import { afterEach, describe, expect, test } from "vitest";

import {
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  DEFAULT_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  redactPrivateKeyMaterial,
  sanitizeErrorForDisplay,
} from "@psilink/core";

import {
  PEER_ANSWER_READ_MAX_BYTES,
  PEER_EXCERPT_MAX_BYTES,
  diagnosePeerAnswer,
  explainPeerIdentificationFailure,
  isPreIdentificationDialFailure,
  observePeerAnswer,
  peerIdentificationDiagnosisOf,
  peerProbeTargetFromConnectOptions,
} from "../../../src/connection/sftpPeerIdentification";
import type { PeerAnswer } from "../../../src/connection/sftpPeerIdentification";

// The diagnosis of a dial that died before the peer identified itself as an SSH
// server. The five peers the acceptance case names are driven rather than
// stubbed, since what is asserted is what arrives on a real socket: an HTTP
// error page, a TLS alert record, an accept-then-clean-close, an
// accept-then-reset, and a valid SSH identification string. The real-server
// control is the integration suite's probe against the SFTP test server.

const listeners: net.Server[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    listeners
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

/** A listener that answers one connection the way `answer` says, on a port the
 * kernel picks. */
function peerAnswering(
  answer: (socket: net.Socket) => void,
): Promise<{ host: string; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      sockets.push(socket);
      // A reset peer's own socket errors on the write side; nothing here reads
      // it, and an unhandled 'error' would fail the file.
      socket.on("error", () => {});
      answer(socket);
    });
    listeners.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        host: "127.0.0.1",
        port:
          typeof address === "object" && address !== null ? address.port : 0,
      });
    });
  });
}

const HTTP_ERROR_PAGE =
  "HTTP/1.0 403 Forbidden\r\n" +
  "Content-Type: text/html\r\n" +
  "\r\n" +
  "<html><head><title>Tunnel or SSL Forbidden</title></head></html>\r\n";

/** A TLS record: content type 21 (alert), version 3.3, one fatal
 * handshake_failure alert. */
const TLS_ALERT_RECORD = Buffer.from([
  0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28,
]);

const BUDGET_MS = 2_000;

const rendered = (error: unknown): string => sanitizeErrorForDisplay(error);

describe("observePeerAnswer reads what answered the port", () => {
  test("names an HTTP response and includes its first bytes", async () => {
    const endpoint = await peerAnswering((socket) =>
      socket.end(HTTP_ERROR_PAGE),
    );
    const answer = await observePeerAnswer(endpoint, BUDGET_MS);
    expect(answer.kind).toBe("non-ssh");
    if (answer.kind !== "non-ssh") return;
    expect(answer.shape).toBe("http");
    expect(answer.excerpt).toContain("403 Forbidden");
    expect(answer.excerpt).toContain("Tunnel or SSL Forbidden");
  });

  test("names a TLS alert record", async () => {
    const endpoint = await peerAnswering((socket) =>
      socket.end(TLS_ALERT_RECORD),
    );
    const answer = await observePeerAnswer(endpoint, BUDGET_MS);
    expect(answer).toEqual({
      kind: "non-ssh",
      shape: "tls-alert",
      // latin1, so each byte the peer sent is one code point the display
      // boundary escapes back to the byte it was.
      excerpt: "\x15\x03\x03\x00\x02\x02\x28",
    });
  });

  test("reads an unrecognized answer as non-SSH without naming a shape", async () => {
    const endpoint = await peerAnswering((socket) =>
      socket.end("220 ftp.example.test FTP service ready\r\n"),
    );
    const answer = await observePeerAnswer(endpoint, BUDGET_MS);
    expect(answer.kind).toBe("non-ssh");
    if (answer.kind !== "non-ssh") return;
    expect(answer.shape).toBe("unrecognized");
  });

  test("distinguishes an accept-then-clean-close from a peer that sent bytes", async () => {
    const endpoint = await peerAnswering((socket) => socket.end());
    expect(await observePeerAnswer(endpoint, BUDGET_MS)).toEqual({
      kind: "closed-unanswered",
    });
  });

  test("reads an accept-then-reset as the same sent-nothing case", async () => {
    const endpoint = await peerAnswering((socket) => socket.resetAndDestroy());
    expect(await observePeerAnswer(endpoint, BUDGET_MS)).toEqual({
      kind: "closed-unanswered",
    });
  });

  test("reports a real identification string as an identified SSH server", async () => {
    const endpoint = await peerAnswering((socket) =>
      socket.end("SSH-2.0-OpenSSH_9.6p1\r\n"),
    );
    expect(await observePeerAnswer(endpoint, BUDGET_MS)).toEqual({
      kind: "identified",
    });
  });

  test("classifies on the raw text: a private-key marker ahead of the identification string does not swallow it", async () => {
    const endpoint = await peerAnswering((socket) =>
      socket.end(
        "-----BEGIN RSA PRIVATE KEY-----\r\nSSH-2.0-OpenSSH_9.6p1\r\n",
      ),
    );
    expect(await observePeerAnswer(endpoint, BUDGET_MS)).toEqual({
      kind: "identified",
    });
  });

  test("reads past the excerpt so a preamble ahead of the identification string does not decide it", async () => {
    const preamble = "authorized use only\r\n".repeat(8);
    expect(preamble.length).toBeGreaterThan(PEER_EXCERPT_MAX_BYTES);
    expect(preamble.length).toBeLessThan(PEER_ANSWER_READ_MAX_BYTES);
    const endpoint = await peerAnswering((socket) => {
      socket.write(preamble);
      socket.end("SSH-2.0-OpenSSH_9.6p1\r\n");
    });
    expect(await observePeerAnswer(endpoint, BUDGET_MS)).toEqual({
      kind: "identified",
    });
  });

  test("reads a preamble past the read bound as non-SSH, identification string and all", async () => {
    // The FAILING side of the bound above, driven because the copy is written
    // around it: a real SSH server whose banner outruns the read lands in the
    // non-SSH classification, so the operator's message states what the first
    // bytes held rather than what the peer is.
    const preamble = "authorized use only\r\n".repeat(32);
    expect(preamble.length).toBeGreaterThan(PEER_ANSWER_READ_MAX_BYTES);
    const endpoint = await peerAnswering((socket) => {
      socket.write(preamble);
      socket.end("SSH-2.0-OpenSSH_9.6p1\r\n");
    });
    const answer = await observePeerAnswer(endpoint, BUDGET_MS);
    expect(answer.kind).toBe("non-ssh");
    if (answer.kind !== "non-ssh") return;
    expect(answer.shape).toBe("unrecognized");
  });

  test("reads an identification string that arrives after the budget as non-SSH", async () => {
    // The other half of the same bound: the deadline. A peer whose preamble
    // fits but whose identification string arrives late is classified on what
    // was read by then.
    const endpoint = await peerAnswering((socket) => {
      socket.write("authorized use only\r\n");
      // Unref'd: the case is decided on the deadline, and nothing here should hold
      // the loop open waiting for a write whose whole point is arriving late.
      setTimeout(() => socket.end("SSH-2.0-OpenSSH_9.6p1\r\n"), 400).unref();
    });
    const answer = await observePeerAnswer(endpoint, 100);
    expect(answer.kind).toBe("non-ssh");
    if (answer.kind !== "non-ssh") return;
    expect(answer.shape).toBe("unrecognized");
  });

  test("bounds the excerpt and stops reading against a peer answering with megabytes", async () => {
    const endpoint = await peerAnswering((socket) =>
      socket.write(
        "HTTP/1.0 500 Internal Server Error\r\n" + "X".repeat(4_000_000),
      ),
    );
    const answer = await observePeerAnswer(endpoint, BUDGET_MS);
    expect(answer.kind).toBe("non-ssh");
    if (answer.kind !== "non-ssh") return;
    expect(answer.excerpt.length).toBe(PEER_EXCERPT_MAX_BYTES);
  });

  test("establishes nothing when the connection is refused", async () => {
    // A port nothing listens on: bound, then released before the read.
    const endpoint = await peerAnswering(() => {});
    await new Promise<void>((resolve) =>
      listeners.splice(0)[0].close(() => resolve()),
    );
    expect(await observePeerAnswer(endpoint, BUDGET_MS)).toEqual({
      kind: "unobserved",
    });
  });

  test("establishes nothing from a peer that accepts and then holds the connection open", async () => {
    const endpoint = await peerAnswering(() => {});
    expect(await observePeerAnswer(endpoint, 150)).toEqual({
      kind: "unobserved",
    });
  });
});

// A peer answering the port with PEM-shaped bytes. The strip runs over the whole
// retained read and the excerpt bound is applied to what it leaves, so every
// consumer is handed the same treated bytes rather than each remembering the
// call. The clip is what makes that order critical -- a marker it cut in half
// matches neither redaction rule -- so the marker's three placements relative to
// the bound are driven separately, over real sockets like the reads above.
describe("the excerpt is redacted before it is clipped", () => {
  const HTTP_HEAD = "HTTP/1.0 200 OK\r\n\r\n";
  const BEGIN_MARKER = "-----BEGIN OPENSSH PRIVATE KEY-----";
  const END_MARKER = "-----END OPENSSH PRIVATE KEY-----";
  const KEY_BODY = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU";
  const REDACTION = "[redacted private key]";

  /** What the read retains of `answer`, as the classification leaves it. */
  const excerptOf = async (answer: string): Promise<string> => {
    expect(answer.length).toBeLessThan(PEER_ANSWER_READ_MAX_BYTES);
    const endpoint = await peerAnswering((socket) => socket.end(answer));
    const observed = await observePeerAnswer(endpoint, BUDGET_MS);
    expect(observed.kind).toBe("non-ssh");
    return observed.kind === "non-ssh" ? observed.excerpt : "";
  };

  test("a whole block inside the excerpt is replaced", async () => {
    const answer = `${HTTP_HEAD}${BEGIN_MARKER}\r\n${KEY_BODY}\r\n${END_MARKER}\r\n`;
    expect(answer.length).toBeLessThanOrEqual(PEER_EXCERPT_MAX_BYTES);
    expect(await excerptOf(answer)).toBe(`${HTTP_HEAD}${REDACTION}\r\n`);
  });

  test("a block whose body runs past the excerpt is replaced from its marker", async () => {
    // The fail-closed dangling rule: a BEGIN with no END within the read, which
    // is what a real key answered onto this port looks like from here.
    const answer = `${HTTP_HEAD}${BEGIN_MARKER}\r\n${"A".repeat(300)}`;
    expect(await excerptOf(answer)).toBe(`${HTTP_HEAD}${REDACTION}`);
  });

  test("a marker straddling the clip leaves no fragment behind", async () => {
    // The marker starts half its own length before the bound, so the clip taken
    // first would cut it in two and hand a consumer a fragment neither rule
    // matches.
    const preamble = "X".repeat(
      PEER_EXCERPT_MAX_BYTES - Math.floor(BEGIN_MARKER.length / 2),
    );
    expect(preamble.length).toBeLessThan(PEER_EXCERPT_MAX_BYTES);
    expect(preamble.length + BEGIN_MARKER.length).toBeGreaterThan(
      PEER_EXCERPT_MAX_BYTES,
    );
    const excerpt = await excerptOf(
      `${preamble}${BEGIN_MARKER}\r\n${KEY_BODY}`,
    );
    expect(excerpt.startsWith(preamble)).toBe(true);
    // What the clip cuts is the replacement rather than the marker, so nothing
    // of the block reaches the bound at all.
    expect(REDACTION.startsWith(excerpt.slice(preamble.length))).toBe(true);
    expect(excerpt).not.toContain("BEGIN");
    expect(excerpt).not.toContain(KEY_BODY);
    // A consumer's own pass finds nothing left to strip: the treatment travels
    // with the excerpt rather than being owed by whoever holds it next.
    expect(redactPrivateKeyMaterial(excerpt)).toBe(excerpt);
  });

  test("a marker starting past the clip leaves the excerpt the bytes it was", async () => {
    const preamble = "X".repeat(PEER_EXCERPT_MAX_BYTES * 2);
    const excerpt = await excerptOf(
      `${preamble}${BEGIN_MARKER}\r\n${KEY_BODY}`,
    );
    expect(excerpt).toBe("X".repeat(PEER_EXCERPT_MAX_BYTES));
  });

  test("the composed chain includes the stripped excerpt as it stands", async () => {
    const excerpt = await excerptOf(
      `${HTTP_HEAD}${BEGIN_MARKER}\r\n${KEY_BODY}`,
    );
    const text = rendered(
      explainPeerIdentificationFailure(
        new Error("Connection lost before handshake"),
        { kind: "non-ssh", shape: "http", excerpt },
        { host: "sftp.example.test", port: 22 },
      ),
    );
    expect(text).toContain(REDACTION);
    expect(text).not.toContain(KEY_BODY);
    expect(text).not.toContain("BEGIN");
  });
});

describe("isPreIdentificationDialFailure gates on the stack's own wording", () => {
  test("recognizes a rejection a re-raise kept as its cause", () => {
    // The gate reads a chain rather than one message, so a diagnostic that
    // replaced the message and kept the stack's own rejection behind it -- the
    // shape every re-raise on the dial paths composes -- stays matched.
    const rejection = new Error(
      "getConnection: Connection lost before handshake",
    );
    const wrapped = new Error("the SFTP dial failed", { cause: rejection });
    expect(isPreIdentificationDialFailure(wrapped)).toBe(true);
  });

  test("walks through a non-Error link interposed in the chain", () => {
    const rejection = new Error(
      "getConnection: connect ECONNRESET 10.0.0.4:22",
    );
    const interposed = { cause: rejection };
    const outer = new Error("the SFTP dial failed", { cause: interposed });
    expect(isPreIdentificationDialFailure(outer)).toBe(true);
  });

  test("recognizes a reset at accept", () => {
    expect(
      isPreIdentificationDialFailure(
        new Error("getConnection: connect ECONNRESET 10.0.0.4:22"),
      ),
    ).toBe(true);
  });

  test("leaves an unreachable host to the rejection it already has", () => {
    expect(
      isPreIdentificationDialFailure(
        new Error("getConnection: connect ECONNREFUSED 10.0.0.4:22"),
      ),
    ).toBe(false);
  });

  test("does not loop on a cause chain that revisits a link", () => {
    const looped = new Error("outer");
    Object.defineProperty(looped, "cause", { value: looped });
    expect(isPreIdentificationDialFailure(looped)).toBe(false);
  });
});

describe("explainPeerIdentificationFailure partitions the peer's bytes", () => {
  const endpoint = { host: "sftp.example.test", port: 2222 };
  const dialRejection = new Error(
    "could not read the server's host key: getConnection: Connection lost " +
      "before handshake",
  );

  test("leaves the rejection alone when the peer identified itself", () => {
    expect(
      explainPeerIdentificationFailure(
        dialRejection,
        { kind: "identified" },
        endpoint,
      ),
    ).toBe(dialRejection);
  });

  test("leaves the rejection alone when nothing was established", () => {
    expect(
      explainPeerIdentificationFailure(
        dialRejection,
        { kind: "unobserved" },
        endpoint,
      ),
    ).toBe(dialRejection);
  });

  test("names the firewall case without an excerpt and keeps the rejection", () => {
    const explained = explainPeerIdentificationFailure(
      dialRejection,
      { kind: "closed-unanswered" },
      endpoint,
    );
    const text = rendered(explained);
    expect(text).toContain("closed it having sent nothing");
    expect(text).toContain("source-IP allowlist");
    expect(text).toContain("sftp.example.test:2222");
    expect(text).toContain("Connection lost before handshake");
    expect(text).not.toContain("first bytes the peer sent");
    // Nothing here is anyone else's bytes, so nothing here may be cut: the cap
    // applies to first-party copy exactly as it does to a peer's.
    expect(text).not.toContain(DISPLAY_TRUNCATION_MARKER);
  });

  test("a clean close and a reset take one message, the stack's wording behind it", () => {
    const closeText = rendered(
      explainPeerIdentificationFailure(
        new Error("getConnection: Connection lost before handshake"),
        { kind: "closed-unanswered" },
        endpoint,
      ),
    );
    const resetText = rendered(
      explainPeerIdentificationFailure(
        new Error("getConnection: connect ECONNRESET 10.0.0.4:22"),
        { kind: "closed-unanswered" },
        endpoint,
      ),
    );
    const firstLine = (text: string): string => text.split("\n")[0];
    expect(firstLine(closeText)).toBe(firstLine(resetText));
    expect(closeText).toContain("Connection lost before handshake");
    expect(resetText).toContain("ECONNRESET");
  });

  test("gives the peer's bytes a display link of their own", () => {
    const answer: PeerAnswer = {
      kind: "non-ssh",
      shape: "http",
      excerpt: "HTTP/1.0 403 Forbidden",
    };
    const links = rendered(
      explainPeerIdentificationFailure(dialRejection, answer, endpoint),
    ).split("\ncaused by: ");
    expect(links[0]).toContain("an HTTP response");
    expect(links).toContain(
      "first bytes the peer sent; PEM private-key blocks replaced: HTTP/1.0 403 Forbidden",
    );
    expect(
      links.some((link) => link.startsWith("Check that the configured")),
    ).toBe(true);
  });

  // Every shape, because each names its own likely cause and they are not the
  // same length: the longest summary is the one the display cap binds first.
  test.each(["http", "tls-alert", "unrecognized"] as const)(
    "the first-party text survives a maximally long peer excerpt (%s)",
    (shape) => {
      // Every byte escaping to four display characters, at the excerpt bound:
      // the widest a peer's link can ever render, since the read that fills it
      // stops at that bound.
      const excerpt = "\x00".repeat(PEER_EXCERPT_MAX_BYTES);
      const links = rendered(
        explainPeerIdentificationFailure(
          dialRejection,
          { kind: "non-ssh", shape, excerpt },
          endpoint,
        ),
      ).split("\ncaused by: ");
      const summary = links[0];
      expect(summary).toContain("did not identify itself");
      // What the peer's first bytes held, which is what was read -- not a
      // verdict on what the peer is, which the bounded read cannot establish.
      expect(summary).toContain("the first bytes the peer");
      expect(summary).toContain("not an SSH identification string");
      expect(summary.length).toBeLessThanOrEqual(DEFAULT_MAX_DISPLAY_LENGTH);
      const guidance = links.find((link) =>
        link.startsWith("Check that the configured"),
      );
      expect(guidance).toBeDefined();
      // The recovery step names the read bound the verdict rests on, so an
      // operator whose server has a long banner can recognize their own case.
      expect(guidance).toContain(String(PEER_ANSWER_READ_MAX_BYTES));
      expect(links.some((link) => link.includes("no credential"))).toBe(true);
      expect(links).toContain(
        `configured endpoint: ${endpoint.host}:${endpoint.port}`,
      );
      const peerLink = links.find((link) =>
        link.startsWith(
          "first bytes the peer sent; PEM private-key blocks replaced:",
        ),
      );
      expect(peerLink).toBeDefined();
      expect(peerLink).toContain("\\x00");
      expect(peerLink?.length).toBeLessThanOrEqual(
        COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH + DISPLAY_TRUNCATION_MARKER.length,
      );
      // The peer's bytes sit on a link of their own, so the widest excerpt the
      // read can deliver spends only that link -- and at this width it fits, so
      // nothing the operator has to act on is cut and neither is the excerpt.
      expect(
        links.filter((link) => link.includes(DISPLAY_TRUNCATION_MARKER)),
      ).toEqual([]);
    },
  );

  test("escapes the peer's control bytes rather than letting them reach the terminal", () => {
    const text = rendered(
      explainPeerIdentificationFailure(
        dialRejection,
        {
          kind: "non-ssh",
          shape: "unrecognized",
          excerpt: "\x1b[2Jcleared\r\nfaked line",
        },
        endpoint,
      ),
    );
    expect(text).toContain("\\x1b[2Jcleared\\x0d\\x0afaked line");
    expect(text).not.toContain("\x1b");
  });
});

// The composed sentence is one consumer of the read; a machine consumer -- the
// console's host-key probe, which discards the child's stderr -- is the other, and
// it reads the classification off the raised error rather than out of the prose.
describe("the raised diagnostic holds the diagnosis structurally", () => {
  const endpoint = { host: "sftp.example.test", port: 2222 };
  const dialRejection = new Error("Connection lost before handshake");

  test("a non-SSH answer includes its shape and the peer's own bytes", () => {
    const explained = explainPeerIdentificationFailure(
      dialRejection,
      { kind: "non-ssh", shape: "http", excerpt: "HTTP/1.1 403 Forbidden" },
      endpoint,
    );
    expect(peerIdentificationDiagnosisOf(explained)).toEqual({
      kind: "non-ssh",
      shape: "http",
      excerpt: "HTTP/1.1 403 Forbidden",
    });
  });

  test("a peer that closed having sent nothing holds that alone", () => {
    const explained = explainPeerIdentificationFailure(
      dialRejection,
      { kind: "closed-unanswered" },
      endpoint,
    );
    expect(peerIdentificationDiagnosisOf(explained)).toEqual({
      kind: "closed-unanswered",
    });
  });

  test("the diagnosis is found through a re-raise that kept it as a cause", () => {
    const explained = explainPeerIdentificationFailure(
      dialRejection,
      { kind: "closed-unanswered" },
      endpoint,
    );
    const rewrapped = new Error("could not read the server's host key", {
      cause: explained,
    });
    expect(peerIdentificationDiagnosisOf(rewrapped)).toEqual({
      kind: "closed-unanswered",
    });
  });

  test("a failure this module never diagnosed holds none", () => {
    expect(peerIdentificationDiagnosisOf(dialRejection)).toBeUndefined();
    expect(
      peerIdentificationDiagnosisOf(
        explainPeerIdentificationFailure(
          dialRejection,
          { kind: "identified" },
          endpoint,
        ),
      ),
    ).toBeUndefined();
  });
});

describe("peerProbeTargetFromConnectOptions follows the dial it diagnoses", () => {
  // Every dial enters the dial sequence with ssh2's connect options and never
  // with the config behind them, so this is the one derivation of the endpoint.
  // The port a portless dial reaches is not written here: it is whatever the
  // pinned stack dials, and the integration assumption reads that off a
  // portless dial's own rejection and holds this to it, where a number written
  // here would be a second assumption nothing checks.
  test("reads the endpoint the connect options hold", () => {
    expect(
      peerProbeTargetFromConnectOptions({
        host: "sftp.example.test",
        port: 2222,
      }),
    ).toEqual({ host: "sftp.example.test", port: 2222 });
  });

  test("reproduces no endpoint from options that name none", () => {
    // A dial this cannot follow: reading some other endpoint would report about
    // a peer it never spoke to, so the caller keeps the rejection it had.
    expect(peerProbeTargetFromConnectOptions({})).toBeUndefined();
    expect(peerProbeTargetFromConnectOptions({ host: "" })).toBeUndefined();
    expect(
      peerProbeTargetFromConnectOptions({
        host: "sftp.example.test",
        port: "2222",
      }),
    ).toBeUndefined();
  });
});

describe("diagnosePeerAnswer says what it read, or nothing", () => {
  // The read and the composition together, as the adapter's dial sequence calls
  // them once its gate has admitted a rejection. The gate itself is above; that
  // the adapter is the only caller, and reads the peer once per diagnosed
  // failure however the dial was entered, is driven over real dials in
  // test/integration/dialPeerIdentification.test.ts.
  const rejection = (): Error =>
    new Error("getConnection: Connection lost before handshake");

  test("names what the live peer answered with, on the endpoint it read", async () => {
    const endpoint = await peerAnswering((socket) =>
      socket.end(HTTP_ERROR_PAGE),
    );
    const text = rendered(
      await diagnosePeerAnswer(rejection(), endpoint, undefined),
    );
    expect(text).toContain("an HTTP response");
    expect(text).toContain("403 Forbidden");
    expect(text).toContain(`configured endpoint: 127.0.0.1:${endpoint.port}`);
  });

  test("returns the rejection when the peer turns out to be an SSH server", async () => {
    const endpoint = await peerAnswering((socket) =>
      socket.end("SSH-2.0-OpenSSH_9.6p1\r\n"),
    );
    const dialFailure = rejection();
    expect(await diagnosePeerAnswer(dialFailure, endpoint, undefined)).toBe(
      dialFailure,
    );
  });

  test("clamps the read to the connect budget the dial ran under", async () => {
    // A peer that accepts and holds the connection open with nothing on it, so
    // only a deadline ends the read: a run that shortened its connect gets the
    // shorter deadline, not the read's own default. The margin is wide because
    // what is asserted is which of the two budgets bounded it.
    const endpoint = await peerAnswering(() => {});
    const started = Date.now();
    const dialFailure = rejection();
    expect(await diagnosePeerAnswer(dialFailure, endpoint, 200)).toBe(
      dialFailure,
    );
    expect(Date.now() - started).toBeLessThan(BUDGET_MS / 2);
  });
});
