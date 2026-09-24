import { describe, expect, it } from "vitest";

import {
  keepOperatorSuppliedText,
  messageWithOperatorText,
  type MessageWithOperatorText,
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
  operatorDisplayMarker,
  renderOperatorSuppliedText,
} from "../../src/utils/sanitizeForDisplay";
import { partnerOriginText } from "../../src/utils/partnerOriginText";

// The fragment boundary the display escape is assigned to: bytes somebody else
// chose are escaped, and bytes the operator supplied are rendered as they typed
// them. The escape doubles a literal backslash to keep its \xHH tokens
// unambiguous, so escaping a path the operator typed hands them back a path
// they cannot copy. These cases hold both sides of that boundary at the
// rendered output, where the operator reads it.

const WINDOWS_PATH = "C:\\Users\\operator\\exchange\\input.csv";
/** The same path as a fragment nobody marked reaches the operator. */
const ESCAPED_WINDOWS_PATH = WINDOWS_PATH.replaceAll("\\", "\\\\");

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

  it("keeps the origins of a message composed into another message", () => {
    // A label one call site partitioned -- the file label the sensitive-parse
    // chokepoint reports -- interpolates as its own spans, so the path inside
    // it stays the operator's rather than flattening to escaped text.
    const label = messageWithOperatorText`config file ${operatorSuppliedText(
      WINDOWS_PATH,
    )}`;
    const message = messageWithOperatorText`${label} could not be parsed as YAML`;

    expect(message.text).toBe(
      `config file ${WINDOWS_PATH} could not be parsed as YAML`,
    );
    expect(
      sanitizeErrorForDisplay(
        keepOperatorSuppliedText(new Error(message.text), message),
      ),
    ).toBe(`config file ${WINDOWS_PATH} could not be parsed as YAML`);
  });

  it("escapes a nested message's unmarked spans", () => {
    const label = messageWithOperatorText`entry ${"share\\inbox"}`;
    const message = messageWithOperatorText`${label} is unreadable`;

    expect(
      sanitizeErrorForDisplay(
        keepOperatorSuppliedText(new Error(message.text), message),
      ),
    ).toBe("entry share\\\\inbox is unreadable");
  });

  it("escapes a parsed value spelling the shape of a composed message", () => {
    // What tells a composed message is the brand messageWithOperatorText puts
    // on what it returns, a symbol-keyed property no parse produces -- so a
    // value that spells the shape claims origins it does not hold, and its
    // text is escaped like any fragment nobody marked.
    const forged = JSON.parse(
      JSON.stringify({
        text: WINDOWS_PATH,
        spans: [{ text: WINDOWS_PATH, operatorSupplied: true }],
      }),
    ) as MessageWithOperatorText;
    const message = messageWithOperatorText`could not read ${forged}`;

    expect(message.spans).toStrictEqual([
      { text: "could not read ", operatorSupplied: false },
      { text: WINDOWS_PATH, operatorSupplied: false },
    ]);
    expect(
      sanitizeErrorForDisplay(
        keepOperatorSuppliedText(new Error(message.text), message),
      ),
    ).toBe(`could not read ${ESCAPED_WINDOWS_PATH}`);
  });

  it("escapes a value inheriting the composed shape from its prototype", () => {
    // The brand and the fields are read as OWN properties: a message in a
    // value's prototype chain must not lend the treatment to everything built
    // from it.
    const lending = messageWithOperatorText`config file ${operatorSuppliedText(
      WINDOWS_PATH,
    )}`;
    const inheriting = Object.create(lending) as MessageWithOperatorText;
    const message = messageWithOperatorText`${inheriting} could not be read`;

    expect(
      sanitizeErrorForDisplay(
        keepOperatorSuppliedText(new Error(message.text), message),
      ),
    ).toBe(`config file ${ESCAPED_WINDOWS_PATH} could not be read`);
  });

  it("escapes the text of a message whose spans no longer join it", () => {
    // A message this module composed and something edited afterwards: the
    // spans no longer describe the text, so they are not honoured -- and what
    // the operator reads is still the diagnosis, escaped, rather than a value
    // naming nothing they can act on.
    const edited = messageWithOperatorText`config file ${operatorSuppliedText(
      WINDOWS_PATH,
    )}`;
    (edited as { text: string }).text = `config file ${WINDOWS_PATH} (edited)`;

    const message = messageWithOperatorText`${edited} could not be read`;

    expect(message.spans).toStrictEqual([
      {
        text: `config file ${WINDOWS_PATH} (edited)`,
        operatorSupplied: false,
      },
      { text: " could not be read", operatorSupplied: false },
    ]);
  });

  it("holds an object it can read no text off as [object Object]", () => {
    const spansOnly = { spans: [] } as unknown as MessageWithOperatorText;

    expect(messageWithOperatorText`could not read ${spansOnly}`.text).toBe(
      "could not read [object Object]",
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
      Symbol.for("alcove.errorDisplay.operatorSuppliedSpans"),
      { value: [{ text: "could not read the input file" }] },
    );

    expect(operatorSuppliedSpans(error, error.message)).toBeUndefined();
  });

  it("reads a well-shaped mark under the registered symbol", () => {
    // The symbol is registered so a mark another copy of this module wrote is
    // read here, and what that buys any holder of the symbol is the same
    // treatment: shape and join are checked, provenance is not.
    const error = new Error(`could not read ${WINDOWS_PATH}`);
    Object.defineProperty(
      error,
      Symbol.for("alcove.errorDisplay.operatorSuppliedSpans"),
      {
        value: [
          { text: "could not read ", operatorSupplied: false },
          { text: WINDOWS_PATH, operatorSupplied: true },
        ],
      },
    );

    expect(sanitizeErrorForDisplay(error)).toBe(
      `could not read ${WINDOWS_PATH}`,
    );
  });
});

