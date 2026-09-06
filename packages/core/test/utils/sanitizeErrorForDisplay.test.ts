import { describe, expect, test } from "vitest";

import {
  createPrivateKeyStreamRedactor,
  joinErrorCauseChain,
  sanitizeErrorChainLinks,
  sanitizeErrorForDisplay,
  redactAndSanitizeForDisplay,
  redactPrivateKeyMaterial,
  CAUSE_DEPTH_ELISION_MARKER,
  MAX_ERROR_CAUSE_DEPTH,
} from "../../src/utils/sanitizeErrorForDisplay";
import {
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  DEFAULT_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  sanitizeForDisplay,
} from "../../src/utils/sanitizeForDisplay";
import {
  ConnectionError,
  asConnectionError,
  errorMessage,
} from "../../src/connection/messageConnection";

describe("sanitizeErrorForDisplay", () => {
  test("passes an ordinary error message through unchanged", () => {
    expect(sanitizeErrorForDisplay(new Error("Connection refused"))).toBe(
      "Connection refused",
    );
  });

  test("renders a no-cause error at the composed-message budget, not the per-value default", () => {
    // A single link is still a COMPOSITION, so the budget it is charged to is
    // COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH. Driven past the per-value default,
    // where the two budgets disagree: a fixture short enough for them to agree
    // measures neither.
    const err = new Error(
      `MOU-2025-0042 failed: ${"d".repeat(DEFAULT_MAX_DISPLAY_LENGTH)}`,
    );
    expect(sanitizeErrorForDisplay(err)).toBe(
      sanitizeForDisplay(errorMessage(err), {
        maxLength: COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
      }),
    );
    // Not vacuous: at the per-value default this same message loses its tail.
    expect(sanitizeForDisplay(errorMessage(err))).toContain(
      DISPLAY_TRUNCATION_MARKER,
    );
    expect(sanitizeErrorForDisplay(err)).not.toContain(
      DISPLAY_TRUNCATION_MARKER,
    );
  });

  test("caps a no-cause error at COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH", () => {
    // The other side of the budget: it is a cap, not a removal, and it falls
    // exactly where the composed-message constant puts it.
    const flooded = "x".repeat(COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH + 1);
    expect(sanitizeErrorForDisplay(new Error(flooded))).toBe(
      "x".repeat(COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH) +
        DISPLAY_TRUNCATION_MARKER,
    );
  });

  test("escapes a newline in the message so it cannot spoof a log line", () => {
    const out = sanitizeErrorForDisplay(new Error("ok\nFAKE: all clear"));
    expect(out).not.toContain("\n");
    expect(out).toContain("\\x0a");
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
    // The cut is disclosed on the link it falls after, not left for the operator
    // to infer: the chain that stops here still had 12 links to go.
    expect(links[links.length - 1]).toBe(
      `link${20 - MAX_ERROR_CAUSE_DEPTH} ${CAUSE_DEPTH_ELISION_MARKER}`,
    );
  });

  test("marks nothing when the chain ends exactly at the depth bound", () => {
    // The bound is spent and there is no further link: every link is rendered, so
    // an elision marker would assert a loss that did not happen.
    let err = new Error("link0");
    for (let i = 1; i < MAX_ERROR_CAUSE_DEPTH; i++)
      err = new Error(`link${i}`, { cause: err });
    const links = sanitizeErrorForDisplay(err).split("\ncaused by: ");
    expect(links.length).toBe(MAX_ERROR_CAUSE_DEPTH);
    expect(links[links.length - 1]).toBe("link0");
  });

  test("marks nothing when the cycle guard stops a chain at the depth bound", () => {
    // The revisited link was already rendered, so the walk stopping on it drops
    // nothing the operator has not read.
    const head = new Error("link0");
    let err: Error = head;
    for (let i = 1; i < MAX_ERROR_CAUSE_DEPTH; i++)
      err = new Error(`link${i}`, { cause: err });
    head.cause = err;
    expect(sanitizeErrorForDisplay(err)).not.toContain(
      CAUSE_DEPTH_ELISION_MARKER,
    );
  });

  test("marks an elided remainder even on a link that spent its whole budget", () => {
    // The marker rides after the per-link cap, so a link that truncates can still
    // report that the chain went on: the two markers are independent losses and
    // both are stated.
    // Each link holds a distinct message, so none is suppressed as a repeat of
    // the one before it and the walk spends its whole depth budget.
    let err = new Error("innermost");
    for (let i = 1; i < 20; i++)
      err = new Error(
        `${i}` + "w".repeat(COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH * 2),
        { cause: err },
      );
    const links = sanitizeErrorForDisplay(err).split("\ncaused by: ");
    expect(links.length).toBe(MAX_ERROR_CAUSE_DEPTH);
    const cut = `${20 - MAX_ERROR_CAUSE_DEPTH}`;
    expect(links[links.length - 1]).toBe(
      cut +
        "w".repeat(COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH - cut.length) +
        DISPLAY_TRUNCATION_MARKER +
        ` ${CAUSE_DEPTH_ELISION_MARKER}`,
    );
  });

  test("passes a message holding the elision marker's text through as content", () => {
    // The marker is plain printable ASCII, so a partner-controlled message that
    // holds its text meets the escape and the cap as any other content does:
    // nothing about the text is privileged, and nothing marks it as the
    // renderer's own.
    const forged = `partner failure ${CAUSE_DEPTH_ELISION_MARKER}`;
    expect(sanitizeErrorForDisplay(new Error(forged))).toBe(forged);
    // Capped like any other content too: past the budget the marker's text is
    // what the cut takes.
    const flooded = `${"z".repeat(COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH)}${CAUSE_DEPTH_ELISION_MARKER}`;
    expect(sanitizeErrorForDisplay(new Error(flooded))).toBe(
      "z".repeat(COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH) +
        DISPLAY_TRUNCATION_MARKER,
    );
  });

  test("cannot distinguish a copied elision marker from a cut it made itself", () => {
    // The measured limit of the marker: a chain that ends on its own, whose last
    // message ends with the marker's text, renders byte-for-byte as a chain the
    // depth bound really cut. An operator cannot tell the two apart, and no
    // check downstream can either.
    const chain = (messages: string[], tail?: unknown): unknown =>
      messages.reduceRight<unknown>(
        (cause, message) =>
          cause === undefined
            ? new Error(message)
            : new Error(message, { cause }),
        tail,
      );
    const head = Array.from(
      { length: MAX_ERROR_CAUSE_DEPTH - 1 },
      (_unused, index) => `link${index}`,
    );

    const cut = sanitizeErrorForDisplay(
      chain([...head, "partner failure"], new Error("beyond the bound")),
    );
    const forged = sanitizeErrorForDisplay(
      chain([...head, `partner failure ${CAUSE_DEPTH_ELISION_MARKER}`]),
    );
    expect(forged).toBe(cut);
    // Not vacuous: the delivery really did spend the whole depth budget and
    // really was marked.
    expect(cut.split("\ncaused by: ")).toHaveLength(MAX_ERROR_CAUSE_DEPTH);
    expect(cut.endsWith(CAUSE_DEPTH_ELISION_MARKER)).toBe(true);

    // The forgery runs one way only. A copied marker on a chain the bound DOES
    // cut cannot suppress the renderer's own, which is appended after the escape
    // whatever the link held -- so the marker's absence stays critical even
    // though its presence is not.
    const both = sanitizeErrorForDisplay(
      chain(
        [...head, `partner failure ${CAUSE_DEPTH_ELISION_MARKER}`],
        new Error("beyond the bound"),
      ),
    );
    expect(
      both.endsWith(
        `${CAUSE_DEPTH_ELISION_MARKER} ${CAUSE_DEPTH_ELISION_MARKER}`,
      ),
    ).toBe(true);
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

  // The sink's whole guarantee, checked over every position a hostile value
  // can occupy in a chain: composition sites interpolate partner and server
  // bytes raw, so any byte this renderer lets through reaches the operator's
  // terminal unescaped. Only this module's own CAUSE_SEPARATOR newline is a
  // permitted control character; every other non-printable-ASCII byte is a
  // leak. The CLI console sentinel enforces the same predicate at runtime.
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

  describe("private-key redaction safety check", () => {
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

    test("redacts a private key held on a cause-chain link", () => {
      const inner = new Error(
        `-----BEGIN PRIVATE KEY-----\n${KEY_BODY}\n-----END PRIVATE KEY-----`,
      );
      const out = sanitizeErrorForDisplay(
        new Error("write failed", { cause: inner }),
      );
      expect(out).not.toContain(KEY_BODY);
    });

    test("leaves ordinary base64url-shaped values (e.g. fingerprints) intact", () => {
      // The safety check must NOT scrub by shape: a host-key fingerprint is
      // shown to the operator on purpose and shares the shared-secret's
      // character set.
      const fingerprint = "SHA256:abcDEF0123456789_-ghijklmnopqrstuvwxyzABCD";
      expect(
        sanitizeErrorForDisplay(new Error(`host key ${fingerprint}`)),
      ).toContain(fingerprint);
    });

    // A key sliced into an error message holds whatever structure the thing
    // that held it left behind: real line breaks from a file read, spaces from
    // a folded or plain multi-line YAML scalar, or nothing at all from a
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
      // (the replacement has no marker), and neither pass may lengthen the
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

// The re-render boundary: a call site that receives a chain this module
// already rendered, as TEXT, and has to pass it onward or show it (the console
// relay reading the CLI's terminal error, and the console seat that renders
// one). What it must not do is charge the whole chain to one value's cap,
// which cuts the chain inside its first link or two and drops the recovery
// step a later link holds.
describe("sanitizeErrorChainLinks", () => {
  /** A first-party link of `size` printable ASCII characters, ending on `tail`
   * so a cut anywhere in it is visible at the end of the link. */
  function linkOfSize(size: number, tail: string): string {
    return "x".repeat(size - tail.length) + tail;
  }

  test("splits at framing a link's own text cannot forge", () => {
    // The escape runs before the join, so every newline a link's own message
    // holds is escaped and only this module's framing survives as a raw one.
    // A link that spells the separator's text verbatim is therefore one link,
    // not two -- the property the split relies on.
    const forged = "spoofed\ncaused by: injected link";
    const rendered = sanitizeErrorForDisplay(
      new Error(`outer ${forged}`, { cause: new Error("the real cause") }),
    );

    const links = sanitizeErrorChainLinks(rendered);
    expect(links).toHaveLength(2);
    expect(links[0]).toContain("spoofed");
    expect(links[0]).toContain("injected link");
    expect(links[1]).toBe("the real cause");
  });

  test("keeps a chain past the per-value default whole, link by link", () => {
    const RECOVERY = "Re-pin the host key on both sides, then run it again.";
    const rendered = sanitizeErrorForDisplay(
      new Error(linkOfSize(600, "the refusal."), {
        cause: new Error(linkOfSize(600, "what was observed."), {
          cause: new Error(linkOfSize(600, RECOVERY)),
        }),
      }),
    );
    // Driven past the cap a per-value pass would apply.
    expect(rendered.length).toBeGreaterThan(DEFAULT_MAX_DISPLAY_LENGTH);

    const links = sanitizeErrorChainLinks(rendered);
    expect(links).toHaveLength(3);
    expect(
      links.every((link) => !link.includes(DISPLAY_TRUNCATION_MARKER)),
    ).toBe(true);
    // The whole chain survives the re-render, framing and all.
    expect(joinErrorCauseChain(links)).toBe(rendered);
    expect(links[2].endsWith(RECOVERY)).toBe(true);
  });

  test("charges each link its own budget rather than the chain one link's", () => {
    // Two links at the per-link budget: the pass admits both whole, where a cap
    // over the whole chain would have to cut the second.
    const first = linkOfSize(COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH, "first end.");
    const second = linkOfSize(
      COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
      "second end.",
    );
    const links = sanitizeErrorChainLinks(joinErrorCauseChain([first, second]));
    expect(links).toEqual([first, second]);
  });

  test("cuts a link past the per-link budget, and marks the cut", () => {
    const links = sanitizeErrorChainLinks(
      "y".repeat(COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH + 1),
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toBe(
      "y".repeat(COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH) +
        DISPLAY_TRUNCATION_MARKER,
    );
  });

  test("bounds the link count at the renderer's depth and marks the elision", () => {
    // A chain this renderer cannot produce -- more links than the walk's own
    // depth bound -- which is what a subverted source would hand a boundary.
    const overLong = Array.from(
      { length: MAX_ERROR_CAUSE_DEPTH + 3 },
      (_, index) => `link ${index}`,
    );
    const links = sanitizeErrorChainLinks(joinErrorCauseChain(overLong));

    expect(links).toHaveLength(MAX_ERROR_CAUSE_DEPTH);
    expect(links[links.length - 1]).toBe(
      `link ${MAX_ERROR_CAUSE_DEPTH - 1} ${CAUSE_DEPTH_ELISION_MARKER}`,
    );
    expect(joinErrorCauseChain(links)).not.toContain(
      `link ${MAX_ERROR_CAUSE_DEPTH}`,
    );
  });

  test("keeps an arriving elision marker rather than re-cutting it away", () => {
    // The renderer appends the marker PAST the last link's cap, so a link that
    // spent its whole budget arrives over it. Re-escaping the link whole would
    // charge the marker's own characters to that budget and truncate them off,
    // delivering a chain that was cut as one that reads complete -- and the
    // marker's absence is the half an operator can rely on.
    let err = new Error("innermost");
    for (let index = 1; index < MAX_ERROR_CAUSE_DEPTH * 2; index++)
      err = new Error(
        `${index}`.padEnd(COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH * 2, "w"),
        { cause: err },
      );
    const rendered = sanitizeErrorForDisplay(err);
    expect(rendered.endsWith(CAUSE_DEPTH_ELISION_MARKER)).toBe(true);

    const links = sanitizeErrorChainLinks(rendered);
    expect(links).toHaveLength(MAX_ERROR_CAUSE_DEPTH);
    // The link under the marker is unchanged, its own truncation marker included:
    // the two losses are independent and both are still stated.
    expect(links[links.length - 1]).toBe(rendered.split("\ncaused by: ").pop());
    expect(links[links.length - 1]).toContain(DISPLAY_TRUNCATION_MARKER);
  });

  test("re-rendering a marked chain is stable across further boundaries", () => {
    // The relay splits the chain and the seat splits it again, so the pass runs
    // more than once on the same text: a second pass that re-cut the marker
    // would leave the fix holding at one boundary and not at two.
    const last = "y".repeat(COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH);
    const rendered = joinErrorCauseChain([
      "the refusal.",
      `${last} ${CAUSE_DEPTH_ELISION_MARKER}`,
    ]);
    const once = sanitizeErrorChainLinks(rendered);
    expect(once[1]).toBe(`${last} ${CAUSE_DEPTH_ELISION_MARKER}`);
    expect(sanitizeErrorChainLinks(joinErrorCauseChain(once))).toEqual(once);
  });

  test("escapes every link it admits", () => {
    // The sender's own pass is not trusted: a link arriving with raw bytes is
    // escaped here too, in every position of the chain.
    const hostile = "\x1b[31m‮EVIL";
    const links = sanitizeErrorChainLinks(
      joinErrorCauseChain([`head ${hostile}`, `tail ${hostile}`]),
    );
    for (const link of links) {
      expect(link).not.toContain("\x1b");
      expect(link).not.toContain("‮");
      expect(link).toContain("\\x1b");
      expect(link).toContain("\\u202e");
    }
  });

  test("returns a lone message as one link", () => {
    expect(sanitizeErrorChainLinks("no chain here")).toEqual(["no chain here"]);
  });
});

describe("redactAndSanitizeForDisplay", () => {
  const RECOVERY = "Confirm the fingerprint out-of-band before trusting it.";

  test("redacts before escaping, so the display cap cannot strand a marker", () => {
    // The order is the whole contract. Escaping first fits the raw armor to the
    // cap, which cuts the END marker off a block that would otherwise have
    // matched whole -- leaving a dangling marker for the sink's own pass to fail
    // closed on, taking the first-party text behind it. Redacting first replaces
    // the block with something far shorter than the cap, so that text survives.
    const armor = "A".repeat(DEFAULT_MAX_DISPLAY_LENGTH - 80);
    const composed =
      `-----BEGIN OPENSSH PRIVATE KEY-----${armor}` +
      `-----END OPENSSH PRIVATE KEY----- ${RECOVERY}`;

    const out = redactAndSanitizeForDisplay(composed);
    expect(out).toContain("[redacted private key]");
    expect(out).not.toContain(armor.slice(0, 24));
    expect(out).toContain(RECOVERY);

    // Not vacuous: the escape-first order this function exists to prevent loses
    // that recovery text at the same input.
    const escapedFirst = redactPrivateKeyMaterial(sanitizeForDisplay(composed));
    expect(escapedFirst).not.toContain(RECOVERY);
  });

  test("escapes exactly once, so a backslash is doubled and not quadrupled", () => {
    // Redaction is not escaping and must not become a second altitude: a
    // fragment crossing this helper reaches the operator with the same backslash
    // count sanitizeForDisplay alone would give it.
    const fragment = "C:\\keys\\id_ed25519";
    expect(redactAndSanitizeForDisplay(fragment)).toBe(
      sanitizeForDisplay(fragment),
    );
  });

  test("leaves text holding no key material exactly as the escape alone would", () => {
    for (const fragment of ["", "ssh-ed25519", "SHA256:abc/def+ghi="]) {
      expect(redactAndSanitizeForDisplay(fragment)).toBe(
        sanitizeForDisplay(fragment),
      );
    }
  });

  test("honors a caller's display cap", () => {
    expect(redactAndSanitizeForDisplay("x".repeat(50), { maxLength: 10 })).toBe(
      sanitizeForDisplay("x".repeat(50), { maxLength: 10 }),
    );
  });
});

describe("createPrivateKeyStreamRedactor", () => {
  const REDACTION = "[redacted private key]";
  const BEGIN = "-----BEGIN OPENSSH PRIVATE KEY-----";
  const END = "-----END OPENSSH PRIVATE KEY-----";
  const KEY_BODY = "MIIByteslookingsecret0123456789ABCDEFabcdef+/wEHEHE";
  const BLOCK = `${BEGIN}\n${KEY_BODY}\n${END}`;

  /** What the redactor emits for a stream delivered as `chunks`, flush included. */
  function streamed(chunks: Array<string>): string {
    const redactor = createPrivateKeyStreamRedactor();
    return (
      chunks.map((chunk) => redactor.push(chunk)).join("") + redactor.close()
    );
  }

  /** Every two-piece delivery of `text`, split at each offset in turn. */
  function everySplit(text: string): Array<Array<string>> {
    const splits: Array<Array<string>> = [];
    for (let at = 0; at <= text.length; at += 1)
      splits.push([text.slice(0, at), text.slice(at)]);
    return splits;
  }

  test("a block delivered whole becomes one replacement", () => {
    expect(streamed([`loading key: ${BLOCK}\nfailed`])).toBe(
      `loading key: ${REDACTION}\nfailed`,
    );
  });

  test("a block split at every offset renders as the whole delivery does", () => {
    // Every offset includes each position inside the BEGIN and END markers,
    // which is the delivery boundary the held-back lookahead exists for.
    const text = `loading key: ${BLOCK}\nfailed`;
    const whole = streamed([text]);
    for (const chunks of everySplit(text))
      expect(streamed(chunks), chunks[0]).toBe(whole);
  });

  test("a block delivered one code unit at a time renders the same", () => {
    const text = `loading key: ${BLOCK}\nfailed`;
    expect(streamed(Array.from(text))).toBe(streamed([text]));
  });

  test("a BEGIN marker with no END stays redacted through the close", () => {
    const text = `${BEGIN}\n${KEY_BODY}\nand the run's last words`;
    for (const chunks of everySplit(text))
      expect(streamed(chunks)).toBe(REDACTION);
  });

  test("an END marker with no BEGIN deletes nothing before it", () => {
    const text = `the run's own words ${END} and the words after`;
    for (const chunks of everySplit(text)) expect(streamed(chunks)).toBe(text);
  });

  test("several blocks in one stream each cost one replacement", () => {
    const text = `one ${BLOCK} two ${BLOCK} three`;
    for (const chunks of everySplit(text))
      expect(streamed(chunks)).toBe(`one ${REDACTION} two ${REDACTION} three`);
  });

  test("text holding no marker passes through byte-identical", () => {
    for (const text of [
      "",
      "exchange failed: connection reset",
      "C:\\keys\\id_ed25519 is world-readable",
      "SHA256:abc/def+ghi=",
    ])
      for (const chunks of everySplit(text))
        expect(streamed(chunks)).toBe(text);
  });

  test("text ending in a partial marker is flushed whole on close", () => {
    // The held-back lookahead is what a partial marker sits in, so a stream
    // that simply stops mid-marker must still deliver the operator's bytes.
    for (let kept = 0; kept < BEGIN.length; kept += 1) {
      const text = `the run stopped here: ${BEGIN.slice(0, kept)}`;
      expect(streamed([text]), text).toBe(text);
      expect(streamed(Array.from(text)), text).toBe(text);
    }
  });

  test("a body longer than any one delivery leaves no byte of itself", () => {
    const body = Array.from(
      { length: 400 },
      (_, line) => `line${line}${KEY_BODY}`,
    ).join("\n");
    const redactor = createPrivateKeyStreamRedactor();
    const emitted: Array<string> = [];
    emitted.push(redactor.push(`starting\n${BEGIN}\n`));
    for (let at = 0; at < body.length; at += 97)
      emitted.push(redactor.push(body.slice(at, at + 97)));
    emitted.push(redactor.push(`\n${END}\nstopped`));
    emitted.push(redactor.close());
    expect(emitted.join("")).toBe(`starting\n${REDACTION}\nstopped`);
    for (const piece of emitted) expect(piece).not.toContain(KEY_BODY);
  });

  test("the stream agrees with the whole-text pass on what it strips", () => {
    for (const text of [
      `loading key: ${BLOCK}`,
      `${BEGIN}\n${KEY_BODY}`,
      `a ${END} b`,
      `${BLOCK} then ${BLOCK}`,
      "no markers at all",
    ])
      expect(streamed([text]), text).toBe(redactPrivateKeyMaterial(text));
  });

  test("a marker whose label runs long is still stripped inside one delivery", () => {
    const label = "X".repeat(200);
    const text = `-----BEGIN ${label} PRIVATE KEY-----\n${KEY_BODY}\n-----END ${label} PRIVATE KEY-----`;
    expect(streamed([text])).toBe(REDACTION);
  });
});
