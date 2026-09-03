// The browser party: mint a live (WebRTC) invitation, publish it to a file for
// the CLI party, hold the rendezvous open, and dump the browser's own
// getStats() and result when the exchange finishes.
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const { chromium } = require_("playwright");
import fs from "node:fs";

const OUT = process.env.OUT_DIR;
const b = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await b.newContext({
  ignoreHTTPSErrors: true,
  acceptDownloads: true,
  permissions: ["clipboard-read", "clipboard-write"],
});
const p = await ctx.newPage();
p.on("console", (m) =>
  fs.appendFileSync(
    `${OUT}/browser-console.log`,
    `[${m.type()}] ${m.text()}\n`,
  ),
);
p.on("pageerror", (e) =>
  fs.appendFileSync(`${OUT}/browser-console.log`, `[pageerror] ${e.message}\n`),
);
await p.addInitScript(() => {
  const Native = window.RTCPeerConnection;
  window.__pcs = [];
  const Wrapped = function (...a) {
    const pc = new Native(...a);
    window.__pcs.push(pc);
    return pc;
  };
  Wrapped.prototype = Native.prototype;
  window.RTCPeerConnection = Wrapped;
  try {
    localStorage.setItem("psilink:diagnostics", "1");
  } catch {}
});

await p.goto(`${process.env.WEB_URL}/exchange`, { waitUntil: "networkidle" });
await p
  .getByLabel(/your name/i)
  .fill("Agency B, b@agency-b.example")
  .catch(async () =>
    p.locator("input[type=text]").first().fill("Agency B, b@agency-b.example"),
  );
await p.locator("input[type=file]").first().setInputFiles(process.env.WEB_CSV);
await p.getByRole("button", { name: /continue to matching/i }).click();
await p.waitForTimeout(1500);
await p.getByRole("button", { name: /continue to review/i }).click();
await p.waitForTimeout(1500);

// "Live, in this browser" is the WebRTC channel; select it explicitly.
const live = p.getByText(/Live, in this browser/i).first();
await live.click().catch(() => {});
await p.waitForTimeout(500);
await p.getByRole("button", { name: /create the invitation/i }).click();
await p.waitForTimeout(4000);
const body = await p.locator("body").innerText();
fs.writeFileSync(`${OUT}/ui-invitation.txt`, body);

// The full link lives only in the clipboard: the page renders an elided
// preview, so the copy control is the only way to read it.
await p.getByLabel(/copy invitation link/i).click();
await p.waitForTimeout(1000);
const link = await p.evaluate(() => navigator.clipboard.readText());
const token = link.includes("#") ? link.slice(link.indexOf("#") + 1) : link;
if (!token) {
  console.log("NO INVITATION FOUND");
  await b.close();
  process.exit(1);
}
fs.writeFileSync(`${OUT}/invitation.txt`, token);
console.log(
  `invitation minted (${token.length} chars), written to ${OUT}/invitation.txt`,
);
console.log("PAGE STATE:", body.slice(0, 700));

// Hold the rendezvous open for the CLI party, then report.
const deadline = Date.now() + Number(process.env.WAIT_MS ?? 600000);
let last = "";
while (Date.now() < deadline) {
  const t = await p
    .locator("body")
    .innerText()
    .catch(() => "");
  if (t !== last) {
    fs.writeFileSync(`${OUT}/ui-live.txt`, t);
    last = t;
  }
  if (/result|matched|complete|finished/i.test(t) && !/waiting/i.test(t)) break;
  await p.waitForTimeout(2000);
}
const stats = await p.evaluate(async () => {
  const out = [];
  for (const pc of window.__pcs ?? []) {
    const s = [];
    (await pc.getStats()).forEach((v) => s.push(v));
    out.push({
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
      stats: s,
    });
  }
  return out;
});
fs.writeFileSync(
  `${OUT}/browser-getstats.json`,
  JSON.stringify(stats, null, 2),
);
for (const pc of stats) {
  const pairs = pc.stats.filter((s) => s.type === "candidate-pair");
  const sel =
    pairs.find((s) => s.nominated && s.state === "succeeded") ??
    pairs.find((s) => s.state === "succeeded");
  const loc = pc.stats.find((s) => s.id === sel?.localCandidateId);
  const rem = pc.stats.find((s) => s.id === sel?.remoteCandidateId);
  console.log(
    `PC state=${pc.connectionState}/${pc.iceConnectionState} selected pair: local=${loc ? `${loc.candidateType}/${loc.protocol}/${loc.relayProtocol ?? "-"}` : "none"} remote=${rem ? `${rem.candidateType}/${rem.protocol}` : "none"}`,
  );
}
fs.writeFileSync(`${OUT}/ui-final.txt`, await p.locator("body").innerText());
console.log("FINAL PAGE:", (await p.locator("body").innerText()).slice(0, 800));
await b.close();
