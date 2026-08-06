import { Readable } from "node:stream";

import { describe, expect, test } from "vitest";

import {
  INVITATION_PLACEHOLDER,
  acceptKitFileName,
  buildAcceptKit,
} from "@bench/acceptKit";
import { generateInvitation } from "@psi/invitation";
import { rendezvousLocatorName } from "@bench/inviterModel";

import type { AcceptKitEndpoint } from "@bench/acceptKit";
import type { InvitationLocation } from "@psi/invitation";

const FILEDROP: AcceptKitEndpoint = { channel: "filedrop", path: "psilink" };
const SFTP: AcceptKitEndpoint = {
  channel: "sftp",
  host: "sftp.example.gov",
  port: 2222,
  path: "/drops/psilink",
};

function sheet(endpoint: AcceptKitEndpoint, version = "1.4.2"): string {
  return buildAcceptKit({ endpoint, version });
}

/** The launcher branch's tell: the release page the three files come from. */
const RELEASES_URL = "https://github.com/georgetown-mdi/jspsi/releases";

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
  test("gives the Linux ownership step, on both channels, before any command", () => {
    for (const endpoint of [FILEDROP, SFTP]) {
      const text = sheet(endpoint);
      // The image runs as uid 1000, so a bind-mounted folder owned by anyone
      // else is unwritable and the partner's accept fails on its first write.
      expect(text).toContain("numbered 1000");
      expect(text).toContain("chown 1000:1000 .");
      // The alternative, for a partner who cannot change the owner.
      expect(text).toContain('--user "$(id -u):$(id -g)"');
      // Docker Desktop is what the sheet assumes and asks nothing of the
      // partner, so the step must not read as required everywhere.
      expect(text).toContain("Docker Desktop on Windows and macOS needs");
      // It qualifies every command on the sheet, so it comes before the first.
      expect(text.indexOf("chown 1000:1000 .")).toBeLessThan(
        text.indexOf("docker run"),
      );
    }
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
    // The exchange command carries the read-only secrets mount, and the
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

  test("a build carrying a version names it in every image reference", () => {
    for (const endpoint of [FILEDROP, SFTP]) {
      const text = sheet(endpoint, "0.9.1");
      // Every reference carries the version; none is left bare or floating.
      const references = imageReferences(text);
      expect(references.length).toBeGreaterThan(0);
      for (const reference of references)
        expect(reference).toBe("docker.io/vdorie/psi-link:0.9.1");
    }
  });

  test("a build carrying no version names the floating tag", () => {
    for (const endpoint of [FILEDROP, SFTP]) {
      const references = imageReferences(buildAcceptKit({ endpoint }));
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
    // release when it carries a version, so the launchers they download match
    // the image the sheet names, and the index otherwise.
    expect(sheet(FILEDROP, "0.9.1")).toContain(`${RELEASES_URL}/tag/v0.9.1\n`);
    const unversioned = buildAcceptKit({ endpoint: FILEDROP });
    expect(unversioned).toContain(`${RELEASES_URL}\n`);
    expect(unversioned).not.toContain(`${RELEASES_URL}/tag/`);
    expect(sheet(FILEDROP, "X.Y.Z")).not.toContain(`${RELEASES_URL}/tag/`);
  });
});

describe("accept kit, printable-ASCII enforcement", () => {
  test("a locator carrying control and non-ASCII bytes renders as printable ASCII", () => {
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
    // only in the release shape, so a value carrying non-ASCII bytes reaches
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

  test("carries the paste placeholder and no invitation token or secret", async () => {
    // Mint through the real invitation flow, then build the kit from the same
    // locator that mint carried, exactly as the bench does.
    const endpoint = { channel: "filedrop" as const, path: "psilink" };
    const minted = await generateInvitation({
      inviterName: "County Health Dept",
      file: Readable.from(CSV),
      location,
      connectionEndpoint: endpoint,
    });
    const text = buildAcceptKit({ endpoint, version: "1.4.2" });

    expect(text).toContain(INVITATION_PLACEHOLDER);
    expect(text).not.toContain(minted.sharedSecret);
    expect(text).not.toContain(minted.encoded);
    expect(text).not.toContain(minted.deepLink);
    // Nor the inviter's own identity, which is the token's to disclose.
    expect(text).not.toContain("County Health Dept");
  });

  test("carries the shared folder's name, never the appliance path behind it", () => {
    const appliancePath = "/data/exchanges/agency-a-agency-b";
    const text = sheet({
      channel: "filedrop",
      path: rendezvousLocatorName(appliancePath),
    });
    expect(text).toContain("Shared folder:  agency-a-agency-b");
    expect(text).not.toContain(appliancePath);
    expect(text).not.toContain("/data/exchanges");
  });

  test("carries no container path from the inviter's appliance", () => {
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
