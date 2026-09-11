import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  basePin,
  classifyDifferences,
  compareRows,
  dockerQueryArgv,
  generateList,
  IMAGES,
  imageConfig,
  normalizeRows,
  parseApkListInstalled,
  parseRpmQueryOutput,
  readListBasePin,
  readListRows,
  renderList,
  repositoryRoot,
} from "./generate-os-package-attribution.mjs";

// Every fixture below is copied out of the captures the two built images were
// queried for, whole records only: what is under test is the exact shape each
// package manager emits, so a reflowed or column-aligned excerpt would test a
// format neither tool produces.
//
// One exception is marked where it appears. No package on either image records
// an empty license -- checked on the apk side against the listing, the
// installed database and `apk info --license` for all 63 packages, and on the
// rpm side by splitting every row -- so the apk half of the missing-license
// fixture is constructed rather than captured. The rpm half is not: rpm renders
// an absent header tag as the literal "(none)", which the capture shows in the
// architecture column of the signing key's pseudo-package.

const APK_EXCERPT = [
  "acl-libs-2.3.2-r1 x86_64 {acl} (LGPL-2.1-or-later AND GPL-2.0-or-later) [installed]",
  "alpine-baselayout-data-3.7.2-r1 x86_64 {alpine-baselayout} (GPL-2.0-only) [installed]",
  "busybox-binsh-1.37.0-r31 x86_64 {busybox} (GPL-2.0-only) [installed]",
  "gmp-6.3.0-r4 x86_64 {gmp} (LGPL-3.0-or-later OR GPL-2.0-or-later) [installed]",
  "libarchive-3.8.7-r0 x86_64 {libarchive} (BSD-2-Clause AND BSD-3-Clause AND Public-Domain) [installed]",
].join("\n");

const RPM_EXCERPT = [
  "python3-setuptools-wheel\t0\t59.6.0\t2.amzn2023.0.6\tnoarch\tMIT and (BSD or ASL 2.0)",
  "bash\t0\t5.2.15\t1.amzn2023.0.2\tx86_64\tGPLv3+",
  "gpg-pubkey\t0\td832c631\t6515c85e\t(none)\tpubkey",
  "tar\t2\t1.34\t1.amzn2023.0.4\tx86_64\tGPLv3+",
  "libstdc++\t0\t14.2.1\t7.amzn2023.0.2\tx86_64\tGPL-3.0-or-later AND LGPL-3.0-or-later AND (GPL-3.0-or-later WITH GCC-exception-3.1) AND (GPL-3.0-or-later WITH Texinfo-exception) AND (LGPL-2.1-or-later WITH GCC-exception-2.0) AND (GPL-2.0-or-later WITH GCC-exception-2.0) AND (GPL-2.0-or-later WITH GNU-compiler-exception) AND BSL-1.0 AND GFDL-1.3-or-later AND Linux-man-pages-copyleft-2-para AND SunPro AND BSD-1-Clause AND BSD-2-Clause AND BSD-2-Clause-Views AND BSD-3-Clause AND BSD-4-Clause AND BSD-Source-Code AND Zlib AND MIT AND Apache-2.0 AND (Apache-2.0 WITH LLVM-Exception) AND ZPL-2.1 AND ISC AND LicenseRef-Fedora-Public-Domain AND HP-1986 AND curl AND Martin-Birgmeier AND HPND-Markus-Kuhn AND dtoa AND SMLNJ AND AMD-newlib AND OAR AND HPND-merchantability-variant AND HPND-Intel",
].join("\n");

const root = repositoryRoot();

