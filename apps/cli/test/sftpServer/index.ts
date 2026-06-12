import type { SftpTestServer } from "./types";
import { startInProcessSftpServer } from "./inProcessServer";
import { startNativeSshdServer } from "./nativeSshdServer";

export * from "./types";
export { startInProcessSftpServer } from "./inProcessServer";
export { startNativeSshdServer } from "./nativeSshdServer";

/** The test SFTP server backends the suite can run against. */
export type SftpBackendName = "in-process" | "native";

/**
 * The backend the suite runs against, from PSILINK_SFTP_BACKEND. Unset (or
 * "in-process") selects the in-process ssh2 server -- the fast default that can
 * be driven into adversarial states; "native" spawns a real OpenSSH sshd.
 */
export function selectedBackend(): SftpBackendName {
  const raw = process.env.PSILINK_SFTP_BACKEND;
  if (raw === undefined || raw === "" || raw === "in-process")
    return "in-process";
  if (raw === "native") return "native";
  throw new Error(
    `Unknown PSILINK_SFTP_BACKEND "${raw}" (expected "in-process" or "native").`,
  );
}

/** Start the backend PSILINK_SFTP_BACKEND selects. */
export async function startSelectedSftpServer(): Promise<SftpTestServer> {
  return selectedBackend() === "native"
    ? startNativeSshdServer()
    : startInProcessSftpServer();
}
