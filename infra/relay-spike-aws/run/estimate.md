# What `all.sh` should cost, before it runs

Read this and `dry-run.sh`'s output before anything is created. The account's
budget is $10/month with a Budget Action that attaches a deny-all policy at 80%.

## The rates, and why every one of them is advisory

**None of the prices below was measured.** This credential has no `pricing:*`
grant, so no rate here came from AWS's own API; they are the published us-west-2
Linux on-demand figures as the author knows them. Confirm them in the AWS Pricing
Calculator, or with `aws pricing get-products --service-code AmazonEC2` from a
credential that has it, before treating any total as a number rather than an
order of magnitude. The measured spend is what `inventory.sh` and
`ce:GetCostAndUsage` report after the run; this file exists so a surprise is
visible as a surprise.

| resource | rate (advisory) | note |
|---|---|---|
| `t4g.micro`, Linux, on-demand | $0.0084 / hour | the services box |
| `t4g.nano`, Linux, on-demand | $0.0042 / hour | the restricted CLI box |
| gp3 volume | $0.08 / GiB-month | root volumes and the 16 GiB image cache |
| public IPv4 address | $0.005 / hour, **whether attached or not** | AWS began charging for in-use addresses in 2024; an older estimate that treats an attached elastic address as free is wrong, and this run holds three at once |
| data transfer out | $0.09 / GB beyond the monthly free tier | the exchange itself moves tens of kilobytes; the image upload is inbound and free |

## Assumed durations

These are the timeouts the scripts actually allow, not an optimistic guess at how
long a good run takes. An earlier draft assumed a ten-minute cycle; the code
permits `wait_ssh` 420 s (`services-up.sh`), `RUN_TIMEOUT` 420 s plus
`EXIT_GRACE` 90 s (`exchange.sh`), and up to 100 s of interface polling plus 120 s
of security-group retry in teardown (`services-down.sh`), which is a twenty-minute
worst case. Everything below is the doubled figure, and the total moved from about
nine cents to about seventeen.

| what | assumption |
|---|---|
| the whole `all.sh` run | 8 hours wall, unattended |
| one ephemeral cycle | 20 minutes: provision, one exchange, teardown, at the timeouts the scripts allow |
| six ephemeral cycles | 2 hours of `t4g.micro` time in total |
| the shared shape | one services box up for 100 minutes, carrying five exchanges plus the CLI-to-web attempt and the managed-relay rows |
| the restricted CLI box | up for the whole 8 hours, with one public address |
| the image-cache volume | 16 GiB, up for the whole 8 hours |

The exchange itself is the smallest term: question 1 measured 13-14 seconds of
wall time per completed exchange. Everything below is provisioning and idle.

## The total

Address hours are counted per address: two elastic addresses held for two hours
are four address-hours.

| line | hours | rate | cost |
|---|---|---|---|
| `t4g.nano`, restricted box | 8.0 | 0.0042 | $0.034 |
| its public address | 8.0 | 0.005 | $0.040 |
| its 12 GiB root volume | 8.0 | 0.08/GiB-month | $0.011 |
| the 16 GiB image cache | 8.0 | 0.08/GiB-month | $0.014 |
| `t4g.micro`, six ephemeral cycles | 2.0 | 0.0084 | $0.017 |
| two elastic addresses, six cycles | 4.0 | 0.005 | $0.020 |
| `t4g.micro`, the shared shape | 1.67 | 0.0084 | $0.014 |
| two elastic addresses, shared | 3.33 | 0.005 | $0.017 |
| services root volumes | 3.67 | 0.08/GiB-month | $0.005 |
| data transfer out | < 1 GB | 0.09 | $0.00 |
| **total** | | | **about $0.17** |

Call it **under $0.25**, since the rates are advisory and the durations are
ceilings the scripts allow rather than a measurement of a good run.

## The ceiling

If `all.sh` hangs and both instances stay up for a full day with three public
addresses and every volume attached:

| line | cost for 24 hours |
|---|---|
| `t4g.micro` | $0.202 |
| `t4g.nano` | $0.101 |
| three public IPv4 addresses | $0.360 |
| two 12 GiB root volumes | $0.063 |
| the 16 GiB image cache | $0.042 |
| **ceiling, one day** | **about $0.77** |

A full week at that ceiling is about $5.40, inside the $10 budget, and the Budget
Action would attach the deny-all policy at $8 before it got there. The ceiling is
unchanged by the doubled durations: it already assumed both instances up for a
full day, which is longer than any run. The addresses,
not the instances, are the largest term -- which is why `services-down.sh`
releases them rather than leaving them allocated.

## What is not in the total

- **Anything the credential cannot create.** No NAT gateway, no load balancer, no
  S3, no Fargate: all denied, and `dry-run.sh` confirms four of them still are.
- **The managed relay's own charge.** A Cloudflare Realtime TURN key bills on
  Cloudflare's account, not this one, and never appears in `ce:GetCostAndUsage`.
- **Let's Encrypt.** Free, and rate-limited rather than metered: five duplicate
  certificates per week, which is why the certificate is issued once and cached
  across cycles instead of per cycle.
