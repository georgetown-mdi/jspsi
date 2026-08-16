import { describe, expect, it } from "vitest";

import {
  argvOnLine,
  deriveCliCapabilities,
  deriveHelperInvocations,
  deriveImageDependencies,
  deriveVerdictVersion,
  dispatchedWords,
  logicalLines,
  repositoryRoot,
} from "./derive-image-dependencies.mjs";

// The derivation the image gate rests on, driven against synthetic scripts for
// the shapes it must and must not read, and against the shipped ones for the set
// the gate is required to cover.
//
// What it cannot reach: the image. Nothing here runs a container; whether the
// image answers what is derived is scripts/assert-image-capabilities.mjs's
// question, and only CI can put it.

const COMMANDS = ["serve", "doctor", "exchange", "invite"];

describe("what the shipped scripts are read to ask of the image", () => {
  const derived = deriveImageDependencies(repositoryRoot());
  const vectors = derived.cli.map((entry) => entry.argv.join(" "));

  it("derives both doctor batteries the setup and launcher scripts run", () => {
    expect(vectors).toContain("doctor probe");
    expect(vectors).toContain("doctor mount /rz");
  });

  it("derives the console role, which the entrypoint routes before the CLI", () => {
    expect(vectors).toContain("serve");
  });

  it("names the call sites each vector was read from", () => {
    const probe = derived.cli.find(
      (entry) => entry.argv.join(" ") === "doctor probe",
    );
    expect(probe.sites.length).toBeGreaterThan(1);
    for (const site of probe.sites) expect(site).toMatch(/^[\w.-]+:\d+$/);
  });

  it("derives all three helper scripts the .cmd path pipes into the image", () => {
    expect(derived.helpers.map((entry) => entry.script)).toEqual([
      "cmd_psilink-credcheck.sh",
      "cmd_psilink-probe.sh",
      "cmd_psilink-volcheck.sh",
    ]);
  });

  it("derives the environment and the mount each helper call site gives it", () => {
    const volcheck = derived.helpers.find(
      (entry) => entry.script === "cmd_psilink-volcheck.sh",
    );
    expect(volcheck.env).toEqual(["MARKER", "TOKEN"]);
    expect(volcheck.mounts).toEqual(["/rz"]);
  });

  it("derives one verdict version both launchers agree on", () => {
    expect(derived.verdictVersion).toBe(1);
  });
});

describe("the argument-vector reader", () => {
  it("reads a PowerShell vector out of an array literal", () => {
    expect(
      argvOnLine(
        "@('run', '--rm', '--env', 'SMB_TOKEN', 'vdorie/psi-link:latest', 'doctor', 'mount', '/rz')",
        COMMANDS,
      ),
    ).toEqual([["doctor", "mount", "/rz"]]);
  });

  it("reads a shell vector following the image the launcher resolves", () => {
    expect(
      argvOnLine(
        '"$PSILINK_ENGINE" run --rm "$(psilink_image)" doctor mount /rz --json',
        COMMANDS,
      ),
    ).toEqual([["doctor", "mount", "/rz", "--json"]]);
  });

  it("reads a vector handed to an argument-vector parameter", () => {
    expect(
      argvOnLine(
        "Invoke-DoctorLoop -BatteryArgs @('doctor', 'probe')",
        COMMANDS,
      ),
    ).toEqual([["doctor", "probe"]]);
  });

  it("reads a new command at a new call site rather than the ones it knew", () => {
    expect(
      argvOnLine("@('run', '--rm', $Image, 'doctor', 'network')", COMMANDS),
    ).toEqual([["doctor", "network"]]);
    expect(argvOnLine("@('run', $Image, 'invite')", COMMANDS)).toEqual([
      ["invite"],
    ]);
  });

  it("reads nothing from a line that never names the image or a vector", () => {
    expect(
      argvOnLine("psilink doctor probe is what it runs", COMMANDS),
    ).toEqual([]);
  });

  it("reads nothing when the tokens after the image name no command", () => {
    expect(
      argvOnLine(
        "docker run --rm vdorie/psi-link:latest file:///sync input.csv out.csv",
        COMMANDS,
      ),
    ).toEqual([]);
  });

  it("stops a vector at a token that is not argument-shaped", () => {
    expect(
      argvOnLine("@($Image, 'doctor', 'probe') then it reports", COMMANDS),
    ).toEqual([["doctor", "probe"]]);
  });
});

