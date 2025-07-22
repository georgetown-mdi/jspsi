import {
  createServerFileRoute,
  setResponseStatus,
  clearResponseHeaders,
  setResponseHeaders,
  getEvent
} from '@tanstack/react-start/server';

import { createEventStream, sendNoContent } from 'h3';

import { sessions } from '../../../../utils/sessions';

const INVITED_PEER_ID_POLLING_FREQUENCY_MS = 250;

export const ServerRoute = createServerFileRoute('/api/psi/$id/wait').methods((api) => ({
  GET: api.handler(async (ctx) => {
    console.log("getting event");
    const event = getEvent();
    console.log("creating event stream");
    const eventStream = createEventStream(event);

    const params = ctx.params;
    if (!('id' in params) || params['id'] === undefined) {
      setResponseStatus(400, 'missing session id');
      return 'missing session id';
    }
    const sessionId = params['id'] as string;
    if (!(sessionId in sessions)) {
      setResponseStatus(400, `invalid session id: ${sessionId}`);
      return `invalid session id: ${sessionId}`;
    }
    const session = sessions[sessionId];
    if (Date.now() > session.timeToLive.getTime()) {
      setResponseStatus(400, `session ${sessionId} has expired`);
      return `session ${sessionId} has expired`;
    }
    
    var clientWaiting = true;
    const getInvitedPeerId = function() {
      if (!clientWaiting) {
        // client closed while function was timed out - we can gracefully exit
        console.log('stream has closed; exiting timeout recursion')
      } else if ('invitedPeerId' in session) {
        console.log(
          `sending SSE peer id ${session['invitedPeerId']} for session ${sessionId}`
        );

        eventStream
          .push(JSON.stringify({invitedPeerId: session['invitedPeerId']}))
          // .then(() => eventStream.close())
      } else if (Date.now() > session.timeToLive.getTime()) {
        console.log(`pushing session expired message`)
        eventStream.
          push(JSON.stringify({error: `session ${sessionId} timedout waiting`}))
          // .then(() => eventStream.close())
      } else {
        setTimeout(getInvitedPeerId, INVITED_PEER_ID_POLLING_FREQUENCY_MS)
      }
    }
    
    eventStream.onClosed(async () => {
      console.log('event stream closed');
      clientWaiting = false;
      await eventStream.close();
    });

    console.log(`waiting for peer to register on ${session['id']}`);
    getInvitedPeerId();
    //eventStream.push(JSON.stringify({ invitedPeerId: "12345" }));

    console.log('sending event stream');
    await eventStream.send();

    setResponseStatus(event, 204);
    return new Response();
  })
}));
