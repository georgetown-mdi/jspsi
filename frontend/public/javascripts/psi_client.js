const PEER_ID_SERVER_POLLING_FREQUENCY_MS = 100;

var eventList = null;
var file = null;
var serverSetup = null;
var clientData = null;

function addMessageToList(message) {
  const newElement = document.createElement("li");
  newElement.textContent = message
  eventList.appendChild(newElement);
}

function startPSI(event) {
  event.preventDefault();

  document.getElementById("clientStartup").style.display = "none";
  document.getElementById("messageLog").style.removeProperty("display");

  eventList = document.querySelector('ul#messages');

  file = document.getElementById("inputFile").files[0];
  document.getElementById("fileName").innerHTML = file.name;
  
  const reader = new FileReader();
  reader.onload = (event) => {
    clientData = event.target.result.split("\n");
    if (file.type === "text/csv") clientData = clientData.slice(1);
    clientData = clientData.filter(function(entry) { return entry.trim() != ''; });
    
    console.log("loaded client data: " + clientData.slice(0, Math.min(clientData.length, 5)));
    addMessageToList("loaded client data: " + clientData.slice(0, Math.min(clientData.length, 5)));
      
    openPeerConnection();
  }
  reader.readAsText(file);
}

function openPeerConnection() {

  const peer = new Peer({
    host: "/",
    path: "/peerjs/",
    port: 3000,
    debug: 2
  });

  peer.on('open', async function(id) {
    console.log(`peer id identified as: ${id}; sending to server`);
    addMessageToList(`peer id identified as: ${id}; sending to server`);

    try {
      const response = await fetch(
        './client/peerId',
      {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        method: 'POST',
        body: JSON.stringify({
          sessionId: sessionId,
          invitedPeerId: peer.id
        })
      })

      if (!response.ok) {
        const responseText = await response.text();
        throw new Error(`Response status: ${response.status}, text: ${responseText}`);
      }
    } catch (error) {
      console.error(error.message);
    }
  });

  peer.on('connection', function(conn) {
    console.log('connection event received');
    addMessageToList(`connection event received`);

    console.log("loading PSI");
    import("./psi/psi_wasm_web.js").then(() => { PSI().then((psi) => {
      console.log("PSI loaded");

      const client = psi.client.createWithNewKey(true);

      conn.on("open", function() {
        console.log("connection open");
      }).on("data", function(data) {
        if (serverSetup === null) {
          console.log("disconnecting from peer server");
          peer.disconnect();

          console.log("received setup message; sending request");
          addMessageToList("received setup message; sending request");

          serverSetup = psi.serverSetup.deserializeBinary(data);
          const clientRequest = client.createRequest(clientData);

          conn.send(clientRequest.serializeBinary());
        } else {
          console.log("received response message; calculating intersection");
          addMessageToList("received response message; calculating intersection");
          const serverResponse = psi.response.deserializeBinary(data);
          const associationTable = client.getAssociationTable(
            serverSetup,
            serverResponse
          );
          console.log("assocations (to server sorted elements) are: ", associationTable);
          var commonValues = [];
          for (var i = 0; i < associationTable[0].length; i++) {
            commonValues.push(clientData[associationTable[0][i]]);
          }
          console.log("common values: ", commonValues);
          addMessageToList("common values: " + commonValues);

          conn.close();
        }
      });
    });});
  });

  peer.on('error', function(err) {
    console.error("peer error " + err);
  });
};