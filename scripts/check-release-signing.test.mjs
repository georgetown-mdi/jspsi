import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  ACTIONS_OIDC_ISSUER,
  RELEASES_DOC,
  certificateFlags,
  couplingViolations,
  findSigningWorkflow,
  parseSignerIdentity,
  parseSignerWorkflow,
  publishSequenceViolations,
  publishedCertificatePair,
  refPatternForTagFilter,
  releaseSigningReport,
  signerWorkflows,
  tagFilters,
  unescapeRegexLiteral,
} from "./check-release-signing.mjs";
import { parseWorkflow } from "./lib/workflows.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const SCRIPT = resolve(here, "check-release-signing.mjs");

const readRoot = (relative) =>
  readFileSync(resolve(repoRoot, relative), "utf8");

// The rule reads a parsed workflow; each case states the source it stands for.
const tagFiltersIn = (source) =>
  tagFilters(parseWorkflow("fixture.yaml", source));

const RELEASE_WORKFLOW = ".github/workflows/release.yaml";
const releaseWorkflowSource = readRoot(RELEASE_WORKFLOW);
const releasesDocSource = readRoot(RELEASES_DOC);

// The committed identity and attestation signer, read rather than transcribed:
// a fixture that carried its own copy would keep passing after the published
// one moved.
const [IDENTITY] = certificateFlags(releasesDocSource).identities;
const [SIGNER_WORKFLOW] = signerWorkflows(releasesDocSource);
const TAG_FILTER = "v[0-9]+.[0-9]+.[0-9]+";

const buildStep = (id, push) =>
  [
    `      - name: Build ${id}`,
    `        id: ${id}`,
    "        uses: docker/build-push-action@v7",
    "        with:",
    `          push: ${push}`,
  ].join("\n");

const signStep = (id) =>
  [
    `      - name: Sign ${id}`,
    "        run: |",
    "          cosign sign --yes \\",
    `            vdorie/psi-link@\${{ steps.${id}.outputs.digest }}`,
  ].join("\n");

const verifyStep = (
  id,
  { identity = IDENTITY, issuer = ACTIONS_OIDC_ISSUER } = {},
) =>
  [
    `      - name: Verify ${id}`,
    "        run: |",
    "          cosign verify \\",
    `            --certificate-identity-regexp '${identity}' \\`,
    `            --certificate-oidc-issuer ${issuer} \\`,
    `            vdorie/psi-link@\${{ steps.${id}.outputs.digest }}`,
  ].join("\n");

const verifyStepWithoutArguments = (id) =>
  verifyStep(id)
    .split("\n")
    .filter((line) => !line.includes("--certificate-"))
    .join("\n");

// The pair of `--certificate-` lines as release.yaml holds them, matched once
// so a mutation strips exactly the first verify step's copy and leaves the
// variant's in place.
const CERTIFICATE_ARGUMENT_LINES =
  /^ *--certificate-identity-regexp '[^']*' \\\n *--certificate-oidc-issuer \S+ \\\n/m;

const attestStep = (id) =>
  [
    `      - name: Attest ${id}`,
    "        uses: actions/attest-build-provenance@v4",
    "        with:",
    `          subject-digest: \${{ steps.${id}.outputs.digest }}`,
  ].join("\n");

const workflow = ({ tags = [TAG_FILTER], steps }) =>
  [
    "name: Release",
    "on:",
    "  push:",
    "    tags:",
    ...tags.map((tag) => `      - "${tag}"`),
    "jobs:",
    "  publish:",
    "    steps:",
    ...steps,
    "",
  ].join("\n");

/** The publish sequence as release.yaml holds it: each image a unit. */
const orderedSteps = [
  buildStep("build", true),
  signStep("build"),
  verifyStep("build"),
  attestStep("build"),
  buildStep("build_fips", true),
  signStep("build_fips"),
  verifyStep("build_fips"),
  attestStep("build_fips"),
];

const doc = ({
  identity = IDENTITY,
  issuer = ACTIONS_OIDC_ISSUER,
  signerWorkflow = SIGNER_WORKFLOW,
} = {}) =>
  [
    "## Verifying a Release",
    "",
    "```sh",
    "cosign verify \\",
    `  --certificate-identity-regexp '${identity}' \\`,
    `  --certificate-oidc-issuer ${issuer} \\`,
    "  vdorie/psi-link:X.Y.Z",
    "```",
    "",
    "### Build provenance",
    "",
    "```sh",
    "gh attestation verify oci://docker.io/vdorie/psi-link@sha256:... \\",
    "  --repo georgetown-mdi/jspsi \\",
    `  --signer-workflow ${signerWorkflow}`,
    "```",
    "",
  ].join("\n");

