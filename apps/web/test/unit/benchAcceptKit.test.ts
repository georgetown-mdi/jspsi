import { Readable } from "node:stream";

import { describe, expect, test } from "vitest";

import {
  INVITATION_PLACEHOLDER,
  acceptKitFileName,
  buildAcceptKit,
} from "@bench/acceptKit";
import { generateInvitation } from "@psi/invitation";

import type { AcceptKitEndpoint } from "@bench/acceptKit";
import type { InvitationLocation } from "@psi/invitation";

const FILEDROP: AcceptKitEndpoint = { channel: "filedrop", path: "psilink" };
const UNNAMED_FILEDROP: AcceptKitEndpoint = { channel: "filedrop" };
const FILEDROP_SPLIT: AcceptKitEndpoint = {
  channel: "filedrop",
  split: true,
  inboundPath: "to-clinic",
  outboundPath: "from-clinic",
};
const UNNAMED_FILEDROP_SPLIT: AcceptKitEndpoint = {
  channel: "filedrop",
  split: true,
};
const SFTP: AcceptKitEndpoint = {
  channel: "sftp",
  host: "sftp.example.gov",
  port: 2222,
  path: "/drops/psilink",
};
const SFTP_SPLIT: AcceptKitEndpoint = {
  channel: "sftp",
  host: "sftp.example.gov",
  port: 2222,
  inboundPath: "/exchange/from-partner",
  outboundPath: "/exchange/from-inviter",
};

/** The sheet for an exchange in the default file-handling mode: everything
 * outside the retain and lockless suites below reads this one. */
function sheet(endpoint: AcceptKitEndpoint, version = "1.4.2"): string {
  return buildAcceptKit({
    endpoint,
    retainFiles: false,
    locklessRendezvous: false,
    version,
  });
}

/** The sheet for an exchange the inviter turned retain mode on for, holding
 * the lockless rendezvous retain mode implies -- what the mint resolves. */
function retainSheet(endpoint: AcceptKitEndpoint, version = "1.4.2"): string {
  return buildAcceptKit({
    endpoint,
    retainFiles: true,
    locklessRendezvous: true,
    version,
  });
}

/** The sheet for an exchange running the lockless rendezvous on its own, which
 * is the operator stating it rather than retain mode implying it. */
function locklessSheet(endpoint: AcceptKitEndpoint, version = "1.4.2"): string {
  return buildAcceptKit({
    endpoint,
    retainFiles: false,
    locklessRendezvous: true,
    version,
  });
}

/** The launcher branch's tell: the release page the three files come from. */
const RELEASES_URL = "https://github.com/georgetown-mdi/jspsi/releases";

/** Every channel shape the console can mint a kit for. */
const ENDPOINTS = [
  FILEDROP,
  UNNAMED_FILEDROP,
  FILEDROP_SPLIT,
  UNNAMED_FILEDROP_SPLIT,
  SFTP,
  SFTP_SPLIT,
];

/** The exchange command as it stands in the default file-handling mode: the one
 * line a bilateral setting rewrites rather than adds. */
function plainExchangeCommand(endpoint: AcceptKitEndpoint): string {
  if (endpoint.channel !== "filedrop")
    return (
      '     docker run --rm -it -v "$PWD":/work -v "/your/secrets":' +
      "/run/secrets:ro docker.io/vdorie/psi-link:1.4.2 exchange " +
      "your-file.csv results.csv"
    );
  return endpoint.split === true
    ? '     docker run --rm -v "$PWD":/work -v "/path/to/the/folder/you/read":' +
        '/sync-in -v "/path/to/the/folder/you/write":/sync-out ' +
        "docker.io/vdorie/psi-link:1.4.2 exchange your-file.csv results.csv"
    : '     docker run --rm -v "$PWD":/work -v "/path/to/your/shared/folder":' +
        "/sync docker.io/vdorie/psi-link:1.4.2 exchange your-file.csv " +
        "results.csv";
}

/** The lines `variant` has that `base` does not: one setting's whole
 * contribution to the sheet, blank lines excluded because both sheets have
 * them. */
function addedLines(base: string, variant: string): Array<string> {
  const known = new Set(base.split("\n"));
  return variant.split("\n").filter((line) => !known.has(line));
}

