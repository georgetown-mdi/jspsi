/**
 * The partner's accept kit: one plaintext, printable, ASCII instruction sheet
 * the inviter downloads at mint time and sends alongside the invitation, for a
 * partner who accepts through the command-line tool (the `sftp` and `filedrop`
 * channels). It assumes the partner has Docker -- Desktop or Engine -- or can
 * get it, and nothing else.
 *
 * Pure: explicit inputs in, one string out -- no React, no I/O, no clock -- so
 * the sheet's whole contract is pinned by unit tests. Its partner-facing
 * invariants are specified in `docs/spec/SERVER_JOB_API.md` ("The partner
 * accept kit").
 *
 * The sheet is a DISCLOSURE SURFACE: whatever it interpolates is written to
 * disk and handed to the partner. Exactly two KINDS of dynamic value are
 * representable here, each justified where it is interpolated -- the rendezvous
 * locator the invitation already carries (its host and directory fields, or a split
 * rendezvous's two folder names), which is free text held to the sheet's ASCII
 * contract by {@link printable}, and this build's public release version, which
 * is interpolated only in the release shape {@link RELEASE_VERSION} admits.
 * Everything else is fixed text: {@link AcceptKitInput} declares only those two
 * kinds and two selector booleans, so no secret, no invitation token, and no path
 * from the inviter's machine or container has a field to arrive in.
 *
 * What the exchange's own settings contribute is therefore a SELECTOR and never
 * a value: {@link AcceptKitInput.retainFiles} and
 * {@link AcceptKitInput.locklessRendezvous} pick between fixed paragraphs and
 * fixed command flags, exactly as the channel discriminant already picks between
 * fixed bodies. Rendering an option block would make a third value representable
 * and void the property above, so a future setting the partner must be told about
 * is disclosed the same way.
 */

/**
 * The rendezvous locator the sheet prints back, in the shapes the console
 * mints: an sftp locator (host, optional port, and either the single shared
 * remote directory or the split inbound/outbound pair) or a filedrop locator
 * (the shared folder's NAME, or the split pair's two names, never the appliance's
 * absolute path). Credential-free by construction, as the invitation endpoint it is
 * copied from is.
 *
 * Every filedrop name is optional because the console cannot always name the
 * shared folder: where the rendezvous mount point was chosen by a launcher
 * rather than by the operator, the mount point is not the folder's name, and the
 * sheet omits the name rather than telling the partner to match one that is not.
 * `split` therefore carries the SHAPE independently of the names: a split
 * rendezvous the console cannot name still has to be described as two folders, or
 * the sheet would send the partner to set up a single shared one.
 */
import { PLACEHOLDER_SSH_USERNAME } from "@psilink/core";

export type AcceptKitEndpoint =
  | {
      channel: "sftp";
      host: string;
      port?: number;
      path?: string;
      inboundPath?: string;
      outboundPath?: string;
    }
  | {
      channel: "filedrop";
      split?: boolean;
      path?: string;
      inboundPath?: string;
      outboundPath?: string;
    };

/**
 * The minted exchange the sheet describes, as the mint fixed it: where the two
 * parties meet, and which bilateral file-handling settings the run carries. Held
 * together so a caller composing the sheet cannot pair one exchange's locator
 * with another's settings.
 */
export interface AcceptKitExchange {
  /** The rendezvous locator minted into the invitation. */
  endpoint: AcceptKitEndpoint;
  /**
   * Whether the inviter turned retain mode on. Retain mode is bilateral and
   * non-negotiated, so the partner's own run must carry it or the two sides stop
   * at rendezvous, and it leaves every protocol file in place afterwards. Both
   * halves are the partner's to know, which is why the sheet takes this at all;
   * it selects fixed text and contributes no value of its own.
   */
  retainFiles: boolean;
  /**
   * Whether the run resolved the lockless rendezvous on -- the setting as the
   * run carries it, with retain mode's implication of it already folded in.
   * Bilateral and non-negotiated like retain mode, and unlike it, it leaves
   * nothing behind: the partner's half of the agreement is the whole of what
   * the sheet has to state, and it too selects fixed text and contributes no
   * value of its own.
   */
  locklessRendezvous: boolean;
}

/**
 * The bilateral settings alone, as every composing helper below takes them: one
 * argument rather than a run of booleans a caller could transpose.
 */
type BilateralSettings = Pick<
  AcceptKitExchange,
  "retainFiles" | "locklessRendezvous"
>;

/** The inputs the sheet is built from. */
export interface AcceptKitInput extends AcceptKitExchange {
  /** The release version this build carries, which decides both the image tag
   * the sheet's commands name and the release page it links; see
   * {@link releaseVersion}. Absent, or in any shape but a release version, the
   * sheet names {@link DEFAULT_PSILINK_IMAGE_TAG} and the releases index. */
  version?: string;
}

/** The published image the sheet's commands run. Named with its registry in
 * full, as the release launchers are, because podman requires the registry
 * prefix and docker accepts it (see `docs/RELEASES.md`). */
const PSILINK_IMAGE_REPOSITORY = "docker.io/vdorie/psi-link";