describe("folding a script into logical lines", () => {
  it("drops a PowerShell comment that names a command in prose", () => {
    const source = [
      "# runs vdorie/psi-link:latest doctor probe against the share",
      "<# vdorie/psi-link:latest doctor probe again #>",
      "$x = 1",
    ].join("\n");
    expect(deriveCliCapabilities({ "a.ps1": source }, COMMANDS)).toEqual([]);
  });

  it("folds an array literal spanning physical lines into one vector", () => {
    const source = [
      "$probe = Invoke-Docker -DockerArgs @(",
      "    'run', '--rm',",
      "    'vdorie/psi-link:latest',",
      "    'doctor', 'probe')",
    ].join("\n");
    expect(deriveCliCapabilities({ "a.ps1": source }, COMMANDS)).toEqual([
      { argv: ["doctor", "probe"], sites: ["a.ps1:1"] },
    ]);
  });

  it("keeps a hash inside a string from truncating the line", () => {
    const source = "$x = \"a # b\"; @($Image, 'serve')";
    expect(deriveCliCapabilities({ "a.ps1": source }, COMMANDS)).toEqual([
      { argv: ["serve"], sites: ["a.ps1:1"] },
    ]);
  });

  it("keeps a hash inside a parameter expansion from truncating the line", () => {
    const source = 'hex=${DIGEST#sha256:}; run "$(psilink_image)" doctor probe';
    expect(deriveCliCapabilities({ "a.sh": source }, COMMANDS)).toEqual([
      { argv: ["doctor", "probe"], sites: ["a.sh:1"] },
    ]);
  });

  it("folds a shell line continued with a backslash", () => {
    const source = ['run --rm "$(psilink_image)" \\', "  doctor probe"].join(
      "\n",
    );
    expect(deriveCliCapabilities({ "a.sh": source }, COMMANDS)).toEqual([
      { argv: ["doctor", "probe"], sites: ["a.sh:1"] },
    ]);
  });

  it("drops a batch rem line", () => {
    const source = "rem vdorie/psi-link:latest serve is what to run\n";
    expect(deriveCliCapabilities({ "a.cmd": source }, COMMANDS)).toEqual([]);
  });

  it("reports the physical line a folded logical line starts at", () => {
    expect(logicalLines("a\nb\n", "shell")).toEqual([
      { line: 1, text: "a" },
      { line: 2, text: "b" },
    ]);
  });
});

describe("the helper-script reader", () => {
  const cmd = [
    'docker run --rm -i --env SMB_PASS --entrypoint sh "vdorie/psi-link:latest" -c "tr -d \'\\r\' | sh" <"%SCRIPT_DIR%cmd_psilink-credcheck.sh" >"%WORK%" 2>nul',
    'docker run --rm -i -v "%VOLUME_NAME%:/rz" --env MARKER --env TOKEN --entrypoint sh "vdorie/psi-link:latest" -c "tr -d \'\\r\' | sh" <"%SCRIPT_DIR%cmd_psilink-volcheck.sh"',
  ].join("\n");

  it("reads the script, its environment and its mount from the call site", () => {
    expect(deriveHelperInvocations(cmd)).toEqual([
      {
        script: "cmd_psilink-credcheck.sh",
        env: ["SMB_PASS"],
        mounts: [],
        sites: ["cmd_Setup-PsilinkFileDrop.cmd:1"],
      },
      {
        script: "cmd_psilink-volcheck.sh",
        env: ["MARKER", "TOKEN"],
        mounts: ["/rz"],
        sites: ["cmd_Setup-PsilinkFileDrop.cmd:2"],
      },
    ]);
  });

  it("reads a helper script added at a new call site", () => {
    const grown = `${cmd}\ndocker run --rm -i --env SMB_TOKEN --entrypoint sh "img" -c "tr -d '\\r' | sh" <"%SCRIPT_DIR%cmd_psilink-newcheck.sh"`;
    expect(
      deriveHelperInvocations(grown).map((entry) => entry.script),
    ).toContain("cmd_psilink-newcheck.sh");
  });

  it("reads nothing from a run that leaves the entrypoint alone", () => {
    expect(
      deriveHelperInvocations(
        'docker run --rm "vdorie/psi-link:latest" doctor probe',
      ),
    ).toEqual([]);
  });
});

describe("the tripwires that keep an empty derivation from passing", () => {
  it("refuses a support script set nothing matches", () => {
    expect(() => deriveCliCapabilities({ "a.txt": "" }, COMMANDS)).toThrow(
      /no reader is defined/,
    );
  });

  it("refuses launchers that read different verdict versions", () => {
    expect(() =>
      deriveVerdictVersion({
        "Start-Psilink.ps1": "$PsilinkVerdictVersion = 2",
        "start-psilink.sh": "PSILINK_VERDICT_VERSION='1'",
      }),
    ).toThrow(/disagree/);
  });

  it("refuses a launcher whose version declaration it cannot find", () => {
    expect(() =>
      deriveVerdictVersion({
        "Start-Psilink.ps1": "",
        "start-psilink.sh": "PSILINK_VERDICT_VERSION='1'",
      }),
    ).toThrow(/extraction pattern rotted/);
  });
});

describe("the entrypoint's own dispatch", () => {
  it("reads the word the entrypoint routes before the CLI sees it", () => {
    expect(dispatchedWords('if [ "$1" = "serve" ]; then\n')).toEqual(["serve"]);
  });

  it("reads a word added to the dispatch", () => {
    expect(
      dispatchedWords(
        'if [ "$1" = "serve" ]; then\nif [ "$1" = "worker" ]; then\n',
      ),
    ).toEqual(["serve", "worker"]);
  });
});
