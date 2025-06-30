
/* Flow is:
 *   1. On load, open an EventSource with the server
 *   2. Wait for a server-sent event indicating that the shared link has been
 *      used / a client is ready to join
 *   3. Open a peer.js Peering connection using the server, directly with the
 *      client
 *   4. Send stuff.
 */

// see https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events

var eventList;

function addMessageToList(message) {
  const newElement = document.createElement("li");
  newElement.textContent = message
  eventList.appendChild(newElement);
}

function openEventStream() {
  eventList = document.querySelector('ul#messages');

  const evtSource = new EventSource(`/server_sse?sessionId=${sessionId}`);

  evtSource.onopen = function() {
    console.log("SSE connection opened; waiting for peer id");
  };

  evtSource.onmessage = function(e) {
    const messageData = JSON.parse(e.data);
    if (!('invitedPeerId' in messageData)) {
      addMessageToList("received unexpected message from server:" + messageData)
    } else {
      const invitedPeerId = messageData['invitedPeerId'];

      console.log(`received peer id ${invitedPeerId}; opening peer to peer connection`);
      addMessageToList(`received peer id ${invitedPeerId}; opening peer to peer connection`);

      const peer = new Peer({
        host: "/",
        path: "/peerjs/",
        port: 3000,
        debug: 2
      })

      peer.on('open', function(id) {
        console.log(`peer id identified as: ${id}`);

        const conn = peer.connect(invitedPeerId);

        conn.on('open', function() {
            console.log('peer connection open');

            conn.send('Hello world');

            addMessageToList("sent hello world");

            conn.close();
        });
        
        conn.on('data', function(data) {
            addMessageToList("received message: " + data);
        });
        
        conn.on('error', function(err) {
            console.error('connection error: ' + err);
        });
      })

      peer.on('error', function(err) {
        console.error('peer error: ' + err);
      });

      
    }
  
    evtSource.close();
  };

  evtSource.onerror = function(err) {
    console.error("EventSource failed:", err);
  }; 
}

window.onload = openEventStream;