/**
 * The image tag the sheet names when the build carries no release version -- a
 * development or hosted build, neither of which is a published image. It is the
 * floating tag the release publishes alongside `X.Y.Z` (`docs/RELEASES.md`),
 * the same floating tag the setup script's own `docker run` commands name.
 */
const DEFAULT_PSILINK_IMAGE_TAG = "latest";

/**
 * The shape a release version has: `X.Y.Z` with semver's optional prerelease
 * and build suffixes (`docs/RELEASES.md`). The build's value is interpolated
 * only when it matches, so an absent, partial, or malformed one names the
 * floating tag rather than reaching the sheet -- and `0.0.0`, the marker the
 * manifests that carry no release version hold, is excluded with it. The
 * image build reads the CLI manifest, which never holds `0.0.0`; the carve-out
 * guards a build mis-wired to the unversioned web or root manifest, not a
 * value the production build path delivers.
 */
const RELEASE_VERSION =
  /^(?!0\.0\.0(?:[-+]|$))\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** The release page the launcher files are downloaded from; the same URL the
 * launchers themselves carry. */
const PSILINK_RELEASES_URL = "https://github.com/georgetown-mdi/jspsi/releases";

/** The command-line reference the sheet closes on. */
const PSILINK_CLI_DOC_URL =
  "https://github.com/georgetown-mdi/jspsi/blob/main/docs/CLI.md";

/** The placeholder the partner replaces with the invitation string. The sheet
 * carries this and never a token: the invitation travels separately, so a
 * mislaid sheet discloses nothing. */
export const INVITATION_PLACEHOLDER = "PASTE_YOUR_INVITATION";

/** The container mount point the sheet's commands bind the partner's own
 * working folder to. It is the image's own working directory, part of the
 * published `docker run` form -- a fixed string in the partner's future
 * command, not a path from the inviter's machine. */
const WORK_MOUNT = "/work";

/** The container mount point the filedrop commands bind the partner's own
 * shared folder to. Fixed, like {@link WORK_MOUNT}. */
const SYNC_MOUNT = "/sync";

/** The container mount points a split filedrop's commands bind the partner's own
 * two folders to -- the one they read the inviter's files out of, and the one they
 * write their own into. Fixed, like {@link SYNC_MOUNT}, and named for the direction
 * they have on the PARTNER's side, which is the side the sheet is written for. */
const INBOUND_SYNC_MOUNT = "/sync-in";
const OUTBOUND_SYNC_MOUNT = "/sync-out";

const RULE = "=".repeat(66);

function heading(title: string): Array<string> {
  return [title, "-".repeat(title.length), ""];
}

/**
 * The rendezvous locator, as the sheet prints it back for the partner to check.
 * Interpolating it is not a disclosure: it is exactly the credential-free
 * locator the invitation the partner already holds carries, and on the filedrop
 * channel it is the shared folder's name rather than any path on the inviter's
 * machine.
 *
 * The filedrop cross-check is a check, not a promise of equality: the same
 * shared folder can carry a different name on each side -- a share root mapped
 * to a drive letter is the ordinary case -- so the sheet asks the partner to
 * check the name against what they were told rather than to match it.
 */
function rendezvousLines(endpoint: AcceptKitEndpoint): Array<string> {
  if (endpoint.channel === "filedrop") {
    // A split rendezvous names both folders from the INVITER's side, which is the
    // direction the partner's own tool mirrors: the inviter's inbound is where the
    // partner writes, and the inviter's outbound is where the partner reads.
    // Labelling them by what the READER does with them, rather than by
    // "inbound"/"outbound", is what keeps the sheet from stating the pair
    // backwards for its reader.
    if (endpoint.split === true)
      return endpoint.inboundPath === undefined ||
        endpoint.outboundPath === undefined
        ? [
            "You and your partner meet through two folders rather than one: you",
            "write into one and read their files out of the other. Your partner's",
            "console could not put a name to either, so there is no name here to",
            "check. Use the two folders you and your partner agreed on.",
          ]
        : [
            `  You write to:   ${printable(endpoint.inboundPath)}`,
            `  You read from:  ${printable(endpoint.outboundPath)}`,
            "",
            "You and your partner meet through two folders rather than one. Those",
            "are what your partner calls them; your own names for them can differ",
            "-- a mapped drive letter, or folders you named yourself -- so check",
            "them against the folders you were told to use rather than expecting",
            "the names to match.",
          ];
    return endpoint.path === undefined
      ? [
          "Your partner's console could not put a name to the shared folder, so",
          "there is no name here to check. Use the folder you and your partner",
          "agreed on.",
        ]
      : [
          `  Shared folder:  ${printable(endpoint.path)}`,
          "",
          "That is what your partner calls the shared folder. Your own name for",
          "it can differ -- a mapped drive letter, or a folder you named",
          "yourself -- so check it against the folder you were told to use",
          "rather than expecting the two to match.",
        ];
  }
  const port = endpoint.port === undefined ? "" : `:${endpoint.port}`;
  return [
    `  SFTP server:    ${printable(endpoint.host)}${port}`,
    // A split-directory invitation names both folders from the INVITER's side,
    // which is the direction the partner's own command-line tool mirrors: the
    // inviter's outbound is where the partner reads, and vice versa. Labelling
    // them by whose they are, rather than by "inbound"/"outbound", is what keeps
    // the sheet from stating the pair backwards for its reader.
    ...(endpoint.inboundPath === undefined ||
    endpoint.outboundPath === undefined
      ? endpoint.path === undefined
        ? []
        : [`  Directory:      ${printable(endpoint.path)}`]
      : [
          `  You write to:   ${printable(endpoint.inboundPath)}`,
          `  You read from:  ${printable(endpoint.outboundPath)}`,
        ]),
    "",
    "The invitation carries the same locator. Check it against what you were",
    "told to expect before you accept.",
  ];
}

