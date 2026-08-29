#!/usr/bin/env node
// Release signing coupling check, run by static_checks.yaml on every pull
// request.
//
// Keyless signing leaves no public key to fetch, so what the `cosign verify`
// command docs/RELEASES.md publishes pins is the release workflow's Sigstore
// identity: this repository's path to the workflow file, plus the ref the run
// came from. Both halves are properties of the workflow rather than of the
// document -- its filename and its `on.push.tags` filter -- and neither a
// rename nor a widened trigger touches the document. What the drift costs runs
// in both directions: a published pattern that no longer describes the signer
// refuses the signature a real release produced, so a partner's verification
// fails over a good image and the project hears about it from the partner; a
// pattern loosened until it passes again accepts signatures a release did not
// produce.
//
// The workflow's own self-verify step catches the first direction, but only at
// release time, with the tag already pushed and the image already published.
// This check is the pull-request half.
//
// Four rules:
//
//   1. The signing workflow and docs/RELEASES.md publish ONE identity pattern
//      and ONE issuer between them, and the issuer is GitHub Actions'. This is
//      what holds the workflow's self-verify to the command a partner runs:
//      they are the same two literals or the check fails.
//   2. That identity decomposes to the anchored shape
//      `^https://github\.com/<owner>/<repo>/<workflow path>@refs/tags/<tag>$`,
//      and its workflow-path segment is the signing workflow's own path. The
//      decomposition refuses any regular-expression metacharacter in the path
//      segment, so a pattern loosened by unescaping a `.` fails here rather
//      than reading as a rename.
//   3. Its tag pattern is the signing workflow's own `on.push.tags` filter.
//   4. Every step that pushes an image is followed by its own cosign sign,
//      cosign verify and attest steps before any later image build. A second
//      image's push sitting between the first one's push and its signing leaves
//      the first published under `latest` and unsigned for as long as that
//      build runs, and permanently if the build fails.
//
// What this check cannot see:
//   - Whether the identity is the one a run actually produces. It holds the
//     published pattern to this repository's workflow path and tag filter;
//     wrong together is agreement. What Fulcio puts in the certificate was
//     driven rather than inferred, and is recorded in
//     docs/notes/cosign-keyless-signing.md.
//   - The `<owner>/<repo>` segment, which nothing in the tree derives. A fork
//     publishing this document unchanged reads as agreeing.
//   - Rule 3 compares text under a stated correspondence rather than modelling
//     GitHub's filter-pattern semantics: over the character class it accepts
//     (letters, digits, `_`, `-`, `/`, `.`, `+`, `[`, `]`), a filter and a
//     regular expression agree character for character except that `.` is
//     literal in a filter and must be escaped in a regular expression. A filter
//     carrying anything else -- `*` and `?` above all, whose glob meanings a
//     regular expression does not share -- fails the rule rather than being
//     translated on a guess.
//   - Whether any of it verifies. Only a release run signs anything; the
//     workflow's self-verify step is what measures that, and this check is what
//     keeps the step's two arguments the published ones.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const WORKFLOW_DIR = ".github/workflows";
const WORKFLOW_FILE = /\.ya?ml$/;

/** The document publishing the verification commands a partner runs. */
export const RELEASES_DOC = "docs/RELEASES.md";

/**
 * GitHub Actions' OIDC issuer, which is what vouches for the workflow identity
 * Fulcio writes into the signing certificate. Driven rather than read off a
 * document: docs/notes/cosign-keyless-signing.md records the probe runs.
 */
export const ACTIONS_OIDC_ISSUER =
  "https://token.actions.githubusercontent.com";

const BUILD_ACTION = "docker/build-push-action@";
const ATTEST_ACTION = "actions/attest-build-provenance@";

// `(?![-\w])` so `cosign sign-blob` and `cosign verify-attestation` -- neither of
// which is a container signature or its verification -- are not read as one.
const COSIGN_SIGN = /\bcosign\s+sign(?![-\w])/;
const COSIGN_VERIFY = /\bcosign\s+verify(?![-\w])/;

const DIGEST_REFERENCE = /steps\.([A-Za-z_][\w-]*)\.outputs\.digest/g;