// The pair a verify step is held to, derived from the same fixture document the
// coupling rules read rather than transcribed beside it.
const PUBLISHED = publishedCertificatePair(doc());

const coupling = (overrides = {}) =>
  couplingViolations({
    workflowPath: RELEASE_WORKFLOW,
    workflowSource: workflow({ steps: orderedSteps }),
    docSource: doc(),
    ...overrides,
  });

describe("the certificate arguments a source publishes", () => {
  it("reads every occurrence of both flags", () => {
    // The document publishes the command three times -- the image, the FIPS
    // variant, and the launcher digest -- and every copy is one of the values
    // the agreement rule holds together.
    const { identities, issuers } = certificateFlags(releasesDocSource);
    expect(identities.length).toBeGreaterThan(1);
    expect(new Set(identities).size).toBe(1);
    expect(new Set(issuers)).toEqual(new Set([ACTIONS_OIDC_ISSUER]));
  });

  it("reads none from a source carrying neither", () => {
    expect(certificateFlags("cosign sign --yes image@sha256:abc")).toEqual({
      identities: [],
      issuers: [],
    });
  });
});

describe("the literal a signer path is made of", () => {
  it("unescapes an escaped dot and passes path characters through", () => {
    expect(
      unescapeRegexLiteral(
        "georgetown-mdi/jspsi/\\.github/workflows/a_b.yaml".replace(
          ".yaml",
          "\\.yaml",
        ),
      ),
    ).toEqual({ literal: "georgetown-mdi/jspsi/.github/workflows/a_b.yaml" });
  });

  it("refuses an unescaped dot, which matches any character", () => {
    // The loosening the document warns about, one character at a time: an
    // unescaped `.` in the workflow path accepts `release-yaml`, `releaseXyaml`
    // and every other single character in that position.
    const { problem } = unescapeRegexLiteral("owner/repo/release.yaml");
    expect(problem).toContain("metacharacter");
  });

  it("refuses a quantifier, a class, and an escape it does not read", () => {
    for (const fragment of [
      "owner/repo/.*",
      "owner/repo/[a-z]+",
      "owner/\\w+",
    ]) {
      expect(unescapeRegexLiteral(fragment).problem).toBeDefined();
    }
  });
});

describe("the signer a published identity names", () => {
  it("decomposes the committed pattern", () => {
    expect(parseSignerIdentity(IDENTITY)).toEqual({
      repository: "georgetown-mdi/jspsi",
      workflowPath: RELEASE_WORKFLOW,
      refPattern: "v[0-9]+\\.[0-9]+\\.[0-9]+",
    });
  });

  it("refuses a pattern anchored at neither end or at one", () => {
    // An unanchored pattern is satisfied by any identity carrying the published
    // one as a substring -- a fork whose repository name ends in `jspsi`, or a
    // ref that merely starts with a release tag.
    for (const pattern of [
      IDENTITY.slice(1),
      IDENTITY.slice(0, -1),
      IDENTITY.slice(1, -1),
    ]) {
      expect(parseSignerIdentity(pattern).problem).toContain("shape");
    }
  });

  it("refuses a pattern over another host or another ref namespace", () => {
    for (const pattern of [
      IDENTITY.replace("github\\.com", "github\\.example"),
      IDENTITY.replace("refs/tags", "refs/heads"),
    ]) {
      expect(parseSignerIdentity(pattern).problem).toContain("shape");
    }
  });

  it("refuses a pattern that is not a regular expression at all", () => {
    expect(
      parseSignerIdentity("^https://github\\.com/a/b/c@refs/tags/(v$").problem,
    ).toContain("valid regular expression");
  });

  it("refuses a subject that is not an owner/repo/path triple", () => {
    expect(
      parseSignerIdentity("^https://github\\.com/owner/repo@refs/tags/v1$")
        .problem,
    ).toContain("triple");
  });
});

