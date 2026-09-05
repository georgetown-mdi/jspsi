import { describe, expect, test } from "vitest";

import {
  DOCTOR_EXIT_CODE,
  DOCTOR_VERDICT_VERSION,
  clampDetail,
  overallOf,
  verdictJson,
  verdictLines,
  verdictOf,
} from "../../src/doctor/verdict";
import type {
  DoctorCheck,
  DoctorCheckRecord,
  DoctorReport,
} from "../../src/doctor/verdict";

function report(checks: DoctorCheckRecord[]): DoctorReport {
  return { mode: "probe", checks };
}

describe("the JSON verdict is the launcher-facing contract", () => {
  test("has exactly version, mode, overall, and the check list", () => {
    const parsed = JSON.parse(
      verdictJson(report([{ id: "tcp_445", status: "ok", summary: "open." }])),
    ) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      "checks",
      "mode",
      "overall",
      "version",
    ]);
    expect(parsed["version"]).toBe(DOCTOR_VERDICT_VERSION);
    expect(parsed["mode"]).toBe("probe");
  });

  test("a check has only id, status, and any meaning/action", () => {
    // summary, detail, and blocksRun exist for the human rendering and for the
    // roll-up; a consumer must not start depending on them through the JSON.
    const [check] = verdictOf(
      report([
        {
          id: "write",
          status: "fail",
          summary: "could not create a file.",
          meaning: "read but not write.",
          action: "ask for write permission.",
          detail: "NT_STATUS_ACCESS_DENIED opening remote file",
          blocksRun: true,
        },
      ]),
    ).checks;
    expect(check).toEqual({
      id: "write",
      status: "fail",
      meaning: "read but not write.",
      action: "ask for write permission.",
    });
  });

  test("omits meaning and action rather than emitting null", () => {
    const [check] = verdictOf(
      report([{ id: "tcp_445", status: "ok", summary: "open." }]),
    ).checks;
    expect(check).toEqual({ id: "tcp_445", status: "ok" });
  });

  test("server-controlled bytes in a meaning stay inside a JSON string", () => {
    const line = verdictJson(
      report([
        {
          id: "share_open",
          status: "fail",
          summary: "refused.",
          meaning: `share '\u001b]0;x\u0007' refused`,
          action: "ask.",
        },
      ]),
    );
    expect(line).not.toContain(String.fromCharCode(0x1b));
    expect(line.split("\n")).toHaveLength(1);
  });

  test("an annotated DoctorCheck literal rejects a human-only field", () => {
    // Each of the three fields that exist only for the human rendering, pinned
    // in the position where excess-property checking is in reach: an annotated
    // literal, which is the shape verdictOf's own `satisfies DoctorCheck` puts
    // its map callback in. An unnecessary directive is itself a typecheck
    // failure, so a shape that started admitting one of these stops this
    // passing.
    // @ts-expect-error a check object has no summary
    const withSummary: DoctorCheck = { id: "a", status: "ok", summary: "s" };
    // @ts-expect-error a check object has no detail
    const withDetail: DoctorCheck = { id: "b", status: "ok", detail: "d" };
    // @ts-expect-error a check object has no blocksRun
    const withBlocks: DoctorCheck = { id: "c", status: "ok", blocksRun: true };
    expect([withSummary.id, withDetail.id, withBlocks.id]).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

describe("the JSON verdict line is printable ASCII", () => {
  // A launcher that cannot classify a line prints it -- to a terminal, or into
  // a log a person later reads -- and a check's meaning and action interpolate
  // the operator's own SMB_* values, which readSmbProbeInput validates only
  // against the C0 controls and DEL. The line has to be safe as BYTES, which
  // bare JSON.stringify does not guarantee: it escapes U+0000-U+001F, the quote
  // and the backslash, but passes DEL, the C1 range, and U+2028/U+2029 through.
  const DEL = String.fromCharCode(0x7f);
  const C1_CSI = String.fromCharCode(0x9b);
  const PRINTABLE_ASCII_ONLY = /^[\x20-\x7e]*$/;

  function lineWith(meaning: string, action: string): string {
    return verdictJson(
      report([
        {
          id: "subdirectory",
          status: "fail",
          summary: "the subfolder would not open.",
          meaning,
          action,
        },
      ]),
    );
  }

  test("a DEL and a C1 byte in a meaning are escaped, not passed through", () => {
    const meaning = `'a${DEL}b${C1_CSI}c' names a file, not a folder.`;
    // The assumption, driven rather than asserted in prose.
    const bare = JSON.stringify({ meaning });
    expect(bare).toContain(DEL);
    expect(bare).toContain(C1_CSI);

    const line = lineWith(meaning, "give the folder, not a file in it.");
    expect(line).toContain(
      `"meaning":"'a\\u007fb\\u009bc' names a file, not a folder."`,
    );
    expect(PRINTABLE_ASCII_ONLY.test(line)).toBe(true);
  });

  test("an action containing the same bytes is escaped the same way", () => {
    const line = lineWith("m", `check ${DEL}${C1_CSI} and run this again.`);
    expect(line).toContain(
      `"action":"check \\u007f\\u009b and run this again."`,
    );
    expect(PRINTABLE_ASCII_ONLY.test(line)).toBe(true);
  });

  test("a bidi override, an astral pair and U+2028 cross as printable ASCII", () => {
    // None of the three is a latin1 byte, so the sweep below does not reach
    // them, and each survives bare JSON.stringify: the bidi override reorders
    // whatever a terminal prints after it, U+2028 terminates a line for a
    // consumer reading the stream as JavaScript, and an astral character is a
    // surrogate pair the encoder has to escape as code units to stay parseable.
    const RLO = "\u202e";
    const ASTRAL = "\u{1f600}";
    const LINE_SEPARATOR = "\u2028";
    const meaning = `'q3${RLO}fdp${ASTRAL}${LINE_SEPARATOR}x' names a file, not a folder.`;
    const bare = JSON.stringify({ meaning });
    for (const raw of [RLO, ASTRAL, LINE_SEPARATOR])
      expect(bare).toContain(raw);

    const line = lineWith(meaning, `rename it ${RLO}${ASTRAL} and try again.`);
    expect(PRINTABLE_ASCII_ONLY.test(line)).toBe(true);
    expect(line).toContain("\\u202e");
    expect(line).toContain("\\ud83d\\ude00");
    expect(line).toContain("\\u2028");
  });

  test("every byte of latin1 crosses as printable ASCII on one line", () => {
    const everyByte = Array.from({ length: 256 }, (_, code) =>
      String.fromCharCode(code),
    ).join("");
    const line = lineWith(everyByte, everyByte);
    expect(PRINTABLE_ASCII_ONLY.test(line)).toBe(true);
    expect(line.split("\n")).toHaveLength(1);
  });

  test("the document a consumer parses back is unchanged by the encoding", () => {
    // The escapes are JSON's own, so the keys, the value types and the parsed
    // values are what JSON.stringify alone would have produced: nothing here for
    // a launcher's own display escape to double.
    const built = report([
      { id: "tcp_445", status: "ok", summary: "open." },
      {
        id: "subdirectory",
        status: "fail",
        summary: "refused.",
        meaning: `'x${DEL} y${C1_CSI}' names a file, not a folder.`,
        action: `back\\slash "quote" \u{1f600}`,
        detail: "NT_STATUS_ACCESS_DENIED",
      },
    ]);
    expect(JSON.parse(verdictJson(built))).toEqual(
      JSON.parse(JSON.stringify(verdictOf(built))),
    );
  });
});

describe("the overall verdict rolls the checks up", () => {
  test("ok when nothing failed, skipped checks included", () => {
    expect(
      overallOf(
        report([
          { id: "a", status: "ok", summary: "" },
          { id: "b", status: "skipped", summary: "" },
        ]),
      ),
    ).toBe("ok");
  });

  test("a warn does not move the verdict off ok, in the JSON or the exit code", () => {
    const warned = report([
      { id: "a", status: "ok", summary: "" },
      {
        id: "b",
        status: "warn",
        summary: "",
        meaning: "nearly out of space.",
        action: "ask for more quota.",
      },
    ]);
    const verdict = verdictOf(warned);
    expect(verdict.overall).toBe("ok");
    expect(verdict.checks[1]).toEqual({
      id: "b",
      status: "warn",
      meaning: "nearly out of space.",
      action: "ask for more quota.",
    });
    expect(DOCTOR_EXIT_CODE[verdict.overall]).toBe(0);
  });

  test("an ordinary failure is fix_and_retry", () => {
    expect(overallOf(report([{ id: "a", status: "fail", summary: "" }]))).toBe(
      "fix_and_retry",
    );
  });

  test("a failure that stopped the run outranks one it returned a verdict on", () => {
    expect(
      overallOf(
        report([
          { id: "a", status: "fail", summary: "" },
          { id: "b", status: "fail", summary: "", blocksRun: true },
        ]),
      ),
    ).toBe("fatal");
  });
});

describe("exit codes are a closed set below Docker's reserved range", () => {
  test("0 for ok and a distinct nonzero code for each failure verdict", () => {
    expect(DOCTOR_EXIT_CODE.ok).toBe(0);
    const codes = Object.values(DOCTOR_EXIT_CODE);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toBeLessThan(125);
  });
});

describe("the human rendering", () => {
  test("labels a passing check that still asks something of the operator WARN", () => {
    const lines = verdictLines(
      report([
        {
          id: "rename_onto_existing",
          status: "warn",
          summary: "will not rename onto an existing file.",
          meaning: "psilink does that when two sides meet at once.",
          action: "pass --lockless-rendezvous on BOTH sides.",
        },
      ]),
    );
    expect(lines[0]).toBe("WARN: will not rename onto an existing file.");
    expect(lines.join("\n")).toContain("MEANING: ");
    expect(lines.join("\n")).toContain("ACTION:  ");
  });

  test("labels a plain pass OK, a failure FAIL, and an unrun check SKIP", () => {
    const lines = verdictLines(
      report([
        { id: "a", status: "ok", summary: "fine." },
        {
          id: "b",
          status: "fail",
          summary: "broken.",
          meaning: "m",
          action: "a",
        },
        { id: "c", status: "skipped", summary: "not run." },
      ]),
    );
    expect(lines[0]).toBe("OK: fine.");
    expect(lines[1]).toBe("FAIL: broken.");
    expect(lines).toContain("SKIP: not run.");
  });

  test("closes with a verdict line naming what to do next", () => {
    expect(
      verdictLines(report([{ id: "a", status: "ok", summary: "" }])).at(-1),
    ).toBe("ALL CHECKS PASSED");
    expect(
      verdictLines(report([{ id: "a", status: "fail", summary: "" }])).at(-1),
    ).toContain("NOT READY YET");
    expect(
      verdictLines(
        report([{ id: "a", status: "fail", summary: "", blocksRun: true }]),
      ).at(-1),
    ).toContain("COULD NOT RUN");
  });

  test("wraps a long meaning under its label rather than emitting one long line", () => {
    const lines = verdictLines(
      report([
        {
          id: "a",
          status: "fail",
          summary: "s",
          meaning: "word ".repeat(60).trim(),
          action: "a",
        },
      ]),
    );
    const meaningLines = lines.filter((line) => /^(MEANING: | {9})/.test(line));
    expect(meaningLines.length).toBeGreaterThan(1);
    for (const line of meaningLines)
      expect(line.length).toBeLessThanOrEqual(80);
  });
});

describe("tool output behind a failure is bounded", () => {
  test("caps the number of lines and says it truncated", () => {
    const clamped = clampDetail(
      Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"),
    );
    expect(clamped.length).toBeLessThan(200);
    expect(clamped.at(-1)).toContain("truncated");
  });

  test("caps a single enormous line", () => {
    const clamped = clampDetail("x".repeat(50_000));
    expect(clamped.join("").length).toBeLessThan(50_000);
    expect(clamped.at(-1)).toContain("truncated");
  });

  test("leaves short output alone", () => {
    expect(clampDetail("NT_STATUS_ACCESS_DENIED\n")).toEqual([
      "NT_STATUS_ACCESS_DENIED",
    ]);
  });

  test("replaces a whole multi-line key block from the tool output", () => {
    // The tool hands the block over in its canonical form, with real newlines.
    // Splitting before redacting would leave a marker on the BEGIN line alone
    // and render every body line verbatim; the per-rendered-line pass the sink
    // applies afterwards sees one line at a time and so cannot catch the body.
    const clamped = clampDetail(
      "smbclient said:\n" +
        "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
        "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAA\n" +
        "SECRETBODYSECRETBODYSECRETBODYSECRETBODYSECRETBO\n" +
        "-----END OPENSSH PRIVATE KEY-----\n" +
        "end of output",
    );
    const rendered = clamped.join("\n");
    expect(rendered).toContain("[redacted private key]");
    expect(rendered).not.toContain("SECRETBODY");
    expect(rendered).not.toContain("b3BlbnNzaC1rZXktdjEA");
    expect(rendered).not.toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(rendered).toContain("smbclient said:");
  });

  test("replacing a block does not by itself report the output as truncated", () => {
    // The bound is measured against the stripped text: the replacement is
    // shorter than the marker it stands in for, so measuring the raw input
    // would tell the operator their output was cut whenever a block was
    // replaced -- and they are asked to pass that rendering on.
    const clamped = clampDetail(
      "hello\n" +
        "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
        "SECRETBODY\n" +
        "-----END OPENSSH PRIVATE KEY-----\n" +
        "bye",
    );
    expect(clamped).toEqual(["hello", "[redacted private key]", "bye"]);
  });

  test("a dangling key marker takes the rest of the tool output, not the check's own text", () => {
    const lines = verdictLines(
      report([
        {
          id: "smb_mount",
          status: "fail",
          summary: "the share did not mount.",
          detail: "-----BEGIN RSA PRIVATE KEY-----\nMIIEow" + "A".repeat(40),
          meaning: "the credentials were refused.",
          action: "check the password file and run this again.",
        },
      ]),
    ).join("\n");
    expect(lines).toContain("[redacted private key]");
    expect(lines).not.toContain("MIIEow");
    expect(lines).toContain("the credentials were refused.");
    expect(lines).toContain("check the password file and run this again.");
  });
});

describe("a key marker straddling the MEANING/ACTION wrap", () => {
  // The wrap re-flows on whitespace at 76 columns and every marker the
  // redaction matches has spaces, so a marker split across two rendered
  // lines matches neither of them: the pass ahead of the re-flow is what these
  // pin, at the lines the rendering hands its sink.
  const KEY_MARKER = "-----BEGIN RSA PRIVATE KEY-----";
  // Word for word the same lengths as KEY_MARKER and matched by no redaction
  // pattern, so rendering it at the same offset shows where the wrap falls --
  // making the straddle below a measured property rather than an assumption.
  const WRAP_GAUGE = "-----AAAAA BBB CCCCCCC DDD-----";
  // Leaves the line at 58 columns under the 9-column MEANING label, where the
  // first two words of either run fit and the third does not.
  const PADDING = "word ".repeat(10);

  function renderedWith(
    meaning: string,
    action: string,
  ): { lines: string[]; text: string; flowed: string } {
    const lines = verdictLines(
      report([
        {
          id: "share_open",
          status: "fail",
          summary: "the share would not open.",
          meaning,
          action,
        },
      ]),
    );
    // The replacement is prose to the wrap like any other phrase, so it can
    // itself be broken across two rendered lines; `flowed` reads the block back
    // as the operator reads it, and `text` is what the sink is handed.
    return {
      lines,
      text: lines.join("\n"),
      flowed: lines.join(" ").replace(/\s+/g, " "),
    };
  }

  test("the wrap falls inside a run of the marker's shape", () => {
    const { lines } = renderedWith(PADDING + WRAP_GAUGE, "a");
    expect(
      lines.filter(
        (line) => line.includes("-----AAAAA") || line.includes("DDD-----"),
      ),
    ).toHaveLength(2);
  });

  test("a marker in a MEANING is replaced, taking the rest of that block", () => {
    const { text, flowed } = renderedWith(
      PADDING + KEY_MARKER + " SECRETBODYSECRETBODY",
      "check the password file and run this again.",
    );
    expect(flowed).toContain("[redacted private key]");
    expect(text).not.toContain("BEGIN");
    expect(text).not.toContain("SECRETBODY");
    // The label is composed outside the redacted text and ACTION is a block of
    // its own, so the fail-closed replacement reaches neither.
    expect(text).toContain("MEANING: ");
    expect(text).toContain("check the password file and run this again.");
    expect(text).toContain("FAIL: the share would not open.");
  });

  test("a marker in an ACTION does not cost the MEANING composed before it", () => {
    const { text, flowed } = renderedWith(
      "the credentials were refused.",
      PADDING + KEY_MARKER + " SECRETBODYSECRETBODY",
    );
    expect(flowed).toContain("[redacted private key]");
    expect(text).not.toContain("BEGIN");
    expect(text).not.toContain("SECRETBODY");
    expect(text).toContain("ACTION:  ");
    expect(text).toContain("the credentials were refused.");
  });

  test("a marker with non-ASCII internal whitespace is redacted, not re-formed by the re-flow", () => {
    // The re-flow collapses every whitespace class to ASCII spaces, so a
    // marker written with U+00A0 separators -- which the raw-text redaction
    // pattern does not match -- becomes a live marker exactly when redaction
    // runs on the pre-normalization text. Redaction over the normalized text
    // is what this pins.
    const { text, flowed } = renderedWith(
      PADDING + KEY_MARKER.replaceAll(" ", "\u00a0") + " SECRETBODYSECRETBODY",
      "check the password file and run this again.",
    );
    expect(flowed).toContain("[redacted private key]");
    expect(text).not.toContain("BEGIN");
    expect(text).not.toContain("SECRETBODY");
    expect(text).toContain("MEANING: ");
    expect(text).toContain("check the password file and run this again.");
  });
});
