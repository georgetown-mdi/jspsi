// Workflow script for /light-review, invoked as
// Workflow({scriptPath: '.claude/scripts/light-review-workflow.mjs', args: {...}}).
//
// It is a Workflow script BODY, not a module: the harness injects `args`,
// `agent`, and `parallel`, and takes the top-level `return` as the run's result.
// No ES module parser accepts a top-level return, which is why eslint.config.mjs
// excludes this file; .claude/scripts/light-review-script.test.mjs compiles it as
// a function body and drives both modes.

export const meta = {
  name: "light-review",
  description:
    "One review round over the target ref's diff against staging: three schema-forced lens reviewers plus a consolidator, or one schema-forced role reviewer under a refutation contract",
  phases: [{ title: "Review" }, { title: "Consolidate" }],
};

const FINDING = {
  type: "object",
  required: ["name", "description", "severity", "file"],
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    severity: { type: "string", enum: ["critical", "major", "minor", "nit"] },
    file: { type: "string" },
  },
};
const REVIEWER_SCHEMA = {
  type: "object",
  required: ["findings", "simplerShape"],
  properties: {
    findings: { type: "array", items: FINDING },
    simplerShape: {
      type: "object",
      required: ["simpler", "reason"],
      properties: { simpler: { type: "boolean" }, reason: { type: "string" } },
    },
  },
};
const CONSOLIDATOR_SCHEMA = {
  type: "object",
  required: ["clusters"],
  properties: {
    clusters: {
      type: "array",
      items: {
        type: "object",
        required: [
          "name",
          "description",
          "severity",
          "file",
          "flaggedBy",
          "verification",
          "verificationNote",
        ],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          severity: {
            type: "string",
            enum: ["critical", "major", "minor", "nit"],
          },
          file: { type: "string" },
          flaggedBy: { type: "number" },
          verification: {
            type: "string",
            enum: ["confirmed", "refuted", "unverifiable"],
          },
          verificationNote: { type: "string" },
        },
      },
    },
  },
};
const ROLE_SCHEMA = {
  type: "object",
  required: ["claims", "findings", "summary"],
  properties: {
    claims: {
      type: "array",
      description:
        "One entry per claim you were given, no more and no fewer. Populate every property; empty array when none.",
      items: {
        type: "object",
        required: ["claim", "verdict", "evidence", "file", "lines"],
        properties: {
          claim: {
            type: "string",
            description:
              "The claim exactly as it was given to you, copied verbatim.",
          },
          verdict: {
            type: "string",
            enum: ["HOLDS", "REFUTED", "COULD-NOT-VERIFY"],
          },
          evidence: {
            type: "string",
            description:
              "What you read or ran and what it showed. Compact prose, a sentence or two.",
          },
          file: {
            type: "string",
            description:
              "Path the evidence sits in; empty string when the verdict rests on no single file.",
          },
          lines: {
            type: "string",
            description:
              "Line or range in that file, e.g. 42 or 42-58; empty string when none applies.",
          },
        },
      },
    },
    findings: {
      type: "array",
      description:
        "Problems you found outside the claims. Populate every property; empty array when none.",
      items: {
        type: "object",
        required: ["name", "description", "severity", "file", "lines"],
        properties: {
          name: { type: "string", description: "Short label for the problem." },
          description: {
            type: "string",
            description: "What is wrong and why it matters. Compact prose.",
          },
          severity: {
            type: "string",
            enum: ["critical", "major", "minor", "nit"],
          },
          file: { type: "string" },
          lines: {
            type: "string",
            description:
              "Line or range in that file; empty string when none applies.",
          },
        },
      },
    },
    summary: {
      type: "string",
      description: "The round in a few compact sentences.",
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

// The ref under review. There is no default by design: a round that fell back
// to HEAD would review whatever the CALLER's checkout happens to hold, which is
// the false-scope bug the by-ref flow exists to close, and it would do it
// silently. A caller that names no ref gets a thrown round instead.
if (
  typeof input.targetRef !== "string" ||
  input.targetRef.trim().length === 0
) {
  throw new Error(
    `targetRef must be a non-empty string naming the ref under review; got ${JSON.stringify(input.targetRef)}.`,
  );
}
const targetRef = input.targetRef.trim();

if (
  input.worktreePath !== undefined &&
  input.worktreePath !== null &&
  typeof input.worktreePath !== "string"
) {
  throw new Error(
    `worktreePath must be the absolute path of the tree holding ${targetRef}, or null when no tree holds it; got ${JSON.stringify(input.worktreePath)}.`,
  );
}
const worktreePath =
  typeof input.worktreePath === "string" && input.worktreePath.trim().length > 0
    ? input.worktreePath.trim()
    : null;

const docsClause =
  input.docs && input.docs.length
    ? "First read these docs for design context: " +
      input.docs.join(", ") +
      ". When an issue could be a deliberate design decision, check whether these docs justify it before flagging it.\n\n"
    : "";

const diffScope = `Generate the diff yourself with git diff "origin/staging...${targetRef}" -- the ref and the three-dot form are both deliberate and non-negotiable: it shows ONLY what ${targetRef} added since it forked from staging, and it excludes every commit staging gained after the fork. That diff is the complete and exclusive scope of your review. Never widen it: do not run a two-dot git diff origin/staging ${targetRef}, do not substitute a local staging ref (it goes stale and drags in merged work), do not diff against ${targetRef}~N, the tip of staging, or any other base. Review ${targetRef} and nothing else -- never HEAD, and never whatever branch a working directory you land in happens to hold.

Review the branch's own changes and nothing else. Anything attributable to staging advancing since the branch forked -- the branch's base or starting point moving, the "root" of the branch changing, upstream commits the branch has not yet absorbed -- is OUT OF SCOPE and not this branch's responsibility. Do not flag it, describe it, or even mention that the base moved; treat such material as invisible. If a hunk merely re-states upstream staging work rather than introducing new behavior authored on this branch, ignore it. Open another file only if a hunk cannot be judged without it.`;

// Where the reviewer stands, and where anything it creates goes. Both halves are
// critical: a shell's working directory does not persist between an agent's
// tool calls, so an unscoped command runs against whatever tree the harness
// dropped it in; and a scratch file left in the tree under review wedges every
// later round of that branch, because the clean-tree gate statuses that tree.
const workingTreeClause = worktreePath
  ? `The tree holding ${targetRef} is checked out at ${worktreePath}. Scope EVERY command to it -- \`cd ${worktreePath} && <command>\` or \`git -C ${worktreePath} <command>\` -- rather than relying on an earlier cd, which does not carry from one call to the next.`
  : `No working tree holds ${targetRef}. Read files at the ref with \`git show ${targetRef}:<path>\` and never check it out; if judging this diff needs code RUN rather than read, say so and stop rather than checking anything out.`;

const scratchClause = `Put every file you create -- probe scripts, temporary tests, scratch notes -- under /tmp, never inside a repository working tree.`;

const groundRules = `${workingTreeClause} ${scratchClause}`;

const salvage = (who) =>
  `${who} returned no structured result -- the structured-output retries were exhausted. The analysis usually survives in the rejected attempts: read subagents/workflows/<runId>/agent-<id>.jsonl for this run and salvage it before re-running the round.`;

// Presence, not truthiness: a role of "" is a mis-invocation for the allowlist below to
// reject, not a lens round that silently drops the claims it was handed.
if (input.role !== undefined && input.role !== null) {
  // The contract is matched on this form, so a list marker the caller left on a line and
  // an enumeration the model echoed back both pair with the claim as written. A marker
  // with nothing after it strips to empty, so a blank bullet cannot pass as a claim.
  const normalizeClaim = (claim) =>
    claim
      .trim()
      .replace(/^([-*+]|\d+[.)])(\s+|$)/, "")
      .trim();
  // Pairing compares on this further-collapsed form, so an echo the model re-wrapped
  // pairs with the contract line it differs from only in runs of whitespace.
  const pairingKey = (claim) => normalizeClaim(claim).replace(/\s+/g, " ");
  const ROLES = ["security-reviewer", "adversarial-verifier"];
  if (!ROLES.includes(input.role)) {
    throw new Error(
      `role must be ${ROLES.join(" or ")}, not "${input.role}"; no other agent runs under a refutation contract.`,
    );
  }
  if (!Array.isArray(input.claims) || input.claims.length === 0) {
    throw new Error(
      "a role round needs a non-empty claims array: with nothing to refute it would return a CLEAR artifact for a round that tested nothing.",
    );
  }
  const claims = [];
  for (const raw of input.claims) {
    if (typeof raw !== "string" || normalizeClaim(raw).length === 0) {
      throw new Error(
        `every claim must be a non-empty string with text beyond a list marker; got ${JSON.stringify(raw)}.`,
      );
    }
    const claim = normalizeClaim(raw);
    if (!claims.includes(claim)) claims.push(claim);
  }

  const rolePrompt = `You are reviewing the ref ${targetRef} of this repository under a refutation contract.
${diffScope}

${groundRules}

${docsClause}Your contract is the named list of claims below. Take each one as something to REFUTE, not to confirm, and run the evidence yourself rather than taking the claim's own justification on faith. Return exactly one entry per claim, with the claim text copied verbatim so the caller can pair it back up, and a verdict of HOLDS, REFUTED, or COULD-NOT-VERIFY. COULD-NOT-VERIFY is not a pass: an unverifiable claim gates the round exactly as a refuted one does, and uncertainty defaults to refuted.

The claims:
${claims.map((claim, i) => `${i + 1}. ${claim}`).join("\n")}

Anything else you find in this diff that is worth the caller knowing goes in findings, separate from the claims -- do not stretch a claim to cover it, and do not invent a claim you were not given.`;

  const result = await agent(rolePrompt, {
    label: input.role,
    phase: "Review",
    agentType: input.role,
    schema: ROLE_SCHEMA,
    model: "opus",
  });
  if (!result) throw new Error(salvage(input.role));

  const answered = result.claims.map((entry) =>
    pairingKey(String(entry.claim ?? "")),
  );
  const unpairable = (detail) =>
    new Error(
      `${input.role} ${detail}\nIts verdicts in full, so the completed analysis is not lost with the round:\n${JSON.stringify(result.claims, null, 1)}`,
    );
  const count = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  if (result.claims.length !== claims.length) {
    throw unpairable(
      `returned ${count(result.claims.length, "verdict")} for ${count(claims.length, "claim")}; the contract needs exactly one verdict per claim.`,
    );
  }

  // A role agent echoing a long claim back drops its trailing clause -- and closes the
  // sentence where it cut -- often enough to cost whole rounds at this step, so an echo
  // that is the contract claim with a trailing clause dropped pairs with it once tail
  // punctuation is off both sides. Truncation only, not extension: an echo that dropped
  // the claim's limit clause verified a BROADER assertion, whose HOLDS implies the
  // narrower contract claim, so restoring the contract text is sound; an echo that ADDED
  // text verified a different, more specific assertion whose verdict does not transfer,
  // so it is left to fail as unpaired. The contract's own text then replaces the lossy
  // echo, and echoInexact tells the caller the substitution happened.
  const withoutTail = (text) => text.replace(/[\s.,;:!?]+$/, "");
  const truncates = (echo, key) => {
    const stem = withoutTail(echo);
    return stem.length > 0 && withoutTail(key).startsWith(stem);
  };
  const keys = claims.map(pairingKey);
  const paired = new Array(claims.length);
  const taken = result.claims.map(() => false);
  const candidates = (matches) =>
    [...result.claims.keys()].filter(
      (entry) => !taken[entry] && matches(entry),
    );

  claims.forEach((claim, index) => {
    const exact = candidates((entry) => answered[entry] === keys[index]);
    if (exact.length > 1) {
      throw unpairable(
        `returned ${count(exact.length, "verdict")} for the claim "${claim}"; the contract needs exactly one per claim.`,
      );
    }
    if (exact.length === 1) {
      paired[index] = { ...result.claims[exact[0]], claim };
      taken[exact[0]] = true;
    }
  });

  claims.forEach((claim, index) => {
    if (paired[index]) return;
    const near = candidates((entry) => truncates(answered[entry], keys[index]));
    if (near.length !== 1) {
      throw unpairable(
        `returned ${count(near.length, "verdict")} for the claim "${claim}"; the contract needs exactly one per claim.`,
      );
    }
    const rival = claims.findIndex(
      (_, i) =>
        i !== index && !paired[i] && truncates(answered[near[0]], keys[i]),
    );
    if (rival !== -1) {
      throw unpairable(
        `echoed "${answered[near[0]]}", which pairs with more than one unmatched claim: "${claim}" and "${claims[rival]}".`,
      );
    }
    paired[index] = {
      ...result.claims[near[0]],
      claim,
      echoInexact: true,
    };
    taken[near[0]] = true;
  });

  return {
    claims: paired,
    findings: result.findings,
    gate: paired.some((entry) => entry.verdict !== "HOLDS"),
    summary: result.summary,
  };
}

if (
  input.claims !== undefined &&
  input.claims !== null &&
  !(Array.isArray(input.claims) && input.claims.length === 0)
) {
  throw new Error(
    "claims were passed without a role: a lens round has no refutation contract to run them under, so it would drop them and review nothing they name. Pass --role security-reviewer or --role adversarial-verifier, or drop the claims.",
  );
}

const reviewerPrompt = `You are a senior software engineer reviewing the ref ${targetRef} of this repository.
${diffScope}

${groundRules}

${docsClause}Review for: correctness bugs, logic errors, security issues, missing error handling at system boundaries, type-safety issues, API-contract violations, documentation-tier placement (spec-level detail -- a constant value, byte/wire layout, an HKDF info string or other algorithm step, or "would only need revisiting if..." rationale -- written into a docs/ overview doc rather than docs/spec/), excess prose (a comment that restates the adjacent code, narrates change history -- "now", "previously", "was moved" -- duplicates a JSDoc, or cites a board item id; name such findings "excess prose: ..."), and anything else that looks wrong.

Do NOT flag missing comments or ask for more explanatory prose unless a genuinely non-obvious constraint is uncarried by the code, names, types, and tests -- this codebase treats prose as a last resort and a check, test, or rename as the preferred carrier.

Separately from the findings, answer the shape question: is there a materially simpler shape for this branch's change -- a different factoring, an existing mechanism it should have reused, a smaller surface? Set simpler=true ONLY if you can name the shape in one sentence (put it in reason); otherwise simpler=false with a short reason. Do not force it.`;

const reviews = (
  await parallel(
    [1, 2, 3].map(
      (n) => () =>
        agent(reviewerPrompt, {
          label: `reviewer-${n}`,
          phase: "Review",
          schema: REVIEWER_SCHEMA,
          model: "sonnet",
        }),
    ),
  )
).filter(Boolean);
if (reviews.length === 0) throw new Error(salvage("Every lens reviewer"));

const consolidatorPrompt = `You are consolidating a code review of the ref ${targetRef}. ${reviews.length} independent reviewers examined git diff "origin/staging...${targetRef}" (three-dot; that ref's own changes only -- never widen the diff, and never substitute HEAD). Their findings:
${JSON.stringify(
  reviews.map((r, i) => ({ reviewer: i + 1, findings: r.findings })),
  null,
  1,
)}

${groundRules}

${docsClause}In a single pass -- no sub-agents, no iteration:
1. Drop any finding that is not about ${targetRef}'s own changes (anything describing the branch's base moving, or staging's progress since the fork) -- discard it before clustering, do not even list it as refuted.
2. Cluster findings that describe the same underlying issue across reviewers; flaggedBy is the number of distinct reviewers in the cluster.
3. Verify each cluster's core claim by reading only the specific hunks or files it names -- not the whole diff -- and set verification confirmed/refuted/unverifiable with a one-line verificationNote.`;

const consolidated = await agent(consolidatorPrompt, {
  label: "consolidator",
  phase: "Consolidate",
  schema: CONSOLIDATOR_SCHEMA,
  model: "sonnet",
});
if (!consolidated) throw new Error(salvage("The consolidator"));

return {
  reviewerCount: reviews.length,
  simplerShapeVotes: reviews.map((r) => r.simplerShape),
  clusters: consolidated.clusters,
};
