import {
  createServerFileRoute,
  setResponseStatus,
  clearResponseHeaders,
  setResponseHeaders
} from '@tanstack/react-start/server';

import { sessions } from '../../../../utils/sessions';

const INVITED_PEER_ID_POLLING_FREQUENCY_MS = 250;

/*
export const ServerRoute = createServerFileRoute('/api/psi').methods((api) => ({
  POST: api.handler((event) => {
    const response = new Response();
    setResponseHeaders(event, {
    })
    console.log(event)
  })
}));
*/

export const ServerRoute = createServerFileRoute('/api/psi/$id/wait').methods({
  POST: async ({ request, params }) => {
    if (!('id' in params) || params['id'] === undefined) {
      setResponseStatus(400);
      return new Response('Missing id of PSI session');
    }
    const sessionId = params['id'] as string;
    if (!(sessionId in sessions)) {
      setResponseStatus(400);
      return new Response('Invalid session id');
    }
    const session = sessions[sessionId];
    if (Date.now() > session.timeToLive.getTime()) {
      setResponseStatus(400);
      return new Response('Expired session id');
    }
    // see https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
    // headers from https://stackoverflow.com/a/59041709
    clearResponseHeaders();
    setResponseHeaders({
      'Cache-Control': 'no-cache',
      'Content-Type': 'text/event-stream',
      'Access-Control-Allow-Origin': '*',
      'Connection': 'keep-alive'
    });
    // flushHeaders(); h3 is under the hood
    
    function getInvitedPeerId() {
      if ('invitedPeerId' in session) {
        console.log(
          `sending SSE peer id ${session['invitedPeerId']} for session ${sessionId}`
        );

        return new Response(JSON.stringify({invitedPeerId: session['invitedPeerId']}));
      }
      setTimeout(getInvitedPeerId, INVITED_PEER_ID_POLLING_FREQUENCY_MS);
    }

    console.log(
      `established SSE connection for session ${sessionId} and waiting until invited peer id is available`
    );

    return getInvitedPeerId();
  }
});
