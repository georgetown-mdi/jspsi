import { ConfigManager as BaseConfigManager } from "./configManager";

import type { JSONSchemaType } from "env-schema";

import type { LogLevel } from "loglevel";

interface Env {
  PEERJS_DEBUG_LEVEL: number;
  LOG_LEVEL: keyof LogLevel;
  SERVER_RECEIVES_FILES: boolean;
}

const schema: JSONSchemaType<Env> = {
  type: "object",
  required: [],
  properties: {
    PEERJS_DEBUG_LEVEL: {
      // Errors only (1), not warnings (2): PeerJS's warning-level logs
      // interpolate remote peer ids into the browser console, and those ids are
      // rendezvous addresses derived from the invitation secret -- the app keeps
      // them out of its own default logs (see psi/rendezvous.ts), so the PeerJS
      // logger must not reintroduce them. Raise via the PEERJS_DEBUG_LEVEL env
      // var when diagnosing connection issues.
      type: "number",
      default: 1,
    },
    LOG_LEVEL: {
      type: "string",
      default: "INFO",
    },
    SERVER_RECEIVES_FILES: {
      // False fits the hosted browser-only deployment, where the file-assurance
      // copy in bench/fileAssurance.ts is true. A deployment whose server
      // legitimately receives files (the console-container deployment) opts in
      // via VITE_SERVER_RECEIVES_FILES so that copy stops rendering.
      type: "boolean",
      default: false,
    },
  },
};

class ConfigManager extends BaseConfigManager<Env> {
  constructor() {
    super(schema);
  }
}

export { ConfigManager };
