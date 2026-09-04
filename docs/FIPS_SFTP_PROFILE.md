---
title: "FIPS Deployment Profile for SFTP Exchanges"
---

# FIPS deployment profile for SFTP exchanges

An agency required to use FIPS-validated cryptography needs its SFTP exchanges to negotiate only approved algorithms. This profile is the settings that constrain that negotiation, what each setting excludes, what happens when the partner's server offers nothing approved, and the one part of the SSH handshake an operator cannot constrain at all.

It is deployment guidance and stands on its own: it narrows what the SSH layer will negotiate whether or not the image you run embeds a validated cryptographic module. Constraining negotiation is **not** a validated-module claim, and this profile makes none -- what psilink can and cannot say about module validation is in [COMPLIANCE.md](COMPLIANCE.md#fips-140).

## Scope: the command-line application

SFTP exchanges are conducted by the CLI. The web application conducts WebRTC exchanges in the browser and, for an SFTP exchange, saves an exchange file for the command-line tool to run rather than conducting it itself (see [CONSOLE.md](CONSOLE.md)). A browser has no equivalent of the settings below, so this profile is CLI guidance and not guidance for the web application.

It applies to a `psilink.yaml`-configured CLI run. The console is not a place to apply it: the SFTP connection an operator authors there admits a strict, fixed set of server fields and no transport-tuning block ([SERVER_JOB_API.md](spec/SERVER_JOB_API.md#authoring-the-sftp-connection)). That fits the console's role -- it is a prototyping tool an exchange graduates from to a plain scheduled CLI run ([CONSOLE.md](CONSOLE.md)) -- so apply this profile to the configuration you graduate to.

## What you can constrain, and what you cannot

The SSH handshake negotiates four things. Three are yours to set:

| Negotiated | Constrained by | Operator-settable |
|---|---|---|
| Key exchange | `algorithms.kex` | Yes |
| Encryption | `algorithms.cipher` | Yes |
| Message authentication | `algorithms.hmac` | Yes |
| Host-key type | `algorithms.serverHostKey` | **No** -- see [Host-key types cannot be constrained](#host-key-types-cannot-be-constrained) |

The three settable lists are sub-keys of the `algorithms` object inside [`connection.provider_options`](EXCHANGE_REFERENCE.md#connectionprovider_options), which documents the passthrough itself: which sub-categories survive its filter, what a partially-surviving or empty list does, and the warnings each emits. This page gives the values; that reference gives the mechanics.

## The settings

Copy this into the connection block of your `psilink.yaml`:

```yaml
connection:
  channel: sftp
  # ... your server, path, and options ...
  provider_options:
    algorithms:
      kex:
        - ecdh-sha2-nistp256
        - ecdh-sha2-nistp384
        - ecdh-sha2-nistp521
        - diffie-hellman-group14-sha256
        - diffie-hellman-group16-sha512
      cipher:
        - aes256-gcm@openssh.com
        - aes128-gcm@openssh.com
        - aes256-ctr
        - aes192-ctr
        - aes128-ctr
      hmac:
        - hmac-sha2-256-etm@openssh.com
        - hmac-sha2-512-etm@openssh.com
        - hmac-sha2-256
        - hmac-sha2-512
```

Order is preference order: the negotiation settles on the first entry the partner's server also accepts. Drop entries from the end to narrow further -- a shorter list is a stricter deployment, at the cost of more partners it cannot reach.

### The reference the selection follows

The selection is the approved security functions of **FIPS 140-3 Annex A**, which incorporates **NIST SP 800-140C**, the CMVP-approved security functions list. The underlying publication for each category:

- **Key exchange** -- ECC and finite-field Diffie-Hellman key agreement per **SP 800-56A Rev. 3**; the NIST curves per FIPS 186-5 / SP 800-186, and the `group14`/`group16` MODP groups per that publication's approved safe-prime groups.
- **Encryption** -- AES (FIPS 197) in GCM (**SP 800-38D**) and CTR (**SP 800-38A**) modes.
- **Message authentication** -- HMAC (**FIPS 198-1**) over SHA-2 (**FIPS 180-4**).

Approval at the algorithm-standard level is a different thing from module-certificate approval; [COMPLIANCE.md](COMPLIANCE.md#fips-140) keeps the two apart.

### What each list excludes

- **`kex`** excludes `curve25519-sha256` and its `@libssh.org` spelling: X25519 is not an approved key-agreement algorithm on any OpenSSL Project certificate ([fips-provider-surface.md](notes/fips-provider-surface.md)), and the FIPS 140-3 certificate this project targets -- 5021, for the Amazon Linux 2023 module the variant image carries -- names it in no table at all, approved or non-approved, and states its non-approved-but-allowed category empty. There is no status X25519 could hold on that certificate, and the certified module does not carry the primitive to begin with ([CONTAINER_IMAGES.md](spec/CONTAINER_IMAGES.md#what-certificate-5021-attests)). It also excludes every SHA-1 key exchange (`diffie-hellman-group1-sha1`, `diffie-hellman-group14-sha1`, `diffie-hellman-group-exchange-sha1`) and the group-exchange family generally, whose modulus the server chooses at handshake time rather than being one of the approved safe primes.
- **`cipher`** excludes `chacha20-poly1305@openssh.com` (not an approved algorithm), `3des-cbc`, and the AES-CBC suites. CBC is itself an approved mode; it is excluded here for the SSH-specific plaintext-recovery weakness, not on FIPS grounds, so an operator who must interoperate with a CBC-only server is widening the list on a security tradeoff rather than a compliance one.
- **`hmac`** excludes every `hmac-sha1` spelling and the `umac-*` family, which is not FIPS-approved. The `-etm@openssh.com` entries are the same HMAC construction in encrypt-then-MAC order and are listed first for that reason.

### The hmac list applies only to the non-AEAD fallback

When the negotiation settles on one of the AES-GCM ciphers, the MAC list is not used: those suites carry their own integrity, and the handshake records an empty MAC in both directions. The `hmac` list governs the run that falls back to a CTR cipher instead, which is why it is still load-bearing -- leaving it unset would let a CTR fallback negotiate `hmac-sha1`.

### A misspelled algorithm name fails the dial

An algorithm name the SSH library does not know is refused when the connection is dialed, with `Unsupported algorithm: <name>`, rather than being dropped from the list silently. A typo in the block above therefore fails the run rather than quietly widening the offer.

## Host-key types cannot be constrained

`serverHostKey` is dropped from the `algorithms` passthrough by design: which host-key types a client will accept is a host-key-trust decision, not transport tuning, and psilink does not let a configuration file weaken it ([EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#connectionprovider_options)). Setting it produces a warning naming the dropped sub-key and changes nothing.

The consequence is direct: **`ssh-rsa`, which signs with SHA-1, stays in the host-key offer and cannot be excluded from negotiation.** On an ordinary runtime a dial made with the profile above offers, in order, `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ecdsa-sha2-nistp384`, `ecdsa-sha2-nistp521`, `rsa-sha2-512`, `rsa-sha2-256`, `ssh-rsa` -- and the server picks from that list; from inside a FIPS-configured image the same dial offers that list without `ssh-ed25519` ([The default offer measured inside the image](#the-default-offer-measured-inside-the-image)). A server that offers only `ssh-rsa` is negotiated with, and no client-side setting refuses it.

**The control available instead is host-key fingerprint pinning.** Pin the server's key by its OpenSSH SHA-256 fingerprint, in the configuration as [`connection.server.host_key_fingerprint`](EXCHANGE_REFERENCE.md#connectionserver) or on the command line as `--server-host-key-fingerprint` (see [CLI.md](CLI.md#sftp-host-key-trust)). The no-pin default is fail-closed, so a non-interactive run against an unpinned server does not connect at all.

Be precise about what that buys, because the two are often conflated:

- Pinning **does** bind the exchange to one specific server key. A different key -- including a substituted one -- fails the connection before authentication, which is the property host-key-type restriction is usually reached for.
- Pinning does **not** change which signature algorithm the handshake uses. If the negotiation lands on `ssh-rsa`, the host-key signature over that handshake is an RSA SHA-1 signature, pinned key or not.

Closing that last gap is a server-side change, not a client-side one: see [What to ask of the partner's server](#what-to-ask-of-the-partners-server).

## When nothing approved overlaps

**The run fails at negotiation. It never proceeds on an unapproved algorithm.** This is the profile's fail-closed property and the reason it can be applied to a partner you do not administer: a partner's server that has nothing approved to offer produces a failed exchange, not a quietly downgraded one.

Against a server restricted to a non-approved set in any one of the three categories, the failure arrives before authentication and before any SFTP session exists, so no exchange file is read or written. The message names the category:

| The partner's server accepts only | The run fails with |
|---|---|
| `curve25519-sha256` | `Handshake failed: no matching key exchange algorithm` |
| `chacha20-poly1305@openssh.com` | `Handshake failed: no matching C->S cipher` |
| `hmac-sha1` | `Handshake failed: no matching C->S MAC` |

The remedy is server-side: the partner enables an approved algorithm in that category (see [What to ask of the partner's server](#what-to-ask-of-the-partners-server)). Widening your own list to reach them is the other option, and it is a decision to make deliberately -- it is the whole control this profile consists of.

### Distinguishing this from a runtime that cannot perform the algorithm

Two different failures both end a run at the handshake, and their remedies are opposites:

- **The partner offers nothing approved** -- the messages above, naming a category (`key exchange algorithm`, `C->S cipher`, `C->S MAC`). Nothing about your host is wrong; the fix is on the partner's server.
- **Your own runtime cannot perform what was asked** -- the error names the missing primitive (today, X25519) rather than a category, and points at the server's administrator or at running from a different host. psilink withholds from its offer any algorithm the running process cannot perform, so this failure means the server accepts nothing outside that withheld set. The mechanics, including what happens when part or all of a `kex` list is unavailable, are in [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#key-exchange-algorithms-and-the-hosts-crypto-provider).

The profile above is chosen so the second case does not arise from the profile itself: none of its entries rests on X25519.

## Running in a FIPS-configured image

If you run psilink in a container configured with an OpenSSL FIPS provider, the provider build -- not this profile -- decides which SSH algorithms are available at all. The SSH stack reaches `node:crypto`, which dispatches through the configured provider, so an algorithm the provider does not carry cannot be performed however it is configured here.

What that means for the lists above, from the provider measurements recorded in [fips-provider-surface.md](notes/fips-provider-surface.md):

- **The profile's algorithms survive both measured provider builds.** ECDH and finite-field DH are in the key-exchange listing of every build measured (3.0.8, 3.0.9, 3.0.21 and 3.5.7), as are the AES modes and HMAC-SHA-2 the cipher and hmac lists name.
- **`curve25519-sha256` is unavailable under a 3.5.x provider, and in the one FIPS image measured end to end.** X25519 keypair generation fails under a from-source 3.5.7 provider, taking every key exchange built on it with it, while the from-source 3.0.8, 3.0.9 and 3.0.21 builds serve X25519. The version line is not what settles it: the measured image pairs the 3.5.7 OpenSSL Node links with the certified Amazon Linux 3.0.8 provider module, and an X25519 derivation fails there ([fips-variant-image.md](notes/fips-variant-image.md)) -- a property of that pairing, which the measurement does not attribute to either component, and that module is separately read to carry no X25519 at all ([What each list excludes](#what-each-list-excludes)). So the 3.0.x/3.5.x split holds for the from-source builds it was taken on and is unverified for a mixed base-and-module pairing; confirm X25519 in your own image before depending on it. This is one more reason the `kex` list above excludes it: a recommendation that depended on the provider build would fail at negotiation for a reason the operator could not see from the profile.
- **MD5 is unavailable under a fips-only configuration.** psilink pins and displays a host key by its OpenSSH SHA-256 fingerprint, so the pin above is unaffected -- but tooling that produces an MD5 fingerprint (`ssh-keygen -E md5`, and some server documentation) cannot be used inside such an image to derive the value you pin.

Which certificate and base image the variant pairs with, and what a claim about it may say, are in [fips-variant-image.md](notes/fips-variant-image.md) and [COMPLIANCE.md](COMPLIANCE.md#fips-140).

### The default offer measured inside the image

The three points above rest on the provider's own measured algorithm surface; what such an image puts on the SSH wire is a separate measurement, taken directly. On an Amazon Linux 2023 host with kernel FIPS mode enabled (`/proc/sys/crypto/fips_enabled` reads `1`), the FIPS variant image -- carrying the AL2023 FIPS provider module `3.0.8-d694bfa693b76001` under a fips-only OpenSSL configuration -- was dialed at a listener that answers the SSH version banner, decodes the client's first packet (`SSH_MSG_KEXINIT`), and drops the connection. No key exchange completed and no server key was involved. The dial carried no `algorithms` block, so what it offered is the default, before any setting on this page narrows it:

| Negotiated | Offered by default from inside the FIPS image |
|---|---|
| Key exchange | `ecdh-sha2-nistp256`, `ecdh-sha2-nistp384`, `ecdh-sha2-nistp521`, `diffie-hellman-group-exchange-sha256`, `diffie-hellman-group14-sha256`, `diffie-hellman-group15-sha512`, `diffie-hellman-group16-sha512`, `diffie-hellman-group17-sha512`, `diffie-hellman-group18-sha512` |
| Encryption | `aes128-gcm@openssh.com`, `aes256-gcm@openssh.com`, `aes128-ctr`, `aes192-ctr`, `aes256-ctr` |
| Message authentication | `hmac-sha2-256-etm@openssh.com`, `hmac-sha2-512-etm@openssh.com`, `hmac-sha1-etm@openssh.com`, `hmac-sha2-256`, `hmac-sha2-512`, `hmac-sha1` |
| Host-key type | `ecdsa-sha2-nistp256`, `ecdsa-sha2-nistp384`, `ecdsa-sha2-nistp521`, `rsa-sha2-512`, `rsa-sha2-256`, `ssh-rsa` |

The key-exchange field also carried `ext-info-c` and `kex-strict-c-v00@openssh.com`, which signal protocol extensions rather than naming algorithms.

Four names an ordinary runtime offers are absent from it:

- **`curve25519-sha256` and its `@libssh.org` spelling**, from the key exchange. X25519 cannot be performed in that image, and psilink withholds the algorithms built on it ([Distinguishing this from a runtime that cannot perform the algorithm](#distinguishing-this-from-a-runtime-that-cannot-perform-the-algorithm)); excluding them in the `kex` list above costs nothing there.
- **`chacha20-poly1305@openssh.com`**, from the ciphers.
- **`ssh-ed25519`**, from the host-key offer, which is otherwise the list described under [Host-key types cannot be constrained](#host-key-types-cannot-be-constrained) -- `ssh-rsa` at the end of it included.

The SHA-1 MACs are not among them. `hmac-sha1-etm@openssh.com` and `hmac-sha1` are offered by default, as is `diffie-hellman-group-exchange-sha256`, so **a FIPS-configured image is not a substitute for the settings above**: run one without them and a partner's server that accepts only `hmac-sha1` still negotiates it on a CTR fallback, and one that accepts only group exchange still negotiates a modulus it chose itself.

The measurement is one image on one host, and it is what the client offers rather than a completed negotiation -- the listener is not an SSH server. The negotiation behavior described everywhere else on this page is verified against a real SSH server on an ordinary runtime. Confirm the offer in your own image when its base image or provider build differs from the one above.

## What to ask of the partner's server

psilink enforces none of the following -- it constrains only what this side offers and accepts. These are the server-side settings to agree with your partner out of band, alongside the exchange directory and account access ([DEPLOYMENT.md](DEPLOYMENT.md#sftp-server)):

- Restrict `KexAlgorithms`, `Ciphers`, and `MACs` to the same approved sets. A server restricted this way and a client running this profile fail closed toward each other rather than settling on the weaker of the two.
- Restrict `HostKeyAlgorithms` to exclude `ssh-rsa`, and offer an `ecdsa-sha2-nistp256` or `rsa-sha2-256`/`rsa-sha2-512` host key. This is the only place the SHA-1 host-key signature described above can be closed, since the client side cannot constrain it.
- Publish the host key's SHA-256 fingerprint out of band so the pin can be set before the first run rather than accepted interactively.

A partner who applies none of this is still reachable: the profile constrains this side's own negotiation regardless, and the exchange either meets an approved algorithm in each category or does not run.

## See also

- [COMPLIANCE.md](COMPLIANCE.md#fips-140) - what psilink does and does not claim about FIPS 140 validation
- [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#connectionprovider_options) - the `algorithms` passthrough, its filter, and its warnings
- [CLI.md](CLI.md#sftp-host-key-trust) - host-key pinning, first-use trust, and rotation
- [DEPLOYMENT.md](DEPLOYMENT.md#sftp-server) - operating the SFTP server the exchange runs over
- [fips-provider-surface.md](notes/fips-provider-surface.md) - the provider measurements this profile's runtime guidance rests on