describe("parsing apk's installed listing", () => {
  const rows = parseApkListInstalled(APK_EXCERPT);

  it("reads one row per installed package", () => {
    expect(rows).toHaveLength(5);
  });

  it("splits a hyphenated package name from its version and release", () => {
    expect(rows[1]).toEqual({
      name: "alpine-baselayout-data",
      version: "3.7.2-r1",
      license: "GPL-2.0-only",
    });
    expect(rows[2].name).toBe("busybox-binsh");
  });

  it("keeps a license expression whole, its operators included", () => {
    expect(rows[0].license).toBe("LGPL-2.1-or-later AND GPL-2.0-or-later");
    expect(rows[3].license).toBe("LGPL-3.0-or-later OR GPL-2.0-or-later");
    expect(rows[4].license).toBe(
      "BSD-2-Clause AND BSD-3-Clause AND Public-Domain",
    );
  });

  it("refuses a line that is not a package listing", () => {
    expect(() =>
      parseApkListInstalled(
        "WARNING: opening from cache https://dl-cdn.alpinelinux.org/alpine/v3.24/main: No such file or directory",
      ),
    ).toThrow(/not a package listing/);
  });
});

describe("parsing rpm's query output", () => {
  const rows = parseRpmQueryOutput(RPM_EXCERPT);

  it("reads one row per installed package", () => {
    expect(rows).toHaveLength(5);
  });

  it("writes the epoch into the version, the substituted zero included", () => {
    expect(rows[1]).toEqual({
      name: "bash",
      version: "0:5.2.15-1.amzn2023.0.2",
      license: "GPLv3+",
    });
    expect(rows[3].version).toBe("2:1.34-1.amzn2023.0.4");
  });

  it("reads the signing key's pseudo-package like any other row", () => {
    expect(rows[2]).toEqual({
      name: "gpg-pubkey",
      version: "0:d832c631-6515c85e",
      license: "pubkey",
    });
  });

  it("keeps a license expression whole, parentheses and WITH included", () => {
    expect(rows[0].license).toBe("MIT and (BSD or ASL 2.0)");
    expect(rows[4].license).toHaveLength(744);
    expect(rows[4].license).toContain(
      "(GPL-3.0-or-later WITH GCC-exception-3.1)",
    );
  });

  it("refuses a row the format string did not fill", () => {
    // rpm prints its complaint on stderr and exits 0 when a format string names
    // a tag it does not know, so a short row is the only thing left to catch.
    expect(() => parseRpmQueryOutput("bash\t0\t5.2.15\n")).toThrow(
      /3 tab-separated fields where the query emits 6/,
    );
  });
});

describe("normalization", () => {
  it("orders rows by package name, whatever order the query reported", () => {
    const forward = normalizeRows(parseRpmQueryOutput(RPM_EXCERPT));
    const reversed = normalizeRows(
      parseRpmQueryOutput(RPM_EXCERPT.split("\n").reverse().join("\n")),
    );
    expect(forward.map((row) => row.name)).toEqual([
      "bash",
      "gpg-pubkey",
      "libstdc++",
      "python3-setuptools-wheel",
      "tar",
    ]);
    expect(reversed).toEqual(forward);
  });

  it("renders the same bytes on a re-run over the same input", () => {
    const once = generateList("default", APK_EXCERPT, root);
    const twice = generateList("default", APK_EXCERPT, root);
    expect(twice).toBe(once);
    expect(once.endsWith("\n")).toBe(true);
  });

  it("renders the same bytes whatever order the query reported", () => {
    expect(
      generateList("fips", RPM_EXCERPT.split("\n").reverse().join("\n"), root),
    ).toBe(generateList("fips", RPM_EXCERPT, root));
  });

  it("refuses a field holding a tab or a newline", () => {
    expect(() =>
      normalizeRows([
        { name: "bash", version: "0:5.2.15-1", license: "GPLv3+\tMIT" },
      ]),
    ).toThrow(/tab or a newline in its license field/);
  });

  it("refuses two rows for one package name", () => {
    expect(() =>
      normalizeRows([
        { name: "glibc", version: "0:2.34-1", license: "LGPLv2+" },
        { name: "glibc", version: "0:2.34-2", license: "LGPLv2+" },
      ]),
    ).toThrow(/glibc is installed more than once/);
  });
});