/** This build's release version, or undefined when it carries none. The one
 * gate on the value: everything below interpolates the result, so nothing the
 * build supplies reaches the sheet without matching {@link RELEASE_VERSION}. */
function releaseVersion(version: string | undefined): string | undefined {
  return version !== undefined && RELEASE_VERSION.test(version)
    ? version
    : undefined;
}

/** The image reference the sheet's `docker run` lines name. The tag is public
 * release metadata, not a disclosure: a released image is named by its own
 * version, so the partner runs the build their invitation was minted by, and
 * any other build names the floating tag. */
function imageReference(version: string | undefined): string {
  return `${PSILINK_IMAGE_REPOSITORY}:${version ?? DEFAULT_PSILINK_IMAGE_TAG}`;
}

/** The release page the launcher files are downloaded from: this build's own
 * release when it carries a version, so the partner takes the launchers from
 * the release that mints their invitation, else the index whose newest entry is
 * what the floating tag resolves to. Release tags are `vX.Y.Z`
 * (`docs/RELEASES.md`). */
function releasePageUrl(version: string | undefined): string {
  return version === undefined
    ? PSILINK_RELEASES_URL
    : `${PSILINK_RELEASES_URL}/tag/v${version}`;
}

/** The accept command, unindented; each caller indents it to its own step.
 * The CSV positional is part of the primary form: it is what makes the
 * consent display list the columns the partner would send, rather than
 * deferring that list to the exchange run. */
function acceptCommand(version: string | undefined): string {
  return (
    `docker run --rm -it -v "$PWD":${WORK_MOUNT} ` +
    `${imageReference(version)} accept ${INVITATION_PLACEHOLDER} your-file.csv`
  );
}

/**
 * What the partner's `exchange` command carries beyond the run itself: the one
 * flag standing for the bilateral settings their side must match.
 *
 * Retain mode travels as the single flag whose implications the CLI resolves
 * for them (`withRetainModeImplications` gives it the timestamped filenames and
 * lockless rendezvous it requires), so the sheet states the operator-visible
 * choice rather than re-deriving the trio here and risking drift from the CLI.
 * That is also why the lockless rendezvous travels only where retain mode is
 * not already carrying it: naming it alongside `--retain-files` would state a
 * rule the CLI does not enforce. Fixed strings chosen by booleans, so nothing
 * new is representable on the sheet.
 */
function bilateralFlag(settings: BilateralSettings): string {
  return chooseBilateral(
    settings,
    " --retain-files",
    " --lockless-rendezvous",
    "",
  );
}

// The one rule for which bilateral agreement the sheet names: retain mode
// already implies the lockless rendezvous, so its text wins; otherwise the
// lockless setting speaks only where it is on.
function chooseBilateral<T>(
  { retainFiles, locklessRendezvous }: BilateralSettings,
  forRetain: T,
  forLockless: T,
  forNeither: T,
): T {
  if (retainFiles) return forRetain;
  return locklessRendezvous ? forLockless : forNeither;
}

/**
 * The flag explained where the reader meets it, so a partner who edits the
 * command down keeps the half of the agreement their side has to run. Indented
 * to the step both bodies print the command in.
 */
function bilateralFlagLines(settings: BilateralSettings): Array<string> {
  return chooseBilateral(
    settings,
    [
      "   --retain-files is your half of the agreement above. Leave it on the",
      "   command: without it the two of you stop with an error when you",
      "   meet.",
      "",
    ],
    [
      "   --lockless-rendezvous is your half of a setting your partner turned",
      "   on: the two sides meet with an acknowledgement instead of a lock",
      "   file. It is an agreement, not a negotiation -- leave it on the",
      "   command, or the two of you stop with an error when you meet.",
      "",
    ],
    [],
  );
}

/**
 * The same agreement, named as the console control that sets it, for the
 * filedrop launcher route: that route hands the partner to the console's accept
 * flow and never runs the commands below, so naming the control is what keeps it
 * from rendezvousing into a mismatch.
 */
function consoleControlLines(settings: BilateralSettings): Array<string> {
  return chooseBilateral(
    settings,
    [
      'Before you start the exchange there, open "How files are handled" in',
      'that accept flow and turn on "Keep every exchange file". That is the',
      "same agreement the section above describes, set on the console rather",
      "than on the command line; without it the two of you stop with an",
      "error when you meet.",
      "",
    ],
    [
      'Before you start the exchange there, open "How files are handled" in',
      'that accept flow and set "Lockless rendezvous" to On. Your partner',
      "turned that setting on, and it is an agreement, not a negotiation:",
      "without it the two of you stop with an error when you meet.",
      "",
    ],
    [],
  );
}

