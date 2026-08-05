# FIPS provider probe -- node-linked

- provider build: `openssl-3.5.7`
- base image: `node:26-alpine@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66`
- workflow run: https://github.com/georgetown-mdi/jspsi/actions/runs/31046265222
- measured: 2026-08-05T20:59:57Z

## Algorithm listing (questions 1 and 2)

```
==============================================================
FIPS provider algorithm listing
==============================================================
provider build (OpenSSL release tag): openssl-3.5.7
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
OpenSSL 3.5.7 9 Jun 2026 (Library: OpenSSL 3.5.7 9 Jun 2026)
built on: Wed Aug  5 20:55:39 2026 UTC
platform: linux-x86_64
options:  bn(64,64)
compiler: gcc -fPIC -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_USE_NODELETE -DL_ENDIAN -DOPENSSL_PIC -DOPENSSL_BUILDING_OPENSSL -DNDEBUG
OPENSSLDIR: "/opt/fips-probe/openssl/ssl"
ENGINESDIR: "/opt/fips-probe/openssl/lib/engines-3"
MODULESDIR: "/opt/fips-probe/openssl/lib/ossl-modules"
Seeding source: os-specific
CPUINFO: OPENSSL_ia32cap=0xfeda3203078bffff:0x00400684219c07a9:0x0000000000000010:0x0000000000000000:0x0000000000000000
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
-rwxr-xr-x    1 root     root       3207584 Aug  5 20:59 /opt/fips-probe/openssl/lib/ossl-modules/fips.so
[exit status 0]

### fips.so digest
$ sha256sum /opt/fips-probe/openssl/lib/ossl-modules/fips.so
74cee9ce943744dc111fccf6d3e43dade3f6a866fa838d679afb232b65b666e1  /opt/fips-probe/openssl/lib/ossl-modules/fips.so
[exit status 0]

### fipsmodule.cnf written by fipsinstall
$ cat /opt/fips-probe/openssl/ssl/fipsmodule.cnf
[fips_sect]
activate = 1
install-version = 1
conditional-errors = 1
security-checks = 1
hmac-key-check = 0
kmac-key-check = 0
tls1-prf-ems-check = 0
no-short-mac = 0
drbg-no-trunc-md = 0
signature-digest-check = 0
hkdf-digest-check = 0
tls13-kdf-digest-check = 0
tls1-prf-digest-check = 0
sshkdf-digest-check = 0
sskdf-digest-check = 0
x963kdf-digest-check = 0
dsa-sign-disabled = 0
tdes-encrypt-disabled = 0
rsa-pkcs15-pad-disabled = 0
rsa-pss-saltlen-check = 0
rsa-sign-x931-pad-disabled = 0
hkdf-key-check = 0
kbkdf-key-check = 0
tls13-kdf-key-check = 0
tls1-prf-key-check = 0
sshkdf-key-check = 0
sskdf-key-check = 0
x963kdf-key-check = 0
x942kdf-key-check = 0
pbkdf2-lower-bound-check = 1
ecdh-cofactor-check = 0
module-mac = 40:1A:D8:37:49:DE:34:3B:4F:33:76:57:FE:11:96:07:D0:7A:E0:3D:F9:EE:E4:1A:AF:F1:A6:AC:DB:80:74:4B
[exit status 0]

==============================================================
Which providers are actually active
==============================================================
### openssl list -providers -verbose, default configuration
$ env -u OPENSSL_CONF -u OPENSSL_MODULES /opt/fips-probe/openssl/bin/openssl list -providers -verbose
Providers:
  default
    name: OpenSSL Default Provider
    version: 3.5.7
    status: active
    build info: 3.5.7
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
    version: 3.5.7
    status: active
    build info: 3.5.7
    gettable provider parameters:
      name: pointer to a UTF8 encoded string (arbitrary size)
      version: pointer to a UTF8 encoded string (arbitrary size)
      buildinfo: pointer to a UTF8 encoded string (arbitrary size)
      status: integer (arbitrary size)
  fips
    name: OpenSSL FIPS Provider
    version: 3.5.7
    status: active
    build info: 3.5.7
    gettable provider parameters:
      name: pointer to a UTF8 encoded string (arbitrary size)
      version: pointer to a UTF8 encoded string (arbitrary size)
      buildinfo: pointer to a UTF8 encoded string (arbitrary size)
      status: integer (arbitrary size)
      security-checks: integer (arbitrary size)
      tls1-prf-ems-check: integer (arbitrary size)
      no-short-mac: integer (arbitrary size)
      hmac-key-check: integer (arbitrary size)
      kmac-key-check: integer (arbitrary size)
      drbg-no-trunc-md: integer (arbitrary size)
      signature-digest-check: integer (arbitrary size)
      hkdf-digest-check: integer (arbitrary size)
      tls13-kdf-digest-check: integer (arbitrary size)
      tls1-prf-digest-check: integer (arbitrary size)
      sshkdf-digest-check: integer (arbitrary size)
      sskdf-digest-check: integer (arbitrary size)
      x963kdf-digest-check: integer (arbitrary size)
      dsa-sign-disabled: integer (arbitrary size)
      tdes-encrypt-disabled: integer (arbitrary size)
      rsa-pkcs15-pad-disabled: integer (arbitrary size)
      rsa-pss-saltlen-check: integer (arbitrary size)
      rsa-sign-x931-pad-disabled: integer (arbitrary size)
      hkdf-key-check: integer (arbitrary size)
      kbkdf-key-check: integer (arbitrary size)
      tls13-kdf-key-check: integer (arbitrary size)
      tls1-prf-key-check: integer (arbitrary size)
      sshkdf-key-check: integer (arbitrary size)
      sskdf-key-check: integer (arbitrary size)
      x963kdf-key-check: integer (arbitrary size)
      x942kdf-key-check: integer (arbitrary size)
      pbkdf2-lower-bound-check: integer (arbitrary size)
      ecdh-cofactor-check: integer (arbitrary size)
[exit status 0]

fips provider status under the fips-only configuration: active

==============================================================
Algorithm listings
==============================================================
### key-exchange algorithms, fips-only configuration
$ env OPENSSL_CONF=/probe/tmp/list/fips-only.cnf OPENSSL_MODULES=/opt/fips-probe/openssl/lib/ossl-modules /opt/fips-probe/openssl/bin/openssl list -key-exchange-algorithms
  { 1.2.840.113549.1.3.1, DH, dhKeyAgreement } @ fips
  ECDH @ fips
  TLS1-PRF @ fips
  HKDF @ fips
[exit status 0]

### signature algorithms, fips-only configuration
$ env OPENSSL_CONF=/probe/tmp/list/fips-only.cnf OPENSSL_MODULES=/opt/fips-probe/openssl/lib/ossl-modules /opt/fips-probe/openssl/bin/openssl list -signature-algorithms
  { 1.2.840.113549.1.1.1, 2.5.8.1.1, RSA, rsaEncryption } @ fips
  { 1.2.840.10040.4.1, 1.3.14.3.2.12, DSA, DSA-old, dsaEncryption, dsaEncryption-old } @ fips
  { 1.2.840.10040.4.3, 1.3.14.3.2.27, DSA-SHA, DSA-SHA-1, DSA-SHA1, DSA-SHA1-old, dsaWithSHA, dsaWithSHA1, dsaWithSHA1-old } @ fips
  { 1.3.101.112, ED25519 } @ fips
  { 1.3.101.113, ED448 } @ fips
  { 2.16.840.1.101.3.4.3.1, DSA-SHA2-224, DSA-SHA224, dsa_with_SHA224 } @ fips
  { 2.16.840.1.101.3.4.3.2, DSA-SHA2-256, DSA-SHA256, dsa_with_SHA256 } @ fips
  { 1.2.840.1.101.3.4.3.3, DSA-SHA2-384, DSA-SHA384, dsa_with_SHA384, id-dsa-with-sha384 } @ fips
  { 1.2.840.1.101.3.4.3.4, DSA-SHA2-512, DSA-SHA512, dsa_with_SHA512, id-dsa-with-sha512 } @ fips
  { 2.16.840.1.101.3.4.3.5, DSA-SHA3-224, dsa_with_SHA3-224, id-dsa-with-sha3-224 } @ fips
  { 2.16.840.1.101.3.4.3.6, DSA-SHA3-256, dsa_with_SHA3-256, id-dsa-with-sha3-256 } @ fips
  { 2.16.840.1.101.3.4.3.7, DSA-SHA3-384, dsa_with_SHA3-384, id-dsa-with-sha3-384 } @ fips
  { 2.16.840.1.101.3.4.3.8, DSA-SHA3-512, dsa_with_SHA3-512, id-dsa-with-sha3-512 } @ fips
  { 1.2.840.113549.1.1.5, RSA-SHA-1, RSA-SHA1, sha1WithRSAEncryption } @ fips
  { 1.2.840.113549.1.1.14, RSA-SHA2-224, RSA-SHA224, sha224WithRSAEncryption } @ fips
  { 1.2.840.113549.1.1.11, RSA-SHA2-256, RSA-SHA256, sha256WithRSAEncryption } @ fips
  { 1.2.840.113549.1.1.12, RSA-SHA2-384, RSA-SHA384, sha384WithRSAEncryption } @ fips
  { 1.2.840.113549.1.1.13, RSA-SHA2-512, RSA-SHA512, sha512WithRSAEncryption } @ fips
  { 1.2.840.113549.1.1.15, RSA-SHA2-512/224, RSA-SHA512-224, sha512-224WithRSAEncryption } @ fips
  { 1.2.840.113549.1.1.16, RSA-SHA2-512/256, RSA-SHA512-256, sha512-256WithRSAEncryption } @ fips
  { 2.16.840.1.101.3.4.3.13, id-rsassa-pkcs1-v1_5-with-sha3-224, RSA-SHA3-224 } @ fips
  { 2.16.840.1.101.3.4.3.14, id-rsassa-pkcs1-v1_5-with-sha3-256, RSA-SHA3-256 } @ fips
  { 2.16.840.1.101.3.4.3.15, id-rsassa-pkcs1-v1_5-with-sha3-384, RSA-SHA3-384 } @ fips
  { 2.16.840.1.101.3.4.3.16, id-rsassa-pkcs1-v1_5-with-sha3-512, RSA-SHA3-512 } @ fips
  ED25519ph @ fips
  ED448ph @ fips
  ECDSA @ fips
  { 1.2.840.10045.4.1, ECDSA-SHA-1, ECDSA-SHA1, ecdsa-with-SHA1 } @ fips
  { 1.2.840.10045.4.3.1, ECDSA-SHA2-224, ECDSA-SHA224, ecdsa-with-SHA224 } @ fips
  { 1.2.840.10045.4.3.2, ECDSA-SHA2-256, ECDSA-SHA256, ecdsa-with-SHA256 } @ fips
  { 1.2.840.10045.4.3.3, ECDSA-SHA2-384, ECDSA-SHA384, ecdsa-with-SHA384 } @ fips
  { 1.2.840.10045.4.3.4, ECDSA-SHA2-512, ECDSA-SHA512, ecdsa-with-SHA512 } @ fips
  { 2.16.840.1.101.3.4.3.9, ECDSA-SHA3-224, ecdsa_with_SHA3-224, id-ecdsa-with-sha3-224 } @ fips
  { 2.16.840.1.101.3.4.3.10, ECDSA-SHA3-256, ecdsa_with_SHA3-256, id-ecdsa-with-sha3-256 } @ fips
  { 2.16.840.1.101.3.4.3.11, ECDSA-SHA3-384, ecdsa_with_SHA3-384, id-ecdsa-with-sha3-384 } @ fips
  { 2.16.840.1.101.3.4.3.12, ECDSA-SHA3-512, ecdsa_with_SHA3-512, id-ecdsa-with-sha3-512 } @ fips
  { 2.16.840.1.101.3.4.3.17, id-ml-dsa-44, ML-DSA-44, MLDSA44 } @ fips
  { 2.16.840.1.101.3.4.3.18, id-ml-dsa-65, ML-DSA-65, MLDSA65 } @ fips
  { 2.16.840.1.101.3.4.3.19, id-ml-dsa-87, ML-DSA-87, MLDSA87 } @ fips
  HMAC @ fips
  CMAC @ fips
  { 2.16.840.1.101.3.4.3.20, id-slh-dsa-sha2-128s, SLH-DSA-SHA2-128s } @ fips
  { 2.16.840.1.101.3.4.3.21, id-slh-dsa-sha2-128f, SLH-DSA-SHA2-128f } @ fips
  { 2.16.840.1.101.3.4.3.22, id-slh-dsa-sha2-192s, SLH-DSA-SHA2-192s } @ fips
  { 2.16.840.1.101.3.4.3.23, id-slh-dsa-sha2-192f, SLH-DSA-SHA2-192f } @ fips
  { 2.16.840.1.101.3.4.3.24, id-slh-dsa-sha2-256s, SLH-DSA-SHA2-256s } @ fips
  { 2.16.840.1.101.3.4.3.25, id-slh-dsa-sha2-256f, SLH-DSA-SHA2-256f } @ fips
  { 2.16.840.1.101.3.4.3.26, id-slh-dsa-shake-128s, SLH-DSA-SHAKE-128s } @ fips
  { 2.16.840.1.101.3.4.3.27, id-slh-dsa-shake-128f, SLH-DSA-SHAKE-128f } @ fips
  { 2.16.840.1.101.3.4.3.28, id-slh-dsa-shake-192s, SLH-DSA-SHAKE-192s } @ fips
  { 2.16.840.1.101.3.4.3.29, id-slh-dsa-shake-192f, SLH-DSA-SHAKE-192f } @ fips
  { 2.16.840.1.101.3.4.3.30, id-slh-dsa-shake-256s, SLH-DSA-SHAKE-256s } @ fips
  { 2.16.840.1.101.3.4.3.31, id-slh-dsa-shake-256f, SLH-DSA-SHAKE-256f } @ fips
[exit status 0]

### KEM algorithms, fips-only configuration
$ env OPENSSL_CONF=/probe/tmp/list/fips-only.cnf OPENSSL_MODULES=/opt/fips-probe/openssl/lib/ossl-modules /opt/fips-probe/openssl/bin/openssl list -kem-algorithms
  { 1.2.840.113549.1.1.1, 2.5.8.1.1, RSA, rsaEncryption } @ fips
  { 2.16.840.1.101.3.4.4.1, id-alg-ml-kem-512, ML-KEM-512, MLKEM512 } @ fips
  { 2.16.840.1.101.3.4.4.2, id-alg-ml-kem-768, ML-KEM-768, MLKEM768 } @ fips
  { 2.16.840.1.101.3.4.4.3, id-alg-ml-kem-1024, ML-KEM-1024, MLKEM1024 } @ fips
  X25519MLKEM768 @ fips
  X448MLKEM1024 @ fips
  SecP256r1MLKEM768 @ fips
  SecP384r1MLKEM1024 @ fips
[exit status 0]

### openssl list -key-exchange-algorithms -provider fips
$ env OPENSSL_CONF=/probe/tmp/list/fips-only.cnf OPENSSL_MODULES=/opt/fips-probe/openssl/lib/ossl-modules /opt/fips-probe/openssl/bin/openssl list -key-exchange-algorithms -provider fips
  { 1.2.840.113549.1.3.1, DH, dhKeyAgreement } @ fips
  ECDH @ fips
  TLS1-PRF @ fips
  HKDF @ fips
[exit status 0]

### openssl list -signature-algorithms -provider fips
$ env OPENSSL_CONF=/probe/tmp/list/fips-only.cnf OPENSSL_MODULES=/opt/fips-probe/openssl/lib/ossl-modules /opt/fips-probe/openssl/bin/openssl list -signature-algorithms -provider fips
  { 1.2.840.113549.1.1.1, 2.5.8.1.1, RSA, rsaEncryption } @ fips
  { 1.2.840.10040.4.1, 1.3.14.3.2.12, DSA, DSA-old, dsaEncryption, dsaEncryption-old } @ fips
  { 1.2.840.10040.4.3, 1.3.14.3.2.27, DSA-SHA, DSA-SHA-1, DSA-SHA1, DSA-SHA1-old, dsaWithSHA, dsaWithSHA1, dsaWithSHA1-old } @ fips
  { 1.3.101.112, ED25519 } @ fips
  { 1.3.101.113, ED448 } @ fips
  { 2.16.840.1.101.3.4.3.1, DSA-SHA2-224, DSA-SHA224, dsa_with_SHA224 } @ fips
  { 2.16.840.1.101.3.4.3.2, DSA-SHA2-256, DSA-SHA256, dsa_with_SHA256 } @ fips
  { 1.2.840.1.101.3.4.3.3, DSA-SHA2-384, DSA-SHA384, dsa_with_SHA384, id-dsa-with-sha384 } @ fips
  { 1.2.840.1.101.3.4.3.4, DSA-SHA2-512, DSA-SHA512, dsa_with_SHA512, id-dsa-with-sha512 } @ fips
  { 2.16.840.1.101.3.4.3.5, DSA-SHA3-224, dsa_with_SHA3-224, id-dsa-with-sha3-224 } @ fips
  { 2.16.840.1.101.3.4.3.6, DSA-SHA3-256, dsa_with_SHA3-256, id-dsa-with-sha3-256 } @ fips
  { 2.16.840.1.101.3.4.3.7, DSA-SHA3-384, dsa_with_SHA3-384, id-dsa-with-sha3-384 } @ fips
  { 2.16.840.1.101.3.4.3.8, DSA-SHA3-512, dsa_with_SHA3-512, id-dsa-with-sha3-512 } @ fips
  { 1.2.840.113549.1.1.5, RSA-SHA-1, RSA-SHA1, sha1WithRSAEncryption } @ fips
  { 1.2.840.113549.1.1.14, RSA-SHA2-224, RSA-SHA224, sha224WithRSAEncryption } @ fips
  { 1.2.840.113549.1.1.11, RSA-SHA2-256, RSA-SHA256, sha256WithRSAEncryption } @ fips
  { 1.2.840.113549.1.1.12, RSA-SHA2-384, RSA-SHA384, sha384WithRSAEncryption } @ fips
  { 1.2.840.113549.1.1.13, RSA-SHA2-512, RSA-SHA512, sha512WithRSAEncryption } @ fips
  { 1.2.840.113549.1.1.15, RSA-SHA2-512/224, RSA-SHA512-224, sha512-224WithRSAEncryption } @ fips
  { 1.2.840.113549.1.1.16, RSA-SHA2-512/256, RSA-SHA512-256, sha512-256WithRSAEncryption } @ fips
  { 2.16.840.1.101.3.4.3.13, id-rsassa-pkcs1-v1_5-with-sha3-224, RSA-SHA3-224 } @ fips
  { 2.16.840.1.101.3.4.3.14, id-rsassa-pkcs1-v1_5-with-sha3-256, RSA-SHA3-256 } @ fips
  { 2.16.840.1.101.3.4.3.15, id-rsassa-pkcs1-v1_5-with-sha3-384, RSA-SHA3-384 } @ fips
  { 2.16.840.1.101.3.4.3.16, id-rsassa-pkcs1-v1_5-with-sha3-512, RSA-SHA3-512 } @ fips
  ED25519ph @ fips
  ED448ph @ fips
  ECDSA @ fips
  { 1.2.840.10045.4.1, ECDSA-SHA-1, ECDSA-SHA1, ecdsa-with-SHA1 } @ fips
  { 1.2.840.10045.4.3.1, ECDSA-SHA2-224, ECDSA-SHA224, ecdsa-with-SHA224 } @ fips
  { 1.2.840.10045.4.3.2, ECDSA-SHA2-256, ECDSA-SHA256, ecdsa-with-SHA256 } @ fips
  { 1.2.840.10045.4.3.3, ECDSA-SHA2-384, ECDSA-SHA384, ecdsa-with-SHA384 } @ fips
  { 1.2.840.10045.4.3.4, ECDSA-SHA2-512, ECDSA-SHA512, ecdsa-with-SHA512 } @ fips
  { 2.16.840.1.101.3.4.3.9, ECDSA-SHA3-224, ecdsa_with_SHA3-224, id-ecdsa-with-sha3-224 } @ fips
  { 2.16.840.1.101.3.4.3.10, ECDSA-SHA3-256, ecdsa_with_SHA3-256, id-ecdsa-with-sha3-256 } @ fips
  { 2.16.840.1.101.3.4.3.11, ECDSA-SHA3-384, ecdsa_with_SHA3-384, id-ecdsa-with-sha3-384 } @ fips
  { 2.16.840.1.101.3.4.3.12, ECDSA-SHA3-512, ecdsa_with_SHA3-512, id-ecdsa-with-sha3-512 } @ fips
  { 2.16.840.1.101.3.4.3.17, id-ml-dsa-44, ML-DSA-44, MLDSA44 } @ fips
  { 2.16.840.1.101.3.4.3.18, id-ml-dsa-65, ML-DSA-65, MLDSA65 } @ fips
  { 2.16.840.1.101.3.4.3.19, id-ml-dsa-87, ML-DSA-87, MLDSA87 } @ fips
  HMAC @ fips
  CMAC @ fips
  { 2.16.840.1.101.3.4.3.20, id-slh-dsa-sha2-128s, SLH-DSA-SHA2-128s } @ fips
  { 2.16.840.1.101.3.4.3.21, id-slh-dsa-sha2-128f, SLH-DSA-SHA2-128f } @ fips
  { 2.16.840.1.101.3.4.3.22, id-slh-dsa-sha2-192s, SLH-DSA-SHA2-192s } @ fips
  { 2.16.840.1.101.3.4.3.23, id-slh-dsa-sha2-192f, SLH-DSA-SHA2-192f } @ fips
  { 2.16.840.1.101.3.4.3.24, id-slh-dsa-sha2-256s, SLH-DSA-SHA2-256s } @ fips
  { 2.16.840.1.101.3.4.3.25, id-slh-dsa-sha2-256f, SLH-DSA-SHA2-256f } @ fips
  { 2.16.840.1.101.3.4.3.26, id-slh-dsa-shake-128s, SLH-DSA-SHAKE-128s } @ fips
  { 2.16.840.1.101.3.4.3.27, id-slh-dsa-shake-128f, SLH-DSA-SHAKE-128f } @ fips
  { 2.16.840.1.101.3.4.3.28, id-slh-dsa-shake-192s, SLH-DSA-SHAKE-192s } @ fips
  { 2.16.840.1.101.3.4.3.29, id-slh-dsa-shake-192f, SLH-DSA-SHAKE-192f } @ fips
  { 2.16.840.1.101.3.4.3.30, id-slh-dsa-shake-256s, SLH-DSA-SHAKE-256s } @ fips
  { 2.16.840.1.101.3.4.3.31, id-slh-dsa-shake-256f, SLH-DSA-SHAKE-256f } @ fips
[exit status 0]

### openssl list -kem-algorithms -provider fips
$ env OPENSSL_CONF=/probe/tmp/list/fips-only.cnf OPENSSL_MODULES=/opt/fips-probe/openssl/lib/ossl-modules /opt/fips-probe/openssl/bin/openssl list -kem-algorithms -provider fips
  { 1.2.840.113549.1.1.1, 2.5.8.1.1, RSA, rsaEncryption } @ fips
  { 2.16.840.1.101.3.4.4.1, id-alg-ml-kem-512, ML-KEM-512, MLKEM512 } @ fips
  { 2.16.840.1.101.3.4.4.2, id-alg-ml-kem-768, ML-KEM-768, MLKEM768 } @ fips
  { 2.16.840.1.101.3.4.4.3, id-alg-ml-kem-1024, ML-KEM-1024, MLKEM1024 } @ fips
  X25519MLKEM768 @ fips
  X448MLKEM1024 @ fips
  SecP256r1MLKEM768 @ fips
  SecP384r1MLKEM1024 @ fips
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
  { 1.2.840.10040.4.1, 1.3.14.3.2.12, DSA, DSA-old, dsaEncryption, dsaEncryption-old } @ default
  { 1.2.840.10040.4.3, 1.3.14.3.2.27, DSA-SHA, DSA-SHA-1, DSA-SHA1, DSA-SHA1-old, dsaWithSHA, dsaWithSHA1, dsaWithSHA1-old } @ default
  { 1.3.101.112, ED25519 } @ default
  { 1.3.101.113, ED448 } @ default
  { 1.2.156.10197.1.301, SM2 } @ default
  { 2.16.840.1.101.3.4.3.1, DSA-SHA2-224, DSA-SHA224, dsa_with_SHA224 } @ default
  { 2.16.840.1.101.3.4.3.2, DSA-SHA2-256, DSA-SHA256, dsa_with_SHA256 } @ default
  { 1.2.840.1.101.3.4.3.3, DSA-SHA2-384, DSA-SHA384, dsa_with_SHA384, id-dsa-with-sha384 } @ default
  { 1.2.840.1.101.3.4.3.4, DSA-SHA2-512, DSA-SHA512, dsa_with_SHA512, id-dsa-with-sha512 } @ default
  { 2.16.840.1.101.3.4.3.5, DSA-SHA3-224, dsa_with_SHA3-224, id-dsa-with-sha3-224 } @ default
  { 2.16.840.1.101.3.4.3.6, DSA-SHA3-256, dsa_with_SHA3-256, id-dsa-with-sha3-256 } @ default
  { 2.16.840.1.101.3.4.3.7, DSA-SHA3-384, dsa_with_SHA3-384, id-dsa-with-sha3-384 } @ default
  { 2.16.840.1.101.3.4.3.8, DSA-SHA3-512, dsa_with_SHA3-512, id-dsa-with-sha3-512 } @ default
  { 1.3.36.3.3.1.2, ripemd160WithRSA, RSA-RIPEMD160 } @ default
  { 1.2.840.113549.1.1.5, RSA-SHA-1, RSA-SHA1, sha1WithRSAEncryption } @ default
  { 1.2.840.113549.1.1.14, RSA-SHA2-224, RSA-SHA224, sha224WithRSAEncryption } @ default
  { 1.2.840.113549.1.1.11, RSA-SHA2-256, RSA-SHA256, sha256WithRSAEncryption } @ default
  { 1.2.840.113549.1.1.12, RSA-SHA2-384, RSA-SHA384, sha384WithRSAEncryption } @ default
  { 1.2.840.113549.1.1.13, RSA-SHA2-512, RSA-SHA512, sha512WithRSAEncryption } @ default
  { 1.2.840.113549.1.1.15, RSA-SHA2-512/224, RSA-SHA512-224, sha512-224WithRSAEncryption } @ default
  { 1.2.840.113549.1.1.16, RSA-SHA2-512/256, RSA-SHA512-256, sha512-256WithRSAEncryption } @ default
  { 2.16.840.1.101.3.4.3.13, id-rsassa-pkcs1-v1_5-with-sha3-224, RSA-SHA3-224 } @ default
  { 2.16.840.1.101.3.4.3.14, id-rsassa-pkcs1-v1_5-with-sha3-256, RSA-SHA3-256 } @ default
  { 2.16.840.1.101.3.4.3.15, id-rsassa-pkcs1-v1_5-with-sha3-384, RSA-SHA3-384 } @ default
  { 2.16.840.1.101.3.4.3.16, id-rsassa-pkcs1-v1_5-with-sha3-512, RSA-SHA3-512 } @ default
  { 1.2.156.10197.1.504, RSA-SM3, sm3WithRSAEncryption } @ default
  ED25519ph @ default
  ED25519ctx @ default
  ED448ph @ default
  ECDSA @ default
  { 1.2.840.10045.4.1, ECDSA-SHA-1, ECDSA-SHA1, ecdsa-with-SHA1 } @ default
  { 1.2.840.10045.4.3.1, ECDSA-SHA2-224, ECDSA-SHA224, ecdsa-with-SHA224 } @ default
  { 1.2.840.10045.4.3.2, ECDSA-SHA2-256, ECDSA-SHA256, ecdsa-with-SHA256 } @ default
  { 1.2.840.10045.4.3.3, ECDSA-SHA2-384, ECDSA-SHA384, ecdsa-with-SHA384 } @ default
  { 1.2.840.10045.4.3.4, ECDSA-SHA2-512, ECDSA-SHA512, ecdsa-with-SHA512 } @ default
  { 2.16.840.1.101.3.4.3.9, ECDSA-SHA3-224, ecdsa_with_SHA3-224, id-ecdsa-with-sha3-224 } @ default
  { 2.16.840.1.101.3.4.3.10, ECDSA-SHA3-256, ecdsa_with_SHA3-256, id-ecdsa-with-sha3-256 } @ default
  { 2.16.840.1.101.3.4.3.11, ECDSA-SHA3-384, ecdsa_with_SHA3-384, id-ecdsa-with-sha3-384 } @ default
  { 2.16.840.1.101.3.4.3.12, ECDSA-SHA3-512, ecdsa_with_SHA3-512, id-ecdsa-with-sha3-512 } @ default
  { 2.16.840.1.101.3.4.3.17, id-ml-dsa-44, ML-DSA-44, MLDSA44 } @ default
  { 2.16.840.1.101.3.4.3.18, id-ml-dsa-65, ML-DSA-65, MLDSA65 } @ default
  { 2.16.840.1.101.3.4.3.19, id-ml-dsa-87, ML-DSA-87, MLDSA87 } @ default
  HMAC @ default
  SIPHASH @ default
  POLY1305 @ default
  CMAC @ default
  { 2.16.840.1.101.3.4.3.20, id-slh-dsa-sha2-128s, SLH-DSA-SHA2-128s } @ default
  { 2.16.840.1.101.3.4.3.21, id-slh-dsa-sha2-128f, SLH-DSA-SHA2-128f } @ default
  { 2.16.840.1.101.3.4.3.22, id-slh-dsa-sha2-192s, SLH-DSA-SHA2-192s } @ default
  { 2.16.840.1.101.3.4.3.23, id-slh-dsa-sha2-192f, SLH-DSA-SHA2-192f } @ default
  { 2.16.840.1.101.3.4.3.24, id-slh-dsa-sha2-256s, SLH-DSA-SHA2-256s } @ default
  { 2.16.840.1.101.3.4.3.25, id-slh-dsa-sha2-256f, SLH-DSA-SHA2-256f } @ default
  { 2.16.840.1.101.3.4.3.26, id-slh-dsa-shake-128s, SLH-DSA-SHAKE-128s } @ default
  { 2.16.840.1.101.3.4.3.27, id-slh-dsa-shake-128f, SLH-DSA-SHAKE-128f } @ default
  { 2.16.840.1.101.3.4.3.28, id-slh-dsa-shake-192s, SLH-DSA-SHAKE-192s } @ default
  { 2.16.840.1.101.3.4.3.29, id-slh-dsa-shake-192f, SLH-DSA-SHAKE-192f } @ default
  { 2.16.840.1.101.3.4.3.30, id-slh-dsa-shake-256s, SLH-DSA-SHAKE-256s } @ default
  { 2.16.840.1.101.3.4.3.31, id-slh-dsa-shake-256f, SLH-DSA-SHAKE-256f } @ default
[exit status 0]

==============================================================
Derived answers
==============================================================
RESULT: X25519 among the fips provider's key-exchange algorithms: ABSENT
  derived from: /probe/tmp/list/kex-fips-config.out
  matching lines:
    (none)
  of those, annotated with the fips provider:
    (none)

RESULT: Ed25519 among the fips provider's signature algorithms: PRESENT
  derived from: /probe/tmp/list/sig-fips-config.out
  matching lines:
    4:  { 1.3.101.112, ED25519 } @ fips
  of those, annotated with the fips provider:
    4:  { 1.3.101.112, ED25519 } @ fips

RESULT: control -- X25519 among the default configuration's key-exchange algorithms: PRESENT
  derived from: /probe/tmp/list/kex-default.out
  matching lines:
    2:  { 1.3.101.110, X25519 } @ default
  of those, annotated with the fips provider:
    (none)

RESULT: control -- Ed25519 among the default configuration's signature algorithms: PRESENT
  derived from: /probe/tmp/list/sig-default.out
  matching lines:
    4:  { 1.3.101.112, ED25519 } @ default
  of those, annotated with the fips provider:
    (none)

LIST_JSON: {"provider_build_tag":"openssl-3.5.7","openssl_cli_version":"OpenSSL 3.5.7 9 Jun 2026 (Library: OpenSSL 3.5.7 9 Jun 2026)","node_version":"v26.5.0","node_openssl_version":"3.5.7","fips_module":"/opt/fips-probe/openssl/lib/ossl-modules/fips.so","fips_module_sha256":"74cee9ce943744dc111fccf6d3e43dade3f6a866fa838d679afb232b65b666e1  /opt/fips-probe/openssl/lib/ossl-modules/fips.so","fips_provider_status":"active","x25519_key_exchange_under_fips":"ABSENT","ed25519_signature_under_fips":"PRESENT","x25519_key_exchange_default_control":"PRESENT","ed25519_signature_default_control":"PRESENT"}
```