// Single-quoted because the pattern carries backslashes and `$`, which a shell
// would otherwise eat; the workflow and the document both write it that way.
const IDENTITY_FLAG = /--certificate-identity-regexp\s+'([^']*)'/g;
const ISSUER_FLAG = /--certificate-oidc-issuer\s+(\S+)/g;

// The whole published shape in one pass: anchored at both ends, over
// github.com, with the ref segment split off at `@refs/tags/`.
const IDENTITY_SHAPE = /^\^https:\/\/github\\\.com\/(.+?)@refs\/tags\/(.+)\$$/;

// The characters a signer path may carry unescaped -- everything else in a
// regular expression is either a metacharacter or an escape.
const LITERAL_CHARACTER = /[\w/-]/;

// The characters a tag filter may carry for rule 3's correspondence to hold.
const FILTER_CHARACTER = /[\w./+[\]-]/;

const SIGNING_ROLES = ["sign", "verify", "attest"];

const ROLE_WORDS = {
  sign: "signed",
  verify: "verified against the published identity",
  attest: "attested",
};

const list = (values) => values.map((value) => `\`${value}\``).join(", ");

/**
 * Every `--certificate-identity-regexp` and `--certificate-oidc-issuer` value a
 * source carries, in order. Markdown and YAML alike: both hold the flags as
 * shell command text, so one scan reads either.
 */
export function certificateFlags(source) {
  const values = (pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1]);
  return { identities: values(IDENTITY_FLAG), issuers: values(ISSUER_FLAG) };
}

/**
 * The literal path a regular-expression fragment matches, or a problem naming
 * the first character that makes it something other than a literal. Only `\.`
 * is accepted as an escape, because a signer path needs no other.
 */
export function unescapeRegexLiteral(fragment) {
  let literal = "";
  for (let index = 0; index < fragment.length; index += 1) {
    const character = fragment[index];
    if (character === "\\") {
      const escaped = fragment[index + 1];
      if (escaped !== ".") {
        return {
          problem: `\`${fragment.slice(index, index + 2)}\` is an escape this check does not read as a literal character`,
        };
      }
      literal += ".";
      index += 1;
      continue;
    }
    if (!LITERAL_CHARACTER.test(character)) {
      return {
        problem: `\`${character}\` is a regular-expression metacharacter rather than a literal one, so the pattern matches more than the one signer it names`,
      };
    }
    literal += character;
  }
  return { literal };
}

/**
 * The `{repository, workflowPath, refPattern}` a published signer-identity
 * pattern names, or a `{problem}` phrase naming why it names none.
 */
export function parseSignerIdentity(pattern) {
  try {
    new RegExp(pattern);
  } catch (error) {
    return {
      problem: `is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const match = IDENTITY_SHAPE.exec(pattern);
  if (match === null) {
    return {
      problem:
        "does not have the shape `^https://github\\.com/<owner>/<repo>/<workflow path>@refs/tags/<tag pattern>$`, so this check cannot tell which workflow and which refs it pins. An unanchored pattern in particular accepts signatures a release did not produce",
    };
  }
  const [, subject, refPattern] = match;
  const { literal, problem } = unescapeRegexLiteral(subject);
  if (problem !== undefined) {
    return { problem: `names its signer as \`${subject}\`, where ${problem}` };
  }
  const segments = literal.split("/");
  if (segments.length < 3) {
    return {
      problem: `names \`${literal}\`, which is not an <owner>/<repo>/<workflow path> triple`,
    };
  }
  return {
    repository: segments.slice(0, 2).join("/"),
    workflowPath: segments.slice(2).join("/"),
    refPattern,
  };
}

/**
 * A tag filter as the regular-expression fragment matching the same refs, or a
 * problem when the filter carries a character outside the class over which that
 * correspondence holds. The header states the correspondence and its limit.
 */
export function refPatternForTagFilter(filter) {
  if (typeof filter !== "string" || filter === "") {
    return { problem: "the trigger's tag filter is not a non-empty string" };
  }
  for (const character of filter) {
    if (!FILTER_CHARACTER.test(character)) {
      return {
        problem: `\`${character}\` is a filter-pattern character this check does not translate, because a regular expression does not read it the same way`,
      };
    }
  }
  return { pattern: filter.replace(/\./g, "\\.") };
}

