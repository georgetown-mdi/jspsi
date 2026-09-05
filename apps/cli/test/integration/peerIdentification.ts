import net from "node:net";
import type { AddressInfo, Socket } from "node:net";

import { expect } from "vitest";
import { sanitizeErrorForDisplay } from "@psilink/core";

// Shared material for the non-SSH-answer diagnosis, which is asserted from two
// projects: dialPeerIdentification.test.ts drives the dial paths that run over
// the test SFTP server, and backendAgnostic/hostKeyProbePeerIdentification.test.ts
// drives the two host-key probe entry points, which reach no server at all.

/** How a peer answers a connection it accepted. */
export type PeerAnswer = (socket: Socket) => void;

/** A proxy answering the SFTP port instead of the server behind it. */
export const HTTP_ERROR_PAGE =
  "HTTP/1.0 403 Forbidden\r\n" +
  "Content-Type: text/html\r\n" +
  "\r\n" +
  "<html><head><title>Tunnel Forbidden</title></head></html>\r\n";

/** The display links of a rendered error, as the operator reads them. */
export const displayLinks = (error: unknown): string[] =>
  sanitizeErrorForDisplay(error).split("\ncaused by: ");

/**
 * How many times one failure was diagnosed, counted by the recovery step the
 * diagnosis composes. That link rather than the peer's excerpt: a chain holding
 * two diagnoses outruns the display boundary's cause-depth cap, which drops the
 * second excerpt while both recovery steps still render (measured -- a wrapper
 * re-applied around the probe leaves one excerpt link and two recovery steps).
 */
export const diagnosisCount = (links: string[]): number =>
  links.filter((link) =>
    link.startsWith("Check that the configured host and port"),
  ).length;

/**
 * Every assertion the two non-SSH peers share: what the operator is told, and
 * that the peer's own bytes are confined to a link of their own.
 */
export function expectNonSshAnswerDiagnosis(
  links: string[],
  endpoint: { port: number },
): void {
  expect(links[0]).toContain("did not identify itself");
  expect(links[0]).toContain("an HTTP response");
  // The peer's bytes ride a link of their own, and no first-party sentence
  // contains them.
  const peerLinks = links.filter((link) =>
    link.startsWith(
      "first bytes the peer sent; PEM private-key blocks replaced:",
    ),
  );
  expect(peerLinks).toHaveLength(1);
  expect(peerLinks[0]).toContain("403 Forbidden");
  expect(
    links.filter(
      (link) => link.includes("403 Forbidden") && link !== peerLinks[0],
    ),
  ).toEqual([]);
  expect(links).toContain(`configured endpoint: 127.0.0.1:${endpoint.port}`);
  // The stack's own rejection is still behind the diagnosis, which is what
  // keeps a clean close distinguishable from a reset.
  expect(
    links.some((link) => link.includes("Connection lost before handshake")),
  ).toBe(true);
}

export interface CountedPeer {
  host: string;
  port: number;
  /** Connections this endpoint accepted, and how many of them sent nothing at
   * all. A dial announces itself with an SSH identification string the moment it
   * connects, and the diagnosis writes nothing on the connection it opens, so
   * the silent count is the number of diagnostic reads the endpoint saw. */
  accepted(): { total: number; silent: number };
  stop(): Promise<void>;
}

/** A peer that is not an SSH server, answering every connection the same way and
 * keeping count of what reached it. */
export function countingPeer(answer: PeerAnswer): Promise<CountedPeer> {
  return new Promise((resolve) => {
    const open: Socket[] = [];
    let total = 0;
    let spoke = 0;
    const server = net.createServer((accepted) => {
      total += 1;
      open.push(accepted);
      // A peer that answers and closes errors the write side of whatever is
      // still writing to it; an unhandled 'error' would fail the file.
      accepted.on("error", () => {});
      accepted.once("data", () => {
        spoke += 1;
      });
      answer(accepted);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        host: "127.0.0.1",
        port,
        accepted: () => ({ total, silent: total - spoke }),
        stop: async () => {
          for (const socket of open) socket.destroy();
          await new Promise<void>((closed) => server.close(() => closed()));
        },
      });
    });
  });
}
