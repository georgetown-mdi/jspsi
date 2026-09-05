import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const MODULE = JSON.stringify(new URL("./event.mjs", import.meta.url).href);

// Each export is exercised in its own process with the payload on stdin, the way
// a hook receives one: file descriptor 0 is read once, so two reads in a single
// process would leave the second with nothing.
function evaluate(expression, input) {
  const { stdout } = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import * as event from ${MODULE};
       process.stdout.write(JSON.stringify(${expression}) ?? "undefined");`,
    ],
    { input, encoding: "utf8" },
  );
  return stdout === "undefined" ? undefined : JSON.parse(stdout);
}

const bash = {
  tool_name: "Bash",
  tool_input: { command: "ls" },
  cwd: "/workspace",
};

describe("readEvent", () => {
  it("parses the JSON object on stdin", () => {
    expect(evaluate("event.readEvent()", JSON.stringify(bash))).toEqual(bash);
  });

  it("reads unparseable input as no event", () => {
    expect(evaluate("event.readEvent()", "not json")).toBeNull();
  });

  it("reads empty input as no event", () => {
    expect(evaluate("event.readEvent()", "")).toBeNull();
  });

  // A payload of this shape is told apart from stdin holding no event at all,
  // because the fail-closed hooks refuse it and allow on the other.
  it("reads a JSON value that is not an object as NOT_AN_EVENT", () => {
    for (const payload of ["null", '[{"tool_name":"Bash"}]', '"Bash"', "7"]) {
      expect(
        evaluate("event.readEvent() === event.NOT_AN_EVENT", payload),
      ).toBe(true);
    }
  });

  it("tells no event apart from a value that is not an event", () => {
    for (const payload of ["not json", ""]) {
      expect(
        evaluate("event.readEvent() === event.NOT_AN_EVENT", payload),
      ).toBe(false);
    }
  });
});

describe("eventForTools", () => {
  it("returns the event when it names one of the tools", () => {
    expect(
      evaluate('event.eventForTools("Edit", "Bash")', JSON.stringify(bash)),
    ).toEqual(bash);
  });

  it("returns nothing for a tool the hook does not gate", () => {
    expect(
      evaluate('event.eventForTools("Workflow")', JSON.stringify(bash)),
    ).toBeNull();
  });

  it("returns nothing for an unreadable event of either shape", () => {
    for (const payload of ["not json", "null", '[{"tool_name":"Bash"}]', "7"]) {
      expect(evaluate('event.eventForTools("Bash")', payload)).toBeNull();
    }
  });

  it("returns nothing for an event naming no tool", () => {
    expect(evaluate('event.eventForTools("Bash")', "{}")).toBeNull();
  });
});

describe("commandOf", () => {
  it("returns the command line of a Bash event", () => {
    expect(
      evaluate("event.commandOf(event.readEvent())", JSON.stringify(bash)),
    ).toBe("ls");
  });

  it("returns nothing when the command is absent or not a string", () => {
    for (const tool_input of [{}, { command: 7 }, { command: null }]) {
      expect(
        evaluate(
          "event.commandOf(event.readEvent())",
          JSON.stringify({ tool_name: "Bash", tool_input }),
        ),
      ).toBeNull();
    }
  });

  it("returns nothing for an event with no tool_input at all", () => {
    expect(evaluate("event.commandOf(event.readEvent())", "{}")).toBeNull();
  });
});

describe("eventCwd", () => {
  it("returns the directory the call was made from", () => {
    expect(
      evaluate("event.eventCwd(event.readEvent())", JSON.stringify(bash)),
    ).toBe("/workspace");
  });

  it("reads an empty or missing cwd as naming no directory", () => {
    for (const cwd of ["", undefined, null, 7]) {
      expect(
        evaluate(
          "event.eventCwd(event.readEvent())",
          JSON.stringify({ tool_name: "Bash", cwd }),
        ),
      ).toBeNull();
    }
  });
});
