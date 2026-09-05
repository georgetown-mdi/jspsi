import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jsBlocks } from "../../scripts/lib/markdownFences.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const COMMAND = ".claude/commands/light-review.md";
const SCRIPT = ".claude/scripts/light-review-workflow.mjs";

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
  it("invokes the script this file tests, and has no script of its own", () => {
    const command = readFileSync(resolve(root, COMMAND), "utf8");
    expect(command).toContain(SCRIPT);
    expect(jsBlocks(command)).toEqual([]);
  });
});

const TARGET = "feature-branch";
const TREE = "/workspace/.claude/worktrees/agent-abc";

const roleArgs = (claims, role = "adversarial-verifier") => ({
  docs: [],
  role,
  claims,
  targetRef: TARGET,
  worktreePath: TREE,
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
        targetRef: TARGET,
        worktreePath: TREE,
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
    expect(result.claims[0].echoInexact).toBeUndefined();
  });

  it("restores the contract's text over a truncated or re-wrapped echo", async () => {
    const claim =
      "the module's surface is bounded (its export list plus its module-private helpers); the web-remaining half is claimed separately.";
    for (const echo of [
      "the module's surface is bounded (its export list plus its module-private helpers).",
      claim.replace("bounded (its", "bounded\n  (its"),
    ]) {
      const result = await run(roleArgs([claim]), () =>
        roleReply([verdict(echo)]),
      );
      expect(result.claims, echo).toHaveLength(1);
      expect(result.claims[0].claim, echo).toBe(claim);
      expect(result.claims[0].evidence, echo).toBe("ran it");
    }
  });

  it("leaves an echo that extends the claim with a further clause unpaired", async () => {
    const claim = "the bound holds for every measured delivery";
    await expect(
      run(roleArgs([claim]), () =>
        roleReply([verdict(`${claim}, and on the unmeasured ones too`)]),
      ),
    ).rejects.toThrow(/returned 0 verdicts for the claim "the bound holds/);
  });

  it("marks the claim whose echo it had to restore, and only that one", async () => {
    const truncated = "the bound holds for every measured delivery";
    const result = await run(
      roleArgs([
        `${truncated}; the unmeasured rest is a stated limit`,
        "a claim",
      ]),
      () => roleReply([verdict(truncated), verdict("a claim")]),
    );
    expect(result.claims[0].echoInexact).toBe(true);
    expect(result.claims[1].echoInexact).toBeUndefined();
  });

  it("refuses an echo that pairs with two unmatched claims alike", async () => {
    const shared = "the parser rejects an oversize frame";
    await expect(
      run(
        roleArgs([`${shared} on the read path`, `${shared} on the write path`]),
        () => roleReply([verdict(shared), verdict("an unrelated echo")]),
      ),
    ).rejects.toThrow(
      /pairs with more than one unmatched claim[\s\S]*on the read path[\s\S]*on the write path/,
    );
  });

  it("refuses an empty echo instead of pairing it with any claim", async () => {
    await expect(
      run(roleArgs(["a claim"]), () => roleReply([verdict("  ")])),
    ).rejects.toThrow(/returned 0 verdicts for the claim "a claim"/);
  });

  it("refuses a verdict list that is not one per claim", async () => {
    await expect(
      run(roleArgs(["a claim", "another claim"]), () =>
        roleReply([verdict("a claim")]),
      ),
    ).rejects.toThrow(/returned 1 verdict for 2 claims/);
  });

  it("throws with the full verdict list when a claim cannot be paired", async () => {
    await expect(
      run(roleArgs(["a claim"]), () =>
        roleReply([verdict("some wholly other claim")]),
      ),
    ).rejects.toThrow(/some wholly other claim/);

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

const lensArgs = {
  docs: [],
  role: null,
  claims: [],
  targetRef: TARGET,
  worktreePath: TREE,
};
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

// Every prompt the round spawns, in both modes. The interpolation cases below
// read these rather than one mode's prompt: a reviewer left on HEAD reviews
// whichever branch its own working directory happens to hold, which is exactly
// the false-scope failure the by-ref flow exists to close.
async function promptsFor(deliver, overrides) {
  const run = runner(deliver);
  const lens = [];
  await run({ ...lensArgs, ...overrides }, (prompt, options) => {
    lens.push(prompt);
    return options.label === "consolidator" ? clusters : review;
  });
  const role = [];
  await run({ ...roleArgs(["a claim"]), ...overrides }, (prompt) => {
    role.push(prompt);
    return roleReply([verdict("a claim")]);
  });
  return [...lens, ...role];
}

describe.each(SHAPES)(
  "light-review target ref ($shape args)",
  ({ deliver }) => {
    const run = runner(deliver);

    it("puts the target ref, never HEAD, in every reviewer prompt", async () => {
      const prompts = await promptsFor(deliver, {});
      expect(prompts).toHaveLength(5);
      for (const prompt of prompts) {
        expect(prompt).toContain(`origin/staging...${TARGET}`);
        expect(prompt).not.toContain("origin/staging...HEAD");
      }
    });

    it("reviews a ref that is not a branch name just as literally", async () => {
      const sha = "0f1e2d3c4b5a";
      const prompts = await promptsFor(deliver, { targetRef: sha });
      for (const prompt of prompts) {
        expect(prompt).toContain(`origin/staging...${sha}`);
      }
    });

    it("gives every reviewer the worktree path and the scratch rule", async () => {
      const prompts = await promptsFor(deliver, {});
      for (const prompt of prompts) {
        expect(prompt).toContain(`git -C ${TREE} <command>`);
        expect(prompt).toContain("under /tmp");
      }
    });

    it("tells a reviewer with no worktree to read at the ref and stop short of running code", async () => {
      for (const worktreePath of [null, undefined, "   "]) {
        const prompts = await promptsFor(deliver, { worktreePath });
        for (const prompt of prompts) {
          expect(prompt, String(worktreePath)).toContain(
            `git show ${TARGET}:<path>`,
          );
          expect(prompt, String(worktreePath)).not.toContain("Scope EVERY");
        }
      }
    });

    it("refuses a round that names no ref instead of falling back to HEAD", async () => {
      for (const targetRef of [undefined, null, "", "   ", 7, ["a-branch"]]) {
        await expect(
          run({ ...lensArgs, targetRef }, () => {
            throw new Error("must not spawn");
          }),
          JSON.stringify(targetRef),
        ).rejects.toThrow(/targetRef must be a non-empty string/);
      }
    });

    it("refuses a worktree path that is not a path", async () => {
      for (const worktreePath of [7, ["/tmp"], {}]) {
        await expect(
          run({ ...lensArgs, worktreePath }, () => {
            throw new Error("must not spawn");
          }),
          JSON.stringify(worktreePath),
        ).rejects.toThrow(/worktreePath must be the absolute path/);
      }
    });
  },
);

describe.each(SHAPES)("light-review lens mode ($shape args)", ({ deliver }) => {
  const run = runner(deliver);

  it("refuses claims handed to it without a role to run them under", async () => {
    for (const role of [null, undefined]) {
      for (const claims of [["a claim"], "a claim", {}]) {
        await expect(
          run({ ...lensArgs, role, claims }, () => {
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