## crypto.subtle engagement (question 3)

```

==============================================================
crypto.subtle FIPS engagement probe
==============================================================
provider build (OpenSSL release tag): openssl-3.5.7
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
    stdout: d3767069
    verdict: no effect observed (the run succeeded regardless)

--openssl-config pointing at a file with an unreadable .include:
    $ node --openssl-config=/probe/tmp/webcrypto/unreadable-include.cnf -e console.log(require('node:crypto').randomBytes(4).toString('hex'));
    [exit status 0, signal null]
    stdout: 61d3654b
    verdict: no effect observed (the run succeeded regardless)

OPENSSL_CONF with an unloadable provider under the openssl_conf key:
    $ node -e console.log(require('node:crypto').randomBytes(4).toString('hex'));
      env OPENSSL_CONF=/probe/tmp/webcrypto/bad-provider-openssl-conf.cnf
    [exit status 0, signal null]
    stdout: d8b7ae21
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
              "7f4e4abf6000-7f4e4ac1d000 r--p 00000000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f4e4ac1d000-7f4e4ae1c000 r-xp 00027000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f4e4ae1c000-7f4e4aea2000 r--p 00226000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f4e4aea2000-7f4e4aec3000 r--p 002ac000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f4e4aec3000-7f4e4aec4000 rw-p 002cd000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
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
              "7f4e4abf6000-7f4e4ac1d000 r--p 00000000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f4e4ac1d000-7f4e4ae1c000 r-xp 00027000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f4e4ae1c000-7f4e4aea2000 r--p 00226000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f4e4aea2000-7f4e4aec3000 r--p 002ac000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f4e4aec3000-7f4e4aec4000 rw-p 002cd000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
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
              "7f4e4abf6000-7f4e4ac1d000 r--p 00000000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f4e4ac1d000-7f4e4ae1c000 r-xp 00027000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f4e4ae1c000-7f4e4aea2000 r--p 00226000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f4e4aea2000-7f4e4aec3000 r--p 002ac000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7f4e4aec3000-7f4e4aec4000 rw-p 002cd000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
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
              "7fd1eca1c000-7fd1eca43000 r--p 00000000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fd1eca43000-7fd1ecc42000 r-xp 00027000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fd1ecc42000-7fd1eccc8000 r--p 00226000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fd1eccc8000-7fd1ecce9000 r--p 002ac000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fd1ecce9000-7fd1eccea000 rw-p 002cd000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
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
              "7fd1eca1c000-7fd1eca43000 r--p 00000000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fd1eca43000-7fd1ecc42000 r-xp 00027000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fd1ecc42000-7fd1eccc8000 r--p 00226000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fd1eccc8000-7fd1ecce9000 r--p 002ac000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fd1ecce9000-7fd1eccea000 rw-p 002cd000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
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
              "7fd1eca1c000-7fd1eca43000 r--p 00000000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fd1eca43000-7fd1ecc42000 r-xp 00027000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fd1ecc42000-7fd1eccc8000 r--p 00226000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fd1eccc8000-7fd1ecce9000 r--p 002ac000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fd1ecce9000-7fd1eccea000 rw-p 002cd000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
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
              "7fdcaf59f000-7fdcaf5c6000 r--p 00000000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fdcaf5c6000-7fdcaf7c5000 r-xp 00027000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fdcaf7c5000-7fdcaf84b000 r--p 00226000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fdcaf84b000-7fdcaf86c000 r--p 002ac000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fdcaf86c000-7fdcaf86d000 rw-p 002cd000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
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
              "7fdcaf59f000-7fdcaf5c6000 r--p 00000000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fdcaf5c6000-7fdcaf7c5000 r-xp 00027000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fdcaf7c5000-7fdcaf84b000 r--p 00226000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fdcaf84b000-7fdcaf86c000 r--p 002ac000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fdcaf86c000-7fdcaf86d000 rw-p 002cd000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
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
              "7fdcaf59f000-7fdcaf5c6000 r--p 00000000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fdcaf5c6000-7fdcaf7c5000 r-xp 00027000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fdcaf7c5000-7fdcaf84b000 r--p 00226000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fdcaf84b000-7fdcaf86c000 r--p 002ac000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fdcaf86c000-7fdcaf86d000 rw-p 002cd000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
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
              "7fd06b3d5000-7fd06b3fc000 r--p 00000000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fd06b3fc000-7fd06b5fb000 r-xp 00027000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fd06b5fb000-7fd06b681000 r--p 00226000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fd06b681000-7fd06b6a2000 r--p 002ac000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fd06b6a2000-7fd06b6a3000 rw-p 002cd000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
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
              "7fd06b3d5000-7fd06b3fc000 r--p 00000000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fd06b3fc000-7fd06b5fb000 r-xp 00027000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fd06b5fb000-7fd06b681000 r--p 00226000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fd06b681000-7fd06b6a2000 r--p 002ac000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fd06b6a2000-7fd06b6a3000 rw-p 002cd000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
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
              "7fd06b3d5000-7fd06b3fc000 r--p 00000000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fd06b3fc000-7fd06b5fb000 r-xp 00027000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fd06b5fb000-7fd06b681000 r--p 00226000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fd06b681000-7fd06b6a2000 r--p 002ac000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fd06b6a2000-7fd06b6a3000 rw-p 002cd000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
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
              "7fddde041000-7fddde068000 r--p 00000000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fddde068000-7fddde267000 r-xp 00027000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fddde267000-7fddde2ed000 r--p 00226000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fddde2ed000-7fddde30e000 r--p 002ac000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fddde30e000-7fddde30f000 rw-p 002cd000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
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
              "7fddde041000-7fddde068000 r--p 00000000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fddde068000-7fddde267000 r-xp 00027000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fddde267000-7fddde2ed000 r--p 00226000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fddde2ed000-7fddde30e000 r--p 002ac000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fddde30e000-7fddde30f000 rw-p 002cd000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
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
              "7fddde041000-7fddde068000 r--p 00000000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fddde068000-7fddde267000 r-xp 00027000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fddde267000-7fddde2ed000 r--p 00226000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fddde2ed000-7fddde30e000 r--p 002ac000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so",
              "7fddde30e000-7fddde30f000 rw-p 002cd000 00:30 8931467                    /opt/fips-probe/openssl/lib/ossl-modules/fips.so"
            ]
          }
        }
    S2 verdict: AES-256-GCM round trip: SUCCEEDED; fips.so mapped: yes; crypto.getFips(): 1
    S3 control MD5 digest through node:crypto (never an approved algorithm): baseline SUCCEEDED, fips-only FAILED (Error: error:0308010C:digital envelope routines::unsupported [openssl: error:03000086:digital envelope routines::initialization error | error:0308010C:digital envelope routines::unsupported])
    S3 control RSA-1024 keygen through crypto.subtle (below the FIPS minimum modulus): baseline SUCCEEDED, fips-only FAILED (OperationError: The operation failed for an operation-specific reason)
    S3 control X25519 deriveBits through crypto.subtle: baseline SUCCEEDED, fips-only FAILED (OperationError: The operation failed for an operation-specific reason)
    corroborating (node:crypto, not crypto.subtle) MD5 digest: baseline SUCCEEDED, fips-only FAILED

==============================================================
S4 causal controls: break the provider, re-run the same call
==============================================================
module-mac corrupted in the copied fipsmodule.cnf: yes
fips.so truncated to 4096 of 3207584 bytes at /probe/tmp/webcrypto/truncated-modules/fips.so

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
- causal controls that took effect and stopped the call: S4a (corrupted module-mac), S4b (truncated fips.so)

QUESTION 3 VERDICT: ENGAGED
REASON: AES-256-GCM through crypto.subtle succeeded under a fips-only configuration, every operation no FIPS provider serves failed in that same process, and breaking the provider stopped the call

PROBE_JSON: {"provider_build_tag":"openssl-3.5.7","fips_module":"/opt/fips-probe/openssl/lib/ossl-modules/fips.so","node_version":"v26.5.0","node_openssl_version":"3.5.7","node_shared_openssl":false,"cross_load":false,"configuration_mechanisms":[{"name":"OPENSSL_CONF pointing at a file with an unreadable .include","reached_openssl":false,"status":0},{"name":"--openssl-config pointing at a file with an unreadable .include","reached_openssl":false,"status":0},{"name":"OPENSSL_CONF with an unloadable provider under the openssl_conf key","reached_openssl":false,"status":0},{"name":"OPENSSL_CONF with an unloadable provider under the nodejs_conf key","reached_openssl":true,"status":null},{"name":"--openssl-shared-config with an unloadable provider under the openssl_conf key","reached_openssl":true,"status":null},{"name":"OPENSSL_MODULES pointing at a directory holding no fips.so","reached_openssl":true,"status":null}],"engagement":[{"recipe":"OPENSSL_CONF + OPENSSL_MODULES environment variables","fips_module_mapped":true,"get_fips":1,"aes_ok":true,"exit_status":0},{"recipe":"node --openssl-config=<file> + OPENSSL_MODULES","fips_module_mapped":true,"get_fips":1,"aes_ok":true,"exit_status":0},{"recipe":"node --openssl-shared-config + OPENSSL_CONF + OPENSSL_MODULES","fips_module_mapped":true,"get_fips":1,"aes_ok":true,"exit_status":0},{"recipe":"OPENSSL_CONF naming the module path in the provider section (no OPENSSL_MODULES)","fips_module_mapped":true,"get_fips":1,"aes_ok":true,"exit_status":0}],"chosen_configuration":"OPENSSL_CONF + OPENSSL_MODULES environment variables","scenarios":{"S1-baseline":{"exit_status":0,"fips_module_mapped":false,"get_fips":0,"operations":{"aes256gcm_round_trip":{"ran":true,"ok":true,"error":null},"x25519_derive_bits":{"ran":true,"ok":true,"error":null},"rsa1024_keygen":{"ran":true,"ok":true,"error":null},"md5_digest":{"ran":true,"ok":true,"error":null}}},"S1b-setFips-default-config":{"exit_status":0,"fips_module_mapped":false,"get_fips":1,"operations":{"aes256gcm_round_trip":{"ran":true,"ok":false,"error":"OperationError: The operation failed for an operation-specific reason"},"x25519_derive_bits":{"ran":true,"ok":false,"error":"OperationError: The operation failed for an operation-specific reason"},"rsa1024_keygen":{"ran":true,"ok":false,"error":"OperationError: The operation failed for an operation-specific reason"},"md5_digest":{"ran":true,"ok":false,"error":"Error: error:0308010C:digital envelope routines::unsupported [openssl: error:03000086:digital envelope routines::initialization error | error:0308010C:digital envelope routines::unsupported]"}}},"S2-S3-fips-only":{"exit_status":0,"fips_module_mapped":true,"get_fips":1,"operations":{"aes256gcm_round_trip":{"ran":true,"ok":true,"error":null},"x25519_derive_bits":{"ran":true,"ok":false,"error":"OperationError: The operation failed for an operation-specific reason"},"rsa1024_keygen":{"ran":true,"ok":false,"error":"OperationError: The operation failed for an operation-specific reason"},"md5_digest":{"ran":true,"ok":false,"error":"Error: error:0308010C:digital envelope routines::unsupported [openssl: error:03000086:digital envelope routines::initialization error | error:0308010C:digital envelope routines::unsupported]"}}},"S4a-broken-mac":{"exit_status":null,"fips_module_mapped":false,"get_fips":null,"operations":{"aes256gcm_round_trip":{"ran":false,"ok":false,"error":null},"x25519_derive_bits":{"ran":false,"ok":false,"error":null},"rsa1024_keygen":{"ran":false,"ok":false,"error":null},"md5_digest":{"ran":false,"ok":false,"error":null}}},"S4b-broken-module":{"exit_status":null,"fips_module_mapped":false,"get_fips":null,"operations":{"aes256gcm_round_trip":{"ran":false,"ok":false,"error":null},"x25519_derive_bits":{"ran":false,"ok":false,"error":null},"rsa1024_keygen":{"ran":false,"ok":false,"error":null},"md5_digest":{"ran":false,"ok":false,"error":null}}}},"causal_controls":[{"label":"S4a (corrupted module-mac)","took_effect":true,"why":"fips.so was not mapped","aes_ok":false},{"label":"S4b (truncated fips.so)","took_effect":true,"why":"fips.so was not mapped","aes_ok":false}],"verdict":"ENGAGED","reason":"AES-256-GCM through crypto.subtle succeeded under a fips-only configuration, every operation no FIPS provider serves failed in that same process, and breaking the provider stopped the call"}
```

