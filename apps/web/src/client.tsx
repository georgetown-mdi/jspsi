import { StartClient } from '@tanstack/react-start/client'
import { StrictMode } from 'react'
import { hydrateRoot } from 'react-dom/client'

import { ConfigManager } from '@utils/clientConfig'
import { setDefaultLevel } from 'loglevel'

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
    <StartClient />
  </StrictMode>,
);