describe("a package that records no license", () => {
  it("fails naming the package when rpm reports an absent tag", () => {
    expect(() =>
      normalizeRows(
        parseRpmQueryOutput(
          "libargon2\t0\t20190702\t1.amzn2023.0.2\tx86_64\t(none)",
        ),
      ),
    ).toThrow(/libargon2 0:20190702-1\.amzn2023\.0\.2 records no license/);
  });

  it("fails naming the package when the license field is empty", () => {
    expect(() =>
      normalizeRows(
        parseRpmQueryOutput("bash\t0\t5.2.15\t1.amzn2023.0.2\tx86_64\t"),
      ),
    ).toThrow(/bash 0:5\.2\.15-1\.amzn2023\.0\.2 records no license/);
  });

  it("fails naming the package when apk reports empty parentheses", () => {
    // Constructed: no package on either built image records an empty license,
    // and apk was observed emitting no shape for the empty case at all.
    expect(() =>
      normalizeRows(
        parseApkListInstalled("musl-1.2.5-r10 x86_64 {musl} () [installed]"),
      ),
    ).toThrow(/musl 1\.2\.5-r10 records no license/);
  });
});

describe("drift against the committed list", () => {
  const committed = [
    { name: "busybox", version: "1.37.0-r31", license: "GPL-2.0-only" },
    { name: "gdbm", version: "1.26-r0", license: "GPL-3.0-or-later" },
    {
      name: "gmp",
      version: "6.3.0-r4",
      license: "LGPL-3.0-or-later OR GPL-2.0-or-later",
    },
  ];
  const classify = (measured) =>
    classifyDifferences(compareRows(committed, measured));

  it("fails naming a package the image added", () => {
    const measured = [
      ...committed,
      {
        name: "samba-client",
        version: "4.23.8-r0",
        license: "GPL-3.0-or-later",
      },
    ];
    expect(classify(measured)).toEqual({
      failing: ["added: samba-client 4.23.8-r0 (GPL-3.0-or-later)"],
      informational: [],
    });
  });

  it("fails naming a package the image no longer holds", () => {
    expect(classify(committed.filter((row) => row.name !== "gdbm"))).toEqual({
      failing: ["removed: gdbm 1.26-r0 (GPL-3.0-or-later)"],
      informational: [],
    });
  });

  it("fails naming a package whose license moved", () => {
    const measured = committed.map((row) =>
      row.name === "gmp" ? { ...row, license: "LGPL-3.0-or-later" } : row,
    );
    expect(classify(measured)).toEqual({
      failing: [
        "changed: gmp license LGPL-3.0-or-later OR GPL-2.0-or-later -> LGPL-3.0-or-later",
      ],
      informational: [],
    });
  });

  it("only reports a package whose version moved", () => {
    const measured = committed.map((row) =>
      row.name === "busybox" ? { ...row, version: "1.37.0-r32" } : row,
    );
    expect(classify(measured)).toEqual({
      failing: [],
      informational: ["changed: busybox version 1.37.0-r31 -> 1.37.0-r32"],
    });
  });

  it("names both classes when a version moved beside a failing difference", () => {
    const measured = [
      { name: "busybox", version: "1.37.0-r32", license: "GPL-2.0-only" },
      { name: "gmp", version: "6.3.0-r5", license: "LGPL-3.0-or-later" },
    ];
    expect(classify(measured)).toEqual({
      failing: [
        "removed: gdbm 1.26-r0 (GPL-3.0-or-later)",
        "changed: gmp license LGPL-3.0-or-later OR GPL-2.0-or-later -> LGPL-3.0-or-later",
      ],
      informational: [
        "changed: busybox version 1.37.0-r31 -> 1.37.0-r32",
        "changed: gmp version 6.3.0-r4 -> 6.3.0-r5",
      ],
    });
  });

  it("reports nothing when the image holds what the list states", () => {
    expect(classify(committed)).toEqual({ failing: [], informational: [] });
  });
});

