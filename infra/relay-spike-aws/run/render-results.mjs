// Build relay-spike-aws/artifacts/RESULTS.md from what the run actually recorded.
//
// The three tables are the ones the original handoff asks for, verbatim in
// shape. A cell with nothing behind it says "not measured" and names the one
// thing that would settle it, because the decision record is written from this
// file without a second round.
import fs from "node:fs";
import path from "node:path";

const ART = path.resolve(
  new URL(".", import.meta.url).pathname,
  "../artifacts",
);
const RUN = path.resolve(new URL(".", import.meta.url).pathname);

const readJsonl = (f) =>
  fs.existsSync(f)
    ? fs
        .readFileSync(f, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    : [];

const rows = readJsonl(path.join(ART, "rows.jsonl"));
const na = (why) => `not measured -- ${why}`;

function timing(cycle) {
  const f = path.join(ART, `cycle-${cycle}`, "timing.tsv");
  if (!fs.existsSync(f)) return {};
  const out = {};
  for (const line of fs.readFileSync(f, "utf8").split("\n").filter(Boolean)) {
    const [, name, , , secs] = line.split("\t");
    out[name] = Number(secs);
  }
  return out;
}

function orphans(cycle) {
  const f = path.join(ART, `cycle-${cycle}`, "orphans.txt");
  if (!fs.existsSync(f)) return na("the cycle did not reach its teardown");
  return (
    fs
      .readFileSync(f, "utf8")
      .split("\n")
      .filter((l) =>
        /^(instances|volumes|addresses|network-interfaces|security-groups|dns-records|local-certificates)\s/.test(
          l,
        ),
      )
      .map((l) => l.trim().replace(/\s+/g, " "))
      .join("; ") || na("the orphan file held no counts")
  );
}

const ephemeralCycles = ["c1", "c2", "c3", "c4", "c5", "c6"];
const firstFrame = (cycle) => {
  const t = timing(cycle);
  const provision =
    (t["1-api-to-running"] ?? 0) +
    (t["2-running-to-ssh"] ?? 0) +
    (t["3-ssh-to-services-tls"] ?? 0);
  const row = rows.find((r) => r.cycle === cycle && r.open_seconds);
  return provision && row
    ? (provision + Number(row.open_seconds)).toFixed(0)
    : null;
};

// Advisory rates, from run/estimate.md, which carries their source. Cost per
// exchange is instance time only; data transfer out is metered separately and is
// called out rather than folded in.
const RATES = {
  "t4g.micro": 0.0084,
  "t4g.nano": 0.0042,
  "gp3-gib-month": 0.08,
  "eip-unattached-hour": 0.005,
};
const costPerExchange = (seconds) =>
  seconds
    ? `$${((seconds / 3600) * (RATES["t4g.micro"] + RATES["t4g.nano"])).toFixed(4)}`
    : null;

const out = [];
out.push("# Relay spike, questions 2 and 3, measured on AWS");
out.push("");
out.push(
  `Generated ${new Date().toISOString()} from \`relay-spike-aws/artifacts/rows.jsonl\`, the per-cycle`,
);
out.push(
  "`timing.tsv` and `orphans.txt`, and `cost-today.json`. Raw evidence sits beside each",
);
out.push("row under `relay-spike-aws/artifacts/cycle-<id>/`.");
out.push("");
out.push("## Stated limits, before the numbers");
out.push("");
out.push(
  "- **The services box is colocated.** coturn, the web app with its broker, and the",
);
out.push(
  "  class-B inspecting proxy share one t4g.micro, because the owner's ceiling is two",
);
out.push(
  "  instances and the restricted CLI box holds the other. An instance-level failure",
);
out.push(
  "  takes relay, signaling and interception together; a real deployment separates them.",
);
out.push(
  "- **Provisioning includes image delivery.** Phase 3 below carries a `docker load`",
);
out.push(
  "  from an attached EBS volume because this credential cannot bake an AMI",
);
out.push(
  "  (`ec2:CreateImage` is denied) and has no registry to pull from (`s3:*`, `ecs:*`",
);
out.push(
  "  denied). A real deployment replaces that phase with a registry pull or a baked",
);
out.push("  image and pays neither the volume nor the load.");
out.push(
  "- **Class B is a routing control, not an addressing one.** On AWS the packets keep",
);
out.push(
  "  the service addresses and a route sends them to the proxy's interface, so the",
);
out.push(
  "  network ACL cannot name the proxy. The interception is confirmed per class switch",
);
out.push(
  "  by reading the issuer of the certificate the restricted box is served.",
);
out.push("");

out.push(
  "## Question 1, per network class, re-measured over the real internet",
);
out.push("");
out.push(
  "Question 1 was already answered on a local Docker substitute (`REPORT.md`). These rows",
);
out.push(
  "carry the same exchange across a real network path with a real relay, and are here to",
);
out.push("confirm or refute it, not to replace it.");
out.push("");
out.push(
  "| class | how relay was forced | completed | local pair | remote pair | s to data channel | CLI exit | restricted side |",
);
out.push("|---|---|---|---|---|---|---|---|");
for (const r of rows.filter((r) => r.shape !== "cli-to-web")) {
  const forced =
    r.class === "a"
      ? "network shape: UDP denied outright by the subnet's network ACL"
      : r.class === "b"
        ? "network shape: UDP denied, TCP/443 routed to the TLS-terminating proxy"
        : "unrestricted";
  out.push(
    `| ${r.class} (${r.shape}, ${r.relay}) | ${forced} | ${r.result === "ok" ? "yes" : r.result} | ${r.relay_evidence ?? na("no coturn log window")} | ${na("the CLI calls getStats() nowhere; coturn and ss -tnp are the witnesses")} | ${r.open_seconds || na("the CLI never reached the rendezvous")} | ${r.a_exit} | CLI |`,
  );
}
if (!rows.length)
  out.push(`| - | - | ${na("all.sh has not run")} | - | - | - | - | - |`);
out.push("");

out.push("## Question 2, per shape");
out.push("");
out.push(
  "| shape | what was provisioned | s to first frame | cost per exchange | cycles | orphans after the last cycle | the interrupted cycle |",
);
out.push("|---|---|---|---|---|---|---|");
const lastEph = ephemeralCycles
  .filter((c) => fs.existsSync(path.join(ART, `cycle-${c}`)))
  .pop();
const ephSeconds = lastEph ? firstFrame(lastEph) : null;
const interrupted = rows.find((r) => r.interrupted === "yes");
out.push(
  `| ephemeral, per exchange | VPC fixture reused; per cycle: one t4g.micro, two elastic addresses, a second network interface, one security group, one TURN secret, one certificate${fs.existsSync(path.join(ART, "cycle-c1", "cloudflare.log")) ? ", two DNS records" : ""} | ${ephSeconds ?? na("no ephemeral cycle completed")} | ${costPerExchange(ephSeconds) ?? na("no timing")} (t4g.micro + t4g.nano at the advisory rates in run/estimate.md, for the measured cycle length; data transfer out is metered separately) | ${ephemeralCycles.filter((c) => fs.existsSync(path.join(ART, `cycle-${c}`, "orphans.txt"))).length} | ${lastEph ? orphans(lastEph) : na("no cycle reached teardown")} | ${interrupted ? `cycle ${interrupted.cycle}: a=${interrupted.a_exit}, b=${interrupted.b_exit}; orphans as listed for that cycle` : na("no interrupted cycle ran")} |`,
);
const sharedRows = rows.filter((r) => r.shape === "shared");
const sharedT = timing("shared");
const sharedProvision =
  (sharedT["1-api-to-running"] ?? 0) +
  (sharedT["2-running-to-ssh"] ?? 0) +
  (sharedT["3-ssh-to-services-tls"] ?? 0);
const sharedOpen = sharedRows.find((r) => r.open_seconds)?.open_seconds;
out.push(
  `| shared, per-exchange credentials | the same box, stood up once; per exchange only a freshly minted time-limited TURN credential | ${sharedOpen ? Number(sharedOpen).toFixed(0) : na("no shared exchange reached the rendezvous")} (provisioning ${sharedProvision || na("not recorded")}s, amortised over ${sharedRows.length} exchanges) | ${sharedProvision && sharedOpen ? `$${(((sharedProvision / sharedRows.length + Number(sharedOpen)) / 3600) * (RATES["t4g.micro"] + RATES["t4g.nano"])).toFixed(4)}` : na("no timing")} | ${sharedRows.length} | ${orphans("shared")} | ${sharedRows.find((r) => r.interrupted === "yes") ? "recorded in rows.jsonl" : na("no interrupted shared exchange ran")} |`,
);
out.push("");
out.push("### Provisioning, phase by phase");
out.push("");
out.push(
  "| cycle | 1 API create to running | 2 running to SSH | 3 SSH to TLS on both addresses | of which docker install | of which image load | 4 to data channel open |",
);
out.push("|---|---|---|---|---|---|---|");
for (const c of [...ephemeralCycles, "shared"]) {
  const t = timing(c);
  if (!Object.keys(t).length) continue;
  const r = rows.find((x) => x.cycle === c && x.open_seconds);
  out.push(
    `| ${c} | ${t["1-api-to-running"] ?? "-"} | ${t["2-running-to-ssh"] ?? "-"} | ${t["3-ssh-to-services-tls"] ?? "-"} | ${t["3-sub-docker-install"] ?? "-"} | ${t["3-sub-image-load"] ?? "-"} | ${r?.open_seconds ?? "-"} |`,
  );
}
out.push("");

out.push("## Question 3, per option");
out.push("");
out.push(
  "| option | carried class A | carried class B | setup effort | cost | credential issuance and expiry |",
);
out.push("|---|---|---|---|---|---|");
const carried = (cls, relay) => {
  const rs = rows.filter(
    (r) => r.class === cls && r.relay === relay && r.shape !== "cli-to-web",
  );
  if (!rs.length)
    return na(
      relay === "cloudflare"
        ? "no Cloudflare TURN key was configured"
        : "no such row ran",
    );
  return rs.some((r) => r.result === "ok")
    ? "yes"
    : `no (${rs.map((r) => r.result).join(", ")})`;
};
out.push(
  `| coturn on EC2 | ${carried("a", "self")} | ${carried("b", "self")} | one t4g.micro, one config file, one certificate, colocated with the broker; the whole bring-up is \`remote/services-bringup.sh\` | ${costPerExchange(ephSeconds) ?? na("no timing")} per ephemeral exchange, plus the elastic addresses while unattached | REST-style time-limited credential: username \`<unix-expiry>:psilink\`, password \`base64(HMAC-SHA1(static-auth-secret, username))\`, minted fresh per exchange, expiring at the embedded timestamp; the secret itself is minted fresh per cycle |`,
);
out.push(
  `| coturn on Fargate | ${na("ecs:* is denied to this credential, so Fargate was never reachable")} | ${na("ecs:* is denied")} | n/a | n/a | n/a |`,
);
const cfRow = rows.find((r) => r.relay === "cloudflare");
out.push(
  `| Cloudflare Realtime TURN (managed) | ${carried("a", "cloudflare")} | ${carried("b", "cloudflare")} | ${cfRow && cfRow.result !== "not-measured" ? "a zone, a TURN key, and one API call per exchange; no server to run" : na("no Cloudflare TURN key was configured; a key id and its API token would settle it")} | ${na("read cost-today.json for AWS spend; the vendor's own charge is on the vendor's bill, not this account")} | one POST per exchange to the credential-generation endpoint with a TTL, returning a username and credential written into a static \`turn:\` entry -- \`ice_provision\` is refused by the CLI, so a managed vendor is used out of band, which is the awkwardness that prices the \`ice_provision\` work |`,
);
out.push("");

const cw = rows.find((r) => r.shape === "cli-to-web");
out.push("## The CLI-to-web attempt");
out.push("");
out.push(
  cw
    ? `Class A, restricted CLI accepting a browser party's invitation: **${cw.result}**, CLI exit ${cw.a_exit} after ${cw.wall_seconds}s. Artifacts: \`${cw.artifacts}\`.`
    : na("the CLI-to-web step did not run"),
);
out.push("");
out.push(
  "Question 1 measured this failing because the web client offers only an mDNS-obscured",
);
out.push(
  "host candidate and a public reflexive address and configures no TURN server of its own.",
);
out.push(
  "A result matching that is a confirmation over a real network path, not a new finding.",
);
out.push("");

out.push("## Spend");
out.push("");
const costFile = path.join(ART, "cost-today.json");
if (fs.existsSync(costFile)) {
  const raw = fs.readFileSync(costFile, "utf8");
  try {
    const j = JSON.parse(raw);
    for (const day of j.ResultsByTime ?? []) {
      out.push(
        `- ${day.TimePeriod.Start}: ` +
          (day.Groups ?? [])
            .map(
              (g) =>
                `${g.Keys[0]} $${Number(g.Metrics.UnblendedCost.Amount).toFixed(4)}`,
            )
            .join(", ") ||
          `- ${day.TimePeriod.Start}: no grouped cost returned`,
      );
    }
  } catch {
    out.push(
      `- Cost Explorer did not return JSON, so the day's spend is UNKNOWN, not zero: ${raw.split("\n")[0]}`,
    );
  }
} else {
  out.push(`- ${na("all.sh did not reach its final step")}`);
}
out.push("");
out.push(
  "Cost Explorer lags by up to a day, so a run read immediately after it finishes reports",
);
out.push(
  "less than it spent. `run/estimate.md` carries the pre-run estimate and its ceiling.",
);
out.push("");
out.push("## Every command that could bill");
out.push("");
out.push(
  "`relay-spike-aws/artifacts/commands.log`, written before each command ran, secrets redacted.",
);

process.stdout.write(out.join("\n") + "\n");
