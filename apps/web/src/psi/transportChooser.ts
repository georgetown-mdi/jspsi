/**
 * The transport an exchange runs over and the copy the Review & create chooser
 * shows for it: which transports this build offers, how each would run, and the
 * label, description and capability note beside each choice. No React.
 */

import { selectExchangeDriver } from "./exchangeDriverSelection";

import type { DeploymentProfile } from "@utils/clientConfig";

import type { ExchangeDriverSelection } from "./exchangeDriverSelection";

/**
 * The transport an exchange runs over, chosen at Review & create. `browser`
 * runs the live WebRTC exchange in this tab; `sftp` and `filedrop` are the two
 * command-line transports whose Create routes to the save-exchange-file surface
 * instead of listening for a partner. The value is editor state so it survives
 * a trip into a Customize tab and reflects into the ledger's How-it-runs row
 * and the review answers.
 */
export type Transport = "browser" | "sftp" | "filedrop";

/** The ledger's How-it-runs row phrasing for each {@link Transport}. */
export const TRANSPORT_LEDGER_LABELS: Record<Transport, string> = {
  browser: "Browser",
  sftp: "SFTP (command-line tool)",
  filedrop: "Shared directory (command-line tool)",
};

/** The review answers-table phrasing for each {@link Transport}. */
export const TRANSPORT_ANSWER_LABELS: Record<Transport, string> = {
  browser: "Live, in this browser",
  sftp: "SFTP (command-line tool)",
  filedrop: "Shared directory (command-line tool)",
};

/** Whether a transport runs in the command-line tool rather than this browser
 * -- the discriminant Create branches on: a CLI transport mints nothing and
 * routes to the save surface, and the browser must never listen for it. A type
 * guard so a narrowed transport reaches the save surface's CLI-only model. */
export function isCliTransport(
  transport: Transport,
): transport is Exclude<Transport, "browser"> {
  return transport !== "browser";
}

/** How a chosen transport would run on this build: the
 * {@link ExchangeDriverSelection} kind as the inviter chooser's UI policy. A console
 * filedrop runs as a server job against the mounted rendezvous directory when
 * `JOB_RENDEZVOUS_DIR` is set, and is disabled otherwise. */
export type TransportRunMode = ExchangeDriverSelection["kind"];

/** One transport card's placement in the chooser: whether it renders disabled,
 * how a pick would run, and -- for SFTP on a console -- whether a connection
 * still needs authoring before it can run here. */
export interface TransportOption {
  transport: Transport;
  disabled: boolean;
  runMode: TransportRunMode;
  /** The console SFTP third state: offered to run here, but no connection is
   * authored yet, so the card reveals the authoring form. False for every other
   * transport and once a connection is configured or the save-a-file alternative
   * is chosen. */
  authoringRequired: boolean;
}

/** The chooser's single source of truth for which transport cards are offered,
 * which render disabled, and which is the default. The capability note and the
 * card copy are regenerated from these facts so copy cannot drift from behavior. */
export interface AvailableTransports {
  options: ReadonlyArray<TransportOption>;
  defaultTransport: Transport;
}

const TRANSPORT_ORDER: ReadonlyArray<Transport> = [
  "browser",
  "sftp",
  "filedrop",
];

/**
 * The transport matrix for a build ({@link AvailableTransports}). Hosted offers
 * all three, defaulting to browser. The console disables Browser, runs filedrop
 * here as a server job when `JOB_RENDEZVOUS_DIR` is set, and defaults to SFTP,
 * else filedrop when mounted, else SFTP for its own authoring.
 *
 * `sftpConfigured` means authored-and-complete; an unconfigured SFTP card still
 * offers to run here with `authoringRequired` set. `sftpSaveFilePreferred` runs
 * SFTP through the operator's own command-line tool instead.
 */
export function availableTransports(
  consoleBuild: boolean,
  sftpConfigured: boolean,
  rendezvousConfigured: boolean,
  sftpSaveFilePreferred = false,
): AvailableTransports {
  const profile: DeploymentProfile = consoleBuild ? "console" : "hosted";
  const options = TRANSPORT_ORDER.map((transport): TransportOption => {
    const disabled =
      consoleBuild &&
      (transport === "browser" ||
        (transport === "filedrop" && !rendezvousConfigured));
    const runMode: TransportRunMode = selectExchangeDriver(
      transport,
      profile,
      sftpConfigured,
      sftpSaveFilePreferred,
    ).kind;
    const authoringRequired =
      transport === "sftp" &&
      consoleBuild &&
      !sftpConfigured &&
      !sftpSaveFilePreferred;
    return { transport, disabled, runMode, authoringRequired };
  });
  const defaultTransport: Transport = consoleBuild
    ? sftpConfigured
      ? "sftp"
      : rendezvousConfigured
        ? "filedrop"
        : "sftp"
    : "browser";
  return { options, defaultTransport };
}

/** The run mode of a chosen transport in an {@link AvailableTransports} matrix;
 * `browser` when the matrix does not model the transport, which keeps callers
 * total. That every build models all three -- so this answer is the matrix's own
 * and never the fallback -- is checked in inviterModel.test.ts. */
export function transportRunMode(
  available: AvailableTransports,
  transport: Transport,
): TransportRunMode {
  return (
    available.options.find((option) => option.transport === transport)
      ?.runMode ?? "browser"
  );
}

const TRANSPORT_RUN_NOUN: Record<Transport, string> = {
  browser: "live",
  sftp: "SFTP",
  filedrop: "shared-directory",
};

