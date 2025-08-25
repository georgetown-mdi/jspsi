import { envSchema } from 'env-schema'

import type { EnvSchemaOpt, JSONSchemaType } from 'env-schema';

import type { LogLevel } from 'loglevel';

interface Env {
  PORT: number;
  LOG_LEVEL: keyof LogLevel,
  TEST_SESSION: boolean;
}

const schema: JSONSchemaType<Env> = {
  type: 'object',
  required: [
    'PORT'
  ],
  properties: {
    PORT: {
      type: 'number',
      default: 3000
    },
    LOG_LEVEL: {
      type: 'string',
      default: 'INFO'
    },
    TEST_SESSION: {
      type: 'boolean',
      default: false
    }
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