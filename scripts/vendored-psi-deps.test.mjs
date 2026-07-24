import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The vendored @openmined/psi.js fork declares two runtime dependencies:
// google-protobuf, whose jspb runtime backs the psi_pb wire types and whose
// package the shipped type declarations import, and node-gyp-build, which
// psi_native_node.js requires to resolve a prebuild. Upstream additionally
// miscategorises a gRPC / protoc codegen set as runtime dependencies; the fork
// carries those as devDependencies, so they stay out of every psilink install.
// These assertions stand in for the "psilink loads no gRPC and no proto codegen
// at runtime" claim -- a re-roll that regresses the fork's manifest fails here
// rather than silently restoring the surface, which is what a comment or a doc
// note alone could not do. Rationale: docs/spec/DEPENDENCY_PINS.md.

const here = dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(
  readFileSync(resolve(here, "..", "package-lock.json"), "utf8"),
);

const VENDORED = "node_modules/@openmined/psi.js";

// Named individually rather than pattern-matched so that reintroducing any of
// them -- through the fork or through any other dependency -- is a decision a
// reviewer makes against a red check, not new supply-chain surface that arrives
// unnoticed.
const CODEGEN_AND_RPC = [
  "@grpc/grpc-js",
  "@grpc/proto-loader",
  "protobufjs",
  "protoc-gen-js",
  "protoc-gen-ts",
  "ts-protoc-gen",
];

// Read the name after the LAST "node_modules/" segment: npm nests a package
// whose version conflicts with another consumer's at
// node_modules/<parent>/node_modules/<name>, and this lockfile already installs
// the vendored package's own google-protobuf that way. Matching the first
// segment instead would read a nested entry's name as "<parent>/node_modules/
// <name>" and never match, so a nested reintroduction would pass unseen.
const NM = "node_modules/";
const installedNames = new Set(
  Object.keys(lock.packages)
    .filter((key) => key.includes(NM))
    .map((key) => key.slice(key.lastIndexOf(NM) + NM.length)),
);

describe("vendored @openmined/psi.js dependency surface", () => {
  it("resolves to the committed local tarball, not a registry package", () => {
    // The pinning premise in DEPENDENCY_PINS.md: a file: path resolves to
    // exactly the committed bytes, which is what makes the sha256 sidecar the
    // integrity check npm records no lockfile hash for.
    expect(lock.packages[VENDORED]?.resolved).toMatch(
      /^file:lib\/openmined-psi\.js-.+\.tgz$/,
    );
  });

  it("declares only the runtime dependencies its entry points load", () => {
    const declared = Object.keys(lock.packages[VENDORED]?.dependencies ?? {});
    expect(declared.sort()).toEqual(["google-protobuf", "node-gyp-build"]);
  });

  it("pulls no gRPC or proto-codegen package into the tree", () => {
    const present = CODEGEN_AND_RPC.filter((name) => installedNames.has(name));
    expect(present).toEqual([]);
  });
});
