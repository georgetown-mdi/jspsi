import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jsBlocks } from "../../scripts/check-workflow-agent-models.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const COMMAND = ".claude/commands/panel.md";
const SCRIPT = ".claude/scripts/panel-workflow.mjs";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// The checked-in script the command invokes by path IS the artifact under test.
// It is a Workflow script body rather than a module, so compile it into a
// function of the three names the Workflow runtime injects; `export const meta`
// is the one module-only spelling in it, and the top-level `return` is legal in
// a function body.
function compileScript() {
  const body = readFileSync(resolve(root, SCRIPT), "utf8").replace(
    /^export const meta =/m,
    "const meta =",
  );
  return new AsyncFunction("args", "agent", "parallel", body);
}

const script = compileScript();
const parallel = (thunks) => Promise.all(thunks.map((thunk) => thunk()));
const runner = (deliver) => (args, respond) =>
  script(deliver(args), respond, parallel);

// The harness may deliver the arguments as JSON text rather than as the object
// the caller passed, so every case below runs under both shapes: a script that
// reads only one of them convenes the panel on the literal text "undefined".
const SHAPES = [
  { shape: "object", deliver: (args) => args },
  { shape: "string", deliver: (args) => JSON.stringify(args) },
];

const QUESTION = "Should the adapter retry a stalled transfer or fail closed?";
const answer = (position) => ({
  position,
  rationale: "what the code showed",
  keyRisk: "the other reading",
});

describe("panel command wiring", () => {
  it("invokes the script this file tests, and carries no script of its own", () => {
    const command = readFileSync(resolve(root, COMMAND), "utf8");
    expect(command).toContain(SCRIPT);
    expect(jsBlocks(command)).toEqual([]);
  });
});

// Every delivery that is not an object of named arguments, and so resolves no
// field the panel needs. Tolerating one convenes the panel on the literal text
// "undefined" rather than stopping.
const UNRESOLVABLE = [[], 42, "text", true, null, undefined];

describe.each(SHAPES)("panel argument shape ($shape args)", ({ deliver }) => {
  const run = runner(deliver);

  it("refuses a delivery that is not an object of named arguments", async () => {
    for (const delivered of UNRESOLVABLE) {
      await expect(
        run(delivered, () => {
          throw new Error("must not spawn");
        }),
        JSON.stringify(delivered),
      ).rejects.toThrow(
        /expected an object of named arguments, or the JSON text of one/,
      );
    }
  });

  it("resolves an object of named arguments and convenes the panel", async () => {
    const verdicts = await run({ question: QUESTION, docs: [] }, () =>
      answer("fail closed"),
    );
    expect(verdicts).toHaveLength(3);
  });
});

describe.each(SHAPES)("panel ($shape args)", ({ deliver }) => {
  const run = runner(deliver);

  it("asks every panelist the question it was convened on", async () => {
    const asked = [];
    const verdicts = await run({ question: QUESTION, docs: [] }, (prompt) => {
      asked.push(prompt);
      return answer("fail closed");
    });
    expect(asked).toHaveLength(3);
    for (const prompt of asked) {
      expect(prompt).toContain(QUESTION);
      expect(prompt).not.toContain("undefined");
    }
    expect(verdicts).toHaveLength(3);
  });

  it("weighs each panelist through its own lens", async () => {
    const lenses = [];
    await run({ question: QUESTION, docs: [] }, (prompt, options) => {
      lenses.push(options.label);
      return answer("fail closed");
    });
    expect(lenses).toEqual([
      "panelist: failure modes",
      "panelist: architecture",
      "panelist: pragmatics",
    ]);
  });

  it("points the docs it was given at the panel base checkout", async () => {
    const asked = [];
    await run(
      {
        question: QUESTION,
        docs: ["docs/spec/FILE_SYNC.md", "docs/DESIGN.md"],
      },
      (prompt) => {
        asked.push(prompt);
        return answer("fail closed");
      },
    );
    for (const prompt of asked) {
      expect(prompt).toContain(
        "Read these first for context: /tmp/panel-base/docs/spec/FILE_SYNC.md, /tmp/panel-base/docs/DESIGN.md",
      );
    }
  });

  it("says nothing about docs when it was given none", async () => {
    const asked = [];
    await run({ question: QUESTION, docs: [] }, (prompt) => {
      asked.push(prompt);
      return answer("fail closed");
    });
    for (const prompt of asked) {
      expect(prompt).not.toContain("Read these first for context");
    }
  });

  it("drops a panelist that exhausted its schema retries", async () => {
    const verdicts = await run(
      { question: QUESTION, docs: [] },
      (prompt, options) =>
        options.label === "panelist: pragmatics" ? null : answer("fail closed"),
    );
    expect(verdicts).toHaveLength(2);
  });
});
