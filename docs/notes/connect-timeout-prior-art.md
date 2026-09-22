---
title: "What a connect timeout bounds: one attempt or the whole dial"
---

# What a connect timeout bounds: one attempt or the whole dial

_Status: decided and built. psilink's connect budget bounds one attempt, as
`curl --connect-timeout` and OpenSSH's `ConnectTimeout` do; `probe-host-key`
dials once, so its `--connect-timeout` is the whole wait, plus at most two
further seconds diagnosing a dial that fails before the peer identifies
itself. The normative rows are in
[CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#connect-probe-bound) and
the operator-facing description in
[EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md); this note is kept for the
measurements and the reasoning. See [docs/notes/README.md](README.md)._

## The question

`server_connect_timeout_ms` -- set by `--connection-timeout` on an exchange and
by `--connect-timeout` on `probe-host-key` -- is a per-attempt bound, and the
dial around it is retried. An operator who states a budget and then watches an
unattended run spend several multiples of it against an unreachable server is
owed an answer: does the flag bound one attempt or the whole dial, and does an
unattended dial need a total budget distinct from the per-attempt one?

## What was measured

All figures 2026-09-21, on the development container.

### psilink, against the in-process SFTP harness

The endpoint accepts the TCP connection and then never completes the SSH
handshake (`stallHandshakeOnConnect`), which is what a dropped or black-holed
endpoint looks like once past the SYN. Driven through the adapter at a 1000 ms
budget and the default `max_reconnect_attempts` of 3:

| case | attempts | wall clock |
| ---- | -------- | ---------- |
| budget 1000 ms, `max_reconnect_attempts` 3 | 4 | 7.04 s |

Four attempts, each spending the budget, with a one-second pause between them:
`4 x 1000 + 3 x 1000`. That predicts about 43 s at a 10 s budget and about two
minutes at both defaults, and it matches the ~43 s a denied-endpoint probe at
`--connect-timeout 10s` was observed to take. The measurement is pinned by
`apps/cli/test/integration/droppedEndpointDialBudget.test.ts`.

### curl and OpenSSH, against a silent endpoint

The container's egress rejects an unrouted address instantly (0 ms), so
TEST-NET-1 measures a refusal rather than a drop. The endpoint used instead was
a loopback listener whose accept queue was overflowed, which drops further SYNs
with no reset -- a true black hole.

curl 7.88.1 (aarch64-unknown-linux-gnu), libcurl/7.88.1:

| case | attempts | wall clock |
| ---- | -------- | ---------- |
| `--connect-timeout 3` | 1 | 3.01 s |
| `--connect-timeout 3 --retry 2` | 3 | 12.02 s |
| `--connect-timeout 3 --retry 2 --retry-delay 0` | 3 | 12.03 s |

OpenSSH_9.2p1 Debian-2+deb12u10:

| case | attempts | wall clock |
| ---- | -------- | ---------- |
| `-o ConnectTimeout=3` | 1 | 3.01 s |
| `-o ConnectTimeout=3 -o ConnectionAttempts=3` | 3 | 11.02 s |

Both spend the stated bound once per attempt. curl's documentation scopes it to
a phase rather than a run -- "Maximum time in seconds that you allow curl's
connection to take. This only limits the connection phase" -- and OpenSSH's to
the connection rather than the command: "Specifies the timeout (in seconds)
used when connecting to the SSH server ... applied both to establishing the
connection and to performing the initial SSH protocol handshake and key
exchange."

Neither tool folds the retries into that bound. Each instead gives the total a
separate setting: curl has `--retry-max-time` ("Retries will be done as usual
... as long as the timer has not reached this given limit") and OpenSSH has
`ConnectionAttempts` ("the number of tries (one per second) to make before
exiting"), which multiplies the per-attempt bound rather than capping the sum.

rsync's `--contimeout` was **not measured**: rsync is not installed in this
container, and its semantics are not asserted here from memory.

## The decision

**The exchange's connect budget stays per-attempt.** Both comparable tools bound
an attempt, and both express the total as the pair -- a per-attempt bound times
an attempt count the caller sets. Redefining psilink's flag to bound the whole
dial would put a flag spelled like theirs on semantics neither has, and would
make the last attempt of a dial get whatever remained of the budget, which is a
worse failure to report than a clean per-attempt expiry.

**No new total-budget setting is added, because psilink already has the pair.**
`max_reconnect_attempts` is the attempt count, `0` is a valid value, and both
are settable from the configuration and the command line. An unattended run
that wants its stated budget to be the whole budget sets it to 0, exactly as a
curl caller leaves `--retry` unset. What was missing was not a control but the
arithmetic: the operator documentation stated the per-attempt bound without
stating what the run would therefore cost, so the total is now stated where each
flag is documented.

**`probe-host-key` dials once.** It is the one place the per-attempt reading had
no lever behind it: the command exposes no reconnect setting, so its
`--connect-timeout` could not be made the whole wait at any value, and the
observation that opened this question was a probe spending four budgets. A
diagnostic read is re-run rather than retried -- `ssh-keyscan`, whose analogue
this command is, makes one attempt -- so the probe now sets
`max_reconnect_attempts` to 0 and `--connect-timeout` is its whole wait.

## What would reopen this

A transport whose first dial fails transiently often enough that a one-attempt
probe becomes unreliable would argue for a reconnect setting on the probe rather
than for changing what the flag bounds. A second flag bounding a whole dial
would only be worth adding if an operator needed a total that the per-attempt
bound times the attempt count cannot express -- for instance a budget spanning
attempts of unequal length.