/**
 * What retain mode leaves behind, and what the partner must do about it. Retain
 * mode is bilateral and non-negotiated, so a partner told only how to accept
 * would meet a mismatch at rendezvous; and it leaves every protocol file in the
 * rendezvous location as a permanent transcript, which is the partner's to know
 * before they join rather than after. Fixed paragraphs per channel, selected by
 * the boolean.
 *
 * The message bodies stay ciphertext in the transcript (see
 * `docs/spec/CHANNEL_SECURITY.md`), but the control files the two sides meet
 * through do not: the hello bodies are plaintext and the filenames carry each
 * party's name, timestamps, sequence numbers, and byte counts, so the disclosure
 * names what an eventual reader of that location learns rather than leaving the
 * partner to infer it from "keeps every file".
 */
function retainLines(endpoint: AcceptKitEndpoint): Array<string> {
  const split =
    endpoint.channel === "sftp" &&
    endpoint.inboundPath !== undefined &&
    endpoint.outboundPath !== undefined;
  const persistence =
    endpoint.channel === "filedrop"
      ? endpoint.split === true
        ? [
            "The files stay in both folders above -- the one you write into and",
            "the one you read from -- your copies of them and your partner's",
            "alike. Nothing removes them when the exchange ends, so both folders",
            "must start empty on both sides, and clearing them afterwards is a",
            "decision the two of you make deliberately.",
          ]
        : [
            "The files stay in the shared folder the two of you meet in -- your",
            "copy of it and your partner's alike. Nothing removes them when the",
            "exchange ends, so both of you must start from an empty shared folder,",
            "and clearing it afterwards is a decision the two of you make",
            "deliberately.",
          ]
      : split
        ? [
            "The files stay in both directories above -- the one you write to",
            "and the one you read from -- on the SFTP server named above.",
            "Nothing removes them when the exchange ends, so both directories",
            "must start empty, and clearing them afterwards is a decision the",
            "two of you make deliberately.",
          ]
        : [
            "The files stay in the directory the two of you meet in, on the SFTP",
            "server named above. Nothing removes them when the exchange ends, so",
            "both of you must start from an empty directory, and clearing it",
            "afterwards is a decision the two of you make deliberately.",
          ];
  return [
    ...heading("THIS EXCHANGE KEEPS ITS FILES"),
    "Your partner has turned on retain mode, so this exchange keeps every",
    "file it writes as a permanent transcript instead of deleting each one",
    "once it has been read.",
    "",
    ...persistence,
    "",
    "The records the two of you exchange are encrypted, and stay encrypted",
    "in what is left behind. The small files the two sides meet through are",
    "not: they are plaintext and they persist alongside the rest, so anyone",
    "who can read that location afterwards can see that an exchange",
    "happened, when, how many messages each side sent and how large they",
    "were, the name each side ran under, and the settings each side",
    "announced. Nothing there is your CSV file or the matched result.",
    "",
    "Retain mode is an agreement, not a negotiation: your side must run it",
    "too, or the two of you stop with an error when you meet. The commands",
    "below already carry it.",
    "",
  ];
}

/** Interpolated operator-authored text, held to the sheet's printable-ASCII
 * contract: any byte outside printable ASCII renders as '?', so the stated
 * invariant is enforced here rather than assumed of the console's inputs. */
function printable(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "?");
}

/** The shared opening: what this is, what the partner needs, and where the
 * terms actually live. The channel is named; the terms are not restated -- the
 * invitation's own consent display owns that disclosure. */
