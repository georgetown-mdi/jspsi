// The `./untrusted-text` entry point of @psilink/core: the chokepoints for text
// a party did not write -- parsing it as JSON under structural bounds, and
// escaping it before an operator reads it.
//
// It exists so a consumer needing only these can take them without the whole
// library behind the main entry point. The standalone signaling broker is that
// consumer: it is a network-facing process whose runtime closure is the set of
// packages an advisory can force a redeploy over, and every name below resolves
// without zod, papaparse, yaml, luxon, uuid, re2js or the PSI bindings
// (scripts/broker-core-reach.test.mjs measures that closure and holds this
// entry to it).
//
// A name belongs here when it is one of those two chokepoints and a consumer
// outside packages/core calls it without the rest of the library. Everything
// else stays on the main entry point (src/main.ts), which re-exports each name
// below so a consumer already taking the whole library reaches one copy of it.

export { displayText, sanitizeForDisplay } from "./utils/sanitizeForDisplay";
export type { Displayable } from "./utils/sanitizeForDisplay";
export { redactAndSanitizeForDisplay } from "./utils/sanitizeErrorForDisplay";
// The untrusted-JSON chokepoint and the refusal it throws, which travel
// together: a caller that parses a partner's frame is the caller that has to
// tell a structural refusal from any other parse failure.
export { parseBoundedJson, JsonStructureBoundError } from "./utils/boundedJson";