describe("accept kit, per-channel shape", () => {
  test("a filedrop sheet names the channel and the shared folder", () => {
    const text = sheet(FILEDROP);
    expect(text).toContain("HOW TO ACCEPT THIS EXCHANGE");
    expect(text).toContain("shared folder you and your partner can both");
    expect(text).toContain("Shared folder:  psilink");
    // The SFTP-only material stays off it.
    expect(text).not.toContain("REPLACE_WITH_SSH_USERNAME");
    expect(text).not.toContain("SFTP server:");
  });

  test("the folder cross-check is a check, not a claim that the names match", () => {
    // The same folder can have a different name on each side -- a share root
    // mapped to a drive letter is the ordinary case -- so the sheet must not tell
    // the partner their own name for it will be this one.
    const text = sheet(FILEDROP);
    expect(text).toContain("Your own name for");
    expect(text).toContain("rather than expecting the two to match");
  });

  test("a filedrop sheet the console could not name the folder for prints no name", () => {
    const text = sheet({ channel: "filedrop" });
    // No name at all rather than a stand-in: the mount point the console binds
    // the folder at is not a name any partner could check against.
    expect(text).not.toContain("Shared folder:");
    expect(text).toContain("could not put a name to the shared folder");
    expect(text).toContain("Use the folder you and your partner");
    // The route to accepting is unchanged -- it is only the name that is
    // missing -- and the guidance blocks stay pinned.
    expect(text).toContain("WHICH KIND OF FOLDER IS YOURS?");
    expect(text).toContain(INVITATION_PLACEHOLDER);
  });

  test("the folder step names no partner name where the sheet has none", () => {
    // The token always has a locator, so accepting writes SOMETHING; on this
    // branch it is the console's own mount point. The step that replaces it must
    // not tell the partner it is their partner's name for the folder.
    const text = sheet({ channel: "filedrop" });
    expect(text).not.toContain("your partner's own name for the folder");
    expect(text).toContain("a placeholder for the folder, not a name either");
    // The replacement it directs is the same one the named branch directs.
    expect(text).toContain("path: /sync");
  });

  test("the folder step names the partner's own name where the sheet has one", () => {
    const text = sheet(FILEDROP);
    expect(text).toContain("your partner's own name for the folder");
    expect(text).not.toContain("a placeholder for the folder");
    expect(text).toContain("path: /sync");
  });

  test("an sftp sheet names the channel and the server locator", () => {
    const text = sheet(SFTP);
    expect(text).toContain("This one runs over an SFTP server.");
    expect(text).toContain("SFTP server:    sftp.example.gov:2222");
    expect(text).toContain("Directory:      /drops/psilink");
    // The filedrop-only routing stays off it: an SFTP partner has no folder
    // question to answer, so the sheet goes straight to the commands.
    expect(text).not.toContain("WHICH KIND OF FOLDER IS YOURS?");
    expect(text).not.toContain(RELEASES_URL);
  });

  test("an sftp locator without a port or directory prints neither", () => {
    const text = sheet({ channel: "sftp", host: "sftp.example.gov" });
    expect(text).toContain("SFTP server:    sftp.example.gov\n");
    expect(text).not.toContain("Directory:");
  });

  test("a split-directory sftp sheet states each folder from the READER's side", () => {
    // The invitation names the pair from the inviter's side: the inviter's
    // inbound is where its peer -- this sheet's reader -- writes.
    const text = sheet({
      channel: "sftp",
      host: "sftp.example.gov",
      inboundPath: "/exchange/from-partner",
      outboundPath: "/exchange/from-inviter",
    });
    expect(text).toContain("You write to:   /exchange/from-partner");
    expect(text).toContain("You read from:  /exchange/from-inviter");
    expect(text).not.toContain("Directory:");
  });

  test("the terms are referred to, never restated", () => {
    for (const endpoint of [FILEDROP, SFTP]) {
      const text = sheet(endpoint);
      // The sheet points at the accept display and says the terms live there.
      expect(text).toContain("WHAT YOU ARE AGREEING TO");
      expect(text).toContain("Accepting prints your partner's linkage");
      expect(text).toContain("this sheet");
    }
  });
});

