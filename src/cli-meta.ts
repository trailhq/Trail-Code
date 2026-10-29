/**
 * `graft version` / `graft --version` / `graft upgrade` support.
 *
 * Split out of cli.ts so the formatting helpers can be unit-tested with
 * injected results instead of hitting the network from tests.
 */
import { existsSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toPosixPath } from "./util/paths.js";
import { brand, PACKAGE_FOR } from "./brand.js";

/** Locates package.json relative to a module URL (works for both `dist/cli.js`
 * running one level under the published package root, and `src/cli.ts` running
 * one level under the repo root via tsx). */
export function resolvePackageJsonPath(moduleUrl: string): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const candidates = [resolve(moduleDir, "..", "package.json"), resolve(moduleDir, "package.json")];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

/**
 * The npm package this code was installed as: `@trailhq/trail-code`, or
 * `@nanonets/graft` (the same code under its old name). Upgrades and update
 * checks go to the package actually installed, not to the name typed.
 */
export function readPackageName(moduleUrl: string): string {
  try {
    const pkg = JSON.parse(readFileSync(resolvePackageJsonPath(moduleUrl), "utf8")) as { name?: string };
    return pkg.name ?? PACKAGE_FOR.graft;
  } catch {
    return PACKAGE_FOR.graft;
  }
}

const PKG_NAME = readPackageName(import.meta.url);

/** Reads the version of the graft package this module was loaded from. */
export function readCurrentVersion(moduleUrl: string): string {
  const raw = readFileSync(resolvePackageJsonPath(moduleUrl), "utf8");
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version ?? "0.0.0";
}

/** True when the running module lives under an npx cache dir (e.g.
 * `~/.npm/_npx/<hash>/node_modules/...`) rather than a regular global install.
 *
 * Normalized first: `fileURLToPath` returns the *platform* separator, so on
 * Windows the cache path is `…\_npx\…` and a bare `includes("/_npx/")` is always
 * false — `graft upgrade` would then run `npm install -g` on top of an npx run.
 * Same hardcoded-`/` mistake as #33; `src/util/paths.ts` exists for exactly this. */
export function isRunningViaNpx(moduleUrl: string): boolean {
  return toPosixPath(fileURLToPath(moduleUrl)).includes("/_npx/");
}

export interface NpmViewResult {
  ok: boolean;
  version?: string;
}

/** `npm view <pkg> version`, offline-safe: any failure (no npm, no network,
 * timeout) resolves to `{ ok: false }` rather than throwing. */
export function getNpmViewVersion(pkgName: string = PKG_NAME, timeoutMs = 2000): NpmViewResult {
  try {
    const res = spawnSync("npm", ["view", pkgName, "version"], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    });
    if (res.error || res.signal || res.status !== 0) return { ok: false };
    const version = res.stdout?.trim();
    if (!version) return { ok: false };
    return { ok: true, version };
  } catch {
    return { ok: false };
  }
}

/** Pure formatter for `graft version` — no I/O, easy to unit-test. */
export function formatVersionReport(current: string, latest: NpmViewResult): string {
  const lines = [`${brand()} ${current}`];
  if (!latest.ok || !latest.version) {
    lines.push("latest: unreachable (offline?)");
  } else if (latest.version === current) {
    lines.push(`latest on npm: ${current} ✓ up to date`);
  } else {
    lines.push(`latest on npm: ${latest.version}, run ${brand()} upgrade`);
  }
  return lines.join("\n");
}

/** The global npm node_modules dir (handles Homebrew/Windows/volta layouts). */
function globalRoot(): string | null {
  try {
    const root = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: process.platform === "win32",
    }).trim();
    return root || null;
  } catch {
    return null;
  }
}

/** Reads the version actually sitting in the global install, straight from
 * disk — more reliable right after `npm install -g` than re-querying the
 * registry (which just tells you what "latest" is, not what landed locally). */
