//
// Shared primitives for addressing GitHub Projects v2 items by their numeric ID
// (the `?itemId=N` value from the project web UI URL). Used by fetch-issues.mjs
// (read) and edit-issue.mjs (write) so the PVTI node-ID derivation has exactly
// one implementation.
//
// A numeric item ID is the big-endian uint32 in the last 4 bytes of the item's
// `PVTI_` global node ID, preceded by a fixed per-project byte prefix.

import { execFileSync } from "node:child_process";

/**
 * Per-project PVTI byte prefix (hex), keyed by project number. To add a project,
 * fetch any one of its items' node IDs and decode:
 * `Buffer.from(id.slice(5), "base64url").subarray(0, -4).toString("hex")`.
 */
export const PROJECT_PREFIXES = {
  9: "9400ce0309ab47ce0163ce16ce", // georgetown-mdi product backlog
  10: "9400ce0309ab47ce0163d09ace", // georgetown-mdi release & operations
};

/** Owner login for both psilink project boards. */
export const OWNER = "georgetown-mdi";

/** Run gh with the given argv and return stdout as a string. */
export function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** Derive an item's PVTI_ global node ID from its project number and numeric ID. */
export function pvtiNodeId(projectNumber, numericId) {
  const prefixHex = PROJECT_PREFIXES[projectNumber];
  if (!prefixHex) {
    throw new Error(
      `No PVTI prefix known for project ${projectNumber}; known: ${Object.keys(PROJECT_PREFIXES).join(", ")}`,
    );
  }
  const idBuf = Buffer.alloc(4);
  idBuf.writeUInt32BE(numericId);
  return (
    "PVTI_" +
    Buffer.concat([Buffer.from(prefixHex, "hex"), idBuf]).toString("base64url")
  );
}

/**
 * Fetch the given numeric item IDs from one project in a single GraphQL call.
 * Returns one entry per requested ID, in order, as
 * { id, type, title, body, url }. Unresolved IDs come back with type "missing"
 * and null fields. Shared by fetch-issues.mjs (read) and lint-issues.mjs
 * (cross-reference resolution) so the aliased multi-fetch has one implementation.
 */
export function fetchItems(projectNumber, numericIds) {
  const fields =
    "... on ProjectV2Item { databaseId content { __typename " +
    "... on DraftIssue { title body } " +
    "... on Issue { title body number url } } }";
  const aliases = numericIds
    .map(
      (id, i) =>
        `i${i}: node(id: "${pvtiNodeId(projectNumber, id)}") { ${fields} }`,
    )
    .join("\n");
  const query = `{ ${aliases} }`;

  // gh exits non-zero if any aliased node is NOT_FOUND, but still prints the
  // JSON body (data for the found nodes, errors for the missing ones). Recover
  // it so one bad ID in a batch does not sink the whole fetch.
  let raw;
  try {
    raw = gh(["api", "graphql", "-f", `query=${query}`]);
  } catch (e) {
    if (!e.stdout) throw e;
    raw = e.stdout;
  }
  const data = JSON.parse(raw).data;

  return numericIds.map((id, i) => {
    const node = data[`i${i}`];
    if (!node || !node.content) {
      return { id, type: "missing", title: null, body: null, url: null };
    }
    const c = node.content;
    return {
      id,
      type: c.__typename,
      title: c.title ?? null,
      body: c.body ?? null,
      url: c.url ?? null,
    };
  });
}
