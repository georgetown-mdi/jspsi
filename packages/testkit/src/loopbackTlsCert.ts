import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** A throwaway key pair for a loopback test server. */
export interface LoopbackTlsCert {
  key: string;
  cert: string;
}

/**
 * A self-signed certificate for this environment's loopback test servers, or
 * `null` where none can be minted -- which a suite needing one skips on rather
 * than reporting the environment as a failure of the code under test.
 *
 * Node has no certificate-issuing API, so minting shells out to `openssl`,
 * making the binary a property of the environment: Windows is left out (it is
 * not a given there, and these suites do not run on it in CI), a minimal
 * container may ship none, and a LibreSSL `openssl` takes the flags below
 * differently.
 *
 * `null` here is a prerequisite the environment did not supply. What that costs
 * is the caller's to declare -- `apps/web/test/requireTestPrerequisites.ts` for
 * the web signaling suites, the leg's own gate for the CLI's live one-command
 * acceptance -- so the run names what it lost and fails where the environment
 * was supposed to supply it.
 *
 * The certificate carries both loopback names in its subject alternative name,
 * so it serves a client that dials `localhost` and one that dials `127.0.0.1`
 * with verification on and no dependence on how the name resolves.
 */
export const loopbackTlsCert: LoopbackTlsCert | null =
  process.platform === "win32" ? null : mintLoopbackTlsCert();

/**
 * The credentials, for a caller that has already arranged to skip without them.
 */
export function requireLoopbackTlsCert(): LoopbackTlsCert {
  if (loopbackTlsCert === null) {
    throw new Error("no loopback TLS certificate could be minted here");
  }
  return loopbackTlsCert;
}

function mintLoopbackTlsCert(): LoopbackTlsCert | null {
  const dir = mkdtempSync(join(tmpdir(), "psilink-loopback-tls-"));
  try {
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
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-days",
        "1",
        "-nodes",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "pipe" },
    );
    return {
      key: readFileSync(join(dir, "key.pem"), "utf8"),
      cert: readFileSync(join(dir, "cert.pem"), "utf8"),
    };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