describe("a tag filter as a regular expression", () => {
  it("escapes the dots and leaves the rest alone", () => {
    expect(refPatternForTagFilter(TAG_FILTER)).toEqual({
      pattern: "v[0-9]+\\.[0-9]+\\.[0-9]+",
    });
  });

  it("refuses the filter characters a regular expression reads differently", () => {
    // `*` and `?` are the pair that matter: both are glob wildcards and both are
    // quantifiers here, so translating one on a guess would compare a pattern
    // against refs it does not admit.
    for (const filter of ["v*", "v?.?.?", "v{1,2}", "v!x"]) {
      expect(refPatternForTagFilter(filter).problem).toBeDefined();
    }
  });

  it("refuses an empty or absent filter", () => {
    for (const filter of ["", undefined, 7]) {
      expect(refPatternForTagFilter(filter).problem).toBeDefined();
    }
  });
});

describe("the tag trigger a workflow declares", () => {
  it("reads the committed release trigger", () => {
    expect(tagFiltersIn(releaseWorkflowSource)).toEqual([TAG_FILTER]);
  });

  it("reads a scalar filter and an absent trigger", () => {
    expect(tagFiltersIn("on:\n  push:\n    tags: v*\n")).toEqual(["v*"]);
    expect(tagFiltersIn("on:\n  pull_request:\n")).toEqual([]);
  });
});

describe("the coupling between the published commands and the signer", () => {
  it("passes a document and a workflow naming one signer", () => {
    expect(coupling()).toEqual([]);
  });

  it("fails a workflow renamed out from under the published commands", () => {
    // The rename half of the drift, which costs both published commands: the
    // document keeps naming the old path while GitHub writes the new one into
    // every certificate and every attestation.
    const violations = coupling({
      workflowPath: ".github/workflows/publish.yaml",
    });
    expect(violations).toHaveLength(2);
    for (const violation of violations) {
      expect(violation).toContain("publish.yaml");
      expect(violation).toContain(RELEASE_WORKFLOW);
    }
  });

  it("fails a tag trigger widened out from under it", () => {
    // The trigger half: a release run from `release-1.2.3` signs an image the
    // published command refuses.
    const [violation, ...rest] = coupling({
      workflowSource: workflow({
        tags: ["release-[0-9]+.[0-9]+.[0-9]+"],
        steps: orderedSteps,
      }),
    });
    expect(rest).toEqual([]);
    expect(violation).toContain("release-[0-9]+.[0-9]+.[0-9]+");
    expect(violation).toContain("v[0-9]+\\.[0-9]+\\.[0-9]+");
  });

  it("fails a trigger it cannot compare, rather than guessing", () => {
    const [violation] = coupling({
      workflowSource: workflow({ tags: ["v*"], steps: orderedSteps }),
    });
    expect(violation).toContain("`*`");
  });

  it("fails a trigger carrying no filter or several", () => {
    for (const tags of [[], [TAG_FILTER, "v[0-9]+.[0-9]+"]]) {
      const [violation] = coupling({
        workflowSource: workflow({ tags, steps: orderedSteps }),
      });
      expect(violation).toContain("tag filters");
    }
  });

  it("fails a self-verify step carrying a different identity from the document", () => {
    // The failure the self-verify would otherwise hide: the release verifies
    // itself against a pattern nobody publishes and passes, while the command
    // the partner runs refuses the same signature.
    const [violation, ...rest] = coupling({
      workflowSource: workflow({
        steps: [
          buildStep("build", true),
          signStep("build"),
          verifyStep("build", {
            identity: IDENTITY.replace("jspsi", "psilink"),
          }),
          attestStep("build"),
        ],
      }),
    });
    expect(rest).toEqual([]);
    expect(violation).toContain("different");
    expect(violation).toContain("psilink");
  });

  it("fails an issuer no GitHub Actions certificate carries", () => {
    const violations = coupling({
      workflowSource: workflow({
        steps: [
          buildStep("build", true),
          signStep("build"),
          verifyStep("build", { issuer: "https://accounts.google.com" }),
          attestStep("build"),
        ],
      }),
    });
    expect(violations.join("\n")).toContain("accounts.google.com");
    expect(violations.join("\n")).toContain(ACTIONS_OIDC_ISSUER);
  });

  it("fails a document that publishes no pinned identity", () => {
    const [violation] = coupling({ docSource: "## Verifying a Release\n" });
    expect(violation).toContain(RELEASES_DOC);
  });

  it("fails a workflow that never verifies what it signed", () => {
    const [violation] = coupling({
      workflowSource: workflow({
        steps: [
          buildStep("build", true),
          signStep("build"),
          attestStep("build"),
        ],
      }),
    });
    expect(violation).toContain("cosign verify");
  });

  it("fails a command missing the issuer argument entirely", () => {
    const withoutIssuer = doc().replace(
      `  --certificate-oidc-issuer ${ACTIONS_OIDC_ISSUER} \\\n`,
      "",
    );
    const [violation] = coupling({
      docSource: withoutIssuer,
      workflowSource: workflow({
        steps: [
          buildStep("build", true),
          signStep("build"),
          verifyStep("build").replace(
            `            --certificate-oidc-issuer ${ACTIONS_OIDC_ISSUER} \\\n`,
            "",
          ),
          attestStep("build"),
        ],
      }),
    });
    expect(violation).toContain("--certificate-oidc-issuer");
  });
});