describe("accept kit, the account the container runs as", () => {
  const USER_FLAG = '--user "$(id -u):$(id -g)"';
  const CHOWN = "chown 1000:1000 .";

  test("gates on the engine before it instructs, on both channels", () => {
    for (const endpoint of [FILEDROP, SFTP]) {
      const text = sheet(endpoint);
      // The reader with nothing to do learns that first, and the exemption is
      // scoped by engine rather than by OS: Docker Desktop runs on Linux too,
      // and presents a mount to whoever the container runs as wherever it runs.
      expect(text).toContain("Docker Desktop, on Windows, macOS, or Linux");
      expect(text).toContain("Docker Engine on Linux");
      const gate = text.indexOf("WHICH DOCKER DO YOU HAVE?");
      expect(gate).toBeGreaterThan(-1);
      expect(gate).toBeLessThan(text.indexOf(USER_FLAG));
      expect(gate).toBeLessThan(text.indexOf(CHOWN));
      // The section qualifies every command on the sheet, so it precedes the
      // first one: the image runs as uid 1000, and a bind-mounted folder owned
      // by anyone else fails the partner's accept on its first write.
      expect(text).toContain("numbered 1000");
      expect(text.indexOf(CHOWN)).toBeLessThan(text.indexOf("docker run"));
    }
  });

  test("leads with the flag and keeps chown as the privileged fallback", () => {
    for (const endpoint of [FILEDROP, SFTP]) {
      const text = sheet(endpoint);
      // The flag needs no privilege, covers every folder the commands mount,
      // and leaves what psilink writes owned by the partner, so it leads; the
      // single-folder chown follows it as the fallback.
      expect(text.indexOf(USER_FLAG)).toBeLessThan(text.indexOf(CHOWN));
      // Giving a folder away to another uid is privileged: the unprivileged
      // form succeeds only for a partner already numbered 1000, who did not
      // need it, and the sheet names the symptom the others will see.
      expect(text).toContain(`sudo ${CHOWN}`);
      expect(text).toContain("Operation not permitted");
      // 1000 is a uid, and on a shared machine it may be another person's:
      // the fallback hands them the folder and everything psilink writes in
      // it, so the sheet says whose folder it becomes before the reader runs
      // the command.
      const consequence = text.split(`sudo ${CHOWN}`)[1];
      expect(consequence).toContain("a number, not a name");
      expect(consequence).toContain("share with other people");
    }
  });

  test("the identity the accept command needs is outside the skippable section", () => {
    // psilink names a party only from what the operator gives it, so every
    // reader's accept stops without the flag -- not only the Docker Engine
    // reader who takes --user. The engine section below is one a whole reader
    // class is told to skip, so the guidance sits ahead of it and ahead of the
    // first command it qualifies.
    for (const endpoint of [FILEDROP, SFTP]) {
      const text = sheet(endpoint);
      const flag = text.indexOf('--identity "YOUR NAME, YOUR ORGANIZATION"');
      expect(flag).toBeGreaterThan(-1);
      expect(flag).toBeLessThan(text.indexOf("WHICH DOCKER DO YOU HAVE?"));
      expect(flag).toBeLessThan(text.indexOf("docker run"));
      const section = text
        .split("THE NAME YOUR PARTNER SEES")[1]
        .split("WHICH DOCKER DO YOU HAVE?")[0];
      expect(section).toContain("what your partner reads as who");
      expect(section).toContain("accepting stops and asks");
    }
  });

  test("the identity is scoped to the accept command, not the exchange run", () => {
    // The exchange steps take the label from the psilink.yaml the accept step
    // wrote, so an instruction to add the flag to every command on the sheet
    // would send the reader to type one where it is not needed -- and be treated
    // as a refusal the exchange run does not make.
    for (const endpoint of [FILEDROP, SFTP]) {
      const section = sheet(endpoint)
        .split("THE NAME YOUR PARTNER SEES")[1]
        .split("WHICH DOCKER DO YOU HAVE?")[0];
      expect(section).toContain("the end of the accept");
      expect(section).toContain("psilink.yaml");
      expect(section).toContain("needs no flag");
      expect(section).not.toContain("every psilink");
    }
  });

  test("no copy-pasteable command has a pre-filled identity", () => {
    // An unreplaced placeholder inside a command the reader pastes whole would
    // ship as this party's name. The flag travels as its own line instead, and
    // the value is shouted so an unreplaced one is unmistakable on both sides.
    for (const endpoint of [FILEDROP, SFTP])
      for (const line of sheet(endpoint).split("\n"))
        if (line.includes("docker run")) expect(line).not.toContain("identity");
  });

  test("the flag's scope names the second folder each channel mounts", () => {
    // Every command has two mounts, and the chown fallback reaches only
    // the first: the flag is what covers the shared folder (/sync) and the
    // credential folder (/run/secrets) as well as the CSV folder (/work).
    const scope = (endpoint: AcceptKitEndpoint): string =>
      sheet(endpoint).split(USER_FLAG)[1].split("sudo chown")[0];
    expect(scope(FILEDROP)).toContain("CSV file");
    expect(scope(FILEDROP)).toContain("shared");
    expect(scope(SFTP)).toContain("CSV file");
    expect(scope(SFTP)).toContain("password file");
    // The chown fallback says so itself rather than leaving the reader to
    // discover the second mount when it fails.
    for (const endpoint of [FILEDROP, SFTP])
      expect(sheet(endpoint)).toContain("only the folder");
  });

  test("sends the chown reader to their own folder, not the shared one", () => {
    // A folder-relative command given before the sheet has named a folder is
    // how a filedrop partner ends up chowning the shared folder -- the one
    // folder the sheet keeps their psilink files out of.
    const fallback = (endpoint: AcceptKitEndpoint): string =>
      sheet(endpoint)
        .split("If you cannot change the commands")[1]
        .split("sudo chown")[0];
    expect(fallback(FILEDROP)).toContain("holds your CSV");
    expect(fallback(FILEDROP)).toContain("never the shared one");
    expect(fallback(SFTP)).toContain("holds your CSV");
    // An SFTP partner has no shared folder, so the warning is not on that sheet.
    expect(fallback(SFTP)).not.toContain("shared");
  });
});

