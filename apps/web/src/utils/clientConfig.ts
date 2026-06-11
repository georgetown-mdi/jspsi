import { envSchema } from "env-schema";

import type { EnvSchemaOpt, JSONSchemaType } from "env-schema";

import type { LogLevel } from "loglevel";

interface Env {
  PEERJS_DEBUG_LEVEL: number;
  LOG_LEVEL: keyof LogLevel;
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
  },
};

class ConfigManager {
  config: Env | null;

  constructor() {
    this.config = null;
  }

  async load(configOptions: EnvSchemaOpt<Env> = {}) {
    if (!this.config) {
      configOptions.schema = configOptions.schema || schema;
      this.config = await envSchema(configOptions);
    }

    return this.config;
  }
}

export { ConfigManager };