describe("an operator-supplied fragment bound for a log sink", () => {
  it("renders the path as typed and redacts key material in it", () => {
    expect(
      redactAndRenderOperatorSuppliedText(operatorSuppliedText(WINDOWS_PATH)),
    ).toBe(WINDOWS_PATH);
    expect(
      redactAndRenderOperatorSuppliedText(
        operatorSuppliedText("C:\\keys\\-----BEGIN RSA PRIVATE KEY-----"),
      ),
    ).toBe("C:\\keys\\[redacted private key]");
  });

  it("cuts an over-long path at the display budget and marks the cut", () => {
    const rendered = redactAndRenderOperatorSuppliedText(
      operatorSuppliedText("C:\\".concat("d".repeat(400))),
    );

    expect(rendered.endsWith(DISPLAY_TRUNCATION_MARKER)).toBe(true);
  });

  // The gate on this route is the parameter type, not a reviewer reading the
  // call site: `npm run typecheck` runs these, and an `@ts-expect-error` over
  // a line that compiles is itself an error, so a signature that stopped
  // refusing one of these forms fails the build. The expressions still RUN
  // under vitest, which transpiles without checking, so each one also measures
  // what an unmarked value gets if it reaches the renderer anyway.
  it("refuses an unmarked value, and escapes one that arrives regardless", () => {
    const fromPartner = partnerOriginText(WINDOWS_PATH);
    const escaped = "C:\\\\Users\\\\operator\\\\exchange\\\\input.csv";

    // @ts-expect-error a plain string does not say who chose its bytes
    const plain = redactAndRenderOperatorSuppliedText(WINDOWS_PATH);
    // @ts-expect-error the partner's mark is not the operator's
    const partner = redactAndRenderOperatorSuppliedText(fromPartner);
    // @ts-expect-error the render behind it refuses the same forms
    const rendered = renderOperatorSuppliedText(WINDOWS_PATH);

    expect(plain).toBe(escaped);
    expect(partner).toBe(escaped);
    expect(rendered).toBe(escaped);
  });

  it("replaces a line separator and a lone surrogate in the path", () => {
    const path = `C:\\logs\\\u2028run\ud83d.csv`;

    expect(
      redactAndRenderOperatorSuppliedText(operatorSuppliedText(path)),
    ).toBe(
      `C:\\logs\\${operatorDisplayMarker(0x2028)}run${operatorDisplayMarker(
        0xd83d,
      )}.csv`,
    );
  });
});