describe("the attestation command the document publishes", () => {
  it("reads the workflow the committed command names", () => {
    expect(signerWorkflows(releasesDocSource)).toEqual([SIGNER_WORKFLOW]);
    expect(parseSignerWorkflow(SIGNER_WORKFLOW)).toEqual({
      workflowPath: RELEASE_WORKFLOW,
    });
  });

  it("reads no value from a document publishing no such command", () => {
    expect(signerWorkflows("### Build provenance\n")).toEqual([]);
  });

  it("fails a command naming a workflow other than the signer", () => {
    // The drift the signature rules cannot see: the attestation command names
    // a workflow of its own, so it keeps pointing at the old path through a
    // rename the cosign identity was corrected for.
    const [violation, ...rest] = coupling({
      docSource: doc({
        signerWorkflow: SIGNER_WORKFLOW.replace("release.yaml", "publish.yaml"),
      }),
    });
    expect(rest).toEqual([]);
    expect(violation).toContain("publish.yaml");
    expect(violation).toContain(RELEASE_WORKFLOW);
  });

  it("fails a document that names no signer workflow at all", () => {
    const [violation, ...rest] = coupling({
      docSource: doc().replace(/^ *--signer-workflow.*\n/m, ""),
    });
    expect(rest).toEqual([]);
    expect(violation).toContain("--signer-workflow");
    expect(violation).toContain(RELEASE_WORKFLOW);
  });

  it("fails a value that is not an owner/repo/workflow-path triple", () => {
    for (const value of [
      "release.yaml",
      "georgetown-mdi/jspsi",
      SIGNER_WORKFLOW.replace("jspsi/", "jspsi//"),
    ]) {
      const [violation, ...rest] = coupling({
        docSource: doc({ signerWorkflow: value }),
      });
      expect(rest).toEqual([]);
      expect(violation).toContain("triple");
    }
  });
});

