import { envSchema } from 'env-schema'

import type { EnvSchemaOpt, JSONSchemaType } from 'env-schema';

interface Env {
  PORT: number;
  LOG_LEVEL: string;
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
      default: 'info'
    },
    TEST_SESSION: {
      type: 'boolean',
      default: false
    }
  }
}

class Config {
  config: Env | null

  constructor() {
    this.config = null;
  }

  
  // eslint-disable-next-line @typescript-eslint/require-await
  async load(configOptions: EnvSchemaOpt<Env> = {}) {
    if (!this.config) {
      configOptions.schema = configOptions.schema || schema;
      this.config = envSchema(configOptions)
    }

    return this.config;
  }
}

export { Config };