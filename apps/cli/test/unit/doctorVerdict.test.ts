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
import type { DoctorCheckRecord, DoctorReport } from "../../src/doctor/verdict";

function report(checks: DoctorCheckRecord[]): DoctorReport {
  return { mode: "probe", checks };
}

describe("the JSON verdict is the launcher-facing contract", () => {
  test("carries exactly version, mode, overall, and the check list", () => {
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

  test("a check carries only id, status, and any meaning/action", () => {
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
  // redaction matches carries spaces, so a marker split across two rendered
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
    expect(text).toContain("the credentials were refused.");
  });
});
