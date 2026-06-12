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

const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
// GitHub rejects API requests without a User-Agent; identify these scripts.
const USER_AGENT = "psilink-board-scripts";

/**
 * Run gh with the given argv and return stdout as a string. Network calls go
 * through `graphql` (Node fetch) now, not gh -- gh (a Go binary) verifies TLS
 * via the macOS `trustd` Mach service, which the command sandbox blocks, so its
 * network subcommands fail in-sandbox. gh is kept only for `gh auth token`,
 * which is network-free (it just reads stored credentials) and so works in-sandbox.
 */
export function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * Resolve a GitHub token without a network round-trip, in precedence order:
 * `GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token` (which reads the stored
 * credential). Env-first matches gh's own precedence and is friendlier to CI /
 * headless. The token is returned for use only as a bearer header -- never log
 * it. Exported with injectable `env` / `readStoredToken` for tests; production
 * callers pass no argument.
 * @internal
 */
export function githubToken({
  env = process.env,
  readStoredToken = () => gh(["auth", "token"]),
} = {}) {
  // Trim before the truthiness test so a whitespace-only env var falls through
  // to the stored credential instead of yielding an empty bearer token.
  const fromEnv = (env.GH_TOKEN || env.GITHUB_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  let stored;
  try {
    stored = readStoredToken().trim();
  } catch {
    stored = "";
  }
  if (!stored) {
    throw new Error(
      "no GitHub token: set GH_TOKEN or GITHUB_TOKEN, or run `gh auth login`",
    );
  }
  return stored;
}

/**
 * POST a GraphQL query or mutation to the GitHub API over Node `fetch`, returning
 * the parsed `{ data, errors }` body. Using Node rather than `gh api graphql`
 * lets these scripts run inside the command sandbox: Node verifies TLS against
 * its own bundled CA store instead of the sandbox-blocked `trustd`. (The sandbox
 * also forces egress through an injected HTTPS proxy that Node's fetch ignores by
 * default; running with NODE_USE_ENV_PROXY=1 in the environment -- e.g. via
 * Claude Code's local settings -- makes fetch honor it.)
 *
 * A response is returned whenever it carries `data` -- even an HTTP 200 that also
 * has `errors`, which is how GraphQL reports a partial result (e.g. one NOT_FOUND
 * node in a batch). This preserves the "one bad ID does not sink the whole fetch"
 * behavior that `fetchItems` relies on. A response with no usable `data` (auth
 * failure, rate limit, malformed body) throws. `variables` is omitted from the
 * request body when not given.
 */
export async function graphql(query, variables) {
  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${githubToken()}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `GitHub GraphQL returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`,
    );
  }
  if (body.data == null) {
    const detail = body.errors
      ? JSON.stringify(body.errors)
      : text.slice(0, 300);
    throw new Error(`GitHub GraphQL error (HTTP ${res.status}): ${detail}`);
  }
  return body;
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
 * Inverse of pvtiNodeId: recover the numeric item ID from a PVTI_ global node
 * ID. Strips the "PVTI_" tag, base64url-decodes, and reads the trailing 4 bytes
 * as a big-endian uint32. The decoded byte prefix (everything before those 4
 * bytes) must match a known PROJECT_PREFIXES entry, which both validates the ID
 * shape and guards against a node ID from some other project sneaking through.
 * numericIdFromNodeId(pvtiNodeId(p, n)) === n holds for every known p.
 *
 * A node ID encodes its own project. When `expectedProject` is given (and is a
 * known project), the decoded project must equal it -- otherwise the numeric ID
 * would be re-encoded under a different project's prefix and silently address
 * the wrong item; reject the mismatch instead.
 */
