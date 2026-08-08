import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jsBlocks } from "./check-workflow-agent-models.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMMAND = ".claude/commands/light-review.md";
const SCRIPT = "scripts/light-review-workflow.mjs";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// The checked-in script the command invokes by path IS the artifact under test.
// It is a Workflow script body rather than a module, so compile it into a
// function of the three names the Workflow runtime injects; `export const meta`
// is the one module-only spelling in it, and the top-level `return` of the role
// branch is legal in a function body.
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
// reads only one of them selects the wrong branch under the other.
const SHAPES = [
  { shape: "object", deliver: (args) => args },
  { shape: "string", deliver: (args) => JSON.stringify(args) },
];

describe("light-review command wiring", () => {
  it("invokes the script this file tests, and carries no script of its own", () => {
    const command = readFileSync(resolve(root, COMMAND), "utf8");
    expect(command).toContain(SCRIPT);
    expect(jsBlocks(command)).toEqual([]);
  });
});

const roleArgs = (claims, role = "adversarial-verifier") => ({
  docs: [],
  role,
  claims,
});
const verdict = (claim, fields = {}) => ({
  claim,
  verdict: "HOLDS",
  evidence: "ran it",
  file: "src/a.ts",
  lines: "1-2",
  ...fields,
});
const roleReply = (claims, summary = "the round") => ({
  claims,
  findings: [],
  summary,
});

describe.each(SHAPES)("light-review role mode ($shape args)", ({ deliver }) => {
  const run = runner(deliver);

  it("refuses a role that is not one of the two contract roles", async () => {
    await expect(
      run(roleArgs(["a claim"], "ux-reviewer"), () => {
        throw new Error("must not spawn");
      }),
    ).rejects.toThrow(/security-reviewer or adversarial-verifier/);
  });

  it("refuses a falsy role instead of falling through to a lens round", async () => {
    for (const role of ["", 0, false]) {
      await expect(
        run(roleArgs(["a claim"], role), () => {
          throw new Error("must not spawn");
        }),
        String(role),
      ).rejects.toThrow(/security-reviewer or adversarial-verifier/);
    }
  });

  it("refuses a role round with no claims to refute", async () => {
    for (const claims of [[], undefined, "a claim"]) {
      await expect(
        run(roleArgs(claims), () => {
          throw new Error("must not spawn");
        }),
      ).rejects.toThrow(/non-empty claims array/);
    }
  });

  it("refuses a claims list holding a blank or non-string entry", async () => {
    for (const claims of [
      ["a claim", "   "],
      ["a claim", { claim: "x" }],
    ]) {
      await expect(
        run(roleArgs(claims), () => {
          throw new Error("must not spawn");
        }),
      ).rejects.toThrow(/non-empty string/);
    }
  });

  it("refuses a claim that is nothing but a list marker", async () => {
    for (const marker of ["- ", "* ", "1. ", "  -  "]) {
      await expect(
        run(roleArgs([marker]), () => {
          throw new Error("must not spawn");
        }),
        JSON.stringify(marker),
      ).rejects.toThrow(/non-empty string with text beyond a list marker/);
    }
    const result = await run(roleArgs(["- real claim"]), () =>
      roleReply([verdict("real claim")]),
    );
    expect(result.claims.map((entry) => entry.claim)).toEqual(["real claim"]);
  });

  it("deduplicates claims after stripping list markers", async () => {
    let asked = null;
    const result = await run(
      roleArgs(["- a claim", "a claim", "1. another claim"]),
      (prompt) => {
        asked = prompt;
        return roleReply([verdict("a claim"), verdict("another claim")]);
      },
    );
    expect(asked).toContain("1. a claim\n2. another claim");
    expect(result.claims.map((entry) => entry.claim)).toEqual([
      "a claim",
      "another claim",
    ]);
    expect(result.gate).toBe(false);
  });

  it("spawns the role it was given and gives it the docs to read", async () => {
    let options = null;
    let asked = null;
    await run(
      {
        docs: ["docs/spec/FILE_SYNC.md"],
        role: "security-reviewer",
        claims: ["a claim"],
      },
      (prompt, spawn) => {
        asked = prompt;
        options = spawn;
        return roleReply([verdict("a claim")]);
      },
    );
    expect(options.agentType).toBe("security-reviewer");
    expect(options.label).toBe("security-reviewer");
    expect(asked).toContain(
      "First read these docs for design context: docs/spec/FILE_SYNC.md",
    );
  });

  it("records the contract's own text, not the model's echo of it", async () => {
    const result = await run(roleArgs(["a claim"]), () =>
      roleReply([verdict("1. a claim")]),
    );
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].claim).toBe("a claim");
    expect(result.claims[0].evidence).toBe("ran it");
  });

  it("throws with the full verdict list when a claim cannot be paired", async () => {
    await expect(
      run(roleArgs(["a claim"]), () =>
        roleReply([verdict("a claim from somewhere else")]),
      ),
    ).rejects.toThrow(/a claim from somewhere else/);

    const twice = run(roleArgs(["a claim"]), () =>
      roleReply([
        verdict("a claim", { evidence: "first pass" }),
        verdict("a claim", { evidence: "second pass" }),
      ]),
    );
    await expect(twice).rejects.toThrow(/returned 2 verdicts/);
    await expect(twice).rejects.toThrow(/first pass[\s\S]*second pass/);
  });

  it("gates on a refuted and on an unverifiable claim alike", async () => {
    for (const outcome of ["REFUTED", "COULD-NOT-VERIFY"]) {
      const result = await run(roleArgs(["a claim", "another claim"]), () =>
        roleReply([
          verdict("a claim"),
          verdict("another claim", { verdict: outcome }),
        ]),
      );
      expect(result.gate, outcome).toBe(true);
    }
  });

  it("throws a salvage path when the role agent returns nothing", async () => {
    await expect(run(roleArgs(["a claim"]), () => null)).rejects.toThrow(
      /adversarial-verifier returned no structured result/,
    );
  });
});

