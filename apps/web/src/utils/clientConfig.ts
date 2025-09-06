import { envSchema } from 'env-schema'

import type { EnvSchemaOpt, JSONSchemaType } from 'env-schema';

import type { LogLevel } from 'loglevel';

interface Env {
  PEERJS_DEBUG_LEVEL: number;
  LOG_LEVEL: keyof LogLevel,
}

const schema: JSONSchemaType<Env> = {
  type: 'object',
  required: [
  ],
  properties: {
    PEERJS_DEBUG_LEVEL: {
      type: 'number',
      default: 2
    },
    LOG_LEVEL: {
      type: 'string',
      default: 'INFO'
    },
  }
}

class ConfigManager {
  config: Env | null

  constructor() {
    this.config = null;
  }
  
  async load(configOptions: EnvSchemaOpt<Env> = {}) {
    if (!this.config) {
      configOptions.schema = configOptions.schema || schema;
      this.config = await envSchema(configOptions)
    }

    return this.config;
  }
}

export { ConfigManager };