# The AWS run tooling for questions 2 and 3

Nothing here has been executed against AWS except `dry-run.sh`, which is
read-only by construction. Every mutating command any script makes is written to
`relay-spike-aws/artifacts/commands.log` before it runs, redacted, so the owner reads what
happened rather than being told about it.

## Read before running anything

1. `estimate.md` -- what the run should cost and what it costs if it hangs. Every
   rate in it is advisory and says so.
2. `./dry-run.sh` -- asks the live IAM evaluator whether every mutating call is
   authorized, self-tests `redact()` against the credential shapes that have
   broken it, and fails if any script writes under `relay-spike-aws/artifacts` without going
   through the functions that redact. Creates nothing. It closes with four
   numbers, not one: how many calls IAM authorized, how many the guardrails
   correctly refused, how many could not be asked at all, and how many AWS
   rejected on their parameters before IAM saw them. Four are
   unaskable until a real instance and volume exist -- `attach-volume`,
   `detach-volume`, `terminate-instances`, `delete-volume` -- because AWS checks
   an id's shape before it consults IAM. `terminate-instances` is among them, so
   run `./dry-run.sh --with-fixture` once `fixture-up.sh` has made the two
   resources: until then the call every teardown depends on is unproven.
3. `../verify.sh` -- the credential's own guardrail check, unchanged.

## Walking the whole flow without creating anything

    SPIKE_NO_MUTATE=1 ./all.sh

Every mutating call prints what it would have run and hands back a synthetic id,
and every remote command and every local container is reported rather than run.
Its state and artifacts go to `state/no-mutate/` and `../artifacts/no-mutate/`, so
a walk cannot overwrite a real run's progress file, state or measurements.

Three things the walk does not cover, so a walk that ends at zero is not a run
that would:

- **Anything that reads a remote host.** The network-class probes and the
  exchanges say `not-measured-no-mutate` and are not results; the logs an
  exchange copies back land as empty files.
- **The interrupt.** `SPIKE_INTERRUPT=1` fires when the party log reports an open
  data channel, and no party runs on a walk, so cycle 4 walks its class-B path
  without ever taking the interrupt.
- **Let's Encrypt issuance.** With `cloudflare/env` configured, the walk
  synthesizes a certificate at the path lego writes instead of issuing one, the
  way it synthesizes resource ids. Everything downstream of the certificate runs;
  the ACME exchange itself does not.

## The shape of a run

    ./fixture-up.sh                 # once per run session
    ./cycle.sh 1 --class a          # one ephemeral cycle, end to end
    ./cycle.sh 4 --class b --interrupt
    ./services-up.sh shared         # the shared shape
    ./exchange.sh shared a shared self
    ./services-down.sh shared
    ./fixture-down.sh               # back to the recorded baseline

    ./all.sh                        # all of the above, unattended, resumable
    ./all.sh --from shared          # resume at a step
    ./all.sh --list                 # the step names

Two instances exist at most: the fixture's restricted CLI box, and one ephemeral
services box. Both places an instance is born count the region's running
instances first and refuse to make a third, so the ceiling is enforced where
instances are made rather than trusted to the caller. `fixture-up.sh` also
refuses when an instance already carries `psilink-spike-cycle=fixture`, because a
partial teardown drops the local state key while the box it named keeps running,
and that is how a second CLI box would appear. The count is read and then acted
on, so two invocations racing each other could still both pass it: one operator,
one run, is the assumption.

## What sits where

| host | what runs there |
|---|---|
| services box, `t4g.micro`, ephemeral | coturn (TURNS 443, TURN 3478), the web app with the broker at `/api` behind an nginx TLS front, and the class-B inspecting proxy |
| restricted CLI box, `t4g.nano`, fixture | one psilink party, in the `psi-link:spike-party` image on host networking, governed by the subnet's network ACL |
| this machine | the partner party, over the real internet, and the browser party under Playwright |

Addresses, all pinned so a certificate can be minted before an instance exists:

| address | what |
|---|---|
| `10.90.1.10` | services box, first interface, primary -- coturn |
| `10.90.1.11` | services box, first interface, secondary -- nginx |
| `10.90.1.20` | services box, second interface -- the class-B proxy's next hop |
| `10.90.2.10` | restricted CLI box |

`aws ec2 describe-instance-types` reports `t4g.micro` at two interfaces and two
IPv4 addresses per interface, measured rather than assumed, which is exactly what
that plan uses.

## The three deliberate deviations from question 1

- **The services are colocated.** Two instances is the ceiling and the restricted
  box holds one. Recorded as a stated limit in `RESULTS.md`.
