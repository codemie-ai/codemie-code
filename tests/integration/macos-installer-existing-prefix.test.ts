/**
 * macOS installer (install/macos/install.sh) in auto mode, with codemie already installed in a writable
 * non-default npm prefix and a global npm prefix that is not writable.
 *
 * The installer must update the copy the shell already runs (install with --prefix <existing prefix>) instead of
 * creating a second copy in ~/.codemie/npm-prefix, and warn when more than one codemie remains on PATH.
 *
 * Hermetic: a fake HOME in a temp dir, stub `node`/`npm` on PATH, system dirs limited to /usr/bin:/bin:/usr/sbin:/sbin.
 * No real npm, no network, no real ~/.codemie.
 *
 * The script under test defaults to install/macos/install.sh; set INSTALLER_SCRIPT_UNDER_TEST to run the same test
 * against another copy (a path relative to the repository root, or absolute). The name avoids the CODEMIE_ prefix,
 * which tests/setup/clean-env.ts strips from the worker environment.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  createTempWorkspace,
  TempWorkspace,
} from "../helpers/temp-workspace.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT_UNDER_TEST = (() => {
  const configured = process.env.INSTALLER_SCRIPT_UNDER_TEST;
  if (!configured) return join(REPO_ROOT, "install", "macos", "install.sh");
  return isAbsolute(configured) ? configured : join(REPO_ROOT, configured);
})();
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** Lays out an npm global install of @codemieai/code under `prefix`, the way npm does. */
function installFakeCodemie(prefix: string, version: string): void {
  mkdirSync(join(prefix, "bin"), { recursive: true });
  mkdirSync(join(prefix, "lib", "node_modules", "@codemieai", "code"), {
    recursive: true,
  });
  writeFileSync(
    join(prefix, "lib", "node_modules", "@codemieai", "code", "package.json"),
    JSON.stringify({ name: "@codemieai/code", version }),
  );
  const bin = join(prefix, "bin", "codemie");
  writeFileSync(bin, `#!/bin/sh\necho "codemie ${version} (stub) $*"\n`);
  chmodSync(bin, 0o755);
}