function opening(
  endpoint: AcceptKitEndpoint,
  { retainFiles }: BilateralSettings,
): Array<string> {
  const channelLines =
    endpoint.channel !== "filedrop"
      ? ["This one runs over an SFTP server."]
      : endpoint.split === true
        ? [
            "This one runs over two folders you and your partner can both reach:",
            "you write your half into one and read their half out of the other.",
          ]
        : [
            "This one runs over a shared folder you and your partner can both",
            "reach.",
          ];
  return [
    RULE,
    "PSILINK -- HOW TO ACCEPT THIS EXCHANGE",
    RULE,
    "",
    "Your partner has set up a psilink record-linkage exchange with you and",
    "sent you an invitation. This sheet takes you from nothing to accepting",
    "it.",
    "",
    ...channelLines,
    "",
    "The invitation is confidential: it carries a one-time secret, so keep it",
    "to the channel it arrived on. This sheet carries no secret of any kind.",
    "",
    ...heading("WHAT YOU NEED"),
    "Docker, installed and running. Docker Desktop (docker.com) is the",
    "usual way to get it, on Windows, macOS, and Linux alike. Nothing else:",
    "psilink runs as a container, so there is nothing to install; what it",
    "writes stays in the folders you mount below.",
    "",
    "Every command below is a single line, even where it wraps on screen.",
    "On Windows, run the commands from PowerShell, not Command Prompt.",
    "",
    // Ahead of the engine question, because it qualifies every reader: psilink
    // names a party only from what the operator gives it, so an acceptance
    // carrying no name stops. The engine section below is one a whole reader
    // class is told to skip, which is why this cannot live there. Scoped to the
    // accept command, the one place on this sheet that chooses the label:
    // accepting writes it into psilink.yaml and the exchange steps read it from
    // there. The flag SHAPE is shown and the value is shouted rather than
    // plausible: an unreplaced placeholder would otherwise reach the partner as
    // this party's name, and no command on this sheet carries it pre-filled for
    // that reason.
    ...heading("THE NAME YOUR PARTNER SEES"),
    "psilink records a name for your side -- what your partner reads as who",
    "they exchanged with, in the agreed terms and in the record each of you",
    "keeps. It picks none for you, so add this to the end of the accept",
    "command on this sheet:",
    "",
    '  --identity "YOUR NAME, YOUR ORGANIZATION"',
    "",
    "with both parts replaced by what your partner will recognize -- your",
    "own name, and the organization you are exchanging on behalf of. Leave",
    "it off and accepting stops and asks, rather than naming you itself.",
    "",
    "Accepting writes that name into psilink.yaml, so the exchange command",
    "later on takes it from there and needs no flag of its own.",
    "",
    ...heading("WHICH DOCKER DO YOU HAVE?"),
    "  * Docker Desktop, on Windows, macOS, or Linux: nothing to do here.",
    "    Skip to the next section.",
    "  * Docker Engine on Linux -- the docker your distribution packages:",
    "    read the rest of this section first.",
    "",
    "On Docker Engine, psilink can hit 'permission denied' the moment it",
    "tries to write in a folder you gave it. That is because psilink runs",
    "inside the container as a user numbered 1000 rather than as you, while",
    "a folder you mount keeps the owner it has on your machine.",
    "",
    "One flag settles it. Add it to every command on this sheet, straight",
    "after the word run:",
    "",
    '  --user "$(id -u):$(id -g)"',
    "",
    "That runs psilink as you: every folder you can use, it can use --",
    ...(endpoint.channel !== "filedrop"
      ? [
          "the folder holding your CSV file and the folder holding your",
          "password file -- and everything it writes stays yours afterwards.",
        ]
      : endpoint.split === true
        ? [
            "the folder holding your CSV file and your own copies of the two",
            "shared folders -- and everything it writes stays yours afterwards.",
          ]
        : [
            "the folder holding your CSV file and your own copy of the shared",
            "folder -- and everything it writes stays yours afterwards.",
          ]),
    "",
    "If you cannot change the commands, the other way is to hand a single",
    "folder over to user 1000. From inside the folder that holds your CSV",
    ...(endpoint.channel !== "filedrop"
      ? ["file, run:"]
      : endpoint.split === true
        ? ["file -- your own folder, never a shared one -- run:"]
        : ["file -- your own folder, never the shared one -- run:"]),
    "",
    "  sudo chown 1000:1000 .",
    "",
    "User 1000 is a number, not a name: whoever holds it on this machine",
    "is who the folder now belongs to, and so is what psilink writes in",
    "it. On your own computer that is almost certainly you. On one you",
    "share with other people it can be someone else, and the flag above",
    "is the better answer there.",
    "",
    "If that asks for a password you do not have, or answers",
    "'Operation not permitted', use the flag above instead. It also covers",
    "only the folder you run it in, so any other folder a command below",
    "mounts needs its own answer.",
    "",
    ...heading("WHAT YOU ARE AGREEING TO"),
    "Not on this sheet, deliberately. Accepting prints your partner's linkage",
    "terms -- what records are matched on, what you receive, and who gets",
    "the result -- and asks you to confirm them. Run accept with your CSV",
    "file named, as the commands below do, and the display also lists which",
    "of your columns would be sent. That display is the thing to read before",
    "you answer; this sheet only gets you to it.",
    "",
    ...heading("WHERE YOU WILL MEET"),
    ...rendezvousLines(endpoint),
    "",
    ...(retainFiles ? retainLines(endpoint) : []),
  ];
}

/**
 * The opening of the step that repoints psilink at the partner's own copy of
 * the shared folder, which turns on whether the sheet could name that folder.
 * Named, accepting wrote the inviter's name for it. Unnamed, what accepting
 * wrote is the console's own mount point -- the token always carries a locator
 * -- so the step calls it a placeholder rather than a name either side chose,
 * and directs the same replacement.
 */
function repointStepOpening(named: boolean): Array<string> {
  return named
    ? [
        "2. Point psilink at your own copy of the shared folder. Accepting wrote",
        "   your partner's own name for the folder; what psilink needs is where",
        "   that folder is on your machine. Open psilink.yaml and set:",
      ]
    : [
        "2. Point psilink at your own copy of the shared folder. Accepting wrote",
        "   a placeholder for the folder, not a name either of you chose; what",
        "   psilink needs is where that folder is on your machine. Open",
        "   psilink.yaml and set:",
      ];
}