describe("accept kit, filedrop routing", () => {
  test("offers the network-drive/DFS launcher branch", () => {
    const text = sheet(FILEDROP);
    expect(text).toContain("A. A Windows network drive or a DFS path");
    expect(text).toContain(RELEASES_URL);
    expect(text).toContain("Start-Psilink.ps1");
    expect(text).toContain("Setup-PsilinkFileDrop.ps1");
    // The launcher branch is Windows-only: the shell launcher does no share
    // resolution, so a macOS/Linux partner is routed to mount-then-B instead.
    expect(text).not.toContain("start-psilink.sh");
    expect(text).toContain("it is situation B below");
    // Why the files are readable rather than opaque, for the partner's IT.
    expect(text).toContain("plaintext PowerShell scripts");
    expect(text).toContain("review every line");
  });

  test("offers the Docker-visible-folder branch with both commands", () => {
    const text = sheet(FILEDROP);
    expect(text).toContain("B. A folder that syncs on this PC");
    expect(text).toContain(
      `docker run --rm -it -v "$PWD":/work docker.io/vdorie/psi-link:1.4.2 ` +
        `accept ${INVITATION_PLACEHOLDER} your-file.csv`,
    );
    expect(text).toContain(
      'docker run --rm -v "$PWD":/work -v "/path/to/your/shared/folder":' +
        "/sync docker.io/vdorie/psi-link:1.4.2 exchange your-file.csv " +
        "results.csv",
    );
  });
});

describe("accept kit, sftp configuration section", () => {
  test("names the placeholder field, the credential, and the @ convention", () => {
    const text = sheet(SFTP);
    expect(text).toContain(
      `docker run --rm -it -v "$PWD":/work docker.io/vdorie/psi-link:1.4.2 ` +
        `accept ${INVITATION_PLACEHOLDER} your-file.csv`,
    );
    // The exchange command has the read-only secrets mount, and the
    // credential fill-in section precedes it: the sheet is read top to bottom.
    expect(text).toContain(
      'docker run --rm -it -v "$PWD":/work -v "/your/secrets":/run/secrets:ro ' +
        "docker.io/vdorie/psi-link:1.4.2 exchange your-file.csv results.csv",
    );
    expect(text.indexOf("username: REPLACE_WITH_SSH_USERNAME")).toBeLessThan(
      text.indexOf("exchange your-file.csv"),
    );
    expect(text).toContain("username: REPLACE_WITH_SSH_USERNAME");
    expect(text).toContain("password (or private_key)");
    expect(text).toContain("password: '@/run/secrets/sftp-password'");
    expect(text).toContain("A value beginning with @ is read from that file");
    // The credential is the partner's to supply; the sheet claims only what
    // psilink enforces -- no transmission to the partner -- not what the
    // counterparty might separately know.
    expect(text).toContain("never carries credentials");
    expect(text).toContain("never sends either one to your partner");
  });

  test("keeps the key-file permission note to one sentence", () => {
    const keyFileNote = sheet(SFTP)
      .split("KEEPING THE KEY FILE")[1]
      .split("IF SOMETHING GOES WRONG")[0]
      .trim();
    expect(keyFileNote).toContain("chmod 600");
    // One sentence: exactly one sentence-ending period (the dots inside
    // .psilink.key are followed by a letter, not a break).
    expect(keyFileNote.match(/\.(\s|$)/g)).toHaveLength(1);
  });
});

describe("accept kit, release version", () => {
  /** Every image the sheet's commands name, in order. */
  function imageReferences(text: string): Array<string> {
    return text.match(/docker\.io\/vdorie\/psi-link\S*/g) ?? [];
  }

  test("a build with a version names it in every image reference", () => {
    for (const endpoint of [FILEDROP, SFTP]) {
      const text = sheet(endpoint, "0.9.1");
      // Every reference has the version; none is left bare or floating.
      const references = imageReferences(text);
      expect(references.length).toBeGreaterThan(0);
      for (const reference of references)
        expect(reference).toBe("docker.io/vdorie/psi-link:0.9.1");
    }
  });

  test("a build with no version names the floating tag", () => {
    for (const endpoint of [FILEDROP, SFTP]) {
      const references = imageReferences(
        buildAcceptKit({
          endpoint,
          retainFiles: false,
          locklessRendezvous: false,
        }),
      );
      expect(references.length).toBeGreaterThan(0);
      for (const reference of references)
        expect(reference).toBe("docker.io/vdorie/psi-link:latest");
    }
  });

  test("a version in any shape but a release version falls back to the floating tag", () => {
    // An empty, partial, placeholder, or malformed value names the floating
    // tag rather than reaching the sheet: no image reference is left empty,
    // truncated, or naming a tag no release published.
    for (const version of [
      "",
      "undefined",
      "0.0.0",
      "0.0.0-rc.1",
      "1.4",
      "v1.4.2",
      "X.Y.Z",
      "1.4.2 ",
      "1.4.2/../evil",
    ]) {
      const references = imageReferences(sheet(FILEDROP, version));
      expect(references.length).toBeGreaterThan(0);
      for (const reference of references)
        expect(reference).toBe("docker.io/vdorie/psi-link:latest");
    }
  });

  test("the release link follows the same value the tag does", () => {
    // The launcher branch sends the partner to a release page: this build's own
    // release when it has a version, so the launchers they download match
    // the image the sheet names, and the index otherwise.
    expect(sheet(FILEDROP, "0.9.1")).toContain(`${RELEASES_URL}/tag/v0.9.1\n`);
    const unversioned = buildAcceptKit({
      endpoint: FILEDROP,
      retainFiles: false,
      locklessRendezvous: false,
    });
    expect(unversioned).toContain(`${RELEASES_URL}\n`);
    expect(unversioned).not.toContain(`${RELEASES_URL}/tag/`);
    expect(sheet(FILEDROP, "X.Y.Z")).not.toContain(`${RELEASES_URL}/tag/`);
  });
});