/** The tag filters a workflow's `on.push.tags` trigger carries. */
export function tagFilters(source) {
  const tags = parse(source)?.on?.push?.tags;
  if (typeof tags === "string") return [tags];
  return Array.isArray(tags) ? tags : [];
}

const stepName = (step) =>
  typeof step?.name === "string"
    ? `"${step.name}"`
    : typeof step?.uses === "string"
      ? `the \`${step.uses}\` step`
      : "an unnamed step";

const digestReferences = (text) => [
  ...new Set([...text.matchAll(DIGEST_REFERENCE)].map((match) => match[1])),
];

/** A step's part in the publish sequence, and the step digests it names. */
export function classifyStep(step) {
  const uses = typeof step?.uses === "string" ? step.uses : "";
  const run = typeof step?.run === "string" ? step.run : "";
  if (uses.startsWith(BUILD_ACTION)) {
    return {
      role: "build",
      ids: typeof step?.id === "string" ? [step.id] : [],
      push: step?.with?.push,
    };
  }
  if (uses.startsWith(ATTEST_ACTION)) {
    return {
      role: "attest",
      ids: digestReferences(String(step?.with?.["subject-digest"] ?? "")),
    };
  }
  if (COSIGN_SIGN.test(run))
    return { role: "sign", ids: digestReferences(run) };
  if (COSIGN_VERIFY.test(run)) {
    return { role: "verify", ids: digestReferences(run) };
  }
  return { role: null, ids: [] };
}

function pushState(value) {
  if (value === true || value === "true") return "pushed";
  if (value === false || value === "false" || value === undefined) {
    return "held";
  }
  return "unknown";
}

/**
 * Every way a workflow's publish sequence lets a pushed image exist unsigned,
 * unverified or unattested while another build runs. Empty means each pushed
 * image is signed, verified and attested before any later build starts.
 */
export function publishSequenceViolations(source, file) {
  const jobs = parse(source)?.jobs;
  const violations = [];
  let pushed = 0;

  for (const [jobId, job] of Object.entries(jobs ?? {})) {
    const steps = Array.isArray(job?.steps) ? job.steps : [];
    const classified = steps.map((step, index) => ({
      index,
      name: stepName(step),
      ...classifyStep(step),
    }));
    const builds = classified.filter((step) => step.role === "build");
    const where = (step) => `${step.name} in job \`${jobId}\``;
    const pushedIds = new Set();

    for (const build of builds) {
      const state = pushState(build.push);
      if (state === "unknown") {
        violations.push(
          `${file}: ${where(build)} sets \`push: ${build.push}\`, which this check cannot read as pushed or held. Write a literal true or false, so whether the step publishes an image stays legible here.`,
        );
        continue;
      }
      if (state === "held") continue;
      pushed += 1;

      const [id] = build.ids;
      if (id === undefined) {
        violations.push(
          `${file}: ${where(build)} pushes an image but carries no \`id:\`, so no signing, verification or attestation step can name the digest it published.`,
        );
        continue;
      }
      pushedIds.add(id);

      const nextBuild = builds.find((step) => step.index > build.index);
      const limit = nextBuild === undefined ? steps.length : nextBuild.index;
      const before =
        nextBuild === undefined
          ? "the job ends"
          : `${nextBuild.name} starts the next image build`;
      const found = {};
      for (const role of SIGNING_ROLES) {
        found[role] = classified.find(
          (step) =>
            step.role === role &&
            step.index > build.index &&
            step.index < limit &&
            step.ids.includes(id),
        );
        if (found[role] === undefined) {
          violations.push(
            `${file}: the image ${where(build)} pushes is not ${ROLE_WORDS[role]} -- by a step naming \`steps.${id}.outputs.digest\` -- before ${before}. Each pushed image is signed, verified and attested as a unit immediately after its own push, so the window in which a published image is unsigned is its own signing step and never another artifact's build.`,
          );
        }
      }
      if (
        found.sign !== undefined &&
        found.verify !== undefined &&
        found.verify.index < found.sign.index
      ) {
        violations.push(
          `${file}: ${where(found.verify)} verifies \`steps.${id}.outputs.digest\` before ${where(found.sign)} signs it, so it checks a signature that does not exist yet.`,
        );
      }
    }

    for (const step of classified) {
      if (!SIGNING_ROLES.includes(step.role)) continue;
      if (step.ids.some((id) => pushedIds.has(id))) continue;
      violations.push(
        `${file}: ${where(step)} names ${step.ids.length === 0 ? "no step digest at all" : `${list(step.ids.map((id) => `steps.${id}.outputs.digest`))}, which no pushing build in this job produces`}, so what it covers cannot be read from this file.`,
      );
    }
  }

  if (pushed === 0) {
    // First, because every other violation collected above is downstream of it:
    // with nothing published, the sequence rule is measuring nothing.
    violations.unshift(
      `${file}: no step pushes an image, so nothing here is signed, verified or attested. Either the release no longer publishes one, or the step shapes this check reads (\`${BUILD_ACTION}\` with \`push: true\`) have moved and the rule is measuring nothing.`,
    );
  }
  return violations;
}