/** Stub `node` (v20) and `npm` (records every call; installs only with --prefix, EACCES otherwise). */
function writeToolStubs(
  stubBin: string,
  globalPrefix: string,
  callLog: string,
  npmrc: string,
): void {
  mkdirSync(stubBin, { recursive: true });
  writeFileSync(
    join(stubBin, "node"),
    '#!/bin/sh\n[ "$1" = "--version" ] && echo v20.11.0\nexit 0\n',
  );
  writeFileSync(
    join(stubBin, "npm"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> "${callLog}"`,
      'case "$1 $2 $3" in',
      `  "config get userconfig") echo "${npmrc}"; exit 0 ;;`,
      `  "config get prefix") echo "${globalPrefix}"; exit 0 ;;`,
      "esac",
      'if [ "$1" = "view" ]; then echo 0.17.4; exit 0; fi',
      'if [ "$1" = "install" ]; then',
      '  prefix=""',
      '  while [ $# -gt 0 ]; do [ "$1" = "--prefix" ] && prefix="$2"; shift; done',
      '  if [ -z "$prefix" ]; then',
      `    echo "npm error code EACCES: permission denied, mkdir '${globalPrefix}/lib/node_modules'" >&2`,
      "    exit 243",
      "  fi",
      '  mkdir -p "$prefix/bin" "$prefix/lib/node_modules/@codemieai/code"',
      `  printf '#!/bin/sh\\necho "codemie 0.17.4 (stub)"\\n' > "$prefix/bin/codemie"`,
      '  chmod +x "$prefix/bin/codemie"',
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(stubBin, "node"), 0o755);
  chmodSync(join(stubBin, "npm"), 0o755);
}

interface Fixture {
  home: string;
  existingPrefix: string;
  legacyPrefix: string;
  globalPrefix: string;
  callLog: string;
  path: string;
}

function buildFixture(
  workspace: TempWorkspace,
  extraPrefixesOnPath: string[] = [],
): Fixture {
  const home = realpathSync(workspace.path);
  const existingPrefix = join(home, ".npm-global");
  const legacyPrefix = join(home, ".codemie", "npm-prefix");
  const globalPrefix = join(home, "global-npm-prefix");
  const stubBin = join(home, "stub-bin");
  const callLog = join(home, "npm-calls.log");

  installFakeCodemie(existingPrefix, "0.17.3");
  for (const prefix of extraPrefixesOnPath)
    installFakeCodemie(prefix, "0.17.0");
  mkdirSync(join(globalPrefix, "lib", "node_modules"), { recursive: true });
  chmodSync(globalPrefix, 0o555);
  writeToolStubs(stubBin, globalPrefix, callLog, join(home, ".npmrc"));

  const path = [
    stubBin,
    join(existingPrefix, "bin"),
    ...extraPrefixesOnPath.map((p) => join(p, "bin")),
    SYSTEM_PATH,
  ].join(":");
  return { home, existingPrefix, legacyPrefix, globalPrefix, callLog, path };
}

function shellEnv(fixture: Fixture): NodeJS.ProcessEnv {
  return {
    HOME: fixture.home,
    PATH: fixture.path,
    CODEMIE_INSTALL_MODE: "auto",
    LANG: "C",
  };
}

function runInstaller(fixture: Fixture): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync("/bin/bash", [SCRIPT_UNDER_TEST], {
    cwd: fixture.home,
    env: shellEnv(fixture),
    encoding: "utf-8",
    timeout: 20_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function resolvedCodemie(fixture: Fixture): string {
  return spawnSync("/bin/bash", ["-c", "command -v codemie"], {
    env: shellEnv(fixture),
    encoding: "utf-8",
  }).stdout.trim();
}

function globalPrefixWritable(fixture: Fixture): boolean {
  try {
    accessSync(fixture.globalPrefix, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The --prefix of the recorded `npm install` call, or 'npm-global' when it ran without one, or null when absent. */
function installPrefixUsed(fixture: Fixture): string | null {
  if (!existsSync(fixture.callLog)) return null;
  const install = readFileSync(fixture.callLog, "utf-8")
    .split("\n")
    .find((line) => line.startsWith("install "));
  if (!install) return null;
  const match = install.match(/--prefix (\S+)/);
  return match ? match[1] : "npm-global";
}

// Skipped on Windows (runs bash) and as root (root ignores the read-only global prefix the fixture relies on).
const UNSUPPORTED = process.platform === "win32" || process.getuid?.() === 0;

describe.skipIf(UNSUPPORTED)(
  "macOS installer with codemie already installed in another prefix",
  () => {
    let workspace: TempWorkspace;

    beforeEach(() => {
      workspace = createTempWorkspace("codemie-macos-installer-");
    });

    afterEach(() => {
      const globalPrefix = join(
        realpathSync(workspace.path),
        "global-npm-prefix",
      );
      if (existsSync(globalPrefix)) chmodSync(globalPrefix, 0o755);
      workspace.cleanup();
    });

    // @case macos_installer_existing_prefix_TC_001
    it("updates the existing prefix instead of creating ~/.codemie/npm-prefix when the global prefix is not writable", () => {
      const fixture = buildFixture(workspace);

      expect({
        resolves: resolvedCodemie(fixture),
        globalWritable: globalPrefixWritable(fixture),
      }).toEqual({
        resolves: join(fixture.existingPrefix, "bin", "codemie"),
        globalWritable: false,
      }); // repro:precondition

      const run = runInstaller(fixture);
      expect(
        run.status,
        `installer output:\n${run.stdout}\n${run.stderr}`,
      ).toBe(0);

      expect({
        installPrefix: installPrefixUsed(fixture),
        secondCopyCreated: existsSync(
          join(fixture.legacyPrefix, "bin", "codemie"),
        ),
      }).toEqual({
        installPrefix: fixture.existingPrefix,
        secondCopyCreated: false,
      }); // repro:symptom
    });

    // @case macos_installer_existing_prefix_TC_002
    it("warns when more than one codemie copy is on PATH after install", () => {
      const otherPrefix = join(realpathSync(workspace.path), ".other-prefix");
      const fixture = buildFixture(workspace, [otherPrefix]);

      expect(
        spawnSync("/bin/bash", ["-c", "which -a codemie"], {
          env: shellEnv(fixture),
          encoding: "utf-8",
        })
          .stdout.trim()
          .split("\n"),
      ).toEqual([
        join(fixture.existingPrefix, "bin", "codemie"),
        join(otherPrefix, "bin", "codemie"),
      ]); // repro:precondition

      const run = runInstaller(fixture);
      expect(
        run.status,
        `installer output:\n${run.stdout}\n${run.stderr}`,
      ).toBe(0);

      expect(run.stderr).toContain(
        "more than one codemie install is on your PATH",
      ); // repro:symptom
    });
  },
);
