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
 * The four records whose absence turns an enforcement off have no control on
 * the invitation-authoring path this offer sits in. A document stating one is
 * opened with its value held: the record rides the authoring state into the
 * intent the run submits, so the configuration composed for that run states it
 * exactly as the file did (docs/spec/EXCHANGE_FILE.md, "The records that must
 * survive"). Having no control, each one is named in the carry-through notice.
 */

/** The channel a configuration the console can open runs over. */
export type LoadedChannel = LoadedAuthoringState["channel"];

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
  /** The configuration is open, and these are the notices beside it.
   * `transportUnavailable` is the channel the file runs over where this console
   * cannot run it, so the transport stays where the review step had it;
   * `notApplied` names the settings the operator's own input file could not
   * supply and `notCovered` the settings whose own column set does not reach
   * every column that file has, both settled once the held terms reach it. */
  | {
      status: "opened";
      carriedThrough: Array<string>;
      warnings: Array<string>;
      transportUnavailable?: LoadedChannel;
      notApplied?: Array<string>;
      notCovered?: Array<string>;
    }
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

/** What the control says once an invitation is minted from terms the console
 * already holds: the load fills the steps below it, and those are sealed, so
 * the offer is withheld rather than shown as a read that would change nothing. */
export const CONFIGURATION_LOAD_SEALED =
  "This exchange's invitation is already created. Start a new exchange to " +
  "open a configuration.";

/** The label of the control that closes an open configuration. */
export const CLOSE_CONFIGURATION_LABEL = "Close this configuration";

/** What the control says once a configuration is open. */
export const CONFIGURATION_OPENED =
  "Opened the configuration in your folder. Every step below starts from it, " +
  "and you can change anything before you run the exchange.";

/**
 * The records this flow holds without an editor, as the file spells them beside
 * the field the load reads them into. An invitation authored here states none of
 * its own, so each rides the run unchanged and the command line is where a value
 * is edited.
 */
const RECORDS_WITH_NO_CONTROL: ReadonlyArray<
  [keyof LoadedAuthoringState["records"], string]
> = [
  ["expectedPayloadColumns", "expected_payload_columns"],
  ["expectedPartnerDeduplicate", "expected_partner_deduplicate"],
  ["disclosedPayloadColumns", "disclosed_payload_columns"],
  ["outboundPayloadConsent", "outbound_payload_consent"],
];

/** What the operator is told about a configuration whose channel this console
 * cannot run: the review step keeps the transport it already had, and the
 * shared-folder case names the mount that would make the file's own channel
 * runnable here. */
const TRANSPORT_UNAVAILABLE_NOTICE: Record<LoadedChannel, string> = {
  sftp:
    "This configuration runs over SFTP, which this console cannot run. " +
    "Choose how this exchange runs on the review step below.",
  filedrop:
    "This configuration runs over a shared directory, and this console has " +
    "no shared folder mounted. Mount one and set JOB_RENDEZVOUS_DIR to run " +
    "it here, or choose how this exchange runs on the review step below.",
};

/** A list of setting names as a sentence fragment, in the file's own spelling. */
function nameList(fields: ReadonlyArray<string>): string {
  return fields.join(", ");
}

/**
 * The records a loaded document states that this flow has no control for, named
 * as the file spells them, for the carry-through notice. Each is composed back
 * into the run's own configuration all the same.
 */
export function recordsWithNoControl(
  loaded: LoadedAuthoringState,
): Array<string> {
  return RECORDS_WITH_NO_CONTROL.filter(
    ([key]) => loaded.records[key] !== undefined,
  ).map(([, field]) => field);
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

/**
 * What the operator is told about the settings a loaded document states that
 * their own input file cannot supply, or undefined where there are none. The
 * settings are named as the file spells them and the columns they describe are
 * not, the rule every notice here holds to. The steps below the control hold
 * what the file's own columns support; the command line runs the configuration
 * as it stands.
 */
export function termsNotAppliedNotice(
  fields: ReadonlyArray<string>,
): string | undefined {
  if (fields.length === 0) return undefined;
  const one = fields.length === 1;
  return (
    "Your input file cannot supply everything this configuration states " +
    "under " +
    nameList(fields) +
    ", so the steps below hold what your own columns support. Run this " +
    "exchange with psilink on the command line to keep " +
    (one ? "that setting" : "those settings") +
    " as your file states " +
    (one ? "it" : "them") +
    "."
  );
}

/**
 * What the operator is told about the columns their input file has that a
 * loaded document's own column set does not state: the console holds each one
 * back, as the command line running that configuration would, and the columns
 * step is where the operator decides otherwise. The setting is named as the
 * file spells it and the columns are not, the rule every notice here holds to.
 */
export function columnsNotCoveredNotice(
  fields: ReadonlyArray<string>,
): string | undefined {
  if (fields.length === 0) return undefined;
  return (
    "Your input file has columns this configuration does not state under " +
    nameList(fields) +
    ", so the steps below keep those columns back instead of sending them " +
    "to your partner. Change how each one is used on the next step to send it."
  );
}

/**
 * What the operator is told when a commitment the file states about what this
 * party discloses can no longer match what the run would disclose: the columns
 * the document states are not the columns this input file gives, so the run is
 * refused when it starts. Shown while that divergence stands, so it is met here
 * rather than as a failed run.
 */
export function divergedCommitmentWarning(
  fields: ReadonlyArray<string>,
): string | undefined {
  if (fields.length === 0) return undefined;
  const one = fields.length === 1;
  return (
    "This configuration's " +
    nameList(fields) +
    (one ? " states" : " state") +
    " what this party discloses, and your input file cannot supply the " +
    "columns it names, so a run started here is refused. Change the columns " +
    "on the next step to match, or close this configuration."
  );
}

/** The commitments a loaded document can state about the columns this party
 * discloses. Each is enforced against the run's own disclosed set when the run
 * starts, so a document stating one over columns this file cannot supply is a
 * refusal already decided. */
const DISCLOSURE_COMMITMENTS: ReadonlyArray<string> = [
  "disclosed_payload_columns",
  "outbound_payload_consent",
];

/** The disclosure commitments an opened configuration states that its own
 * column set no longer reaches, named as the file spells them. Empty where the
 * file supplied every column the document names, which is where the run's
 * disclosed set can still match what the commitment holds. */
export function divergedCommitments(
  state: MountedConfigurationState,
): Array<string> {
  if (state.status !== "opened") return [];
  if (!(state.notApplied ?? []).includes("metadata")) return [];
  return DISCLOSURE_COMMITMENTS.filter((field) =>
    state.carriedThrough.includes(field),
  );
}

/**
 * Whether the control offers a read. A configuration is an input to every step
 * below it, so the offer stands only while nothing is open (or a read did not
 * answer) and the draft those steps hold is still editable: once an invitation
 * is minted the terms are sealed, and a load that filled the cards around them
 * would report a configuration the run's terms do not state.
 */
export function mountedConfigurationOfferable(
  state: MountedConfigurationState,
  sealed: boolean,
): boolean {
  if (sealed) return false;
  return state.status === "unread" || state.status === "unavailable";
}

/** The whole of what an opened configuration puts beside the control, in the
 * order it renders: what this console cannot run at all, then the carry-through
 * notice, since it is about the run itself, then the credential the operator
 * has to supply, and last what their input file could not supply. */
export function mountedConfigurationNotices(
  state: MountedConfigurationState,
): Array<string> {
  if (state.status !== "opened") return [];
  return [
    state.transportUnavailable === undefined
      ? undefined
      : TRANSPORT_UNAVAILABLE_NOTICE[state.transportUnavailable],
    carriedThroughNotice(state.carriedThrough),
    credentialWarningNotice(state.warnings),
    termsNotAppliedNotice(state.notApplied ?? []),
    columnsNotCoveredNotice(state.notCovered ?? []),
    divergedCommitmentWarning(divergedCommitments(state)),
  ].filter((notice): notice is string => notice !== undefined);
}

/** The opened state with the channel this console cannot run named on it, so
 * the notice stands beside the control that opened the configuration. Any other
 * state is returned unchanged: a load that does not proceed selects no
 * transport and so withholds none. */
export function withUnavailableTransport(
  state: MountedConfigurationState,
  channel: LoadedChannel,
): MountedConfigurationState {
  if (state.status !== "opened") return state;
  return { ...state, transportUnavailable: channel };
}

/** The opened state with the settings the operator's input file could not
 * supply, and those whose columns do not reach every column it has, named on it
 * as the file spells them beside the same control. Both are read off the file
 * the terms reached last, so a state that names none clears what an earlier one
 * named; a state that is not an opened configuration is left as it is. */
export function withTermsNotApplied(
  state: MountedConfigurationState,
  names: ReadonlyArray<string>,
  notCovered: ReadonlyArray<string> = [],
): MountedConfigurationState {
  if (state.status !== "opened") return state;
  return {
    ...state,
    notApplied: names.length === 0 ? undefined : [...names],
    notCovered: notCovered.length === 0 ? undefined : [...notCovered],
  };
}

/**
 * The state and, for a load that proceeds, the authoring state it hands the
 * screen. A refusal yields no authoring state at all, so no step is partly
 * filled from a document the console would not run.
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
      return {
        state: {
          status: "opened",
          carriedThrough: [
            ...new Set([
              ...answer.carriedThrough,
              ...recordsWithNoControl(loaded),
            ]),
          ].sort(),
          warnings: answer.warnings,
        },
        loaded,
      };
    }
  }
}
