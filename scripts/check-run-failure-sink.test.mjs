import { describe, expect, it } from "vitest";
import {
  parseFile,
  parseSource,
  sourceModules,
} from "./lib/typeScriptSources.mjs";
import {
  FAILURE_TYPES,
  SINK_COMPONENT_FILE,
  TEXT_SINKS,
  WEB_SOURCE_DIR,
  declaresType,
  exportsFunction,
  failureBindingNames,
  failureTextRenders,
} from "./check-run-failure-sink.mjs";

const rendersIn = (source, file = "fixture.tsx") =>
  failureTextRenders(parseSource(file, source));

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

/** The file of the recurring seat, the surface holding the second tracked
 * type's real call sites. */
const MANAGED_RUN_SURFACE_FILE = "apps/web/src/recurring/ManagedRunSurface.tsx";

/** The same regression on the recurring seat's own failure type: an alert
 * inlining both pieces in spans of its own. */
const INLINE_MANAGED_FAILURE = `
export function Alerted({ failure }: { failure: ManagedRunFailureAlert }) {
  return (
    <Alert title={failure.title}>
      <span style={{ whiteSpace: "pre-line" }}>{failure.message}</span>
      <span className="mono">{failure.reportedCause}</span>
    </Alert>
  );
}
`;

/** The reported cause handed to the sink that lays it out and labels it. */
const THROUGH_THE_REPORTED_CAUSE_SINK = `
export function Alerted({ failure }: { failure: RunFailure }) {
  return <FailureReportedCause reportedCause={failure.reportedCause} />;
}
`;

/** The same regression on the other piece: an alert inlining the exchange's
 * report in a span of its own, unlaid-out and unlabelled. */
const INLINE_REPORTED_CAUSE = `
export function Alerted({ failure }: { failure: RunFailure }) {
  return (
    <Alert title={failure.title}>
      <span className="mono">{failure.reportedCause}</span>
    </Alert>
  );
}
`;

// Bound for the case that walks the whole web source tree: it parses every
// module in it, with no wait in it. It runs 0.7s alone against vitest's 5s
// default, and 9.0s with the rest of the script suites competing for the same
// cores, which is the contention that reddened it. Sized well past that worst
// measurement, this stays a hang safety check -- a walk that never terminates
// still fails here -- rather than a claim about how fast the scan runs.
const TREE_SCAN_TIMEOUT_MS = 60_000;

