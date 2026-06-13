import fsp from "node:fs/promises";
import path from "node:path";

import { inject } from "vitest";

import type { SftpPartyCredentials, SftpServerHandle } from "./types";

declare module "vitest" {
  interface ProvidedContext {
    sftpServer: SftpServerHandle;
  }
}

/** The running test SFTP server, surfaced by the globalSetup over `provide`. */
export function sftpServer(): SftpServerHandle {
  return inject("sftpServer");
}

/** Remote path the client connects to for a served namespace. */
export function remotePath(srv: SftpServerHandle, namespace: string): string {
  return `${srv.remoteRoot}/${namespace}`;
}

/** Host filesystem path backing a served namespace (for planting and cleaning). */
export function localPath(srv: SftpServerHandle, namespace: string): string {
  return path.join(srv.backingDir, namespace);
}

/** Create (and return) the host directory backing a served namespace. */
export async function ensureNamespace(
  srv: SftpServerHandle,
  namespace: string,
): Promise<string> {
  const dir = localPath(srv, namespace);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/** Auth fields for a party, spread into a connection's `server` block. */
export interface ServerAuth {
  username: string;
  password?: string;
  privateKey?: string;
}

/**
 * The connection auth for a party using the backend's default method: password
 * where the backend offers it (the in-process default), otherwise the private
 * key (the native sshd backend, which authenticates by public key). The bulk of
 * the suite uses this so it runs unchanged on either backend.
 */
export function serverAuth(cred: SftpPartyCredentials): ServerAuth {
  if (cred.password !== undefined)
    return { username: cred.username, password: cred.password };
  if (cred.privateKey !== undefined)
    return { username: cred.username, privateKey: cred.privateKey };
  throw new Error("backend party has neither a password nor a private key");
}

/**
 * Explicit public-key connection auth for a party. Used by the dedicated
 * public-key leg, which is tagged in-process only; the in-process backend
 * surfaces a private key for both parties.
 */
export function publicKeyAuth(cred: SftpPartyCredentials): {
  username: string;
  privateKey: string;
} {
  if (cred.privateKey === undefined)
    throw new Error("backend party has no private key for public-key auth");
  return { username: cred.username, privateKey: cred.privateKey };
}
