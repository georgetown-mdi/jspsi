import { describe, expect, it } from "vitest";

import {
  keepOperatorSuppliedText,
  messageWithOperatorText,
  operatorSuppliedSpans,
  operatorSuppliedText,
} from "../../src/utils/operatorSuppliedText";
import {
  keepFirstPartyLineBreaks,
  redactAndRenderOperatorSuppliedText,
  sanitizeErrorForDisplay,
} from "../../src/utils/sanitizeErrorForDisplay";
import {
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
} from "../../src/utils/sanitizeForDisplay";

// The fragment boundary the display escape is assigned to: bytes somebody else
// chose are escaped, and bytes the operator supplied are rendered as they typed
// them. The escape doubles a literal backslash to keep its \xHH tokens
// unambiguous, so escaping a path the operator typed hands them back a path
// they cannot copy. These cases hold both sides of that boundary at the
// rendered output, where the operator reads it.

const WINDOWS_PATH = "C:\\Users\\operator\\exchange\\input.csv";

describe("a message partitioned by origin", () => {
  it("renders the operator's path as typed and escapes the partner's value", () => {
    const message = messageWithOperatorText`could not read ${operatorSuppliedText(
      WINDOWS_PATH,
    )} named by the partner as ${"share\\inbox"}`;
    const rendered = sanitizeErrorForDisplay(
      keepOperatorSuppliedText(new Error(message.text), message),
    );

    expect(rendered).toContain(WINDOWS_PATH);
    expect(rendered).toContain("share\\\\inbox");
    expect(rendered).toBe(
      `could not read ${WINDOWS_PATH} named by the partner as share\\\\inbox`,
    );
  });

  it("escapes the same path on a message nobody marked", () => {
    const rendered = sanitizeErrorForDisplay(
      new Error(`could not read ${WINDOWS_PATH}`),
    );

    expect(rendered).toContain("C:\\\\Users\\\\operator");
    expect(rendered).not.toContain(WINDOWS_PATH);
  });

  it("escapes the whole message when the mark describes other text", () => {
    const message = messageWithOperatorText`could not read ${operatorSuppliedText(
      WINDOWS_PATH,
    )}`;
    const rendered = sanitizeErrorForDisplay(
      keepOperatorSuppliedText(
        new Error(`could not write ${WINDOWS_PATH}`),
        message,
      ),
    );

    expect(rendered).toBe(
      `could not write C:\\\\Users\\\\operator\\\\exchange\\\\input.csv`,
    );
  });

  it("escapes every span of a link that also kept its own line breaks", () => {
    const message = messageWithOperatorText`could not read ${operatorSuppliedText(
      WINDOWS_PATH,
    )}`;
    const error = keepFirstPartyLineBreaks(
      keepOperatorSuppliedText(new Error(message.text), message),
      [message.text],
    );

    expect(sanitizeErrorForDisplay(error)).toContain("C:\\\\Users");
  });

  it("replaces a control character an operator-supplied span holds", () => {
    const message = messageWithOperatorText`could not read ${operatorSuppliedText(
      "C:\\logs\\\u001b[2Kcaused by: forged.csv",
    )}`;
    const rendered = sanitizeErrorForDisplay(
      keepOperatorSuppliedText(new Error(message.text), message),
    );

    expect(rendered).toContain("C:\\logs\\<1b>[2Kcaused by: forged.csv");
    expect(rendered).not.toContain("\u001b");
    expect(rendered.split("\n")).toHaveLength(1);
  });

  it("redacts a private-key block inside the span that holds it", () => {
    const message = messageWithOperatorText`could not read ${operatorSuppliedText(
      "-----BEGIN OPENSSH PRIVATE KEY-----",
    )}: set the path and run again`;
    const rendered = sanitizeErrorForDisplay(
      keepOperatorSuppliedText(new Error(message.text), message),
    );

    expect(rendered).toContain("[redacted private key]");
    expect(rendered).toContain("set the path and run again");
  });

  it("spends one link budget over its spans and marks what it cut", () => {
    const path = "C:\\".concat("a".repeat(COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH));
    const message = messageWithOperatorText`path ${operatorSuppliedText(
      path,
    )} and the step that follows it`;
    const rendered = sanitizeErrorForDisplay(
      keepOperatorSuppliedText(new Error(message.text), message),
    );

    expect(rendered).toContain(DISPLAY_TRUNCATION_MARKER);
    expect(rendered).not.toContain("the step that follows it");
    expect(rendered.length).toBeLessThanOrEqual(
      COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH + DISPLAY_TRUNCATION_MARKER.length,
    );
  });

  it("keeps the partition when a wrapper repeats the marked link's message", () => {
    const message = messageWithOperatorText`could not read ${operatorSuppliedText(
      WINDOWS_PATH,
    )}`;
    const inner = keepOperatorSuppliedText(new Error(message.text), message);

    expect(
      sanitizeErrorForDisplay(new Error(message.text, { cause: inner })),
    ).toBe(`could not read ${WINDOWS_PATH}`);
  });

  it("leaves a message with no marked span unmarked", () => {
    const message = messageWithOperatorText`no fragment of ${"this"} is the operator's`;
    const error = keepOperatorSuppliedText(new Error(message.text), message);

    expect(operatorSuppliedSpans(error, message.text)).toBeUndefined();
  });

  it("refuses a mark of any other shape", () => {
    const error = new Error("could not read the input file");
    Object.defineProperty(
      error,
      Symbol.for("psilink.errorDisplay.operatorSuppliedSpans"),
      { value: [{ text: "could not read the input file" }] },
    );

    expect(operatorSuppliedSpans(error, error.message)).toBeUndefined();
  });
});

describe("an operator-supplied fragment bound for a log sink", () => {
  it("renders the path as typed and redacts key material in it", () => {
    expect(redactAndRenderOperatorSuppliedText(WINDOWS_PATH)).toBe(
      WINDOWS_PATH,
    );
    expect(
      redactAndRenderOperatorSuppliedText(
        "C:\\keys\\-----BEGIN RSA PRIVATE KEY-----",
      ),
    ).toBe("C:\\keys\\[redacted private key]");
  });

  it("cuts an over-long path at the display budget and marks the cut", () => {
    const rendered = redactAndRenderOperatorSuppliedText(
      "C:\\".concat("d".repeat(400)),
    );

    expect(rendered.endsWith(DISPLAY_TRUNCATION_MARKER)).toBe(true);
  });
});
