import {
  createServerFileRoute,
  getEvent,
  setResponseStatus
} from '@tanstack/react-start/server';

import { createEventStream } from 'h3';

import { useSessionManager } from '@utils/sessions';

const INVITED_PEER_ID_POLLING_FREQUENCY_MS = 250;

export const ServerRoute = createServerFileRoute('/api/psi/$uuid/wait').methods((api) => ({
  GET: api.handler(async (ctx) => {
    const params = ctx.params;

    if (!('uuid' in params)) {
      setResponseStatus(400, 'missing session uuid');
      return 'missing session uuid';
    }
    const sessionId = {uuid: params['uuid']};

    const sessionManager = await useSessionManager();

    if (!sessionManager.has(sessionId)) {
      setResponseStatus(400, `session id: ${sessionId.uuid} does not exist or has expired`);
      return `session id: ${sessionId.uuid} does not exist or has expired`;
    }
    const session = sessionManager.get(sessionId);
    if (Date.now() > session.timeToLive.getTime()) {
      setResponseStatus(400, `session id: ${sessionId.uuid} does not exist or has expired`);
      return `session id: ${sessionId.uuid} does not exist or has expired`;
    }

    const event = getEvent();
    const eventStream = createEventStream(event);

    let clientWaiting = true;
    const getInvitedPeerId = function() {
      if (!clientWaiting) {
        // client closed while function was timed out - we can gracefully exit
        console.log(`GET /api/psi/${session.uuid}/wait: stream has closed; exiting timeout recursion`)
      } else if ('invitedPeerId' in session) {
        console.log(
          `GET /api/psi/${session.uuid}/wait: SSE peer id ${session.invitedPeerId}`
        );

        eventStream
          .push(JSON.stringify({invitedPeerId: session.invitedPeerId}))
           .then(() => eventStream.close())
      } else if (Date.now() > session.timeToLive.getTime()) {
        console.log(`GET /api/psi/${session.uuid}/wait: SSE session expired}`);
        eventStream.
          push(JSON.stringify({error: `session ${session.uuid} timed-out waiting`}))
           .then(() => eventStream.close())
      } else {
        setTimeout(getInvitedPeerId, INVITED_PEER_ID_POLLING_FREQUENCY_MS)
      }
    }

    eventStream.onClosed(async () => {
      console.log(`GET /api/psi/${session.uuid}/wait: event stream closed`);
      clientWaiting = false;
      await eventStream.close();
    });

    console.log(`GET /api/psi/${session.uuid}/wait: created event stream and waiting`);
    getInvitedPeerId();

    await eventStream.send();

    console.log(`GET /api/psi/${session.uuid}/wait: sending 204`);

    setResponseStatus(event, 204);
    return new Response();
  })
}));