- **Class B is a routing control.** The local harness routed inside the party's
  own container; on AWS a VPC route sends the two service addresses to the
  services box's second interface, where `iptables REDIRECT` hands them to the
  proxy. The packets keep the service addresses, so a network ACL cannot name the
  proxy -- `set-class.sh` ends by reading the issuer of the certificate the
  restricted box is served, and fails if class B is not intercepted or class A is.
- **Images arrive on a volume.** `ec2:CreateImage` is denied and there is no
  registry, so the images are shipped once into a 16 GiB gp3 volume and each
  ephemeral services box loads them from it. The timing log separates that from
  what AWS took, and `RESULTS.md` says a real deployment pays neither.

## Cloudflare is optional

`../cloudflare/env` (copy `env.example`, `chmod 600`) may carry a zone and a
DNS token, a Realtime TURN key, both, or neither. With the DNS token: real
hostnames and one Let's Encrypt certificate issued by DNS-01 on the first cycle
and reused after. Without it: the private CA under `../certs/` and raw
addresses, exactly as question 1 ran. With the TURN key: question 3's managed row
runs. Without it: that row is reported "not measured, needs the key".

Every Cloudflare endpoint in `cloudflare.sh` is **advisory** -- none has been
driven, because no token exists yet. Each call records its request and response
with secrets redacted, so the first real run replaces the advisory note with a
measurement.

## Secrets

TURN secrets, minted credentials, Cloudflare tokens and the SSH private key live
under $SPIKE_ROOT at mode 600 and appear in no artifact. Everything
that lands under `artifacts/` is written by `artifact_write`, `artifact_append`
or `artifact_tee` in `lib.sh`, each of which pipes through `redact()` first, and
`dry-run.sh` fails if any script in this directory writes an artifact any other
way. That is what covers the logs copied off the remote hosts -- the party logs,
coturn's, the proxy's -- as well as `commands.log`, the configuration files and
the Cloudflare request and response log.

`redact()` strips by field name (`credential:`, `token=`, `Bearer `, URL
userinfo, `PRIVATE KEY` blocks) and, as a backstop, by the literal value of every
secret the run has minted, read from the files the writers create through
`cycle_secret_file` and `party_secret_file`. A path is not a secret: coturn's
`pkey=` and a configured zone name are left readable.

## Stated limits and quotas

- **Elastic addresses.** The default quota is five per region (ADVISORY: AWS's
  published default; `describe-account-attributes` reports `vpc-max-elastic-ips`
  = 5 on this account). A run holds three at once -- the CLI box's auto-assigned
  address and the services box's two -- so two cycles' worth of stranded
  addresses would stall the third cycle at `allocate-address`. That is why
  `services-down.sh` will not drop a cycle's state until the tag-scoped count for
  that cycle reaches zero, and why `all.sh` refuses to start another cycle while
  a previous one still owns anything.
- **Three resources are born untagged and cannot be tagged.** `create-vpc` also
  creates the VPC's default security group, its main route table and its default
  network ACL, and the create call cannot carry tag specifications for them
  (measured: `InvalidParameter: 'security-group' is not a valid taggable resource
  type for this operation`). All three are deleted with the VPC, and both
  `inventory.sh` and `nuke.sh` filter default and main resources out deliberately
  -- but "everything this run creates is tagged at creation" is false as written,
  and these are the three exceptions.
- **`nuke.sh` deletes by ACCOUNT, not by tag**, and the tagging guardrail
  `../README.md` describes is not in fact attached: `create-tags` on a
  pre-existing VPC and `delete-vpc` on the default VPC both come back ALLOWED
  under `--dry-run`, which `dry-run.sh` reports as INFO. Both of those are the
  owner's posture decisions, not this tooling's; it reports them rather than
  changing the account.

## If a run dies badly

`all.sh` and `cycle.sh` tear the services box down on a trap, so an interrupted
run should leave only the fixture. If it leaves more:

    ../inventory.sh                 # what exists
    ./services-down.sh <cycle-id>   # retry one cycle's teardown by recorded id
    ./fixture-down.sh               # by recorded id
    ./fixture-down.sh --nuke        # or hand it to ../nuke.sh, which deletes by account

A teardown that fails keeps the ids it could not delete: `services-down.sh` holds
`state/cycle-<id>.env` and `state/active-cycle` until nothing carries that cycle's
tag, and `fixture-down.sh` holds `state/fixture.env` and the SSH key until every
delete has returned. Re-running either retries by id. Only ids that were thrown
away need `nuke.sh`.

`fixture-up.sh` undoes itself on a failure: an EXIT trap terminates the box it
launched, releases any address it allocated, and prints what it did and what it
left. Bash runs an EXIT trap when the shell is killed by an untrapped SIGINT
(measured), so Ctrl-C takes the same path.
