# Guardrails and run tooling for the WebRTC relay spike's AWS account

Everything needed to stand up a dedicated, budget-capped AWS account, prove its
IAM guardrails against the live evaluator, run one WebRTC relay measurement in
it, and destroy what the run created. It exists because the relay measurement
needed a real internet path, a real certificate authority, and a real network
ACL, and none of those can come from a laptop.

## Provenance

Agent-authored during the relay spike, reviewed through refutation rounds, and
run once against a dedicated spike account on 2026-09-03. It is a proposal
rather than ratified infrastructure: read every claim here as something to
check.

What the run measured, and what it concluded, is in
[`docs/notes/webrtc-relay-deployment.md`](../../docs/notes/webrtc-relay-deployment.md).
Nothing about the measurement is restated here; this directory is the tooling
only.

Nothing in this directory runs in CI. No workflow, package script, or test
invokes it, and none of it is a build input.

[`run/README.md`](run/README.md) and [`run/estimate.md`](run/estimate.md) are the
spike's own working documents, carried as they were written before the run.
Where they say nothing has been executed against AWS, or that no Cloudflare
token exists, read the provenance above instead.

## Order of operations

The budget comes first and the access key comes last, so that the only AWS
credential this tooling ever holds is the scoped spike one and there is no admin
credential nearby to escalate from. Steps 1 through 4 are console work.

1. Create a cost budget with alerts. `budget.json` and `notify.json` carry the
   same thing for the CLI; `notify.json` needs a real address in place of
   `REPLACE_WITH_YOUR_EMAIL`.
2. Create customer-managed policies from `spike-policy-allow.json` and
   `spike-policy-guardrails.json`, and attach both. IAM caps a managed policy at
   6144 bytes, which is why the guardrails are a file of their own. Deny wins
   wherever it appears, so the split changes nothing about the outcome.
3. Create the identity and attach the policies to it.
4. Put the credential in a **named** profile, never `default`.
5. Write the account id to `ACCOUNT_ID` beside this file (copy
   `ACCOUNT_ID.example`). Every script that touches the account reads it and
   refuses to run without it.
6. `./inventory.sh`, before anything is provisioned, for a known-empty baseline.
   Its last section prints the budget, which confirms step 1 from the credential
   that will actually be used.
7. `./verify.sh`, then `run/dry-run.sh`, before any create.

A budget alerts and does not stop spend. The hard stop is a Budget Action that
attaches a deny policy when the threshold trips:
`budget-action-role-trust.json` is the service role's trust policy and
`budget-action-denyall.json` the policy it attaches. Both are console work, and
the trust policy needs a real account id in place of
`REPLACE_WITH_YOUR_ACCOUNT_ID`.

## The scripts

| path | what it does |
| --- | --- |
| `inventory.sh` | Read-only. Lists tagged resources in the working region, then sweeps every enabled region for instances, volumes and elastic IPs whether tagged or not, and reports month-to-date spend and the budget. `--brief` stops after the home region; `--fast` skips the cross-region sweep |
| `verify.sh` | Asks the live IAM evaluator, with `--dry-run`, whether each guardrail behaves as claimed. Creates nothing and costs nothing. Exits non-zero on any failure |
| `nuke.sh` | Destroys what the account holds, in dependency order. Dry run unless `--yes` appears in the arguments |
| `run/dry-run.sh` | Asks IAM whether every mutating call the run scripts make is authorized, self-tests the redaction filter against the credential shapes that have broken it, and fails if any script writes an artifact without going through the functions that redact |
| `run/all.sh` | The whole measurement, unattended and resumable. `--list` prints the step names, `--from <step>` resumes |
| `run/fixture-up.sh`, `run/fixture-down.sh` | The once-per-session fixture: the restricted CLI box and the volume the container images arrive on |
| `run/cycle.sh` | One ephemeral provision, exchange and teardown |
| `run/services-up.sh`, `run/services-down.sh` | The services box on its own, for the shared shape |
| `run/exchange.sh`, `run/cli-to-web.sh` | One exchange between two CLI parties, and one between a CLI party and a browser party |
| `run/set-class.sh` | Applies a network class to the restricted subnet, and verifies it took by reading the certificate issuer the restricted box is served |
| `run/mkcerts.sh`, `run/mkpair.sh`, `run/cloudflare.sh` | Certificates, the party working directories, and the optional Cloudflare DNS and TURN calls |
| `run/lib.sh` | The account and region guard, the command log, the redaction filter, and the shared helpers. Sourced by every script above; makes no AWS call of its own |
| `run/render-results.mjs` | Renders the recorded rows into a results document |
| `run/web-invite.mjs`, `run/remote/intercept.mjs` | The browser party under Playwright, and the class-B inspecting proxy |
| `run/remote/` | What is copied to an instance and run there: bring-up for each box, the image-cache seed, one party's run, and the nginx and coturn configuration templates |
| `run/expected/` | The intersection a correct exchange resolves to, compared byte for byte by `run/exchange.sh`, so a run that resolves anything else has changed the measurement rather than moved it |

