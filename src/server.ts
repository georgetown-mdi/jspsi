import app from './app';
import { debug as debugConstructor } from 'debug';
const debug = debugConstructor('jspsi:wwwserver');

import http from 'http';

import { default as createError, HttpError } from 'http-errors';

import { ExpressPeerServer } from 'peer';

/**
 * Get port from environment and store in Express.
 */
const port = parseInt(process.env.PORT || '3000', 10) || 3000;
app.set('port', port);

/**
 * Create HTTP server.
 */

const server = http.createServer(app);

/**
 * Listen on provided port, on all network interfaces.
 */

const peerServer = ExpressPeerServer(server, {
  path: '',
  port: port
});

app.use('/peerjs', peerServer);

// catch 404 and forward to error handler
app.use(function (_req, _res, next) {
  next(createError(404));
});

server.listen(port);
server.on('error', onError);
server.on('listening', onListening);

/**
 * Event listener for HTTP server "error" event.
 */
function onError(error: HttpError) {
  if (error.syscall !== 'listen') {
    throw error;
  }

  const bind = typeof port === 'string' ? 'Pipe ' + port : 'Port ' + port;

  // handle specific listen errors with friendly messages
  switch (error.code) {
    case 'EACCES':
      console.error(bind + ' requires elevated privileges');
      process.exit(1);
      break;
    case 'EADDRINUSE':
      console.error(bind + ' is already in use');
      process.exit(1);
      break;
    default:
      throw error;
  }
}

/**
 * Event listener for HTTP server "listening" event.
 */

function onListening() {
  const addr = server.address();
  const bind = typeof addr === 'string' ? 'pipe ' + addr : 'port ' + addr!.port;
  debug('Listening on ' + bind);
}