function joinNouns(nouns: ReadonlyArray<string>): string {
  if (nouns.length <= 1) return nouns.join("");
  if (nouns.length === 2) return `${nouns[0]} and ${nouns[1]}`;
  return `${nouns.slice(0, -1).join(", ")}, and ${nouns[nouns.length - 1]}`;
}

function transportNounsByRunMode(
  available: AvailableTransports,
  runMode: TransportRunMode,
): Array<string> {
  return available.options
    .filter((option) => option.runMode === runMode && !option.disabled)
    .map((option) => TRANSPORT_RUN_NOUN[option.transport]);
}

/** The capability note, regenerated from {@link availableTransports} facts so the
 * copy cannot drift from which transports run here, save a file for the CLI, or are
 * a disabled roadmap capability. */
function capabilityNoteFor(
  consoleBuild: boolean,
  available: AvailableTransports,
): string {
  if (!consoleBuild)
    return "This browser runs live exchanges only; SFTP and shared-directory exchanges run in the psilink command-line tool.";
  const here = transportNounsByRunMode(available, "server-job");
  const cli = transportNounsByRunMode(available, "save-file");
  const parts: Array<string> = [];
  if (here.length > 0)
    parts.push(`This console runs ${joinNouns(here)} exchanges here`);
  if (cli.length > 0)
    parts.push(
      here.length > 0
        ? `${joinNouns(cli)} exchanges save a file for the command-line tool`
        : `This console saves a file for the command-line tool to run ${joinNouns(cli)} exchanges`,
    );
  parts.push("in-tab browser exchanges are out of scope on this console");
  return `${parts.join("; ")}.`;
}

/** The Review & create transport-chooser copy for the deployment. Hosted keeps
 * browser-only phrasing and saves the two command-line exchanges for the CLI.
 * On the console (`consoleBuild`) Browser is disabled as out of scope; filedrop
 * runs here when `rendezvousConfigured`; SFTP runs here reading the file on the
 * console when `sftpConfigured`, else inviting the operator to author a
 * connection unless `sftpSaveFilePreferred`. Both the SFTP copy and the
 * capability note derive from {@link availableTransports}. */
export interface TransportChooserCopy {
  browserLabel: string;
  browserDescription: string;
  filedropLabel: string;
  filedropDescription: string;
  sftpLabel: string;
  sftpDescription: string;
  capabilityNote: string;
}

/**
 * What the console's rendezvous mounts add to the filedrop card's copy: whether
 * they are a split inbound/outbound pair, and why a configured pair still cannot
 * run. Both are absent off a console build.
 *
 * Kept separate from `rendezvousConfigured`: neither changes which cards are
 * OFFERED (an incoherent pair reports itself unconfigured, disabling the card
 * by that alone) -- they change only what the card SAYS.
 */
export interface RendezvousShape {
  split?: boolean;
  problem?: string;
}

export function transportChooserCopy(
  consoleBuild: boolean,
  sftpConfigured: boolean,
  rendezvousConfigured: boolean,
  sftpSaveFilePreferred = false,
  rendezvousShape: RendezvousShape = {},
): TransportChooserCopy {
  const available = availableTransports(
    consoleBuild,
    sftpConfigured,
    rendezvousConfigured,
    sftpSaveFilePreferred,
  );
  const sftpOption = available.options.find(
    (option) => option.transport === "sftp",
  );
  const sftpRunsHere = sftpOption?.runMode === "server-job";
  const sftpAuthoringRequired = sftpOption?.authoringRequired === true;
  const filedropRunsHere = consoleBuild && rendezvousConfigured;
  return {
    browserLabel: "Live, in this browser",
    browserDescription: consoleBuild
      ? "In-tab browser exchanges are out of scope on this console -- they are the public psilink web app's domain. Run the exchange over SFTP or a shared directory instead."
      : "Your browsers connect directly. You get an invitation link and code to share; keep this tab open while your partner accepts.",
    filedropLabel: filedropRunsHere
      ? "Over a shared directory, run here"
      : "Over a shared directory, run by the command-line tool",
    filedropDescription: filedropRunsHere
      ? rendezvousShape.split === true
        ? 'Runs the exchange here against the two shared folders mounted on this console: it reads your partner\'s files out of one and writes yours into the other. That needs retain mode -- turn on "Keep every exchange file" below. Your file is read on this console, not uploaded from your browser. Your partner accepts with the same invitation code and runs their half against the same two folders.'
        : "Runs the exchange here against the shared directory mounted on this console. Your file is read on this console, not uploaded from your browser. Your partner accepts with the same invitation code and runs their half against the same synced folder."
      : consoleBuild
        ? // The console's own reason wins where it has one: an incoherent pair
          // reports itself unconfigured, and the generic mount-a-directory
          // message would otherwise tell an operator who already mounted two
          // to add a third.
          (rendezvousShape.problem ??
          "Unavailable: mount a rendezvous directory and set JOB_RENDEZVOUS_DIR to run a shared-directory exchange here.")
        : "Saves an exchange file the command-line tool runs against a directory both parties can reach.",
    sftpLabel: sftpRunsHere
      ? "Over SFTP, run here"
      : "Over SFTP, run by the psilink command-line tool",
    sftpDescription: sftpRunsHere
      ? sftpAuthoringRequired
        ? "Runs the exchange here over an SFTP connection you set up below. Your file is read on this console, not uploaded from your browser. Your partner accepts with the same invitation code."
        : "Runs the exchange here through the SFTP connection set up on this machine. Your file is read on this console, not uploaded from your browser. Your partner accepts with the same invitation code."
      : "Saves an exchange file that runs the command-line tool over your SFTP server. Your partner accepts with the same invitation code.",
    capabilityNote: capabilityNoteFor(consoleBuild, available),
  };
}
