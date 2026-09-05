import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";

import type { Server, SecureContext } from "node:tls";

/**
 * A loopback TLS listener that selects its certificate by the server name the
 * client sends, and the certificates it selects between.
 *
 * This is the shape a hosted signaling endpoint sitting behind a shared front
 * end has: one address, several names, and a certificate chosen per handshake
 * from the SNI extension. A client that sends no server name is served the
 * front's fallback certificate, which is valid for a name it did not dial -- so
 * a diagnostic dial that omits SNI where the real socket sends it answers about
 * a certificate the real socket never saw.
 *
 * The authorities here are minted for the run and trusted nowhere: a test that
 * needs one trusted installs it for its own duration
 * ({@link tls.setDefaultCACertificates}) and puts the process default back.
 */

/** A key and the certificate it belongs to, both PEM. */
export interface CertificatePair {
  key: string;
  cert: string;
}

/** The name the fixture's SNI context answers for. */
export const SNI_VHOST_NAME = "localhost";

/** The name the fixture's fallback certificate is valid for, and no other. */
export const SNI_VHOST_FALLBACK_NAME = "other.invalid";

/** The certificates a vhosted front selects between. */
export interface SniVhostCertificates {
  /** The single authority a test driving this fixture trusts. */
  trustedAuthority: string;
  /**
   * Served when the handshake names no host, or one the front does not know.
   * Valid for {@link SNI_VHOST_FALLBACK_NAME} only.
   */
  fallback: CertificatePair;
  /**
   * Served for {@link SNI_VHOST_NAME}, under {@link trustedAuthority}.
   */
  selected: CertificatePair;
  /**
   * Served for {@link SNI_VHOST_NAME}, under an authority nothing trusts: the
   * certificate failure a client that does send the name is entitled to see.
   */
  selectedUntrusted: CertificatePair;
}

/**
 * Mint the fixture's certificates, or `null` where `openssl` cannot supply
 * them -- which a suite needing them skips on, as it does for
 * `@psilink/testkit/loopbackTlsCert`, rather than reporting the environment as
 * a failure of the code under test.
 */
export function mintSniVhostCertificates(): SniVhostCertificates | null {
  const dir = mkdtempSync(join(tmpdir(), "psilink-sni-vhost-"));
  try {
    mintAuthority(dir, "trusted");
    mintAuthority(dir, "untrusted");
    return {
      trustedAuthority: readFileSync(join(dir, "trusted.crt"), "utf8"),
      fallback: mintLeaf(dir, "fallback", "trusted", [
        `DNS:${SNI_VHOST_FALLBACK_NAME}`,
      ]),
      selected: mintLeaf(dir, "selected", "trusted", [
        `DNS:${SNI_VHOST_NAME}`,
        "IP:127.0.0.1",
      ]),
      selectedUntrusted: mintLeaf(dir, "selected-untrusted", "untrusted", [
        `DNS:${SNI_VHOST_NAME}`,
        "IP:127.0.0.1",
      ]),
    };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function mintAuthority(dir: string, name: string): void {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-keyout",
      join(dir, `${name}.key`),
      "-out",
      join(dir, `${name}.crt`),
      "-days",
      "1",
      "-nodes",
      "-subj",
      `/CN=psilink test ${name} authority`,
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign",
    ],
    { stdio: "pipe" },
  );
}

function mintLeaf(
  dir: string,
  name: string,
  authority: string,
  subjectAltNames: Array<string>,
): CertificatePair {
  execFileSync(
    "openssl",
    [
      "req",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-keyout",
      join(dir, `${name}.key`),
      "-out",
      join(dir, `${name}.csr`),
      "-nodes",
      "-subj",
      `/CN=${name}`,
    ],
    { stdio: "pipe" },
  );
  writeFileSync(
    join(dir, `${name}.ext`),
    `subjectAltName=${subjectAltNames.join(",")}\n`,
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      join(dir, `${name}.csr`),
      "-CA",
      join(dir, `${authority}.crt`),
      "-CAkey",
      join(dir, `${authority}.key`),
      "-CAcreateserial",
      "-out",
      join(dir, `${name}.crt`),
      "-days",
      "1",
      "-extfile",
      join(dir, `${name}.ext`),
    ],
    { stdio: "pipe" },
  );
  return {
    key: readFileSync(join(dir, `${name}.key`), "utf8"),
    cert: readFileSync(join(dir, `${name}.crt`), "utf8"),
  };
}

/** A running vhosted front, and what it observed. */
export interface SniVhostListener {
  /** Loopback port the front is listening on. */
  port: number;
  /** Every server name a handshake sent, in arrival order. */
  serverNames: Array<string>;
  /** Close the listener. Idempotent. */
  stop: () => Promise<void>;
}

/**
 * Listen on a loopback port serving `selected` to a handshake that names
 * {@link SNI_VHOST_NAME} and `fallback` to one that names nothing else or
 * nothing at all, recording each name for a caller measuring what was sent.
 */
export async function startSniVhostListener(
  fallback: CertificatePair,
  selected: CertificatePair,
): Promise<SniVhostListener> {
  const selectedContext: SecureContext = tls.createSecureContext({
    key: selected.key,
    cert: selected.cert,
  });
  const serverNames: Array<string> = [];
  const server: Server = tls.createServer(
    {
      key: fallback.key,
      cert: fallback.cert,
      SNICallback: (servername, callback) => {
        serverNames.push(servername);
        callback(
          null,
          servername === SNI_VHOST_NAME ? selectedContext : undefined,
        );
      },
    },
    // A client that rejects the certificate resets the stream; the listener
    // stays up for the next handshake rather than raising it as its own error.
    (socket) => socket.on("error", () => {}),
  );
  server.on("error", () => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the vhosted listener did not bind a loopback port");
  }
  return {
    port: address.port,
    serverNames,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
