import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The Elastic Beanstalk log-retention hook, driven against fixture fragments.
//
// What it stands in for: an instance whose platform-provisioned logrotate
// fragments rotate on size alone, so a slow-filling log keeps its rotated
// copies for an unbounded time. The hook rewrites the rotation directives of
// those fragments and leaves the rest of each one alone.
//
// What it cannot reach: the platform's own fragments, which exist only on the
// instance, and logrotate itself, which is not installed in the development
// container. The fixtures below are shaped like the fragments an instance was
// read to hold, not captured from one, and the hook asks the instance's own
// logrotate to parse its result before installing it.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";

const HOOK_TREES = [
  "apps/web/deploy/aws_eb/.platform/hooks/postdeploy/bound_log_retention.sh",
  "apps/web/deploy/aws_eb/.platform/confighooks/postdeploy/bound_log_retention.sh",
];
const HOOK = resolve(repoRoot, HOOK_TREES[0]);

const FRAGMENTS = [
  "logrotate.elasticbeanstalk.nginx.conf",
  "logrotate.elasticbeanstalk.web-stdout.conf",
  "logrotate.elasticbeanstalk.web-stderr.conf",
];

// A size the platform does not use, so an assertion that the hook carries the
// value over cannot pass on the hook's own default.
const FIXTURE_SIZE = "25M";

const fixture = (logPath, olddir, size = FIXTURE_SIZE) =>
  [
    `${logPath} {`,
    "    su root root",
    ...(size === null ? [] : [`    size ${size}`]),
    "    missingok",
    "    rotate 4",
    "    compress",
    "    notifempty",
    `    olddir ${olddir}`,
    "    copytruncate",
    "}",
    "",
  ].join("\n");

const read = (relative) => readFileSync(resolve(repoRoot, relative), "utf8");

const blocksByLogPath = (fragment) =>
  new Map(
    [...fragment.matchAll(/^(\S+) \{$([\s\S]*?)^\}$/gm)].map((block) => [
      block[1],
      block[2],
    ]),
  );

const hookSource = read(HOOK_TREES[0]);
const retentionDays = Number(
  /^RETENTION_DAYS=(\d+)$/m.exec(hookSource)?.[1] ?? NaN,
);

const tmpDirs = [];

const confDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "eb-logrotate-"));
  tmpDirs.push(dir);
  const conf = join(dir, "conf");
  mkdirSync(conf);
  writeFileSync(
    join(conf, FRAGMENTS[0]),
    fixture("/var/log/nginx/*", "/var/log/nginx/rotated"),
  );
  writeFileSync(
    join(conf, FRAGMENTS[1]),
    fixture("/var/log/web.stdout.log", "/var/log/rotated"),
  );
  writeFileSync(
    join(conf, FRAGMENTS[2]),
    fixture("/var/log/web.stderr.log", "/var/log/rotated"),
  );
  return conf;
};

const runHook = (conf) =>
  spawnSync(BASH, [HOOK, conf], { encoding: "utf8", cwd: repoRoot });

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

