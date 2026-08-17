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
 * Mint a self-signed `localhost` certificate for a test HTTPS server. Node has
 * no certificate-issuing API, so this shells out to `openssl` (an EC key keeps
 * it to milliseconds); callers skip on `win32`, where openssl is not a given and
 * where this suite does not run in CI.
 */
export function createLoopbackTlsCert(): LoopbackTlsCert {
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