/**
 * Every way the published verification command and the workflow that produces
 * the signature it checks are out of step. Empty means the document, the
 * workflow's self-verify step, the workflow's path and its tag trigger all name
 * one signer.
 */
export function couplingViolations({
  workflowPath,
  workflowSource,
  docSource,
}) {
  const violations = [];
  const doc = certificateFlags(docSource);
  const workflow = certificateFlags(workflowSource);

  if (doc.identities.length === 0) {
    violations.push(
      `${RELEASES_DOC} publishes no \`--certificate-identity-regexp\`, so there is no pinned signer for ${workflowPath} to be held to. The verification command a partner runs is what this check couples to the workflow.`,
    );
  }
  if (workflow.identities.length === 0) {
    violations.push(
      `${workflowPath} runs no \`cosign verify --certificate-identity-regexp\`, so a release publishes an image without ever checking that the command ${RELEASES_DOC} publishes verifies it.`,
    );
  }

  const identities = [...new Set([...doc.identities, ...workflow.identities])];
  const issuers = [...new Set([...doc.issuers, ...workflow.issuers])];
  if (identities.length > 1) {
    violations.push(
      `${RELEASES_DOC} and ${workflowPath} carry ${identities.length} different \`--certificate-identity-regexp\` values between them: ${list(identities)}. The release verifies its own signature with one of them and the partner runs another.`,
    );
  }
  if (issuers.length > 1) {
    violations.push(
      `${RELEASES_DOC} and ${workflowPath} carry ${issuers.length} different \`--certificate-oidc-issuer\` values between them: ${list(issuers)}.`,
    );
  }
  for (const issuer of issuers) {
    if (issuer === ACTIONS_OIDC_ISSUER) continue;
    violations.push(
      `\`${issuer}\` is pinned as the certificate's OIDC issuer, but a signature produced by a GitHub Actions job carries \`${ACTIONS_OIDC_ISSUER}\`. Verification compares the issuer for equality, so this pin refuses every release signature.`,
    );
  }
  if (issuers.length === 0) {
    violations.push(
      `Neither ${RELEASES_DOC} nor ${workflowPath} pins \`--certificate-oidc-issuer\`. Both \`--certificate-\` arguments are required: an identity pattern alone is satisfied by a certificate any issuer minted.`,
    );
  }

  if (identities.length !== 1) return violations;
  const [pattern] = identities;
  const identity = parseSignerIdentity(pattern);
  if (identity.problem !== undefined) {
    violations.push(
      `The published signer identity \`${pattern}\` ${identity.problem}.`,
    );
    return violations;
  }

  if (identity.workflowPath !== workflowPath) {
    violations.push(
      `The published signer identity pins the workflow \`${identity.workflowPath}\`, but the workflow that signs the release images is \`${workflowPath}\`. Fulcio writes the running workflow's own path into the certificate, so the published command refuses the signature every release produces.`,
    );
  }

  const filters = tagFilters(workflowSource);
  if (filters.length !== 1) {
    violations.push(
      `${workflowPath} triggers on ${filters.length} tag filters${filters.length === 0 ? "" : ` (${list(filters)})`}, and this check holds the published identity against exactly one. Either the workflow lost the tag trigger the signer identity is made of, or the identity now covers a set of filters that has to be compared by hand.`,
    );
    return violations;
  }

  const translated = refPatternForTagFilter(filters[0]);
  if (translated.problem !== undefined) {
    violations.push(
      `${workflowPath} triggers on tags matching \`${filters[0]}\`, which this check cannot compare against the published identity: ${translated.problem}. Compare the two by hand and narrow the filter, or widen this check deliberately.`,
    );
    return violations;
  }
  if (translated.pattern !== identity.refPattern) {
    violations.push(
      `The published signer identity pins refs matching \`${identity.refPattern}\`, but ${workflowPath} triggers on tags matching \`${filters[0]}\` -- \`${translated.pattern}\` as a regular expression. Every release run outside the published pattern signs an image the published command refuses, and every ref inside it that the trigger no longer admits is a signature the pattern would accept from somewhere else.`,
    );
  }
  return violations;
}

