import type { SftpTestServer } from "./types";
import { startInProcessSftpServer } from "./inProcessServer";
import {
  NATIVE_PROFILES,
  type NativeProfile,
  startNativeSshdServer,
} from "./nativeSshdServer";

export * from "./types";
export { startInProcessSftpServer } from "./inProcessServer";
export {
  NATIVE_PROFILES,
  type NativeProfile,
  startNativeSshdServer,
} from "./nativeSshdServer";

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

/**
 * The hardened configuration the native backend runs, from
 * PSILINK_SFTP_NATIVE_PROFILE. Unset selects `baseline` (the unchanged Phase-1
 * config). Only meaningful when the native backend is selected; the in-process
 * backend ignores it. Conformance tests read it to gate profile-specific
 * assertions (e.g. the allowlist wrong-user rejection).
 */
export function selectedNativeProfile(): NativeProfile {
  const raw = process.env.PSILINK_SFTP_NATIVE_PROFILE;
  if (raw === undefined || raw === "") return "baseline";
  if ((NATIVE_PROFILES as readonly string[]).includes(raw))
    return raw as NativeProfile;
  throw new Error(
    `Unknown PSILINK_SFTP_NATIVE_PROFILE "${raw}" ` +
      `(expected one of ${NATIVE_PROFILES.join(", ")}).`,
  );
}

/** Start the backend PSILINK_SFTP_BACKEND selects. */
export async function startSelectedSftpServer(): Promise<SftpTestServer> {
  return selectedBackend() === "native"
    ? startNativeSshdServer({ profile: selectedNativeProfile() })
    : startInProcessSftpServer();
}
