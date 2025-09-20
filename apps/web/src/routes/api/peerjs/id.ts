import {
  createServerFileRoute,
  getResponseHeader,
  setResponseHeader
} from '@tanstack/react-start/server';

import { createMiddleware } from '@tanstack/react-start'

import cors from 'cors'

import { usePeerServer } from '@peerServer'

import type { CorsRequest } from 'cors';

const corsMiddleware = createMiddleware({ type: 'request' }).server(
  ({ next, request }) => {
    
    const peerServer = usePeerServer();
    const applyCors = cors(peerServer.config.corsOptions)

    const corsRequest: CorsRequest = {
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
    }

    let corsResult: 'next' | 'end' | any = undefined

    applyCors(
      corsRequest,
      {
        // @ts-ignore: getHeader is duck-typed by the vary package
        getHeader: getResponseHeader,
        setHeader: setResponseHeader,
        end: () => {
          console.warn('end was called within cors');
          corsResult = 'end';
        }
      },
      (err) => { 
        if (err) {
          console.warn('next was called and err is:', err)
          corsResult = err
        } else {
          corsResult = 'next'
        }
      }
    )

    if (corsResult === 'next') return next();

    if (corsResult === 'end') throw new Error('cors ended early');

    throw new Error('cors resulted in error: ' + corsResult.toString());
  },
)

export const ServerRoute = createServerFileRoute('/api/peerjs/id').methods(
  (api) => ({
    GET: api.middleware([corsMiddleware]).handler(() => {
      const peerServer = usePeerServer();

      return new Response(
        peerServer.realm.generateClientId(peerServer.config.generateClientId)
      );
    })
  })
);