/** The split rendezvous's counterpart to {@link repointStepOpening}. Accepting
 * mirror-swaps the inviter's pair, so what it wrote is already this reader's own
 * inbound and outbound; only the machine-local locations are theirs to fill in. */
function splitRepointStepOpening(named: boolean): Array<string> {
  return named
    ? [
        "2. Point psilink at your own copies of the two folders. Accepting wrote",
        "   your partner's own names for them; what psilink needs is where those",
        "   folders are on your machine. Open psilink.yaml and set:",
      ]
    : [
        "2. Point psilink at your own copies of the two folders. Accepting wrote",
        "   placeholders for them, not names either of you chose; what psilink",
        "   needs is where those folders are on your machine. Open psilink.yaml",
        "   and set:",
      ];
}

/** The accept step both filedrop bodies open on: run accept, then the three
 * caveats a reader needs before the next step (what to substitute, keeping the
 * code out of the shell history, and the Windows path form). */
function filedropAcceptStep(version: string | undefined): Array<string> {
  return [
    "1. Accept the invitation. This prints the terms, asks you to confirm,",
    "   and on a yes writes psilink.yaml and .psilink.key into the folder:",
    "",
    `     ${acceptCommand(version)}`,
    "",
    `   Replace ${INVITATION_PLACEHOLDER} with the invitation code your`,
    "   partner sent -- the long block of letters and numbers, not the web",
    "   link -- and your-file.csv with your CSV file's name. Naming your",
    "   file is what lets the display list the columns you would send",
    "   before you confirm; without it, that list is worked out from your",
    "   file only when the exchange runs, and you are not asked again.",
    "",
    "   To keep the code out of your command history, save it into a file",
    "   named invitation.txt next to your CSV and write @invitation.txt in",
    "   its place.",
    "",
    '   On Windows PowerShell, replace "$PWD" with the folder\'s full path in',
    "   every command on this sheet, for example",
    `   -v "C:\\Users\\you\\exchange":${WORK_MOUNT}`,
    "",
  ];
}

/**
 * The split filedrop body: the same two commands as the single-folder route, over
 * two mounts instead of one.
 *
 * Its situation A differs from the single-folder route's in the one way that
 * matters: the PowerShell launchers provision a single rendezvous folder, so they
 * cannot start this exchange. Saying so plainly, with the two ways forward, is what
 * keeps a Windows network-drive partner from following a route that ends in a
 * console the exchange cannot run.
 */
function filedropSplitBody(
  version: string | undefined,
  named: boolean,
  settings: BilateralSettings,
): Array<string> {
  return [
    ...heading("STEP 1 -- WHICH KIND OF FOLDERS ARE YOURS?"),
    "This exchange meets through two folders rather than one. The answer",
    "decides everything below. Pick one.",
    "",
    "  A. A Windows network drive or a DFS path. Either folder opens in File",
    "     Explorer as Z:\\Exchange, \\\\fileserver\\exchange, or a DFS namespace",
    "     your IT department set up.",
    "",
    "  B. Folders that sync on this PC, or any other folders Docker can open:",
    "     synced folders under your own user folder (OneDrive, Dropbox,",
    "     Egnyte and the like), plain local folders, or shares you mounted",
    "     yourself on macOS or Linux.",
    "",
    ...heading("A -- A WINDOWS NETWORK DRIVE OR A DFS PATH"),
    "Docker cannot see drive letters or network paths: they belong to",
    "Windows, not to the small Linux virtual machine Docker runs inside. The",
    "psilink launcher scripts that settle that for you cover a single shared",
    "folder, not the two this exchange uses, so they cannot start this one.",
    "",
    "Two ways forward, and either is fine:",
    "",
    "  * Ask your IT department to make both folders reachable as ordinary",
    "    paths on this machine. Once they open as folders rather than as",
    "    drive letters or network paths, they are situation B below.",
    "",
    "  * Ask your partner for a new invitation over a single shared folder",
    "    instead. Nothing is lost by starting again.",
    "",
    "(On macOS or Linux a network share is not situation A: mount it the way",
    'you usually do -- Finder\'s "Connect to Server", or your file manager --',
    "and once it shows as a folder, it is situation B below.)",
    "",
    ...heading("B -- FOLDERS DOCKER CAN OPEN"),
    "Two commands, both run from the folder that holds your CSV file. Use a",
    "folder of your own, neither of the shared folders: accepting writes",
    "psilink.yaml and .psilink.key (your key file) beside your CSV, and",
    "anything inside a shared folder can be read and changed by everyone",
    "with access to it.",
    "",
    ...filedropAcceptStep(version),
    ...splitRepointStepOpening(named),
    "",
    "     connection:",
    "       channel: filedrop",
    `       inbound_path: ${INBOUND_SYNC_MOUNT}`,
    `       outbound_path: ${OUTBOUND_SYNC_MOUNT}`,
    "",
    "   Then mount your two folders there when you run the exchange -- the",
    `   one you READ your partner's files out of at ${INBOUND_SYNC_MOUNT}, the one you`,
    `   WRITE your own into at ${OUTBOUND_SYNC_MOUNT}:`,
    "",
    `     docker run --rm -v "$PWD":${WORK_MOUNT} ` +
      `-v "/path/to/the/folder/you/read":${INBOUND_SYNC_MOUNT} ` +
      `-v "/path/to/the/folder/you/write":${OUTBOUND_SYNC_MOUNT} ` +
      `${imageReference(version)} exchange${bilateralFlag(settings)} ` +
      `your-file.csv results.csv`,
    "",
    "   Getting the two the wrong way round is the one mistake to watch for:",
    "   the exchange would then wait for files in the folder it is writing",
    "   into and never meet your partner. Replace your-file.csv with your",
    "   CSV file's name. The matched result is written to results.csv beside",
    "   your input. You and your partner each run your own half; whichever",
    "   runs first waits for the other.",
    "",
    ...bilateralFlagLines(settings),
  ];
}