`SPIKE_NO_MUTATE=1 run/all.sh` walks the whole flow without creating anything:
every mutating call prints what it would have run and hands back a synthetic id.
`run/README.md` states the three things the walk does not cover.

Ending the spike is `./nuke.sh --yes`, then `./inventory.sh` until it comes back
empty, then deleting the access key.

## Known defects

Carried from the spike rather than fixed here.

- **`inventory.sh` sweeps regions serially.** Two calls per enabled region, one
  after another, which dominates the script's runtime. `--fast` skips the sweep
  and `--brief` stops before it; both trade the escape check for speed, and
  neither is the check `run/all.sh` ends on.
- **`verify.sh` reports a skip rather than a pass or a fail** when it cannot
  construct the call: the flow-logs check needs an existing VPC to name, and
  says so. The script's summary calls a skipped check one that was never asked
  of IAM, because it is not a pass.
- **Four calls cannot reach an authorization decision at all.** AWS validates an
  instance or volume id's shape before it consults IAM, so `attach-volume`,
  `detach-volume`, `terminate-instances` and `delete-volume` come back malformed
  under `--dry-run` until real resources exist. `terminate-instances` is the call
  every teardown depends on, which is why `run/dry-run.sh --with-fixture` exists
  and why it must be run once `run/fixture-up.sh` has made them.
- **The tagging guardrail the policies would need in a shared account was never
  written.** As run, `ec2:CreateTags` on a pre-existing untagged VPC and
  `ec2:DeleteVpc` on the default VPC both came back allowed. In an account
  holding nothing but the spike that reaches nothing, and `nuke.sh` deletes
  account-wide by design. Write it before pointing any of this at an account
  that holds something else.
- **Instance count is not capped and data transfer is not capped.** IAM has no
  condition key for the `--count` argument to `RunInstances`, and no policy caps
  transfer. The instance-size cap bounds the exposure rather than removing it;
  for a hard ceiling, lower the account's running On-Demand Standard vCPU quota
  in Service Quotas. The credential cannot raise it back.

## What is not tracked

The tooling is here; nothing that identifies an account, carries a secret, or is
a measurement is. Each path below is ignored by this directory's `.gitignore`.

| path | what goes there |
| --- | --- |
| `ACCOUNT_ID` | The account every script pins itself to. Copy `ACCOUNT_ID.example`. No script defaults to an account, and `nuke.sh` refuses to touch anything when the caller's account does not match |
| `cloudflare/env` | Optional: a zone, a DNS token, and a Realtime TURN key. Copy `cloudflare/env.example` and `chmod 600`. Without it the run uses a private certificate authority and raw addresses and reports the managed-relay measurement as not taken |
| `cli/`, `certs/` | The party input CSVs and the private certificate authority the run uses when Cloudflare is not configured |
| `artifacts/`, `run/state/` | Everything a run writes: the command log, the per-cycle measurements, the SSH private key, minted TURN credentials, and any certificate |

`run/lib.sh` reads all four under `SPIKE_ROOT`, which is this directory unless
the environment sets it elsewhere. Setting it keeps a run's working material out
of the repository entirely.

Not to be confused with [`aws_eb/`](../aws_eb/README.md), the Terraform draft for
the web application's Elastic Beanstalk environment. That one describes
infrastructure the project intends to keep; this one provisions an account for a
measurement and then destroys it.
