import {
  createServerFileRoute,
  getEvent,
  setResponseStatus
} from '@tanstack/react-start/server';

import { createEventStream } from 'h3';

import { sessions } from '../../../../utils/sessions';

const INVITED_PEER_ID_POLLING_FREQUENCY_MS = 250;

export const ServerRoute = createServerFileRoute('/api/psi/$id/wait').methods((api) => ({
  GET: api.handler(async (ctx) => {
    const params = ctx.params;
    if (!('id' in params)) {
      setResponseStatus(400, 'missing session id');
      return 'missing session id';
    }
    const sessionId = params['id'];
    if (!(sessionId in sessions)) {
      setResponseStatus(400, `invalid session id: ${sessionId}`);
      return `invalid session id: ${sessionId}`;
    }
    const session = sessions[sessionId];
    if (Date.now() > session.timeToLive.getTime()) {
      setResponseStatus(400, `session ${sessionId} has expired`);
      return `session ${sessionId} has expired`;
    }

    const event = getEvent();
    const eventStream = createEventStream(event);

    let clientWaiting = true;
    const getInvitedPeerId = function() {
      if (!clientWaiting) {
        // client closed while function was timed out - we can gracefully exit
        console.log(`GET /api/psi/${session['id']}/wait: stream has closed; exiting timeout recursion`)
      } else if ('invitedPeerId' in session) {
        console.log(
          `GET /api/psi/${session['id']}/wait: SSE peer id ${session['invitedPeerId']}`
        );

        eventStream
          .push(JSON.stringify({invitedPeerId: session['invitedPeerId']}))
           .then(() => eventStream.close())
      } else if (Date.now() > session.timeToLive.getTime()) {
        console.log(`GET /api/psi/${session['id']}/wait: SSE session expired}`);
        eventStream.
          push(JSON.stringify({error: `session ${sessionId} timed-out waiting`}))
           .then(() => eventStream.close())
      } else {
        setTimeout(getInvitedPeerId, INVITED_PEER_ID_POLLING_FREQUENCY_MS)
      }
    }

    eventStream.onClosed(async () => {
      console.log(`GET /api/psi/${session['id']}/wait: event stream closed`);
      clientWaiting = false;
      await eventStream.close();
    });

    console.log(`GET /api/psi/${session['id']}/wait: creating event stream to wait for peer`);
    getInvitedPeerId();

    await eventStream.send();

    console.log(`GET /api/psi/${session['id']}/wait: sending 204`);

    setResponseStatus(event, 204);
    return new Response();
  })
}));
