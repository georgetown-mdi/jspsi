import {
  createServerFileRoute,
  getEvent,
  setResponseStatus
} from '@tanstack/react-start/server';

import { createEventStream, setHeader } from 'h3';

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
    eventStream.onClosed(() => {
      clientWaiting = false;
      console.log(`GET /api/psi/${session.uuid}/wait: event stream closed`);
    });

    console.log(`GET /api/psi/${session.uuid}/wait: created event stream`);

    const getInvitedPeerId = async () => {
      if (!clientWaiting) {
        console.log(`GET /api/psi/${session.uuid}/wait: stream has closed; exiting timeout recursion`)
        return;
      }

      if ('invitedPeerId' in session) {
        console.log(
          `GET /api/psi/${session.uuid}/wait: SSE pushing peer id ${session.invitedPeerId}`
        );

        await eventStream.push(JSON.stringify({invitedPeerId: session.invitedPeerId}));

        return eventStream.close();
      } else if (Date.now() > session.timeToLive.getTime()) {
        console.log(`GET /api/psi/${session.uuid}/wait: SSE session expired}`);
        await eventStream.push(JSON.stringify({error: `session ${session.uuid} timed-out waiting`}));

        return eventStream.close();
      } else {
        setTimeout(getInvitedPeerId, INVITED_PEER_ID_POLLING_FREQUENCY_MS);
      }
    }

    console.log(`GET /api/psi/${session.uuid}/wait: sending event stream`);
    const sentEventStream = eventStream.send();

    getInvitedPeerId();

    return sentEventStream.then(() => {
      console.log(`GET /api/psi/${session.uuid}/wait: sending 200`);
      return new Response();
    });
  })
}));
