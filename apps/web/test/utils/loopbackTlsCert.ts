import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** A throwaway key pair for a loopback test server, trusted by nobody: clients
 * dial it with `rejectUnauthorized: false`. */
export interface LoopbackTlsCert {
  key: string;
  cert: string;
}

/**
 * A self-signed `localhost` certificate for this environment's test HTTPS
 * servers, or `null` where none can be minted -- which a suite needing one skips
 * on rather than reporting the environment as a failure of the code under test.
 * Node has no certificate-issuing API, so minting shells out to `openssl`, making
 * the binary a property of the environment: Windows is left out (it is not a
 * given there, and these suites do not run on it in CI), a minimal container may
 * ship none, and a LibreSSL `openssl` takes the flags below differently.
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
