// The CLI's sensitive-file parsing chokepoint. Its implementation now lives in
// @psilink/core (shared with the web app, which imports an operator's YAML/JSON
// linkage-terms document through the same redacting parsers); this thin
// re-export keeps the CLI's call sites and the ESLint routing rule unchanged --
// raw `yaml` parsers stay banned across apps/cli/src except this module, which
// no longer holds a raw parser at all, only the shared re-export. See the
// promoted implementation and its leak-channel rationale in
// packages/core/src/sensitiveFile.ts.
export {
  parseSensitiveYaml,
  editSensitiveYamlDocument,
  parseSensitiveJson,
} from "@psilink/core";