describe("--check against the committed default list", () => {
  // The listing is rendered back from the committed list rather than captured,
  // so these cases move with the list instead of pinning the versions it holds.
  const listRows = readListRows(
    readFileSync(resolve(root, IMAGES.default.listFile), "utf8"),
  );
  const apkListing = (rows) =>
    rows
      .map(
        (row) =>
          `${row.name}-${row.version} x86_64 {${row.name}} (${row.license}) [installed]`,
      )
      .join("\n");
  const check = (rows) =>
    spawnSync(
      process.execPath,
      [
        resolve(root, "scripts/generate-os-package-attribution.mjs"),
        "default",
        "--query-output",
        "-",
        "--check",
      ],
      { input: apkListing(rows), encoding: "utf8" },
    );

  it("passes when the image holds what the list states", () => {
    const result = check(listRows);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "the image holds each at the version and license the list states",
    );
  });

  it("passes reporting the package whose version moved", () => {
    const [first, ...rest] = listRows;
    const result = check([{ ...first, version: "9.9.9-r9" }, ...rest]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      `${IMAGES.default.listFile} states a stale version for 1 package`,
    );
    expect(result.stdout).toContain(
      `changed: ${first.name} version ${first.version} -> 9.9.9-r9`,
    );
    expect(result.stdout).toContain(
      "node scripts/generate-os-package-attribution.mjs default",
    );
  });

  it("fails on a license that moved and on a package that went missing", () => {
    const [first, ...rest] = listRows;
    const licensed = check([{ ...first, license: "WTFPL" }, ...rest]);
    expect(licensed.status).toBe(1);
    expect(licensed.stderr).toContain(
      `changed: ${first.name} license ${first.license} -> WTFPL`,
    );
    const dropped = check(rest);
    expect(dropped.status).toBe(1);
    expect(dropped.stderr).toContain(
      `removed: ${first.name} ${first.version} (${first.license})`,
    );
  });
});

describe("querying a built image", () => {
  it("runs each image's own query against the tag it is given", () => {
    expect(dockerQueryArgv("default", "psi-link:smoke")).toEqual([
      "run",
      "--rm",
      "--entrypoint",
      "sh",
      "psi-link:smoke",
      "-c",
      "apk list --installed",
    ]);
    const fips = dockerQueryArgv("fips", "psi-link:fips-smoke");
    expect(fips.slice(0, 5)).toEqual([
      "run",
      "--rm",
      "--entrypoint",
      "sh",
      "psi-link:fips-smoke",
    ]);
    expect(fips[6]).toContain("rpm -qa --qf");
    expect(fips[6]).toContain("%{LICENSE}");
  });

  it("refuses an image it has no query for, and a missing tag", () => {
    expect(() => dockerQueryArgv("alpine", "psi-link:smoke")).toThrow(
      /no image is named alpine/,
    );
    expect(() => dockerQueryArgv("default", "")).toThrow(/no image tag/);
  });
});

describe("the committed lists", () => {
  for (const [variant, image] of Object.entries(IMAGES)) {
    const text = readFileSync(resolve(root, image.listFile), "utf8");

    it(`${image.listFile} states the base pin ${image.dockerfile} names`, () => {
      expect(readListBasePin(text)).toBe(
        basePin(
          readFileSync(resolve(root, image.dockerfile), "utf8"),
          image.dockerfile,
        ),
      );
    });

    it(`${image.listFile} is exactly what the generator renders`, () => {
      expect(
        renderList(
          variant,
          normalizeRows(readListRows(text)),
          readListBasePin(text),
        ),
      ).toBe(text);
    });

    it(`${image.listFile} states which architectures were compared`, () => {
      const header = text
        .split("\n")
        .filter((line) => line.startsWith("#"))
        .join("\n");
      expect(header).toContain(imageConfig(variant).query);
      expect(header).toContain("linux/amd64 and linux/arm64");
      expect(header).toContain("compares linux/amd64 only");
    });
  }
});
