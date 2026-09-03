// The class-B inspecting proxy on AWS: a TLS-terminating forward point that
// presents its own certificate, decrypts, counts what it can read in the clear,
// and re-encrypts onward to the real service on the same instance.
//
// It is the port of proxy/intercept.mjs from question 1's local harness. The one
// difference is how traffic reaches it: there, a route inside the party
// container; here, a VPC route in the restricted subnet sending the two service
// addresses to this instance's second interface, where iptables REDIRECT hands
// them to these listeners. Class A has no such route, so class A is not
// intercepted -- the route table alone is the discriminator, which is why the
// REDIRECT rules can stay installed for the life of the instance.
//
// The client socket is held paused until the upstream is connected, so no byte
// of the client's first request is consumed before the pipe exists.
import tls from "node:tls";
import net from "node:net";
import fs from "node:fs";
import { PassThrough } from "node:stream";

const D = process.env.SPIKE_DIR ?? "/opt/spike";
const caFile = `${D}/certs/ca.crt`;
const ca =
  fs.existsSync(caFile) && fs.statSync(caFile).size > 0
    ? fs.readFileSync(caFile)
    : undefined;

const targets = [
  {
    port: 8010,
    host: process.env.SPIKE_IP_TURN,
    sni: process.env.SPIKE_TURN_HOST,
    cert: "turn",
    label: "TURN",
  },
  {
    port: 8020,
    host: process.env.SPIKE_IP_WEB,
    sni: process.env.SPIKE_WEB_HOST,
    cert: "web",
    label: "BROKER",
  },
];

for (const t of targets) {
  const server = tls.createServer(
    {
      key: fs.readFileSync(`${D}/certs/mitm-${t.cert}.key`),
      cert: fs.readFileSync(`${D}/certs/mitm-${t.cert}.crt`),
    },
    (client) => {
      client.pause();
      const from = `${client.remoteAddress}:${client.remotePort}`;
      console.log(
        `[${t.label}] client TLS established from ${from} (presented the proxy's own certificate)`,
      );
      let up = 0,
        down = 0,
        closed = false;
      const upMeter = new PassThrough(),
        downMeter = new PassThrough();
      upMeter.on("data", (d) => {
        up += d.length;
      });
      downMeter.on("data", (d) => {
        down += d.length;
      });
      const upstream = tls.connect(
        {
          host: t.host,
          port: 443,
          ...(net.isIP(t.sni) ? {} : { servername: t.sni }),
          ...(ca ? { ca } : {}),
        },
        () => {
          console.log(
            `[${t.label}] upstream TLS to ${t.host}:443 authorized=${upstream.authorized}`,
          );
          client.pipe(upMeter).pipe(upstream);
          upstream.pipe(downMeter).pipe(client);
          client.resume();
        },
      );
      const done = (who) => () => {
        if (closed) return;
        closed = true;
        console.log(
          `[${t.label}] ${who} closed ${from}; plaintext the proxy could read: client->server ${up}B, server->client ${down}B`,
        );
        client.destroy();
        upstream.destroy();
      };
      client.on("close", done("client"));
      upstream.on("close", done("upstream"));
      client.on("error", (e) =>
        console.log(`[${t.label}] client error: ${e.message}`),
      );
      upstream.on("error", (e) =>
        console.log(`[${t.label}] upstream error: ${e.message}`),
      );
    },
  );
  server.on("tlsClientError", (e, sock) =>
    console.log(
      `[${t.label}] client TLS REJECTED from ${sock.remoteAddress ?? "peer"}: ${e.message}`,
    ),
  );
  server.listen(t.port, "0.0.0.0", () =>
    console.log(
      `[${t.label}] intercepting listener on ${t.port} -> ${t.host}:443`,
    ),
  );
}