describe("the EB log-retention hook's two copies", () => {
  it("are byte-identical", () => {
    const [first, ...rest] = HOOK_TREES.map(read);
    for (const content of rest) {
      expect(content).toBe(first);
    }
  });

  it("both fail the hook loudly on a failed rewrite", () => {
    for (const content of HOOK_TREES.map(read)) {
      expect(content.split("\n").slice(0, 2)).toEqual([
        "#!/bin/bash",
        "set -euo pipefail",
      ]);
    }
  });

  it("are both executable in the git index (mode 100755)", () => {
    const output = execFileSync("git", ["ls-files", "-s", ...HOOK_TREES], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const lines = output.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(HOOK_TREES.length);
    for (const line of lines) {
      expect(line).toMatch(/^100755 /);
    }
  });
});

describe("the EB log-retention hook", () => {
  it("bounds every fragment it is responsible for by time", () => {
    const conf = confDir();
    const result = runHook(conf);
    expect(result.status).toBe(0);
    for (const name of FRAGMENTS) {
      const bounded = readFileSync(join(conf, name), "utf8");
      expect(bounded).toMatch(/^ *daily$/m);
      expect(bounded).toMatch(/^ *maxage \d+$/m);
    }
  });

  it("keeps rotated copies for a day less than the retention window", () => {
    // The live log holds a day of records before the daily rotation moves
    // them, so the oldest record of the last kept copy is the window old.
    expect(retentionDays).toBeGreaterThan(1);
    const conf = confDir();
    expect(runHook(conf).status).toBe(0);
    for (const name of FRAGMENTS) {
      const bounded = readFileSync(join(conf, name), "utf8");
      expect(bounded).toMatch(
        new RegExp(`^ *rotate ${retentionDays - 1}$`, "m"),
      );
      expect(bounded).toMatch(
        new RegExp(`^ *maxage ${retentionDays - 1}$`, "m"),
      );
    }
  });

  it("carries the platform's size trigger over as a maximum size", () => {
    // Dropping it would let one burst of traffic fill a day's copy without
    // bound; leaving it as `size` would keep rotation size-triggered only.
    const conf = confDir();
    expect(runHook(conf).status).toBe(0);
    for (const name of FRAGMENTS) {
      const bounded = readFileSync(join(conf, name), "utf8");
      expect(bounded).toMatch(new RegExp(`^ *maxsize ${FIXTURE_SIZE}$`, "m"));
      expect(bounded).not.toMatch(new RegExp(`^ *size ${FIXTURE_SIZE}$`, "m"));
    }
  });

  it("leaves the directives it does not own as the platform wrote them", () => {
    const conf = confDir();
    expect(runHook(conf).status).toBe(0);
    const bounded = readFileSync(join(conf, FRAGMENTS[0]), "utf8");
    expect(bounded.split("\n")).toEqual(
      expect.arrayContaining([
        "/var/log/nginx/* {",
        "    su root root",
        "    missingok",
        "    compress",
        "    notifempty",
        "    olddir /var/log/nginx/rotated",
        "    copytruncate",
        "}",
      ]),
    );
  });

  it("leaves an already-bounded fragment untouched", () => {
    // It runs on every deployment, and a rewrite that never settles would
    // rewrite the platform's file each time.
    const conf = confDir();
    expect(runHook(conf).status).toBe(0);
    const first = FRAGMENTS.map((name) =>
      readFileSync(join(conf, name), "utf8"),
    );
    expect(runHook(conf).status).toBe(0);
    const second = FRAGMENTS.map((name) =>
      readFileSync(join(conf, name), "utf8"),
    );
    expect(second).toEqual(first);
  });

  it("fails the deployment when a fragment it bounds is not there", () => {
    // A platform that renames or drops a fragment leaves that log rotating
    // on size alone, which is the state this hook exists to end.
    const conf = confDir();
    rmSync(join(conf, FRAGMENTS[1]));
    const result = runHook(conf);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(FRAGMENTS[1]);
    expect(result.stderr).toContain(conf);
  });

  it("bounds each block of a fragment that rotates several logs by its own size", () => {
    // Each block of a fragment keeps the size trigger the platform gave that
    // block, and a block the platform wrote without one is given none.
    const conf = confDir();
    writeFileSync(
      join(conf, FRAGMENTS[0]),
      [
        fixture("/var/log/nginx/access.log", "/var/log/nginx/rotated", "10M"),
        fixture("/var/log/nginx/error.log", "/var/log/nginx/rotated", "500M"),
        fixture("/var/log/nginx/other.log", "/var/log/nginx/rotated", null),
      ].join("\n"),
    );
    expect(runHook(conf).status).toBe(0);
    const bounded = blocksByLogPath(
      readFileSync(join(conf, FRAGMENTS[0]), "utf8"),
    );
    expect([...bounded.keys()]).toEqual([
      "/var/log/nginx/access.log",
      "/var/log/nginx/error.log",
      "/var/log/nginx/other.log",
    ]);
    expect(bounded.get("/var/log/nginx/access.log")).toMatch(
      /^ *maxsize 10M$/m,
    );
    expect(bounded.get("/var/log/nginx/error.log")).toMatch(
      /^ *maxsize 500M$/m,
    );
    expect(bounded.get("/var/log/nginx/other.log")).not.toMatch(/^ *maxsize /m);
    for (const block of bounded.values()) {
      expect(block).toMatch(/^ *daily$/m);
      expect(block).toMatch(/^ *maxage \d+$/m);
    }
  });
});
