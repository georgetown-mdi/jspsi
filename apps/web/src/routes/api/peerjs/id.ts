import {
  getResponseHeader,
  setResponseHeader,
} from "@tanstack/react-start/server";

import { createFileRoute } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";

import cors from "cors";

import { usePeerServer } from "@peerServer";

import type { CorsRequest } from "cors";

const corsMiddleware = createMiddleware({ type: "request" }).server(
  ({ next, request }) => {
    const peerServer = usePeerServer();
    const applyCors = cors(peerServer.config.corsOptions);

    const corsRequest: CorsRequest = {
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
    };

    let corsResult: "next" | "end" | Error | undefined = undefined;

    applyCors(
      corsRequest,
      {
        // @ts-ignore: getHeader is duck-typed by the vary package
        getHeader: getResponseHeader,
        setHeader: setResponseHeader,
        end: () => {
          corsResult = "end";
        },
      },
      (err) => {
        if (err) {
          corsResult = err;
        } else {
          corsResult = "next";
        }
      },
    );

    // applyCors invokes its callbacks synchronously, but TS cannot see closure
    // assignments, so it still narrows corsResult to undefined here; widen back
    // to the declared union before branching.
    const settledCorsResult = corsResult as "next" | "end" | Error | undefined;

    if (settledCorsResult === "next") return next();

    if (settledCorsResult === "end") throw new Error("cors ended early");

    throw new Error("cors resulted in error: " + settledCorsResult);
  },
);

export const Route = createFileRoute("/api/peerjs/id")({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        GET: {
          middleware: [corsMiddleware],
          handler: () => {
            const peerServer = usePeerServer();

            return new Response(
              peerServer.realm.generateClientId(
                peerServer.config.generateClientId,
              ),
            );
          },
        },
      }),
  },
});
