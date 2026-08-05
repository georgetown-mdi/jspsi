# FIPS provider probe -- openssl-3.0

- provider build: `openssl-3.0.21`
- base image: `node:26-alpine@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66`
- workflow run: https://github.com/georgetown-mdi/jspsi/actions/runs/31046265222
- measured: 2026-08-05T20:58:41Z

## Algorithm listing (questions 1 and 2)

```
==============================================================
FIPS provider algorithm listing
==============================================================
provider build (OpenSSL release tag): openssl-3.0.21
install prefix:                       /opt/fips-probe/openssl
fips module:                          /opt/fips-probe/openssl/lib/ossl-modules/fips.so
fips module config:                   /opt/fips-probe/openssl/ssl/fipsmodule.cnf
provider config used for the listings below:
    config_diagnostics = 1
    openssl_conf = probe_init
    
    .include /opt/fips-probe/openssl/ssl/fipsmodule.cnf
    
    [probe_init]
    providers = probe_providers
    alg_section = probe_algorithms
    
    [probe_algorithms]
    default_properties = fips=yes
    
    [probe_providers]
    fips = fips_sect
    base = probe_base
    
    [probe_base]
    activate = 1

### openssl version -a (the CLI doing the listing)
$ /opt/fips-probe/openssl/bin/openssl version -a
OpenSSL 3.0.21 9 Jun 2026 (Library: OpenSSL 3.0.21 9 Jun 2026)
built on: Wed Aug  5 20:55:41 2026 UTC
platform: linux-x86_64
options:  bn(64,64)
compiler: gcc -fPIC -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_USE_NODELETE -DL_ENDIAN -DOPENSSL_PIC -DOPENSSL_BUILDING_OPENSSL -DNDEBUG
OPENSSLDIR: "/opt/fips-probe/openssl/ssl"
ENGINESDIR: "/opt/fips-probe/openssl/lib/engines-3"
MODULESDIR: "/opt/fips-probe/openssl/lib/ossl-modules"
Seeding source: os-specific
CPUINFO: OPENSSL_ia32cap=0xfeda3203078bffff:0x400684219c07a9
[exit status 0]

### openssl version -m (module directory compiled into this CLI)
$ /opt/fips-probe/openssl/bin/openssl version -m
MODULESDIR: "/opt/fips-probe/openssl/lib/ossl-modules"
[exit status 0]

### node --version (the image's own Node)
$ node --version
v26.5.0
[exit status 0]

### node openssl version (what Node links, for the cross-load comparison)
$ node -p process.versions.openssl
3.5.7
[exit status 0]

### fips.so on disk
$ ls -l /opt/fips-probe/openssl/lib/ossl-modules/fips.so
-rwxr-xr-x    1 root     root       1892248 Aug  5 20:58 /opt/fips-probe/openssl/lib/ossl-modules/fips.so
[exit status 0]

### fips.so digest
$ sha256sum /opt/fips-probe/openssl/lib/ossl-modules/fips.so
2d28258e29d40067c2c6adfa5dc74679b6b31ae97d37beb4384d97e8ab60d52f  /opt/fips-probe/openssl/lib/ossl-modules/fips.so
[exit status 0]

### fipsmodule.cnf written by fipsinstall
$ cat /opt/fips-probe/openssl/ssl/fipsmodule.cnf
[fips_sect]
activate = 1
install-version = 1
conditional-errors = 1
security-checks = 1
module-mac = A3:9C:02:72:9E:59:2F:86:5C:12:4E:0F:00:43:8A:B1:CD:33:3F:B8:44:5D:0E:B7:EA:C4:77:FB:ED:31:D7:ED
install-mac = 41:9C:38:C2:8F:59:09:43:2C:AA:2F:58:36:2D:D9:04:F9:6C:56:8B:09:E0:18:3A:2E:D6:CC:69:05:04:E1:11
install-status = INSTALL_SELF_TEST_KATS_RUN
[exit status 0]

==============================================================
Which providers are actually active
==============================================================
### openssl list -providers -verbose, default configuration
$ env -u OPENSSL_CONF -u OPENSSL_MODULES /opt/fips-probe/openssl/bin/openssl list -providers -verbose
Providers:
  default
    name: OpenSSL Default Provider
    version: 3.0.21
    status: active
    build info: 3.0.21
    gettable provider parameters:
      name: pointer to a UTF8 encoded string (arbitrary size)
      version: pointer to a UTF8 encoded string (arbitrary size)
      buildinfo: pointer to a UTF8 encoded string (arbitrary size)
      status: integer (arbitrary size)
[exit status 0]

### openssl list -providers -verbose, fips-only configuration
$ env OPENSSL_CONF=/probe/tmp/list/fips-only.cnf OPENSSL_MODULES=/opt/fips-probe/openssl/lib/ossl-modules /opt/fips-probe/openssl/bin/openssl list -providers -verbose
Providers:
  base
    name: OpenSSL Base Provider
    version: 3.0.21
    status: active
    build info: 3.0.21
    gettable provider parameters:
      name: pointer to a UTF8 encoded string (arbitrary size)
      version: pointer to a UTF8 encoded string (arbitrary size)
      buildinfo: pointer to a UTF8 encoded string (arbitrary size)
      status: integer (arbitrary size)
  fips
    name: OpenSSL FIPS Provider
    version: 3.0.21
    status: active
    build info: 3.0.21
    gettable provider parameters:
      name: pointer to a UTF8 encoded string (arbitrary size)
      version: pointer to a UTF8 encoded string (arbitrary size)
      buildinfo: pointer to a UTF8 encoded string (arbitrary size)
      status: integer (arbitrary size)
      security-checks: integer (arbitrary size)
[exit status 0]

fips provider status under the fips-only configuration: active

==============================================================
Algorithm listings
==============================================================
### key-exchange algorithms, fips-only configuration
$ env OPENSSL_CONF=/probe/tmp/list/fips-only.cnf OPENSSL_MODULES=/opt/fips-probe/openssl/lib/ossl-modules /opt/fips-probe/openssl/bin/openssl list -key-exchange-algorithms
  { 1.2.840.113549.1.3.1, DH, dhKeyAgreement } @ fips
  { 1.3.101.110, X25519 } @ fips
  { 1.3.101.111, X448 } @ fips
  ECDH @ fips
  TLS1-PRF @ fips
  HKDF @ fips
[exit status 0]

### signature algorithms, fips-only configuration
$ env OPENSSL_CONF=/probe/tmp/list/fips-only.cnf OPENSSL_MODULES=/opt/fips-probe/openssl/lib/ossl-modules /opt/fips-probe/openssl/bin/openssl list -signature-algorithms
  { 1.2.840.113549.1.1.1, 2.5.8.1.1, RSA, rsaEncryption } @ fips
  { 1.2.840.10040.4.1, 1.2.840.10040.4.3, 1.3.14.3.2.12, 1.3.14.3.2.13, 1.3.14.3.2.27, DSA, DSA-old, DSA-SHA, DSA-SHA1, DSA-SHA1-old, dsaEncryption, dsaEncryption-old, dsaWithSHA, dsaWithSHA1, dsaWithSHA1-old } @ fips
  { 1.3.101.112, ED25519 } @ fips
  { 1.3.101.113, ED448 } @ fips
  ECDSA @ fips
  HMAC @ fips
  CMAC @ fips
[exit status 0]

### KEM algorithms, fips-only configuration
$ env OPENSSL_CONF=/probe/tmp/list/fips-only.cnf OPENSSL_MODULES=/opt/fips-probe/openssl/lib/ossl-modules /opt/fips-probe/openssl/bin/openssl list -kem-algorithms
  { 1.2.840.113549.1.1.1, 2.5.8.1.1, RSA, rsaEncryption } @ fips
[exit status 0]

### openssl list -key-exchange-algorithms -provider fips
$ env OPENSSL_CONF=/probe/tmp/list/fips-only.cnf OPENSSL_MODULES=/opt/fips-probe/openssl/lib/ossl-modules /opt/fips-probe/openssl/bin/openssl list -key-exchange-algorithms -provider fips
  { 1.2.840.113549.1.3.1, DH, dhKeyAgreement } @ fips
  { 1.3.101.110, X25519 } @ fips
  { 1.3.101.111, X448 } @ fips
  ECDH @ fips
  TLS1-PRF @ fips
  HKDF @ fips
[exit status 0]

### openssl list -signature-algorithms -provider fips
$ env OPENSSL_CONF=/probe/tmp/list/fips-only.cnf OPENSSL_MODULES=/opt/fips-probe/openssl/lib/ossl-modules /opt/fips-probe/openssl/bin/openssl list -signature-algorithms -provider fips
  { 1.2.840.113549.1.1.1, 2.5.8.1.1, RSA, rsaEncryption } @ fips
  { 1.2.840.10040.4.1, 1.2.840.10040.4.3, 1.3.14.3.2.12, 1.3.14.3.2.13, 1.3.14.3.2.27, DSA, DSA-old, DSA-SHA, DSA-SHA1, DSA-SHA1-old, dsaEncryption, dsaEncryption-old, dsaWithSHA, dsaWithSHA1, dsaWithSHA1-old } @ fips
  { 1.3.101.112, ED25519 } @ fips
  { 1.3.101.113, ED448 } @ fips
  ECDSA @ fips
  HMAC @ fips
  CMAC @ fips
[exit status 0]

### openssl list -kem-algorithms -provider fips
$ env OPENSSL_CONF=/probe/tmp/list/fips-only.cnf OPENSSL_MODULES=/opt/fips-probe/openssl/lib/ossl-modules /opt/fips-probe/openssl/bin/openssl list -kem-algorithms -provider fips
  { 1.2.840.113549.1.1.1, 2.5.8.1.1, RSA, rsaEncryption } @ fips
[exit status 0]

### control: key-exchange algorithms, default configuration
$ env -u OPENSSL_CONF -u OPENSSL_MODULES /opt/fips-probe/openssl/bin/openssl list -key-exchange-algorithms
  { 1.2.840.113549.1.3.1, DH, dhKeyAgreement } @ default
  { 1.3.101.110, X25519 } @ default
  { 1.3.101.111, X448 } @ default
  ECDH @ default
  TLS1-PRF @ default
  HKDF @ default
  { 1.3.6.1.4.1.11591.4.11, id-scrypt, SCRYPT } @ default
[exit status 0]

### control: signature algorithms, default configuration
$ env -u OPENSSL_CONF -u OPENSSL_MODULES /opt/fips-probe/openssl/bin/openssl list -signature-algorithms
  { 1.2.840.113549.1.1.1, 2.5.8.1.1, RSA, rsaEncryption } @ default
  { 1.2.840.10040.4.1, 1.2.840.10040.4.3, 1.3.14.3.2.12, 1.3.14.3.2.13, 1.3.14.3.2.27, DSA, DSA-old, DSA-SHA, DSA-SHA1, DSA-SHA1-old, dsaEncryption, dsaEncryption-old, dsaWithSHA, dsaWithSHA1, dsaWithSHA1-old } @ default
  { 1.3.101.112, ED25519 } @ default
  { 1.3.101.113, ED448 } @ default
  { 1.2.156.10197.1.301, SM2 } @ default
  ECDSA @ default
  HMAC @ default
  SIPHASH @ default
  POLY1305 @ default
  CMAC @ default
[exit status 0]

==============================================================
Derived answers
==============================================================
RESULT: X25519 among the fips provider's key-exchange algorithms: PRESENT
  derived from: /probe/tmp/list/kex-fips-config.out
  matching lines:
    2:  { 1.3.101.110, X25519 } @ fips
  of those, annotated with the fips provider:
    2:  { 1.3.101.110, X25519 } @ fips

RESULT: Ed25519 among the fips provider's signature algorithms: PRESENT
  derived from: /probe/tmp/list/sig-fips-config.out
  matching lines:
    3:  { 1.3.101.112, ED25519 } @ fips
  of those, annotated with the fips provider:
    3:  { 1.3.101.112, ED25519 } @ fips

RESULT: control -- X25519 among the default configuration's key-exchange algorithms: PRESENT
  derived from: /probe/tmp/list/kex-default.out
  matching lines:
    2:  { 1.3.101.110, X25519 } @ default
  of those, annotated with the fips provider:
    (none)

RESULT: control -- Ed25519 among the default configuration's signature algorithms: PRESENT
  derived from: /probe/tmp/list/sig-default.out
  matching lines:
    3:  { 1.3.101.112, ED25519 } @ default
  of those, annotated with the fips provider:
    (none)

LIST_JSON: {"provider_build_tag":"openssl-3.0.21","openssl_cli_version":"OpenSSL 3.0.21 9 Jun 2026 (Library: OpenSSL 3.0.21 9 Jun 2026)","node_version":"v26.5.0","node_openssl_version":"3.5.7","fips_module":"/opt/fips-probe/openssl/lib/ossl-modules/fips.so","fips_module_sha256":"2d28258e29d40067c2c6adfa5dc74679b6b31ae97d37beb4384d97e8ab60d52f  /opt/fips-probe/openssl/lib/ossl-modules/fips.so","fips_provider_status":"active","x25519_key_exchange_under_fips":"PRESENT","ed25519_signature_under_fips":"PRESENT","x25519_key_exchange_default_control":"PRESENT","ed25519_signature_default_control":"PRESENT"}
```

