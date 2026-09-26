---
title: "Managed Exchange Record"
---

# Managed exchange record

This document specifies the **managed exchange record**: the browser-persisted
state that lets a two-party PPRL exchange run again on an agreed schedule from
the web application -- unattended where the platform allows -- without
re-authoring the exchange or re-establishing a shared secret. It covers the
record's field-by-field shape -- what persists across runs versus what is
supplied at each run -- the field types, and the key-derivation implications of
the persisted secret. It also covers the schedule and run bookkeeping the
unattended path relies on, the local sibling stores beside the record (the
backup, spent, and import markers, the accounting of disclosures each run files
its record into with the note left by a run that could not, and the results a
scheduled run parks for the operator's next visit), and the export artifact's
custody model and rollback caveats. It is the
implementation-level complement to the **Managed exchange lifecycle** overview in
[MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md), which says what the feature is for,
its automation goal and platform envelope, its durability and single-owner
contract, and its threat posture; this document covers the on-disk (in-browser)
shape those properties are enforced over. It does
not cover the browser at-rest threat model (see
[SECURITY_DESIGN.md](../SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges)),
the exchange-file artifact the record is composed from (see
[EXCHANGE_FILE.md](EXCHANGE_FILE.md)), the invitation wire format (see
[FILE_SYNC.md](FILE_SYNC.md)), or the shared-secret rotation construction (see
[PROTOCOL.md](PROTOCOL.md#shared-secret-rotation)). Intended readers are security
auditors and implementors.

> **Normative, not aspirational:** the [persist-before-success
> ordering](#persist-before-success-ordering) and the [single-owner
> invariant](#single-owner-invariant) below bind any implementation of this
> record. Sections that specify design intent rather than shipped behavior say
> so at their own head.

## What the record is, and what it is not

A managed exchange record is the minimal state a party's own browser retains so
that a recurring exchange with the same partner, over the same terms, can be run
again. It is **not** a saved copy of the exchange's inputs or outputs:

- **It never holds the input data, nor any row value derived from it.** The
  record holds a **pointer** to the operator's file at most, never a copy of
  its contents (`inputFileHandle` under [Persisted across
  runs](#persisted-across-runs)). This mirrors the CLI, where `alcove.yaml`
  references data by path and never embeds it, and the exchange-record artifact
  commits to data rather than embedding it (see
  [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md)).
- **It never holds a match result.** The intersection and any received payload
  are the run's output, handled under the operator's data governance, not
  folded back into the managed record.
- **It holds exactly one live shared secret at a time.** The secret is a linear
  resource (see [The secret is a linear
  resource](#the-secret-is-a-linear-resource)); the record stores the current
  rotated value and no history of prior values.

## Record shape

The record is a single object, persisted in the browser's IndexedDB under the
app's origin -- JSON-serializable but for the optional input-file handle, a
platform object IndexedDB stores by structured clone and the export artifact
omits (see [Export artifact](#export-artifact)). Its core is this party's own
**exchange-file document** -- the same shared config schema the web app mints
and the CLI consumes -- plus the secret and the small set of local-only fields
that document does not hold. This is the CLI-parity shape: what
the CLI keeps as `alcove.yaml` plus `.alcove.key`, the browser keeps as one
record. Persisting the whole document, rather than a bespoke subset of its
fields, keeps the record from becoming a parallel format of the kind the
no-parallel-format contract in [EXCHANGE_FILE.md](EXCHANGE_FILE.md) exists to
prevent. `camelCase` on the TypeScript side; the persisted key names below are
the normative field names.

The four bookkeeping fields, `schedule`, `lastRun`, `standingCondition`, and
`rotationInFlightSince`, hold **no free text**: every field of each is a timestamp, an integer duration,
a closed enum, or a marker admitted only as `true`, so none can accumulate
narrative, a match result, a count, or a row value. The constraint is the type,
not a prose promise.

The CLI parity has one deliberate break. The CLI's two artifacts are separable:
an operator can retire the secret alone (delete `.alcove.key`, keep the config)
and permission the two files differently. The one-record design does not offer
that separability: there is no secret-only retirement -- removing a managed
secret means deleting the whole record and re-establishing it by re-invite --
and one store read discloses the secret and the partnership metadata together.
The trade buys the single persist-before-success write and one import/export
artifact; it is stated here so a reviewer does not infer a separability the
design does not have.

### Persisted across runs

These fields survive a run, a crash, a tab close, and a browser restart. They
are the standing definition of the managed exchange.

| Field | Type | Notes |
| ----- | ---- | ----- |
| `schemaVersion` | string literal | The single recognized literal for v4, `alcove-managed-exchange/v4`; a reader rejects any other value rather than migrating it -- the earlier literals among them, `alcove-managed-exchange/v1` (whose records hold no `standingCondition`) and `alcove-managed-exchange/v2` (whose condition holds no operator response) -- matching the reader-rejects-unknown rule the exchange-record and verification-keys files follow (see [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md)). |
| `id` | string (UUID) | A locally-generated identifier for this managed exchange, distinct from any rendezvous id. Used only to name the record in local UI; never sent on the wire. |
| `label` | string, at most 120 UTF-16 code units (enforced at write; a character outside the Basic Multilingual Plane counts as two) | An operator-supplied display name for the partnership. Local only; never sent -- but disclosed to any reader of the store (see [Metadata at rest](../SECURITY_DESIGN.md#metadata-at-rest-presence-and-shape)). The length cap is enforced; the content guidance is not and cannot be: keeping agreement numbers, contact details, and other sensitive counterparty detail out of the label is **operator cooperation**, exactly as export-source invalidation is -- the field's only structural protections are the cap and its never-sent locality. |
| `exchangeFile` | object | This party's exchange-file document, verbatim: the validated `ExchangeSpec` shape both applications share (see [EXCHANGE_FILE.md](EXCHANGE_FILE.md), "The artifact is the CLI config schema") -- the linkage terms both parties validated (column **shape** and disclosed payload column **names**, never a row value), metadata, standardization, any payload-column commitments, the acceptor's own outbound-payload consent record (see [EXCHANGE_FILE.md](EXCHANGE_FILE.md#payload-disclosure-consent), "Payload-disclosure consent"), the acceptor's `expectedPartnerDeduplicate` -- the cardinality side the accepted invitation declared for the partner, which a re-run holds the partner to (see [EXCHANGE_FILE.md](EXCHANGE_FILE.md#terms-binding-consent), "Terms-binding consent") -- this party's own `includeOwnColumns` output-composition choice, a closed two-value enum naming no column, this party's own `csvDelimiter` -- the field-delimiter choice its input file is read under and its result file written with, naming no column and holding no row value: one character, or the reserved word `detect` where the operator chose to have the delimiter taken from the file itself, a value distinct from the field being absent; an absent field is read and written with a comma, so every record stored without one keeps reading and no migration pass rewrites it -- and the connection block. A record stored before that rule holds no delimiter: it was read by detection and now reads as a comma, with no `schemaVersion` change, so a recurring exchange whose input is not comma-separated fails closed at its next window, with the single-column delimiter remedy stated at launch. It has **no `authentication` block** (the secret lives in `sharedSecret` below) and is composed exactly as the mint layer composes a downloadable file: assembled from a credential-free locator input, validated through the shared schema, with the **parse result** (never the raw input) persisted. The document's operator-authored free-text fields persist verbatim with it: each metadata column's optional `description` (no schema length bound), each standardization step's `params` (an open parameter map -- an authored cleaning step can embed a literal value, a pattern or a replacement string), and `retentionDisposition` (bounded at 1024 characters, the config schema's text bound), plus the terms' own 1024-bounded payload `description` and legal-agreement `purpose` strings. The record stores the document as minted, or as the operator last edited its local settings, so the content guidance for these fields is the same **operator cooperation** the `label` row describes, and no additional bound or strip pass runs at persist time: the document is kept verbatim, and a document the mint layer accepts must remain saveable as managed (see [Metadata at rest](../SECURITY_DESIGN.md#metadata-at-rest-presence-and-shape)). The document's terms and connection are fixed for the partnership: a re-invite re-issues the document verbatim with only a fresh secret, and exchanging on different terms is a new exchange, not an edit or re-invite of this record. Its three per-party settings -- `includeOwnColumns`, `csvDelimiter`, and `retentionDisposition` -- are local fields the operator edits in place (see [Local settings of the document](#local-settings-of-the-document)). |
| `side` | enum (`"inviter"` \| `"acceptor"`), or absent | This party's side of the partnership; dispatches a re-run to the matching rendezvous flow (see [Role: a local `side` field](#role-a-local-side-field-not-the-document)). Local-only by design -- not the document's `connection.role`, which no web path reads. Present exactly when the document's connection is `webrtc`, the one channel whose connection names a `role`: a [configuration-only record](#the-configuration-only-record) on `sftp` or `filedrop` holds none, and a reader refuses a record whose `side` and channel disagree. |
| `inputFileHandle` | `FileSystemFileHandle` or absent | A persisted **pointer** to the operator's input file, held where the File System Access API exists (Chromium), with persistent read permission where the platform grants it (an installed app), so an unattended run reads the standing file with nobody present and an attended re-run is one action. It is a reference, never a copy: no input content or row value derived from it persists, which is where the no-second-copy invariant is enforced. It is also live, not a snapshot: each run calls `getFile()` at run start and reads whatever file exists at the path, the pointer following the name rather than the file that stood there when it was picked -- a `File` already obtained stops being readable once the file underneath it changes, so `File` objects are never retained across runs -- which is what makes putting the current period's extract at the same name the data-refresh workflow, by an overwrite in place, a rename over the name, or a delete and a create (see [The input file each run](../MANAGED_EXCHANGE.md#the-input-file-each-run)). A missing entry at run start fails the file read with a clean not-found, recorded as a benign `"input"` failure (see `lastRun`), never routed through desync/attack framing. What it does add to the store's disclosure is the input file's **name**, and the granted read permission extends an in-origin reader's reach to the file's current contents (see [Metadata at rest](../SECURITY_DESIGN.md#metadata-at-rest-presence-and-shape)). Absent on browsers without the API (each attended run re-selects the file) and in any imported record: the handle is a device- and profile-local platform object stored by structured clone, with no file serialization, so the export artifact omits it and the first run after an import re-acquires one by selection. |
| `outputDirectoryHandle` | `FileSystemDirectoryHandle` or absent | A persisted **pointer** to the folder the operator granted for a scheduled run's results, held where the File System Access API exists. A run with nobody present writes its results CSV into that folder, under a name holding the exchange's label and the run's own instant, so successive runs accumulate rather than overwrite and two exchanges granted one folder are told apart by name; a run whose grant is absent, not honoured unattended, or revoked, and one whose write fails, parks the results instead (see [The parked results of a scheduled run](#the-parked-results-of-a-scheduled-run)). The grant is taken at schedule entry and by re-pointing, never at run time: the directory picker requires a user gesture, and at run time the permission is **queried and never prompted**, the same unattended rule `inputFileHandle` takes. The mode is `readwrite`, a larger grant than the input side's single-file read -- an in-origin script can read and write everything in that folder while it stands (see [Metadata at rest](../SECURITY_DESIGN.md#metadata-at-rest-presence-and-shape)). Absent on browsers without the API, and never in the export artifact, for the reason `inputFileHandle` is: it is a device- and profile-local platform object stored by structured clone, with no serialization. What an import then holds depends on which import it is: one that installs a fresh record has no handle and re-grants, while a [revive-in-place](#the-backup-marker-the-spent-state-and-the-import-marker-local-siblings-never-in-the-artifact) -- this profile's own spent record, updated rather than duplicated -- keeps the grant that record already held, since the folder was granted to this profile and the handle never left it. |
| `sharedSecret` | string (base64url, 43 chars / 32 bytes), or absent | The **current** rotated shared secret, matching `SHARED_SECRET_REGEX` (see [EXCHANGE_FILE.md](EXCHANGE_FILE.md)) -- the `.alcove.key` analog the exchange-file document never holds. This is the one at-rest secret in the record. Rotated after every successful run and re-persisted before the run is treated as succeeded (see [Persist-before-success ordering](#persist-before-success-ordering)). Absent in a [configuration-only record](#the-configuration-only-record), which runs nowhere here; its absence is what withholds the run, and no other field records that. Present only where the document's connection is `webrtc`, the one channel this app runs, and the document states no `signing` block, a part this app cannot run; a reader refuses a record holding one on any other channel or beside that block. |
| `expires` | string (ISO 8601, UTC `Z`) or absent | The instant after which `sharedSecret` must not be used; the recovery when it lapses is re-invite. Absent means no bound is in force. The record inherits the CLI key file's **consumer** semantics for `expires` -- one field, one meaning to every consumer (see [Token age and rotation policy](../SECURITY_DESIGN.md#token-age-and-rotation-policy), a citation about meaning, not sourcing) -- while its **provenance** is single-source: only the max-age stamp writes it, the invitation's setup lifetime having been consumed at provisioning. Two write paths stamp it -- a successful run's rotation write-back and an operator's in-place edit of `tokenMaxAgeDays` -- both under the same never-move-later rule (see [Edit-time re-derivation of `expires`](#edit-time-re-derivation-of-expires)). |
| `tokenMaxAgeDays` | integer or absent | The operator's max-token-age policy for this exchange, the browser analog of the CLI `authentication.token_max_age_days`, and like it **off by default**: absent means no bound is in force, and a record is created with it absent unless the operator sets one. When set, each successful run stamps `expires` this many days out onto the rotated secret. The reason to opt in is a dormant partnership: rotation caps exposure only for an exchange that actually runs, so an idle stored secret has no automatic exposure bound without it (see [The primary controls](../SECURITY_DESIGN.md#the-primary-controls)). It is a **local field** the operator may edit in place without a re-invite; what the edit does to `expires` is [Edit-time re-derivation of `expires`](#edit-time-re-derivation-of-expires). |
| `schedule` | object or absent | The partnership-agreed run schedule the unattended path executes: the agreed recurrence and run window -- the schedule is partnership-level agreement, coordinated out-of-band exactly as the terms are -- plus the retry bookkeeping for a missed window (the next planned attempt). Absent for an exchange run attended-only. The field-by-field layout is in [The `schedule` object](#the-schedule-object). |
| `lastRun` | object or absent | Run bookkeeping the backup state and the tiered desync UX read (see [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md)): `at` (ISO 8601 UTC), `outcome` (`"succeeded"` \| `"failed"` \| `"desynced"` \| `"missed"` \| `"skipped"`), and, for a non-succeeded outcome, an optional `failureKind` (`"auth"` \| `"transport"` \| `"storage"` \| `"custody-unreadable"` \| `"input"` \| `"terms-shortfall"` \| `"consent"` \| `"handed-off"` \| `"too-large"` \| `"cancelled"`). A `"missed"` outcome records a no-show: the wait for the other party's runner spent its whole budget with nobody arriving, so no handshake ran. A scheduled run reaches it when an agreed window passes without a completed handshake; an attended run reaches it when its own wait for the partner expires. It has no `failureKind` -- the outcome is the whole account, and it is held apart from `"transport"` (a connection that was made and broke, whose remedy is retrying the connection) and from `"cancelled"` (the operator stopped the run). It is benign, retried at the next window or whenever the operator runs the exchange again, and never routed through the desync/attack framing (see [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#a-missed-window-is-neither-desync-nor-attack)). A `"skipped"` outcome records an agreed window the scheduled runner declined to open because the operator's [compromise response](#the-operators-response-to-it) stood on the record: nothing connected and nothing rotated, so it is neither a run nor a no-show, it has no `failureKind`, and it leaves the miss count where it stood (see [A due window under the operator's compromise response](#a-due-window-under-the-operators-compromise-response)). An `"input"` failure records a benign pre-run acquisition problem -- the handle's file missing, moved, or unreadable at run start -- detected before any connection, likewise never routed through that framing; putting the file back clears it, so its surface offers the run again. A `"terms-shortfall"` failure records the other benign pre-run input state, held apart from it because its remedy is not another attempt: the file was read and cannot satisfy every linkage key the standing terms declare, so the run is refused before connecting (by the run-start input guard, or by the run boundary's own `assertLinkageTermsSatisfiable` inside the pre-connection prepare), and the same file refuses identically at the next window. Its remedy is a file covering every agreed key, or terms re-agreed with the partner out of band -- never a retry or a bare re-pick. A `"terms-shortfall"` entry additionally holds `singleColumnInput`, admitted only as `true` and omitted rather than written `false`, when the file the run-start input guard read came out as ONE column -- the shape a file separated by something other than this record's `csvDelimiter` comes out as. The reading is what tells the delimiter remedy apart from a real shortfall of the agreed keys, and by the next visit the launch error that held it is gone, so the next visit's summary and the between-visit notification read it off the entry: where it is set both state the delimiter remedy, and where it is absent both state the agreed-keys copy. A `"consent"` failure records the third pre-connection refusal: a send-side disclosure gate refused because the set this run would send is not the one the exchange recorded agreeing to send (see [What the setup consent covers across runs](../MANAGED_EXCHANGE.md#what-the-setup-consent-covers-across-runs)). It is likewise benign and outside that framing. A `"handed-off"` failure records the fourth: the run found this device's copy [spent](#the-backup-marker-the-spent-state-and-the-import-marker-local-siblings-never-in-the-artifact) by an export and refused inside the run+rotate lock, before reading the input file and before connecting, rather than rotating a secret whose owner is now elsewhere. It is the single-owner invariant holding rather than a fault, so it too stays outside the desync/attack framing, and it is the record's own account of a run -- attended or scheduled -- that met a hand-off nobody was present to answer for. A `"custody-unreadable"` failure records the fifth, and it is that same refusal failing to read the entry it decides on: the sibling entry did not validate, or its store did not answer, so the run stopped in the same place rather than rotating on custody it could not establish. The same kind records the record itself failing the runnable check at the run's read inside that lock -- gone, not a valid record, or holding a configuration only -- which stops the run at the same point and rotates nothing. It is held apart from `"storage"` because the two leave different states behind -- a `"storage"` failure rotated a secret it could not save, which can leave the two parties holding different ones and is recovered by re-inviting, while this refusal precedes the handshake and rotates nothing, so nothing here is a desync and a fresh secret would replace one nothing moved. A `"too-large"` failure records a refusal to send a PSI set over the bound one WebRTC message holds ([PROTOCOL.md](PROTOCOL.md#the-memory-ceiling-and-the-csv-intake-cap)): the pre-connection first-round check, or a round's own check on the frame it built, which sends the partner an abort in the set's place. It is benign and outside the desync/attack framing, but unlike the five above it can follow the handshake and earlier rounds, so it states nothing about what this run sent. The entry holds no size, as no entry holds a count: the next visit and the between-visit notification state the bound and the remedy, and only a live launch shows the refusal's own message, with the size. A `"too-large"` entry additionally holds `tooLargeSetOwner` (`"local"` \| `"partner"`), the refusal's own reading of whose set was over the bound: `"local"` for this party's own set, `"partner"` for the partner's set a round had to send back re-encrypted. It names the one remedy both surfaces state -- split your input into smaller exchanges, or ask the partner to split theirs -- and the notification's tag differs by side. An entry without it states both remedies. `"consent"`, `"terms-shortfall"`, `"too-large"`, `"handed-off"`, and `"custody-unreadable"` are the failure kinds a surface must **not** present as retryable: the same input determines the same disclosure, falls the same way short of the same keys, and builds the same too-large set, a handed-off copy refuses identically at every later run, and a run reads the same unreadable entry every time, so the remedy is the operator's, not another attempt's. A record written before a value was added to either enum still reads -- an entry with `"input"` for a shortfall loads and tiers as the generic input state; the converse is the reader-rejects-unknown rule's consequence, an artifact with an outcome or kind this reader does not know being refused whole rather than read with the value dropped. Widening either enum therefore leaves `schemaVersion` where it is: the version moves for a member an older build would read past and lose state by, not for a value it refuses, and not for `singleColumnInput` or `tooLargeSetOwner`, whose absence is the copy every build states (the agreed-keys copy, and both too-large remedies): a build that does not know either gives worse advice rather than reading a state wrongly. A **re-invite clears `lastRun`** in the same rotation transaction that advances the fresh secret: the re-invite is the recovery for the failure the entry recorded, so leaving it would re-derive a consumed tier at the next visit -- and once the import marker is cleared alongside, a stale `"auth"` failure would re-derive as the attack tier rather than the benign import one. A successful run instead advances `lastRun` to `"succeeded"`; only the re-invite recovery drops it. Which of two runs' entries the store keeps is [Recording a run outcome](#recording-a-run-outcome). |
| `rotationInFlightSince` | string (ISO 8601, UTC `Z`) or absent | The instant a run began a key exchange that has not saved its rotated secret: written durably after the partner connects and before the key exchange starts, and removed by the rotation write that stores the rotated secret, so a record still holding it outside a run records a key exchange that stopped between the two. What writes and reads it: [The rotation-in-flight marker](#the-rotation-in-flight-marker). Absent in a [configuration-only record](#the-configuration-only-record), and never in the export artifact or the command-line key file this app writes. |
| `standingCondition` | object | The unanswered **standing condition**: evidence that this device's secret may no longer be the partnership's, raised by a run and not answered since. It holds one of two forms, neither with free text: a raised condition, `since` (ISO 8601 UTC, the instant of the run that raised it) and `kind` (`"auth"` \| `"storage"`), the two `failureKind`s whose remedy is out-of-band rather than an act on this device; or `{"kind": "none"}` while none stands. A raised condition additionally holds the operator's `response` where one has been given -- `kind` (`"compromise"`) and `at` (ISO 8601 UTC, the instant they answered) -- nested inside the condition it answers rather than beside it, so the acts that clear the condition clear the response with it (see [The standing condition](#the-standing-condition)). The field is **required**, so a reader never has to tell a record holding none from one written without the field: a record stored under `alcove-managed-exchange/v1`, which has no such field, is rejected whole and re-established by re-invite, as is one under `alcove-managed-exchange/v2`, whose condition cannot hold a response (see [Versioning](#versioning-an-app-upgrade-can-invalidate-a-stored-record)). It stands BESIDE `lastRun` rather than inside it because `lastRun` holds one run: the next run's stamp replaces it, so a no-show or a later success would otherwise carry the evidence off with the entry that held it and the operator would never again be asked for the confirmation the design requires (see [A standing condition outlives the run that raised it](../MANAGED_EXCHANGE.md#a-standing-condition-outlives-the-run-that-raised-it)). What raises and clears it is [The standing condition](#the-standing-condition). |

Everything in this table except `sharedSecret` is non-secret but not
non-sensitive. Together the persisted fields disclose the partnership's
existence and shape to any reader of the store: who links with whom, over which
field categories, on what agreed schedule, whatever the document's
operator-authored free-text fields hold (see the `exchangeFile` row), and, when
a handle is persisted, from which named input file. That
presence-and-shape disclosure, and why none of the secret-centric controls
reduce it, is analyzed in [Metadata at
rest](../SECURITY_DESIGN.md#metadata-at-rest-presence-and-shape).

#### The configuration-only record

A record MAY hold **no `sharedSecret`**. Such a record is a **configuration
only**: the agreed terms, the connection, and the local settings, with nothing to
run them on. One route writes one -- importing a command-line `alcove.yaml`
without its `.alcove.key` (see [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#bringing-a-command-line-configuration-back))
-- and the exchange it describes keeps running wherever that key file is.

**A record on any channel but `webrtc` is one.** This app conducts webrtc
exchanges only, and the record schema refuses a `sharedSecret` on an `sftp` or
`filedrop` connection, so the narrowing that withholds a keyless record's run
withholds the run of every record on a channel this app does not conduct: the
limit is met where a run would start, not at the import. The surfaces read the
channel off the document to say which reason applies -- the channel, where it is
one this app does not run, and the key file otherwise.

**A record whose document states a `signing` block asking for a receipt is
one.** This app does not sign exchange receipts, so a run here would complete
without the receipt a `certificate` or `session-derived` block asks for. The
record schema refuses a `sharedSecret` beside such a block on the same terms as
beside another channel, so the one narrowing withholds the run, and an artifact
holding both is refused whole rather than installed, under the generic
newer-version reason, since no artifact this app exports holds both; a record
such an artifact installed before this rule fails the list read and is
discarded from the recovery surface. The command-line import holds the block
unchanged -- every field, an `@` in any of its values kept as text and never
resolved in the browser -- no editor changes it, and the export writes it back
as read. The configuration page names the block, as the file spells it, as the
part this app cannot run, in place of the key-file reason on `webrtc` and
beside the channel reason on `sftp` and `filedrop`, and the list row names it
in place of the key-file reason on `webrtc` and beside the channel on `sftp`
and `filedrop`; the page's list of settings held without an editor leaves it
out, since that reason already names it. The parts this app cannot run are one
list (`DOCUMENT_PARTS_THIS_APP_DOES_NOT_RUN`, read through
`documentPartsThisAppDoesNotRun`,
`apps/web/src/psi/managed/managedExchangeRecord.ts`), which the record schema,
the import and export allowlist, and the surfaces all read.

**A `signing` block whose mode is `none` is not one.** It asks for no receipt,
which this app meets by signing nothing, so it takes no part in the narrowing:
a pair stating it imports runnable, the record holds it beside a secret, and
both exports -- the command-line configuration and the backup artifact --
write it back unchanged. It is held as any other setting without an editor,
and named among them.

**The withheld run is the record's shape, not a flag.** Every path that runs,
rotates, re-invites, hands off, or backs up an exchange takes the narrowed record
type that holds a secret (`RunnableManagedExchangeRecord`), so a configuration-only
record cannot be handed to one: the surfaces narrow first and show the
configuration-only state where the narrowing fails, and the unattended tick skips
such a record. Where the type is erased the narrowing is made again at runtime: a
store entry point takes the record's `id`, which carries no shape, so the
rotation and re-invite writes narrow the record they read INSIDE the transaction
and refuse a configuration-only one there, aborting the transaction with the
record still holding no secret. There is no transition into or out of the state,
and no stored marker to disagree with the record.

**It holds nothing a run or a secret produces.** The record schema refuses a
configuration-only record that also holds `expires` (a bound on a secret it does
not have), `schedule` or `lastRun` (nothing here runs to meet a window or record
an outcome), or either platform handle (no run reads a file or writes a folder).
`label` and `tokenMaxAgeDays` are the record fields it does hold, and it edits
them in place beside the document's [local settings](#local-settings-of-the-document);
an edit of the policy stamps no `expires`.

**`schemaVersion` does not move for it.** The literal moves for a member an older
build would read past and lose state by ([Versioning](#versioning-an-app-upgrade-can-invalidate-a-stored-record)).
A build that predates this shape requires `sharedSecret`, so it refuses a
configuration-only record whole rather than reading one as runnable -- the
fail-closed outcome the version bump exists to produce -- while every record such
a build wrote stays readable here. The same holds for an absent `side`, which a
build that predates it also requires.

**One import is offered beside every listing.** The list offers one import
control whether it is empty, populated, or unreadable. It takes the backup
artifact or a command-line `alcove.yaml` and routes by what the file holds, not
by which listing it stands beside:

- **A backup** installs or revives a runnable record, reconciled against the
  one exchange it holds ([Reconciling a backup
  import](#reconciling-a-backup-import)).
- **An `alcove.yaml` chosen alone**, on any channel, installs a
  configuration-only record: a `webrtc` file lands as a record with no key, and
  an `sftp` or `filedrop` file as a record on a channel this app does not run.
  It holds no secret, reconciles against no stored record, and runs nowhere
  here, so nothing it installs can be a second live copy of anything.
- **An `alcove.yaml` chosen together with its `.alcove.key`** installs a
  runnable record ([Importing the key file beside a
  configuration](#importing-the-key-file-beside-a-configuration)), with a
  reconciliation and refusals of its own.

#### Importing the key file beside a configuration

An `alcove.yaml` chosen together with its `.alcove.key`, in one pick of the
import control, installs a **runnable** record: the configuration-only record
the `alcove.yaml` alone would install, holding the key file's secret. Which
file is the key file is read off the names -- the one whose name ends in
`.key`, the name Alcove writes (`DEFAULT_KEY_PATH`, `apps/cli/src/keyFile.ts`)
-- and two files that are not one of each, a key file chosen alone, and more
than two files are refused before either is read. The code:
`readManagedCommandLinePair` and `readManagedCommandLineKeyFile`
(`apps/web/src/psi/managed/managedCommandLineImport.ts`),
`importManagedCommandLinePair` (`managedExchangeImport.ts`).

**What it accepts.** The configuration exactly as the configuration-only import
accepts it, and a key file holding exactly what Alcove writes there: a JSON
object with a `sharedSecret` matching `SHARED_SECRET_REGEX`, an optional ISO
8601 `expires`, and the command line's optional
[rotation-in-flight marker](#the-rotation-in-flight-marker), and no other field.
The key file is validated on its own -- the configuration's schema parse never
sees it -- through the sensitive-JSON chokepoint and the strict key-file schema
the [hand-off re-take](#taking-a-command-line-hand-off-back) also reads
(`keyFileFieldsSchema`), under the re-take's size cap, applied before the file
is read. The export artifact's key half is read against the two-field key-pair
schema (`keyPairFieldsSchema`) instead, which admits no marker.

**What it refuses**, with nothing written:

- A key file over the cap, one that is not JSON, one that is not an object, and
  one whose `sharedSecret` is absent or not an Alcove shared secret, whose
  `expires` is not an ISO 8601 date and time, or that holds any other field.
  The refusal names each problem in fixed words and states no byte of the file:
  no field value, no field name it did not expect, no parser message.
- A configuration this app does not run -- on `sftp` or `filedrop`, or stating
  a `signing` block whose mode is not `none` -- with its key file. The record schema holds a secret only
  where this app runs the exchange, and the operator chose the key file to run
  it here, so the pair is refused, naming the reason and the configuration-only
  import as the way to edit it here, rather than installed without the key.
- Every configuration the configuration-only import refuses, and the app's
  backup artifact chosen as the configuration.
- A pair whose exchange a stored record already is, where the rule below
  refuses it.

**Where the secret lands.** In the installed or revived record's `sharedSecret`,
with the key file's `expires` in `expires`: the record fields every runnable
record keeps them in, written by `createManagedExchange` or inside the
reconciliation's transaction, with the at-rest treatment the backup import's
install gives the artifact's secret. It is written to no other store, field,
or sibling entry; it is never rendered, logged, or stated in a refusal, and no
request carries it (`apps/web/test/unit/psi/managedCommandLineKeyImport.test.ts`,
`apps/web/test/browser/managedCommandLinePairImport.test.ts`, and the pair cases
in `apps/web/test/browser/savedExchanges.test.ts` pin each).

**One rule decides whether it is a stored exchange: the same secret.** A pair
holds no record `id` and no other identity: the configuration names no exchange,
and the key file holds the secret and its bound. The rendezvous ids both parties
register under are derived from the secret, so the secret is the exchange's
identity, and it is the one the backup import already matches on. The pair is
reconciled in the backup import's transaction (`reconcileManagedCommandLinePair`,
`reviveSpentManagedExchange`'s own, `managedExchangeStore.ts`), compared in
memory:

- **A match handed off to the command line refuses**, as it does for a backup,
  naming the record: those files are what the hand-off saved, and the route
  that brings them back is the [re-take](#taking-a-command-line-hand-off-back)
  on that record's own surface, whose confirmation asks the operator to stop the
  command-line run first. The refusal says to choose these two files there. **A
  match whose sibling entry cannot be read refuses** on the backup's terms too.
- **A migration-spent match is revived in place**: the pair's document, `side`,
  max-age policy, and key pair are laid over the stored record, an absent
  `expires` or policy clearing the stored one, and the `id`, label, schedule,
  `lastRun`, standing condition, and platform grants -- none of which the pair
  has a field for -- are kept (`applyManagedExchangeCommandLinePair`). The spent
  state is cleared and the import marker stamped. **A migration-spent match on
  the other `side` refuses**, naming the record: the partner's files hold the
  same secret with the other side, so these are not this party's files.
- **A live match refuses**, naming the record, as it does for a backup: the
  pair holds nothing the live record lacks, so a second live copy of one secret
  is all installing it could add. It decides ahead of a migration-spent match
  for the same reason.
- **No match asks, then installs fresh**, with a new `id`, as the next
  paragraph states.

**A pair no stored secret matches is recognized by its terms and side.** A
command-line run rotates the secret, so a pair from a hand-off that has run
since, or from an exchange moved to another device and run there, matches no
stored secret; a configuration-only record holds none to match. The import
names every stored record the [no-secret-match
rule](#recognizing-a-stored-exchange-without-a-secret-match) finds among those
handed off to the command line, migration-spent, or configuration-only, and
installs nothing until the operator answers (`decideCommandLinePairTarget`,
`apps/web/src/psi/managed/managedPairRecognition.ts`). The answers:

- **Take the pair into one of them.** A handed-off record is taken back through
  its [re-take](#taking-a-command-line-hand-off-back), which checks the pair
  again under its lock; the question states the re-take's own condition, that
  the command-line run is stopped first. A migration-spent record is revived and
  a configuration-only record completed in place, both as a migration-spent
  secret match is revived, less the backup marker where the pair's secret
  differs from the one it attests. A chosen record that no longer qualifies --
  deleted, taken back, running, or changed -- refuses, and nothing is written.
- **Install as a new record**, beside every record named.
- **Cancel**, writing nothing.

**The markers.** Every pair import that writes stamps the [import
marker](#the-backup-marker-the-spent-state-and-the-import-marker-local-siblings-never-in-the-artifact)
as of the import: a key file obtained outside this browser can hold a secret the
partnership has rotated past, the reading the desync tiering gives it until a
run succeeds. It stamps **no backup marker** -- the pair is not the app's backup
file (the command-line export's rule, below) -- and a revive keeps any backup
marker the stored record held, the secret it attests being unchanged.

#### The connection block: credential-free by composition

For the browser path the document's connection block is the `webrtc` channel
restricted to its credential-free locator subset: `server` locator fields only
(`host`/`port`/`path` -- no `server.username`, no PeerJS `key`), the
`invitation_relay` the invitation named (TURN and STUN urls only, see
[PROTOCOL.md](PROTOCOL.md#the-invitations-relay-locator)), and no
`turn`, `ice_provision`, or `provider_options` entries (a TURN entry holds
relay credentials, and the provider map is opaque and `@`-file-pathed). An
acceptor's record keeps `invitation_relay`, and each re-run relays through it
(`beginManagedRendezvous`). This
party's side lives in the local `side` field, not the document (see [Role: a
local `side` field](#role-a-local-side-field-not-the-document)). The full shared schema **can** represent those
credential-bearing fields, so the guarantee comes from composition, exactly as
in the mint layer: the record composer assembles the connection from a
credential-free locator input and persists the schema's parse result. The
downloadable-file mint path's credential-free input union covers only the
file-sync channels (a webrtc exchange is coordinated live, not from a
downloadable file), so core holds the composer's webrtc arm as three distinct
pieces. They are a credential-free `WebRTCExchangeLocator` type
(`host`/`port`/`path` and a url-only `relay`); a `webrtc` arm in `connectionFromLocator`, the
locator-to-connection expansion in `packages/core/src/config/exchangeFile.ts`;
and the composition guarantee extending to the nested `server` object's two
credential fields (`server.username` and the PeerJS `server.key`), which the
flat file-sync locators never had to exclude. The webrtc locator is the
invitation's endpoint schema (`WebRTCEndpointSchema`,
`packages/core/src/config/invitation.ts`), which is already credential-free by
schema, so there is one locator source of truth rather than two, and the
locator-to-connection expansion validates through it -- rejecting any field
outside the allowlist rather than letting the non-strict webrtc connection
schema silently strip it. The composition rule, not a strip pass, is the
enforcement.

A backup file's document was composed by this app, but the file is in the
operator's hands before it is imported, so the backup import measures its
document against the same allowlist a command-line import applies
(`refuseDocumentNotHeld`, `apps/web/src/psi/managed/managedCommandLineImport.ts`):
a connection field outside its channel's locator subset, a literal credential,
or a top-level field this app does not keep is refused, naming the fields a
command-line import of that document names, and nothing is installed. The
refusal tells the operator to remove them from the configuration inside the
backup file, since a backup holds that configuration as text.

A configuration-only record on `filedrop` holds that channel's credential-free
locator subset under the same rule: what `connectionFromLocator`'s arm for the
channel expands to, the folder fields and `options`.

A configuration-only record on `sftp` holds the whole connection the shared
schema admits: the locator subset (`server.host`, `server.port`,
`server.username`, the `server` folder fields `path`, `inbound_path`, and
`outbound_path`, and `options`) and, beyond it, `server.password`,
`server.private_key`, `server.private_key_passphrase`,
`server.keyboard_interactive`, `server.host_key_fingerprint`, `proxy`, and
`provider_options`. Nothing in this app runs an sftp record, so each of these
is held unchanged for the file Alcove runs (EXCHANGE_FILE.md, "What a consumer
does with a setting it cannot honor"). A credential among them is held only as
an `@path` reference, never as a value:

- **Credential positions.** `server.password`, `server.private_key`,
  `server.private_key_passphrase`, the `bearer` and `password` of `proxy.auth`,
  and the value of every key, at any depth under `provider_options`, that
  matches case-insensitively a key the SFTP
  option passthrough names as a credential: `password`, `passphrase`,
  `privateKey`, or `private_key`
  ([EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#connectionprovider_options)),
  named by its dotted key path.
  Every other `provider_options` key is transport tuning, a cipher list for
  one, and is held unchanged whether it is written as a value or an `@path`.
- **The rule.** A credential position holding anything but a string that begins
  with `@` is refused by the command-line import and by the export, naming the
  setting and never its value. One holding an `@path` is held and exported
  byte-for-byte. The browser never reads the file an `@path` names, and the
  configuration page names each setting written as one (the host-key pin and
  any other `provider_options` key included) with a warning that Alcove reads
  that file on the machine that runs the exported document.

The command-line import and export apply one rule, measured off the locator arms
plus the sftp held set (`apps/web/src/psi/managed/managedCommandLineDocument.ts`),
so neither leg holds a field the other would refuse.

#### Role: a local `side` field, not the document

The record's local `side` field (`"inviter"` \| `"acceptor"`) dispatches a
re-run to the right rendezvous flow: the web selects its role by **which
function runs** -- `listenAsInviter` or `dialAsAcceptor`
(`apps/web/src/psi/transport/rendezvous.ts`), each hardcoding its peer-id derivation
label and its handshake role (the inviter is the `"responder"`, the acceptor
the `"initiator"`). The document's `connection.role` field is not
used for this: no web path reads it, and the record does not change that -- the
document is persisted untouched. The field is not inert everywhere, which is why
the local `side` is not redundant with it: on the CLI, `role` is what a webrtc
run derives its own rendezvous peer id from, and `alcove exchange` refuses a
webrtc connection that has none (`apps/cli/src/protocol.ts`). A document the
web composes has no `role` at all -- the locator expansion writes only
`host`/`port`/`path` (see [EXCHANGE_FILE.md](EXCHANGE_FILE.md)) -- so the side a
browser record runs is knowable only from `side`.

On the webrtc re-run path the document's `server` locator is likewise inert: the
inviter derives its signaling location from `window.location`, and the
acceptor's came from the invitation endpoint at accept time. The connection
block is persisted for document fidelity -- the document is kept verbatim, per
the CLI-parity contract above -- not because the webrtc re-run reads it; the
one field of it a re-run reads is an acceptor's `invitation_relay`.

#### Versioning: an app upgrade can invalidate a stored record

A persisted document is subject to the exchange-file versioning and
compatibility policy (see
[EXCHANGE_FILE.md](EXCHANGE_FILE.md#versioning-and-compatibility-policy)): the
web app is continuously deployed, there is no back-compatibility promise for
existing artifacts, and an unknown enum value rejects loudly at load. An app
upgrade can therefore invalidate a stored record -- over and above the record's
own `schemaVersion` reader-rejects-unknown rule -- and the recovery is
re-invite: a record the new version cannot load is re-established from a fresh
invitation rather than hand-migrated, matching the policy's guidance for every
other artifact of this schema.

That evolution path -- reject, re-invite, re-create -- is also how the shape
grows: a schema revision adds its fields under a new `schemaVersion`, required
on that new shape, rather than as optional, structurally always-absent
placeholders on the version already stored.

A version bump therefore destroys an **unanswered compromise response** along
with the condition it answers and the record that holds both. That is accepted,
because it collapses into the three clearers rather than adding a fourth: the
record the response stood on is refused whole, no surface renders an invitation
control over a record that does not load, and re-establishing the exchange is
the delete-and-re-invite the versioning rule already prescribes. The same holds
for a page running older code than the record it reads: it refuses the record
rather than reading it as unanswered.

#### Local settings of the document

Three settings of the stored document are this party's alone: `includeOwnColumns`
(which of its own columns its result file holds), `csvDelimiter` (how its input
file is read and its result file written), and `retentionDisposition` (the note
filed with its exchange record). None is a linkage term -- none is sent,
cross-validated, or folded into the agreed-terms hash (see
[EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#retention_disposition)) -- so
each is a local field the operator edits in place, on a runnable record and a
configuration-only one alike, without a re-invite.

- **One write.** The edit goes through the same field-scoped local-fields write
  as `label` and `tokenMaxAgeDays`, and the edited document is re-validated
  through the shared schema: a delimiter the schema refuses, or an own-columns
  choice on a count-only exchange, fails the write and nothing is stored.
- **Only what changed.** A save writes a setting only where the operator changed
  it, so a document that is not edited keeps each setting as it stated it -- an
  absent `csvDelimiter` stays absent rather than becoming a comma. Clearing the
  own-columns choice or the retention note drops the field; a changed delimiter
  is written as the value chosen.
- **Offered where it acts.** The own-columns control is offered only where the
  terms give this party a result file (not on a count-only exchange, and not
  where `output` gives it none); elsewhere a save leaves the stored value as it
  is.
- **What reads them.** The next run takes the edited document: it reads its input
  and writes its result by `csvDelimiter`, composes its result under
  `includeOwnColumns`, and writes `retentionDisposition` into the exchange record
  it files. The command-line export and the export artifact hold the edited
  document.
- **A changed delimiter re-reads the file.** Before a changed delimiter is saved,
  the stored `inputFileHandle` is read with it and the columns it yields are
  graded against the agreed terms, as the run-start input guard grades them; the
  save waits for that read, and the editor states the result. The read queries
  the handle's read grant and never prompts for it, and only the column names are
  kept. A file it cannot read, or columns short of an agreed key, is stated as a
  warning and does not block the save: the operator may be about to replace the
  file. A record with no usable handle has nothing to re-read, and its next run
  reads the file under the new delimiter.

At setup the offer to save an exchange as recurring authors `retentionDisposition`
beside the label and the max-age policy; the other two come from the setup's own
file and columns steps.

#### Edit-time re-derivation of `expires`

The `tokenMaxAgeDays` policy is a local field an operator may edit in place
(distinct from a run rotation or a re-invite). Editing it re-derives `expires`
conservatively, under one normative constraint: **an edit never moves `expires`
later**. The bound is a stored-credential exposure bound, so an in-place edit --
which does not rotate the secret -- must not stretch that credential's usable
life; a longer policy set by an edit takes effect only at the **next rotation's**
write-back, which restamps from the real advance instant.

The derivation needs the last-advance anchor -- the creation deposit, run
rotation, or re-invite the current `expires` was stamped from -- but that instant
is not persisted (the record holds only the resulting `expires` and
the policy). It is **reconstructed** as `current expires - previous
tokenMaxAgeDays`, exact whenever a **reconstructable bound** exists: a prior
policy and a parseable current `expires` together. The arms discriminate on that
bound-existence, not on policy-existence, so the import-reachable state
{`tokenMaxAgeDays` present, `expires` absent} -- a record with a policy but no
stamped bound -- falls to the edit-instant anchor exactly as an add-where-none
does, because there is no bound to reconstruct an anchor from. The new bound is
then:

- **Edit with a reconstructable bound in force** (a prior policy and a parseable
  current `expires`). `min(reconstructed anchor + new days, current expires)` --
  so a shorter policy recomputes an earlier bound from the anchor, and a longer
  policy keeps the current bound (the `min` floors it there, never moving
  `expires` later).
- **Edit with no reconstructable bound** -- no prior policy, or a policy but no
  parseable `expires` (the {policy present, bound absent} state, and the corrupt-
  `expires` case). No bound to reconstruct an anchor from, so the anchor is the
  **edit instant**: the bound is `edit instant + new days`. Where a parseable
  `expires` is stamped without a policy (the {policy absent, bound present}
  state, which a key-file import can leave), the bound is floored at it,
  `min(edit instant + new days, current expires)`, so this arm never moves
  `expires` later either. Introducing a bound where none was in force only
  tightens (unbounded to bounded).
- **Clearing the policy.** Drops `expires` entirely, matching the rotation
  write-back's `null` clear -- a dropped policy must not leave a stale bound armed.

A computed bound past the representable date range clears rather than storing a
nonsense value: an edit that refuses to extend a credential must never harden a
bounded secret into an unbounded one on a bad stamp, so clearing is the
conservative outcome (re-invite recovers a mistaken clear). The schema's day-count
cap makes this unreachable through the UI; the rule holds for a schema-bypassing
caller.

The decoupling has a real consequence, always in the **safe** (never-later)
direction. After a lengthen keeps the current bound, the reconstructed anchor no
longer matches the real advance instant: `current expires - new (longer) days`
lands **earlier** than the true anchor. A subsequent shorten therefore computes
from that earlier reconstructed anchor and can land a bound sooner than a run
rotation would have -- strictly the conservative direction, and recoverable by
re-invite if it lands an already-lapsed bound (the standing recovery for a lapsed
`expires`). The implementation of this derivation is
`apps/web/src/psi/managed/managedTokenAgeEdit.ts`.

#### Recording a run outcome

Every runner -- the attended Run and the scheduled one alike -- records its
`lastRun` through one field-scoped store write
(`recordManagedExchangeLastRun` in
`apps/web/src/psi/managed/managedExchangeStore.ts`), which touches neither the
secret nor the document. Two rules decide whether the entry it is handed lands,
and each drops the entry whole rather than writing part of it:

- **Monotonic on `at`.** An entry stamped before the stored one is dropped. The
  [run+rotate lock](#the-secret-is-a-linear-resource) serializes the runs it
  binds, but not every entry reaches this write from inside it -- a run that
  fails stamps and writes its bookkeeping tail
  (`apps/web/src/psi/managed/managedRun.ts`) after its lock has released -- so
  an entry stamped behind the stored one can still arrive; this rule makes it a
  no-op instead.
- **A failure MUST NOT overwrite a success stamped after its own run began.**
  Every write states the instant its run began -- stamped before the run's first
  check, so it precedes every act the run makes -- and an entry whose outcome is
  not `"succeeded"` is dropped when the stored entry is a `"succeeded"` one
  stamped at or after that instant. The rule above does not cover this: a
  failing run's bookkeeping tail is stamped after its lock has released, so
  another context can run a whole exchange under the lock and record its success
  in between -- leaving the failure as the newer stamp, which would otherwise
  land over that success.

The second rule is what makes an inter-attempt yield safe (see [Occupying a due
window](#occupying-a-due-window)): the free interval it opens is exactly when an
attended run can complete inside a scheduled window, and every ordering that
would have erased that run's success reduces to a failing run stamping over it.
A success is the entry nothing re-derives -- a window that recorded one and then
folded to a miss counts a window that was met -- so a stamp sharing the run's
start instant is kept as well.

The rules are the store write's, not a runner's, so they hold for a refusal
recorded inside the lock (`handed-off`, `custody-unreadable`, an input
rejection, a failed rotation persist) exactly as for one the runner classifies
after the fact. They do not reach the entry a [schedule advance](#catch-up-on-wake)
carries: that one is the catch-up walk's verdict on an already-closed window, or
a skipped window's own stamp, rather than a run in flight, so it states no run
start and the monotonic rule is what holds a newer success off it.

A stored entry stamped later than the writer's own clock holds nothing off, for
the run write and the schedule advance alike: the incoming entry replaces it. A
stamp from the future -- a clock that ran fast and was corrected, or a record
imported from such a machine -- would otherwise drop every later outcome until
wall time passed it, the same stamp [catch-up](#catch-up-on-wake) already
refuses as evidence.

Neither rule reaches the [standing condition](#the-standing-condition) an entry
raises. They choose which of two runs' **stamps** the record keeps, while the
condition is not one run's stamp but evidence nobody has answered, so a run that
met one raises it whether or not its own entry lands.

#### The standing condition

A `"storage"` or `"auth"` failure is the one class whose remedy is out-of-band --
re-inviting the partner, or the confirmation that tells a desync from an attack --
and it is also the class a later run's stamp would quietly consume: a no-show
replaces `lastRun` with an entry that records no failure kind at all. The
`standingCondition` field is that evidence held where no run stamp reaches it.

**Raised** by any `lastRun` entry whose `failureKind` is `"auth"` or `"storage"`,
at that entry's own instant. The first raise stands: a later condition leaves the
standing one as it is, since answering is a single act over everything that stood
before it, and the earlier evidence is the one still unanswered. It is raised at
two sites, and needs both:

- the `lastRun` write above, which every runner records through; and
- the [schedule advance](#catch-up-on-wake), which carries the condition its
  window's run raised. That is the second chance for the window whose run could
  not write at all: a store failure spanning the rotation write and the run's own
  best-effort bookkeeping write, recovering in time to answer the advance, would
  otherwise leave the plan moved past a window that neither ran nor recorded
  anything. It lands under the same plan condition as the rest of the advance, so
  it is a second chance and not a guarantee.

**Cleared** -- returned to the `"none"` form -- by exactly three things, and
nothing else:

- the operator's explicit clear-and-acknowledge on the exchange's page, which for
  an unexplained handshake failure is the two-outcome gate (see
  [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#a-standing-condition-outlives-the-run-that-raised-it));
- a **re-invite**, in the same rotation transaction that drops `lastRun` -- the
  fresh secret is what the condition's recovery asked for -- which the rotation
  write itself refuses while the condition holds the operator's
  [response](#the-operators-response-to-it);
- **deleting** the record, which takes it along with everything else.

A no-show never clears it, and neither does a successful run on its own: a later
success rules out neither a third party's attempt nor an accidental self-fork,
which are exactly the readings the confirmation exists to separate. A no-show
cannot clear it structurally as well as by rule -- clearing runs only off a
rotation write or an operator's act, and a no-show rotates nothing.

The condition tiers as the equivalent `lastRun` entry would: a `"storage"`
condition is the benign persist-failure state, and an `"auth"` condition is the
benign restore state while the import marker stands and the unexplained state
otherwise. Surfaces read it where the record's own bookkeeping has no failure to
show, and they phrase it as the standing state it is rather than as a reading of
the last run, which may since be a no-show or a success.

It supplies the tier in one further place: a recorded unexplained handshake
failure standing beside a `"storage"` condition is treated as the storage tier,
since the persist failure explains that handshake -- a one-sided persist failure
leaves the two parties on different secrets, and the handshakes after it fail
closed. It is the Tier 1 reading ("the record holds a benign explanation") made
durable rather than a rule of its own, and the rationale for that tiering,
including what an adversary gains by provoking the benign reading, is [Telling a
desync from an attack](../MANAGED_EXCHANGE.md#telling-a-desync-from-an-attack).
A recorded benign cause is not displaced by either rule: it is the run's own
actionable state, and the condition stands until something clears it.

#### The operator's response to it

The two-outcome gate's "something does not add up" reply -- the **compromise
response** (see [Telling a desync from an
attack](../MANAGED_EXCHANGE.md#telling-a-desync-from-an-attack)) -- is recorded
as a `response` member of the raised condition: the closed `kind`
(`"compromise"`) and the `at` instant the operator answered, no free text. It is
nested inside the condition rather than standing beside it so that it has
exactly the clearers the condition has and no clearer of its own; the three acts
that clear a condition each write the whole field, and each takes the response
with the condition. A run never writes it, and a run never clears it.

- **The first answer stands.** A second gate reached later leaves the recorded
  instant as it is, for the reason the first raise stands: the answer is a
  single act over everything that stood before it.
- **The answer always has a carrier.** Answered where no condition stands --
  the raise write the failure earned never landed -- the same write raises one,
  of the `"auth"` kind at the answered failure's instant (the last run's, or the
  answer's own where the record holds no run). Without it the answer would have
  nowhere to live and the gate would be put again at the next visit.
- **While it stands, the schedule's windows are skipped.** A window falling due
  under it is not attempted: nothing connects and nothing rotates, and the window
  records its own `"skipped"` outcome rather than a partner's absence (see [A due
  window under the operator's compromise
  response](#a-due-window-under-the-operators-compromise-response)). A scheduled
  attempt reads the record again before it connects, so an answer written while a
  window is being occupied stops the attempts after it as well as the windows
  after it. The attended run is untouched -- it is the operator's own act, taken
  with the response's warning in front of them.
- **The clear-and-acknowledge folds the windows it held.** The acknowledgement
  applies the [catch-up](#catch-up-on-wake) a wake applies, at the clearing
  instant and in the same write that removes the answer, so every window that
  elapsed under it is recorded `"skipped"` there rather than counted a miss by
  the next wake, which would read a record the answer has left.
- **While it stands, no control offers a fresh invitation.** Neither gate is put
  again, no failure recovery mints, and the configuration section's re-invite on
  the same terms is withheld. The in-app re-invite is reachable only after the
  clear-and-acknowledge, which is the interposition the response exists for and
  not a gap in it.
- **The re-invite's own write refuses it.** The withheld controls are read off
  the record a page mounted with, so a page open since before the answer was
  written still offers them. The rotation write therefore re-reads the record
  inside its own transaction and refuses while a response stands, leaving the
  secret and the answer as they were; the page states the same withheld reason
  its controls do. That makes the clear-and-acknowledge the one order in which a
  fresh invitation is minted: the answer is cleared by the acknowledgement
  first, and the re-invite is on offer after it.
- **A run in flight is a second, independent withhold, excluded rather than
  checked.** It shares the two controls and their withheld reason with the
  compromise response, and it has a write-time guarantee of its own: the rotation
  write takes the record's [run+rotate lock](#the-secret-is-a-linear-resource) with
  `ifAvailable` before it opens its transaction, exactly as the [hand-off
  spend](#the-backup-marker-the-spent-state-and-the-import-marker-local-siblings-never-in-the-artifact)
  does, and refuses while a run holds it. Neither rotation write compares against
  the secret it replaces, so a mint landing beside a run's own rotation would
  discard one of the two. The click re-reads the polled run signal immediately
  beforehand, which pre-empts that refusal in the words the refusal is shown in
  rather than deciding it. This withhold needs no clearer of its own because it is
  not standing: ending the run restores the controls without an acknowledgement.

### The schedule object

The optional `schedule` object holds the partnership-agreed run cadence, the
run window the two runners meet in, and the miss bookkeeping the retry policy
reads. It is present only when the operator saved the exchange as recurring;
an attended-only exchange omits it. Under the no-free-text rule in [Record
shape](#record-shape) it discloses no more than the [metadata-at-rest
analysis](../SECURITY_DESIGN.md#metadata-at-rest-presence-and-shape) covers.

| Field | Type | Notes |
| ----- | ---- | ----- |
| `anchor` | string (ISO 8601, UTC `Z`) | The instant of the first agreed window's open, the phase the recurrence counts from. Both parties persist the **same** `anchor`, agreed out-of-band with the rest of the schedule, so both runners compute the same window opens. Stored UTC; a local-time cadence ("09:00 Tuesdays") is resolved to UTC at save and re-resolved only when the operator edits the schedule, so a daylight-saving shift does not silently move an unattended window. |
| `intervalDays` | integer, **1 through 366** | The recurrence period in whole days: the run window opens every `intervalDays` after `anchor`. A whole-day integer covers the daily, weekly, and monthly-approximated (for example 28- or 30-day) cadences the persona runs; sub-day cadences are out of scope for a partnership coordinated out-of-band, and calendar-month recurrence (the drifting "1st of the month") is not modeled -- an integer period keeps both runners' window computation identical without a shared calendar library. The ceiling is an annual cadence, the longest a partnership recurrence means anything at; it is also what keeps every window a surface renders on a calendar that exists (see [Every admitted schedule renders](#every-admitted-schedule-renders)). |
| `windowSeconds` | integer, **1 through 43200** | The run window's width: window *n* is open from `anchor + n * intervalDays` for `windowSeconds`. The width is chosen to dwarf realistic clock skew between the two machines (see [Clock skew](#clock-skew-and-the-window-width)); a several-hour width is the intended range, not a several-minute one. The structural floor is one second, but schedule entry enforces a UX-level minimum of **one hour**: width is the only skew mitigation the design has, so a seconds-wide window would guarantee perpetual self-inflicted misses. The ceiling is twelve hours, which sits below the shortest period the `intervalDays` floor admits, so no schedule this schema accepts can place two windows over one instant. |
| `nextWindow` | string (ISO 8601, UTC `Z`) | The open instant of the next window the runner plans to attempt. Derived from `anchor`, `intervalDays`, and the run bookkeeping (advanced past a completed or missed window), it is persisted rather than recomputed so a reader -- the runtime waking, or a next-visit surface -- sees the planned attempt without replaying history. After a miss it is the **next** window, never a sooner off-schedule retry: retry-at-next-window is the whole retry policy (see [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#retry-and-repeated-misses)). A runtime that wakes to find it in the past applies the catch-up rule below before anything else (see [Catch-up on wake](#catch-up-on-wake)). |
| `consecutiveMisses` | integer, at least 0 | The count of consecutive agreed windows that passed without a completed handshake, **regardless of which side was absent**: a window this runner sat out waiting for a peer that never arrived counts exactly as one this runner itself slept through (the latter recorded retroactively; see [Catch-up on wake](#catch-up-on-wake)). A `"succeeded"` outcome resets it to 0; a `"missed"` outcome increments it; **any other outcome leaves it unchanged**, because only a no-show signals the two runners are not meeting. A handshake that ran and failed (`"failed"`/`"desynced"`) means the partnership *did* meet, so it is a desync/attack question, not a coordination-drift one; a benign pre-peer failure (an `"input"` or `"terms-shortfall"` refusal) is likewise not a partner no-show. It drives only the reporting of a repeated-miss coordination problem, whose escalated state fires at **two** consecutive misses (see [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#retry-and-repeated-misses)); it never pauses the schedule and never changes `nextWindow`'s cadence. |

The object holds no operator-facing recurrence label, no timezone name, and no
window-outcome history: `anchor` plus `intervalDays` plus `windowSeconds` fully
determine every past and future window, and `lastRun` already holds the most
recent outcome. `consecutiveMisses` is the only cross-window state the retry
policy needs.

Window *n* is the half-open interval from `anchor + n * intervalDays` to
`windowSeconds` later: an instant exactly at the close belongs to no window, so
a window is elapsed the moment it closes. Two consecutive windows never both
contain the same instant, which the two fields' own ceilings and floors settle
rather than a cross-field rule: the widest admitted `windowSeconds` is twelve
hours and the shortest admitted period is one day, so a width can never reach
the next open. Every open is computed by fixed-millisecond arithmetic
from the stored UTC `anchor`, never by a local-calendar date add -- a calendar
add moves the instant by the offset change on the week a party's zone shifts,
which is exactly when two runners can least afford to stop overlapping. The host
zone is read once, at entry, to resolve a local wall-clock cadence into `anchor`
(see the `anchor` row); no later computation reads it. Every stored instant
has the UTC designator, and one that does not -- from a hand edit or a
tampered artifact -- is refused rather than read against the host zone, which
would otherwise place the same record's windows differently on every machine.

The schedule is a **local-only** field, not part of the persisted
`exchangeFile` document: a reschedule is neither a terms change nor a credential,
so it must not force the re-invite a document change requires (see [Record
shape](#record-shape)), and the CLI would hold it inertly. Each party enters it
locally at save-as-recurring, agreed out-of-band exactly as the terms and the
setup secret are (see
[SECURITY_DESIGN.md](../SECURITY_DESIGN.md#invitation-contents-and-confidentiality)).
Normatively: neither the invitation wire format nor the exchange-file document
holds the schedule, and no schedule field is ever sent to a server or to the
partner over the wire. Two parties who enter mismatched values never share an
overlapping window and record mutual misses until they reconcile out-of-band --
a benign coordination failure, never a desync or an attack. The operational
framing is in
[MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#where-the-schedule-is-agreed-and-where-it-lives).

Entry is implemented in `apps/web/src/recurring/scheduleEntryModel.ts` (the
validation, the resolution, and the cross-field condition) over the arithmetic in
`apps/web/src/psi/managed/managedSchedule.ts`; the form itself is the local-fields editor
in `apps/web/src/recurring/ManagedExchangeDetail.tsx`, which writes the schedule
through the store's one local-fields edit alongside the label and the max-age
policy.

#### What entry writes

Entry composes the whole object from four values the operator types -- the first
agreed window's local date and time of day, the period in days, and the width in
hours -- plus three rules that are entry's alone:

- **The anchor is resolved once.** The host zone is read here and nowhere else,
  turning the wall-clock cadence into the stored UTC `anchor` (see the `anchor`
  row). Re-opening the form reads the anchor back on the operator's own clock,
  and a save that left every cadence field as it was **writes no schedule at
  all** rather than resolving again. A wall clock a zone skips or repeats does
  not round-trip, so re-resolving on an unrelated save (a label edit, a max-age
  change) could walk the agreed instant away from the partner's. Omitting the
  field, rather than writing back the object the form opened on, is what keeps
  such a save off the runner's bookkeeping too: `nextWindow` and
  `consecutiveMisses` live in this same object and advance under a page left
  open, so a mount-time snapshot written back would rewind them to a window
  already accounted for. The reuse is **per field**, not all-or-nothing:
  a save that edited one cadence field takes the anchor and the width from the
  stored object verbatim while the fields displaying them are untouched, and
  writes the rebuilt schedule because the operator moved something. The fields
  hold the cadence to the minute and the width to the hour, coarser than the
  record stores either, so re-deriving them from what they display would rewrite
  a stored value at a resolution the operator never saw -- an edit to the period
  alone silently moving an agreed anchor or width.
- **`nextWindow` is the first window not yet closed at the save**, not the
  anchor's own window. A cadence anchored to a date already past would otherwise
  hand [catch-up](#catch-up-on-wake) every window that elapsed before the
  partnership agreed the cadence, and count each one a miss it never had.
  Entering a cadence while one of its windows is already open plans **that**
  window, so the run in progress can meet it.
- **`consecutiveMisses` starts at 0** on an edited cadence. The stored count
  speaks for windows on the lattice the edit replaced.

Entry also enforces the field bounds in the table above as its own validation, so
an out-of-range value is refused at the field rather than at the store write, and
the width floor of one hour that the schema's structural floor does not state.
Those bounds hold what the operator **enters**. A width the record already
states is shown back as the exact value it is rather than rounded, and stands.
Such a width is one merely finer than the field's unit, 5400 seconds for an hour
and a half, or one below the floor from an import or a hand-edited record. The
save holds its seconds through untouched, and neither the unit nor the floor is
applied to it. Rewriting it would change what the partnership agreed without
saying so, and
refusing it would block the form's other edits -- a label, a max-age policy -- on
a value the operator never typed. Only a width the operator changes takes entry's
bounds and the whole-hour rule the field asks for.

One cross-field condition is **reported rather than refused**. When
[`tokenMaxAgeDays`](#persisted-across-runs) is set and `intervalDays` is at or
past it, the stored secret lapses before the window that would have refreshed
it -- the partnership stops on a lapsed credential and recovery is a re-invite.
Entry states that in the bound's own terms ("must run or be renewed within N
days") and leaves the save available, since an operator who renews by hand is
entitled to the cadence. The policy remains opt-in and off by default, so the
condition is unreachable for an exchange that set no bound.

#### Every admitted schedule renders

Every surface that shows a window formats the instant directly and has no
fallback for one no calendar has. What makes that total is the pair of ceilings
on `intervalDays` and `windowSeconds`: the window containing an instant, and the
first window after it, both then land within one period plus one width of that
instant, which is inside the representable range for any clock reading a machine
can hold. A period or width past the ceilings is refused by the schema, so it
never reaches a surface as a record at all. The attended list read parses
strictly and rejects wholesale on it, so the whole read fails and the
saved-exchanges list routes to its read-failed recovery surface. That surface's
separate per-entry diagnostic read is where the offending record is identified
and discarded. The display derivation also refuses a reading instant within one
period plus one width of the end of the representable range, which is the other
half of the pair.

**The unattended read is per-entry, not strict.** A wake reads the store one
entry at a time. An entry this build cannot parse is **skipped**, reported as
its own skip in the wake's diagnostic line, and every other due record still
runs. Such an entry holds an out-of-bounds period or width from an artifact
imported or hand-edited before these ceilings existed, or is any other record an
app upgrade invalidated. Such an
entry stays unparseable until an operator discards it, so a wholesale rejection
here would be standing rather than transient: no exchange in the store would run
unattended for as long as the entry sat there, with nobody present to meet the
recovery surface. The skip costs one exchange its scheduled runs; the rejection
would cost all of them. The attended read stays strict precisely so the operator
does meet that surface, which is where a skipped entry is resolved.

The wake reads each record's [local sibling
state](#the-backup-marker-the-spent-state-and-the-import-marker-local-siblings-never-in-the-artifact)
the same way. A record whose sibling entry this build cannot parse -- a member a
newer deployment added, or a corrupted value -- is skipped as unreadable, since
that entry may be the one recording a hand-off, and every other record still
runs.

#### Catch-up on wake

A runner does not tick while its machine sleeps, so a runtime can wake -- a
laptop reopened after a week on a daily cadence, the app relaunched after a
reboot -- with `nextWindow` in the past and one or more windows fully elapsed.
On wake, before attempting anything, the runner applies one catch-up rule:

- Every fully-elapsed, unattempted window counts as **one miss each**:
  `consecutiveMisses` is incremented by the count, and `lastRun` records the
  most recent elapsed window as `"missed"`. A window that opened at or after the
  operator's [compromise response](#the-operators-response-to-it) is the one
  exception: it is skipped rather than missed, on the rule [a due window under
  that response](#a-due-window-under-the-operators-compromise-response) takes.
- `nextWindow` advances past every fully-elapsed window to the first window not
  yet closed: if the current instant falls inside that window, the runner
  attempts it immediately; otherwise `nextWindow` is the first window opening
  after the current instant.

A window is **unattempted** when no run bookkeeping falls inside it. A
`"succeeded"` entry stamped after a window closed and before the next one opens
is that window's: the stamp is the run's completion, so a run met inside the
window can finish past its close, and a success in the gap follows that
window's verdict in time anyway. Any other entry in the gap speaks for no
window. A window that does have a `lastRun` was met, so it takes that entry's verdict from the
`consecutiveMisses` row above rather than counting as a miss, and its own
bookkeeping stands rather than being overwritten by the catch-up's `"missed"`
entry. The same reading determines the window still open at the wake: a
`"succeeded"` run inside it satisfies it, so `nextWindow` advances past without
an attempt -- which is how an attended run inside an agreed window discharges
that window -- while a run that failed inside it does not, leaving the rest of
the window attemptable. Bookkeeping the wake cannot stand behind determines
nothing: a `lastRun` whose `at` is stamped ahead of the wake instant -- a
forward-skewed clock, or a hand-edited record -- discharges no window, whether
the window it names has opened or not, so the schedule keeps planning that
window and attempts it while it is open. Deferring the verdict to a later wake
is the conservative direction: no agreed window is skipped on a stamp from the
future, and none is counted as missed before its close.

Catch-up applies these verdicts **window by window, oldest first**, never as a
net over the span: a `"succeeded"` window resets `consecutiveMisses` to 0 and
only the windows after it rebuild the count, wherever in the run that window
sits -- including the window still open at the wake, whose recorded success
resets the count the elapsed windows before it raised.

One window the walk does not visit is read the same way before it starts: the
window immediately preceding `nextWindow`, whose recorded `"succeeded"` run
resets the count. That window is where a run the schedule advanced past as
`"unattempted"` lands its outcome -- the advance happens while the other
context's run is still in flight -- so without this reading a completed exchange
inside an agreed window could fail to discharge the miss run, and the escalation
threshold could be crossed a window early. The reach is exactly one window: a
success further back sits behind windows the walk has already counted on their
own evidence, and leaves them counted.

The rule keeps both fields accurate. `consecutiveMisses` reflects the true count
of elapsed misses whichever side was absent, and the runner lands on a live
window rather than replaying stale past ones. Crossing the two-miss escalation
threshold during catch-up fires the repeated-miss surface at the wake -- which
is how a persistently absent party learns of a miss pattern late rather than
never (see
[MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#retry-and-repeated-misses)).

The wake's bookkeeping write is **conditioned on the plan it read**: it lands
only while the stored `anchor`, `intervalDays`, `windowSeconds`, `nextWindow`,
and `consecutiveMisses` are still the ones the catch-up computed against, and is
dropped whole otherwise. Nothing serializes one wake's write against another's,
or against an operator's edit, so an unconditioned write could rewind
`nextWindow` and lower `consecutiveMisses` behind newer bookkeeping -- deferring
the two-miss escalation by exactly the misses it erased -- overwrite a re-plan
the operator had just made, or restore a count they had just cleared on the plan
the wake was running. A dropped write costs nothing: the next wake recomputes
the same rule against the stored plan.

The import path is the rule's second consumer: an imported backup holds the
snapshot's `nextWindow`, typically in the past by the time the artifact is
restored, and the first wake after an import applies the same catch-up --
elapsed windows counted, `nextWindow` advanced to a live window -- before any
attempt.

#### Occupying a due window

A window catch-up lands on and finds open is **occupied**, not waited out in one
call. The runner makes bounded re-attempts across it: each attempt waits for the
partner's runner up to the human-timescale budget both one-shot roles share,
clamped to what is left of the window -- as is each seat's registration with the
signaling server, bounded by the smaller of its own
[budget](WEBRTC_TRANSPORT.md#budgets) and that remainder -- and the next
attempt begins no sooner than a fixed pacing interval after the last one
started, up to a cap on attempts per window. One window-long wait would put the whole window on a single broker
registration surviving that long; the pacing and the cap are what keep an attempt
that fails immediately from spending the window in a loop. The pacing interval is
itself bounded by the close, which ends the occupancy in any case.

**A limit of the occupancy.** The lock is held per attempt, not per window. An
attempt that spends its full peer wait outlasts the pacing interval, so the next
attempt takes the [single-writer lock](#the-secret-is-a-linear-resource) back at
once. But an attempt that fails fast leaves the lock free for the rest of its
pacing gap, and a window whose attempt cap runs out before the close leaves it
free for the tail (see
[MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#cross-tab-single-writer-locking-web-locks)).
An operator's own Run can take the lock in any such free interval and rotate
the shared secret. The occupancy does not attempt again after it: the attempt
after the Run finds its success stamped inside the window on the record it
reads (below) and ends the occupancy as `"succeeded"`, as catch-up would
discharge the same window. An attempt already under way when the Run's success
landed cannot write over it either: the write rule in [Recording a run
outcome](#recording-a-run-outcome) holds a failing run's entry off a success
stamped after that run began. An attempt that
instead meets that Run still in flight -- the lock spans its payload exchange --
is refused rather than queued, since the scheduled path takes the lock
fail-fast: the window's disposition is `"unattempted"`, the occupancy ends
there, and the schedule advances past the window, so the window is consumed
rather than re-attempted against the rotated record. A designed
inter-attempt yield -- one that makes the free interval wide enough for an
attended Run to take rather than leaving it to how an attempt happened to
fail -- is deferred rather than designed away.

An occupancy belongs to one record. Each wake dispatches every due record that is
not already occupying its window, so an exchange holding its own window open for
hours neither blocks nor delays a second exchange whose window opens during it.

Two boundaries the occupancy holds:

- **The window's close is reached as a no-show, never as an abort.** The last
  attempt's wait is clamped to the close, so a window nobody arrived in ends as
  the partner absence it is. Signalling the close through the run's abort instead
  would record the operator's own cancellation (see the `lastRun` `failureKind`
  row), which is a different fact.
- **Nothing is re-attempted once the data exchange began.** Past that phase
  boundary this run's payload could already have reached the partner, so a
  re-attempt would disclose a second time. The boundary gates the retry rather
  than the failure's kind.

Within those, an attempt is re-made only for a partner who never arrived and for
a failure with no determinate local cause. A lapsed `expires`, a copy an export
handed off, a hand-off state the run could not read, an unusable input, a
shortfall against the standing terms, a refused disclosure, a failed rotation
persist, and a handshake that failed closed each reproduce identically on the
next attempt, so each ends the window's occupancy where it happened.

The hand-off is the one of them a window can meet after starting cleanly, and it
is why the spent state is read per attempt rather than per tick: the runner's own
skip below reads it once when the wake begins, while the run path re-reads it
inside the [run+rotate lock](#the-secret-is-a-linear-resource) at the start of
every attempt. A hand-off confirmed while a window is open therefore refuses that
attempt outright rather than being re-attempted until the window closes; the
refusal itself is non-retryable and counts no partner miss, but a window that
already found the partner absent before it still folds to `"missed"` under the
table below.

The record itself is read on that same per-attempt cadence, and each attempt
runs the record that read returns -- its secret, input handle, document, and
max-age policy -- never the copy the window was claimed on, so an edit, a
re-pointed input, or an attended rotation reaches the attempts after it. The
same read ends the occupancy:

- A record deleted while its window is being occupied stops the attempts after
  the delete, and that window is accounted for nowhere, there being no record
  left to write its bookkeeping onto.
- A record whose schedule was dropped, or whose `anchor`, `intervalDays`,
  `windowSeconds`, `nextWindow`, or `consecutiveMisses` no longer match the plan
  the window was claimed on, stops the same way with no disposition: the
  window's conditioned write would be dropped, and the stored plan is the
  operator's.
- A record that lost its input handle, or holds no shared secret, stops with no
  disposition, as the passed-over records below do.
- A record whose `lastRun` is a `"succeeded"` entry stamped inside the window
  ends it as `"succeeded"`: another context met the partner in it.

The window's disposition folds every attempt it took, written once for the window
rather than once per attempt. A further disposition, `"skipped"`, is decided by
the record rather than by an attempt and so never reaches this fold (see [A due
window under the operator's compromise
response](#a-due-window-under-the-operators-compromise-response)):

| Disposition | The window | `consecutiveMisses` | Advance has a `lastRun` |
| ----------- | ---------- | ------------------- | --------------------------- |
| `"succeeded"` | an attempt completed the exchange, or another context recorded a success inside the window | reset to 0 | no -- the run recorded its own |
| `"missed"` | none did, at least one found the partner absent, and none failed in a way that proves the partner was met | incremented | no -- the run recorded its own |
| `"failed"` | its attempts failed, none of them on an absent partner -- or one of them proved the partner was met | unchanged | no -- the run recorded its own |
| `"unattempted"` | its last attempt was refused the single-writer lock, held by another context | unchanged | no -- the window has no bookkeeping |

The `"missed"` row folds rather than reading the last attempt because an attempt
that spent its whole peer wait has already answered the question the miss count
asks -- whether the two runners met in this window -- and pacing starts the next
attempt at once after a wait that long. Reading the last verdict alone would
therefore let one trailing transient failure record a window of no-show waits as
`"failed"`, which leaves the count untouched and loses the miss entirely.

A failure that **proves the partner was met** decides the same question the
other way, and outranks any absence the window found earlier. A handshake that
failed closed ran against a partner on the far end of an open channel, a
rotation persist fails only after that handshake yielded the rotated secret, and
any failure past the data-exchange boundary postdates both. Per the
[`consecutiveMisses`](#the-schedule-object) row, a partnership that met is a
desync/attack question rather than a coordination-drift one, so such a window
records `"failed"` and counts nothing. A failure with no determinate cause
proves nothing either way and leaves the fold to the absence above.

`"unattempted"` is the one disposition that is not an outcome the record can
hold, and the one that stands whatever the attempts before it found: another
context was running this very record, so the window is that context's to account
for rather than this runner's, and the schedule advances past it recording
neither an attempt nor a miss. The advance happens while that run is still in
flight, so its bookkeeping lands in a window already advanced past; a
`"succeeded"` one is credited at the next wake (see
[Catch-up on wake](#catch-up-on-wake)), while any other outcome it records leaves
the window uncounted. Every other disposition's `lastRun` is written by the run
itself, so the schedule advance has none and cannot contend with it.

Three records are passed over rather than attempted, each leaving its window
with no disposition at all -- the wake that finds the window elapsed counts it
exactly as one this runtime slept through:

- One this device has handed off (its local `spent` state), by either export.
- One with no persisted `inputFileHandle`, which has no unattended read of the
  input at all.
- One whose runtime stopped while the window was still open.

The rules above are implemented in `apps/web/src/psi/managed/managedScheduleRunner.ts`;
the browser host that wakes them, and the installed-runtime gate that decides
whether it runs at all, are `apps/web/src/psi/managed/managedScheduleRuntime.ts` and
`apps/web/src/components/ScheduledExchangeRunner.tsx`.

#### A due window under the operator's compromise response

A window that falls due while the record's standing condition holds the
operator's [response](#the-operators-response-to-it) is **skipped**, decided
before each attempt connects and read off the stored record rather than
re-derived from a failure. The operator has said the secret may be in someone
else's hands; a scheduled run would put exactly that secret on exactly that
channel again, with nobody present to see it happen.

A skipped window rotates nothing, and connects to nobody from the answer
forward: an answer standing when the window falls due leaves it unattempted
altogether, and one written while it is being occupied ends the occupancy where
it lands. Its bookkeeping is the same single conditioned write every other window
takes:

- `nextWindow` advances past it, so the runner meets the next agreed window and
  nothing re-decides this one.
- `consecutiveMisses` is left where it stood: the window ended on this device's
  own withhold rather than on a partner's absence, so it is no evidence about
  whether the two runners are still meeting, and it must not carry the
  coordination prompt a pattern of absences earns (see
  [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#retry-and-repeated-misses)).
- The advance carries a `lastRun` of `{"outcome": "skipped"}`, stamped at the
  instant the window was skipped. It is what the exchange's page and the
  between-visit notification read the skip from.
- No standing condition is raised or altered. The condition the answer rides on
  is the one an earlier failure raised, which the window's write leaves as it
  found it.

A window that opened under the response and was already elapsed when the runner
woke folds the same way in [catch-up](#catch-up-on-wake): it counts no miss, and
the `lastRun` the catch-up write carries for the most recent such window states
`"skipped"` at that window's close. A window that opened before the operator
answered is still a miss -- nothing held it back at the time.

It is not one of the three passed-over records above: those leave their window
with no disposition, to be counted as missed at the wake that finds it elapsed,
while this one is accounted for where it happened.

Scheduling resumes at the next due window as soon as the response is cleared,
which is the three acts that clear the condition holding it and nothing else
(see [The standing condition](#the-standing-condition)). The attended run is not
withheld: only the unattended path decides without the operator, and only the
unattended path is held.

### Clock skew and the window width

The two runners never exchange a clock reading; each opens and closes its window
by its own machine clock against the shared `anchor` and `intervalDays`, so an
overlapping window depends on both clocks agreeing closely enough. The mitigation
is width, not synchronization: `windowSeconds` is chosen to dwarf realistic skew
(a several-hour window against the seconds-to-minutes skew of a machine with any
working time source), so two reasonably-set clocks overlap comfortably and only a
grossly wrong clock on one side turns a scheduled run into a benign miss. The
design adds no time-sync protocol; a persistently miss-producing clock is a
local operational problem the miss reporting (see
[MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#retry-and-repeated-misses)) points
the operator at, resolved by fixing the machine's time source, not by the app.

### Re-supplied each run

These are never persisted in the record. They are supplied at each run -- by
the scheduled runtime, or by the operator on an attended run.

| Input | Why it is not persisted |
| ----- | ----------------------- |
| The input file's contents | Never persisted -- the record holds a pointer at most (`inputFileHandle` above), never content. The file is read in the browser at each run and never uploaded, exactly as the one-shot flow reads it (see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#invitation-contents-and-confidentiality)). See [The input file each run](../MANAGED_EXCHANGE.md#the-input-file-each-run). |
| Any connection credential | The persisted document's connection block is composed from a credential-free locator (see [The connection block](#the-connection-block-credential-free-by-composition)), so no credential is representable in the record. |
| The live rendezvous / peer id | Derived fresh each run from `sharedSecret` under the label the local `side` field selects (see [Derived, never stored](#derived-never-stored)); storing it would duplicate a value that changes with every rotation. |
| The session key and AEAD keys | Ephemeral per run; derived by the handshake and discarded after. Never persisted. |

## The secret is a linear resource

The persisted `sharedSecret` is the single most consequential field, because it
is not an ordinary cache entry: it is a **linear resource**. After a successful
run, both parties independently derive the same replacement secret from the
key-exchange session key and the old secret is retired; there is exactly one live
secret shared between the two parties at any time, and neither party keeps the
old one. Two consequences follow, and both are normative:

### Single-owner invariant

A managed record's `sharedSecret` must be advanced (used to run, then rotated and
re-persisted) by **one device only**. If two devices both hold a copy and both
run, they fork the secret permanently: after the first device rotates, the second
device's copy is stale, and no automatic reconciliation exists (there is no grace
window; see [Desync detection and
recovery](../MANAGED_EXCHANGE.md#desync-detection-and-recovery)). The guard on a
single device is a cross-tab single-writer lock (Web Locks) held from a run's
begin through the success stamp it writes, so **one exchange of a record is in
flight at a time** on a browser profile: a second tab, a second attended Run, and
a scheduled attempt are each refused or queued across the whole run, the payload
exchange included, rather than across its rotation alone. Once it holds the
lock, a run reads the record again and runs that copy -- its secret, side,
terms, and max-age policy -- rather than one its surface or its scheduled window
read earlier, so each run, attended or scheduled, authenticates with and rotates
the secret stored when it takes the lock. A [hand-off
spend](#the-backup-marker-the-spent-state-and-the-import-marker-local-siblings-never-in-the-artifact),
a [command-line hand-off taken back](#taking-a-command-line-hand-off-back), and a
[re-invite's rotation write](#the-operators-response-to-it) each contend for that
same lock, so they too are refused while an exchange is in flight.
The partner influences how long the payload exchange takes, so the run's cancel
reaches that width: it closes the run's connection, which rejects the wait the
exchange is parked in, so the run ends and the lock releases without the holding
tab being destroyed. Three limits of that remain. Between the channel being
acquired and the transport open resolving, the cancel reaches nothing: the
connection-open wait takes no signal of its own, so only its own 30-second
ceiling ends it, partner-influenced only up to that same ceiling, and the run
holds the record's single-writer lock throughout that handshake phase. The
cancel lands at the run's next act on the connection, so one arriving inside a
local PSI round takes effect when that round next reads or writes. And a run
nobody cancels holds the lock for as long as the partner takes, up to the
connection's inactivity budget; a destroyed tab still releases it.
A cancelled run cut after this party's payload send files its entry in the
[accounting of disclosures](#the-accounting-of-disclosures) like any other run
that disclosed, and so does a run a mid-exchange transport drop cuts in the same
window: the scope is the record-owed region, not how the run ended (see
**When an entry is written** under [the accounting of
disclosures](#the-accounting-of-disclosures)). One cut before that point files
nothing, and owes nothing -- no payload frame had reached the transport. Either way the record's own `lastRun` stamps the run `"failed"`, with
`failureKind` `"cancelled"` or `"transport"`, which does not itself say which
side of the send the run stopped on; the accounting does. And the cancel does not
discard what the transport already holds buffered: the teardown's close flushes
rather than drops, so a cancel does not mean nothing further leaves the device.
Export/import between devices is **migration, not sync** (the source copy is
invalidated on export). Both are specified in
[MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#single-device-ownership).

### Persist-before-success ordering

The rotated secret must be durably persisted **before** this party begins the
data exchange -- the first peer-visible act after the handshake. The protocol
has no discrete peer-visible success signal to gate on: both sides rotate at
handshake completion, and the exchange's terminal act is a fire-and-forget final
send, so the data exchange itself is what the persist must precede. Concretely,
within a single run:

1. Once the partner has connected, and before the key exchange starts, the
   [rotation-in-flight marker](#the-rotation-in-flight-marker) is written in a
   strict-durability transaction awaited to `complete`.
2. The handshake completes and yields the `AuthResult`
   (`{ sessionKey, rotatedSecret, applyEncryption }`; see
   [PROTOCOL.md](PROTOCOL.md#shared-secret-rotation)).
3. `sharedSecret` (and `expires`, refreshed from `tokenMaxAgeDays` when a
   policy is set) is written, and the marker removed, in one write to
   IndexedDB in a transaction opened with **`{ durability: "strict" }`**, and the
   write is awaited to the transaction's `complete` event, before step 4. Strict
   durability requests OS writeback before `complete` fires; the default
   (relaxed) durability fires `complete` once the write is visible in-process,
   **before** OS writeback -- surviving a tab or renderer crash but not an OS
   crash or power loss. Strict narrows that gap without closing it (it is
   honored variably across engines and is still not a forced media flush).
4. Only then does the party begin the data exchange and, on completion, mark
   `lastRun.outcome = "succeeded"`.

This is the browser analog of the CLI's persist-then-exchange ordering, where the
key file is written (through an atomic, fsync-durable path) immediately after the
handshake rotates the secret and before the data exchange runs (see
[CREDENTIAL_STORAGE.md](CREDENTIAL_STORAGE.md#posix-write-discipline)). Its
guarantee is precisely scoped: it eliminates **this party's contribution** to
the desync window and provides renderer-crash consistency. It does not cover the
partner's independent persist failure -- neither side can know whether the
other's save succeeded, the same one-sided limit the CLI states when its
key-file write fails after rotation -- nor an OS crash or power loss under the
durability limits above, nor wholesale storage eviction (see
[MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#surviving-storage-eviction)). That
residual is covered by fast re-invite, not a stronger at-rest guarantee.

### The rotation-in-flight marker

The persist-before-success ordering cannot close the one-sided window between
the handshake and the rotation write: a tab killed there leaves the partner on
the rotated secret and this device on the old one, and on WebRTC the rendezvous
ids and the relay key both derive from the secret, so each side then records a
no-show at every window. The `rotationInFlightSince` marker makes that window
visible after the fact. It changes nothing about the secret: the record still
holds exactly one live `sharedSecret`, and no previous secret is kept.

- **Written** by the run, inside its run+rotate lock, once the partner has
  connected and before the key exchange starts
  (`markManagedExchangeRotationInFlight`,
  `apps/web/src/psi/managed/managedExchangeStore.ts`), as a strict-durability,
  field-scoped write awaited to `complete`. A marker already present keeps its
  first instant. A no-show never reaches it, and a write that fails stops the
  run before the key exchange, with nothing rotated.
- **Removed** by the rotation write that stores the rotated secret -- the run's
  own and a re-invite's -- in the same transaction, and by a take-back that
  replaces the secret. A recorded outcome supersedes it: the bookkeeping write
  that records a key exchange reaching a verdict at or after the marker -- a
  success, a failed-closed handshake, or a rotation not saved, the last two
  with the standing condition they raise -- removes it in the same write
  (`applyManagedExchangeLastRun`), while a cut run, a dropped connection, a
  refusal before connecting, and every no-show leave it standing.
- **Read** as the `"partial-rotation"` failure tier
  (`apps/web/src/psi/managed/managedFailureTiers.ts`) only where a no-show is
  the record's last run, the marker predates that run, and no standing
  condition is raised: the pattern a secret the partner saved and this device
  did not produces. A live no-show is read the same way against the record as
  it stood at launch, where no standing condition is raised and no outcome
  recorded since the marker supersedes it. The tier is Tier 1, recovered by re-invite with no attack
  checklist. It never displaces a standing condition, and a failed-closed
  handshake beside a marker stays the unexplained tier: the marker is evidence
  for the benign reading only alongside the no-shows it predicts.
- **Not carried** between devices or applications: the export artifact and the
  command-line key file this app writes hold none. A command-line key file
  holding the CLI's own marker (see
  [EXCHANGE_FILE.md](EXCHANGE_FILE.md#the-rotation-in-flight-marker)) is read
  and the marker dropped, since an import is already read through the import
  marker; an artifact whose key block holds one is refused whole, as for any
  unknown field.

## Derived, never stored

Two per-run values are always derived from the persisted `sharedSecret` and never
themselves persisted, so persisting the secret is sufficient to reconstruct them
and there is no second value to keep consistent with it:

- **The rendezvous peer id.** Derived from the decoded secret under the role
  label the local `side` field selects; the construction is specified in
  [PROTOCOL.md](PROTOCOL.md#webrtc-rendezvous-peer-id-derivation). Because it
  derives from the secret, it changes with every rotation, so it cannot be a
  stored field -- storing it would strand a stale id after a rotation.
- **The rotated replacement secret.** Derived from the key-exchange session key
  (see [PROTOCOL.md](PROTOCOL.md#shared-secret-rotation)). It is written into
  `sharedSecret` by the persist-before-success step above; the derivation itself
  is core's.

The managed record introduces no new KDF, info string, or salt: it persists the
same 32-byte secret the invitation and rotation already define, and every
derived value uses the labels those constructions hold. The record's own at-rest hygiene
(see
[SECURITY_DESIGN.md](../SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges))
is a secondary control layered over that secret, not a change to how it is
derived or rotated.

## Export artifact

The managed record can be exported to a file for device migration and
eviction recovery (see [the durability
backbone](../MANAGED_EXCHANGE.md#the-durability-backbone-exportimport)).
The artifact's shape and custody model:

- **Contents.** The persisted record fields above -- the exchange-file document
plus `sharedSecret`, `expires`, the schedule, and the local bookkeeping, the
browser analog of handing over `alcove.yaml` and `.alcove.key` together --
**minus both platform handles**. A `FileSystemFileHandle` and a
`FileSystemDirectoryHandle` are device- and profile-local platform objects with no
file serialization, so the export omits them and the first run after an import
re-acquires the input file by selection while the output folder is granted again.
In each handle's place the export writes a **marker in `local` recording that the
source record held it** -- `heldInputFile` and `heldOutputFolder`, written only
when the handle was there, omitted rather than written `false`. They are what lets
an import name the grants to take again on the importing browser (see [Eviction
recovery is the import
flow](../MANAGED_EXCHANGE.md#eviction-recovery-is-the-import-flow)), and an
artifact holding neither marker -- a source that held no handle, or a file
written before the markers existed -- names nothing rather than guessing. The
record's `id` is likewise not included: it is a device-local record
  identifier, not partnership data, and an import is a **take-over that mints a
  fresh local record**, not a copy of the source's identity. The artifact does
  not rotate -- it snapshots the secret current at export -- so a stale artifact
  stays usable until the partnership rotates past it or any `expires` it holds
  (stamped when a max-age policy is set) lapses; the backup state prompts
  re-export after each rotation.
- **Top-level shape.** The artifact is a JSON document with an `artifactVersion`
tag and three parts that keep the two CLI halves separable from the browser-only
fields. The tag is its own reader-rejects-unknown literal --
`alcove-managed-exchange-backup/v3`, the single value this build accepts, and
the only one it writes -- distinct from the record's `schemaVersion`: the on-disk
artifact format versions independently of the stored record. Every other value
is refused on the literal rather than migrated, the superseded
`alcove-managed-exchange-backup/v2` being recognized only far enough to say so
(below). `exchangeDocument` embeds the exchange-file document as a
valid `alcove.yaml` (the snake_case YAML the CLI loads, serialized through the
same discipline the mint layer applies to a validated spec). `key` is the
`.alcove.key` pair (`sharedSecret` and, when a bound is in force, `expires`).
And `local` holds the browser-only fields the two CLI artifacts do not (`label`,
`side`, `schedule`, `lastRun`, `standingCondition`, `tokenMaxAgeDays`, and the
two held-grant markers above). The [standing
condition](#the-standing-condition) travels, the operator's `response` to it
included, because an export that dropped either would be a fourth way to clear
one, and only the operator's acknowledgement, a re-invite, and a delete may. The
artifact's field is optional and omitted where none stands, so an import holding
none installs a record whose condition is the `"none"` form. The response rides
only in an `alcove-managed-exchange-backup/v3` artifact: the `artifactVersion`
literal moved for it, so a build that does not know the member refuses the file
whole on the tag. Nothing strips it -- an artifact holding an answered condition
either imports with the answer or is refused entire. The artifact's own
  JSON keys are `camelCase`, by design: the `.alcove.key` file the CLI reads is
  itself `camelCase` JSON (`sharedSecret`, `expires`), parsed without a
  `snake_case` conversion, so a `camelCase` `key` block is what maps onto a valid
  key file with no renaming. Only the embedded `exchangeDocument` is `snake_case`,
  because the CLI loads it as YAML through `camelizeKeys`.
- **What an older reader does with an optional `local` key.** The
  `artifactVersion` literal does not move for any of the optional keys in
  `local` -- `standingCondition` and the two held-grant markers, `heldInputFile`
  and `heldOutputFolder`, each written only where there is something to write --
  so the format does not version for them. That does not make an artifact
  holding one readable everywhere. A build whose `local` schema does not know
  the key refuses the artifact whole, because the strict reader-rejects-unknown
  schema rejects an unknown nested key and the top-level parse fails with it.
  That rule reaches only as far as the reading build's schemas are strict. The
  operator's `response` sits one level further in, inside the condition, and a
  build whose condition schema does not know the member drops it rather than
  refusing the file -- installing a record whose condition holds no answer and
  offering the fresh invitation over it. That is why the response moved the
  `artifactVersion` literal to `alcove-managed-exchange-backup/v3`: such a
  build refuses the whole file on the tag and reconstructs no record from it.
  The nested schemas do run, and one rejection can name the tag and a nested
  path together; what the tag fixes is that nothing is installed, not that
  nothing else was read. This build's condition schema is strict, so a member
  it does not know is refused rather than dropped from the record an import
  would otherwise reconstruct.
  The import surface holds that rejection apart from a file whose bytes do not
  parse at all: a document that parses and then fails the schema names a newer
  build's export as a likely cause and states the two ways past it -- bring the
  page up to date, or write the file from a build that matches -- alongside the
  wrong-file and modified-file checks. A file tagged
  `alcove-managed-exchange-backup/v2`, the format this one replaced, is the
  other direction and is told apart from both: neither remedy applies to it, so
  the refusal states that the backup is from an earlier version and points at
  setting the exchange up again with the partner.
- **What a reconstructed `lastRun` can and cannot assert.** The `local.lastRun`
  block is validated against the record's own `lastRun` schema rather than a
  narrower one, so an artifact is accepted with every outcome and
  `failureKind` the [record shape](#persisted-across-runs) names, `"handed-off"`
  among them, and an import copies what it read onto the reconstructed record
  verbatim. That widens what the surfaces display and nothing else: the run
  path's custody refusal reads the [spent sibling
  entry](#the-backup-marker-the-spent-state-and-the-import-marker-local-siblings-never-in-the-artifact),
  never `lastRun`, so an artifact asserting `"handed-off"` misdescribes the tier
  shown for a record that is in the operator's own custody. It cannot make a
  record run that would otherwise refuse, and it cannot stop a refusal the spent
  entry earns.
- **CLI-separable format.** The record is the CLI's config-plus-key pair kept as
one browser object, and its export stays consumable by the CLI toolchain rather
than becoming a third format. The embedded `exchangeDocument` is a valid
`alcove.yaml`. The `key` block's `sharedSecret` and `expires` pair maps onto a
valid `.alcove.key`, and can be lifted out verbatim, since the field names
already match the key file's. The `local` block's fields are cleanly separable
and ignorable. This is a format-compatibility commitment, not a
  claim the embedded exchange runs there: the composed webrtc connection holds
  no `role`, the field the CLI derives its rendezvous peer id from and refuses a
  webrtc run without (see [Role: a local `side` field](#role-a-local-side-field-not-the-document)).
- **Plaintext, custody-protected.** The artifact is a plaintext credential file,
  not passphrase-encrypted. Passphrase encryption is not done: the
  record must be usable with nobody present to supply a passphrase, and the
  artifact adopts the CLI key file's trust model instead. `.alcove.key` is a
  plaintext credential protected by custody and storage permissions, not by a
  passphrase, and the export asks for the same handling: owner-only storage,
  never an unencrypted transmission channel, and the backup guidance in [Key
  file security](../SECURITY_DESIGN.md#key-file-security). An operator who wants
  encryption at rest stores the file in an encrypted location or secrets
  manager, exactly as the CLI's backup guidance says.
- **A captured export is a captured credential.** It stays usable until the
  partnership rotates past it -- which a dormant partnership may not do for
  months -- so the response to a lost or copied artifact is the [compromise
  response](../SECURITY_DESIGN.md#compromise-response) (notify the partner
  out-of-band, re-invite), not quiet deletion.
- **No anti-rollback.** The record has no rotation epoch and no history, and
  the handshake gives the partner no way to recognize a superseded copy, so a
  restored artifact (or a browser-profile/VM snapshot) silently re-arms whatever
  secret it holds: still-current (the captured-credential case above) or
  rotated-past (a guaranteed desync at the next run). Source invalidation on
  export is an operator-cooperation property, not a cryptographic one. A
  monotonic rotation epoch held in the record and checked in the handshake
  would let a party detect a stale or forked peer; it is a future core hardening,
  deferred alongside the grace-window mitigation (see
  [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#rollback-at-rest-copies-can-silently-resurrect)).

### The backup marker, the spent state, and the import marker: local siblings, never in the artifact

Three pieces of derived-backup, migration, and restore state live **beside** the
record, in a separate origin-local store keyed by the record `id`, and are
**neither record fields nor artifact contents**:

- **The backup marker** (`backedUpAt`, an ISO 8601 UTC instant) records when a
  backup was last taken. It is the input to the derived backup state the UI
  surfaces (see [Moment-anchored backup
  surfaces](../MANAGED_EXCHANGE.md#moment-anchored-backup-surfaces)), which is
  simply **marker present / absent**: a present marker is "backed up", no marker is
  "backup needed". "Taken since the last rotation" is enforced **structurally**, not
  re-derived from `lastRun`, by the write-side rules below -- which also settle which
  export the state is about:
  - **A marking export binds the marker to the bytes it serialized.** The backup and
    migration exports read the current record, serialize the bytes they will download,
    and stamp the marker in one atomic store step (a cross-store
    read-serialize-and-mark), then download exactly those bytes, so the marker can only
    ever attest the secret the file holds. A stale tab or a stale in-memory record
    cannot mark a secret it did not serialize. Serializing inside the step is what binds
    the marker to bytes that exist: a step that resolved without serializing would leave
    a marker attesting bytes nothing produced, so it fails the export instead.
  - **The command-line export marks nothing.** What it writes is the CLI's own
    `alcove.yaml` and `.alcove.key`. The import takes that pair back ([Importing
    the key file beside a configuration](#importing-the-key-file-beside-a-configuration)),
    so the files can restore the secret, and the export still stamps no marker: the
    marker attests a file nothing rewrites, and the key file is the command line's
    working copy, which every command-line run rewrites with the secret it rotated
    to, on a machine this browser cannot see. A marker stamped for it would read
    "backed up" about a copy the first run there replaces, and the backup surfaces
    that read the marker send the operator to the backup file, not to it. The pair
    import stamps no backup marker for the same reason. The export takes a plain
    read of the record by `id` and leaves the
    marker -- present or absent -- exactly where it stood, whether the hand-off is
    confirmed or dismissed. The two exports are named apart where they are offered, so
    the operator chooses between "a file this browser restores from" and "the files
    the command line runs from" rather than between two downloads.
  - **Rotation clears the marker.** The persist-before-success rotation write clears
    the marker in the **same** transaction that advances the secret, so a rotation
    stales any prior export the instant it lands -- independent of how the run is
    later classified (a run that rotates and then fails in the data exchange has
    still rotated, and its marker is already gone). "Marker present" therefore means
    "an export containing the current secret was taken since the last rotation".

  The marker is a **plain timestamp**, honoring the derived-never-stored rule: it is
  no digest, fingerprint, or other secret-derived value, and there is no rotation
  epoch. `navigator.storage.persisted()` is never an input to the derivation, so a
  granted persist cannot suppress the actionable "backup needed" state (see
  [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges)).
- **The spent state** (`spentAt`, an ISO 8601 UTC instant, and an optional
  `handoff` discriminator) records that an export handed this device's copy off.
  Two exports write it, and the discriminator is which one did:
  - the **migration export** ("take over on another device"), which writes
    `spentAt` alone, so an absent `handoff` means a migration spend;
  - the **command-line export**'s confirmed hand-off, which writes
    `handoff: "command-line"` beside it.

  Either way it transitions the source to a visible spent state -- no Run
  affordance, no scheduled runs, labeled with the handoff date -- so the
  operator-cooperation invalidation is visible at the one moment it is violable.

  **The run path enforces that state, not the surfaces that show it.** A surface
  reads the spent state when it loads and a wake reads it when it begins, and both
  readings are as old as whatever has happened since. So the run's own locked
  window re-reads it first of all: a run that finds this device's copy spent
  refuses -- before the input file is read and before any connection -- and records
  a `handed-off` `lastRun` rather than rotating a secret whose owner is elsewhere.
  Rotating would leave the new owner's first run meeting a partner that has moved
  on, which nothing short of a re-invite recovers, and no run makes that decision on
  the operator's behalf: the refusal is the whole response, with no override on the
  run path. Taking a handed-off exchange back is a deliberate act on that record's
  own surface (see [Taking a command-line hand-off
  back](#taking-a-command-line-hand-off-back)). A spend confirmed after a surface
  loaded, or between two attempts at one scheduled window, therefore stops the runs
  that follow it.

  The spend is **operator-attested, not dispatch-anchored**: a download dispatch
  (`anchor.click()`) gives no landing signal, so a cancelled or failed save must not
  spend the source. Each export downloads its files, then writes the spent state only
  after the operator confirms they are saved; a dismissed dialog leaves the source
  live and recoverable. The migration also marks the source backed-up on dispatch, so
  a migration-spent copy has a current artifact by construction; the command-line
  export marks nothing, so a copy spent that way holds whatever backup state it
  already had. The attestation is checked rather than taken on its word, and the
  check and the write are **one atomic store step** (a cross-store
  check-and-spend), as the backup marker's are. Inside a single transaction
  spanning the record and sibling stores, the confirmation reads the record by
  `id`, compares the `sharedSecret` the files it downloaded hold, and writes the
  spent state only while the two match. A rotation -- whose own write
  spans the same two stores -- therefore lands either before that step, which then
  reads the rotated secret and refuses, or after a spend that was decided against
  the secret those files hold; it cannot land between the check and the write.
  So a rotation that persisted between the download and the attestation -- a run
  in any context, or a re-invite -- refuses the spend instead of recording one,
  since what would be handed over is a copy the partnership has already moved
  past. A record gone from the store refuses on its own terms: there is no live
  copy left to spend, and none to download again either. Those two refusals are
  reported apart and say different things.

  **A run in flight is excluded rather than checked.** That transaction decides a
  rotation that has already landed; a run still in flight has landed nothing for it
  to read -- the secret has not rotated yet, so the check would pass, and that run's
  own persist would then supersede the copy just handed over. So the spend takes the
  record's [run+rotate lock](#the-secret-is-a-linear-resource) with `ifAvailable`
  before it opens the transaction at all, and refuses while a run holds it, reporting
  a refusal of its own. The exclusion runs both ways from one lock: both run paths
  take it with `ifAvailable` too, so a run that begins while the spend holds it is
  refused rather than queued -- the attended Run as the exchange being busy, the
  scheduled path by deferring the attempt as `"unattempted"` -- and any later run
  re-reads the spent state that spend wrote as its first act inside the lock, which
  is the refusal above. Waiting for the spend would reach that same refusal later.
  Spend and run are therefore mutually excluded rather than observing each other,
  and neither order leaves a handed-over copy behind a rotation.

  Stated limit: that exclusion is the Web Locks lock's, so it binds the contexts of
  one browser profile on one machine -- which is the whole scenario, both hand-off
  surfaces and both run paths of a record being that profile's, the record itself
  being origin-local to it. What it does not cover is what no lock could: a copy held
  under another profile, browser, or machine, which can only have got there through
  an export the operator took. Bounding that is migration-not-sync and operator
  cooperation (see [Single-owner invariant](#single-owner-invariant)), not this step.
  The spent state has no secret material and no epoch.

  **Revive by import is the migration spend's recovery, and only its.** The
  migration export downloads the artifact that clears its own spend (a
  **revive-in-place**: an import whose secret matches the spent record's updates
  that record's fields, keeps its `id` and its platform handles -- the input file
  and the granted output folder -- clears the spent state,
  and marks it imported and backed-up, rather than installing a duplicate). The
  command-line export downloads the CLI's `alcove.yaml` and `.alcove.key`, which
  the command line runs from and rewrites; the import refuses that pair against the
  record the hand-off spent while it holds that record's secret ([Importing the key
  file beside a configuration](#importing-the-key-file-beside-a-configuration)),
  and the route that takes it back is the [re-take](#taking-a-command-line-hand-off-back), behind
  the operator's word that the command-line run has stopped. That is why the surfaces reading the spent state branch on the
  discriminator rather than naming one recovery for both -- a spent copy is told
  the recovery its hand-off actually has.

  **The match is `spent` plus a secret match plus an absent `handoff`.** Revive keys
  on the absence rather than on an inequality against a known route, so a hand-off
  added later is gated by default instead of inheriting the migration's
  recovery. An artifact the operator exported from this browser before a
  command-line hand-off still has the secret that record was spent holding, and
  the import **refuses it**. It neither revives the spent record -- that would
  run a copy the hand-off gave away -- nor installs a fresh one, which would
  split one secret across a spent husk here and a live row beside it. Nothing is
  written. A handed-off match determines the
  import by itself: an artifact whose secret matches a handed-off record is refused
  even when a migration-spent record holds that secret too, and the refusal names the
  handed-off record. Where it fires, the refusal names the stored record and the
  recovery that record actually has -- the exchange runs from the files the
  hand-off saved, and bringing it back to this browser is the re-take on that
  record's own surface, which the refusal names by the words on its control. The
  guard binds at the store's import path, and the surface an operator meets it at
  -- the list's import -- is not the surface offering the re-take.

  **The reconciliation parses each stored record on its own.** An entry this
  build cannot parse is **skipped** rather than failing the import: an invalid
  record at rest must not block importing an artifact for a different exchange,
  which is the way forward the read-failed recovery surface offers beside its
  listing. The skipped entry stays in the store, listed by that surface's
  per-entry diagnostic read, until the operator discards it.

  Two limits follow from the skip. A skipped entry cannot be **revived**, a
  revive rewriting the whole record, so an artifact matching a migration-spent
  entry this build cannot parse installs fresh and leaves the husk for the
  operator to discard. And the handed-off refusal reads such an entry's
  `sharedSecret` off the raw value rather than through the schema, so it still
  fires for a skipped entry whose sibling holds a `handoff` and whose secret
  field is readable and equal to the artifact's -- naming no label, the failed
  parse leaving the record's own fields untrusted. An entry whose secret field is
  unreadable too matches nothing and the import installs fresh, the bound the
  refusal already has against a record rotated or deleted past the artifact.

  **Each sibling entry is parsed on its own too**, on the same terms and for the
  same reason: one local-state entry this build cannot parse must not block an
  import for a different exchange either. A record whose sibling entry does not
  parse takes no part in the reconciliation at all -- neither revived nor counted
  a match -- unless it holds the artifact's `sharedSecret`, in which case the
  import is **refused**. The `handoff` is recorded in that sibling, so an
  unreadable one leaves no way to tell a handed-off record from a
  migration-spent or a live one, and the refusal is the one answer that neither
  runs a copy a hand-off may hold nor installs a second live copy beside it. It
  names **no hand-off route**, none having been read, and names the record's
  label only where the record itself parses; where it does not, the secret
  comparison reads the raw value under the bound stated just above. A
  handed-off refusal that did read its sibling determines the import ahead of
  this one, naming the route it read.

  The attended list read joins the sibling state and rejects wholesale on the
  same unreadable entry, so the list an operator meets this refusal beside is
  the read-failed one. The refusal names the store rather
  than the file, the file being intact, and the discard it offers is the
  delete-by-key that surface's recovery listing already provides.

  **The refusal is scoped to this store's state at import**, and both of its
  conditions are the operator's to remove: the handed-off record must still be in
  this store, and its `sharedSecret` must still equal the artifact's. An artifact
  exported before a rotation the record then took holds an older secret and
  matches nothing, so it installs fresh; deleting the handed-off record removes the
  match on the same terms. Neither is prevented -- the refusal is an
  operator-cooperation property, not a cryptographic one, exactly as the revive
  below is. Neither leaves a durable second owner either: an older artifact's
  secret is already behind the partnership's, and a copy of the current secret
  diverges from the handed-off one at the first rotation either side makes, so the
  losing copy's next handshake fails and is reported through the import/desync tiering
  (recovery: re-invite).

  Reviving a migration spend remains an operator-cooperation property, not a
  cryptographic one: nothing in the protocol prevents a copied artifact or a profile
  snapshot from resurrecting a migrated copy -- the same caveat, with the same
  response (see
  [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#rollback-at-rest-copies-can-silently-resurrect)).
- **The import marker** (`importedAt`, an ISO 8601 UTC instant) records that this
  device installed or revived the record from a backup artifact or from a
  command-line `alcove.yaml` and its `.alcove.key`, or took it back from a
  command-line hand-off. It is the evidence the desync tiering reads to tell an
  **import/restore since the last successful run** apart from an unexplained
  handshake failure (Tier 1 versus
  Tier 2; see [Telling a desync from an
  attack](../MANAGED_EXCHANGE.md#telling-a-desync-from-an-attack)). A restored
  copy can hold a secret the partnership has rotated past, so a handshake
  failure while this marker stands is the benign import tier (recovery:
  re-invite), not the attack path. "Since the last successful run" is enforced
  **structurally**, not by comparing timestamps, by two write-side rules that mirror
  the backup marker's:
  - **Import stamps it.** A fresh install and a revive-in-place both stamp
    `importedAt` (alongside the backup marker) as of the import instant. A
    revive-in-place stamps it in its own transaction, so that record holds the
    evidence from the moment it lands; a fresh install, from a backup or a
    command-line pair, stamps it in a separate best-effort write after the
    install, and a failure of that write leaves the installed record without it,
    so a stale-secret handshake failure on that record tiers as unexplained
    rather than as the import. Every [take-back of
    a command-line hand-off](#taking-a-command-line-hand-off-back) stamps it too,
    with or without a key file, and the one that installs a key file's secret clears
    the backup marker rather than stamping it. An import of a command-line
    `alcove.yaml` with its `.alcove.key` stamps it and no backup marker ([Importing
    the key file beside a configuration](#importing-the-key-file-beside-a-configuration)).
  - **Rotation clears it.** The persist-before-success rotation write clears the
    import marker in the **same** transaction that advances the secret. A rotation is
    driven by a completed handshake, which proves the two parties held the same
    secret, so a successful run **consumes** the evidence -- the marker's mere
    presence therefore means "restored and not yet successfully run since". This is
    what stops a stale import from shielding a later, genuinely-unexplained handshake
    failure (the secret-farming caveat: a benign reading is offered only when the
    record's own structured evidence still explains the failure).

  It too is a **plain timestamp**, no secret material and no rotation epoch.

All three are **local siblings by design**. The marker's currency input, this
device's spent status, and this device's restore history must not travel in the
export artifact: an imported copy is a fresh live owner, for which "the source
last backed up on X", "the source was spent", or "the source was imported on X"
is meaningless. And the record schema is not strict: a member it does not name
is dropped on read rather than rejected, and is gone at that build's next write.
Holding any of them on the record would therefore force a new `schemaVersion`,
so no older build drops it silently, or leak into the artifact. Keeping them siblings makes their non-inclusion **structural**: the
exporter reads
only the record. Deleting a managed exchange removes the record and its sibling
state together (see [Deleting a managed
exchange](../MANAGED_EXCHANGE.md#deleting-a-managed-exchange)).

### Reconciling a backup import

A backup artifact holds one exchange, so the guard on importing it is a lookup
against that exchange, not a condition on the rest of the store: the import is
offered beside every listing ([The configuration-only
record](#the-configuration-only-record)), and what else the store holds decides
nothing. The reconciliation runs in one transaction over the record and sibling
stores (`reviveSpentManagedExchange`, `managedExchangeStore.ts`), comparing
secrets in memory, and nothing is written on any outcome but a revive or a fresh
install.

Stated limit: a fresh install is a second transaction, run after the
reconciliation has found no match. Two imports of the same artifact racing in
two tabs can therefore both find none and both install, leaving two live copies
of one secret, which split at the first rotation either makes exactly as the
live-copy refusal below describes.

**The outcomes**, each named to the operator:

- **Restored this device's spent copy.** A migration-spent record holding the
  artifact's secret is revived in place ([the spent
  state](#the-backup-marker-the-spent-state-and-the-import-marker-local-siblings-never-in-the-artifact)).
- **Added as new.** No record holds the artifact's secret and no live copy is
  recognized: a fresh record installs with a new `id`.
- **Refused, a live copy is already here.** A live record holds the artifact's
  secret: it is this exchange, and a second live copy of one secret splits from
  it at the first rotation either side makes. The refusal names that record and
  says to open it.
- **Refused, handed off to the command line.** A handed-off record holds the
  artifact's secret; the refusal names the record and the take-back on that
  record's own surface ([Taking a command-line hand-off
  back](#taking-a-command-line-hand-off-back)).

A record whose sibling entry cannot be read refuses as that section states. The
refusals decide in this order: hand-off, unreadable sibling, a scoped
restore's other file (below), live copy by secret. On the list's import, a
live copy recognized without a secret match (below) is asked about after them
and before a revive or a fresh install. A scoped restore does not ask (below).

No refusal sends the operator to delete other exchanges: each names the one
record it is about and what to do with that record.

#### Recognizing a stored exchange without a secret match

A secret rotates at every run, so a file taken before a run -- a backup of a
live record, or the command line's files after a run there -- holds a secret
its own stored record does not, and the secret alone no longer finds it. The
rule that recognizes it, stated once here for every import that installs a
runnable record to call:

**Every stored record whose agreed terms and `side` equal the imported
record's is named, and the import installs nothing into or beside them until
the operator answers.** The agreed terms are the part of the linkage terms a
partner refuses an exchange over when its copy differs -- every field but this
party's own `identity` and the terms' `date` (`partnerBoundTerms`,
`@alcove/core`) -- compared in canonical form. A record with no `side` matches
nothing. The code: `findRecordsByTermsAndSide`
(`apps/web/src/psi/managed/managedLiveCopyMatch.ts`).

Which stored records each import asks about is what it can do with them:

- **The list's backup import asks about live records**, those no hand-off and
  no migration has spent, and offers to open one or install beside them. A
  scoped restore reports one after reviving (below).
- **The command-line pair import asks about records handed off to the command
  line, migration-spent, or configuration-only**, and offers to take the pair
  into one or install it beside them ([Importing the key file beside a
  configuration](#importing-the-key-file-beside-a-configuration)). It asks
  about no live record: a live record runs here, and its secret match is the
  one the pair would have.

Equal terms and side is a heuristic: two separate exchanges with one partner
can share both. So the match is a question, never a refusal, and never a
write on its own. The operator is shown every matching record's name in one
question and chooses among the import's answers or cancels (nothing is
written). The matches are named together and acknowledged by one confirm: a
confirmed install names every record it goes beside, and only a match that
confirm did not name -- one added since the question -- is asked about again.

#### Restoring a migration-spent record from its backup

A migration-spent row offers "Restore from backup", which opens the same import
scoped to that record (`restoreManagedExchangeFromBackup`,
`managedExchangeImport.ts`). It revives the record only from an artifact holding
the secret that record holds; any other file -- another exchange's backup, a
backup taken after the exchange rotated on the other device, or a command-line
file -- is refused, naming the list's import for it, and nothing is written.

A scoped restore never asks about a live copy recognized by terms and side: the
question exists to identify a record the operator has not, and here the
operator chose the row and the secret match confirms it. The restore revives
the record, and when a live record has the revived record's agreed terms and
`side`, the restore's notice names that record in one sentence. It adds no
confirm step and writes nothing to the other record.

### Taking a command-line hand-off back

A copy spent under `handoff: "command-line"` comes back to this browser through an
explicit **re-take**, offered on that record's own surface and by the pair import
when the operator takes a pair with the record's terms and side into it
([Importing the key file beside a
configuration](#importing-the-key-file-beside-a-configuration)). It is the only
route from that spent state to a running one: the import refuses the artifact
(above) and a command-line pair holding the record's secret alike, and the
surface showing the spent state is where the operator already is.

**The operator attests; the browser checks what it can.** Two facts decide a
re-take and neither is readable here -- whether the scheduled command-line run has
been stopped, and whether it has run since the hand-off. So the action is offered
behind a confirmation stating both, and a declined confirmation writes nothing.
Nothing here prevents a second live copy any more than the import refusal does: the
re-take makes taking one a deliberate, stated act rather than an accidental one,
which is all operator cooperation can be (see [Single-owner
invariant](#single-owner-invariant)).

**The secret comes from the key file, not from a fresh invitation.** The hand-off
wrote this exchange's own secret into `.alcove.key` with no re-invite, so the
take-back needs none either. Each command-line run rotates the secret and writes
the rotated one back to that file, which decides what a re-take needs:

- **Runs have happened there.** The operator chooses that `.alcove.key` with the
  `alcove.yaml` beside it, in one pick, and the re-take reads the key file's
  `sharedSecret` and `expires` into the record.
- **None has.** The stored secret is still the partnership's, and no file is needed.
- **The file cannot be produced.** The exchange is taken back without it, and the
  [fast re-invite](../MANAGED_EXCHANGE.md#recovery-fast-re-invite) is the recovery
  -- the one any secret this browser cannot match already has.

A `.alcove.key` holds the secret and its bound and nothing naming the exchange it
belongs to, which is why the `alcove.yaml` is chosen with it: a key file chosen
alone is refused before either is read. Both files are untrusted structured input,
read by the pair import's own reader (`readManagedCommandLinePair`) under its caps,
and only a validated pair reaches the store. Files that are not such a pair leave
the record spent and the store untouched.

**What the re-take checks.** Inside its transaction, before installing anything,
the re-take compares the pair's agreed terms and `side` with the stored record's,
on the [no-secret-match rule](#recognizing-a-stored-exchange-without-a-secret-match)'s
comparison (`decideRetake`, `managedPairRecognition.ts`): a pair on other terms,
or on the other side -- the partner's files -- is refused, naming which, and
nothing is written.

**What the check cannot cover.** Equal terms and side do not name one exchange,
and nothing tells this exchange's current key file from a stale copy of it. A
stale pair, or another exchange's on the same terms and side, whose secret differs
from the stored one is therefore installed over it, and the record then holds a
secret the partner does not share, recoverable only by a fresh invitation. The
confirmation states that cost and where the right files are (the folder the
exchange was handed off to on the machine running it); the operator's reading of
it is the only check there is beyond terms and side.

**The write rules.**

- **A run in flight excludes it**, on the [run+rotate
  lock](#the-secret-is-a-linear-resource) taken with `ifAvailable`, exactly as the
  spend is excluded: the run re-reads the spent state as its first act inside that
  lock, and the re-take is a write against that state. A run holding the lock is
  reported rather than waited out.
- **The read, the key application, and the spent-state clear are one transaction**
  spanning the record and sibling stores, so a rotation lands fully before or fully
  after it.
- **A key that advances the secret is applied as a rotation** -- the same
  field-scoped write a run's own rotation takes -- and **clears the backup marker**
  in that same transaction: the secret has advanced, so no earlier export of this
  exchange holds it. Whether it advances is decided on `sharedSecret` alone, so a
  file holding the stored secret with a different `expires` applies nothing, which a
  hand-edited file is the only way to reach.
- **Every re-take is recorded as an import**, stamping the
  [import marker](#the-backup-marker-the-spent-state-and-the-import-marker-local-siblings-never-in-the-artifact)
  in that same transaction. Nothing here can tell this exchange's current key file
  from a stale one or another exchange's, and nothing here can check the attestation
  that no run has happened on the other machine, so either route can leave the record
  holding a secret the partner has moved past: an `auth` failure at the next run
  tiers as **imported**, whose recovery is the re-invite, until a run succeeds and
  the rotation clears the marker.
  The instant differs with what the re-take did to the secret: a key file whose
  secret differs from the stored one stamps the re-take instant; a re-take that
  left the stored secret in place, whether it chose no key file or one holding
  the same secret, stamps the hand-off's own `spentAt`, the point from which this
  device's copy may have fallen behind. A re-take that leaves the secret in place
  also leaves the backup marker where it stands, the stored secret still being
  the one that backup holds.
- **The hand-off's own refusal is consumed.** A `lastRun` recording the
  `handed-off` refusal -- a run that came due while this copy was spent -- is
  dropped in the same transaction, with or without a key: the take-back ends the
  state that entry records, and left in place it tiers a record running here again
  as handed off. Every other `lastRun` is kept, being run history the take-back
  does not answer.
- **Only a `handoff: "command-line"` spend is taken back.** A migration spend's
  recovery is the revive-in-place its own artifact performs, and a live record has
  nothing to take back; both are reported, and neither is written to.
- **Nothing else about the record moves.** The agreed terms, the label, the
  schedule, and the platform handles are untouched: the exchange that comes back is
  the one that was handed off.

## The accounting of disclosures

A managed exchange's **accounting of disclosures** is a second local sibling, in
its own origin-local store keyed by the record `id`: the
[self-attested exchange records](EXCHANGE_RECORD.md) this exchange's runs have
produced, accumulated in run order. It is what an operator populates a HIPAA
accounting of disclosures or a FERPA disclosure record from (see
[COMPLIANCE.md](../COMPLIANCE.md#hipaa-considerations)).

**An entry is a run's exchange record, verbatim.** Not a summary of one, and not
a second format beside it. Every fact the accounting states is a field of that
record: the partner, the governing agreement and the purpose of the disclosure
under it, the categories disclosed each way, the records this party exposed, the
result size where the record format's entitlement gate recorded one, and the
instant. What a surface renders is therefore a reading of the artifact, and a
fact the record does not hold is reported as not recorded rather than inferred
from elsewhere.

**Why it cannot be a record field.** The managed record's `lastRun` is a
timestamp and closed enums by design and keeps only the most recent run, so it
can hold no disclosure and no history; and an exchange record holds free text a
partner authored, which that field set excludes. The accounting is
therefore its own store, which also keeps it out of the export artifact
structurally, exactly as the three markers above are kept out.

**Shape.** One object per exchange: a `version`
(`alcove-disclosure-accounting/v2`, its own reader-rejects-unknown literal) and
`entries`, the exchange records oldest first. A stored value that fails
validation -- an unrecognized version, an unknown key, or an entry that is not a
valid exchange record -- rejects the whole read rather than loading the entries
that parsed: a partially-loaded accounting would still render, as a shorter and
quietly false account of what was disclosed, so the failure is reported as a
failure.

**When an entry is written.** A run appends its record once that record is owed
-- from the moment this party's payload crosses (see
[EXCHANGE_RECORD.md](EXCHANGE_RECORD.md#when-a-record-is-owed)) -- inside a single
strict-durability transaction. A run that finishes appends before it reports its
outputs. A run that stops after that point appends before its failure propagates,
so an operator cancelling a run, and a transport drop cutting one, both leave the
disclosure accounted for; the scope is that region, not how the run ended. A run
that stops before it discloses appends nothing, and owes nothing. This is where
an **unattended** run's disclosure record lands: the per-run record is otherwise
offered only as a download at run completion, which requires an operator present,
so a scheduled run would otherwise leave no record of a disclosure it made. The
append is idempotent on the record's own binding nonce (per-exchange,
CSPRNG-generated, locally generated, so it identifies a run within this holder's
own log; see [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md#record-fields)), so a
retried write cannot inflate the count of disclosures the accounting reports. The
record is held to the exchange-record format on the way in, by the same validation
the read applies, and what is written is the parsed result: what is at rest is
structurally what the reader admits, so no field beyond the format can sit in the
store unseen, and a record the reader would reject is never written. A failed
append does not fail the run -- the disclosure has already happened and the
exchange's results stand -- and is reported as a notice instead. A failed append
on a run that STOPPED raises a notice of its own, beside the run's failure rather
than in place of it: the run still reports the failure it had, and the notice
states that the accounting is missing a disclosure that happened. It offers no
record download, unlike the completed run's, because a stopped run has no results
surface to offer one from. Both go to the diagnostic log as well, and both leave
a note of the run for the next visit (see [A run whose record was not
filed](#a-run-whose-record-was-not-filed)), which is what reaches an operator who
was not there for the notice.

**When no record could be built.** An owed record can still fail to build: the
build is a secondary artifact, so its failure leaves the run's result untouched
and reports that no record could be produced (see
[EXCHANGE_RECORD.md](EXCHANGE_RECORD.md#when-a-record-is-owed)). That leaves a
disclosure that happened with nothing to append. A run that stopped in that state
raises a notice of its own, on the terms the failed append takes: beside the run's
failure rather than in place of it, with no record download to offer, and in the
diagnostic log as well. The notice states the consequence -- this run has no entry
in the accounting -- because the cause is written where the build failed, on the
operator log an unattended run discards. A run that FINISHED in that state raises
the matching notice, before its outputs are built. It names no download either --
the build produced no record file to offer -- and that ordering is what keeps it
independent of the completion surface, which a run whose outputs also fail to
build never reaches. Both runs leave a note holding no record, since nothing was
built to retain and no later filing can add the entry.

**What a stopped run's entry states.** The entry is the record, so what it states
is the record's fields and nothing beside them: the columns this party consented
to disclose and sent, the run's own instant, the records it exposed, and its
[`outcome`](EXCHANGE_RECORD.md#when-a-record-is-owed) -- which is what marks it as
a run that disclosed and then stopped rather than one that finished. A surface
reading the accounting **MUST** mark such an entry where it lists entries, not
only where it expands one, and **MUST NOT** present it as a completed disclosure:
what a record attests is this party's own act of disclosure and never the
partner's receipt of it, so an accounting drawn from the list must not take an
unconfirmed send for a delivered one. Whether the partner's payload came back is a
fact of the live run rather than of the frozen record (see
[EXCHANGE_RECORD.md](EXCHANGE_RECORD.md#when-a-record-is-owed)), so no entry
states it as a field; but a terminated entry's received-columns fact lists what
had arrived, which for a non-empty list shows the partner's payload came back,
and an empty list is ambiguous -- nothing arrived, or the run stopped first.

**What it holds at rest, and retention.** The entries are the records' own
cleartext content: names, categories, references, and aggregate counts, never a
payload value, a linkage-field value, or a matched identifier. The `resultSize`
an entry holds is the intersection **cardinality** under the record format's
entitlement gate, not the intersection, so the managed record's no-match-result
rule is untouched -- but the accounting does add a growing, per-run set of
partner and agreement metadata to what a reader of the store learns (see
[Metadata at
rest](../SECURITY_DESIGN.md#metadata-at-rest-presence-and-shape)). It is bounded
only by the exchange's own run history: nothing prunes it, since a silently
dropped entry would falsify the account. Deleting the managed exchange deletes
its accounting, and the note of any run it could not file, in the same one-step
delete, so an operator who must keep it exports it first.

### What an exchange-record version bump does to a stored accounting

An entry is an exchange record, and the record format's version literal moves
with its field set; a reader rejects an unrecognized version rather than
migrating it, and no migration is offered pre-release (see
[EXCHANGE_RECORD.md](EXCHANGE_RECORD.md)). So a bump of
`EXCHANGE_RECORD_VERSION` invalidates the entries of every accounting already at
rest. Two consequences follow, and the second is the one that compounds:

- **The read refuses the whole value**, per the Shape rule above, so the
  accounting renders as unreadable rather than as an empty or shortened one.
- **The append refuses it too.** A run files its entry by reading the current
  accounting, appending, and writing back within one transaction, so the read
  failure is a write failure: the exchange goes on running and disclosing, and
  files nothing. A scheduled run's failed append raises the same notice any
  failed append raises, on a completion surface an unattended run does not open.

**The stored form survives the bump.** The accounting's own `version` is a
separate literal from the entries', and the envelope is validated without looking
inside an entry, so a bump leaves the envelope readable and the stored entries
returned verbatim. Only the per-entry validation refuses. This is what recovery
rests on, and it is pinned by a test driving both parses against a moved version
rather than asserted here.

**The unreadable state is a value in hand, not a failure to read.** One read
obtains the stored value in a single round trip and classifies it. A store that
does not open and a read transaction that does not complete are both
*store-unavailable*, which offers neither arm below. A store fails to open under
private mode with storage blocked, on an engine without IndexedDB, or where a
version-change open is transiently held off by another tab's older connection.
Only a value that was obtained and then refused by
the parses is *unreadable*. The split is the one the saved-exchanges list
already makes between a failed open and a failed read after one, and it is
critical twice over. The blocked-open condition is transient and self-healing,
so routing it to the reset would offer to destroy records over a condition that
clears when the other tab yields. And reading once means the validating parse
and the envelope-only parse see the same bytes, so the two readings of an
accounting cannot disagree.

**A refused value is then split by which side is behind.** A bump strands entries
only in one direction, and the refused entries' own `version` literals -- held
in the same raw value the envelope parse returned -- say which one this is. Where
an entry names a later record format than the reading build admits, the entries
are not stranded: a build that reads them exists, and this page is running older
code than it. That is reachable in the deployed app, not hypothetical: the service
worker does not swap code under a running page (see
[../MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md)), so a tab left open across a
deployment reads what the newer build filed. It classifies as *stale-page*, whose
remedy is a reload; offering the reset there would destroy records the current
build reads. Only entries the reading build is ahead of are the *unreadable* state
the recovery below belongs to. A literal that cannot be ordered against this
build's -- another family, or no ordinal -- is not later, so a value nothing can
be concluded about keeps the reading that offers a way out. The append refuses in
both directions alike, since it re-reads through the same validating parse: a run
from a stale page discloses and files nothing, which is why that state's copy
states the consequence and not only the remedy.

The direction split reads only as far as an envelope this build admits. The
entry literals that decide it are read by the envelope-only parse, so a
later build that reshapes the envelope itself -- a bumped accounting `version`
literal, or any added envelope key, which the strict envelope schema refuses --
classifies here as *unreadable*, reset offered, even when its entries are newer
than this build. Nothing pins the envelope's shape across builds (the recovery
check pins the entry version literal alone), so an envelope change is a
compatibility decision that change must itself state: route the new envelope
through this direction split, or accept that pages of this build offer the
reset over the value it writes.

**The recovery offered is export then reset**, in that order, from the unreadable
state, and it never removes the exchange:

| Arm | What it does | What it does not do |
| --- | --- | --- |
| Stored-form export | Writes the envelope and its entries out as JSON, verbatim | Does not restore appendability, and asserts nothing about the entries |
| Accounting-scoped reset | Deletes the accounting value alone, so the next run starts a fresh accounting and the exchange can file again | Does not retain the entries; they are destroyed |

Neither alone covers the failure, which is why the surface orders them: the
export is the only thing that retains the record, and the reset is the only thing
that restores appendability. The reset is confirmed explicitly, names what is
destroyed and what is kept, and is never a read's side effect. When the stored
value is damaged past its envelope -- corruption rather than a version bump --
there is nothing to export and the surface says so rather than offering a
download it cannot honor. The export arm alone is offered from the stale-page
state as well: handing back stored bytes asserts nothing in either direction,
where the reset belongs to the direction that has records stranded.

Two shapes are not offered. **Migration** would rewrite a
self-attested artifact into a version it was not written under, which the
reader-rejects-unknown rule and the pre-release no-migration rule both exclude. A
**read-only legacy view** would render an earlier record's absent fields through
the current version's meaning of their absence -- the quietly false account the
whole-read rejection above exists to prevent. The export hands over stored bytes
and makes no claim about them; an extracted entry is an archival artifact, and a
build that does not recognize its version will not re-check it.

A bump is held to re-taking this decision by
`npm run check:exchange-record-version`,
which pins the record version literal and fails the move rather than letting it
ship past the obligation.

### A run whose record was not filed

A run that disclosed and did not file its entry -- the append refused it, or no
record could be built for it -- leaves a **note** in the same disclosure store,
under a key of its own: the array key of the record `id` and the fixed part
`unfiled`, beside the accounting that same id keys on its own. An array key
equals no string key, so a note collides with no exchange's accounting whatever
the id holds.

**Why it is neither a row nor a record field.** An accounting entry is a
self-attested exchange record that was filed; a placeholder row for a run that
was never filed would put a non-attested row into a log whose rows are attested
artifacts, and every count drawn from the log would have to be qualified by
which rows are real. The managed record cannot hold it either, for the reason it
holds no accounting: `lastRun` is a timestamp and closed enums with no free-text
field, and it keeps only the most recent run.

**Shape.** One object per exchange: a `version`
(`alcove-unfiled-disclosure/v2`, its own reader-rejects-unknown literal) and
`entries`, oldest first. An entry holds `at`, the ISO 8601 instant the shortfall
was noted, which falls inside the run it stands for; and, where the run built a
record the reader admits, `record`, that run's exchange record retained verbatim.
An entry with no `record` is a run whose record could not be built, and nothing
can file it later.

**When an entry is written.** Whenever a run that disclosed does not file --
either arm above -- and on the same terms the append itself takes: best-effort,
never the run's outcome, and beside the notice the run raises rather than in
place of it. One entry per run: a repeated write is matched on the retained
record's own binding nonce, or for an entry with no record on its instant, so the
number of entries is the number of runs the accounting is short. The record is
held to the exchange-record format on the way in and the parsed result is what is
retained, so a record the reader would refuse is never retained -- an entry with
nothing filable is written instead, which is what that state is. A note already
stored that this build cannot read refuses the write rather than being replaced:
those bytes are the only thing standing for the runs they name, so the new run's
fact takes the fallback below instead.

**What it holds at rest, and retention.** A retained record is one exchange
record's own cleartext content -- the same names, categories, references, and
aggregate counts an accounting entry holds, and never a payload value, a
linkage-field value, or a matched identifier. An entry is deleted when its record
is filed into the accounting, and the whole note is deleted with the exchange, in
the same one-step delete. Nothing else prunes it: a dropped entry would retract a
true statement that a disclosure has no entry.

**Reading it.** The fact that a run went unfiled outlives any record format, so
the envelope parse looks inside no retained record. The reading then validates
each retained record on its own and treats one this build refuses as an entry
with nothing filable, the same thing an entry with no record means for filing:
the append would refuse it too. The two are marked apart because what the browser
holds differs -- the refused record is still at rest -- and a surface states them
apart for that reason. The stored bytes are untouched by that reading -- only a
write prunes an entry -- so a build that admits them again finds them.

**Filing what a note retained.** The note's records are appended to the
accounting in ONE transaction over both keys, so an entry cannot be dropped from
the note without landing in the accounting. The append is the accounting's own
and is idempotent on the record's binding nonce, so filing a run the accounting
already holds adds no second entry. An entry with no usable record stays noted.
An accounting this build refuses refuses the filing too, exactly as it refuses a
run's own append, so the note stands until that accounting is recovered by the
export-then-reset path above.

**What a surface reading it must state.** A surface showing the accounting while
an entry stands **MUST NOT** present it as a complete account of what the
exchange disclosed, and **MUST** state the number of runs it is short where it
states the number of entries it holds. A run whose record cannot be filed **MUST**
be stated as unrecoverable rather than offered a control that would not file it,
and **MUST NOT** be stated as a run no record is kept for where its record is
still at rest and only this build's refusal makes it unfilable.

**When the note cannot be written.** Storage full, a database that will not
open, or a note already stored that this build cannot read leaves the note
unwritable at exactly the moment it is owed. The fact then falls back to
origin-local `localStorage` under `alcove-unfiled-disclosure`: a version literal
and a bounded list of exchange ids, holding no instant and no record, so it can
be written where a record-sized write was refused. The flag is cleared where its
own alert has rendered -- not on a visit that shows nothing for the exchange,
which would destroy the fact unseen -- and where the exchange is deleted or every
exchange is cleared, so no id of an exchange the browser no longer holds is kept.
A run named only by that flag can never be filed: that is the limit of what is
recoverable, and the surface states it rather than offering a remedy.

That fallback has a floor of its own. The value names at most **20** exchanges
and is bounded to **4096** UTF-16 code units, and a flag past either bound, or one
`localStorage` refuses outright, is not stored: the fact then lands nowhere in
this browser, and the run reports it to the diagnostic log, which is the only
place left to state it. A browser out of storage is exactly the condition both
bounds hold the value small for, and a flag is refused rather than displacing one
already stored, since an earlier exchange's unrecorded run is no less true than a
later one's.

**Where a write is exclusive, and two cases nothing reaches.** Every write of the
fallback value -- a flag, one exchange's clear, and the clear of all of them --
holds one origin-wide Web Locks name across its read of the value and its write
back, so a second context cannot write between the two and have what it wrote
dropped. Where the context reaches no lock manager at all the write runs
unlocked, and a flag another context wrote in that window is lost. Two further
cases the code admits and nothing reaches today:

- A fallback value stored under another version is read as absent and
  **overwritten** by the next flag write, where a note this build cannot read
  instead fails the write and leaves those bytes untouched. The two differ
  because the note holds the runs themselves and the fallback holds ids alone.
  Version 1 is the only version of the value that has been written, so there is
  no other-version value to lose.
- Filing prunes note entries by the binding nonces it appended rather than by the
  entries it took them from, so two entries sharing one nonce would both go for
  one append. The merge that writes an entry refuses one whose nonce a stored
  entry already holds, so no write the app makes produces that pair.

## The parked results of a scheduled run

A run with nobody present builds the same results file an attended run builds and
has no one to hand it to. Where the operator granted an output folder
(`outputDirectoryHandle` under [Persisted across runs](#persisted-across-runs))
the run **writes** the file there; otherwise, and whenever that grant or write
does not hold, it **parks** the file: a third local sibling, in its own
origin-local store keyed by the record `id`, holding what each unattended run
produced until the operator returns for it or the retention releases it.

**Which of the two a run takes.** The folder first, parking as the fallback:

| The run finds | What it does | What the next visit is told |
| --- | --- | --- |
| A grant held, permission `"granted"`, write lands | Writes the results into the folder | The folder and file name the results went to |
| A grant held, permission not `"granted"` (never honoured unattended, or revoked) | Parks the results; never prompts | The results, and that the folder could not be written to without asking |
| A grant held, write throws | Parks the results | The results, and that the write to the folder failed |
| No grant held | Parks the results | The results |

The permission is queried, never requested: a run with nobody present has nobody
to answer a prompt, so a grant that is not already in force is the second row,
not a prompt nobody sees. Neither a failed write nor a failed park may restate
the run's outcome: it rotated, disclosed, and succeeded before any of this.

**What an entry holds.** One entry per run, in run order, as one of four shapes.
Every shape holds `runAt` (ISO 8601 UTC, the run's own bookkeeping stamp) and an
optional `pairTableFactors`, the two declared record counts described under
"What a run projects and what it keeps" below:

| Shape | Further fields | What it means |
| --- | --- | --- |
| Results | `fileName` (the download name: the exchange's label and the run's stamp), `csv` (the results file as a `Blob`), optional `matchedRecordCount`, optional `fallback` (`"ungranted"` \| `"write-failed"`) | The run's results, waiting for the operator; `fallback` names why a granted folder did not take them, and is absent where no grant was held |
| Written | `kind: "written"`, `fileName`, `directoryName` (the granted folder's own name, the leaf a handle reports -- no path is disclosed to the app), optional `matchedRecordCount` | The run's results are in the granted folder; this entry is the note saying where, and holds no rows |
| Storage refused | `kind: "storage-refused"` | This browser would not store that run's results; the rows are gone and the run itself stands |
| Too large | `kind: "too-large"`, `resultBytes` (what the results file weighed), optional `matchedRecordCount`, optional `fallback` (`"ungranted"` \| `"write-failed"`) | The run's results were above the size this browser keeps; none of them are here, none were shortened to fit, and the run itself stands. `fallback` names which folder outcome preceded the bound, on the same values the results shape holds, and is absent where no grant was held |

A written entry is the one shape that leaves no row value at rest in the browser:
the rows are in the operator's own folder, under whatever protection that
filesystem gives them, and the retention below applies to the note alone.

The results CSV is the whole of what is parked. The run's exchange record and its
verification keys are not: the record is already filed to [the accounting of
disclosures](#the-accounting-of-disclosures), and parking a second copy of it
beside the rows would put the same artifact in two stores with two lifetimes. A
run that produced no result table -- a count-only run, or one whose agreed terms
give this party no output -- parks nothing.

**What a run projects and what it keeps.** Two sizes, one measurement.

- **The bound.** A parked results file is bounded at **`MAX_PARKED_RESULT_BYTES`,
  which IS the web app's CSV intake cap `MAX_CSV_FILE_BYTES`**
  (`apps/web/src/psi/resultSizeProjection.ts`, `apps/web/src/components/csvIntake.ts`),
  not a second figure: a result too large for this app to read back as an input
  is not one it holds at rest for the operator, so raising the intake cap raises
  this bound in the same edit. A unit test pins the derivation. The bound is
  weighed against the built file's own bytes, and only on the parking route --
  the granted folder takes a result of any size.
- **The projection.** The results file holds one row per matched pair, so a
  projected pair count converts to a file size through the writer's bytes per
  pair -- the arithmetic behind the pair-table advisory
  ([PROTOCOL.md](PROTOCOL.md#deriving-one-table-from-the-exchanged-association-maps),
  "The advisory bound is 10,000,000 projected pairs"), whose measurement this
  reads: **`RESULT_BYTES_PER_PAIR` = 41**, the widest of the shapes measured
  there. The pair count is the product of the two DECLARED
  record counts, which is what `pairTableFactors` holds -- present only where the
  agreed cardinality makes the pair table their product (`many-to-many`), absent
  under every other, where a single record count bounds it and there is no
  product to project.
- **Why the widest cost.** The projection warns rather than refuses, so it takes
  the direction that warns early: at the widest measured shape it reaches the
  bound while a narrower result of the same pair count still fits. A run whose
  projection is over the bound is warned about where the operator enters the
  schedule and in the run history, before the run it speaks about.

**Why it cannot be a record field.** Two reasons, either sufficient. The export
artifact must not hold row values, and a sibling store makes that exclusion
structural, as it does for the markers and the accounting: the exporter reads
only the record. And the record schema drops a member it does not name rather
than rejecting it, so a delivery-state field on the record would make every
later delivery shape a `schemaVersion` event, lest an older build drop the field
at its next write.

**The retention is arithmetic, not a timer.** An entry is offered and kept while
`now` is before `runAt` plus the retention, which is **30 days**. There is no
stored expiry field: the bound is derived from the entry's own run instant at
every reading, so the number a surface states and the number enforced cannot
drift apart. The rule is applied inside every transaction over the store, the
read included, and an entry past it is deleted there rather than merely withheld
-- so the stated retention holds whether or not any sweep fires, and no code path
hands a caller an entry it has released. A transaction runs only when the app
reads or writes that exchange's store, so an exchange nobody revisits and that
never runs again keeps a past-retention entry on disk until one of those two
happens. An entry whose `runAt` this reader
cannot place on the clock -- the same UTC-designator rule the record's stored
instants take -- is dropped by that same rule: it can be held to no retention at
all, and content at rest that nothing bounds is what the rule exists to prevent.
A read that empties the value removes the key, leaving no envelope behind.

**Clearing is the operator's own bound, beside the retention.** One step removes
everything this exchange's runs left in the store -- the parked rows, the written
notes, and the recorded states -- and removes the key itself, so no envelope is
left at rest. It reads nothing first, so it also removes a value this build
refuses, the one state the read offers no other way out of. The written notes go
with the rows rather than staying behind them: a note holds the granted folder's
own name, which [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#metadata-at-rest-presence-and-shape)
classes as presence and shape at rest. What is in the operator's own folder stays
there, and the accounting of disclosures is untouched.

**A result above the bound is a recorded state too, and parks nothing.** The
results are kept whole or not at all: nothing is parked, nothing is shortened,
and the too-large shape above stands in their place under the same `runAt`,
naming what the file weighed. Its remedy is the output-folder grant, which the
bound does not apply to -- and the entry's `fallback` decides which step that
grant is, because a result this size reaches the bound from every folder outcome
above but a landed write: choose a folder where no grant was held, grant the
folder again where the run could not use the grant with nobody present, or check
the folder still exists and has room where the write failed. The next visit's row
and the run's own diagnostic line each name the case rather than the grant alone.
The run's own bookkeeping is untouched, as it is for a refusal: the run rotated,
disclosed, and succeeded before any of this.

**A storage refusal is a recorded state, not a silent drop.** A run whose results
the store will not take -- the quota refusing the rows is the expected case --
records the refused shape above under the same `runAt`. The entry holds no rows,
which is what lets it be written where the results were not. The run's own
bookkeeping is untouched by either outcome: it rotated, disclosed, and succeeded,
and the parking is downstream of all three. A refusal the store will not record
either leaves only a diagnostic-log line; nothing else is claimed.

**Reader-rejects-unknown, with no recovery arm.** The stored value carries its
own format literal (`alcove-parked-results/v2`), and a reader refuses an
unrecognized version, an unknown key, or an entry that is not one of the four
shapes, rather than loading a shortened set. The refused value is left exactly
where it is, and neither recovery arm the accounting offers is offered here: no
export, because the bytes are matched rows no reading of which this build can
vouch for, and no reset, because destroying results an operator may still want is
not something a read may do on their behalf. The parking write re-reads through
the same parse, so while such a value sits there a later run parks nothing and
cannot record the refused state either; what the operator meets is the unreadable
state itself, and the run's own bookkeeping still states what the run did.
Clearing what this exchange has parked, or deleting the exchange, removes the
value.

**What the format literal does and does not decide.** An optional field added to
a shape -- `fallback` on the results and too-large shapes -- leaves
`alcove-parked-results/v2` where it is. Moving it would refuse every entry an
operator has not collected yet, which is the loss the reader-rejects-unknown rule
exists to bound rather than to cause. A newer build reads an entry holding no
`fallback` as the plain case, no grant held, which is what that absence means in
the shape. The other direction the literal does not decide at all: the entry
schema is strict down to unknown keys, so a build that does not know the field
refuses a value holding it whatever the literal says. What bounds that direction
is the continuous-deployment policy -- reject, re-invite, re-create (see
[EXCHANGE_FILE.md](EXCHANGE_FILE.md#versioning-and-compatibility-policy)) -- not
a version the two builds negotiate over.

**What it discloses at rest** is not what the rest of this document describes.
Every other store here holds presence, shape, and aggregate counts; this one
holds matched identifiers and disclosed payload values, unencrypted -- for every
entry but the written one, whose rows are in the granted folder instead. See
[SECURITY_DESIGN.md](../SECURITY_DESIGN.md#results-of-a-scheduled-run-at-rest),
which states the reach and the bounds, and claims no at-rest protection.

Deleting a managed exchange deletes its parked results in the same one-step
delete (see [Deleting a managed
exchange](../MANAGED_EXCHANGE.md#deleting-a-managed-exchange)).

## The between-visit notification opt-in

The operator's opt-in to OS notifications about scheduled runs (see
[MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#the-between-visit-notification)) is
a **device preference**, not record state. It is stored in origin-local
`localStorage` under `alcove-between-visit-notifications`, holding the literal
`on` and nothing else; any other value, an absent key, and storage that refuses
the read alike mean not opted in. It **MUST NOT** enter the record, a local
sibling keyed by record `id`, or the export artifact: it says nothing about an
exchange, and a device that imports one decides for itself.

What a notification says is derived at the moment it is raised, from the
bookkeeping the window just wrote -- `lastRun`, the schedule's
`consecutiveMisses`, the standing condition, and the backup marker. No status of
its own is persisted: whether a state has already been announced is held **only**
in the running app runtime, so a relaunched runtime can raise a standing state's
notification once more and no stored field can disagree with the bookkeeping the
next visit reads.

An absent Notification API, a refused permission, and a failing show each
produce no notification and no error; an installed runtime with no
service-worker registration shows the notice through the page's own
`Notification` constructor instead.

## See also

- [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md) - the managed exchange lifecycle: who it serves, the automation goal and platform envelope, durability contract, single-owner invariant, desync story, eviction survival, and the moment-anchored backup surfaces
- [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges) - the browser at-rest threat model for the persisted secret: the primary controls, the rollback and metadata-at-rest analyses, and the egress-hardening limits
- [EXCHANGE_FILE.md](EXCHANGE_FILE.md) - the exchange-file artifact and the credential-free endpoint locator the record composes from
- [PROTOCOL.md](PROTOCOL.md#shared-secret-rotation) - the shared-secret rotation and rendezvous-peer-id derivation constructions
- [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md) - the self-attested per-run disclosure record (a distinct artifact; the managed record is not a disclosure log, and the accounting of disclosures above accumulates these records rather than defining a log of its own)
</content>
