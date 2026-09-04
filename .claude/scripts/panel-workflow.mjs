// Workflow script for /panel, invoked as
// Workflow({scriptPath: '.claude/scripts/panel-workflow.mjs', args: {...}}).
//
// It is a Workflow script BODY, not a module: the harness injects `args`,
// `agent`, and `parallel`, and takes the top-level `return` as the run's result.
// No ES module parser accepts a top-level return, which is why eslint.config.mjs
// excludes this file; .claude/scripts/panel-script.test.mjs compiles it as a
// function body and drives it.

export const meta = {
  name: "panel",
  description:
    "Three independent schema-forced panelists on one design question",
  phases: [{ title: "Panel" }],
};

const SCHEMA = {
  type: "object",
  required: ["position", "rationale", "keyRisk"],
  properties: {
    position: {
      type: "string",
      description: "Your answer to the question in one or two sentences.",
    },
    rationale: {
      type: "string",
      description: "Why, grounded in what you read. Compact prose.",
    },
    keyRisk: {
      type: "string",
      description: "The strongest consideration against your own position.",
    },
  },
};

// The harness may hand a script its arguments as JSON text rather than as the
// object the caller passed. Any other delivery -- an array, a bare scalar, null,
// nothing at all -- has no named field, and reading one off it yields
// undefined rather than failing, so the round would reach its agents with holes
// where the caller's arguments belong. Resolving fails closed on it instead, and
// `npm run check:workflow-args-resolve` holds every read of `args` in a
// committed Workflow script to the one call below.
function resolveWorkflowArgs(delivered) {
  const expected = "an object of named arguments, or the JSON text of one";
  let resolved = delivered;
  if (typeof delivered === "string") {
    try {
      resolved = JSON.parse(delivered);
    } catch (cause) {
      throw new Error(`args is text that is not JSON; expected ${expected}.`, {
        cause,
      });
    }
  }
  if (
    resolved === null ||
    typeof resolved !== "object" ||
    Array.isArray(resolved)
  ) {
    const got =
      resolved === null
        ? "null"
        : Array.isArray(resolved)
          ? "an array"
          : resolved === undefined
            ? "nothing"
            : `a ${typeof resolved}`;
    throw new Error(`args resolved to ${got}; expected ${expected}.`);
  }
  return resolved;
}

const input = resolveWorkflowArgs(args);

const docsClause =
  input.docs && input.docs.length
    ? `Read these first for context: ${input.docs.map((d) => "/tmp/panel-base/" + d).join(", ")}.\n\n`
    : "";

const prompt = (
  lens,
) => `You are an independent expert panelist. Read ONLY under /tmp/panel-base, a clean checkout of the project's mainline: do not read, cd into, or search /workspace, and do not run builds or tests (the tree has no node_modules). You are one of several panelists and must not coordinate; answer from your own read.

${docsClause}Weigh the question primarily through the lens of ${lens}, then answer it directly -- an answer, not a survey of options.

The question:
${input.question}`;

return (
  await parallel([
    () =>
      agent(prompt("correctness and failure modes"), {
        label: "panelist: failure modes",
        phase: "Panel",
        schema: SCHEMA,
        model: "opus",
      }),
    () =>
      agent(prompt("architecture and maintenance cost"), {
        label: "panelist: architecture",
        phase: "Panel",
        schema: SCHEMA,
        model: "opus",
      }),
    () =>
      agent(prompt("operational and cost pragmatics"), {
        label: "panelist: pragmatics",
        phase: "Panel",
        schema: SCHEMA,
        model: "sonnet",
      }),
  ])
).filter(Boolean);