/** The filedrop routing decision: a network drive or DFS path needs the
 * launcher, any folder Docker can open takes the direct commands. */
function filedropBody(
  version: string | undefined,
  named: boolean,
  settings: BilateralSettings,
): Array<string> {
  return [
    ...heading("STEP 1 -- WHICH KIND OF FOLDER IS YOURS?"),
    "The answer decides everything below. Pick one.",
    "",
    "  A. A Windows network drive or a DFS path. It opens in File Explorer",
    "     as Z:\\Exchange, \\\\fileserver\\exchange, or a DFS namespace your",
    "     IT department set up.",
    "",
    "  B. A folder that syncs on this PC, or any other folder Docker can",
    "     open: a synced folder under your own user folder (OneDrive,",
    "     Dropbox, Egnyte and the like), a plain local folder, or a share",
    "     you mounted yourself on macOS or Linux.",
    "",
    ...heading("A -- A WINDOWS NETWORK DRIVE OR A DFS PATH"),
    "Docker cannot see drive letters or network paths: they belong to",
    "Windows, not to the small Linux virtual machine Docker runs inside. Your",
    "file server also treats Docker as a different computer, so it needs its",
    "own sign-in for the share. A launcher script does all of that for you.",
    "",
    "Download both files from the psilink release page:",
    "",
    `  ${releasePageUrl(version)}`,
    "",
    "  Start-Psilink.ps1",
    "  Setup-PsilinkFileDrop.ps1  (must sit beside it)",
    "",
    'Put them in a folder of their own and run, in PowerShell -- not "Run as',
    'administrator", because an elevated window cannot see the drives you',
    "mapped as yourself:",
    "",
    "  powershell -ExecutionPolicy Bypass -File .\\Start-Psilink.ps1",
    "",
    "It asks for your folders, works out the real server and share behind",
    "your drive letter or DFS path, creates the Docker volume that reaches",
    "it, checks the folder, and opens the psilink console in your browser.",
    "Paste the invitation into the console's accept flow there, and you are",
    "done -- the rest of this sheet is for situation B.",
    "",
    ...consoleControlLines(settings),
    "(On macOS or Linux a network share is not situation A: mount it the way",
    'you usually do -- Finder\'s "Connect to Server", or your file manager --',
    "and once it shows as a folder, it is situation B below.)",
    "",
    "Why you can trust those files: they are plaintext PowerShell scripts,",
    "meant to be read, so your IT department can review every line before",
    "you run one. Take them from the release page above and nowhere else:",
    "that is where the release publishes them together, and the release",
    "copy of Start-Psilink.ps1 names the exact psilink image it starts, so",
    "what it runs is what that release built.",
    "",
    ...heading("B -- A FOLDER DOCKER CAN OPEN"),
    "Two commands, both run from the folder that holds your CSV file. Use a",
    "folder of your own, not the shared folder itself: accepting writes",
    "psilink.yaml and .psilink.key (your key file) beside your CSV, and",
    "anything inside the shared folder can be read and changed by everyone",
    "with access to it.",
    "",
    ...filedropAcceptStep(version),
    ...repointStepOpening(named),
    "",
    "     connection:",
    "       channel: filedrop",
    `       path: ${SYNC_MOUNT}`,
    "",
    "   Then mount your shared folder there when you run the exchange:",
    "",
    `     docker run --rm -v "$PWD":${WORK_MOUNT} ` +
      `-v "/path/to/your/shared/folder":${SYNC_MOUNT} ` +
      `${imageReference(version)} exchange${bilateralFlag(settings)} ` +
      `your-file.csv results.csv`,
    "",
    "   Replace your-file.csv with your CSV file's name. The matched result",
    "   is written to results.csv beside your input. You and your partner",
    "   each run your own half; whichever runs first waits for the other.",
    "",
    ...bilateralFlagLines(settings),
  ];
}

/** The SFTP body: accept, fill in the credentials acceptance leaves open, then
 * run -- in that order, because the exchange command only works after the
 * fill-in and a reader follows the sheet top to bottom. */