describe("accept kit, printable-ASCII enforcement", () => {
  test("a locator with control and non-ASCII bytes renders as printable ASCII", () => {
    // The invariant is enforced at the interpolation point, not assumed of
    // the console's inputs: the only free-text fields the sheet interpolates
    // are the operator-authored host and path.
    const text = sheet({
      channel: "sftp",
      host: "héllo\nexample.gov",
      path: "/drops/psi–link",
    });
    expect(text).toContain("SFTP server:    h?llo?example.gov");
    expect(text).toContain("Directory:      /drops?/psi?link");
    // The build's version is the other representable input; it is interpolated
    // only in the release shape, so a value with non-ASCII bytes reaches
    // neither the image reference nor the release link, and the sheet it
    // produces is printable ASCII like any other.
    const hostileVersion = sheet(
      { channel: "filedrop", path: "psilink" },
      "1.0.0-é\nX",
    );
    expect(hostileVersion).toContain("docker.io/vdorie/psi-link:latest");
    expect(hostileVersion).toMatch(/^[\x20-\x7e\n]*$/);
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      expect(code === 10 || (code >= 32 && code <= 126)).toBe(true);
    }

    // The split-directory pair interpolates two more free-text fields, held to
    // the same contract.
    const splitText = sheet({
      channel: "sftp",
      host: "sftp.example.gov",
      inboundPath: "héllo\nfrom-partner",
      outboundPath: "/exchange/psi–link",
    });
    expect(splitText).toContain("You write to:   h?llo?from-partner");
    expect(splitText).toContain("You read from:  /exchange/psi?link");
    for (const ch of splitText) {
      const code = ch.charCodeAt(0);
      expect(code === 10 || (code >= 32 && code <= 126)).toBe(true);
    }
  });
});

describe("accept kit, a split filedrop rendezvous", () => {
  test("names both folders by what the READER does with each", () => {
    // The endpoint states the pair from the INVITER's side, which is the direction
    // the partner's own tool mirrors: the inviter's inbound is where the reader
    // WRITES, and the inviter's outbound is where the reader READS.
    const text = sheet(FILEDROP_SPLIT);
    expect(text).toContain("You write to:   to-clinic");
    expect(text).toContain("You read from:  from-clinic");
    expect(text).toContain("two folders you and your partner can both reach");
    // The single-shared-folder wording never crosses onto it.
    expect(text).not.toContain("Shared folder:");
  });

  test("describes two folders even where it can name neither", () => {
    // The SHAPE is not the names: a split rendezvous the console cannot name still
    // has to be set up as two folders, so the sheet must not fall back to the
    // single-shared-folder body.
    const text = sheet(UNNAMED_FILEDROP_SPLIT);
    expect(text).toContain("two folders rather than one");
    expect(text).toContain(
      "Use the two folders you and your partner agreed on.",
    );
    expect(text).not.toContain("Shared folder:");
    expect(text).not.toContain("path: /sync\n");
  });

  test("directs a two-mount run, and says the launcher route cannot serve it", () => {
    const text = retainSheet(FILEDROP_SPLIT);
    expect(text).toContain("inbound_path: /sync-in");
    expect(text).toContain("outbound_path: /sync-out");
    expect(text).toContain('-v "/path/to/the/folder/you/read":/sync-in');
    expect(text).toContain('-v "/path/to/the/folder/you/write":/sync-out');
    // The PowerShell launchers provision one rendezvous folder, so route A is
    // accurate about not serving this exchange rather than sending the reader to a
    // console that cannot run it.
    expect(text).toContain("cover a single shared");
    expect(text).toContain("cannot start this one");
    // The single-folder route's own mount never appears.
    expect(text).not.toContain('":/sync ');
  });

  test("states what a split retain-mode run leaves in both folders", () => {
    const text = retainSheet(FILEDROP_SPLIT);
    expect(text).toContain("THIS EXCHANGE KEEPS ITS FILES");
    expect(text).toContain(
      "The files stay in both folders above -- the one you write into and",
    );
    expect(text).toContain("both folders\nmust start empty on both sides");
    // The single-folder wording never crosses over.
    expect(text).not.toContain(
      "The files stay in the shared folder the two of you meet in",
    );
  });

  test("holds both folder names to the printable-ASCII contract", () => {
    const text = sheet({
      channel: "filedrop",
      split: true,
      inboundPath: "h\u00e9llo\nto-clinic",
      outboundPath: "from\u2013clinic",
    });
    expect(text).toContain("You write to:   h?llo?to-clinic");
    expect(text).toContain("You read from:  from?clinic");
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      expect(code === 10 || (code >= 32 && code <= 126)).toBe(true);
    }
  });
});