/**
 * The workflow that signs the release images, as `{path, source}`, or a
 * `{problem}` when the tree holds other than exactly one.
 */
export function findSigningWorkflow(workflows) {
  const signing = workflows.filter(({ source }) => {
    const jobs = parse(source)?.jobs;
    return Object.values(jobs ?? {}).some((job) =>
      (Array.isArray(job?.steps) ? job.steps : []).some(
        (step) => classifyStep(step).role === "sign",
      ),
    );
  });
  if (signing.length === 1) return signing[0];
  return {
    problem:
      signing.length === 0
        ? `no workflow under ${WORKFLOW_DIR} runs \`cosign sign\`, so nothing signs a release image, or the step shape this check reads has moved`
        : `${signing.length} workflows under ${WORKFLOW_DIR} run \`cosign sign\` (${list(signing.map(({ path }) => path))}), and this check holds the published identity against exactly one signer`,
  };
}

function readWorkflows(root) {
  return readdirSync(resolve(root, WORKFLOW_DIR))
    .filter((name) => WORKFLOW_FILE.test(name))
    .sort()
    .map((name) => ({
      path: `${WORKFLOW_DIR}/${name}`,
      source: readFileSync(resolve(root, WORKFLOW_DIR, name), "utf8"),
    }));
}

/**
 * Every rule run over a repository tree, with what a passing run reports. The
 * file reads live here rather than in the CLI entry so a test can drive the
 * whole check -- finding the signer, reading the document, both rule sets --
 * over a tree of its own.
 */
export function releaseSigningReport(root) {
  const signing = findSigningWorkflow(readWorkflows(root));
  if (signing.problem !== undefined) return { violations: [signing.problem] };
  return {
    violations: [
      ...couplingViolations({
        workflowPath: signing.path,
        workflowSource: signing.source,
        docSource: readFileSync(resolve(root, RELEASES_DOC), "utf8"),
      }),
      ...publishSequenceViolations(signing.source, signing.path),
    ],
    workflowPath: signing.path,
    identity: certificateFlags(signing.source).identities[0],
  };
}

// CLI entry: only runs when invoked directly, so the test can import the rules
// and drive them over sources of its own without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { violations, workflowPath, identity } = releaseSigningReport(root);
  if (violations.length > 0) {
    console.error("Release signing check failed:\n");
    for (const violation of violations) console.error(`  ${violation}`);
    console.error(
      `\nThe signature a release produces and the command ${RELEASES_DOC} publishes pin one identity, which is the signing workflow's path plus its tag trigger. Change one and change all of them in the same edit.`,
    );
    process.exit(1);
  }
  console.log(
    `Release signing check passed: ${workflowPath} verifies each image it publishes against \`${identity}\`, the identity ${RELEASES_DOC} publishes, and signs, verifies and attests each pushed image before the next build.`,
  );
}
