import { createServerFileRoute } from '@tanstack/react-start/server';

import { json } from '@tanstack/react-start'

export const ServerRoute = createServerFileRoute('/api/peerjs/').methods({
    GET: () => {
        return json({
            "name": "PeerJS Server",
            "description": "A server side element to broker connections between PeerJS clients.",
            "website": "https://peerjs.com/"
        });
    }
});
