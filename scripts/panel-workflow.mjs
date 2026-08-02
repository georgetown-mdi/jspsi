// Workflow script for /panel, invoked as
// Workflow({scriptPath: 'scripts/panel-workflow.mjs', args: {...}}).
//
// It is a Workflow script BODY, not a module: the harness injects `args`,
// `agent`, and `parallel`, and takes the top-level `return` as the run's result.
// No ES module parser accepts a top-level return, which is why eslint.config.mjs
// excludes this file; scripts/panel-script.test.mjs compiles it as a function
// body and drives it.

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
// object the caller passed.
const input = typeof args === "string" ? JSON.parse(args) : args;

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