function sftpBody(
  version: string | undefined,
  settings: BilateralSettings,
): Array<string> {
  return [
    ...heading("THE THREE STEPS"),
    "The commands run from the folder that holds your CSV file.",
    "",
    "1. Accept the invitation. This prints the terms, asks you to confirm,",
    "   and on a yes writes psilink.yaml and .psilink.key into the folder:",
    "",
    `     ${acceptCommand(version)}`,
    "",
    `   Replace ${INVITATION_PLACEHOLDER} with the invitation code your`,
    "   partner sent -- the long block of letters and numbers, not the web",
    "   link -- and your-file.csv with your CSV file's name. Naming your",
    "   file is what lets the display list the columns you would send",
    "   before you confirm; without it, that list is worked out from your",
    "   file only when the exchange runs, and you are not asked again.",
    "",
    "   To keep the code out of your command history, save it into a file",
    "   named invitation.txt next to your CSV and write @invitation.txt in",
    "   its place.",
    "",
    '   On Windows PowerShell, replace "$PWD" with the folder\'s full path in',
    "   every command on this sheet, for example",
    `   -v "C:\\Users\\you\\exchange":${WORK_MOUNT}`,
    "",
    "2. Fill in your credentials. Accepting wrote psilink.yaml with the",
    "   server and directory taken from the invitation; two things are yours",
    "   to supply, because an invitation never carries credentials:",
    "",
    // The placeholder is core's own constant, so the sheet cannot drift from
    // what accept actually seeds into psilink.yaml.
    `     username: ${PLACEHOLDER_SSH_USERNAME}`,
    "         Replace this placeholder with the account the SFTP server",
    "         accepts for you.",
    "",
    "     password (or private_key)",
    "         Add one under the same server: block. Point it at a file with",
    "         the @ convention rather than typing the secret into",
    "         psilink.yaml:",
    "",
    "           connection:",
    "             server:",
    "               username: your-account",
    "               password: '@/run/secrets/sftp-password'",
    "",
    "         A value beginning with @ is read from that file when psilink",
    "         runs, so the secret stays out of psilink.yaml, out of your",
    "         shell history, and out of process listings.",
    "",
    "   psilink never sends either one to your partner: your credential",
    "   goes only from your machine to the server.",
    "",
    "3. Run the exchange. Docker sees only what you mount, so the command",
    "   also mounts the folder holding your credential file, read-only:",
    "",
    `     docker run --rm -it -v "$PWD":${WORK_MOUNT} ` +
      `-v "/your/secrets":/run/secrets:ro ` +
      `${imageReference(version)} exchange${bilateralFlag(settings)} ` +
      `your-file.csv results.csv`,
    "",
    '   Replace "/your/secrets" with the folder that holds your credential',
    "   file, and your-file.csv with your CSV file's name. The matched",
    "   result is written to results.csv beside your input. You and your",
    "   partner each run your own half; whichever runs first waits for the",
    "   other.",
    "",
    ...bilateralFlagLines(settings),
    "   The first run shows the server's SSH host-key fingerprint and asks",
    "   you to confirm it. Check it against the value the server's",
    "   administrator published; later runs verify it silently.",
    "",
  ];
}

/** The shared closing: recovery, the privacy reassurance, and the reference
 * links. */
function closing(version: string | undefined): Array<string> {
  return [
    ...heading("KEEPING THE KEY FILE"),
    "Accepting writes .psilink.key holding the shared secret: keep it",
    "owner-only (chmod 600 on macOS or Linux) and never commit it.",
    "",
    ...heading("IF SOMETHING GOES WRONG"),
    "  * Invitations expire. If yours has, ask your partner for a new one --",
    "    nothing is lost by starting again.",
    "  * Every command prints what it did and which files it wrote.",
    "  * Your input file itself is never sent. psilink reads it in the folder",
    "    you mounted and writes the result beside your input; what goes to",
    "    your partner is what the accept display describes.",
    "",
    ...heading("REFERENCE"),
    "  Command-line reference:",
    `    ${PSILINK_CLI_DOC_URL}`,
    "  psilink image used above:",
    `    ${imageReference(version)}`,
    "",
  ];
}

/**
 * Build the accept kit for one minted invitation. The output is printable
 * ASCII with a trailing newline, addressed to the partner.
 */
export function buildAcceptKit({
  endpoint,
  version: buildVersion,
  ...settings
}: AcceptKitInput): string {
  const version = releaseVersion(buildVersion);
  const lines = [
    ...opening(endpoint, settings),
    ...(endpoint.channel !== "filedrop"
      ? sftpBody(version, settings)
      : endpoint.split === true
        ? filedropSplitBody(
            version,
            endpoint.inboundPath !== undefined &&
              endpoint.outboundPath !== undefined,
            settings,
          )
        : filedropBody(version, endpoint.path !== undefined, settings)),
    ...closing(version),
  ];
  return `${lines.join("\n")}\n`;
}

/** The download filename `psilink-accept-instructions-<date>.txt`, the date the
 * local calendar day of `at` -- the moment the operator clicks download, which
 * can be any time the share screen is open, not the mint moment. */
export function acceptKitFileName(at: Date): string {
  const year = at.getFullYear();
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `psilink-accept-instructions-${year}-${month}-${day}.txt`;
}
