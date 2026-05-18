import type { ConnectionConfig } from "@psilink/core";

export interface ConnectionOverrides {
  /** Maps to connection.authentication.pakeToken. */
  pakeToken?: string;
  /** Seconds to wait for peer; maps to connection.options.pollTimeoutMs. */
  timeout?: number;
  serverUsername?: string;
  serverPassword?: string;
  serverPrivateKey?: string;
  serverPort?: number;
}

export function applyConnectionOverrides(
  connection: ConnectionConfig,
  overrides: ConnectionOverrides,
): ConnectionConfig {
  const result = structuredClone(connection);

  if (overrides.pakeToken !== undefined) {
    if (result.authentication === undefined)
      result.authentication = { pakeToken: overrides.pakeToken };
    else result.authentication.pakeToken = overrides.pakeToken;
  }

  if (result.channel === "sftp") {
    const { server } = result;
    if (overrides.serverUsername !== undefined)
      server.username = overrides.serverUsername;
    if (overrides.serverPassword !== undefined)
      server.password = overrides.serverPassword;
    if (overrides.serverPrivateKey !== undefined)
      server.privateKey = overrides.serverPrivateKey;
    if (overrides.serverPort !== undefined) server.port = overrides.serverPort;

    if (overrides.timeout !== undefined) {
      const opts = result.options ?? {};
      result.options = {
        ...opts,
        pollTimeoutMs: overrides.timeout * 1000,
      };
    }
  }

  return result;
}