describe("accept kit, retain mode", () => {
  const RETAIN_HEADING = "THIS EXCHANGE KEEPS ITS FILES";
  const RETAIN_FLAG = "--retain-files";

  /** The lines the retain-on sheet has that the retain-off sheet does
   * not: the whole retain contribution. */
  function retainDelta(
    endpoint: AcceptKitEndpoint,
    version = "1.4.2",
  ): Array<string> {
    return addedLines(sheet(endpoint, version), retainSheet(endpoint, version));
  }

  test("states what the exchange keeps and where it persists, per channel", () => {
    const sftpText = retainSheet(SFTP);
    expect(sftpText).toContain(RETAIN_HEADING);
    expect(sftpText).toContain("permanent transcript");
    // Where, in that channel's own terms -- the directory on the server the
    // locator above already named, not a second copy of the locator.
    expect(sftpText).toContain(
      "The files stay in the directory the two of you meet in, on the SFTP",
    );
    expect(sftpText).toContain("server named above");
    expect(sftpText).toContain("start from an empty directory");
    // The split wording never crosses onto the single-path sheet.
    expect(sftpText).not.toContain("both directories");

    const splitText = retainSheet(SFTP_SPLIT);
    expect(splitText).toContain(RETAIN_HEADING);
    expect(splitText).toContain("permanent transcript");
    // A split exchange leaves the transcript in BOTH named directories, so
    // the disclosure names both directories' obligations rather than the
    // single-directory wording above.
    expect(splitText).toContain(
      "The files stay in both directories above -- the one you write to",
    );
    expect(splitText).toContain("and the one you read from");
    expect(splitText).toContain("server named above");
    expect(splitText).toContain("both directories\nmust start empty");
    // The single-path wording never crosses over onto the split sheet.
    expect(splitText).not.toContain(
      "The files stay in the directory the two of you meet in",
    );
    expect(splitText).not.toContain("start from an empty directory");

    for (const endpoint of [FILEDROP, UNNAMED_FILEDROP]) {
      const text = retainSheet(endpoint);
      expect(text).toContain(RETAIN_HEADING);
      expect(text).toContain("permanent transcript");
      expect(text).toContain(
        "The files stay in the shared folder the two of you meet in",
      );
      expect(text).toContain("start from an empty shared folder");
      // The SFTP wording never crosses over.
      expect(text).not.toContain("on the SFTP");
    }
  });

  test("discloses that the rendezvous files persist in plaintext", () => {
    // The message bodies are ciphertext, but the control files the two sides
    // meet through are not, and retain mode leaves them in place: a partner
    // told only "keeps every file" would not know what an eventual reader of
    // that location learns.
    for (const endpoint of ENDPOINTS) {
      const text = retainSheet(endpoint);
      expect(text).toContain("they are plaintext and they persist");
      expect(text).toContain("that an exchange");
      expect(text).toContain("the name each side ran under");
      expect(text).toContain("the settings each side\nannounced");
      // And the reassurance that bounds it, so the disclosure is not treated as
      // the input file being left behind.
      expect(text).toContain("Nothing there is your CSV file");
    }
  });

  test("says the agreement is bilateral and non-negotiated", () => {
    for (const endpoint of ENDPOINTS) {
      const text = retainSheet(endpoint);
      expect(text).toContain("an agreement, not a negotiation");
      expect(text).toContain("your side must run it");
    }
  });

  test("has the flag on the exchange command, never on accept", () => {
    for (const endpoint of ENDPOINTS) {
      const text = retainSheet(endpoint);
      // One flag, not three: the CLI resolves what retain mode implies, so the
      // sheet cannot drift from it by re-deriving the trio.
      expect(text).toContain(`exchange ${RETAIN_FLAG} your-file.csv`);
      expect(text).not.toContain("--timestamp-in-filename");
      expect(text).not.toContain("--lockless-rendezvous");
      // Accepting writes the config and needs nothing from retain mode; the
      // flag belongs to the run.
      expect(text).not.toContain(`accept ${RETAIN_FLAG}`);
      expect(text).toContain(`accept ${INVITATION_PLACEHOLDER} your-file.csv`);
      // And the command is explained where the reader meets it.
      expect(text).toContain("is your half of the agreement above");
    }
  });

  test("routes the launcher branch to the console control instead", () => {
    // Situation A never runs the commands on the sheet: it hands the partner
    // to the console's accept flow, so the same agreement has to be named
    // there or that route rendezvouses into a mismatch.
    const text = retainSheet(FILEDROP);
    const launcher = text
      .split("done -- the rest of this sheet is for situation B")[1]
      .split("B -- A FOLDER DOCKER CAN OPEN")[0];
    expect(launcher).toContain('open "How files are handled"');
    expect(launcher).toContain('turn on "Keep every exchange file"');
    // An SFTP partner has no launcher branch, so the console instruction is
    // not on that sheet.
    expect(retainSheet(SFTP)).not.toContain("Keep every exchange file");
  });

  test("leaves the sheet untouched when retain mode is off", () => {
    for (const endpoint of ENDPOINTS) {
      const text = sheet(endpoint);
      for (const marker of [
        RETAIN_HEADING,
        RETAIN_FLAG,
        "retain mode",
        "Keep every exchange file",
        "permanent transcript",
      ])
        expect(text).not.toContain(marker);
    }
  });

  test("turning retain on adds lines and rewrites only the exchange command", () => {
    // The retain-off sheet is the retain-on sheet minus insertions, save for
    // the one command line that gains the flag: nothing else is reworded, so
    // the default sheet cannot drift as the retain copy is edited.
    for (const endpoint of ENDPOINTS)
      expect(addedLines(retainSheet(endpoint), sheet(endpoint))).toEqual([
        plainExchangeCommand(endpoint),
      ]);
  });

  test("the retain disclosure is fixed text, not a third dynamic value", () => {
    // The sheet admits exactly two dynamic values (the locator and the release
    // version). Retain mode selects fixed paragraphs, so a hostile locator
    // changes nothing about what it contributes -- the delta is identical.
    const benign = retainDelta(SFTP);
    const hostile = retainDelta({
      channel: "sftp",
      host: "héllo\nexample.gov",
      path: "/drops/psi–link",
    });
    expect(hostile).toEqual(benign);
    expect(retainDelta(UNNAMED_FILEDROP)).toEqual(retainDelta(FILEDROP));

    // The version reaches the delta only where it already reached the sheet:
    // the image reference on the rewritten command line, and nowhere else.
    const other = retainDelta(SFTP, "0.9.1");
    const withoutImage = (lines: Array<string>): Array<string> =>
      lines.filter((line) => !line.includes("docker.io/vdorie/psi-link"));
    expect(withoutImage(other)).toEqual(withoutImage(benign));
    expect(benign.filter((line) => line.includes("1.4.2"))).toHaveLength(1);
    // And nothing the delta adds has either dynamic value.
    for (const line of withoutImage(benign)) {
      expect(line).not.toContain("sftp.example.gov");
      expect(line).not.toContain("/drops/psilink");
      expect(line).not.toContain("1.4.2");
    }
  });

  test("a retain sheet is printable ASCII with a trailing newline", () => {
    for (const endpoint of ENDPOINTS) {
      const text = retainSheet(endpoint);
      expect(text).toMatch(/^[\x20-\x7e\n]*$/);
      expect(text.endsWith("\n")).toBe(true);
    }
  });
});