export function numericIdFromNodeId(nodeId, expectedProject) {
  if (typeof nodeId !== "string" || !nodeId.startsWith("PVTI_")) {
    throw new Error(`not a PVTI_ node id: ${nodeId}`);
  }
  const buf = Buffer.from(nodeId.slice(5), "base64url");
  if (buf.length < 5) {
    throw new Error(`PVTI_ node id too short to decode: ${nodeId}`);
  }
  const prefixHex = buf.subarray(0, -4).toString("hex");
  const ownerProject = Object.keys(PROJECT_PREFIXES).find(
    (p) => PROJECT_PREFIXES[p] === prefixHex,
  );
  if (ownerProject === undefined) {
    throw new Error(
      `PVTI_ node id "${nodeId}" has prefix ${prefixHex}, not a known project; known: ${Object.values(PROJECT_PREFIXES).join(", ")}`,
    );
  }
  if (
    expectedProject !== undefined &&
    PROJECT_PREFIXES[expectedProject] !== undefined &&
    Number(ownerProject) !== Number(expectedProject)
  ) {
    throw new Error(
      `node id ${nodeId} is on project ${ownerProject}, not the requested project ${expectedProject}`,
    );
  }
  return buf.readUInt32BE(buf.length - 4);
}

/**
 * Resolve one item argument to its numeric ID. A `PVTI_...` value is decoded via
 * numericIdFromNodeId; anything else is parsed as a base-10 integer. Returns NaN
 * for an unparseable numeric argument so a caller's Number.isInteger check still
 * rejects it. A malformed PVTI_ id throws (a clearer signal than NaN). Shared so
 * fetch-issues.mjs, lint-issues.mjs, and edit-issue.mjs accept the two id forms
 * identically. Pass `expectedProject` (the project number the caller was given)
 * so a node ID from a different board is rejected rather than silently remapped.
 */
export function toNumericId(arg, expectedProject) {
  return arg.startsWith("PVTI_")
    ? numericIdFromNodeId(arg, expectedProject)
    : Number(arg);
}

/**
 * GraphQL selection for an item's project-field values. Covers the value types
 * the boards use -- text, number, and single-select -- each carrying its field
 * name via the ProjectV2FieldCommon interface. Shared so fetchItems (read by
 * numeric ID) and the all-items listing in list-epic.mjs extract fields the same
 * way. Other value types (date, iteration, ...) are simply not selected here and
 * fall out of the resulting map; extend this and extractFields together if a new
 * type needs surfacing.
 */
export const FIELD_VALUES_FRAGMENT =
  "fieldValues(first: 20) { nodes { __typename " +
  "... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } } " +
  "... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } } " +
  "... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } } } }";

/**
 * Turn a fieldValues node list (as selected by FIELD_VALUES_FRAGMENT) into a
 * plain { fieldName -> value } map. Text and single-select values map to their
 * string; number values map to their number. Nodes with no field name (or an
 * unselected value type, which has neither text/number/name) are skipped.
 */
export function extractFields(fieldValues) {
  const out = {};
  for (const node of fieldValues?.nodes ?? []) {
    const name = node?.field?.name;
    if (!name) continue;
    if (typeof node.text === "string") out[name] = node.text;
    else if (typeof node.number === "number") out[name] = node.number;
    else if (typeof node.name === "string") out[name] = node.name;
  }
  return out;
}

/**
 * Build the `ProjectV2FieldValue` input for updateProjectV2ItemFieldValue (the
 * write-side counterpart to extractFields), picking the typed key from the
 * field's `dataType`: a single-select resolves the option ID by name;
 * text/number/date map straight through (number as a JS number, since the
 * GraphQL field is a Float). `field` is { name, dataType, options? } as returned
 * by the project field introspection in edit-issue.mjs. Throws on an unknown
 * option, a non-numeric value for a NUMBER field, or an unsupported dataType.
 */
export function fieldValueInput(field, value) {
  switch (field.dataType) {
    case "SINGLE_SELECT": {
      const option = (field.options ?? []).find(
        (o) => o.name.toLowerCase() === value.toLowerCase(),
      );
      if (!option) {
        const names = (field.options ?? []).map((o) => o.name).join(", ");
        throw new Error(
          `option "${value}" not valid for "${field.name}"; choices: ${names}`,
        );
      }
      return { singleSelectOptionId: option.id };
    }
    case "TEXT":
      return { text: value };
    case "NUMBER": {
      const number = Number(value);
      if (!Number.isFinite(number)) {
        throw new Error(
          `field "${field.name}" is a number field but value "${value}" is not numeric`,
        );
      }
      return { number };
    }
    case "DATE":
      return { date: value };
    default:
      throw new Error(
        `field "${field.name}" has unsupported type ${field.dataType}; extend the field-value handling to support it`,
      );
  }
}