describe("failure display-sink check", () => {
  it(
    "the tree as it stands renders every failure piece through its sink",
    () => {
      const offSink = [];
      const throughSink = new Map(
        TEXT_SINKS.map(({ property }) => [property, 0]),
      );
      for (const file of sourceModules(WEB_SOURCE_DIR))
        for (const render of failureTextRenders(parseFile(file))) {
          if (render.throughSink)
            throughSink.set(
              render.property,
              throughSink.get(render.property) + 1,
            );
          else offSink.push(`${file}:${render.line}: ${render.text}`);
        }
      expect(offSink).toEqual([]);
      // Each sink separately, and named in the assertion so a failure says
      // which: a green result on one of the two pieces says nothing about the
      // other's callers still being in this scan's reach.
      for (const { property } of TEXT_SINKS)
        expect([property, throughSink.get(property) > 0]).toEqual([
          property,
          true,
        ]);
    },
    TREE_SCAN_TIMEOUT_MS,
  );

  it("every type this check scans for still stands where it says", () => {
    for (const { name, file } of FAILURE_TYPES)
      expect([name, declaresType(parseFile(file), name)]).toEqual([name, true]);
  });

  it("every sink this check names still stands where it says", () => {
    for (const { component } of TEXT_SINKS)
      expect([
        component,
        exportsFunction(parseFile(SINK_COMPONENT_FILE), component),
      ]).toEqual([component, true]);
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

  it("holds the recurring seat's surface, whose type is its own", () => {
    // The seat that runs unattended classifies into ManagedRunFailureAlert and
    // renders it through the shared body, so its bindings are found and none of
    // its renders sits outside a sink. The binding assertion is the vacuity
    // guard on the render one: an unfound binding reports no render either.
    const surface = parseFile(MANAGED_RUN_SURFACE_FILE);
    expect(failureBindingNames(surface)).toContain("failure");
    expect(
      failureTextRenders(surface).filter((render) => !render.throughSink),
    ).toEqual([]);
  });

  it("flags the recurring seat's failure inlined outside the sinks", () => {
    expect(rendersIn(INLINE_MANAGED_FAILURE)).toMatchObject([
      { line: 5, text: "failure.message", throughSink: false },
      { line: 6, text: "failure.reportedCause", throughSink: false },
    ]);
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

  it("allows the reportedCause attribute of its own sink", () => {
    expect(rendersIn(THROUGH_THE_REPORTED_CAUSE_SINK)).toMatchObject([
      {
        text: "failure.reportedCause",
        property: "reportedCause",
        throughSink: true,
      },
    ]);
  });

  it("flags an alert inlining the reported cause in a span of its own", () => {
    expect(rendersIn(INLINE_REPORTED_CAUSE)).toMatchObject([
      {
        line: 5,
        text: "failure.reportedCause",
        property: "reportedCause",
        throughSink: false,
      },
    ]);
  });

  it("flags a piece handed to the other piece's sink", () => {
    expect(
      rendersIn(`
        function Alerted({ failure }: { failure: RunFailure }) {
          return <FailureMessage reportedCause={failure.reportedCause} />;
        }
      `),
    ).toMatchObject([{ text: "failure.reportedCause", throughSink: false }]);
  });

  it("reads the guard in front of an optional piece as no render", () => {
    expect(
      rendersIn(`
        function Alerted({ failure }: { failure: RunFailure }) {
          return failure.reportedCause !== undefined && !failure.message ? (
            <FailureReportedCause reportedCause={failure.reportedCause} />
          ) : null;
        }
      `),
    ).toMatchObject([{ text: "failure.reportedCause", throughSink: true }]);
  });

  it("reads a bare && guard in front of an optional piece as no render", () => {
    // The idiomatic form of the same guard: the read yields the branch rather
    // than any text of its own, so the only render is the one handing the piece
    // to its sink.
    expect(
      rendersIn(`
        function Alerted({ failure }: { failure: RunFailure }) {
          return (
            <Alert>
              {failure.reportedCause && (
                <FailureReportedCause reportedCause={failure.reportedCause} />
              )}
            </Alert>
          );
        }
      `),
    ).toMatchObject([{ text: "failure.reportedCause", throughSink: true }]);
  });

  it("flags a guarded branch that inlines the piece it guards", () => {
    // Exempting the guard exempts nothing behind it: the branch is where the
    // operator's text comes from, and a span there is the regression this check
    // exists for.
    expect(
      rendersIn(`
        function Alerted({ failure }: { failure: RunFailure }) {
          return (
            <Alert>
              {failure.reportedCause && (
                <span className="mono">{failure.reportedCause}</span>
              )}
            </Alert>
          );
        }
      `),
    ).toMatchObject([{ text: "failure.reportedCause", throughSink: false }]);
  });

  it("reads a ternary's test as no render and flags its branch", () => {
    expect(
      rendersIn(`
        function Alerted({ failure }: { failure: RunFailure }) {
          return failure.reportedCause ? (
            <span className="mono">{failure.reportedCause}</span>
          ) : null;
        }
      `),
    ).toMatchObject([{ text: "failure.reportedCause", throughSink: false }]);
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

  it("follows a renamed destructure to the local name it binds", () => {
    const source = `
      export function Alerted({ failure: renamedFailure }: { failure: RunFailure }) {
        return <span style={{ whiteSpace: "pre-line" }}>{renamedFailure.message}</span>;
      }
    `;
    expect(bindingsIn(source)).toEqual(["renamedFailure"]);
    expect(rendersIn(source)).toMatchObject([
      { text: "renamedFailure.message", throughSink: false },
    ]);
  });

  it("allows a renamed destructure rendered through the sink", () => {
    expect(
      rendersIn(`
        export function Alerted({ failure: renamedFailure }: { failure: RunFailure }) {
          return <FailureMessage message={renamedFailure.message} />;
        }
      `),
    ).toMatchObject([{ text: "renamedFailure.message", throughSink: true }]);
  });

  it("follows a renamed destructure nested one pattern deep", () => {
    expect(
      rendersIn(`
        function Alerted({ run: { failure: renamedFailure } }: { run: { failure: RunFailure } }) {
          return <span>{renamedFailure.message}</span>;
        }
      `),
    ).toMatchObject([{ text: "renamedFailure.message", throughSink: false }]);
  });

  it("keeps the member's key for a props object bound whole", () => {
    expect(
      bindingsIn(
        "function Alerted(props: { failure: RunFailure }) { return props; }\n",
      ),
    ).toEqual(["failure"]);
  });

  it("passes over a file annotating no name as a tracked type", () => {
    expect(
      rendersIn(`
        function Alerted({ failure }: { failure: ManagedRunRecovery }) {
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