describe("the publish sequence", () => {
  const sequence = (steps, tags = [TAG_FILTER]) =>
    publishSequenceViolations(
      workflow({ tags, steps }),
      "fixture.yaml",
      PUBLISHED,
    );

  it("passes the committed release workflow", () => {
    expect(
      publishSequenceViolations(
        releaseWorkflowSource,
        RELEASE_WORKFLOW,
        publishedCertificatePair(releasesDocSource),
      ),
    ).toEqual([]);
  });

  it("passes each image signed, verified and attested before the next build", () => {
    expect(sequence(orderedSteps)).toEqual([]);
  });

  it("fails a later image build inserted before an earlier push is signed", () => {
    // The variant's push between the default push and its signing leaves
    // `latest` published and unsigned for as long as the variant build runs,
    // and permanently if that build fails.
    const violations = sequence([
      buildStep("build", true),
      buildStep("build_fips", true),
      signStep("build"),
      verifyStep("build"),
      attestStep("build"),
      signStep("build_fips"),
      verifyStep("build_fips"),
      attestStep("build_fips"),
    ]);
    expect(violations).toHaveLength(3);
    for (const violation of violations) {
      expect(violation).toContain("steps.build.outputs.digest");
      expect(violation).toContain("Build build_fips");
    }
  });

  it("fails a scanning build inserted between a push and its signing", () => {
    // `push: false` is still a later image build: the window it opens over the
    // published image is the same one.
    const violations = sequence([
      buildStep("build", true),
      buildStep("scan_candidate", false),
      signStep("build"),
      verifyStep("build"),
      attestStep("build"),
    ]);
    expect(violations).toHaveLength(3);
  });

  it("fails a pushed image that is never signed, verified or attested", () => {
    expect(sequence([buildStep("build", true)])).toHaveLength(3);
    expect(
      sequence([
        buildStep("build", true),
        signStep("build"),
        attestStep("build"),
      ]),
    ).toHaveLength(1);
  });

  it("fails a verification placed before the signature it checks", () => {
    const [violation] = sequence([
      buildStep("build", true),
      verifyStep("build"),
      signStep("build"),
      attestStep("build"),
    ]);
    expect(violation).toContain("before");
  });

  it("fails a pushing build carrying no id", () => {
    const [violation] = sequence([
      buildStep("build", true).replace("        id: build\n", ""),
    ]);
    expect(violation).toContain("`id:`");
  });

  it("fails a signing step naming no pushed image", () => {
    const [violation] = sequence([
      ...orderedSteps,
      signStep("build_absent").replace(
        "steps.build_absent.outputs.digest",
        "steps.nothing.outputs.digest",
      ),
    ]);
    expect(violation).toContain("nothing");
  });

  it("fails a push value it cannot read as pushed or held", () => {
    const violations = sequence([
      buildStep("build", "${{ inputs.publish }}"),
      signStep("build"),
      verifyStep("build"),
      attestStep("build"),
    ]);
    expect(violations.join("\n")).toContain("literal true or false");
  });

  it("fails a workflow in which nothing is pushed at all", () => {
    // The rule measuring nothing is itself a failure: a step shape that moved
    // would otherwise leave every assertion vacuously satisfied.
    const [violation] = sequence([
      buildStep("build", false),
      signStep("build"),
      verifyStep("build"),
      attestStep("build"),
    ]);
    expect(violation).toContain("no step pushes an image");
  });

  it("holds the sequence per job rather than across the file", () => {
    // Two jobs each publishing one image is a shape the rule admits; a job's
    // steps run in its own order and nothing interleaves them.
    const source = [
      "name: Release",
      "on:",
      "  push:",
      "    tags:",
      `      - "${TAG_FILTER}"`,
      "jobs:",
      "  publish:",
      "    steps:",
      buildStep("build", true),
      signStep("build"),
      verifyStep("build"),
      attestStep("build"),
      "  publish_variant:",
      "    steps:",
      buildStep("build_fips", true),
      signStep("build_fips"),
      verifyStep("build_fips"),
      attestStep("build_fips"),
      "",
    ].join("\n");
    expect(publishSequenceViolations(source, "fixture.yaml")).toEqual([]);
  });
});

