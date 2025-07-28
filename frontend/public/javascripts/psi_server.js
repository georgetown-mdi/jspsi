
/* Flow is:
 *   1. On load, open an EventSource with the server
 *   2. Wait for a server-sent event indicating that the shared link has been
 *      used / a client is ready to join
 *   3. Open a peer.js Peering connection using the server, directly with the
 *      client
 *   4. Send stuff.
 */

// see https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events

var eventList = null;
var file = null;
var serverData = null;
var invitedPeerId = null;

function addMessageToList(message) {
  const newElement = document.createElement("li");
  newElement.textContent = message
  eventList.appendChild(newElement);
}


function processFileSelection(event) {
  event.preventDefault();

  document.getElementById("serverStartup").style.display = "none";
  document.getElementById("messageLog").style.removeProperty("display");

  file = document.getElementById("inputFile").files[0];
  document.getElementById("fileName").innerHTML = file.name;

  const reader = new FileReader();
  reader.onload = (event) => {
    serverData = event.target.result.split("\n");
    if (file.type === "text/csv") serverData = serverData.slice(1);
    serverData = serverData.filter(function(entry) { return entry.trim() != ''; });
    
    console.log("loaded server data: " + serverData.slice(0, Math.min(serverData.length, 5)));
    addMessageToList("loaded server data: " + serverData.slice(0, Math.min(serverData.length, 5)));

    if (invitedPeerId !== null) openPeerConnection();
  }
  reader.readAsText(file);

  addMessageToList(`waiting for peer to join`);
}

function openPeerConnection() {
  console.log("peer id received and file loaded; opening direct connection");
  addMessageToList("peer id received and file loaded; opening direct connection");

  const peer = new Peer({
    host: "/",
    path: "/peerjs/",
    port: 3000,
    debug: 2
  });

  peer.on("open", function(id) {
    console.log(`peer id identified as: ${id}`);
    console.log("loading PSI");
    import("./psi/psi_wasm_web.js").then(() => { PSI().then((psi) => {
      console.log("PSI loaded");
      const conn = peer.connect(invitedPeerId);

      conn.on("open", function() {
        // note, this doesn't mean that the peer is connected yet so that we can't disconnect
        // from the peerjs server until we receive a message
        console.log("peer connection open"); 
        addMessageToList("peer connection open");

        server = psi.server.createWithNewKey(true);

        console.log("sending setup message");
        addMessageToList("sending setup message");
        var sortingPermutation = [];
        const serverSetup = server.createSetupMessage(
          0.0,
          -1,
          serverData,
          psi.dataStructure.Raw,
          sortingPermutation
        );

        conn.send(serverSetup.serializeBinary());
      }).on("data", function(data) {
        console.log('received data ', data);

        console.log("disconnecting from peer server");
        peer.disconnect();

        console.log("received request message, sending response");
        addMessageToList("received request message, sending response");
        const clientRequest = psi.request.deserializeBinary(data);
        const serverResponse = server.processRequest(clientRequest);
        conn.send(serverResponse.serializeBinary());

        conn.close();
      }).on("error", function(err) {
          console.error("connection error: " + err);
      });
    });});
  });

  peer.on("error", function(err) {
    console.error("peer error: " + err);
  });
}

function openEventStream() {
  eventList = document.querySelector("ul#messages");

  const eventSource = new EventSource(`/server/peerId?sessionId=${sessionId}`);

  eventSource.onopen = function() {
    console.log("SSE connection opened; waiting for peer id");
  };

  eventSource.onmessage = function(message) {
    const messageData = JSON.parse(message.data);
    if (!("invitedPeerId" in messageData)) {
      addMessageToList("received unexpected message from server:" + messageData)
    } else {
      invitedPeerId = messageData["invitedPeerId"];
      console.log(`received peer id ${invitedPeerId}`);
      addMessageToList(`received peer id ${invitedPeerId}`);

      document.getElementById("linkRow").remove();

      if (serverData !== null) openPeerConnection();
    }
  
    eventSource.close();
  };

  eventSource.onerror = function(err) {
    console.error("EventSource failed:", err);
  }; 
}

window.onload = openEventStream;