describe("accept kit, lockless rendezvous", () => {
  const LOCKLESS_FLAG = "--lockless-rendezvous";

  /** The lines the lockless sheet has that the default sheet does not:
   * the whole contribution of the setting. */
  function locklessDelta(
    endpoint: AcceptKitEndpoint,
    version = "1.4.2",
  ): Array<string> {
    return addedLines(
      sheet(endpoint, version),
      locklessSheet(endpoint, version),
    );
  }

  test("has the flag on the exchange command, never on accept", () => {
    for (const endpoint of ENDPOINTS) {
      const text = locklessSheet(endpoint);
      expect(text).toContain(`exchange ${LOCKLESS_FLAG} your-file.csv`);
      // The setting stands alone here: it is the operator's own, not retain
      // mode's implication, so none of retain's material reaches the sheet.
      expect(text).not.toContain("--retain-files");
      expect(text).not.toContain("--timestamp-in-filename");
      expect(text).not.toContain("THIS EXCHANGE KEEPS ITS FILES");
      // Accepting writes the config and meets nobody; the flag belongs to the
      // run, which is where the two sides rendezvous.
      expect(text).not.toContain(`accept ${LOCKLESS_FLAG}`);
      expect(text).toContain(`accept ${INVITATION_PLACEHOLDER} your-file.csv`);
      // And the flag is explained where the reader meets it, so a partner
      // trimming the command keeps the half of the agreement that is theirs.
      expect(text).toContain("is your half of a setting your partner turned");
      expect(text).toContain("an agreement, not a negotiation");
    }
  });

  test("routes the launcher branch to the console control instead", () => {
    // Situation A never runs the commands on the sheet: it hands the partner
    // to the console's accept flow, so the setting has to be named as the
    // control that sets it there or that route stops at rendezvous.
    const launcher = locklessSheet(FILEDROP)
      .split("done -- the rest of this sheet is for situation B")[1]
      .split("B -- A FOLDER DOCKER CAN OPEN")[0];
    expect(launcher).toContain('open "How files are handled"');
    expect(launcher).toContain('set "Lockless rendezvous" to On');
    // An SFTP partner has no launcher branch, so the console instruction is
    // not on that sheet.
    expect(locklessSheet(SFTP)).not.toContain("Lockless rendezvous");
  });

  test("retain mode includes it, so the flag never doubles up", () => {
    // Retain mode implies the lockless rendezvous and the CLI resolves that
    // implication: the sheet states the one operator-visible flag, and a retain
    // sheet is byte-identical however the rendezvous setting resolved.
    for (const endpoint of ENDPOINTS) {
      const text = retainSheet(endpoint);
      expect(text).toBe(
        buildAcceptKit({
          endpoint,
          retainFiles: true,
          locklessRendezvous: false,
          version: "1.4.2",
        }),
      );
      expect(text).not.toContain(LOCKLESS_FLAG);
    }
  });

  test("leaves the sheet untouched when the rendezvous is left at its default", () => {
    for (const endpoint of ENDPOINTS) {
      const text = sheet(endpoint);
      for (const marker of [
        LOCKLESS_FLAG,
        "Lockless rendezvous",
        "acknowledgement",
        "lock file",
      ])
        expect(text).not.toContain(marker);
    }
  });

  test("turning it on adds lines and rewrites only the exchange command", () => {
    // The default sheet is the lockless sheet minus insertions, save for the
    // one command line that gains the flag: nothing else is reworded, so the
    // default sheet cannot drift as this copy is edited.
    for (const endpoint of ENDPOINTS)
      expect(addedLines(locklessSheet(endpoint), sheet(endpoint))).toEqual([
        plainExchangeCommand(endpoint),
      ]);
  });

  test("the addition is fixed text, not a third dynamic value", () => {
    // The sheet admits exactly two dynamic values (the locator and the release
    // version). The setting selects fixed text, so a hostile locator changes
    // nothing about what it contributes -- the delta is identical.
    const benign = locklessDelta(SFTP);
    const hostile = locklessDelta({
      channel: "sftp",
      host: "héllo\nexample.gov",
      path: "/drops/psi–link",
    });
    expect(hostile).toEqual(benign);
    expect(locklessDelta(UNNAMED_FILEDROP)).toEqual(locklessDelta(FILEDROP));

    // The version reaches the delta only where it already reached the sheet:
    // the image reference on the rewritten command line, and nowhere else.
    const other = locklessDelta(SFTP, "0.9.1");
    const withoutImage = (lines: Array<string>): Array<string> =>
      lines.filter((line) => !line.includes("docker.io/vdorie/psi-link"));
    expect(withoutImage(other)).toEqual(withoutImage(benign));
    expect(benign.filter((line) => line.includes("1.4.2"))).toHaveLength(1);
    for (const line of withoutImage(benign)) {
      expect(line).not.toContain("sftp.example.gov");
      expect(line).not.toContain("/drops/psilink");
      expect(line).not.toContain("1.4.2");
    }
  });

  test("a lockless sheet is printable ASCII with a trailing newline", () => {
    for (const endpoint of ENDPOINTS) {
      const text = locklessSheet(endpoint);
      expect(text).toMatch(/^[\x20-\x7e\n]*$/);
      expect(text.endsWith("\n")).toBe(true);
    }
  });
});

