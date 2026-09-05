import { describe, expect, it } from "vitest";
import {
  parseFile,
  parseSource,
  sourceModules,
} from "./lib/typeScriptSources.mjs";
import {
  FAILURE_TYPE_FILE,
  FAILURE_TYPE_NAME,
  SINK_COMPONENT_FILE,
  SINK_COMPONENT_NAME,
  WEB_SOURCE_DIR,
  declaresType,
  exportsFunction,
  failureBindingNames,
  failureMessageRenders,
} from "./check-run-failure-sink.mjs";

const rendersIn = (source, file = "fixture.tsx") =>
  failureMessageRenders(parseSource(file, source));

const bindingsIn = (source, file = "fixture.tsx") =>
  failureBindingNames(parseSource(file, source));

/** A component rendering a failure through the sink, as the two real call
 * sites do. */
const THROUGH_THE_SINK = `
export function Alerted({ failure }: { failure: RunFailure }) {
  return <Alert title={failure.title}><FailureMessage message={failure.message} /></Alert>;
}
`;

/** The regression the check exists for: an alert styling its own pre-line span
 * around the message instead of handing it to the sink. */
const INLINE_SPAN = `
export function Alerted({ failure }: { failure: RunFailure }) {
  return (
    <Alert title={failure.title}>
      <span style={{ whiteSpace: "pre-line" }}>{failure.message}</span>
    </Alert>
  );
}
`;

describe("RunFailure display-sink check", () => {
  it("the tree as it stands renders every RunFailure message through the sink", () => {
    const offSink = [];
    let throughSink = 0;
    for (const file of sourceModules(WEB_SOURCE_DIR))
      for (const render of failureMessageRenders(parseFile(file))) {
        if (render.throughSink) throughSink += 1;
        else offSink.push(`${file}:${render.line}: ${render.text}`);
      }
    expect(offSink).toEqual([]);
    expect(throughSink).toBeGreaterThan(0);
  });

  it("the type this check scans for still stands where it says", () => {
    expect(declaresType(parseFile(FAILURE_TYPE_FILE), FAILURE_TYPE_NAME)).toBe(
      true,
    );
  });

  it("the sink this check names still stands where it says", () => {
    expect(
      exportsFunction(parseFile(SINK_COMPONENT_FILE), SINK_COMPONENT_NAME),
    ).toBe(true);
  });

  it("finds the binding shapes the real call sites use", () => {
    expect(failureBindingNames(parseFile(SINK_COMPONENT_FILE))).toContain(
      "failure",
    );
    expect(
      failureBindingNames(
        parseFile("apps/web/src/exchange/RecoveredExchangePanel.tsx"),
      ),
    ).toContain("failure");
  });

  it("allows the message attribute of a FailureMessage element", () => {
    expect(rendersIn(THROUGH_THE_SINK)).toMatchObject([
      { text: "failure.message", throughSink: true },
    ]);
  });

  it("flags an alert that styles its own span around the message", () => {
    expect(rendersIn(INLINE_SPAN)).toMatchObject([
      { line: 5, text: "failure.message", throughSink: false },
    ]);
  });

  it("flags the same read reached by optional chaining", () => {
    expect(
      rendersIn(`
        function Alerted({ failure }: { failure: RunFailure | undefined }) {
          return <span>{failure?.message}</span>;
        }
      `),
    ).toMatchObject([{ text: "failure?.message", throughSink: false }]);
  });

  it("flags a message attribute handed to some element other than the sink", () => {
    expect(
      rendersIn(`
        function Alerted({ failure }: { failure: RunFailure }) {
          return <Text message={failure.message} />;
        }
      `),
    ).toMatchObject([{ text: "failure.message", throughSink: false }]);
  });

  it("binds the useState shape, whose type rides the initializer", () => {
    expect(
      bindingsIn("const [failure, setFailure] = useState<RunFailure>();\n"),
    ).toEqual(["failure"]);
  });

  it("binds a named props interface member the component destructures", () => {
    expect(
      rendersIn(`
        interface Props {
          failure: RunFailure | undefined;
        }
        function Section({ failure }: Props) {
          return <span>{failure.message}</span>;
        }
      `),
    ).toMatchObject([{ text: "failure.message", throughSink: false }]);
  });

  it("passes over a file annotating no name as the failure type", () => {
    expect(
      rendersIn(`
        function Alerted({ failure }: { failure: ManagedRunFailureAlert }) {
          return <span style={{ whiteSpace: "pre-line" }}>{failure.message}</span>;
        }
      `),
    ).toEqual([]);
  });

  it("reads a message outside JSX as no render at all", () => {
    expect(
      bindingsIn(
        "function empty(failure: RunFailure) { return failure.message === ''; }\n",
      ),
    ).toEqual(["failure"]);
    expect(
      rendersIn(
        "function empty(failure: RunFailure) { return failure.message === ''; }\n",
      ),
    ).toEqual([]);
  });

  it("does not follow the message through a local, the limit the header states", () => {
    expect(
      rendersIn(`
        function Alerted({ failure }: { failure: RunFailure }) {
          const text = failure.message;
          return <span>{text}</span>;
        }
      `),
    ).toEqual([]);
  });
});
