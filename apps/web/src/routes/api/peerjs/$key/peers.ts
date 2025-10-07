import { createFileRoute } from '@tanstack/react-router';
import { json } from '@tanstack/react-start'
import { setResponseStatus } from '@tanstack/react-start/server';

import { usePeerServer } from '@peerServer'

export const Route = createFileRoute('/api/peerjs/$key/peers')({
  server: {
    handlers: {
      GET: () => {
        const peerServer = usePeerServer();

        if (peerServer.config.allow_discovery) {
          const clientsIds = peerServer.realm.getClientsIds();
		  return json(clientsIds);
        }

        setResponseStatus(401)
        return new Response();
      }
    }
  }
});
