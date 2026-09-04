import { describe, expect, test, vi } from "vitest";

import {
  resolveEndedTransportCloseSeams,
  resolveTerminalCloseSeam,
  resolveTransportCloseSeams,
  transportCloseSeamError,
} from "../../src/connection/sftpClientInternals";
import type {
  Ssh2ClientSocket,
  Ssh2SftpClientInternals,
} from "../../src/connection/sftpClientInternals";

// The close-seam resolvers over the ssh2 / ssh2-sftp-client internals view.
//
// The RESOLVED arms are driven against the pinned library on every real-server
// leg -- test/integration/terminalCloseBound.test.ts,
// heldSessionWithheldClose.test.ts, teardownQueuedSignal.test.ts, and
// ephemeralSessionExchange.test.ts all reach them -- so what is worth pinning
// here is what a server cannot show: that a resolved seam is bound to the
// receiver it was read off, and which seam is NAMED when several are gone at
// once. The order decides the one thing the operator is told on an upgrade that
// relocates more than one member, and it is not visible from any single
// unavailable arm.
//
// The unavailable arms are the process's own dependency tree rather than
// anything on the wire (docs/TESTING.md, "What the real-server legs cannot
// reach"), so they are modelled, and modelled only over the seams the adapter
// already reaches: no case here supposes a member the adapter never reads.

type MutableSocket = Ssh2ClientSocket & { destroyCalledOn?: unknown };

function socket(): MutableSocket {
  const built: MutableSocket = {
    writableEnded: false,
    destroy() {
      built.destroyCalledOn = this;
    },
  };
  return built;
}

function internals(
  overrides: {
    socket?: MutableSocket | undefined;
    client?: Partial<NonNullable<Ssh2SftpClientInternals["client"]>> | null;
  } = {},
): { value: Ssh2SftpClientInternals; sock: MutableSocket | undefined } {
  const sock = "socket" in overrides ? overrides.socket : socket();
  if (overrides.client === null) return { value: { sftp: null }, sock };
  const client = {
    setNoDelay: vi.fn(),
    _sock: sock,
    once: vi.fn(),
    removeListener: vi.fn(),
    end: vi.fn(),
    ...overrides.client,
  } as NonNullable<Ssh2SftpClientInternals["client"]>;
  return { value: { client, sftp: null }, sock };
}

describe("resolveTerminalCloseSeam", () => {
  test("resolves destroy bound to the socket it was read off, and carries that socket", () => {
    const { value, sock } = internals();

    const seam = resolveTerminalCloseSeam(value);

    expect("missing" in seam).toBe(false);
    if ("missing" in seam) return;
    expect(seam.socket).toBe(sock);
    seam.destroy();
    expect(sock?.destroyCalledOn).toBe(sock);
  });

  test("names client._sock.destroy() when the socket's destroy is gone", () => {
    const sock = socket();
    delete sock.destroy;

    expect(resolveTerminalCloseSeam(internals({ socket: sock }).value)).toEqual(
      {
        missing: "client._sock.destroy()",
      },
    );
  });

  test("names client._sock.destroy() when there is no socket, and when there is no client", () => {
    expect(
      resolveTerminalCloseSeam(internals({ socket: undefined }).value),
    ).toEqual({ missing: "client._sock.destroy()" });
    expect(resolveTerminalCloseSeam(internals({ client: null }).value)).toEqual(
      { missing: "client._sock.destroy()" },
    );
  });
});

describe("resolveEndedTransportCloseSeams", () => {
  test("resolves once and removeListener bound to the client, over the terminal seam", () => {
    const { value, sock } = internals();

    const seams = resolveEndedTransportCloseSeams(value);

    expect("missing" in seams).toBe(false);
    if ("missing" in seams) return;
    const listener = () => {};
    seams.once("close", listener);
    seams.removeListener("close", listener);
    expect(value.client?.once).toHaveBeenCalledWith("close", listener);
    expect(value.client?.removeListener).toHaveBeenCalledWith(
      "close",
      listener,
    );
    expect(seams.socket).toBe(sock);
  });

  test("names writableEnded when the flag is absent rather than false", () => {
    const sock = socket();
    delete sock.writableEnded;

    expect(
      resolveEndedTransportCloseSeams(internals({ socket: sock }).value),
    ).toEqual({ missing: "client._sock.writableEnded" });
  });

  test.each([
    ["once", "client.once()"],
    ["removeListener", "client.removeListener()"],
  ] as const)("names %s's seam when it is gone", (member, missing) => {
    const { value } = internals({ client: { [member]: undefined } });

    expect(resolveEndedTransportCloseSeams(value)).toEqual({ missing });
  });

  test("reports the terminal seam's own unavailability unchanged", () => {
    const sock = socket();
    delete sock.destroy;

    expect(
      resolveEndedTransportCloseSeams(internals({ socket: sock }).value),
    ).toEqual({ missing: "client._sock.destroy()" });
  });
});

describe("resolveTransportCloseSeams", () => {
  test("resolves end bound to the client, over the ended-transport seams", () => {
    const { value, sock } = internals();

    const seams = resolveTransportCloseSeams(value);

    expect("missing" in seams).toBe(false);
    if ("missing" in seams) return;
    seams.end();
    expect(value.client?.end).toHaveBeenCalledTimes(1);
    expect(seams.socket).toBe(sock);
    expect(typeof seams.once).toBe("function");
    expect(typeof seams.removeListener).toBe("function");
  });

  test("names client.end() when it is gone", () => {
    expect(
      resolveTransportCloseSeams(
        internals({ client: { end: undefined } }).value,
      ),
    ).toEqual({ missing: "client.end()" });
  });
});

describe("the order the seams are resolved in", () => {
  // Which seam an operator is NAMED on an upgrade that relocated several at
  // once. Each row removes everything from its own seam onward, so the reported
  // name is the first still-checked one; read top to bottom the rows are the
  // resolution order itself.
  const order = [
    "client.end()",
    "client.once()",
    "client.removeListener()",
    "client._sock.destroy()",
    "client._sock.writableEnded",
  ] as const;

  test.each(order.map((missing, index) => ({ missing, index })))(
    "reports $missing first once it and every seam after it are gone",
    ({ missing, index }) => {
      const sock = socket();
      const gone = new Set(order.slice(index));
      if (gone.has("client._sock.destroy()")) delete sock.destroy;
      if (gone.has("client._sock.writableEnded")) delete sock.writableEnded;
      const { value } = internals({
        socket: sock,
        client: {
          ...(gone.has("client.end()") ? { end: undefined } : {}),
          ...(gone.has("client.once()") ? { once: undefined } : {}),
          ...(gone.has("client.removeListener()")
            ? { removeListener: undefined }
            : {}),
        },
      });

      expect(resolveTransportCloseSeams(value)).toEqual({ missing });
    },
  );
});

describe("transportCloseSeamError", () => {
  test("states what failed and what the operator can do about it", () => {
    const error = transportCloseSeamError();

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(
      "closes the SFTP connection from this side at every poll boundary, " +
        "which the installed SFTP library does not support",
    );
    expect(error.message).toContain("'psilink --version'");
    // The ssh2 internal that is missing is contributor-tier detail: the caller
    // logs it at debug rather than putting it on the operator's terminal, and no
    // operator message cites a docs path the shipped image does not contain.
    expect(error.message).not.toContain("docs/spec/DEPENDENCY_PINS.md");
  });
});
