import { describe, expect, test } from "vitest";

import {
  sanitizeErrorForDisplay,
  redactPrivateKeyMaterial,
  MAX_ERROR_CAUSE_DEPTH,
} from "../src/utils/sanitizeErrorForDisplay";
import { sanitizeForDisplay } from "../src/utils/sanitizeForDisplay";
import {
  ConnectionError,
  asConnectionError,
  errorMessage,
} from "../src/connection/messageConnection";

describe("sanitizeErrorForDisplay", () => {
  test("passes an ordinary error message through unchanged", () => {
    expect(sanitizeErrorForDisplay(new Error("Connection refused"))).toBe(
      "Connection refused",
    );
  });

  test("renders a no-cause error exactly as sanitizeForDisplay(errorMessage(err))", () => {
    const err = new Error("MOU-2025-0042 failed");
    expect(sanitizeErrorForDisplay(err)).toBe(
      sanitizeForDisplay(errorMessage(err)),
    );
  });

  test("escapes ANSI / control bytes in the top-level message", () => {
    const out = sanitizeErrorForDisplay(new Error("\x1b[31mEVIL\x1b[0m"));
    expect(out).not.toContain("\x1b");
    expect(out).toContain("\\x1b[31mEVIL");
  });

  test("escapes a newline in the message so it cannot spoof a log line", () => {
    const out = sanitizeErrorForDisplay(new Error("ok\nFAKE: all clear"));
    expect(out).not.toContain("\n");
    expect(out).toContain("\\x0a");
  });

  test("neutralizes deceptive Unicode (bidi override) in the message", () => {
    const out = sanitizeErrorForDisplay(new Error("user\u202eEVIL"));
    expect(out).not.toContain("\u202e");
    expect(out).toContain("\\u202e");
  });

  test("escapes control/ANSI bytes carried by a chained cause", () => {
    // The dangerous bytes live one link down the cause chain; the wrapper
    // message is clean. The cause text must still be neutralized, and the raw
    // ESC must not appear anywhere in the rendered output.
    const out = sanitizeErrorForDisplay(
      new Error("exchange failed", { cause: new Error("\x1b[31mEVIL") }),
    );
    expect(out).not.toContain("\x1b");
    expect(out).toContain("caused by:");
    expect(out).toContain("\\x1b[31mEVIL");
  });

  test("does not re-leak a hostile filedrop path embedded in a transport cause", () => {
    // The reachable vector: a get/delete fs failure on a partner-chosen message
    // filename yields an fs error whose message embeds raw ESC/newline/bidi. The
    // event bridge wraps it via asConnectionError, so the bytes ride both the
    // wrapper message and the cause. Neither may reach the operator raw.
    const fsError = new Error(
      "ENOENT: no such file or directory, open '/drop/\x1b[31mEVIL\nFAKE.json'",
    );
    const wrapped = asConnectionError(fsError, "transport");
    const out = sanitizeErrorForDisplay(wrapped);
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("\n");
    expect(out).toContain("\\x1b[31mEVIL\\x0aFAKE.json");
  });

  test("suppresses a duplicate when the wrapper message equals its cause", () => {
    // asConnectionError copies errorMessage(cause) into the wrapper message, so
    // the outer and first inner links are byte-identical: print the text once.
    const cause = new Error("ENOENT: no such file or directory");
    const wrapper = new ConnectionError(errorMessage(cause), "transport", {
      cause,
    });
    const out = sanitizeErrorForDisplay(wrapper);
    expect(out).toBe(sanitizeForDisplay(errorMessage(cause)));
    expect(out).not.toContain("caused by:");
  });

  test("keeps a distinct deeper cause after suppressing the wrapper duplicate", () => {
    const root = new Error("EROFS: read-only file system");
    const mid = new Error(errorMessage(root), { cause: root });
    const wrapper = new ConnectionError(errorMessage(mid), "transport", {
      cause: mid,
    });
    const out = sanitizeErrorForDisplay(wrapper);
    // wrapper == mid == root in message, so the chain collapses to one line.
    expect(out).toBe(sanitizeForDisplay("EROFS: read-only file system"));
  });

  test("renders multiple distinct links joined by 'caused by:'", () => {
    const out = sanitizeErrorForDisplay(
      new Error("outer", { cause: new Error("inner") }),
    );
    expect(out).toBe("outer\ncaused by: inner");
  });

  test("is cycle-safe: a chain that revisits a link stops", () => {
    const a = new Error("A");
    const b = new Error("B", { cause: a });
    a.cause = b;
    const out = sanitizeErrorForDisplay(a);
    expect(out).toBe("A\ncaused by: B");
  });

  test("is depth-bounded: a very long chain stops at MAX_ERROR_CAUSE_DEPTH", () => {
    let err = new Error("link0");
    for (let i = 1; i < 20; i++) err = new Error(`link${i}`, { cause: err });
    const out = sanitizeErrorForDisplay(err);
    const links = out.split("\ncaused by: ");
    expect(links.length).toBe(MAX_ERROR_CAUSE_DEPTH);
    expect(links[0]).toBe("link19");
    expect(links[links.length - 1]).toBe(`link${20 - MAX_ERROR_CAUSE_DEPTH}`);
  });

  test("walks a non-Error cause and neutralizes its bytes", () => {
    const out = sanitizeErrorForDisplay(
      new Error("outer", { cause: "raw\x1b[31m cause" }),
    );
    expect(out).not.toContain("\x1b");
    expect(out).toContain("caused by:");
    expect(out).toContain("\\x1b[31m cause");
  });

  test("renders non-Error / null / undefined values via their String form", () => {
    expect(sanitizeErrorForDisplay("plain failure")).toBe("plain failure");
    expect(sanitizeErrorForDisplay(null)).toBe("null");
    expect(sanitizeErrorForDisplay(undefined)).toBe("undefined");
    expect(sanitizeErrorForDisplay(42)).toBe("42");
  });

  test("escapes control/ANSI bytes in a non-Error thrown value", () => {
    expect(sanitizeErrorForDisplay("evil\x1b[31m")).toBe("evil\\x1b[31m");
  });

  test("does not throw on an error whose message getter throws", () => {
    const hostile = new Error("placeholder");
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("boom");
      },
    });
    expect(sanitizeErrorForDisplay(hostile)).toBe("[unreadable error]");
  });

  test("ends the chain on an error whose cause getter throws", () => {
    const hostile = new Error("real failure");
    Object.defineProperty(hostile, "cause", {
      get() {
        throw new Error("boom");
      },
    });
    // The readable top message still renders; the throwing cause read stops the
    // walk rather than propagating.
    expect(sanitizeErrorForDisplay(hostile)).toBe("real failure");
  });

  test("renders readable links on both sides of an unreadable middle cause", () => {
    // An unreadable link (throwing message getter) in the middle of the chain
    // becomes the marker but does not stop the walk: its own `.cause` is a normal
    // data property, so a readable inner link beyond it still renders.
    const mid = new Error("placeholder", { cause: new Error("inner") });
    Object.defineProperty(mid, "message", {
      get() {
        throw new Error("boom");
      },
    });
    expect(sanitizeErrorForDisplay(new Error("outer", { cause: mid }))).toBe(
      "outer\ncaused by: [unreadable error]\ncaused by: inner",
    );
  });

  test("coerces a non-string message rather than letting the sanitizer throw", () => {
    // A malformed Error with a numeric .message would make sanitizeForDisplay's
    // code-point iteration throw; the helper coerces it to a string first.
    const weird = new Error("placeholder");
    (weird as unknown as { message: unknown }).message = 12345;
    expect(sanitizeErrorForDisplay(weird)).toBe("12345");
  });

  test("renders an empty-message link inside a chain via the errorMessage fallback", () => {
    expect(
      sanitizeErrorForDisplay(new Error("outer", { cause: new Error("") })),
    ).toBe("outer\ncaused by: Error");
  });

  test("stringifies a non-Error object cause instead of reading its message field", () => {
    // A non-Error object cause matches errorMessage's String(...) contract: it
    // renders as [object Object]; its own .message is not duck-typed. (Its
    // .cause is still followed, like any object link -- exercised elsewhere.)
    expect(
      sanitizeErrorForDisplay(
        new Error("outer", { cause: { message: "ignored" } }),
      ),
    ).toBe("outer\ncaused by: [object Object]");
  });

  // The guarantee the sink carries ALONE. Composition sites interpolate partner
  // and server bytes raw, so nothing between the wire and here escapes anything:
  // if this renderer let a byte through, it would reach the operator's terminal
  // as that byte. Stated as a property over every position a hostile value can
  // occupy in a cause chain rather than as a case per position, because the
  // property is what the composition sites are allowed to rely on.
  //
  // The one control character permitted is the newline this module itself emits
  // between links (CAUSE_SEPARATOR); every other byte outside printable ASCII is
  // a leak. The CLI integration console sentinel enforces the same predicate on
  // what actually reaches the console at runtime.
  test("renders only printable ASCII plus its own framing newline", () => {
    const hostile = [
      "\x1b[2J\x1b[31mANSI",
      "line\nbreak\r\ninjection",
      "bidi\u202eEVIL\u200bzero-width",
      "homoglyph \u0430\u0435\u043e",
      "astral \u{1f600}\u{10ffff}",
      "nul\u0000and\u0007bell",
      "lone surrogate \ud800",
      "c1 control \u0085\u009b",
    ];
    for (const value of hostile) {
      const deep = new Error(`outer ${value}`, {
        cause: new Error(`middle ${value}`, {
          cause: { toString: () => `leaf ${value}` },
        }),
      });
      for (const err of [
        new Error(value),
        value,
        deep,
        new Error("fixed", { cause: value }),
      ]) {
        const rendered = sanitizeErrorForDisplay(err);
        expect(rendered).not.toMatch(/[^\x20-\x7e\n]/);
        // Not vacuous: the escaped form of the hostile value is really there.
        expect(rendered).toContain(sanitizeForDisplay(value));
      }
    }
  });

  describe("private-key redaction backstop", () => {
    const KEY_BODY = "MIIByteslookingsecret0123456789ABCDEFabcdef+/wEHEHE";

    test("redacts a PEM private-key block embedded in a message", () => {
      const pem = `-----BEGIN PRIVATE KEY-----\n${KEY_BODY}\n-----END PRIVATE KEY-----`;
      const out = sanitizeErrorForDisplay(
        new Error(`could not load key: ${pem}`),
      );
      expect(out).toContain("[redacted private key]");
      expect(out).not.toContain(KEY_BODY);
    });

    test("redacts OpenSSH and other labelled private-key blocks", () => {
      const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${KEY_BODY}\n-----END OPENSSH PRIVATE KEY-----`;
      const out = sanitizeErrorForDisplay(new Error(pem));
      expect(out).not.toContain(KEY_BODY);
    });

    test("redacts a PKCS#8 ENCRYPTED PRIVATE KEY block and a key with no trailing newline", () => {
      const enc = `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${KEY_BODY}\n-----END ENCRYPTED PRIVATE KEY-----`;
      expect(sanitizeErrorForDisplay(new Error(enc))).not.toContain(KEY_BODY);
      // No newline between the body and the END marker.
      const tight = `-----BEGIN PRIVATE KEY-----${KEY_BODY}-----END PRIVATE KEY-----`;
      expect(sanitizeErrorForDisplay(new Error(tight))).not.toContain(KEY_BODY);
    });

    test("returns promptly on a long run of BEGIN markers with no END (no ReDoS)", () => {
      // The block regex must not backtrack quadratically when many BEGIN markers
      // appear with no closing END (partner-controlled error text). A naive lazy
      // gap regex takes seconds on this input; the tempered lookahead keeps it
      // linear. The dangling fallback then redacts from the first marker.
      const evil = "-----BEGIN A PRIVATE KEY-----".repeat(20000);
      const start = Date.now();
      const out = sanitizeErrorForDisplay(new Error(evil));
      expect(Date.now() - start).toBeLessThan(1000);
      expect(out).toContain("[redacted private key]");
    });

    test("redacts a truncated block (BEGIN marker with no END)", () => {
      // A key sliced into an error mid-stream has no END marker; the dangling
      // fallback must still strip from the BEGIN marker onward.
      const out = sanitizeErrorForDisplay(
        new Error(`-----BEGIN RSA PRIVATE KEY-----\n${KEY_BODY}`),
      );
      expect(out).toContain("[redacted private key]");
      expect(out).not.toContain(KEY_BODY);
    });

    test("redacts a private key carried on a cause-chain link", () => {
      const inner = new Error(
        `-----BEGIN PRIVATE KEY-----\n${KEY_BODY}\n-----END PRIVATE KEY-----`,
      );
      const out = sanitizeErrorForDisplay(
        new Error("write failed", { cause: inner }),
      );
      expect(out).not.toContain(KEY_BODY);
    });

    test("leaves ordinary base64url-shaped values (e.g. fingerprints) intact", () => {
      // The backstop must NOT scrub by shape: a host-key fingerprint is shown to
      // the operator on purpose and shares the shared-secret's character set.
      const fingerprint = "SHA256:abcDEF0123456789_-ghijklmnopqrstuvwxyzABCD";
      expect(
        sanitizeErrorForDisplay(new Error(`host key ${fingerprint}`)),
      ).toContain(fingerprint);
    });

    // A key sliced into an error message carries whatever structure the thing
    // that carried it left behind: real line breaks from a file read, spaces
    // from a folded or plain multi-line YAML scalar, or nothing at all from a
    // single-line JSON scalar. The reach past a truncated marker is to the end
    // of the link for exactly this reason -- a rule that consumes only armor
    // organised into LINES leaks the whole body of every other delivery.
    test("redacts a truncated key whatever joins its armor lines", () => {
      const body = [
        "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz",
        "c2gtZWQyNTUxOQAAACBQ1n3QqzB2rN0m8oL7vC5xY6aJ4kD1gH2sF3dP9uT8iQ",
        "Wq1n3QqzB2rN0m8oL7vC5xY6aJ4kD1gH2sF3dP9uT8iR6eW0yA==",
      ];
      const marker = "-----BEGIN OPENSSH PRIVATE KEY-----";
      for (const separator of ["\n", "\r\n", "\r", " ", "\t", "", "\\n"]) {
        const sliced = `${marker}${separator}${body.join(separator)}`;
        for (const carrier of [
          `could not load key: ${sliced}`,
          `bad config {"key": "${sliced}"}`,
        ]) {
          const out = sanitizeErrorForDisplay(new Error(carrier));
          expect(out).toContain("[redacted private key]");
          for (const line of body) {
            expect(out).not.toContain(line.slice(0, 24));
            expect(out).not.toContain(line.slice(-24));
          }
        }
      }
    });

    test("redactPrivateKeyMaterial is idempotent and never grows its input", () => {
      // Composition sites redact a fragment before it is interpolated, and the
      // renderer redacts the whole link again. The second pass must be a no-op
      // (the replacement carries no marker), and neither pass may lengthen the
      // text, or a display budget fitted over raw fragments would overrun.
      const inputs = [
        "",
        "plain text",
        "-----BEGIN RSA PRIVATE KEY-----",
        `-----BEGIN RSA PRIVATE KEY-----\n${KEY_BODY}`,
        `a-----BEGIN PRIVATE KEY-----b-----END PRIVATE KEY-----c`,
        "-----BEGIN A PRIVATE KEY-----".repeat(200),
      ];
      for (const input of inputs) {
        const once = redactPrivateKeyMaterial(input);
        expect(redactPrivateKeyMaterial(once)).toBe(once);
        expect(once.length).toBeLessThanOrEqual(input.length);
      }
    });

    // The reach is fail-closed to the end of the link, so operator text composed
    // after a marker in the SAME link is taken with it. That is the cost the
    // composition sites pay off by redacting their partner-controlled fragments
    // first; it is pinned here so a future change to the reach is a visible
    // decision rather than a silent one.
    test("the reach past a marker is the whole link, and stops at the link boundary", () => {
      const out = sanitizeErrorForDisplay(
        new Error("-----BEGIN RSA PRIVATE KEY-----then first-party text", {
          cause: new Error("the next link is out of reach"),
        }),
      );
      expect(out).not.toContain("then first-party text");
      expect(out).toContain("the next link is out of reach");
    });
  });
});
