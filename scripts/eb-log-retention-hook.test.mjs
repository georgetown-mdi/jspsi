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

import { describeHookTreeParity } from "./lib/hookTreeParity.mjs";

// The Elastic Beanstalk log-retention hook, driven against fixture fragments.
//
// What it stands in for: an instance whose platform-provisioned logrotate
// fragments rotate on size alone, so a slow-filling log keeps its rotated
// copies for an unbounded time. The hook rewrites the rotation directives of
// those fragments and leaves the rest of each one alone.
//
// What it cannot reach: the platform's own fragments, which exist only on the
// instance. The fixtures below are shaped like the fragments an instance was
// read to hold, not captured from one. Every path a fixture names -- the logs
// it rotates, its `olddir`, the user its `su` names -- resolves under the
// test's own temporary tree or to the user running the test, so the hook's
// logrotate check reads a config logrotate can act on wherever logrotate is
// installed; where it is not, the hook reports that it installed the rewrite
// unchecked.

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

// The platform's fragments name root; the fixtures name the user the test
// runs as, which is the user the hook's logrotate check runs as here.
const id = (flag) => execFileSync("id", [flag], { encoding: "utf8" }).trim();
const SU = `${id("-un")} ${id("-gn")}`;

const fixture = (logPath, olddir, size = FIXTURE_SIZE) =>
  [
    `${logPath} {`,
    `    su ${SU}`,
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
const rotatedDays = retentionDays - 1;

const tmpDirs = [];

// A fixture instance: the fragment directory the hook is pointed at, the logs
// those fragments rotate, and the directory the rotated copies go to.
const fixtureTree = () => {
  const root = mkdtempSync(join(tmpdir(), "eb-logrotate-"));
  tmpDirs.push(root);
  const conf = join(root, "conf");
  const logs = join(root, "log");
  const olddir = join(logs, "rotated");
  const nginxDir = join(logs, "nginx");
  for (const dir of [conf, logs, olddir, nginxDir]) {
    mkdirSync(dir);
  }
  const log = (relative) => {
    const path = join(logs, relative);
    writeFileSync(path, "a line the service wrote\n");
    return path;
  };
  const tree = { conf, olddir, log, nginxGlob: join(nginxDir, "*") };
  log("nginx/access.log");
  writeFileSync(join(conf, FRAGMENTS[0]), fixture(tree.nginxGlob, olddir));
  writeFileSync(
    join(conf, FRAGMENTS[1]),
    fixture(log("web.stdout.log"), olddir),
  );
  writeFileSync(
    join(conf, FRAGMENTS[2]),
    fixture(log("web.stderr.log"), olddir),
  );
  return tree;
};

const runHook = (conf) =>
  spawnSync(BASH, [HOOK, conf], { encoding: "utf8", cwd: repoRoot });

// The hook reports what it refused on stderr, and its logrotate check relays
// logrotate's own complaint there, so a failed run says why it failed.
const runHookExpectingSuccess = (conf) => {
  const result = runHook(conf);
  expect(result.status, `the hook failed with:\n${result.stderr}`).toBe(0);
  return result;
};

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

describeHookTreeParity("the EB log-retention hook's two copies", HOOK_TREES);

describe("the EB log-retention hook", () => {
  it("bounds every fragment it is responsible for by time", () => {
    const { conf } = fixtureTree();
    runHookExpectingSuccess(conf);
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
    const { conf } = fixtureTree();
    runHookExpectingSuccess(conf);
    for (const name of FRAGMENTS) {
      const bounded = readFileSync(join(conf, name), "utf8");
      expect(bounded).toMatch(new RegExp(`^ *rotate ${rotatedDays}$`, "m"));
      expect(bounded).toMatch(new RegExp(`^ *maxage ${rotatedDays}$`, "m"));
    }
  });

  it("carries the platform's size trigger over as a maximum size", () => {
    // Dropping it would let one burst of traffic fill a day's copy without
    // bound; leaving it as `size` would keep rotation size-triggered only.
    const { conf } = fixtureTree();
    runHookExpectingSuccess(conf);
    for (const name of FRAGMENTS) {
      const bounded = readFileSync(join(conf, name), "utf8");
      expect(bounded).toMatch(new RegExp(`^ *maxsize ${FIXTURE_SIZE}$`, "m"));
      expect(bounded).not.toMatch(new RegExp(`^ *size ${FIXTURE_SIZE}$`, "m"));
    }
  });

  it("leaves the directives it does not own as the platform wrote them", () => {
    const { conf, olddir, nginxGlob } = fixtureTree();
    runHookExpectingSuccess(conf);
    const bounded = readFileSync(join(conf, FRAGMENTS[0]), "utf8");
    expect(bounded.split("\n")).toEqual(
      expect.arrayContaining([
        `${nginxGlob} {`,
        `    su ${SU}`,
        "    missingok",
        "    compress",
        "    notifempty",
        `    olddir ${olddir}`,
        "    copytruncate",
        "}",
      ]),
    );
  });

  it("leaves a minsize floor where the platform wrote it", () => {
    // minsize holds a floor under rotation rather than triggering it, so the
    // hook's daily trigger replaces neither it nor its position in the block.
    const { conf, log } = fixtureTree();
    const access = log("nginx/access.log");
    writeFileSync(
      join(conf, FRAGMENTS[0]),
      [
        `${access} {`,
        "    minsize 1M",
        "    size 10M",
        "    copytruncate",
        "}",
        "",
      ].join("\n"),
    );
    runHookExpectingSuccess(conf);
    expect(readFileSync(join(conf, FRAGMENTS[0]), "utf8").split("\n")).toEqual([
      `${access} {`,
      "    minsize 1M",
      "    copytruncate",
      "    daily",
      "    maxsize 10M",
      `    rotate ${rotatedDays}`,
      `    maxage ${rotatedDays}`,
      "}",
      "",
    ]);
  });

  it("bounds a block whose braces hold trailing spaces or a comment", () => {
    // A closing brace the rewrite does not recognize strips the block's
    // rotation directives and puts none back.
    const { conf, log } = fixtureTree();
    const access = log("nginx/access.log");
    const error = log("nginx/error.log");
    writeFileSync(
      join(conf, FRAGMENTS[0]),
      [
        `${access} {`,
        "    size 10M # bursts",
        "    copytruncate",
        "} # the platform's own note",
        `${error} {`,
        "    size 20M",
        "    copytruncate",
        "}   ",
        "",
      ].join("\n"),
    );
    runHookExpectingSuccess(conf);
    expect(readFileSync(join(conf, FRAGMENTS[0]), "utf8").split("\n")).toEqual([
      `${access} {`,
      "    copytruncate",
      "    daily",
      "    maxsize 10M",
      `    rotate ${rotatedDays}`,
      `    maxage ${rotatedDays}`,
      "} # the platform's own note",
      `${error} {`,
      "    copytruncate",
      "    daily",
      "    maxsize 20M",
      `    rotate ${rotatedDays}`,
      `    maxage ${rotatedDays}`,
      "}   ",
      "",
    ]);
  });

  it("leaves an already-bounded fragment untouched", () => {
    // It runs on every deployment, and a rewrite that never settles would
    // rewrite the platform's file each time.
    const { conf } = fixtureTree();
    runHookExpectingSuccess(conf);
    const first = FRAGMENTS.map((name) =>
      readFileSync(join(conf, name), "utf8"),
    );
    runHookExpectingSuccess(conf);
    const second = FRAGMENTS.map((name) =>
      readFileSync(join(conf, name), "utf8"),
    );
    expect(second).toEqual(first);
  });

  it("fails the deployment when a fragment it bounds is not there", () => {
    // A platform that renames or drops a fragment leaves that log rotating
    // on size alone, which is the state this hook exists to end.
    const { conf } = fixtureTree();
    rmSync(join(conf, FRAGMENTS[1]));
    const result = runHook(conf);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(FRAGMENTS[1]);
    expect(result.stderr).toContain(conf);
  });

  it("fails the deployment rather than install a block without the bound", () => {
    // Whatever shape defeats the rewrite -- here a block the fragment never
    // closes -- the result is not installed and the deployment stops.
    const { conf, log } = fixtureTree();
    const stdoutLog = log("web.stdout.log");
    const unclosed = [
      `${stdoutLog} {`,
      "    size 25M",
      "    copytruncate",
      "",
    ].join("\n");
    writeFileSync(join(conf, FRAGMENTS[1]), unclosed);
    const result = runHook(conf);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(FRAGMENTS[1]);
    expect(result.stderr).toContain(`${stdoutLog} {`);
    expect(readFileSync(join(conf, FRAGMENTS[1]), "utf8")).toBe(unclosed);
  });

  it("bounds each block of a fragment that rotates several logs by its own size", () => {
    // Each block of a fragment keeps the size trigger the platform gave that
    // block, and a block the platform wrote without one is given none.
    const { conf, olddir, log } = fixtureTree();
    const access = log("nginx/access.log");
    const error = log("nginx/error.log");
    const other = log("nginx/other.log");
    writeFileSync(
      join(conf, FRAGMENTS[0]),
      [
        fixture(access, olddir, "10M"),
        fixture(error, olddir, "500M"),
        fixture(other, olddir, null),
      ].join("\n"),
    );
    runHookExpectingSuccess(conf);
    const bounded = blocksByLogPath(
      readFileSync(join(conf, FRAGMENTS[0]), "utf8"),
    );
    expect([...bounded.keys()]).toEqual([access, error, other]);
    expect(bounded.get(access)).toMatch(/^ *maxsize 10M$/m);
    expect(bounded.get(error)).toMatch(/^ *maxsize 500M$/m);
    expect(bounded.get(other)).not.toMatch(/^ *maxsize /m);
    for (const block of bounded.values()) {
      expect(block).toMatch(/^ *daily$/m);
      expect(block).toMatch(/^ *maxage \d+$/m);
    }
  });
});
