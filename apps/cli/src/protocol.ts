import PSI from "@openmined/psi.js";

import {
  SFTPConnection,
  getLogger,
  describeExchangeStages,
  runExchange,
  buildOutputTable,
} from "@psilink/core";
import type {
  ConnectionConfig,
  SFTPConnectionConfig,
  PreparedExchange,
} from "@psilink/core";

import { SSH2SFTPClientAdapter } from "./connection/ssh2SftpAdapter";
import { writeOutput } from "./util/cli";

/**
 * Runs the PSI protocol over an SFTP connection and writes results to output.
 */
export async function runProtocol(
  connection: ConnectionConfig,
  prepared: PreparedExchange,
  output: string | undefined,
  verbosity: number,
  loggerName: string,
): Promise<void> {
  const sftpConfig = connection as SFTPConnectionConfig;
  const log = getLogger(loggerName);

  const conn = new SFTPConnection(new SSH2SFTPClientAdapter(), {
    verbose: verbosity,
  });
  conn.on("error", (err: unknown) => {
    log.error("sftp error:", err);
    process.exit(69);
  });
  process.on("SIGINT", async function () {
    log.info("caught SIGINT, exiting");
    if (conn.connected) {
      await conn.cleanup();
      await conn.close();
    }
    process.exit(0);
  });

  log.info(
    "opening connection to",
    sftpConfig.server.host,
    "with options",
    sftpConfig.options,
  );
  await conn.openWithConfig(sftpConfig);

  log.info("synchronizing");
  await conn.synchronize();

  if (conn.handshakeRole === "responder") {
    log.info("arrived first - will wait for message");
  } else {
    log.info("arrived second - will send first message");
  }

  log.info("starting polling");
  conn.start();

  const stageLabels = Object.fromEntries(
    describeExchangeStages(prepared).map(({ id, label }) => [id, label]),
  );
  const { associationTable, partnerPayload } = await runExchange(
    conn,
    conn.handshakeRole!,
    prepared,
    {
      psiLibrary: await PSI(),
      verbosity,
      onStage: (id: string) => {
        const label = stageLabels[id] ?? id;
        log.info(label.charAt(0).toLowerCase() + label.slice(1));
      },
      onWarning: (msg: string) => log.warn("terms exchange:", msg),
      onProtocolConfirmed: (partnerTerms, resolvedRole) => {
        log.info("terms agreed, partner identity:", partnerTerms.identity);
        log.info("role:", resolvedRole);
      },
    },
  );

  log.info("stopping polling");
  conn.stop();

  log.info("closing connection");
  await conn.close();

  const { headers, rows } = buildOutputTable(
    associationTable,
    prepared.rawRows,
    prepared.metadata,
    partnerPayload,
  );
  writeOutput(output, headers, rows);
}
