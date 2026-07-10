import { describe, expect, test, vi } from "vitest";

import { Realm } from "@peerjs-server/models/realm";
import defaultConfig from "@peerjs-server/config/index";

import type { IClient } from "@peerjs-server/models/client";
import type { PeerServerInstance } from "@peerjs-server/instance";

const mockUsePeerServer = vi.fn<() => PeerServerInstance>();

vi.mock("@peerServer", () => ({
  usePeerServer: () => mockUsePeerServer(),
}));

const { Route } = await import("../../src/routes/api/peerjs/$key/peers");

function getHandler(): () => Response | Promise<Response> {
  const handlers = Route.options.server!.handlers!;
  if (typeof handlers === "function") {
    throw new Error("expected the plain-record handlers form");
  }
  return handlers.GET as () => Response;
}

// setClient only keys the realm's client map by the given id; the client value
// itself is never read by getClientsIds, so an empty stand-in is enough.
const stubClient = {} as IClient;

describe("GET /api/peerjs/$key/peers", () => {
  test("responds 401 with an empty body when discovery is disabled", async () => {
    const realm = new Realm();
    realm.setClient(stubClient, "peer-1");
    mockUsePeerServer.mockReturnValue({
      config: { ...defaultConfig, allow_discovery: false },
      realm,
    });

    const response = await getHandler()();

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
  });

  test("responds 200 with the client-id list when discovery is enabled", async () => {
    const realm = new Realm();
    realm.setClient(stubClient, "peer-1");
    realm.setClient(stubClient, "peer-2");
    mockUsePeerServer.mockReturnValue({
      config: { ...defaultConfig, allow_discovery: true },
      realm,
    });

    const response = await getHandler()();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(["peer-1", "peer-2"]);
  });
});
