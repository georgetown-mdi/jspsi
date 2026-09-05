// The CLI's sensitive-file parsing chokepoint: a thin re-export of the
// shared implementation in @psilink/core (also used by the web app to parse
// an operator's YAML/JSON linkage-terms document). The ESLint routing rule
// targets this module; raw `yaml` parsers are banned across apps/cli/src
// except here, which holds no parser of its own. Implementation and
// leak-channel rationale: packages/core/src/sensitiveFile.ts.
export {
  parseSensitiveYaml,
  editSensitiveYamlDocument,
  parseSensitiveJson,
} from "@psilink/core";
