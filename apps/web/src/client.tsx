import { StartClient } from '@tanstack/react-start'
import { StrictMode } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { setDefaultLevel } from 'loglevel'

import { ConfigManager } from '@utils/clientConfig'
import { createRouter } from './router'

const router = createRouter()

const configManager = new ConfigManager();
const config = await configManager.load(
  {
    data: Object.fromEntries(
      Object.entries(import.meta.env)
        .filter(([key]) => key.startsWith('VITE_'))
        .map(([key, value]) => [key.substring(5), value])
    )
  }
);

setDefaultLevel(config.LOG_LEVEL);

hydrateRoot(
  document,
  <StrictMode>
    <StartClient router={router} />
  </StrictMode>,
)