## crypto.subtle engagement (question 3)

```

==============================================================
crypto.subtle FIPS engagement probe
==============================================================
provider build (OpenSSL release tag): openssl-3.0.21
provider module:                     /opt/fips-probe/openssl/lib/ossl-modules/fips.so
provider module config:              /opt/fips-probe/openssl/ssl/fipsmodule.cnf
provider config section:             [fips_sect]
Node running the probe:              v26.5.0
OpenSSL that Node links:             3.5.7
Node built against a shared OpenSSL:  false
Node built with an OpenSSL FIPS build: false

This exercises the same WebCrypto call shape the product's AEAD uses -- a raw
256-bit AES-GCM key and a 12-byte IV, the parameters read from
packages/core/src/connection/encryptedMessageConnection.ts in this tree -- but it
does not import that module. It is a proxy for the AEAD path, not an end-to-end
run of it.

==============================================================
Environment facts, with no configuration applied
==============================================================
node --enable-fips on the stock binary:
    $ node --enable-fips -p require('node:crypto').getFips()
    [exit status 1, signal null]
    stderr:
        /usr/local/bin/node: OpenSSL error when trying to enable FIPS:

crypto.setFips(true) on the stock binary:
    $ node -e const c = require('node:crypto'); c.setFips(true); console.log('getFips=' + c.getFips());
    [exit status 0, signal null]
    stdout: getFips=1

==============================================================
Does the bundled OpenSSL read a configuration file at all
==============================================================
Each probe below hands Node a configuration that CANNOT load. A run that fails
is one where that configuration path reached OpenSSL. A run that succeeds is one
where the path was either not read at all or its error tolerated -- the two are
not distinguished here, so only the failures are evidence.

OPENSSL_CONF pointing at a file with an unreadable .include:
    $ node -e console.log(require('node:crypto').randomBytes(4).toString('hex'));
      env OPENSSL_CONF=/probe/tmp/webcrypto/unreadable-include.cnf
    [exit status 0, signal null]
    stdout: a1314e48
    verdict: no effect observed (the run succeeded regardless)

--openssl-config pointing at a file with an unreadable .include:
    $ node --openssl-config=/probe/tmp/webcrypto/unreadable-include.cnf -e console.log(require('node:crypto').randomBytes(4).toString('hex'));
    [exit status 0, signal null]
    stdout: facd7b5b
    verdict: no effect observed (the run succeeded regardless)

OPENSSL_CONF with an unloadable provider under the openssl_conf key:
    $ node -e console.log(require('node:crypto').randomBytes(4).toString('hex'));
      env OPENSSL_CONF=/probe/tmp/webcrypto/bad-provider-openssl-conf.cnf
    [exit status 0, signal null]
    stdout: 3f5b8a8c
    verdict: no effect observed (the run succeeded regardless)

OPENSSL_CONF with an unloadable provider under the nodejs_conf key:
    $ node -e console.log(require('node:crypto').randomBytes(4).toString('hex'));
      env OPENSSL_CONF=/probe/tmp/webcrypto/bad-provider-nodejs-conf.cnf
    [exit status null, signal SIGABRT]
    stderr:
        
          #  /usr/local/bin/node[43]: std::shared_ptr<node::InitializationResultImpl> node::InitializeOncePerProcessInternal(const std::vector<std::__cxx11::basic_string<char> >&, ProcessInitializationFlags::Flags) at ../src/node.cc:1252
          #  Assertion failed: ncrypto::CSPRNG(nullptr, 0)
        
        ----- Native stack trace -----
    verdict: this path REACHED OpenSSL (the run failed on it)

--openssl-shared-config with an unloadable provider under the openssl_conf key:
    $ node --openssl-shared-config -e console.log(require('node:crypto').randomBytes(4).toString('hex'));
      env OPENSSL_CONF=/probe/tmp/webcrypto/bad-provider-openssl-conf.cnf
    [exit status null, signal SIGABRT]
    stderr:
        
          #  /usr/local/bin/node[44]: std::shared_ptr<node::InitializationResultImpl> node::InitializeOncePerProcessInternal(const std::vector<std::__cxx11::basic_string<char> >&, ProcessInitializationFlags::Flags) at ../src/node.cc:1252
          #  Assertion failed: ncrypto::CSPRNG(nullptr, 0)
        
        ----- Native stack trace -----
    verdict: this path REACHED OpenSSL (the run failed on it)

OPENSSL_MODULES pointing at a directory holding no fips.so:
    $ node -e console.log(require('node:crypto').randomBytes(4).toString('hex'));
      env OPENSSL_CONF=/probe/tmp/webcrypto/modules-probe.cnf
      env OPENSSL_MODULES=/probe/tmp/webcrypto/empty-modules
    [exit status null, signal SIGABRT]
    stderr:
        
          #  /usr/local/bin/node[45]: std::shared_ptr<node::InitializationResultImpl> node::InitializeOncePerProcessInternal(const std::vector<std::__cxx11::basic_string<char> >&, ProcessInitializationFlags::Flags) at ../src/node.cc:1252
          #  Assertion failed: ncrypto::CSPRNG(nullptr, 0)
        
        ----- Native stack trace -----
    verdict: this path REACHED OpenSSL (the run failed on it)

==============================================================
Which configuration loads the FIPS provider into Node
==============================================================

recipe: OPENSSL_CONF + OPENSSL_MODULES environment variables
    configuration /probe/tmp/webcrypto/good-openssl-conf-env.cnf:
        config_diagnostics = 1
        openssl_conf = probe_init
        nodejs_conf = probe_init
        
        .include /probe/tmp/webcrypto/fipsmodule-good.cnf
        
        [probe_init]
        providers = probe_providers
        alg_section = probe_algorithms
        
        [probe_algorithms]
        default_properties = fips=yes
        
        [probe_providers]
        fips = fips_sect
        base = probe_base
        
        [probe_base]
        activate = 1
    $ node /probe/webcrypto-probe.mjs --child engage-openssl-conf-env
      env OPENSSL_CONF=/probe/tmp/webcrypto/good-openssl-conf-env.cnf
      env OPENSSL_MODULES=/opt/fips-probe/openssl/lib/ossl-modules
    [exit status 0, signal null]
    measured:
        {
          "scenario": "engage-openssl-conf-env",
          "set_fips_called": false,
          "node": {
            "version": "v26.5.0",
            "openssl": "3.5.7",
            "shared_openssl": false,
            "openssl_is_fips": false,
            "exec_argv": []
          },
          "env": {
            "OPENSSL_CONF": "/probe/tmp/webcrypto/good-openssl-conf-env.cnf",
            "OPENSSL_MODULES": "/opt/fips-probe/openssl/lib/ossl-modules"
          },
          "get_fips_at_start": {
            "ok": true,
            "value": 1
          },
          "maps_before_crypto": {
            "readable": true,
            "mapped": true,
            "lines": [
              "7f7da0f29000-7f7da0f42000 r--p 00000000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f7da0f42000-7f7da1068000 r-xp 00019000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f7da1068000-7f7da10ae000 r--p 0013f000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f7da10ae000-7f7da10c5000 r--p 00184000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f7da10c5000-7f7da10c6000 rw-p 0019b000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
            ]
          },
          "operations": {
            "aes256gcm_round_trip": {
              "ok": true,
              "detail": {
                "ciphertext_bytes": 40,
                "ciphertext_head_hex": "c36787de55e47d77"
              }
            },
            "x25519_derive_bits": {
              "ok": true,
              "detail": {
                "derived_bytes": 32
              }
            },
            "rsa1024_keygen": {
              "ok": false,
              "error": {
                "name": "OperationError",
                "message": "The operation failed for an operation-specific reason",
                "code": 0,
                "cause": {
                  "name": "Error",
                  "message": "error:020000AE:rsa routines::invalid modulus",
                  "code": "ERR_OSSL_RSA_INVALID_MODULUS",
                  "library": "rsa routines",
                  "reason": "invalid modulus"
                }
              }
            },
            "md5_digest": {
              "ok": false,
              "error": {
                "name": "Error",
                "message": "error:0308010C:digital envelope routines::unsupported",
                "code": "ERR_OSSL_EVP_UNSUPPORTED",
                "library": "digital envelope routines",
                "reason": "unsupported",
                "openssl_error_stack": [
                  "error:03000086:digital envelope routines::initialization error",
                  "error:0308010C:digital envelope routines::unsupported"
                ]
              }
            }
          },
          "maps_after_aes": {
            "readable": true,
            "mapped": true,
            "lines": [
              "7f7da0f29000-7f7da0f42000 r--p 00000000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f7da0f42000-7f7da1068000 r-xp 00019000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f7da1068000-7f7da10ae000 r--p 0013f000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f7da10ae000-7f7da10c5000 r--p 00184000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f7da10c5000-7f7da10c6000 rw-p 0019b000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
            ]
          },
          "get_fips_after_aes": {
            "ok": true,
            "value": 1
          },
          "maps_at_exit": {
            "readable": true,
            "mapped": true,
            "lines": [
              "7f7da0f29000-7f7da0f42000 r--p 00000000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f7da0f42000-7f7da1068000 r-xp 00019000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f7da1068000-7f7da10ae000 r--p 0013f000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f7da10ae000-7f7da10c5000 r--p 00184000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f7da10c5000-7f7da10c6000 rw-p 0019b000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
            ]
          }
        }
    verdict: AES-256-GCM round trip: SUCCEEDED; fips.so mapped: yes; crypto.getFips(): 1

recipe: node --openssl-config=<file> + OPENSSL_MODULES
    configuration /probe/tmp/webcrypto/good-openssl-config-flag.cnf:
        config_diagnostics = 1
        openssl_conf = probe_init
        nodejs_conf = probe_init
        
        .include /probe/tmp/webcrypto/fipsmodule-good.cnf
        
        [probe_init]
        providers = probe_providers
        alg_section = probe_algorithms
        
        [probe_algorithms]
        default_properties = fips=yes
        
        [probe_providers]
        fips = fips_sect
        base = probe_base
        
        [probe_base]
        activate = 1
    $ node --openssl-config=/probe/tmp/webcrypto/good-openssl-config-flag.cnf /probe/webcrypto-probe.mjs --child engage-openssl-config-flag
      env OPENSSL_MODULES=/opt/fips-probe/openssl/lib/ossl-modules
    [exit status 0, signal null]
    measured:
        {
          "scenario": "engage-openssl-config-flag",
          "set_fips_called": false,
          "node": {
            "version": "v26.5.0",
            "openssl": "3.5.7",
            "shared_openssl": false,
            "openssl_is_fips": false,
            "exec_argv": [
              "--openssl-config=/probe/tmp/webcrypto/good-openssl-config-flag.cnf"
            ]
          },
          "env": {
            "OPENSSL_CONF": null,
            "OPENSSL_MODULES": "/opt/fips-probe/openssl/lib/ossl-modules"
          },
          "get_fips_at_start": {
            "ok": true,
            "value": 1
          },
          "maps_before_crypto": {
            "readable": true,
            "mapped": true,
            "lines": [
              "7f7a9a219000-7f7a9a232000 r--p 00000000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f7a9a232000-7f7a9a358000 r-xp 00019000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f7a9a358000-7f7a9a39e000 r--p 0013f000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f7a9a39e000-7f7a9a3b5000 r--p 00184000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f7a9a3b5000-7f7a9a3b6000 rw-p 0019b000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
            ]
          },
          "operations": {
            "aes256gcm_round_trip": {
              "ok": true,
              "detail": {
                "ciphertext_bytes": 40,
                "ciphertext_head_hex": "c36787de55e47d77"
              }
            },
            "x25519_derive_bits": {
              "ok": true,
              "detail": {
                "derived_bytes": 32
              }
            },
            "rsa1024_keygen": {
              "ok": false,
              "error": {
                "name": "OperationError",
                "message": "The operation failed for an operation-specific reason",
                "code": 0,
                "cause": {
                  "name": "Error",
                  "message": "error:020000AE:rsa routines::invalid modulus",
                  "code": "ERR_OSSL_RSA_INVALID_MODULUS",
                  "library": "rsa routines",
                  "reason": "invalid modulus"
                }
              }
            },
            "md5_digest": {
              "ok": false,
              "error": {
                "name": "Error",
                "message": "error:0308010C:digital envelope routines::unsupported",
                "code": "ERR_OSSL_EVP_UNSUPPORTED",
                "library": "digital envelope routines",
                "reason": "unsupported",
                "openssl_error_stack": [
                  "error:03000086:digital envelope routines::initialization error",
                  "error:0308010C:digital envelope routines::unsupported"
                ]
              }
            }
          },
          "maps_after_aes": {
            "readable": true,
            "mapped": true,
            "lines": [
              "7f7a9a219000-7f7a9a232000 r--p 00000000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f7a9a232000-7f7a9a358000 r-xp 00019000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f7a9a358000-7f7a9a39e000 r--p 0013f000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f7a9a39e000-7f7a9a3b5000 r--p 00184000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f7a9a3b5000-7f7a9a3b6000 rw-p 0019b000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
            ]
          },
          "get_fips_after_aes": {
            "ok": true,
            "value": 1
          },
          "maps_at_exit": {
            "readable": true,
            "mapped": true,
            "lines": [
              "7f7a9a219000-7f7a9a232000 r--p 00000000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f7a9a232000-7f7a9a358000 r-xp 00019000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f7a9a358000-7f7a9a39e000 r--p 0013f000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f7a9a39e000-7f7a9a3b5000 r--p 00184000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f7a9a3b5000-7f7a9a3b6000 rw-p 0019b000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
            ]
          }
        }
    verdict: AES-256-GCM round trip: SUCCEEDED; fips.so mapped: yes; crypto.getFips(): 1

recipe: node --openssl-shared-config + OPENSSL_CONF + OPENSSL_MODULES
    configuration /probe/tmp/webcrypto/good-shared-config-flag.cnf:
        config_diagnostics = 1
        openssl_conf = probe_init
        nodejs_conf = probe_init
        
        .include /probe/tmp/webcrypto/fipsmodule-good.cnf
        
        [probe_init]
        providers = probe_providers
        alg_section = probe_algorithms
        
        [probe_algorithms]
        default_properties = fips=yes
        
        [probe_providers]
        fips = fips_sect
        base = probe_base
        
        [probe_base]
        activate = 1
    $ node --openssl-shared-config /probe/webcrypto-probe.mjs --child engage-shared-config-flag
      env OPENSSL_CONF=/probe/tmp/webcrypto/good-shared-config-flag.cnf
      env OPENSSL_MODULES=/opt/fips-probe/openssl/lib/ossl-modules
    [exit status 0, signal null]
    measured:
        {
          "scenario": "engage-shared-config-flag",
          "set_fips_called": false,
          "node": {
            "version": "v26.5.0",
            "openssl": "3.5.7",
            "shared_openssl": false,
            "openssl_is_fips": false,
            "exec_argv": [
              "--openssl-shared-config"
            ]
          },
          "env": {
            "OPENSSL_CONF": "/probe/tmp/webcrypto/good-shared-config-flag.cnf",
            "OPENSSL_MODULES": "/opt/fips-probe/openssl/lib/ossl-modules"
          },
          "get_fips_at_start": {
            "ok": true,
            "value": 1
          },
          "maps_before_crypto": {
            "readable": true,
            "mapped": true,
            "lines": [
              "7fea4c079000-7fea4c092000 r--p 00000000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fea4c092000-7fea4c1b8000 r-xp 00019000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fea4c1b8000-7fea4c1fe000 r--p 0013f000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fea4c1fe000-7fea4c215000 r--p 00184000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fea4c215000-7fea4c216000 rw-p 0019b000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
            ]
          },
          "operations": {
            "aes256gcm_round_trip": {
              "ok": true,
              "detail": {
                "ciphertext_bytes": 40,
                "ciphertext_head_hex": "c36787de55e47d77"
              }
            },
            "x25519_derive_bits": {
              "ok": true,
              "detail": {
                "derived_bytes": 32
              }
            },
            "rsa1024_keygen": {
              "ok": false,
              "error": {
                "name": "OperationError",
                "message": "The operation failed for an operation-specific reason",
                "code": 0,
                "cause": {
                  "name": "Error",
                  "message": "error:020000AE:rsa routines::invalid modulus",
                  "code": "ERR_OSSL_RSA_INVALID_MODULUS",
                  "library": "rsa routines",
                  "reason": "invalid modulus"
                }
              }
            },
            "md5_digest": {
              "ok": false,
              "error": {
                "name": "Error",
                "message": "error:0308010C:digital envelope routines::unsupported",
                "code": "ERR_OSSL_EVP_UNSUPPORTED",
                "library": "digital envelope routines",
                "reason": "unsupported",
                "openssl_error_stack": [
                  "error:03000086:digital envelope routines::initialization error",
                  "error:0308010C:digital envelope routines::unsupported"
                ]
              }
            }
          },
          "maps_after_aes": {
            "readable": true,
            "mapped": true,
            "lines": [
              "7fea4c079000-7fea4c092000 r--p 00000000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fea4c092000-7fea4c1b8000 r-xp 00019000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fea4c1b8000-7fea4c1fe000 r--p 0013f000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fea4c1fe000-7fea4c215000 r--p 00184000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fea4c215000-7fea4c216000 rw-p 0019b000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
            ]
          },
          "get_fips_after_aes": {
            "ok": true,
            "value": 1
          },
          "maps_at_exit": {
            "readable": true,
            "mapped": true,
            "lines": [
              "7fea4c079000-7fea4c092000 r--p 00000000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fea4c092000-7fea4c1b8000 r-xp 00019000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fea4c1b8000-7fea4c1fe000 r--p 0013f000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fea4c1fe000-7fea4c215000 r--p 00184000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fea4c215000-7fea4c216000 rw-p 0019b000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
            ]
          }
        }
    verdict: AES-256-GCM round trip: SUCCEEDED; fips.so mapped: yes; crypto.getFips(): 1

recipe: OPENSSL_CONF naming the module path in the provider section (no OPENSSL_MODULES)
    configuration /probe/tmp/webcrypto/good-module-key.cnf:
        config_diagnostics = 1
        openssl_conf = probe_init
        nodejs_conf = probe_init
        
        .include /probe/tmp/webcrypto/fipsmodule-good-module-key.cnf
        
        [probe_init]
        providers = probe_providers
        alg_section = probe_algorithms
        
        [probe_algorithms]
        default_properties = fips=yes
        
        [probe_providers]
        fips = fips_sect
        base = probe_base
        
        [probe_base]
        activate = 1
    $ node /probe/webcrypto-probe.mjs --child engage-module-key
      env OPENSSL_CONF=/probe/tmp/webcrypto/good-module-key.cnf
    [exit status 0, signal null]
    measured:
        {
          "scenario": "engage-module-key",
          "set_fips_called": false,
          "node": {
            "version": "v26.5.0",
            "openssl": "3.5.7",
            "shared_openssl": false,
            "openssl_is_fips": false,
            "exec_argv": []
          },
          "env": {
            "OPENSSL_CONF": "/probe/tmp/webcrypto/good-module-key.cnf",
            "OPENSSL_MODULES": null
          },
          "get_fips_at_start": {
            "ok": true,
            "value": 1
          },
          "maps_before_crypto": {
            "readable": true,
            "mapped": true,
            "lines": [
              "7fcfe9c8c000-7fcfe9ca5000 r--p 00000000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fcfe9ca5000-7fcfe9dcb000 r-xp 00019000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fcfe9dcb000-7fcfe9e11000 r--p 0013f000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fcfe9e11000-7fcfe9e28000 r--p 00184000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fcfe9e28000-7fcfe9e29000 rw-p 0019b000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
            ]
          },
          "operations": {
            "aes256gcm_round_trip": {
              "ok": true,
              "detail": {
                "ciphertext_bytes": 40,
                "ciphertext_head_hex": "c36787de55e47d77"
              }
            },
            "x25519_derive_bits": {
              "ok": true,
              "detail": {
                "derived_bytes": 32
              }
            },
            "rsa1024_keygen": {
              "ok": false,
              "error": {
                "name": "OperationError",
                "message": "The operation failed for an operation-specific reason",
                "code": 0,
                "cause": {
                  "name": "Error",
                  "message": "error:020000AE:rsa routines::invalid modulus",
                  "code": "ERR_OSSL_RSA_INVALID_MODULUS",
                  "library": "rsa routines",
                  "reason": "invalid modulus"
                }
              }
            },
            "md5_digest": {
              "ok": false,
              "error": {
                "name": "Error",
                "message": "error:0308010C:digital envelope routines::unsupported",
                "code": "ERR_OSSL_EVP_UNSUPPORTED",
                "library": "digital envelope routines",
                "reason": "unsupported",
                "openssl_error_stack": [
                  "error:03000086:digital envelope routines::initialization error",
                  "error:0308010C:digital envelope routines::unsupported"
                ]
              }
            }
          },
          "maps_after_aes": {
            "readable": true,
            "mapped": true,
            "lines": [
              "7fcfe9c8c000-7fcfe9ca5000 r--p 00000000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fcfe9ca5000-7fcfe9dcb000 r-xp 00019000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fcfe9dcb000-7fcfe9e11000 r--p 0013f000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fcfe9e11000-7fcfe9e28000 r--p 00184000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fcfe9e28000-7fcfe9e29000 rw-p 0019b000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
            ]
          },
          "get_fips_after_aes": {
            "ok": true,
            "value": 1
          },
          "maps_at_exit": {
            "readable": true,
            "mapped": true,
            "lines": [
              "7fcfe9c8c000-7fcfe9ca5000 r--p 00000000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fcfe9ca5000-7fcfe9dcb000 r-xp 00019000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fcfe9dcb000-7fcfe9e11000 r--p 0013f000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fcfe9e11000-7fcfe9e28000 r--p 00184000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fcfe9e28000-7fcfe9e29000 rw-p 0019b000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
            ]
          }
        }
    verdict: AES-256-GCM round trip: SUCCEEDED; fips.so mapped: yes; crypto.getFips(): 1

Chosen configuration for the scenarios below: OPENSSL_CONF + OPENSSL_MODULES environment variables (fips.so mapped: yes, crypto.getFips(): 1).

==============================================================
S1 baseline: default configuration, no provider configured
==============================================================
    $ node /probe/webcrypto-probe.mjs --child S1-baseline
    [exit status 0, signal null]
    measured:
        {
          "scenario": "S1-baseline",
          "set_fips_called": false,
          "node": {
            "version": "v26.5.0",
            "openssl": "3.5.7",
            "shared_openssl": false,
            "openssl_is_fips": false,
            "exec_argv": []
          },
          "env": {
            "OPENSSL_CONF": null,
            "OPENSSL_MODULES": null
          },
          "get_fips_at_start": {
            "ok": true,
            "value": 0
          },
          "maps_before_crypto": {
            "readable": true,
            "mapped": false,
            "lines": []
          },
          "operations": {
            "aes256gcm_round_trip": {
              "ok": true,
              "detail": {
                "ciphertext_bytes": 40,
                "ciphertext_head_hex": "c36787de55e47d77"
              }
            },
            "x25519_derive_bits": {
              "ok": true,
              "detail": {
                "derived_bytes": 32
              }
            },
            "rsa1024_keygen": {
              "ok": true,
              "detail": {
                "modulus_length": 1024,
                "private_key_type": "private"
              }
            },
            "md5_digest": {
              "ok": true,
              "detail": {
                "hex": "99b6221c617fc898f6326b691c121416"
              }
            }
          },
          "maps_after_aes": {
            "readable": true,
            "mapped": false,
            "lines": []
          },
          "get_fips_after_aes": {
            "ok": true,
            "value": 0
          },
          "maps_at_exit": {
            "readable": true,
            "mapped": false,
            "lines": []
          }
        }
    verdict: AES-256-GCM round trip: SUCCEEDED; fips.so mapped: no; crypto.getFips(): 0

Same, but calling crypto.setFips(true) first. This is not one of the graded
scenarios: it records what Node's own FIPS switch does with no provider
configured, so a raised getFips() is not mistaken for an engaged provider.
    $ node /probe/webcrypto-probe.mjs --child S1b-setFips-default-config --set-fips
    [exit status 0, signal null]
    measured:
        {
          "scenario": "S1b-setFips-default-config",
          "set_fips_called": true,
          "node": {
            "version": "v26.5.0",
            "openssl": "3.5.7",
            "shared_openssl": false,
            "openssl_is_fips": false,
            "exec_argv": []
          },
          "env": {
            "OPENSSL_CONF": null,
            "OPENSSL_MODULES": null
          },
          "get_fips_at_start": {
            "ok": true,
            "value": 0
          },
          "maps_before_crypto": {
            "readable": true,
            "mapped": false,
            "lines": []
          },
          "operations": {
            "aes256gcm_round_trip": {
              "ok": false,
              "error": {
                "name": "OperationError",
                "message": "The operation failed for an operation-specific reason",
                "code": 0,
                "cause": {
                  "name": "Error",
                  "message": "error:0308010C:digital envelope routines::unsupported",
                  "code": "ERR_OSSL_EVP_UNSUPPORTED",
                  "library": "digital envelope routines",
                  "reason": "unsupported"
                }
              }
            },
            "x25519_derive_bits": {
              "ok": false,
              "error": {
                "name": "OperationError",
                "message": "The operation failed for an operation-specific reason",
                "code": 0,
                "cause": {
                  "name": "Error",
                  "message": "error:0308010C:digital envelope routines::unsupported",
                  "code": "ERR_OSSL_EVP_UNSUPPORTED",
                  "library": "digital envelope routines",
                  "reason": "unsupported"
                }
              }
            },
            "rsa1024_keygen": {
              "ok": false,
              "error": {
                "name": "OperationError",
                "message": "The operation failed for an operation-specific reason",
                "code": 0,
                "cause": {
                  "name": "Error",
                  "message": "error:0308010C:digital envelope routines::unsupported",
                  "code": "ERR_OSSL_EVP_UNSUPPORTED",
                  "library": "digital envelope routines",
                  "reason": "unsupported"
                }
              }
            },
            "md5_digest": {
              "ok": false,
              "error": {
                "name": "Error",
                "message": "error:0308010C:digital envelope routines::unsupported",
                "code": "ERR_OSSL_EVP_UNSUPPORTED",
                "library": "digital envelope routines",
                "reason": "unsupported",
                "openssl_error_stack": [
                  "error:03000086:digital envelope routines::initialization error",
                  "error:0308010C:digital envelope routines::unsupported"
                ]
              }
            }
          },
          "set_fips_result": {
            "ok": true,
            "detail": {
              "get_fips_after": 1
            }
          },
          "maps_after_aes": {
            "readable": true,
            "mapped": false,
            "lines": []
          },
          "get_fips_after_aes": {
            "ok": true,
            "value": 1
          },
          "maps_at_exit": {
            "readable": true,
            "mapped": false,
            "lines": []
          }
        }
    verdict: AES-256-GCM round trip: FAILED (OperationError: The operation failed for an operation-specific reason); fips.so mapped: no; crypto.getFips(): 1

==============================================================
S2 and S3: fips-only configuration, one process
==============================================================
S2 is the AES-256-GCM round trip; S3 is the attribution controls beside it.
    configuration /probe/tmp/webcrypto/good-openssl-conf-env.cnf:
        config_diagnostics = 1
        openssl_conf = probe_init
        nodejs_conf = probe_init
        
        .include /probe/tmp/webcrypto/fipsmodule-good.cnf
        
        [probe_init]
        providers = probe_providers
        alg_section = probe_algorithms
        
        [probe_algorithms]
        default_properties = fips=yes
        
        [probe_providers]
        fips = fips_sect
        base = probe_base
        
        [probe_base]
        activate = 1
    $ node /probe/webcrypto-probe.mjs --child S2-S3-fips-only
      env OPENSSL_CONF=/probe/tmp/webcrypto/good-openssl-conf-env.cnf
      env OPENSSL_MODULES=/opt/fips-probe/openssl/lib/ossl-modules
    [exit status 0, signal null]
    measured:
        {
          "scenario": "S2-S3-fips-only",
          "set_fips_called": false,
          "node": {
            "version": "v26.5.0",
            "openssl": "3.5.7",
            "shared_openssl": false,
            "openssl_is_fips": false,
            "exec_argv": []
          },
          "env": {
            "OPENSSL_CONF": "/probe/tmp/webcrypto/good-openssl-conf-env.cnf",
            "OPENSSL_MODULES": "/opt/fips-probe/openssl/lib/ossl-modules"
          },
          "get_fips_at_start": {
            "ok": true,
            "value": 1
          },
          "maps_before_crypto": {
            "readable": true,
            "mapped": true,
            "lines": [
              "7f3df17c4000-7f3df17dd000 r--p 00000000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f3df17dd000-7f3df1903000 r-xp 00019000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f3df1903000-7f3df1949000 r--p 0013f000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f3df1949000-7f3df1960000 r--p 00184000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f3df1960000-7f3df1961000 rw-p 0019b000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
            ]
          },
          "operations": {
            "aes256gcm_round_trip": {
              "ok": true,
              "detail": {
                "ciphertext_bytes": 40,
                "ciphertext_head_hex": "c36787de55e47d77"
              }
            },
            "x25519_derive_bits": {
              "ok": true,
              "detail": {
                "derived_bytes": 32
              }
            },
            "rsa1024_keygen": {
              "ok": false,
              "error": {
                "name": "OperationError",
                "message": "The operation failed for an operation-specific reason",
                "code": 0,
                "cause": {
                  "name": "Error",
                  "message": "error:020000AE:rsa routines::invalid modulus",
                  "code": "ERR_OSSL_RSA_INVALID_MODULUS",
                  "library": "rsa routines",
                  "reason": "invalid modulus"
                }
              }
            },
            "md5_digest": {
              "ok": false,
              "error": {
                "name": "Error",
                "message": "error:0308010C:digital envelope routines::unsupported",
                "code": "ERR_OSSL_EVP_UNSUPPORTED",
                "library": "digital envelope routines",
                "reason": "unsupported",
                "openssl_error_stack": [
                  "error:03000086:digital envelope routines::initialization error",
                  "error:0308010C:digital envelope routines::unsupported"
                ]
              }
            }
          },
          "maps_after_aes": {
            "readable": true,
            "mapped": true,
            "lines": [
              "7f3df17c4000-7f3df17dd000 r--p 00000000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f3df17dd000-7f3df1903000 r-xp 00019000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f3df1903000-7f3df1949000 r--p 0013f000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f3df1949000-7f3df1960000 r--p 00184000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f3df1960000-7f3df1961000 rw-p 0019b000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
            ]
          },
          "get_fips_after_aes": {
            "ok": true,
            "value": 1
          },
          "maps_at_exit": {
            "readable": true,
            "mapped": true,
            "lines": [
              "7f3df17c4000-7f3df17dd000 r--p 00000000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f3df17dd000-7f3df1903000 r-xp 00019000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f3df1903000-7f3df1949000 r--p 0013f000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f3df1949000-7f3df1960000 r--p 00184000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f3df1960000-7f3df1961000 rw-p 0019b000 00:30 8918695                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
            ]
          }
        }
    S2 verdict: AES-256-GCM round trip: SUCCEEDED; fips.so mapped: yes; crypto.getFips(): 1
    S3 control MD5 digest through node:crypto (never an approved algorithm): baseline SUCCEEDED, fips-only FAILED (Error: error:0308010C:digital envelope routines::unsupported [openssl: error:03000086:digital envelope routines::initialization error | error:0308010C:digital envelope routines::unsupported])
    S3 control RSA-1024 keygen through crypto.subtle (below the FIPS minimum modulus): baseline SUCCEEDED, fips-only FAILED (OperationError: The operation failed for an operation-specific reason)
    S3 control X25519 deriveBits through crypto.subtle: baseline SUCCEEDED, fips-only SUCCEEDED
    corroborating (node:crypto, not crypto.subtle) MD5 digest: baseline SUCCEEDED, fips-only FAILED

==============================================================
S4 causal controls: break the provider, re-run the same call
==============================================================
module-mac corrupted in the copied fipsmodule.cnf: yes
fips.so truncated to 4096 of 1892248 bytes at /probe/tmp/webcrypto/truncated-modules/fips.so

S4a: the provider config's module-mac corrupted
    configuration /probe/tmp/webcrypto/broken-mac-openssl-conf-env.cnf:
        config_diagnostics = 1
        openssl_conf = probe_init
        nodejs_conf = probe_init
        
        .include /probe/tmp/webcrypto/fipsmodule-broken-mac.cnf
        
        [probe_init]
        providers = probe_providers
        alg_section = probe_algorithms
        
        [probe_algorithms]
        default_properties = fips=yes
        
        [probe_providers]
        fips = fips_sect
        base = probe_base
        
        [probe_base]
        activate = 1
    $ node /probe/webcrypto-probe.mjs --child S4a-broken-mac
      env OPENSSL_CONF=/probe/tmp/webcrypto/broken-mac-openssl-conf-env.cnf
      env OPENSSL_MODULES=/opt/fips-probe/openssl/lib/ossl-modules
    [exit status null, signal SIGABRT]
    stderr:
        
          #  /usr/local/bin/node[123]: std::shared_ptr<node::InitializationResultImpl> node::InitializeOncePerProcessInternal(const std::vector<std::__cxx11::basic_string<char> >&, ProcessInitializationFlags::Flags) at ../src/node.cc:1252
          #  Assertion failed: ncrypto::CSPRNG(nullptr, 0)
        
        ----- Native stack trace -----
    stdout: (empty; the process produced no record)
    verdict: AES-256-GCM round trip: DID NOT RUN (the process ended with exit status null and signal SIGABRT without producing a record: #  /usr/local/bin/node[123]: std::shared_ptr<node::InitializationResultImpl> node::InitializeOncePerProcessInternal(const std::vector<std::__cxx11::basic_string<char> >&, ProcessInitializationFlags::Flags) at ../src/node.cc:1252 / #  Assertion failed: ncrypto::CSPRNG(nullptr, 0)); fips.so mapped: no; crypto.getFips(): unavailable

S4b: the provider module truncated
    configuration /probe/tmp/webcrypto/broken-module-openssl-conf-env.cnf:
        config_diagnostics = 1
        openssl_conf = probe_init
        nodejs_conf = probe_init
        
        .include /probe/tmp/webcrypto/fipsmodule-good.cnf
        
        [probe_init]
        providers = probe_providers
        alg_section = probe_algorithms
        
        [probe_algorithms]
        default_properties = fips=yes
        
        [probe_providers]
        fips = fips_sect
        base = probe_base
        
        [probe_base]
        activate = 1
    $ node /probe/webcrypto-probe.mjs --child S4b-broken-module
      env OPENSSL_CONF=/probe/tmp/webcrypto/broken-module-openssl-conf-env.cnf
      env OPENSSL_MODULES=/probe/tmp/webcrypto/truncated-modules
    [exit status null, signal SIGBUS]
    stdout: (empty; the process produced no record)
    verdict: AES-256-GCM round trip: DID NOT RUN (the process ended with exit status null and signal SIGBUS without producing a record); fips.so mapped: no; crypto.getFips(): unavailable
    S4a (corrupted module-mac): break TOOK EFFECT -- fips.so was not mapped
    S4b (truncated fips.so): break TOOK EFFECT -- fips.so was not mapped

==============================================================
Verdict
==============================================================
- the provider was reached through: OPENSSL_CONF + OPENSSL_MODULES environment variables
- attribution controls that succeed at baseline and fail under the fips-only configuration: MD5 digest through node:crypto (never an approved algorithm), RSA-1024 keygen through crypto.subtle (below the FIPS minimum modulus)
- build-dependent operations that survived, which the algorithm listing should show this provider carrying: X25519 deriveBits through crypto.subtle
- causal controls that took effect and stopped the call: S4a (corrupted module-mac), S4b (truncated fips.so)

QUESTION 3 VERDICT: ENGAGED
REASON: AES-256-GCM through crypto.subtle succeeded under a fips-only configuration, every operation no FIPS provider serves failed in that same process, and breaking the provider stopped the call

PROBE_JSON: {"provider_build_tag":"openssl-3.0.21","fips_module":"/opt/fips-probe/openssl/lib/ossl-modules/fips.so","node_version":"v26.5.0","node_openssl_version":"3.5.7","node_shared_openssl":false,"cross_load":true,"configuration_mechanisms":[{"name":"OPENSSL_CONF pointing at a file with an unreadable .include","reached_openssl":false,"status":0},{"name":"--openssl-config pointing at a file with an unreadable .include","reached_openssl":false,"status":0},{"name":"OPENSSL_CONF with an unloadable provider under the openssl_conf key","reached_openssl":false,"status":0},{"name":"OPENSSL_CONF with an unloadable provider under the nodejs_conf key","reached_openssl":true,"status":null},{"name":"--openssl-shared-config with an unloadable provider under the openssl_conf key","reached_openssl":true,"status":null},{"name":"OPENSSL_MODULES pointing at a directory holding no fips.so","reached_openssl":true,"status":null}],"engagement":[{"recipe":"OPENSSL_CONF + OPENSSL_MODULES environment variables","fips_module_mapped":true,"get_fips":1,"aes_ok":true,"exit_status":0},{"recipe":"node --openssl-config=<file> + OPENSSL_MODULES","fips_module_mapped":true,"get_fips":1,"aes_ok":true,"exit_status":0},{"recipe":"node --openssl-shared-config + OPENSSL_CONF + OPENSSL_MODULES","fips_module_mapped":true,"get_fips":1,"aes_ok":true,"exit_status":0},{"recipe":"OPENSSL_CONF naming the module path in the provider section (no OPENSSL_MODULES)","fips_module_mapped":true,"get_fips":1,"aes_ok":true,"exit_status":0}],"chosen_configuration":"OPENSSL_CONF + OPENSSL_MODULES environment variables","scenarios":{"S1-baseline":{"exit_status":0,"fips_module_mapped":false,"get_fips":0,"operations":{"aes256gcm_round_trip":{"ran":true,"ok":true,"error":null},"x25519_derive_bits":{"ran":true,"ok":true,"error":null},"rsa1024_keygen":{"ran":true,"ok":true,"error":null},"md5_digest":{"ran":true,"ok":true,"error":null}}},"S1b-setFips-default-config":{"exit_status":0,"fips_module_mapped":false,"get_fips":1,"operations":{"aes256gcm_round_trip":{"ran":true,"ok":false,"error":"OperationError: The operation failed for an operation-specific reason"},"x25519_derive_bits":{"ran":true,"ok":false,"error":"OperationError: The operation failed for an operation-specific reason"},"rsa1024_keygen":{"ran":true,"ok":false,"error":"OperationError: The operation failed for an operation-specific reason"},"md5_digest":{"ran":true,"ok":false,"error":"Error: error:0308010C:digital envelope routines::unsupported [openssl: error:03000086:digital envelope routines::initialization error | error:0308010C:digital envelope routines::unsupported]"}}},"S2-S3-fips-only":{"exit_status":0,"fips_module_mapped":true,"get_fips":1,"operations":{"aes256gcm_round_trip":{"ran":true,"ok":true,"error":null},"x25519_derive_bits":{"ran":true,"ok":true,"error":null},"rsa1024_keygen":{"ran":true,"ok":false,"error":"OperationError: The operation failed for an operation-specific reason"},"md5_digest":{"ran":true,"ok":false,"error":"Error: error:0308010C:digital envelope routines::unsupported [openssl: error:03000086:digital envelope routines::initialization error | error:0308010C:digital envelope routines::unsupported]"}}},"S4a-broken-mac":{"exit_status":null,"fips_module_mapped":false,"get_fips":null,"operations":{"aes256gcm_round_trip":{"ran":false,"ok":false,"error":null},"x25519_derive_bits":{"ran":false,"ok":false,"error":null},"rsa1024_keygen":{"ran":false,"ok":false,"error":null},"md5_digest":{"ran":false,"ok":false,"error":null}}},"S4b-broken-module":{"exit_status":null,"fips_module_mapped":false,"get_fips":null,"operations":{"aes256gcm_round_trip":{"ran":false,"ok":false,"error":null},"x25519_derive_bits":{"ran":false,"ok":false,"error":null},"rsa1024_keygen":{"ran":false,"ok":false,"error":null},"md5_digest":{"ran":false,"ok":false,"error":null}}}},"causal_controls":[{"label":"S4a (corrupted module-mac)","took_effect":true,"why":"fips.so was not mapped","aes_ok":false},{"label":"S4b (truncated fips.so)","took_effect":true,"why":"fips.so was not mapped","aes_ok":false}],"verdict":"ENGAGED","reason":"AES-256-GCM through crypto.subtle succeeded under a fips-only configuration, every operation no FIPS provider serves failed in that same process, and breaking the provider stopped the call"}
```

