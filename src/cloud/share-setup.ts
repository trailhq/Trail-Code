/**
 * What a person's Claude Code is set up with, for `trail share-session`: the
 * MCP servers it reaches, the hooks and permissions in its settings, its
 * plugins, skills, agents and commands, the CLAUDE.md files it reads, and the
 * notes Claude Code's memory keeps. One JSON document, sent beside the
 * person's sessions.
 *
 * Nothing that can hold a secret leaves as a value: an MCP server's `env` and
 * `headers`, and a settings file's `env`, go as their names only, and a URL as
 * its origin. Every other string goes through `redactText` and then
 * `anonymize`, the same as a session's.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactText, type Redaction } from "../trace/redact.js";
import { anonymize } from "./share-session.js";

/** A file bigger than this is left out: a skill or a memory note is a few KB. */
const MAX_FILE = 512 * 1024;

export interface McpServerInfo {
  /** `user`, `desktop`, `local <folder>` (Claude Code's per-folder scope) or `project <folder>` (`.mcp.json`). */
  scope: string;
  name: string;
  type: string;
  command?: string;
  args: string[];
  /** Origin only: a path or query can carry a token. */
  url?: string;
  /** Names only. */
  env: string[];
  /** Names only. */
  headers: string[];
}

export interface SettingsInfo {
  path: string;
  model?: string;
  outputStyle?: string;
  statusLine?: string;
  /** Event → `matcher → command` for each hook. */
  hooks: Record<string, string[]>;
  permissions: { allow: string[]; ask: string[]; deny: string[] };
  /** Plugins turned on here. */
  plugins: string[];
  /** Names only. */
  env: string[];
}

export interface SetupFile {
  kind: "claude-md" | "skill" | "agent" | "command" | "memory";
  path: string;
  content: string;
}

export interface ClaudeSetup {
  kind: "claude-setup";
  version: 1;
  mcp: McpServerInfo[];
  settings: SettingsInfo[];
  /** Installed plugins, by name. */
  plugins: string[];
  files: SetupFile[];
}

export interface SetupResult {
  setup: ClaudeSetup;
  /** Secrets taken out, by kind. */
  redacted: Record<string, number>;
  /** Places the person's name, email or home folder was taken out. */
  hidden: number;
  /** Files over the size cap, left out. */
  leftOut: number;
}

type Json = Record<string, unknown>;

function readJson(path: string): Json | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

function obj(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** The `.md` files in `dir` (one level), sorted. */
function mdFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** `<dir>/*\/SKILL.md`, sorted. */
function skillFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .sort()
      .map((d) => join(dir, d, "SKILL.md"));
  } catch {
    return [];
  }
}

/** Where Claude Desktop keeps its MCP servers on this platform. */
function desktopConfig(home: string): string {
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return join(home, ".config", "Claude", "claude_desktop_config.json");
}

/**
 * The person's Claude Code setup, scrubbed. `dirs` are the folders their
 * shared sessions ran in: each one's `.mcp.json`, `.claude/` and CLAUDE.md
 * files are read too.
 */