const lensArgs = { docs: [], role: null, claims: [] };
const review = {
  findings: [{ name: "n", description: "d", severity: "nit", file: "a.ts" }],
  simplerShape: { simpler: false, reason: "no" },
};
const clusters = {
  clusters: [
    {
      name: "n",
      description: "d",
      severity: "nit",
      file: "a.ts",
      flaggedBy: 1,
      verification: "confirmed",
      verificationNote: "read it",
    },
  ],
};
const lensReply = (prompt, options) =>
  options.label === "consolidator" ? clusters : review;

// Every delivery that is not an object of named arguments, and so resolves no
// field the round needs. Tolerating one runs the whole round on prompts whose
// arguments are missing rather than stopping.
const UNRESOLVABLE = [[], 42, "text", true, null, undefined];

describe.each(SHAPES)(
  "light-review argument shape ($shape args)",
  ({ deliver }) => {
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

    it("resolves an object of named arguments and runs the round on it", async () => {
      const result = await run(lensArgs, lensReply);
      expect(result.reviewerCount).toBe(3);
    });
  },
);

describe.each(SHAPES)("light-review lens mode ($shape args)", ({ deliver }) => {
  const run = runner(deliver);

  it("refuses claims handed to it without a role to run them under", async () => {
    for (const role of [null, undefined]) {
      for (const claims of [["a claim"], "a claim", {}]) {
        await expect(
          run({ docs: [], role, claims }, () => {
            throw new Error("must not spawn");
          }),
          `${String(role)} ${JSON.stringify(claims)}`,
        ).rejects.toThrow(/claims were passed without a role/);
      }
    }
  });

  it("consolidates what the reviewers that returned found", async () => {
    const result = await run(lensArgs, lensReply);
    expect(result.reviewerCount).toBe(3);
    expect(result.clusters).toEqual(clusters.clusters);
  });

  it("gives every agent it spawns the docs to read", async () => {
    const asked = [];
    await run({ ...lensArgs, docs: ["docs/DESIGN.md"] }, (prompt, options) => {
      asked.push(prompt);
      return options.label === "consolidator" ? clusters : review;
    });
    expect(asked).toHaveLength(4);
    for (const prompt of asked) {
      expect(prompt).toContain(
        "First read these docs for design context: docs/DESIGN.md",
      );
    }
  });

  it("throws a salvage path when every reviewer is lost", async () => {
    await expect(run(lensArgs, () => null)).rejects.toThrow(
      /Every lens reviewer returned no structured result/,
    );
  });

  it("throws a salvage path when the consolidator is lost", async () => {
    await expect(
      run(lensArgs, (prompt, options) =>
        options.label === "consolidator" ? null : review,
      ),
    ).rejects.toThrow(/The consolidator returned no structured result/);
  });
});