## Image build (tail)

```
#11 219.4 install ./include/openssl/lhash.h -> /opt/fips-probe/openssl/include/openssl/lhash.h
#11 219.4 install ./include/openssl/macros.h -> /opt/fips-probe/openssl/include/openssl/macros.h
#11 219.4 install ./include/openssl/md2.h -> /opt/fips-probe/openssl/include/openssl/md2.h
#11 219.5 install ./include/openssl/md4.h -> /opt/fips-probe/openssl/include/openssl/md4.h
#11 219.5 install ./include/openssl/md5.h -> /opt/fips-probe/openssl/include/openssl/md5.h
#11 219.5 install ./include/openssl/mdc2.h -> /opt/fips-probe/openssl/include/openssl/mdc2.h
#11 219.5 install ./include/openssl/modes.h -> /opt/fips-probe/openssl/include/openssl/modes.h
#11 219.5 install ./include/openssl/obj_mac.h -> /opt/fips-probe/openssl/include/openssl/obj_mac.h
#11 219.5 install ./include/openssl/objects.h -> /opt/fips-probe/openssl/include/openssl/objects.h
#11 219.5 install ./include/openssl/objectserr.h -> /opt/fips-probe/openssl/include/openssl/objectserr.h
#11 219.5 install ./include/openssl/ocsp.h -> /opt/fips-probe/openssl/include/openssl/ocsp.h
#11 219.5 install ./include/openssl/ocsperr.h -> /opt/fips-probe/openssl/include/openssl/ocsperr.h
#11 219.5 install ./include/openssl/opensslconf.h -> /opt/fips-probe/openssl/include/openssl/opensslconf.h
#11 219.5 install ./include/openssl/opensslv.h -> /opt/fips-probe/openssl/include/openssl/opensslv.h
#11 219.5 install ./include/openssl/ossl_typ.h -> /opt/fips-probe/openssl/include/openssl/ossl_typ.h
#11 219.5 install ./include/openssl/param_build.h -> /opt/fips-probe/openssl/include/openssl/param_build.h
#11 219.5 install ./include/openssl/params.h -> /opt/fips-probe/openssl/include/openssl/params.h
#11 219.5 install ./include/openssl/pem.h -> /opt/fips-probe/openssl/include/openssl/pem.h
#11 219.5 install ./include/openssl/pem2.h -> /opt/fips-probe/openssl/include/openssl/pem2.h
#11 219.5 install ./include/openssl/pemerr.h -> /opt/fips-probe/openssl/include/openssl/pemerr.h
#11 219.5 install ./include/openssl/pkcs12.h -> /opt/fips-probe/openssl/include/openssl/pkcs12.h
#11 219.5 install ./include/openssl/pkcs12err.h -> /opt/fips-probe/openssl/include/openssl/pkcs12err.h
#11 219.5 install ./include/openssl/pkcs7.h -> /opt/fips-probe/openssl/include/openssl/pkcs7.h
#11 219.5 install ./include/openssl/pkcs7err.h -> /opt/fips-probe/openssl/include/openssl/pkcs7err.h
#11 219.5 install ./include/openssl/prov_ssl.h -> /opt/fips-probe/openssl/include/openssl/prov_ssl.h
#11 219.5 install ./include/openssl/proverr.h -> /opt/fips-probe/openssl/include/openssl/proverr.h
#11 219.5 install ./include/openssl/provider.h -> /opt/fips-probe/openssl/include/openssl/provider.h
#11 219.5 install ./include/openssl/rand.h -> /opt/fips-probe/openssl/include/openssl/rand.h
#11 219.5 install ./include/openssl/randerr.h -> /opt/fips-probe/openssl/include/openssl/randerr.h
#11 219.5 install ./include/openssl/rc2.h -> /opt/fips-probe/openssl/include/openssl/rc2.h
#11 219.5 install ./include/openssl/rc4.h -> /opt/fips-probe/openssl/include/openssl/rc4.h
#11 219.5 install ./include/openssl/rc5.h -> /opt/fips-probe/openssl/include/openssl/rc5.h
#11 219.5 install ./include/openssl/ripemd.h -> /opt/fips-probe/openssl/include/openssl/ripemd.h
#11 219.5 install ./include/openssl/rsa.h -> /opt/fips-probe/openssl/include/openssl/rsa.h
#11 219.5 install ./include/openssl/rsaerr.h -> /opt/fips-probe/openssl/include/openssl/rsaerr.h
#11 219.5 install ./include/openssl/safestack.h -> /opt/fips-probe/openssl/include/openssl/safestack.h
#11 219.5 install ./include/openssl/seed.h -> /opt/fips-probe/openssl/include/openssl/seed.h
#11 219.5 install ./include/openssl/self_test.h -> /opt/fips-probe/openssl/include/openssl/self_test.h
#11 219.5 install ./include/openssl/sha.h -> /opt/fips-probe/openssl/include/openssl/sha.h
#11 219.5 install ./include/openssl/srp.h -> /opt/fips-probe/openssl/include/openssl/srp.h
#11 219.5 install ./include/openssl/srtp.h -> /opt/fips-probe/openssl/include/openssl/srtp.h
#11 219.5 install ./include/openssl/ssl.h -> /opt/fips-probe/openssl/include/openssl/ssl.h
#11 219.5 install ./include/openssl/ssl2.h -> /opt/fips-probe/openssl/include/openssl/ssl2.h
#11 219.5 install ./include/openssl/ssl3.h -> /opt/fips-probe/openssl/include/openssl/ssl3.h
#11 219.5 install ./include/openssl/sslerr.h -> /opt/fips-probe/openssl/include/openssl/sslerr.h
#11 219.5 install ./include/openssl/sslerr_legacy.h -> /opt/fips-probe/openssl/include/openssl/sslerr_legacy.h
#11 219.5 install ./include/openssl/stack.h -> /opt/fips-probe/openssl/include/openssl/stack.h
#11 219.5 install ./include/openssl/store.h -> /opt/fips-probe/openssl/include/openssl/store.h
#11 219.5 install ./include/openssl/storeerr.h -> /opt/fips-probe/openssl/include/openssl/storeerr.h
#11 219.5 install ./include/openssl/symhacks.h -> /opt/fips-probe/openssl/include/openssl/symhacks.h
#11 219.5 install ./include/openssl/tls1.h -> /opt/fips-probe/openssl/include/openssl/tls1.h
#11 219.5 install ./include/openssl/trace.h -> /opt/fips-probe/openssl/include/openssl/trace.h
#11 219.5 install ./include/openssl/ts.h -> /opt/fips-probe/openssl/include/openssl/ts.h
#11 219.5 install ./include/openssl/tserr.h -> /opt/fips-probe/openssl/include/openssl/tserr.h
#11 219.5 install ./include/openssl/txt_db.h -> /opt/fips-probe/openssl/include/openssl/txt_db.h
#11 219.5 install ./include/openssl/types.h -> /opt/fips-probe/openssl/include/openssl/types.h
#11 219.5 install ./include/openssl/ui.h -> /opt/fips-probe/openssl/include/openssl/ui.h
#11 219.5 install ./include/openssl/uierr.h -> /opt/fips-probe/openssl/include/openssl/uierr.h
#11 219.5 install ./include/openssl/whrlpool.h -> /opt/fips-probe/openssl/include/openssl/whrlpool.h
#11 219.5 install ./include/openssl/x509.h -> /opt/fips-probe/openssl/include/openssl/x509.h
#11 219.5 install ./include/openssl/x509_vfy.h -> /opt/fips-probe/openssl/include/openssl/x509_vfy.h
#11 219.5 install ./include/openssl/x509err.h -> /opt/fips-probe/openssl/include/openssl/x509err.h
#11 219.5 install ./include/openssl/x509v3.h -> /opt/fips-probe/openssl/include/openssl/x509v3.h
#11 219.5 install ./include/openssl/x509v3err.h -> /opt/fips-probe/openssl/include/openssl/x509v3err.h
#11 219.5 install ./include/openssl/aes.h -> /opt/fips-probe/openssl/include/openssl/aes.h
#11 219.5 install ./include/openssl/asn1.h -> /opt/fips-probe/openssl/include/openssl/asn1.h
#11 219.5 install ./include/openssl/asn1_mac.h -> /opt/fips-probe/openssl/include/openssl/asn1_mac.h
#11 219.6 install ./include/openssl/asn1err.h -> /opt/fips-probe/openssl/include/openssl/asn1err.h
#11 219.6 install ./include/openssl/asn1t.h -> /opt/fips-probe/openssl/include/openssl/asn1t.h
#11 219.6 install ./include/openssl/async.h -> /opt/fips-probe/openssl/include/openssl/async.h
#11 219.6 install ./include/openssl/asyncerr.h -> /opt/fips-probe/openssl/include/openssl/asyncerr.h
#11 219.6 install ./include/openssl/bio.h -> /opt/fips-probe/openssl/include/openssl/bio.h
#11 219.6 install ./include/openssl/bioerr.h -> /opt/fips-probe/openssl/include/openssl/bioerr.h
#11 219.6 install ./include/openssl/blowfish.h -> /opt/fips-probe/openssl/include/openssl/blowfish.h
#11 219.6 install ./include/openssl/bn.h -> /opt/fips-probe/openssl/include/openssl/bn.h
#11 219.6 install ./include/openssl/bnerr.h -> /opt/fips-probe/openssl/include/openssl/bnerr.h
#11 219.6 install ./include/openssl/buffer.h -> /opt/fips-probe/openssl/include/openssl/buffer.h
#11 219.6 install ./include/openssl/buffererr.h -> /opt/fips-probe/openssl/include/openssl/buffererr.h
#11 219.6 install ./include/openssl/camellia.h -> /opt/fips-probe/openssl/include/openssl/camellia.h
#11 219.6 install ./include/openssl/cast.h -> /opt/fips-probe/openssl/include/openssl/cast.h
#11 219.6 install ./include/openssl/cmac.h -> /opt/fips-probe/openssl/include/openssl/cmac.h
#11 219.6 install ./include/openssl/cmp.h -> /opt/fips-probe/openssl/include/openssl/cmp.h
#11 219.6 install ./include/openssl/cmp_util.h -> /opt/fips-probe/openssl/include/openssl/cmp_util.h
#11 219.6 install ./include/openssl/cmperr.h -> /opt/fips-probe/openssl/include/openssl/cmperr.h
#11 219.6 install ./include/openssl/cms.h -> /opt/fips-probe/openssl/include/openssl/cms.h
#11 219.6 install ./include/openssl/cmserr.h -> /opt/fips-probe/openssl/include/openssl/cmserr.h
#11 219.6 install ./include/openssl/comp.h -> /opt/fips-probe/openssl/include/openssl/comp.h
#11 219.6 install ./include/openssl/comperr.h -> /opt/fips-probe/openssl/include/openssl/comperr.h
#11 219.6 install ./include/openssl/conf.h -> /opt/fips-probe/openssl/include/openssl/conf.h
#11 219.6 install ./include/openssl/conf_api.h -> /opt/fips-probe/openssl/include/openssl/conf_api.h
#11 219.6 install ./include/openssl/conferr.h -> /opt/fips-probe/openssl/include/openssl/conferr.h
#11 219.6 install ./include/openssl/configuration.h -> /opt/fips-probe/openssl/include/openssl/configuration.h
#11 219.6 install ./include/openssl/conftypes.h -> /opt/fips-probe/openssl/include/openssl/conftypes.h
#11 219.6 install ./include/openssl/core.h -> /opt/fips-probe/openssl/include/openssl/core.h
#11 219.6 install ./include/openssl/core_dispatch.h -> /opt/fips-probe/openssl/include/openssl/core_dispatch.h
#11 219.6 install ./include/openssl/core_names.h -> /opt/fips-probe/openssl/include/openssl/core_names.h
#11 219.6 install ./include/openssl/core_object.h -> /opt/fips-probe/openssl/include/openssl/core_object.h
#11 219.6 install ./include/openssl/crmf.h -> /opt/fips-probe/openssl/include/openssl/crmf.h
#11 219.6 install ./include/openssl/crmferr.h -> /opt/fips-probe/openssl/include/openssl/crmferr.h
#11 219.6 install ./include/openssl/crypto.h -> /opt/fips-probe/openssl/include/openssl/crypto.h
#11 219.6 install ./include/openssl/cryptoerr.h -> /opt/fips-probe/openssl/include/openssl/cryptoerr.h
#11 219.6 install ./include/openssl/cryptoerr_legacy.h -> /opt/fips-probe/openssl/include/openssl/cryptoerr_legacy.h
#11 219.6 install ./include/openssl/ct.h -> /opt/fips-probe/openssl/include/openssl/ct.h
#11 219.6 install ./include/openssl/cterr.h -> /opt/fips-probe/openssl/include/openssl/cterr.h
#11 219.6 install ./include/openssl/decoder.h -> /opt/fips-probe/openssl/include/openssl/decoder.h
#11 219.6 install ./include/openssl/decodererr.h -> /opt/fips-probe/openssl/include/openssl/decodererr.h
#11 219.6 install ./include/openssl/des.h -> /opt/fips-probe/openssl/include/openssl/des.h
#11 219.6 install ./include/openssl/dh.h -> /opt/fips-probe/openssl/include/openssl/dh.h
#11 219.6 install ./include/openssl/dherr.h -> /opt/fips-probe/openssl/include/openssl/dherr.h
#11 219.6 install ./include/openssl/dsa.h -> /opt/fips-probe/openssl/include/openssl/dsa.h
#11 219.6 install ./include/openssl/dsaerr.h -> /opt/fips-probe/openssl/include/openssl/dsaerr.h
#11 219.6 install ./include/openssl/dtls1.h -> /opt/fips-probe/openssl/include/openssl/dtls1.h
#11 219.6 install ./include/openssl/e_os2.h -> /opt/fips-probe/openssl/include/openssl/e_os2.h
#11 219.6 install ./include/openssl/ebcdic.h -> /opt/fips-probe/openssl/include/openssl/ebcdic.h
#11 219.6 install ./include/openssl/ec.h -> /opt/fips-probe/openssl/include/openssl/ec.h
#11 219.6 install ./include/openssl/ecdh.h -> /opt/fips-probe/openssl/include/openssl/ecdh.h
#11 219.6 install ./include/openssl/ecdsa.h -> /opt/fips-probe/openssl/include/openssl/ecdsa.h
#11 219.6 install ./include/openssl/ecerr.h -> /opt/fips-probe/openssl/include/openssl/ecerr.h
#11 219.6 install ./include/openssl/encoder.h -> /opt/fips-probe/openssl/include/openssl/encoder.h
#11 219.6 install ./include/openssl/encodererr.h -> /opt/fips-probe/openssl/include/openssl/encodererr.h
#11 219.6 install ./include/openssl/engine.h -> /opt/fips-probe/openssl/include/openssl/engine.h
#11 219.6 install ./include/openssl/engineerr.h -> /opt/fips-probe/openssl/include/openssl/engineerr.h
#11 219.6 install ./include/openssl/err.h -> /opt/fips-probe/openssl/include/openssl/err.h
#11 219.6 install ./include/openssl/ess.h -> /opt/fips-probe/openssl/include/openssl/ess.h
#11 219.6 install ./include/openssl/esserr.h -> /opt/fips-probe/openssl/include/openssl/esserr.h
#11 219.6 install ./include/openssl/evp.h -> /opt/fips-probe/openssl/include/openssl/evp.h
#11 219.6 install ./include/openssl/evperr.h -> /opt/fips-probe/openssl/include/openssl/evperr.h
#11 219.6 install ./include/openssl/fips_names.h -> /opt/fips-probe/openssl/include/openssl/fips_names.h
#11 219.6 install ./include/openssl/fipskey.h -> /opt/fips-probe/openssl/include/openssl/fipskey.h
#11 219.7 install ./include/openssl/hmac.h -> /opt/fips-probe/openssl/include/openssl/hmac.h
#11 219.7 install ./include/openssl/http.h -> /opt/fips-probe/openssl/include/openssl/http.h
#11 219.7 install ./include/openssl/httperr.h -> /opt/fips-probe/openssl/include/openssl/httperr.h
#11 219.7 install ./include/openssl/idea.h -> /opt/fips-probe/openssl/include/openssl/idea.h
#11 219.7 install ./include/openssl/kdf.h -> /opt/fips-probe/openssl/include/openssl/kdf.h
#11 219.7 install ./include/openssl/kdferr.h -> /opt/fips-probe/openssl/include/openssl/kdferr.h
#11 219.7 install ./include/openssl/lhash.h -> /opt/fips-probe/openssl/include/openssl/lhash.h
#11 219.7 install ./include/openssl/macros.h -> /opt/fips-probe/openssl/include/openssl/macros.h
#11 219.7 install ./include/openssl/md2.h -> /opt/fips-probe/openssl/include/openssl/md2.h
#11 219.7 install ./include/openssl/md4.h -> /opt/fips-probe/openssl/include/openssl/md4.h
#11 219.7 install ./include/openssl/md5.h -> /opt/fips-probe/openssl/include/openssl/md5.h
#11 219.7 install ./include/openssl/mdc2.h -> /opt/fips-probe/openssl/include/openssl/mdc2.h
#11 219.7 install ./include/openssl/modes.h -> /opt/fips-probe/openssl/include/openssl/modes.h
#11 219.7 install ./include/openssl/obj_mac.h -> /opt/fips-probe/openssl/include/openssl/obj_mac.h
#11 219.7 install ./include/openssl/objects.h -> /opt/fips-probe/openssl/include/openssl/objects.h
#11 219.7 install ./include/openssl/objectserr.h -> /opt/fips-probe/openssl/include/openssl/objectserr.h
#11 219.7 install ./include/openssl/ocsp.h -> /opt/fips-probe/openssl/include/openssl/ocsp.h
#11 219.7 install ./include/openssl/ocsperr.h -> /opt/fips-probe/openssl/include/openssl/ocsperr.h
#11 219.7 install ./include/openssl/opensslconf.h -> /opt/fips-probe/openssl/include/openssl/opensslconf.h
#11 219.7 install ./include/openssl/opensslv.h -> /opt/fips-probe/openssl/include/openssl/opensslv.h
#11 219.7 install ./include/openssl/ossl_typ.h -> /opt/fips-probe/openssl/include/openssl/ossl_typ.h
#11 219.7 install ./include/openssl/param_build.h -> /opt/fips-probe/openssl/include/openssl/param_build.h
#11 219.7 install ./include/openssl/params.h -> /opt/fips-probe/openssl/include/openssl/params.h
#11 219.7 install ./include/openssl/pem.h -> /opt/fips-probe/openssl/include/openssl/pem.h
#11 219.7 install ./include/openssl/pem2.h -> /opt/fips-probe/openssl/include/openssl/pem2.h
#11 219.7 install ./include/openssl/pemerr.h -> /opt/fips-probe/openssl/include/openssl/pemerr.h
#11 219.7 install ./include/openssl/pkcs12.h -> /opt/fips-probe/openssl/include/openssl/pkcs12.h
#11 219.7 install ./include/openssl/pkcs12err.h -> /opt/fips-probe/openssl/include/openssl/pkcs12err.h
#11 219.7 install ./include/openssl/pkcs7.h -> /opt/fips-probe/openssl/include/openssl/pkcs7.h
#11 219.7 install ./include/openssl/pkcs7err.h -> /opt/fips-probe/openssl/include/openssl/pkcs7err.h
#11 219.7 install ./include/openssl/prov_ssl.h -> /opt/fips-probe/openssl/include/openssl/prov_ssl.h
#11 219.7 install ./include/openssl/proverr.h -> /opt/fips-probe/openssl/include/openssl/proverr.h
#11 219.7 install ./include/openssl/provider.h -> /opt/fips-probe/openssl/include/openssl/provider.h
#11 219.7 install ./include/openssl/rand.h -> /opt/fips-probe/openssl/include/openssl/rand.h
#11 219.7 install ./include/openssl/randerr.h -> /opt/fips-probe/openssl/include/openssl/randerr.h
#11 219.7 install ./include/openssl/rc2.h -> /opt/fips-probe/openssl/include/openssl/rc2.h
#11 219.7 install ./include/openssl/rc4.h -> /opt/fips-probe/openssl/include/openssl/rc4.h
#11 219.7 install ./include/openssl/rc5.h -> /opt/fips-probe/openssl/include/openssl/rc5.h
#11 219.7 install ./include/openssl/ripemd.h -> /opt/fips-probe/openssl/include/openssl/ripemd.h
#11 219.7 install ./include/openssl/rsa.h -> /opt/fips-probe/openssl/include/openssl/rsa.h
#11 219.7 install ./include/openssl/rsaerr.h -> /opt/fips-probe/openssl/include/openssl/rsaerr.h
#11 219.7 install ./include/openssl/safestack.h -> /opt/fips-probe/openssl/include/openssl/safestack.h
#11 219.7 install ./include/openssl/seed.h -> /opt/fips-probe/openssl/include/openssl/seed.h
#11 219.7 install ./include/openssl/self_test.h -> /opt/fips-probe/openssl/include/openssl/self_test.h
#11 219.7 install ./include/openssl/sha.h -> /opt/fips-probe/openssl/include/openssl/sha.h
#11 219.7 install ./include/openssl/srp.h -> /opt/fips-probe/openssl/include/openssl/srp.h
#11 219.7 install ./include/openssl/srtp.h -> /opt/fips-probe/openssl/include/openssl/srtp.h
#11 219.7 install ./include/openssl/ssl.h -> /opt/fips-probe/openssl/include/openssl/ssl.h
#11 219.7 install ./include/openssl/ssl2.h -> /opt/fips-probe/openssl/include/openssl/ssl2.h
#11 219.7 install ./include/openssl/ssl3.h -> /opt/fips-probe/openssl/include/openssl/ssl3.h
#11 219.7 install ./include/openssl/sslerr.h -> /opt/fips-probe/openssl/include/openssl/sslerr.h
#11 219.7 install ./include/openssl/sslerr_legacy.h -> /opt/fips-probe/openssl/include/openssl/sslerr_legacy.h
#11 219.7 install ./include/openssl/stack.h -> /opt/fips-probe/openssl/include/openssl/stack.h
#11 219.7 install ./include/openssl/store.h -> /opt/fips-probe/openssl/include/openssl/store.h
#11 219.7 install ./include/openssl/storeerr.h -> /opt/fips-probe/openssl/include/openssl/storeerr.h
#11 219.7 install ./include/openssl/symhacks.h -> /opt/fips-probe/openssl/include/openssl/symhacks.h
#11 219.7 install ./include/openssl/tls1.h -> /opt/fips-probe/openssl/include/openssl/tls1.h
#11 219.7 install ./include/openssl/trace.h -> /opt/fips-probe/openssl/include/openssl/trace.h
#11 219.7 install ./include/openssl/ts.h -> /opt/fips-probe/openssl/include/openssl/ts.h
#11 219.7 install ./include/openssl/tserr.h -> /opt/fips-probe/openssl/include/openssl/tserr.h
#11 219.7 install ./include/openssl/txt_db.h -> /opt/fips-probe/openssl/include/openssl/txt_db.h
#11 219.7 install ./include/openssl/types.h -> /opt/fips-probe/openssl/include/openssl/types.h
#11 219.8 install ./include/openssl/ui.h -> /opt/fips-probe/openssl/include/openssl/ui.h
#11 219.8 install ./include/openssl/uierr.h -> /opt/fips-probe/openssl/include/openssl/uierr.h
#11 219.8 install ./include/openssl/whrlpool.h -> /opt/fips-probe/openssl/include/openssl/whrlpool.h
#11 219.8 install ./include/openssl/x509.h -> /opt/fips-probe/openssl/include/openssl/x509.h
#11 219.8 install ./include/openssl/x509_vfy.h -> /opt/fips-probe/openssl/include/openssl/x509_vfy.h
#11 219.8 install ./include/openssl/x509err.h -> /opt/fips-probe/openssl/include/openssl/x509err.h
#11 219.8 install ./include/openssl/x509v3.h -> /opt/fips-probe/openssl/include/openssl/x509v3.h
#11 219.8 install ./include/openssl/x509v3err.h -> /opt/fips-probe/openssl/include/openssl/x509v3err.h
#11 219.8 install libcrypto.a -> /opt/fips-probe/openssl/lib/libcrypto.a
#11 219.9 install libssl.a -> /opt/fips-probe/openssl/lib/libssl.a
#11 219.9 link /opt/fips-probe/openssl/lib/libcrypto.so -> /opt/fips-probe/openssl/lib/libcrypto.so.3
#11 219.9 link /opt/fips-probe/openssl/lib/libssl.so -> /opt/fips-probe/openssl/lib/libssl.so.3
#11 219.9 created directory `/opt/fips-probe/openssl/lib/pkgconfig'
#11 219.9 install libcrypto.pc -> /opt/fips-probe/openssl/lib/pkgconfig/libcrypto.pc
#11 219.9 install libssl.pc -> /opt/fips-probe/openssl/lib/pkgconfig/libssl.pc
#11 219.9 install openssl.pc -> /opt/fips-probe/openssl/lib/pkgconfig/openssl.pc
#11 219.9 "make" depend && "make" _build_modules
#11 220.1 make[1]: Entering directory '/src/openssl'
#11 220.2 make[1]: Leaving directory '/src/openssl'
#11 220.5 make[1]: Entering directory '/src/openssl'
#11 220.5 make[1]: Nothing to be done for '_build_modules'.
#11 220.5 make[1]: Leaving directory '/src/openssl'
#11 220.5 created directory `/opt/fips-probe/openssl/lib/engines-3'
#11 220.5 *** Installing engines
#11 220.5 install engines/afalg.so -> /opt/fips-probe/openssl/lib/engines-3/afalg.so
#11 220.5 install engines/capi.so -> /opt/fips-probe/openssl/lib/engines-3/capi.so
#11 220.5 install engines/loader_attic.so -> /opt/fips-probe/openssl/lib/engines-3/loader_attic.so
#11 220.5 install engines/padlock.so -> /opt/fips-probe/openssl/lib/engines-3/padlock.so
#11 220.5 created directory `/opt/fips-probe/openssl/lib/ossl-modules'
#11 220.5 *** Installing modules
#11 220.5 install providers/legacy.so -> /opt/fips-probe/openssl/lib/ossl-modules/legacy.so
#11 220.5 "make" depend && "make" _build_programs
#11 220.7 make[1]: Entering directory '/src/openssl'
#11 220.8 make[1]: Leaving directory '/src/openssl'
#11 221.2 make[1]: Entering directory '/src/openssl'
#11 221.2 make[1]: Nothing to be done for '_build_programs'.
#11 221.2 make[1]: Leaving directory '/src/openssl'
#11 221.2 created directory `/opt/fips-probe/openssl/bin'
#11 221.2 *** Installing runtime programs
#11 221.2 install apps/openssl -> /opt/fips-probe/openssl/bin/openssl
#11 221.2 install tools/c_rehash -> /opt/fips-probe/openssl/bin/c_rehash
#11 221.2 + make install_fips
#11 221.3 "make" depend && "make" _build_sw
#11 221.5 make[1]: Entering directory '/src/openssl'
#11 221.6 make[1]: Leaving directory '/src/openssl'
#11 222.0 make[1]: Entering directory '/src/openssl'
#11 222.0 make[1]: Leaving directory '/src/openssl'
#11 222.0 created directory `/opt/fips-probe/openssl/ssl'
#11 222.0 *** Installing FIPS module
#11 222.0 install providers/fips.so -> /opt/fips-probe/openssl/lib/ossl-modules/fips.so
#11 222.0 *** Installing FIPS module configuration
#11 222.0 install providers/fipsmodule.cnf -> /opt/fips-probe/openssl/ssl/fipsmodule.cnf
#11 DONE 222.7s

