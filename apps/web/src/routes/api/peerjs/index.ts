import { createFileRoute } from '@tanstack/react-router';

import { json } from '@tanstack/react-start'

export const Route = createFileRoute('/api/peerjs/')({
  server: {
    handlers: {
      GET: () => {
        return json({
          "name": "PeerJS Server",
          "description": "A server side element to broker connections between PeerJS clients.",
          "website": "https://peerjs.com/"
        });
    }
    }
  }
});