describe("accept kit invariants", () => {
  const location: InvitationLocation = {
    origin: "https://example.org:8443",
    hostname: "example.org",
    port: "8443",
  };
  const CSV =
    "ssn,ssn4,first_name,last_name,dob\n123456789,6789,Alice,Smith,1990-01-02\n";

  test("has the paste placeholder and no invitation token or secret", async () => {
    // Mint through the real invitation flow, then build the kit from the same
    // locator that mint held, exactly as the console does.
    const endpoint = { channel: "filedrop" as const, path: "psilink" };
    const minted = await generateInvitation({
      inviterName: "County Health Dept",
      file: Readable.from(CSV),
      location,
      connectionEndpoint: endpoint,
    });
    const text = buildAcceptKit({
      endpoint,
      retainFiles: false,
      locklessRendezvous: false,
      version: "1.4.2",
    });

    expect(text).toContain(INVITATION_PLACEHOLDER);
    expect(text).not.toContain(minted.sharedSecret);
    expect(text).not.toContain(minted.encoded);
    expect(text).not.toContain(minted.deepLink);
    // Nor the inviter's own identity, which is the token's to disclose.
    expect(text).not.toContain("County Health Dept");
  });

  test("has the shared folder's name, never the console path behind it", () => {
    // The name the console minted into the token, standing for the mount
    // /data/exchanges/agency-a-agency-b behind it.
    const text = sheet({ channel: "filedrop", path: "agency-a-agency-b" });
    expect(text).toContain("Shared folder:  agency-a-agency-b");
    expect(text).not.toContain("/data/exchanges/agency-a-agency-b");
    expect(text).not.toContain("/data/exchanges");
  });

  test("has no container path from the inviter's console", () => {
    // The only container paths the sheet names are the partner's own future
    // mount points in the commands it gives them.
    for (const endpoint of [FILEDROP, SFTP]) {
      const text = sheet(endpoint);
      expect(text).not.toContain("/data");
      expect(text).not.toContain("/app");
      expect(text).not.toContain("psilink.yaml.tmp");
      // The mount points the partner types are present and fixed.
      expect(text).toContain('-v "$PWD":/work');
    }
  });

  test("is printable ASCII with a trailing newline", () => {
    for (const endpoint of [FILEDROP, SFTP]) {
      const text = sheet(endpoint);
      expect(text).toMatch(/^[\x20-\x7e\n]*$/);
      expect(text.endsWith("\n")).toBe(true);
    }
  });
});

describe("accept kit filename", () => {
  test("stamps the local calendar day of the download click", () => {
    expect(acceptKitFileName(new Date(2026, 1, 3, 9, 30))).toBe(
      "psilink-accept-instructions-2026-02-03.txt",
    );
  });
});
