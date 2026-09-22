import { isJobChannel } from "@jobs/intentSchemas";

import { authoringStateFromDocument } from "./loadedConfig";

import type {
  LoadedAuthoringState,
  LoadedEnforcementRecords,
} from "./loadedConfig";
import type { JobChannel } from "@jobs/intentSchemas";
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
 *
 * A configuration on a channel the console does not conduct opens all the same:
 * the steps below start from it for review, and the run is withheld by the one
 * derived field {@link runWithheldReason} reads, which names the channel.
 */

/** The channel a configuration the console can open runs over. */
export type LoadedChannel = LoadedAuthoringState["channel"];

/** A channel the console opens a configuration on but does not conduct. */
type UnconductedChannel = Exclude<LoadedChannel, JobChannel>;

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
   * every column that file has, both settled once the held terms reach it;
   * `pendingOutboundConsent` is the consent record the file states as pending,
   * which no run that shares results with the partner gets past.
   * `notConducted` is the file's channel where the console conducts no
   * exchange over it at all, derived once at the read: it withholds the run
   * and replaces every notice about the run with the one naming the channel. */
  | {
      status: "opened";
      carriedThrough: Array<string>;
      warnings: Array<string>;
      notConducted?: UnconductedChannel;
      transportUnavailable?: JobChannel;
      notApplied?: Array<string>;
      notCovered?: Array<string>;
      pendingOutboundConsent?: boolean;
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

/** What the control says once a configuration the console cannot run is open. */
export const CONFIGURATION_OPENED_FOR_REVIEW =
  "Opened the configuration in your folder. Every step below starts from it " +
  "for you to review.";

/** The line under the open control for an opened state. */
export function configurationOpenedMessage(
  state: MountedConfigurationState,
): string {
  return state.status === "opened" && state.notConducted !== undefined
    ? CONFIGURATION_OPENED_FOR_REVIEW
    : CONFIGURATION_OPENED;
}

/** What the operator is told beside the load about a configuration on a channel
 * the console does not conduct, naming the channel as the file spells it. */
export function channelNotConductedNotice(channel: UnconductedChannel): string {
  return (
    `This configuration runs over ${channel}, and the console conducts sftp ` +
    "and filedrop exchanges only. The steps below show its settings, but the " +
    "console cannot run this exchange or save changes to it. Run it with " +
    "psilink on the command line, or close this configuration to author an " +
    "exchange the console runs."
  );
}

/**
 * Why the review step withholds its run control, or undefined where nothing
 * open withholds it: a configuration on a channel the console does not
 * conduct. Read off the state the load derived once, so no run starts and then
 * fails on the channel.
 */
export function runWithheldReason(
  state: MountedConfigurationState,
): string | undefined {
  if (state.status !== "opened" || state.notConducted === undefined)
    return undefined;
  return (
    `The console cannot run this ${state.notConducted} configuration: it ` +
    "conducts sftp and filedrop exchanges only. Run it with psilink on the " +
    "command line, or close the configuration to author an exchange here."
  );
}

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
 * has nothing to run it over: the review step keeps the transport it already
 * had, and each case names what would make the file's own channel runnable
 * here -- a mounted shared folder, or an authored SFTP connection. */
const TRANSPORT_UNAVAILABLE_NOTICE: Record<JobChannel, string> = {
  sftp:
    "This configuration runs over SFTP, and this console has no SFTP " +
    "connection to run it with. Author one in the connection step below, or " +
    "choose how this exchange runs on the review step.",
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

/** The records above as the file spells them, which a run here states from the
 * authoring state: every other held setting sits outside the blocks a run here
 * composes, so the export keeps it and the run does not apply it. */
const RECORD_FIELDS_THE_RUN_STATES: ReadonlySet<string> = new Set(
  RECORDS_WITH_NO_CONTROL.map(([, field]) => field),
);

/**
 * What the operator is told about the settings the console holds without an
 * editor, or undefined when the document states none. The console writes each
 * back unchanged, and the command line is where they are edited. A held setting
 * the run itself does not apply is named again with that said, so the notice
 * promises nothing about the run keeping it in force.
 */
export function carriedThroughNotice(
  fields: ReadonlyArray<string>,
): string | undefined {
  if (fields.length === 0) return undefined;
  const one = fields.length === 1;
  const notApplied = fields.filter(
    (field) => !RECORD_FIELDS_THE_RUN_STATES.has(field),
  );
  const notAppliedOne = notApplied.length === 1;
  const notAppliedNames =
    notApplied.length === fields.length
      ? notAppliedOne
        ? "it"
        : "them"
      : nameList(notApplied);
  return (
    "This configuration states " +
    (one ? "a setting" : "settings") +
    " the console has no control for, and keeps " +
    (one ? "it" : "each") +
    " unchanged: " +
    nameList(fields) +
    "." +
    (notApplied.length === 0
      ? ""
      : " The run started here does not apply " +
        notAppliedNames +
        "; the configuration the console hands back states " +
        (notAppliedOne ? "it" : "them") +
        " as your file does.") +
    " Edit " +
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
 * What the operator is told about a consent record the loaded configuration
 * states as pending: core refuses every run that shares results with the
 * partner until the record names a confirmed set, and the command line is
 * where that confirmation is given. Names the setting only, as the notices
 * beside it do.
 */
export const PENDING_OUTBOUND_CONSENT_WARNING =
  "This configuration's outbound_payload_consent is pending, so a run that " +
  "shares results with your partner is refused until it is confirmed with " +
  "psilink on the command line.";

/**
 * What the operator is told when the columns this run would send to the partner
 * are not the columns a commitment the file states holds: core enforces the
 * commitment against the run's own disclosed set when the run starts, so the
 * refusal is already decided and is met here rather than as a failed run.
 */
export function divergedCommitmentWarning(
  fields: ReadonlyArray<string>,
): string | undefined {
  if (fields.length === 0) return undefined;
  const one = fields.length === 1;
  return (
    "The columns this exchange would send to your partner are not the " +
    "columns this configuration's " +
    nameList(fields) +
    (one ? " states" : " state") +
    ", so a run started here is refused. Change the columns on the next step " +
    "to match " +
    (one ? "it" : "them") +
    ", or close this configuration."
  );
}

/** What the run the console holds would disclose, and the commitments it keeps
 * from the file it was opened from: the pair {@link divergedCommitments}
 * compares. Absent until an input file is read, where no disclosed set is
 * settled yet. */
export interface RunDisclosure {
  /** The columns the draft this screen holds sends to the partner,
   * `disclosedColumnNames` over its own metadata -- the set core compares the
   * commitment against. */
  disclosedColumns: ReadonlyArray<string>;
  /** Whether the partner is entitled to the matched results, the draft's own
   * `output.shareWithPartner`. Core's consent gate
   * (`assessOutboundPayloadConsent`) reports not-required where it is false,
   * since the run sends nothing at all. */
  sharesWithPartner: boolean;
  records: LoadedEnforcementRecords;
}

/** The commitments a loaded document can state about the columns this party
 * discloses, named as the file spells them, each beside the column set it holds
 * for the run in hand. A `pending` consent record confirms no set, so it has
 * none to compare, and a run the partner takes no results from is past core's
 * consent gate whatever the record states. The commitment on
 * `disclosed_payload_columns` has no such gate: core holds it in either
 * direction. */
const DISCLOSURE_COMMITMENTS: ReadonlyArray<{
  field: string;
  columnsOf: (run: RunDisclosure) => ReadonlyArray<string> | undefined;
}> = [
  {
    field: "disclosed_payload_columns",
    columnsOf: (run) => run.records.disclosedPayloadColumns,
  },
  {
    field: "outbound_payload_consent",
    columnsOf: (run) =>
      run.sharesWithPartner &&
      run.records.outboundPayloadConsent?.status === "confirmed"
        ? run.records.outboundPayloadConsent.columns
        : undefined,
  },
];

/** Whether a commitment holds exactly the columns the run discloses, the
 * membership comparison core's own enforcement makes
 * (`assertDisclosureMatchesCommitment`, `assertOutboundPayloadConsented`):
 * neither a column dropped from the set nor one added to it matches. */
function sameColumnSet(
  committed: ReadonlyArray<string>,
  disclosed: ReadonlySet<string>,
): boolean {
  const committedSet = new Set(committed);
  return (
    committedSet.size === disclosed.size &&
    [...committedSet].every((name) => disclosed.has(name))
  );
}

/** The disclosure commitments an opened configuration states that the run's own
 * disclosed set no longer matches, named as the file spells them. Empty where
 * every commitment holds exactly what the run would send, which is what core
 * lets through. */
export function divergedCommitments(
  state: MountedConfigurationState,
  run: RunDisclosure | undefined,
): Array<string> {
  if (
    state.status !== "opened" ||
    state.notConducted !== undefined ||
    run === undefined
  )
    return [];
  const disclosed = new Set(run.disclosedColumns);
  return DISCLOSURE_COMMITMENTS.filter((commitment) => {
    const columns = commitment.columnsOf(run);
    return columns !== undefined && !sameColumnSet(columns, disclosed);
  }).map((commitment) => commitment.field);
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
 * has to supply, then what their input file could not supply, then a consent
 * record the file states as pending, and last a commitment the run's own
 * disclosed set no longer matches. `run` is what that last one is read from,
 * absent until a file is read. A configuration the console does not conduct
 * puts the notice naming its channel in place of every one about a run here,
 * and keeps the two about what the steps below hold. */
export function mountedConfigurationNotices(
  state: MountedConfigurationState,
  run?: RunDisclosure,
): Array<string> {
  if (state.status !== "opened") return [];
  if (state.notConducted !== undefined)
    return [
      channelNotConductedNotice(state.notConducted),
      termsNotAppliedNotice(state.notApplied ?? []),
      columnsNotCoveredNotice(state.notCovered ?? []),
    ].filter((notice): notice is string => notice !== undefined);
  return [
    state.transportUnavailable === undefined
      ? undefined
      : TRANSPORT_UNAVAILABLE_NOTICE[state.transportUnavailable],
    carriedThroughNotice(state.carriedThrough),
    credentialWarningNotice(state.warnings),
    termsNotAppliedNotice(state.notApplied ?? []),
    columnsNotCoveredNotice(state.notCovered ?? []),
    state.pendingOutboundConsent === true
      ? PENDING_OUTBOUND_CONSENT_WARNING
      : undefined,
    divergedCommitmentWarning(divergedCommitments(state, run)),
  ].filter((notice): notice is string => notice !== undefined);
}

/** The opened state with the channel this console cannot run named on it, so
 * the notice stands beside the control that opened the configuration. Any other
 * state is returned unchanged: a load that does not proceed selects no
 * transport and so withholds none. */
export function withUnavailableTransport(
  state: MountedConfigurationState,
  channel: JobChannel,
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
          ...(isJobChannel(loaded.channel)
            ? {}
            : { notConducted: loaded.channel }),
          ...(loaded.records.outboundPayloadConsent?.status === "pending"
            ? { pendingOutboundConsent: true }
            : {}),
        },
        loaded,
      };
    }
  }
}
