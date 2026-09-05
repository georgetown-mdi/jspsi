import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The vendored @openmined/psi.js fork declares two runtime dependencies:
// google-protobuf, whose jspb runtime backs the psi_pb wire types and whose
// package the shipped type declarations import, and node-gyp-build, which
// psi_native_node.js requires to resolve a prebuild. Upstream additionally
// miscategorises a gRPC / protoc codegen set as runtime dependencies; the fork
// holds those as devDependencies, so they stay out of every psilink install.
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

// The Subresource-Integrity value npm records for a `file:` tarball is the
// sha512 of that file's own bytes, base64. Measured against real npm 11.19.0
// rather than read off its packing code: regenerating this repository's entry
// with `npm install --package-lock-only` in a throwaway tree reproduces the
// committed value exactly, and repeating that over a tarball with one byte
// changed moves it. A future npm that repacked a `file:` dependency before
// hashing would redden this check rather than pass it silently.
const tarballIntegrity = (path) =>
  `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;

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
    // The pinning assumption in DEPENDENCY_PINS.md: a file: path resolves to
    // exactly the committed bytes. The sha256 sidecar covers those bytes in the
    // tree; the install-time half is the recorded sha512 integrity, held
    // against the tarball by the assertion below rather than claimed here.
    expect(lock.packages[VENDORED]?.resolved).toMatch(
      /^file:lib\/openmined-psi\.js-.+\.tgz$/,
    );
  });

  it("records the integrity the committed tarball's bytes hash to", () => {
    const entry = lock.packages[VENDORED];
    expect(
      entry,
      `package-lock.json holds no entry for ${VENDORED}`,
    ).toBeDefined();
    const root = resolve(here, "..");
    const tarball = resolve(root, entry.resolved.slice("file:".length));
    const computed = tarballIntegrity(tarball);
    expect(
      computed,
      `${relative(root, tarball)} hashes to ${computed}, but package-lock.json ` +
        `records ${entry.integrity} for ${VENDORED}. npm installs a file: ` +
        `dependency out of its content-addressed cache by the recorded value, ` +
        `so a stale one reinstalls the bytes being replaced while the sha256 ` +
        `sidecar, the provenance marker, and the attestation all pass over the ` +
        `new ones. Recompute it: docs/PREBUILD_REVENDOR.md, step 5.`,
    ).toBe(entry.integrity);
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
