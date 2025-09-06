import { createServerFileRoute, setResponseStatus } from '@tanstack/react-start/server';
import { json } from '@tanstack/react-start'

import { usePeerServer } from '@peerServer'

export const ServerRoute = createServerFileRoute('/api/peerjs/$key/peers').methods({
    GET: () => {
        const peerServer = usePeerServer();

        if (peerServer.config.allow_discovery) {
            const clientsIds = peerServer.realm.getClientsIds();
			return json(clientsIds);
        }

        setResponseStatus(401)
        return new Response();
    }
});
