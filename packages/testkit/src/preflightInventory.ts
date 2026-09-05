// The labelled checks the CLI runs before an exchange starts, each against what
// the console does about the same concern.
//
// The console is a GUI over the same CLI, so every one of these checks still runs
// -- in the child process, once the exchange has been launched. What the console
// owes the operator is the ones that belong at the controls, while there is still
// something to change: a refusal the CLI raises after launch reaches a console
// operator as a failed run. Nothing about the two living in one repository makes
// them agree, so each check is a row here with its console DISPOSITION, and both
// apps' unit projects drive this one set: the CLI leg binds every row to the code
// that enforces it there, and the console leg binds every `authored` row to the
// control that states it here. A row neither leg can bind fails, and a check
// added to one of the CLI's preflight modules without a row fails the CLI leg
// before the console leg is ever asked about it.
//
// The set lives here rather than in either test tree because both apps need it and
// neither may import the other, and it holds only the row declarations: an anchor
// is an app's own symbol, and `packages/` cannot import `apps/`.
//
// Stated limits, since a safety check is not a guarantee: the CLI leg's closure test
// enumerates the modules whose whole purpose is preflight plus the `warn`-prefixed
// exports of the CLI's option surface. A check written inline in a command module,
// rather than as an export of one of those, is outside what it can see -- three
// rows below are already of that shape, anchored by behaviour instead. The console
// leg binds each `authored` row to a symbol and verifies the symbol exists; only
// the three credential and retain rows are additionally driven through behaviour,
// so a row's `how` prose describes the bound surface without the binding proving
// it -- read a row as "this symbol holds the concern", not as a verified
// transcript of what it does.

/** One row of the inventory. Adding a member here fails BOTH legs to compile
 * until the check is anchored on the CLI side and dispositioned on the console
 * side. */
export type PreflightId =
  | "linkageSatisfiability"
  | "unacceptedPayloadColumns"
  | "valueConstraints"
  | "passphraseRequiresPrivateKey"
  | "keyboardInteractiveRequiresPassword"
  | "lowPollingFrequency"
  | "connectionPerPollShortInterval"
  | "unsupportedChannelFlags"
  | "ignoredOfflineOverrides"
  | "keyFilePath"
  | "hostKeyTrust"
  | "identityDivergence"
  | "outboundPayloadConsent"
  | "splitDirectoryRequiresRetain"
  | "jobAdmission";

/** What the CLI's check does when it fires: refuse the run, warn and continue, or
 * put a question to the operator. */
export type PreflightWeight = "refuses" | "warns" | "asks";

/**
 * Where the console meets the same concern:
 * - `authored`: the console states it at the control, before the run is launched.
 * - `runWarning`: the console has no authoring-time surface; what reaches the
 *   operator is the CLI child's own warning, folded into the run's warnings.
 * - `unreachable`: the console cannot compose the state the check guards against.
 * - `pending`: a known gap, not built by design.
 */
export type ConsoleDisposition =
  | { readonly kind: "authored"; readonly how: string }
  | { readonly kind: "runWarning"; readonly how: string }
  | { readonly kind: "unreachable"; readonly because: string }
  | { readonly kind: "pending"; readonly because: string };

/** One check: how the CLI names the concern, what its check does, and the
 * console's disposition of it. */
export interface PreflightRow {
  readonly concern: string;
  readonly weight: PreflightWeight;
  readonly console: ConsoleDisposition;
}