/**
 * Fetch the given numeric item IDs from one project in a single GraphQL call.
 * Returns one entry per requested ID, in order, as
 * { id, type, title, body, url, fields }, where fields is the { name -> value }
 * map of populated project-field values (see extractFields). Unresolved IDs come
 * back with type "missing", null content fields, and an empty fields map. Shared
 * by fetch-issues.mjs (read) and lint-issues.mjs (cross-reference resolution) so
 * the aliased multi-fetch has one implementation. The id/type/title/body/url
 * properties are stable; fields was added later and is purely additive.
 */
export async function fetchItems(projectNumber, numericIds) {
  const fields =
    "... on ProjectV2Item { databaseId " +
    FIELD_VALUES_FRAGMENT +
    " content { __typename " +
    "... on DraftIssue { title body } " +
    "... on Issue { title body number url } } }";
  const aliases = numericIds
    .map(
      (id, i) =>
        `i${i}: node(id: "${pvtiNodeId(projectNumber, id)}") { ${fields} }`,
    )
    .join("\n");
  const query = `{ ${aliases} }`;

  // GraphQL returns HTTP 200 with both `data` (the found nodes) and `errors`
  // (NOT_FOUND for the missing ones), so one bad ID in a batch does not sink the
  // whole fetch -- the missing aliases simply come back as null nodes below.
  const data = (await graphql(query)).data;

  return numericIds.map((id, i) => {
    const node = data[`i${i}`];
    if (!node || !node.content) {
      return {
        id,
        type: "missing",
        title: null,
        body: null,
        url: null,
        fields: {},
      };
    }
    const c = node.content;
    return {
      id,
      type: c.__typename,
      title: c.title ?? null,
      body: c.body ?? null,
      url: c.url ?? null,
      fields: extractFields(node.fieldValues),
    };
  });
}

// GitHub's projectV2 items connection caps `first` at 100, so this is also the
// per-page size: fetchAllItems pages through the connection 100 at a time rather
// than relying on a single page covering the whole board.
export const PAGE_SIZE = 100;

/**
 * Default GraphQL runner for fetchAllItems: run the query via fetch and return
 * its `data`. Split out as the injection point so tests can drive fetchAllItems
 * with synthetic pages instead of a live board.
 */
async function runQueryViaFetch(query) {
  return (await graphql(query)).data;
}

/**
 * Fetch every item of a project with its field values and node IDs, returning
 * [{ id, nodeId, title, fields }] where id is the numeric item ID, nodeId is the
 * `PVTI_` global node ID, and fields is the { name -> value } map (see
 * extractFields, which surfaces Status / Epic / Implementation Order among
 * others). Pages through the items connection with a cursor until hasNextPage is
 * false, so no item is dropped however large the board grows -- the silent
 * truncation a single `gh project item-list --limit N` would cause is impossible
 * here. Shared by list-epic.mjs (filter to one Epic) and list-issues.mjs (whole
 * board). `runQuery(query) -> data` is injectable for tests; it defaults to fetch.
 */
export async function fetchAllItems(
  projectNumber,
  { runQuery = runQueryViaFetch } = {},
) {
  const nodes = [];
  let cursor = null;
  do {
    // Inline the cursor into the query the same way the other args are inlined;
    // GitHub's endCursor is an opaque base64 token with no quote/backslash chars
    // to escape. Omit `after` entirely on the first page.
    const after = cursor === null ? "" : `, after: "${cursor}"`;
    const query = `{ organization(login: "${OWNER}") { projectV2(number: ${projectNumber}) { items(first: ${PAGE_SIZE}${after}) { pageInfo { hasNextPage endCursor } nodes { id ${FIELD_VALUES_FRAGMENT} content { __typename ... on DraftIssue { title } ... on Issue { title } } } } } } }`;
    const data = await runQuery(query);
    const project = data?.organization?.projectV2;
    if (!project) {
      throw new Error(
        `project ${projectNumber} not found under owner ${OWNER}`,
      );
    }
    const conn = project.items;
    nodes.push(...conn.nodes);
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor !== null);
  return nodes.map((node) => ({
    id: numericIdFromNodeId(node.id),
    nodeId: node.id,
    title: node.content?.title ?? null,
    fields: extractFields(node.fieldValues),
  }));
}