#12 [ 7/10] RUN set -eux;   mkdir -p "/opt/fips-probe/openssl/ssl";   LD_LIBRARY_PATH="/opt/fips-probe/openssl/lib" "/opt/fips-probe/openssl/bin/openssl" fipsinstall   -module "/opt/fips-probe/openssl/lib/ossl-modules/fips.so"   -out "/opt/fips-probe/openssl/ssl/fipsmodule.cnf"   -provider_name fips;   if [ ! -f "/opt/fips-probe/openssl/lib/ossl-modules/fips.so" ]; then   echo "fips.so absent after install_fips" >&2;   ls -la "/opt/fips-probe/openssl/lib/ossl-modules" >&2 || true;   ls -la "/opt/fips-probe/openssl/lib" >&2 || true;   exit 1;   fi
#12 0.111 + mkdir -p /opt/fips-probe/openssl/ssl
#12 0.112 + LD_LIBRARY_PATH=/opt/fips-probe/openssl/lib /opt/fips-probe/openssl/bin/openssl fipsinstall -module /opt/fips-probe/openssl/lib/ossl-modules/fips.so -out /opt/fips-probe/openssl/ssl/fipsmodule.cnf -provider_name fips
#12 0.117 HMAC : (Module_Integrity) : Pass
#12 0.119 SHA1 : (KAT_Digest) : Pass
#12 0.119 SHA2 : (KAT_Digest) : Pass
#12 0.119 SHA3 : (KAT_Digest) : Pass
#12 0.119 TDES : (KAT_Cipher) : Pass
#12 0.119 AES_GCM : (KAT_Cipher) : Pass
#12 0.119 AES_ECB_Decrypt : (KAT_Cipher) : Pass
#12 0.119 RSA : (KAT_Signature) : RNG : (Continuous_RNG_Test) : Pass
#12 0.121 Pass
#12 0.121 ECDSA : (PCT_Signature) : Pass
#12 0.122 ECDSA : (PCT_Signature) : Pass
#12 0.123 DSA : (PCT_Signature) : Pass
#12 0.124 TLS13_KDF_EXTRACT : (KAT_KDF) : Pass
#12 0.124 TLS13_KDF_EXPAND : (KAT_KDF) : Pass
#12 0.124 TLS12_PRF : (KAT_KDF) : Pass
#12 0.124 PBKDF2 : (KAT_KDF) : Pass
#12 0.125 SSHKDF : (KAT_KDF) : Pass
#12 0.125 KBKDF : (KAT_KDF) : Pass
#12 0.125 HKDF : (KAT_KDF) : Pass
#12 0.125 SSKDF : (KAT_KDF) : Pass
#12 0.125 X963KDF : (KAT_KDF) : Pass
#12 0.125 X942KDF : (KAT_KDF) : Pass
#12 0.125 HASH : (DRBG) : Pass
#12 0.126 CTR : (DRBG) : Pass
#12 0.126 HMAC : (DRBG) : Pass
#12 0.126 DH : (KAT_KA) : Pass
#12 0.126 ECDH : (KAT_KA) : Pass
#12 0.127 RSA_Encrypt : (KAT_AsymmetricCipher) : Pass
#12 0.127 RSA_Decrypt : (KAT_AsymmetricCipher) : Pass
#12 0.130 RSA_Decrypt : (KAT_AsymmetricCipher) : Pass
#12 0.133 INSTALL PASSED
#12 0.133 + '[' '!' -f /opt/fips-probe/openssl/lib/ossl-modules/fips.so ]
#12 DONE 0.1s

#13 [ 8/10] COPY list-algorithms.sh webcrypto-probe.mjs /probe/
#13 DONE 0.0s

#14 [ 9/10] RUN chmod +x /probe/list-algorithms.sh
#14 DONE 0.1s

#15 [10/10] WORKDIR /probe
#15 DONE 0.0s

#16 exporting to image
#16 exporting layers
#16 exporting layers 3.0s done
#16 writing image sha256:2c1e4f8efe35badd76f597c99c130d71ad60f35adf7b18a6fbea59411b06f413 done
#16 naming to docker.io/library/fips-probe:openssl-3.0 done
#16 DONE 3.0s

 [33m1 warning found (use docker --debug to expand):
[0m - InvalidDefaultArgInFrom: Default value for ARG ${BASE_IMAGE} results in empty or invalid base image name (line 11)
```