## Image build (tail)

```
#11 274.0 	crypto/rsa/libcrypto-shlib-rsa_lib.o \
#11 274.0 	crypto/rsa/libcrypto-shlib-rsa_meth.o \
#11 274.0 	crypto/rsa/libcrypto-shlib-rsa_mp.o \
#11 274.0 	crypto/rsa/libcrypto-shlib-rsa_mp_names.o \
#11 274.0 	crypto/rsa/libcrypto-shlib-rsa_none.o \
#11 274.0 	crypto/rsa/libcrypto-shlib-rsa_oaep.o \
#11 274.0 	crypto/rsa/libcrypto-shlib-rsa_ossl.o \
#11 274.0 	crypto/rsa/libcrypto-shlib-rsa_pk1.o \
#11 274.0 	crypto/rsa/libcrypto-shlib-rsa_pmeth.o \
#11 274.0 	crypto/rsa/libcrypto-shlib-rsa_prn.o \
#11 274.0 	crypto/rsa/libcrypto-shlib-rsa_pss.o \
#11 274.0 	crypto/rsa/libcrypto-shlib-rsa_saos.o \
#11 274.0 	crypto/rsa/libcrypto-shlib-rsa_schemes.o \
#11 274.0 	crypto/rsa/libcrypto-shlib-rsa_sign.o \
#11 274.0 	crypto/rsa/libcrypto-shlib-rsa_sp800_56b_check.o \
#11 274.0 	crypto/rsa/libcrypto-shlib-rsa_sp800_56b_gen.o \
#11 274.0 	crypto/rsa/libcrypto-shlib-rsa_x931.o \
#11 274.0 	crypto/rsa/libcrypto-shlib-rsa_x931g.o \
#11 274.0 	crypto/seed/libcrypto-shlib-seed.o \
#11 274.0 	crypto/seed/libcrypto-shlib-seed_cbc.o \
#11 274.0 	crypto/seed/libcrypto-shlib-seed_cfb.o \
#11 274.0 	crypto/seed/libcrypto-shlib-seed_ecb.o \
#11 274.0 	crypto/seed/libcrypto-shlib-seed_ofb.o \
#11 274.0 	crypto/sha/libcrypto-shlib-keccak1600-x86_64.o \
#11 274.0 	crypto/sha/libcrypto-shlib-sha1-mb-x86_64.o \
#11 274.0 	crypto/sha/libcrypto-shlib-sha1-x86_64.o \
#11 274.0 	crypto/sha/libcrypto-shlib-sha1_one.o \
#11 274.0 	crypto/sha/libcrypto-shlib-sha1dgst.o \
#11 274.0 	crypto/sha/libcrypto-shlib-sha256-mb-x86_64.o \
#11 274.0 	crypto/sha/libcrypto-shlib-sha256-x86_64.o \
#11 274.0 	crypto/sha/libcrypto-shlib-sha256.o \
#11 274.0 	crypto/sha/libcrypto-shlib-sha3.o \
#11 274.0 	crypto/sha/libcrypto-shlib-sha512-x86_64.o \
#11 274.0 	crypto/sha/libcrypto-shlib-sha512.o \
#11 274.0 	crypto/siphash/libcrypto-shlib-siphash.o \
#11 274.0 	crypto/slh_dsa/libcrypto-shlib-slh_adrs.o \
#11 274.0 	crypto/slh_dsa/libcrypto-shlib-slh_dsa.o \
#11 274.0 	crypto/slh_dsa/libcrypto-shlib-slh_dsa_hash_ctx.o \
#11 274.0 	crypto/slh_dsa/libcrypto-shlib-slh_dsa_key.o \
#11 274.0 	crypto/slh_dsa/libcrypto-shlib-slh_fors.o \
#11 274.0 	crypto/slh_dsa/libcrypto-shlib-slh_hash.o \
#11 274.0 	crypto/slh_dsa/libcrypto-shlib-slh_hypertree.o \
#11 274.0 	crypto/slh_dsa/libcrypto-shlib-slh_params.o \
#11 274.0 	crypto/slh_dsa/libcrypto-shlib-slh_wots.o \
#11 274.0 	crypto/slh_dsa/libcrypto-shlib-slh_xmss.o \
#11 274.0 	crypto/sm2/libcrypto-shlib-sm2_crypt.o \
#11 274.0 	crypto/sm2/libcrypto-shlib-sm2_err.o \
#11 274.0 	crypto/sm2/libcrypto-shlib-sm2_key.o \
#11 274.0 	crypto/sm2/libcrypto-shlib-sm2_sign.o \
#11 274.0 	crypto/sm3/libcrypto-shlib-legacy_sm3.o \
#11 274.0 	crypto/sm3/libcrypto-shlib-sm3.o \
#11 274.0 	crypto/sm4/libcrypto-shlib-sm4.o \
#11 274.0 	crypto/srp/libcrypto-shlib-srp_lib.o \
#11 274.0 	crypto/srp/libcrypto-shlib-srp_vfy.o \
#11 274.0 	crypto/stack/libcrypto-shlib-stack.o \
#11 274.0 	crypto/store/libcrypto-shlib-store_err.o \
#11 274.0 	crypto/store/libcrypto-shlib-store_init.o \
#11 274.0 	crypto/store/libcrypto-shlib-store_lib.o \
#11 274.0 	crypto/store/libcrypto-shlib-store_meth.o \
#11 274.0 	crypto/store/libcrypto-shlib-store_register.o \
#11 274.0 	crypto/store/libcrypto-shlib-store_result.o \
#11 274.0 	crypto/store/libcrypto-shlib-store_strings.o \
#11 274.0 	crypto/thread/arch/libcrypto-shlib-thread_none.o \
#11 274.0 	crypto/thread/arch/libcrypto-shlib-thread_posix.o \
#11 274.0 	crypto/thread/arch/libcrypto-shlib-thread_win.o \
#11 274.0 	crypto/thread/libcrypto-shlib-api.o \
#11 274.0 	crypto/thread/libcrypto-shlib-arch.o \
#11 274.0 	crypto/thread/libcrypto-shlib-internal.o \
#11 274.0 	crypto/ts/libcrypto-shlib-ts_asn1.o \
#11 274.0 	crypto/ts/libcrypto-shlib-ts_conf.o \
#11 274.0 	crypto/ts/libcrypto-shlib-ts_err.o \
#11 274.0 	crypto/ts/libcrypto-shlib-ts_lib.o \
#11 274.0 	crypto/ts/libcrypto-shlib-ts_req_print.o \
#11 274.0 	crypto/ts/libcrypto-shlib-ts_req_utils.o \
#11 274.0 	crypto/ts/libcrypto-shlib-ts_rsp_print.o \
#11 274.0 	crypto/ts/libcrypto-shlib-ts_rsp_sign.o \
#11 274.0 	crypto/ts/libcrypto-shlib-ts_rsp_utils.o \
#11 274.0 	crypto/ts/libcrypto-shlib-ts_rsp_verify.o \
#11 274.0 	crypto/ts/libcrypto-shlib-ts_verify_ctx.o \
#11 274.0 	crypto/txt_db/libcrypto-shlib-txt_db.o \
#11 274.0 	crypto/ui/libcrypto-shlib-ui_err.o \
#11 274.0 	crypto/ui/libcrypto-shlib-ui_lib.o \
#11 274.0 	crypto/ui/libcrypto-shlib-ui_null.o \
#11 274.0 	crypto/ui/libcrypto-shlib-ui_openssl.o \
#11 274.0 	crypto/ui/libcrypto-shlib-ui_util.o \
#11 274.0 	crypto/whrlpool/libcrypto-shlib-wp-x86_64.o \
#11 274.0 	crypto/whrlpool/libcrypto-shlib-wp_dgst.o \
#11 274.0 	crypto/x509/libcrypto-shlib-by_dir.o \
#11 274.0 	crypto/x509/libcrypto-shlib-by_file.o \
#11 274.0 	crypto/x509/libcrypto-shlib-by_store.o \
#11 274.0 	crypto/x509/libcrypto-shlib-pcy_cache.o \
#11 274.0 	crypto/x509/libcrypto-shlib-pcy_data.o \
#11 274.0 	crypto/x509/libcrypto-shlib-pcy_lib.o \
#11 274.0 	crypto/x509/libcrypto-shlib-pcy_map.o \
#11 274.0 	crypto/x509/libcrypto-shlib-pcy_node.o \
#11 274.0 	crypto/x509/libcrypto-shlib-pcy_tree.o \
#11 274.0 	crypto/x509/libcrypto-shlib-t_acert.o \
#11 274.0 	crypto/x509/libcrypto-shlib-t_crl.o \
#11 274.0 	crypto/x509/libcrypto-shlib-t_req.o \
#11 274.0 	crypto/x509/libcrypto-shlib-t_x509.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_aaa.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_ac_tgt.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_addr.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_admis.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_akeya.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_akid.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_asid.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_attrdesc.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_attrmap.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_audit_id.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_authattid.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_battcons.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_bcons.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_bitst.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_conf.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_cpols.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_crld.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_enum.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_extku.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_genn.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_group_ac.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_ia5.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_ind_iss.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_info.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_int.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_iobo.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_ist.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_lib.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_ncons.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_no_ass.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_no_rev_avail.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_pci.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_pcia.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_pcons.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_pku.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_pmaps.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_prn.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_purp.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_rolespec.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_san.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_sda.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_single_use.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_skid.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_soa_id.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_sxnet.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_timespec.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_tlsf.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_usernotice.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_utf8.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3_utl.o \
#11 274.0 	crypto/x509/libcrypto-shlib-v3err.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x509_acert.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x509_att.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x509_cmp.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x509_d2.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x509_def.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x509_err.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x509_ext.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x509_lu.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x509_meth.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x509_obj.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x509_r2x.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x509_req.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x509_set.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x509_trust.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x509_txt.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x509_v3.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x509_vfy.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x509_vpm.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x509aset.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x509cset.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x509name.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x509rset.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x509spki.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x509type.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x_all.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x_attrib.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x_crl.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x_exten.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x_ietfatt.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x_name.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x_pubkey.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x_req.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x_x509.o \
#11 274.0 	crypto/x509/libcrypto-shlib-x_x509a.o \
#11 274.0 	providers/libcrypto-shlib-baseprov.o \
#11 274.0 	providers/libcrypto-shlib-defltprov.o \
#11 274.0 	providers/libcrypto-shlib-nullprov.o \
#11 274.0 	providers/libcrypto-shlib-prov_running.o \
#11 274.0 	providers/libdefault.a providers/libcommon.a  -ldl -pthread 
#11 274.1 ar qc libcrypto.a providers/common/der/libcommon-lib-der_ml_dsa_key.o providers/common/der/libcommon-lib-der_rsa_gen.o providers/common/der/libcommon-lib-der_rsa_key.o providers/common/der/libcommon-lib-der_slh_dsa_gen.o providers/common/der/libcommon-lib-der_slh_dsa_key.o providers/common/der/libcommon-lib-der_wrap_gen.o providers/common/libcommon-lib-provider_ctx.o providers/common/libcommon-lib-provider_err.o providers/implementations/ciphers/libcommon-lib-ciphercommon.o providers/implementations/ciphers/libcommon-lib-ciphercommon_block.o providers/implementations/ciphers/libcommon-lib-ciphercommon_ccm.o providers/implementations/ciphers/libcommon-lib-ciphercommon_ccm_hw.o providers/implementations/ciphers/libcommon-lib-ciphercommon_gcm.o providers/implementations/ciphers/libcommon-lib-ciphercommon_gcm_hw.o providers/implementations/ciphers/libcommon-lib-ciphercommon_hw.o providers/implementations/digests/libcommon-lib-digestcommon.o ssl/record/methods/libcommon-lib-tls_pad.o
#11 274.3 gcc -fPIC -pthread -m64 -Wa,--noexecstack -Wall -O3 -Wl,-z,defs -Wl,-znodelete -shared -Wl,-Bsymbolic   \
#11 274.3 	-o providers/fips.so -Wl,--version-script=providers/fips.ld \
#11 274.3 	providers/fips/fips-dso-fips_entry.o \
#11 274.3 	providers/libfips.a -ldl -pthread 
#11 274.4 ranlib libcrypto.a || echo Never mind.
#11 274.4 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/lib/openssl-bin-cmp_mock_srv.d.tmp -c -o apps/lib/openssl-bin-cmp_mock_srv.o apps/lib/cmp_mock_srv.c
#11 274.5 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-asn1parse.d.tmp -c -o apps/openssl-bin-asn1parse.o apps/asn1parse.c
#11 274.6 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-ca.d.tmp -c -o apps/openssl-bin-ca.o apps/ca.c
#11 274.9 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-ciphers.d.tmp -c -o apps/openssl-bin-ciphers.o apps/ciphers.c
#11 275.0 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-cmp.d.tmp -c -o apps/openssl-bin-cmp.o apps/cmp.c
#11 275.1 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-cms.d.tmp -c -o apps/openssl-bin-cms.o apps/cms.c
#11 275.3 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-crl.d.tmp -c -o apps/openssl-bin-crl.o apps/crl.c
#11 275.7 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-crl2pkcs7.d.tmp -c -o apps/openssl-bin-crl2pkcs7.o apps/crl2pkcs7.c
#11 276.0 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-dgst.d.tmp -c -o apps/openssl-bin-dgst.o apps/dgst.c
#11 276.0 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-dhparam.d.tmp -c -o apps/openssl-bin-dhparam.o apps/dhparam.c
#11 276.3 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-dsa.d.tmp -c -o apps/openssl-bin-dsa.o apps/dsa.c
#11 276.6 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-dsaparam.d.tmp -c -o apps/openssl-bin-dsaparam.o apps/dsaparam.c
#11 276.7 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-ec.d.tmp -c -o apps/openssl-bin-ec.o apps/ec.c
#11 276.9 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-ecparam.d.tmp -c -o apps/openssl-bin-ecparam.o apps/ecparam.c
#11 276.9 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-enc.d.tmp -c -o apps/openssl-bin-enc.o apps/enc.c
#11 277.0 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-engine.d.tmp -c -o apps/openssl-bin-engine.o apps/engine.c
#11 277.1 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-errstr.d.tmp -c -o apps/openssl-bin-errstr.o apps/errstr.c
#11 277.3 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-fipsinstall.d.tmp -c -o apps/openssl-bin-fipsinstall.o apps/fipsinstall.c
#11 277.3 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-gendsa.d.tmp -c -o apps/openssl-bin-gendsa.o apps/gendsa.c
#11 277.5 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-genpkey.d.tmp -c -o apps/openssl-bin-genpkey.o apps/genpkey.c
#11 277.5 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-genrsa.d.tmp -c -o apps/openssl-bin-genrsa.o apps/genrsa.c
#11 277.6 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-info.d.tmp -c -o apps/openssl-bin-info.o apps/info.c
#11 277.8 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-kdf.d.tmp -c -o apps/openssl-bin-kdf.o apps/kdf.c
#11 277.8 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-list.d.tmp -c -o apps/openssl-bin-list.o apps/list.c
#11 277.9 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-mac.d.tmp -c -o apps/openssl-bin-mac.o apps/mac.c
#11 277.9 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-nseq.d.tmp -c -o apps/openssl-bin-nseq.o apps/nseq.c
#11 278.2 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-ocsp.d.tmp -c -o apps/openssl-bin-ocsp.o apps/ocsp.c
#11 278.2 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-openssl.d.tmp -c -o apps/openssl-bin-openssl.o apps/openssl.c
#11 278.2 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-passwd.d.tmp -c -o apps/openssl-bin-passwd.o apps/passwd.c
#11 278.6 gcc  -Iapps -I. -Iinclude -Iapps/include  -pthread -m64 -Wa,--noexecstack -Wall -O3 -DOPENSSL_BUILDING_OPENSSL -DNDEBUG  -MMD -MF apps/openssl-bin-pkcs12.d.tmp -c -o apps/openssl-bi
#11 278.6 [output clipped, log limit 2MiB reached]
#11 298.3 + make install_sw
#11 301.7 + make install_fips
#11 DONE 304.5s

#12 [ 7/10] RUN set -eux;   mkdir -p "/opt/fips-probe/openssl/ssl";   LD_LIBRARY_PATH="/opt/fips-probe/openssl/lib" "/opt/fips-probe/openssl/bin/openssl" fipsinstall   -module "/opt/fips-probe/openssl/lib/ossl-modules/fips.so"   -out "/opt/fips-probe/openssl/ssl/fipsmodule.cnf"   -provider_name fips;   if [ ! -f "/opt/fips-probe/openssl/lib/ossl-modules/fips.so" ]; then   echo "fips.so absent after install_fips" >&2;   ls -la "/opt/fips-probe/openssl/lib/ossl-modules" >&2 || true;   ls -la "/opt/fips-probe/openssl/lib" >&2 || true;   exit 1;   fi
#12 0.112 + mkdir -p /opt/fips-probe/openssl/ssl
#12 0.113 + LD_LIBRARY_PATH=/opt/fips-probe/openssl/lib /opt/fips-probe/openssl/bin/openssl fipsinstall -module /opt/fips-probe/openssl/lib/ossl-modules/fips.so -out /opt/fips-probe/openssl/ssl/fipsmodule.cnf -provider_name fips
#12 0.120 HMAC : (KAT_Integrity) : Pass
#12 0.120 HMAC : (Module_Integrity) : Pass
#12 0.123 SHA1 : (KAT_Digest) : Pass
#12 0.123 SHA2 : (KAT_Digest) : Pass
#12 0.123 SHA3 : (KAT_Digest) : Pass
#12 0.123 AES_GCM : (KAT_Cipher) : Pass
#12 0.123 AES_ECB_Decrypt : (KAT_Cipher) : Pass
#12 0.123 TDES : (KAT_Cipher) : Pass
#12 0.123 RSA : (KAT_Signature) : Pass
#12 0.125 ECDSA : (KAT_Signature) : Pass
#12 0.126 ECDSA : (KAT_Signature) : Pass
#12 0.127 EDDSA : (KAT_Signature) : Pass
#12 0.127 EDDSA : (KAT_Signature) : Pass
#12 0.128 DSA : (KAT_Signature) : Pass
#12 0.128 ML-DSA : (KAT_Signature) : Pass
#12 0.130 SLH-DSA : (KAT_Signature) : Pass
#12 0.146 SLH-DSA : (KAT_Signature) : Pass
#12 0.190 TLS13_KDF_EXTRACT : (KAT_KDF) : Pass
#12 0.191 TLS13_KDF_EXPAND : (KAT_KDF) : Pass
#12 0.191 TLS12_PRF : (KAT_KDF) : Pass
#12 0.191 PBKDF2 : (KAT_KDF) : Pass
#12 0.191 KBKDF : (KAT_KDF) : Pass
#12 0.191 KBKDF_KMAC : (KAT_KDF) : Pass
#12 0.191 HKDF : (KAT_KDF) : Pass
#12 0.191 SSKDF : (KAT_KDF) : Pass
#12 0.191 X963KDF : (KAT_KDF) : Pass
#12 0.191 X942KDF : (KAT_KDF) : Pass
#12 0.191 HASH : (DRBG) : Pass
#12 0.191 CTR : (DRBG) : Pass
#12 0.191 HMAC : (DRBG) : Pass
#12 0.191 DH : (KAT_KA) : Pass
#12 0.192 ECDH : (KAT_KA) : Pass
#12 0.192 ML-KEM : (KAT_AsymmetricKeyGeneration) : Pass
#12 0.192 ML-DSA : (KAT_AsymmetricKeyGeneration) : Pass
#12 0.192 SLH-DSA : (KAT_AsymmetricKeyGeneration) : Pass
#12 0.193 KEM_Encap : (KAT_KEM) : Pass
#12 0.193 KEM_Decap : (KAT_KEM) : Pass
#12 0.193 KEM_Decap_Reject : (KAT_KEM) : Pass
#12 0.193 RSA_Encrypt : (KAT_AsymmetricCipher) : Pass
#12 0.193 RSA_Decrypt : (KAT_AsymmetricCipher) : Pass
#12 0.196 RSA_Decrypt : (KAT_AsymmetricCipher) : Pass
#12 0.197 	name:     	OpenSSL FIPS Provider
#12 0.197 	version:  	3.5.7
#12 0.197 	build:    	3.5.7
#12 0.199 INSTALL PASSED
#12 0.200 + '[' '!' -f /opt/fips-probe/openssl/lib/ossl-modules/fips.so ]
#12 DONE 0.2s

#13 [ 8/10] COPY list-algorithms.sh webcrypto-probe.mjs /probe/
#13 DONE 0.0s

#14 [ 9/10] RUN chmod +x /probe/list-algorithms.sh
#14 DONE 0.1s

#15 [10/10] WORKDIR /probe
#15 DONE 0.0s

#16 exporting to image
#16 exporting layers
#16 exporting layers 4.0s done
#16 writing image sha256:482f72e1aae19867e9e67858069529dc174f145c49f63249ec4634c96ad85f39 done
#16 naming to docker.io/library/fips-probe:node-linked done
#16 DONE 4.0s

 [33m1 warning found (use docker --debug to expand):
[0m - InvalidDefaultArgInFrom: Default value for ARG ${BASE_IMAGE} results in empty or invalid base image name (line 11)
```