/** Every labelled CLI pre-launch check, with the console's disposition of it. */
export const PREFLIGHT_INVENTORY: Record<PreflightId, PreflightRow> = {
  linkageSatisfiability: {
    concern:
      "the agreed linkage keys cannot be satisfied by the columns this input " +
      "carries, so the run would match nothing",
    weight: "refuses",
    console: {
      kind: "authored",
      how:
        "every pre-launch seat grades core's own verdict through one module " +
        "and refuses the launch with the key that cannot be built",
    },
  },
  unacceptedPayloadColumns: {
    concern:
      "the input discloses payload columns the accepted invitation declares " +
      "the partner will not accept",
    weight: "warns",
    console: {
      kind: "authored",
      how:
        "the acceptor's columns step names the conflict against the " +
        "invitation's own declaration; the console blocks the launch where " +
        "the CLI warns and proceeds",
    },
  },
  valueConstraints: {
    concern:
      "cleaned values of a linkage field trip a value constraint (warn, never " +
      "enforce -- the exchange still proceeds)",
    weight: "warns",
    console: {
      kind: "authored",
      how:
        "the standardization preview badges each flagged value against core's " +
        "own constraint check, on the sample the operator is looking at",
    },
  },
  passphraseRequiresPrivateKey: {
    concern:
      "a private-key passphrase is set with no private key to decrypt, so it " +
      "has no effect",
    weight: "refuses",
    console: {
      kind: "authored",
      how:
        "the connection form re-parses its own fields through core's " +
        "connection schema and refuses the save on the passphrase control",
    },
  },
  keyboardInteractiveRequiresPassword: {
    concern:
      "keyboard-interactive is armed with no password to answer the server's " +
      "prompts with, so it has no effect",
    weight: "refuses",
    console: {
      kind: "authored",
      how:
        "the connection form re-parses its own fields through core's " +
        "connection schema and refuses the save on the toggle itself",
    },
  },
  lowPollingFrequency: {
    concern:
      "a sub-second poll interval may trip an SFTP server's anti-flood " +
      "protection and drop the connection",
    weight: "warns",
    console: {
      kind: "authored",
      how:
        "the connection tuning card carries the advisory beside the interval " +
        "field, against core's own threshold constant",
    },
  },
  connectionPerPollShortInterval: {
    concern:
      "connection-per-poll on a short interval pays a full SSH handshake every " +
      "cycle, which the mode does not exist for",
    weight: "warns",
    console: {
      kind: "authored",
      how:
        "the connection tuning card carries the advisory beside the toggle, " +
        "against core's own threshold constant",
    },
  },
  unsupportedChannelFlags: {
    concern:
      "a flag was set that the chosen channel does not use, so the run ignores " +
      "it",
    weight: "warns",
    console: {
      kind: "authored",
      how:
        "the tuning card withholds the control the channel has no use for, so " +
        "the state is not authorable; the job intent's strict per-channel " +
        "schema refuses one that arrives anyway",
    },
  },
  ignoredOfflineOverrides: {
    concern:
      "a connection or options override was given to an offline invite or " +
      "accept, which composes no connection to apply it to",
    weight: "warns",
    console: {
      kind: "unreachable",
      because:
        "the console composes the configuration itself from the controls it " +
        "showed; there is no command line whose overrides a run could ignore",
    },
  },
  keyFilePath: {
    concern:
      "the key file's path names a directory, a special node, or a parent that " +
      "cannot be created or written",
    weight: "refuses",
    console: {
      kind: "unreachable",
      because:
        "the appliance owns the key file's path -- a fixed name inside the " +
        "job's own working directory -- so no operator-supplied path reaches " +
        "it, and the input listing excludes a dotfile by construction",
    },
  },
  hostKeyTrust: {
    concern:
      "no host-key fingerprint is pinned, so the server's identity cannot be " +
      "confirmed",
    weight: "asks",
    console: {
      kind: "authored",
      how:
        "the connection form requires a literal pin and never offers trust on " +
        "first use; its probe reads the key for comparison and names what " +
        "answered the port when it was not an SSH server",
    },
  },
  identityDivergence: {
    concern:
      "the signing identity is bound to a party name that differs from the " +
      "one the agreed linkage terms carry",
    weight: "refuses",
    console: {
      kind: "pending",
      because:
        "the appliance keeps ONE long-lived signing identity, whose party name " +
        "is bound when it is created and left alone afterwards, so a later " +
        "exchange under a different name diverges -- and the CLI child refuses " +
        "such a run rather than warning through it, which reaches a console " +
        "operator only as a launch that failed. An authoring-time surface for " +
        "it is a known gap",
    },
  },
  outboundPayloadConsent: {
    concern:
      "what this exchange will send has not been confirmed by the operator " +
      "running it",
    weight: "asks",
    console: {
      kind: "authored",
      how:
        "the operator authors the disclosed columns themselves and the step " +
        "lists them, so there is no inferred set to put back to them; the " +
        "consent record is core's derivation of that same authored metadata",
    },
  },
  splitDirectoryRequiresRetain: {
    concern:
      "a separate outbound directory was named without retain mode, which the " +
      "split layout requires",
    weight: "refuses",
    console: {
      kind: "authored",
      how:
        "the connection form refuses the save at the point the second " +
        "directory is named, and points at the retain control by its label",
    },
  },
  jobAdmission: {
    concern:
      "core's run-boundary gate refuses the exchange for a reason no earlier " +
      "check restated",
    weight: "refuses",
    console: {
      kind: "pending",
      because:
        "the console has no advance surface for that gate's verdict, and the " +
        "seam for one is deliberately not built: it would have to run core's " +
        "boundary against a composed run before there is a run to compose",
    },
  },
};

/** Every row id, in declaration order. */
export function preflightIds(): Array<PreflightId> {
  return Object.keys(PREFLIGHT_INVENTORY) as Array<PreflightId>;
}

/** The rows the console states at a control, which the console leg must bind to a
 * real symbol. */
export function authoredPreflightIds(): Array<PreflightId> {
  return preflightIds().filter(
    (id) => PREFLIGHT_INVENTORY[id].console.kind === "authored",
  );
}

/** The prose a row's disposition holds, whichever kind it is: what the console
 * does, or why it does nothing. Empty prose is what the contract test refuses. */
export function dispositionReason(id: PreflightId): string {
  const disposition = PREFLIGHT_INVENTORY[id].console;
  return disposition.kind === "authored" || disposition.kind === "runWarning"
    ? disposition.how
    : disposition.because;
}
