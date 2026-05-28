import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { PSIParticipant } from "../src/participant";
import { PassthroughConnection } from "./utils/passthroughConnection";

import type { Connection } from "../src/types";

const psiLibrary = await PSI();

test("starter visits all declared stages including 'waiting for client request'", async () => {
  const starterConn = new PassthroughConnection();
  const joinerConn = new PassthroughConnection(starterConn);
  starterConn.setOther(joinerConn);

  const starterStages: Array<string> = [];
  const starter = new PSIParticipant(
    "starter",
    psiLibrary,
    { role: "starter", verbose: 0 },
    (id) => starterStages.push(id),
  );
  const joiner = new PSIParticipant("joiner", psiLibrary, {
    role: "joiner",
    verbose: 0,
  });

  await Promise.all([
    starter.identifyIntersection(starterConn as Connection, ["a", "b"]),
    joiner.identifyIntersection(joinerConn as Connection, ["b", "c"]),
  ]);

  expect(starterStages).toContain("waiting for client request");
  expect(starterStages.indexOf("sending startup message")).toBeLessThan(
    starterStages.indexOf("waiting for client request"),
  );
  expect(starterStages.indexOf("waiting for client request")).toBeLessThan(
    starterStages.indexOf("processing client request"),
  );
});