export function readGlobalInstalledVersion(pkgName: string = PKG_NAME): string | null {
  const root = globalRoot();
  if (!root) return null;
  const pkgJson = join(root, ...pkgName.split("/"), "package.json");
  if (!existsSync(pkgJson)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export interface UpgradeResult {
  /** True when `npm install -g` actually ran (false for the npx no-op path). */
  ran: boolean;
  ok: boolean;
  /** Present when ran=true and the install failed. */
  errorMessage?: string;
  oldVersion?: string;
  newVersion?: string;
  /** The `trail` package's version, when `graft upgrade` installed it alongside. */
  trailVersion?: string;
  /** A plain fix for a failure we recognise, shown instead of npm's error block. */
  fix?: string;
  /** npm's own error output, for a failure we don't recognise. */
  npmError?: string;
}

/** Pure formatter for a finished upgrade — no I/O, easy to unit-test. */
export function formatUpgradeReport(result: UpgradeResult): string {
  if (!result.ran) {
    return (
      `running via npx: npx already fetches the latest ${brand()} on every run.\n` +
      `For a permanent install: npm install -g ${PKG_NAME}`
    );
  }
  if (!result.ok) {
    if (result.fix) return `✗ ${brand()} wasn't upgraded: ${result.fix}`;
    const failed = `✗ npm install -g ${PKG_NAME}@latest failed${result.errorMessage ? `: ${result.errorMessage}` : ""}`;
    return `${result.npmError?.trim() ? `${result.npmError.trim()}\n` : ""}${failed}`;
  }
  const line = `${brand()} ${result.oldVersion ?? "?"} → ${result.newVersion ?? result.oldVersion ?? "?"}`;
  return result.trailVersion ? `${line}\n✓ trail ${result.trailVersion} installed too: graft keeps working, and trail is its new name` : line;
}

/** What npm's error block names: its code, and the path (and rename dest) it failed on. */
export interface NpmProblem {
  code: string;
  path?: string;
  dest?: string;
}

/** Reads npm's `npm error code …` and `npm error path …` lines (`npm ERR!` before npm 10). */
export function parseNpmError(stderr: string): NpmProblem | null {
  const field = (name: string) => stderr.match(new RegExp(`^npm (?:error|ERR!) ${name} (.+)$`, "m"))?.[1].trim();
  const code = field("code");
  return code ? { code, path: field("path"), dest: field("dest") } : null;
}

/** A link in npm's bin folder that points into a trail or graft install, or at nothing. */
function isTrailLink(path: string): boolean {
  let target: string;
  try {
    target = resolve(dirname(path), readlinkSync(path));
  } catch {
    return false; // not a link: someone else's file
  }
  return !existsSync(target) || /[\\/](@trailhq[\\/]trail-code|@nanonets[\\/]graft)[\\/]|[\\/]dist[\\/]bin[\\/](trail|graft)\.js$/.test(target);
}

/**
 * Removes what an earlier npm run left behind that makes every later `npm i -g`
 * fail, and says what it removed; null when it's nothing trail should touch.
 *
 *  - ENOTEMPTY: npm moves the old package aside to `.<name>-<hash of its path>`
 *    before writing the new one. An install stopped midway leaves that folder,
 *    and as the name comes from the path, every later install collides with it.
 *  - EEXIST: a `trail` or `graft` link in npm's bin folder from another copy of
 *    trail (a local build installed from a folder, say), which npm won't replace.
 *    Only a link into a trail or graft install, or to nothing, is removed.
 */
export function clearNpmLeftover(problem: NpmProblem | null): string | null {
  if (problem?.code === "ENOTEMPTY" && problem.path && problem.dest) {
    if (dirname(problem.dest) !== dirname(problem.path) || !basename(problem.dest).startsWith(".")) return null;
    rmSync(problem.dest, { recursive: true, force: true });
    return `removed ${problem.dest}, left by an npm install that was stopped midway`;
  }
  if (problem?.code === "EEXIST" && problem.path && isTrailLink(problem.path)) {
    rmSync(problem.path, { force: true });
    return `removed ${problem.path}, a link to another copy of trail`;
  }
  return null;
}

/**
 * The fix for a global folder only root can write to (Node from nodejs.org or a
 * system package): an npm prefix in the home folder, set once. Not sudo: a sudo
 * install works once, then every upgrade needs it too.
 */
export function noSudoFix(path: string, pkgs: string[], shell: string = process.env.SHELL ?? "", platform: string = process.platform): string {
  const addToPath = shell.endsWith("fish")
    ? "fish_add_path ~/.npm-global/bin"
    : `echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ${shell.endsWith("zsh") ? "~/.zshrc" : platform === "darwin" ? "~/.bash_profile" : "~/.bashrc"}`;
  return [
    `npm needs sudo to write to ${path}.`,
    "  Skip sudo: point npm at a folder in your home, once, and installs never need it again:",
    "",
    "    mkdir -p ~/.npm-global",
    "    npm config set prefix ~/.npm-global",
    `    ${addToPath}`,
    "",
    `  Then open a new terminal and run: npm i -g ${pkgs.join(" ")}`,
  ].join("\n");
}

/** `npm <args>` with npm's stderr kept, to read its error code; stdout still shows. */
function npmRun(args: string[]): { ok: boolean; stderr: string; error?: string } {
  const res = spawnSync("npm", args, { stdio: ["inherit", "inherit", "pipe"], encoding: "utf8" });
  return { ok: !res.error && res.status === 0, stderr: res.stderr ?? "", error: res.error?.message };
}

/** Runs `npm install -g @nanonets/graft@latest`, clearing npm leftovers that
 * block it (`clearNpmLeftover`) and turning EACCES into the no-sudo fix, then
 * re-reads the freshly installed version. No-ops with guidance when running
 * via npx. */
export function runUpgrade(moduleUrl: string): UpgradeResult {
  const oldVersion = readCurrentVersion(moduleUrl);
  if (isRunningViaNpx(moduleUrl)) {
    return { ran: false, ok: true, oldVersion };
  }
  // `graft upgrade` is the handover: it also installs the `trail` command, once
  // that package is published. One npm call, so the two land at one version.
  const alongside = PKG_NAME === PACKAGE_FOR.graft && getNpmViewVersion(PACKAGE_FOR.trail).ok ? [PACKAGE_FOR.trail] : [];
  const pkgs = [PKG_NAME, ...alongside];
  const args = ["install", "-g", ...pkgs.map((p) => `${p}@latest`)];
  console.error(`· npm ${args.join(" ")}`);
  let res = npmRun(args);
  // Two leftovers at most (graft upgrade installs two packages), then npm's own error stands.
  for (let retries = 0; !res.ok && retries < 2; retries++) {
    const cleared = clearNpmLeftover(parseNpmError(res.stderr));
    if (!cleared) break;
    console.error(`· ${cleared}; trying again`);
    res = npmRun(args);
  }
  if (!res.ok) {
    const problem = parseNpmError(res.stderr);
    if (problem?.code === "EACCES" && process.platform !== "win32") {
      return { ran: true, ok: false, oldVersion, fix: noSudoFix(problem.path ?? "npm's global folder", pkgs) };
    }
    return { ran: true, ok: false, oldVersion, npmError: res.stderr, errorMessage: res.error };
  }
  const newVersion = readGlobalInstalledVersion(PKG_NAME) ?? getNpmViewVersion(PKG_NAME).version ?? oldVersion;
  const trailVersion = alongside.length ? (readGlobalInstalledVersion(PACKAGE_FOR.trail) ?? undefined) : undefined;
  return { ran: true, ok: true, oldVersion, newVersion, trailVersion };
}