describe("the arguments each verify step runs", () => {
  const sequence = (steps, published = PUBLISHED) =>
    publishSequenceViolations(workflow({ steps }), "fixture.yaml", published);

  it("reads the published pair, and no value from a document publishing two", () => {
    expect(publishedCertificatePair(releasesDocSource)).toEqual({
      identity: IDENTITY,
      issuer: ACTIONS_OIDC_ISSUER,
    });
    expect(
      publishedCertificatePair(
        doc() + doc({ identity: IDENTITY.replace("jspsi", "psilink") }),
      ),
    ).toEqual({ identity: undefined, issuer: ACTIONS_OIDC_ISSUER });
  });

  it("fails a verify step stripped of both arguments while another keeps them", () => {
    // The drift the file-wide agreement rule cannot see: the variant's step
    // still carries the pair, so the file agrees with itself and with the
    // document, and the stripped step still names the digest that credits it
    // with covering the image.
    const steps = [...orderedSteps];
    steps[2] = verifyStepWithoutArguments("build");
    const source = workflow({ steps });
    expect(coupling({ workflowSource: source })).toEqual([]);

    const violations = publishSequenceViolations(
      source,
      "fixture.yaml",
      PUBLISHED,
    );
    expect(violations).toHaveLength(2);
    for (const violation of violations) {
      expect(violation).toContain('"Verify build" in job');
      expect(violation).toContain("steps.build.outputs.digest");
    }
    expect(violations.join("\n")).toContain("--certificate-identity-regexp");
    expect(violations.join("\n")).toContain("--certificate-oidc-issuer");
  });

  it("fails a verify step pinned to an identity the document does not publish", () => {
    const violations = sequence([
      buildStep("build", true),
      signStep("build"),
      verifyStep("build", { identity: IDENTITY.replace("jspsi", "psilink") }),
      attestStep("build"),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('"Verify build" in job');
    expect(violations[0]).toContain("psilink");
    expect(violations[0]).toContain(RELEASES_DOC);
  });

  it("fails a verify step pinned to an issuer the document does not publish", () => {
    const violations = sequence([
      buildStep("build", true),
      signStep("build"),
      verifyStep("build", { issuer: "https://accounts.google.com" }),
      attestStep("build"),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("accounts.google.com");
  });

  it("holds a step to carrying both arguments with no published pair to match", () => {
    // A document publishing no single pair is the agreement rule's finding
    // rather than this one's, so a value is compared only against a value.
    const divergent = [
      buildStep("build", true),
      signStep("build"),
      verifyStep("build", { identity: IDENTITY.replace("jspsi", "psilink") }),
      attestStep("build"),
    ];
    expect(sequence(divergent, {})).toEqual([]);

    const stripped = [...divergent];
    stripped[2] = verifyStepWithoutArguments("build");
    expect(sequence(stripped, {})).toHaveLength(2);
  });

  it("says nothing of the arguments of a verify step covering no pushed image", () => {
    const violations = sequence([
      ...orderedSteps,
      verifyStepWithoutArguments("build").replace(
        "steps.build.outputs.digest",
        "steps.nothing.outputs.digest",
      ),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("cannot be read from this file");
  });
});

describe("the workflow the check reads the signer identity off", () => {
  it("finds the one workflow that signs", () => {
    const found = findSigningWorkflow([
      {
        path: "a.yaml",
        source: "jobs:\n  test:\n    steps:\n      - run: npm test\n",
      },
      {
        path: RELEASE_WORKFLOW,
        source: workflow({ steps: orderedSteps }),
      },
    ]);
    expect(found.path).toBe(RELEASE_WORKFLOW);
  });

  it("refuses a tree with no signer, or with more than one", () => {
    expect(findSigningWorkflow([]).problem).toContain("no workflow");
    const twice = workflow({ steps: orderedSteps });
    expect(
      findSigningWorkflow([
        { path: "a.yaml", source: twice },
        { path: "b.yaml", source: twice },
      ]).problem,
    ).toContain("2 workflows");
  });
});

describe("the check over a repository tree", () => {
  const trees = [];
  const tree = ({ workflowSource, docSource }) => {
    const root = mkdtempSync(join(tmpdir(), "psilink-release-signing-"));
    trees.push(root);
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, RELEASE_WORKFLOW), workflowSource);
    writeFileSync(join(root, RELEASES_DOC), docSource);
    return root;
  };

  afterAll(() => {
    for (const root of trees) rmSync(root, { recursive: true, force: true });
  });

  it("passes a tree whose document and workflow agree", () => {
    const report = releaseSigningReport(
      tree({
        workflowSource: workflow({ steps: orderedSteps }),
        docSource: doc(),
      }),
    );
    expect(report.violations).toEqual([]);
    expect(report.workflowPath).toBe(RELEASE_WORKFLOW);
    expect(report.identity).toBe(IDENTITY);
  });

  it("fails the committed workflow with one verify step's arguments stripped", () => {
    // The same mutation against the real files: every other rule stays quiet,
    // because the surviving copy of the pair is what they read.
    const stripped = releaseWorkflowSource.replace(
      CERTIFICATE_ARGUMENT_LINES,
      "",
    );
    expect(certificateFlags(stripped).identities).toHaveLength(
      certificateFlags(releaseWorkflowSource).identities.length - 1,
    );
    const report = releaseSigningReport(
      tree({ workflowSource: stripped, docSource: releasesDocSource }),
    );
    expect(report.violations).toHaveLength(2);
    expect(report.violations.join("\n")).toContain(
      "--certificate-identity-regexp",
    );
    expect(report.violations.join("\n")).toContain("--certificate-oidc-issuer");
  });

  it("reports both rule sets at once", () => {
    const report = releaseSigningReport(
      tree({
        workflowSource: workflow({
          tags: ["release-[0-9]+.[0-9]+.[0-9]+"],
          steps: [buildStep("build", true), signStep("build")],
        }),
        docSource: doc(),
      }),
    );
    // Both coupling failures -- the widened trigger, and a workflow that never
    // verifies what it signed -- plus the missing verify and attest steps: a run
    // reports everything that is wrong rather than the first thing.
    expect(report.violations).toHaveLength(4);
  });
});

describe("the check as CI runs it", () => {
  it("passes the committed repository", () => {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(stdout).toContain("Release signing check passed");
    expect(stdout).toContain(RELEASE_WORKFLOW);
  });
});
