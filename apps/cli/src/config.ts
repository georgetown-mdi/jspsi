import fs from "node:fs";
import type { ExchangeSpec, LinkageTerms } from "@psilink/core";

export const readAtSignFile = (val: unknown): unknown => {
  if (typeof val === "string" && val.startsWith("@"))
    return fs.readFileSync(val.slice(1), "utf8").trim();
  return val;
};

export interface CliOverrides {
  /** Maps to identity (used when generating default linkage terms). */
  identity?: string;
  /** Maps to connection.authentication.pakeToken. */
  pakeToken?: string;
  /** Seconds to wait for peer; maps to connection.options.pollTimeoutMs. */
  timeout?: number;
  serverUsername?: string;
  serverPassword?: string;
  serverPrivateKey?: string;
  serverPort?: number;
  linkageTerms?: LinkageTerms;
}

export function applyCliOverrides(
  spec: ExchangeSpec,
  overrides: CliOverrides,
): ExchangeSpec {
  const result = structuredClone(spec);

  if (overrides.identity !== undefined) result.identity = overrides.identity;

  if (overrides.linkageTerms !== undefined)
    result.linkageTerms = overrides.linkageTerms;

  if (overrides.pakeToken !== undefined) {
    if (result.connection.authentication === undefined)
      result.connection.authentication = { pakeToken: overrides.pakeToken };
    else result.connection.authentication.pakeToken = overrides.pakeToken;
  }

  if (result.connection.channel === "sftp") {
    const { server } = result.connection;
    if (overrides.serverUsername !== undefined)
      server.username = overrides.serverUsername;
    if (overrides.serverPassword !== undefined)
      server.password = overrides.serverPassword;
    if (overrides.serverPrivateKey !== undefined)
      server.privateKey = overrides.serverPrivateKey;
    if (overrides.serverPort !== undefined) server.port = overrides.serverPort;

    if (overrides.timeout !== undefined) {
      const opts = result.connection.options ?? {};
      result.connection.options = {
        ...opts,
        pollTimeoutMs: overrides.timeout * 1000,
      };
    }
  }

  return result;
}
