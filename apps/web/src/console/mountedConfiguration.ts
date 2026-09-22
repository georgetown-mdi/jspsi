import { authoringStateFromDocument } from "./loadedConfig";

import type { LoadedAuthoringState } from "./loadedConfig";
import type { MountedConfigurationAnswer } from "@psi/jobClient/mountedConfigClient";

/**
 * The console's offer to open the command-line configuration sitting in its
 * mounted working folder, as a value: what the control shows, what the operator
 * is told beside it, and the authoring state a successful load hands the
 * screen. No React and no I/O -- the fetch runs in the screen and reports its
 * answer here.
 *
 * Every notice names SETTINGS ONLY, as the file spells them. A setting's value
 * can be a credential, which is why the server names rather than sends the two
 * lists ({@link ../jobs/configLoad}), and nothing here reverses that.
 *
 * The three records whose absence turns an enforcement off have no control and
 * no composed key on the invitation-authoring path this offer sits in: they are
 * the acceptor's commitments, and the invitation authored here is this party's
 * own statement of its terms. A document stating one is refused by name rather
 * than opened with the record dropped, which would release the exchange from a
 * check one exchange later (docs/spec/EXCHANGE_FILE.md, "The records that must
 * survive").
 */

/** What the load control shows. */
export type MountedConfigurationState =
  /** Nothing read yet: the control offers the load. */
  | { status: "unread" }
  /** A read is in flight. */
  | { status: "reading" }
  /** The mount holds no configuration, so authoring starts from an empty form. */
  | { status: "absent" }
  /** The read did not answer, and the offer stands so the operator can retry. */
  | { status: "unavailable" }
  /** The configuration is open, and these are the notices beside it. */
  | { status: "opened"; carriedThrough: Array<string>; warnings: Array<string> }
  /** The console refused the file, in the words the read answered with. */
  | { status: "refused"; error: string };

/** The state the offer starts in, before any read. */
export const MOUNTED_CONFIGURATION_UNREAD: MountedConfigurationState = {
  status: "unread",
};

/** The control's label, naming the folder rather than a path: the browser is
 * never shown one inside the container. */
export const OPEN_CONFIGURATION_LABEL = "Open the configuration in my folder";

/** What the control says while nothing has been read. */
export const OPEN_CONFIGURATION_INVITATION =
  "If you already run this exchange with psilink on the command line, open " +
  "its psilink.yaml from the folder you mounted and every step below starts " +
  "from it.";

/** What the control says for a mount holding no configuration. Not a fault: a
 * console whose operator has authored nothing yet is the ordinary first run. */
export const NO_CONFIGURATION_IN_FOLDER =
  "There is no psilink.yaml in the folder you mounted, so this exchange is " +
  "authored here from the start.";

/** What the control says for a read that did not answer. */
export const CONFIGURATION_READ_UNAVAILABLE =
  "The console could not read the folder you mounted. Nothing below has " +
  "changed; try opening the configuration again.";

/** What the control says once a configuration is open. */
export const CONFIGURATION_OPENED =
  "Opened the configuration in your folder. Every step below starts from it, " +
  "and you can change anything before you run the exchange.";

/**
 * The records this flow neither composes nor holds, as the file spells them
 * beside the field the load reads them into. Each is the acceptor's own
 * commitment, so an invitation authored here has no control that would edit one
 * and no composed key that would put one back.
 */
const RECORDS_THIS_FLOW_CANNOT_STATE: ReadonlyArray<
  [keyof LoadedAuthoringState["records"], string]
> = [
  ["expectedPayloadColumns", "expected_payload_columns"],
  ["expectedPartnerDeduplicate", "expected_partner_deduplicate"],
  ["disclosedPayloadColumns", "disclosed_payload_columns"],
];

/** A list of setting names as a sentence fragment, in the file's own spelling. */
function nameList(fields: ReadonlyArray<string>): string {
  return fields.join(", ");
}

/**
 * The refusal for a document stating a record this flow cannot put back, or
 * undefined when it states none. A refusal rather than a carry-through: the
 * console writes a whole configuration for the run it starts, so a record it
 * held without stating would be a check this exchange is no longer held to.
 */
export function recordsThisFlowCannotState(
  loaded: LoadedAuthoringState,
): string | undefined {
  const stated = RECORDS_THIS_FLOW_CANNOT_STATE.filter(
    ([key]) => loaded.records[key] !== undefined,
  ).map(([, field]) => field);
  if (stated.length === 0) return undefined;
  return (
    "This configuration states " +
    (stated.length === 1 ? "a setting" : "settings") +
    " an invitation authored here cannot state back, and each one is a check " +
    "your partner is held to: " +
    nameList(stated) +
    ". Run this configuration with psilink on the command line instead."
  );
}

/**
 * What the operator is told about the settings the console holds without an
 * editor, or undefined when the document states none. The console writes each
 * back unchanged, and the command line is where they are edited.
 */
export function carriedThroughNotice(
  fields: ReadonlyArray<string>,
): string | undefined {
  if (fields.length === 0) return undefined;
  const one = fields.length === 1;
  return (
    "This configuration states " +
    (one ? "a setting" : "settings") +
    " the console has no control for, and keeps " +
    (one ? "it" : "each") +
    " unchanged: " +
    nameList(fields) +
    ". Edit " +
    (one ? "it" : "them") +
    " with psilink on the command line."
  );
}

/**
 * What the operator is told about the credential fields the load could not
 * pre-fill, or undefined when there are none. The credential's value never
 * leaves the server, so the connection step asks for it again -- the exchange
 * still runs, and this is the one thing the operator has to supply.
 */
export function credentialWarningNotice(
  fields: ReadonlyArray<string>,
): string | undefined {
  if (fields.length === 0) return undefined;
  const one = fields.length === 1;
  return (
    "The console cannot fill in " +
    (one ? "the credential" : "the credentials") +
    " this configuration states: " +
    nameList(fields) +
    ". Supply " +
    (one ? "it" : "each") +
    " again in the connection step, from the folder you mounted."
  );
}

/** The whole of what an opened configuration puts beside the control, in the
 * order it renders: the carry-through notice first, since it is about the run
 * itself, then the credential the operator has to supply. */
export function mountedConfigurationNotices(
  state: MountedConfigurationState,
): Array<string> {
  if (state.status !== "opened") return [];
  return [
    carriedThroughNotice(state.carriedThrough),
    credentialWarningNotice(state.warnings),
  ].filter((notice): notice is string => notice !== undefined);
}

/**
 * The state and, for a load that proceeds, the authoring state it hands the
 * screen. A refusal -- the route's own, or this flow's record refusal -- yields
 * no authoring state at all, so no step is partly filled from a document the
 * console would not run.
 */
export function mountedConfigurationRead(answer: MountedConfigurationAnswer): {
  state: MountedConfigurationState;
  loaded?: LoadedAuthoringState;
} {
  switch (answer.kind) {
    case "absent":
      return { state: { status: "absent" } };
    case "unavailable":
      return { state: { status: "unavailable" } };
    case "refused":
      return { state: { status: "refused", error: answer.error } };
    case "opened": {
      const loaded = authoringStateFromDocument(answer.document);
      const refusal = recordsThisFlowCannotState(loaded);
      if (refusal !== undefined)
        return { state: { status: "refused", error: refusal } };
      return {
        state: {
          status: "opened",
          carriedThrough: answer.carriedThrough,
          warnings: answer.warnings,
        },
        loaded,
      };
    }
  }
}