export function collectSetup(opts: { home?: string; dirs?: string[]; who: string[] }): SetupResult {
  const home = opts.home ?? homedir();
  const taken = new Map<string, string>();
  let hidden = 0;
  let leftOut = 0;
  const clean = (s: string): string => {
    const r = redactText(s);
    for (const f of r.found as Redaction[]) if (!taken.has(f.what)) taken.set(f.what, f.kind);
    const a = anonymize(r.text, opts.who);
    hidden += a.n;
    return a.text;
  };
  const origin = (u: string): string => {
    try {
      return new URL(u).origin;
    } catch {
      return clean(u.split(/[?#]/)[0] ?? "");
    }
  };

  const mcp: McpServerInfo[] = [];
  const addServers = (scope: string, servers: unknown) => {
    for (const [name, raw] of Object.entries(obj(servers))) {
      const s = obj(raw);
      const url = typeof s.url === "string" ? s.url : undefined;
      mcp.push({
        scope: clean(scope),
        name: clean(name),
        type: typeof s.type === "string" ? s.type : url ? "http" : "stdio",
        ...(typeof s.command === "string" ? { command: clean(s.command) } : {}),
        args: strings(s.args).map(clean),
        ...(url ? { url: origin(url) } : {}),
        env: Object.keys(obj(s.env)).map(clean),
        headers: Object.keys(obj(s.headers)).map(clean),
      });
    }
  };
  const root = readJson(join(home, ".claude.json"));
  addServers("user", root?.mcpServers);
  for (const [dir, p] of Object.entries(obj(root?.projects))) addServers(`local ${dir}`, obj(p).mcpServers);
  addServers("desktop", readJson(desktopConfig(home))?.mcpServers);

  const dirs = [...new Set(opts.dirs ?? [])].filter((d) => d !== home).sort();
  for (const d of dirs) addServers(`project ${d}`, readJson(join(d, ".mcp.json"))?.mcpServers);

  const settings: SettingsInfo[] = [];
  const addSettings = (path: string) => {
    const s = readJson(path);
    if (!s) return;
    const hooks: Record<string, string[]> = {};
    for (const [event, groups] of Object.entries(obj(s.hooks))) {
      const out: string[] = [];
      for (const g of Array.isArray(groups) ? groups : []) {
        const matcher = typeof obj(g).matcher === "string" ? (obj(g).matcher as string) : "";
        for (const h of Array.isArray(obj(g).hooks) ? (obj(g).hooks as unknown[]) : []) {
          const command = obj(h).command;
          // share-session's own entry is plumbing, not the person's setup: leaving it out keeps the setup unchanged by the yes.
          if (typeof command === "string" && !command.includes('-hooks.cjs" share-sync')) out.push(clean(matcher ? `${matcher} → ${command}` : command));
        }
      }
      if (out.length) hooks[event] = out;
    }
    const perms = obj(s.permissions);
    const statusLine = obj(s.statusLine).command;
    const info: SettingsInfo = {
      path: clean(path),
      ...(typeof s.model === "string" ? { model: s.model } : {}),
      ...(typeof s.outputStyle === "string" ? { outputStyle: clean(s.outputStyle) } : {}),
      ...(typeof statusLine === "string" ? { statusLine: clean(statusLine) } : {}),
      hooks,
      permissions: { allow: strings(perms.allow).map(clean), ask: strings(perms.ask).map(clean), deny: strings(perms.deny).map(clean) },
      plugins: Object.entries(obj(s.enabledPlugins))
        .filter(([, on]) => on === true)
        .map(([name]) => clean(name)),
      env: Object.keys(obj(s.env)).map(clean),
    };
    // A file that says nothing (one holding only share-session's own hook, say) adds nothing to the setup.
    const { path: _path, permissions, hooks: h, ...rest } = info;
    const empty = !Object.keys(h).length && !permissions.allow.length && !permissions.ask.length && !permissions.deny.length && Object.values(rest).every((v) => (Array.isArray(v) ? !v.length : v === undefined));
    if (!empty) settings.push(info);
  };
  addSettings(join(home, ".claude", "settings.json"));
  for (const d of dirs) for (const f of ["settings.json", "settings.local.json"]) addSettings(join(d, ".claude", f));

  const installed = readJson(join(home, ".claude", "plugins", "installed_plugins.json"));
  const plugins = Object.keys(obj(installed?.plugins ?? installed)).map(clean).sort();

  const files: SetupFile[] = [];
  const seen = new Set<string>();
  const addFile = (kind: SetupFile["kind"], path: string) => {
    if (seen.has(path)) return;
    let size: number;
    try {
      const st = statSync(path);
      if (!st.isFile()) return;
      size = st.size;
    } catch {
      return;
    }
    seen.add(path);
    if (size > MAX_FILE) {
      leftOut++;
      return;
    }
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      return;
    }
    files.push({ kind, path: clean(path), content: clean(content) });
  };
  const claudeDir = join(home, ".claude");
  addFile("claude-md", join(claudeDir, "CLAUDE.md"));
  for (const f of skillFiles(join(claudeDir, "skills"))) addFile("skill", f);
  for (const f of mdFiles(join(claudeDir, "agents"))) addFile("agent", f);
  for (const f of mdFiles(join(claudeDir, "commands"))) addFile("command", f);
  for (const d of dirs) {
    for (const f of ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", join(".claude", "CLAUDE.md")]) addFile("claude-md", join(d, f));
    for (const f of skillFiles(join(d, ".claude", "skills"))) addFile("skill", f);
    for (const f of mdFiles(join(d, ".claude", "agents"))) addFile("agent", f);
    for (const f of mdFiles(join(d, ".claude", "commands"))) addFile("command", f);
  }
  const projects = join(claudeDir, "projects");
  let folders: string[] = [];
  try {
    folders = readdirSync(projects).sort();
  } catch {
    // no Claude Code projects yet
  }
  for (const p of folders) for (const f of mdFiles(join(projects, p, "memory"))) addFile("memory", f);

  const redacted: Record<string, number> = {};
  for (const kind of taken.values()) redacted[kind] = (redacted[kind] ?? 0) + 1;
  return { setup: { kind: "claude-setup", version: 1, mcp, settings, plugins, files }, redacted, hidden, leftOut };
}

/** `2 MCP servers, 41 skills, 3 CLAUDE.md files, 6 hooks`: what a setup holds, for the summary. */
export function setupCounts(s: ClaudeSetup): { mcp: number; skills: number; agents: number; commands: number; claudeMd: number; memory: number; hooks: number; plugins: number } {
  const n = (k: SetupFile["kind"]) => s.files.filter((f) => f.kind === k).length;
  return {
    mcp: s.mcp.length,
    skills: n("skill"),
    agents: n("agent"),
    commands: n("command"),
    claudeMd: n("claude-md"),
    memory: n("memory"),
    hooks: s.settings.reduce((sum, x) => sum + Object.values(x.hooks).reduce((a, h) => a + h.length, 0), 0),
    plugins: new Set([...s.plugins, ...s.settings.flatMap((x) => x.plugins)]).size,
  };
}
