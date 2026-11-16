/**
 * `trail share-session` with no session named: everything a person's Claude
 * Code holds from the last N days, sent to the Trail team for the
 * team-memory experiment, which asks whether an agent given a teammate's
 * context solves a problem better than one without.
 *
 * Nothing goes until the person has seen it. The whole bundle is scrubbed and
 * written to a folder under `~/.trail/share/` first, exactly as it will be
 * sent: each session as a zipped JSONL, the setup as `setup.json`, and
 * `SUMMARY.md` listing every item by folder. The person can open any of it,
 * leave folders out by their number, or say no. On Trail the items are
 * grouped by a bundle id made here, with nothing that names the person, and a
 * delete code that only this laptop is given takes them all back.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { anonymize, bundleSession, MAX_GZ_BYTES, sessionCwd, sessionsSince, sizeLabel } from "./share-session.js";
import { collectSetup, setupCounts } from "./share-setup.js";

export interface BundleItem {
  kind: "session" | "setup";
  /** The session's id, or `setup`. */
  id: string;
  /** Inside the copy: `sessions/<folder>/<id>.jsonl.gz`, or `setup.json`. */
  file: string;
  /** The folder it ran in, as shown (`~/src/web`); "" for the setup. */
  folder: string;
  /** `github.com/owner/name`, or "". */
  repo: string;
  title: string;
  messages: number;
  subagents: number;
  /** Before zipping. */
  bytes: number;
  gzBytes: number;
  redacted: number;
  /** Last written, ms. */
  mtime: number;
  /** A session's file size on the laptop, before scrubbing: how keep-sending tells it grew. */
  size?: number;
}

export interface Manifest {
  version: 1;
  createdAt: number;
  days: number;
  items: BundleItem[];
  /** Folders by number, the way the summary and a leave-out answer count them. */
  folders: Array<{ n: number; label: string; sessions: number }>;
  /** Folders the person left out, by label. */
  dropped: string[];
  /** Sessions over the upload cap, left out. */
  tooBig: Array<{ folder: string; title: string; gzBytes: number }>;
  /** Secrets taken out, by kind. */
  redacted: Record<string, number>;
  /** Places the person's name, email or home folder was taken out. */
  hidden: number;
  /** Images and files that aren't text, left out. */
  leftOut: number;
  setup: ReturnType<typeof setupCounts>;
  /** The folders the sessions ran in, as they are on this laptop. Kept here, never sent. */
  dirs: string[];
}

/** What has gone from one copy: kept beside it, so a broken send picks up where it stopped. */
export interface SentState {
  bundleId: string;
  /** The delete code's secret part. Trail keeps only its sha256. */
  secret: string;
  sent: string[];
  finishedAt?: number;
  deletedAt?: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (ms: number) => `${MONTHS[new Date(ms).getMonth()]} ${new Date(ms).getDate()}`;

/** `~/Documents/assign` → `Documents-assign`, safe as one folder name. */
export function slug(label: string): string {
  return label.replace(/^~[\\/]?/, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "home";
}

/** A new folder for one copy under `root`: `2026-11-05-1412`, or `-2` and on if that's taken. */
export function newCopyDir(root: string, now = Date.now()): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  const base = join(root, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`);
  let dir = base;
  for (let i = 2; existsSync(dir); i++) dir = `${base}-${i}`;
  return dir;
}

/**
 * Scrub the last `days` days of sessions and the setup into `out`, and say
 * what's there. `repoOf` names a folder's repo; `onProgress` hears each
 * session as it's done.
 */
export function prepareBundle(opts: {
  days: number;
  home: string;
  who: string[];
  out: string;
  now?: number;
  repoOf?: (cwd: string) => string;
  onProgress?: (done: number, total: number) => void;
}): Manifest {
  const now = opts.now ?? Date.now();
  const sessions = sessionsSince(opts.days, opts.home, now);
  mkdirSync(opts.out, { recursive: true });
  const items: BundleItem[] = [];
  const tooBig: Manifest["tooBig"] = [];
  const redacted: Record<string, number> = {};
  const add = (r: Record<string, number>) => {
    for (const [k, n] of Object.entries(r)) redacted[k] = (redacted[k] ?? 0) + n;
  };
  const cwds = new Set<string>();
  let hidden = 0;
  let leftOut = 0;

  sessions.forEach((s, i) => {
    const b = bundleSession(s, opts.who);
    const cwd = sessionCwd(s);
    const folder = cwd ? anonymize(cwd, opts.who).text : (s.folder ?? "");
    hidden += b.hidden;
    leftOut += b.leftOut;
    if (b.gz.length > MAX_GZ_BYTES) {
      tooBig.push({ folder, title: b.title, gzBytes: b.gz.length });
    } else {
      // Always `/`: it's shown in SUMMARY.md, and join() takes it on Windows too.
      const file = ["sessions", slug(folder), `${s.id}.jsonl.gz`].join("/");
      mkdirSync(join(opts.out, dirname(file)), { recursive: true });
      writeFileSync(join(opts.out, file), b.gz);
      add(b.redacted);
      if (cwd && existsSync(cwd)) cwds.add(cwd);
      items.push({
        kind: "session",
        id: s.id,
        file,
        folder,
        repo: cwd && opts.repoOf ? opts.repoOf(cwd) : "",
        title: b.title,
        messages: b.messages,
        subagents: b.subagents,
        bytes: b.bytes,
        gzBytes: b.gz.length,
        redacted: Object.values(b.redacted).reduce((n, c) => n + c, 0),
        mtime: s.mtime,
        size: s.size,
      });
    }
    opts.onProgress?.(i + 1, sessions.length);
  });

  const set = collectSetup({ home: opts.home, dirs: [...cwds], who: opts.who });
  const json = `${JSON.stringify(set.setup, null, 2)}\n`;
  writeFileSync(join(opts.out, "setup.json"), json);
  add(set.redacted);
  hidden += set.hidden;
  leftOut += set.leftOut;
  items.unshift({
    kind: "setup",
    id: "setup",
    file: "setup.json",
    folder: "",
    repo: "",
    title: "Claude setup",
    messages: 0,
    subagents: 0,
    bytes: Buffer.byteLength(json),
    gzBytes: gzipSync(json).length,
    redacted: Object.values(set.redacted).reduce((n, c) => n + c, 0),
    mtime: now,
  });

  const m: Manifest = {
    version: 1,
    createdAt: now,
    days: opts.days,
    items,
    folders: numberFolders(items),
    dropped: [],
    tooBig,
    redacted,
    hidden,
    leftOut,
    setup: setupCounts(set.setup),
    dirs: [...cwds].sort(),
  };
  writeCopy(opts.out, m);
  return m;
}

function numberFolders(items: BundleItem[]): Manifest["folders"] {
  const count = new Map<string, number>();
  for (const it of items) if (it.kind === "session") count.set(it.folder, (count.get(it.folder) ?? 0) + 1);
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, sessions], i) => ({ n: i + 1, label, sessions }));
}

/**
 * The folder numbers in an answer like `3 7` or `3, 7`, or null when the
 * answer isn't only numbers or names a folder that isn't listed.
 */
export function parseLeaveOut(answer: string, m: Manifest): number[] | null {
  const parts = answer.split(/[\s,]+/).filter(Boolean);
  if (!parts.length || !parts.every((p) => /^\d{1,4}$/.test(p))) return null;
  const ns = [...new Set(parts.map(Number))];
  return ns.every((n) => m.folders.some((f) => f.n === n)) ? ns : null;
}

/** Take the numbered folders out of the copy: their files go, and the summary says so. */
export function leaveOut(dir: string, m: Manifest, numbers: number[]): Manifest {
  const labels = new Set(m.folders.filter((f) => numbers.includes(f.n)).map((f) => f.label));
  for (const it of m.items) if (it.kind === "session" && labels.has(it.folder)) rmSync(join(dir, it.file), { force: true });
  for (const l of labels) rmSync(join(dir, "sessions", slug(l)), { recursive: true, force: true });
  const next: Manifest = { ...m, items: m.items.filter((it) => !(it.kind === "session" && labels.has(it.folder))), dropped: [...m.dropped, ...labels] };
  writeCopy(dir, next);
  return next;
}

export function readManifest(dir: string): Manifest | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
    return m.version === 1 && Array.isArray(m.items) ? m : null;
  } catch {
    return null;
  }
}

export function readSent(dir: string): SentState | null {
  try {
    const s = JSON.parse(readFileSync(join(dir, "sent.json"), "utf8")) as SentState;
    return typeof s.bundleId === "string" && Array.isArray(s.sent) ? s : null;
  } catch {
    return null;
  }
}

export function writeSent(dir: string, s: SentState): void {
  writeFileSync(join(dir, "sent.json"), `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
}

/** A new bundle id and the secret half of its delete code. */
export function newSentState(): SentState {
  return { bundleId: randomUUID(), secret: randomBytes(18).toString("base64url"), sent: [] };
}

/** The one string the person keeps: `<bundle id>.<secret>`. */
export function deleteCode(s: Pick<SentState, "bundleId" | "secret">): string {
  return `${s.bundleId}.${s.secret}`;
}

export function parseDeleteCode(code: string): { bundleId: string; secret: string } | null {
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{16,})$/i.exec(code.trim());
  return m ? { bundleId: m[1]!.toLowerCase(), secret: m[2]! } : null;
}

/** What Trail keeps of a delete code: the sha256 of its secret, in hex. */
export function deleteHash(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * The newest copy under `root` that hasn't all gone: one never sent, or one
 * whose send stopped partway. Null when there's none.
 */
export function unfinishedCopy(root: string): { dir: string; manifest: Manifest; sent: SentState | null } | null {
  let names: string[];
  try {
    names = readdirSync(root).sort().reverse();
  } catch {
    return null;
  }
  for (const name of names) {
    const dir = join(root, name);
    const manifest = readManifest(dir);
    if (!manifest) continue;
    const sent = readSent(dir);
    if (sent?.finishedAt || sent?.deletedAt) return null;
    return { dir, manifest, sent };
  }
  return null;
}

/** One item as Trail takes it: the zipped bytes in base64. */
export function itemPayload(dir: string, it: BundleItem): string {
  const raw = readFileSync(join(dir, it.file));
  return (it.file.endsWith(".gz") ? raw : gzipSync(raw)).toString("base64");
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What will be sent, for the person to say yes to. `copy` is the folder as shown (`~/.trail/share/…`). */
export function bundlePreviewLines(m: Manifest, copy: string, to: { url: string }, opts: { sync?: string } = {}): string[] {
  const sessions = m.items.filter((it) => it.kind === "session");
  const gz = m.items.reduce((n, it) => n + it.gzBytes, 0);
  const times = sessions.map((s) => s.mtime);
  const [first, last] = times.length ? [dayLabel(Math.min(...times)), dayLabel(Math.max(...times))] : ["", ""];
  const span = !times.length ? "none" : first === last ? first : `${first} – ${last}`;
  let host = to.url;
  try {
    host = new URL(to.url).host;
  } catch {
    // keep the address as it is
  }
  const kept = m.folders.filter((f) => !m.dropped.includes(f.label));
  // A long path keeps its start and end; SUMMARY.md has it whole.
  const short = (l: string) => (l.length > 48 ? `${l.slice(0, 20)}…${l.slice(-27)}` : l);
  const width = Math.max(0, ...kept.slice(0, 8).map((f) => short(f.label).length));
  const rows: Array<[string, string]> = [
    ["Sessions", `${plural(sessions.length, "session")} in ${plural(kept.length, "folder")} · ${span} · ${sizeLabel(gz)} zipped`],
    ...kept.slice(0, 8).map((f): [string, string] => ["", `${String(f.n).padStart(3)}  ${short(f.label).padEnd(width)}  ${plural(f.sessions, "session")}`]),
    ...(kept.length > 8 ? [["", `  …  ${plural(kept.length - 8, "more folder")}, numbered in SUMMARY.md`] as [string, string]] : []),
    ["Setup", setupLine(m.setup)],
    ["Memory", plural(m.setup.memory, "note")],
    ["Secrets", redactedLine(m.redacted)],
    ["You", `${m.hidden ? `your name, email and home folder taken out in ${plural(m.hidden, "place")}` : "nothing that names you found"}; other people's names stay`],
    ...(m.leftOut || m.tooBig.length ? [["Left out", leftOutLine(m)] as [string, string]] : []),
    ...(m.dropped.length ? [["Dropped", `you left out ${plural(m.dropped.length, "folder")}: ${m.dropped.join(", ")}`] as [string, string]] : []),
    ["Copy", `${copy}  every file exactly as it will go, listed in SUMMARY.md`],
    ["Goes to", `the Trail team on ${host}, for the team-memory experiment, without your name`],
    ...(opts.sync
      ? ([
          ["Keeps on", `after this, each Claude Code session you start sends what changed since, scrubbed the same way and kept in a copy you can read; ${opts.sync} stops it`],
          ["Hook", "one entry in ~/.claude/settings.json, so it runs in every folder, in the terminal and in Claude Desktop; stopping takes it out"],
        ] as Array<[string, string]>)
      : []),
    ["Delete", "any time, with the code you get once it's sent"],
  ];
  const head = `Your Claude, last ${plural(m.days, "day")}${opts.sync ? " and from now on" : ""}, ready to send to the Trail team`;
  return [head, "", ...rows.map(([k, v]) => `${k.padEnd(10)}${v}`)];
}

function setupLine(c: Manifest["setup"]): string {
  const parts: Array<[number, string]> = [
    [c.mcp, `${plural(c.mcp, "MCP server")} (env values and headers left out)`],
    [c.skills, plural(c.skills, "skill")],
    [c.agents, plural(c.agents, "agent")],
    [c.commands, plural(c.commands, "command")],
    [c.claudeMd, plural(c.claudeMd, "CLAUDE.md file")],
    [c.hooks, plural(c.hooks, "hook")],
    [c.plugins, plural(c.plugins, "plugin")],
  ];
  const some = parts.filter(([n]) => n > 0).map(([, text]) => text);
  return some.length ? some.join(" · ") : "nothing set up beyond Claude Code's defaults";
}

function redactedLine(r: Record<string, number>): string {
  const n = Object.values(r).reduce((a, c) => a + c, 0);
  if (!n) return "none found";
  const kinds = Object.entries(r)
    .sort((x, y) => y[1] - x[1])
    .map(([k, c]) => `${k.replace(/^an? /, "")} ×${c}`)
    .join(", ");
  return `${n} redacted: ${kinds}`;
}

function leftOutLine(m: Manifest): string {
  return [
    ...(m.leftOut ? [`${plural(m.leftOut, "image or file that isn't text", "images and files that aren't text")}`] : []),
    ...(m.tooBig.length ? [`${plural(m.tooBig.length, "session")} over ${sizeLabel(MAX_GZ_BYTES)} zipped`] : []),
  ].join("; ");
}

/** The copy's manifest and its SUMMARY.md, rewritten together. */
function writeCopy(dir: string, m: Manifest): void {
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(m, null, 2)}\n`);
  const out = [
    "# What share-session will send",
    "",
    "Every file below is in this folder, exactly as it will go to the Trail team. Sessions are zipped JSONL; read one with",
    "",
    "    gunzip -c sessions/<folder>/<id>.jsonl.gz | less",
    "",
    "`setup.json` holds your MCP servers, settings, plugins, skills, agents, commands, CLAUDE.md files and memory notes.",
    "",
    "## Folders",
    "",
    "Answer with these numbers to leave a folder out.",
    "",
    ...m.folders.map((f) => `${String(f.n).padStart(3)}. ${f.label} · ${plural(f.sessions, "session")}${m.dropped.includes(f.label) ? " · left out" : ""}`),
    "",
    "## Sessions",
    "",
  ];
  for (const f of m.folders) {
    if (m.dropped.includes(f.label)) continue;
    out.push(`### ${f.n}. ${f.label}`, "");
    for (const it of m.items.filter((x) => x.kind === "session" && x.folder === f.label)) {
      const secrets = it.redacted ? ` · ${plural(it.redacted, "secret")} redacted` : "";
      out.push(`- ${dayLabel(it.mtime)} · ${it.title || "(nothing typed)"} · ${plural(it.messages, "message")} · ${sizeLabel(it.gzBytes)}${secrets} · \`${it.file}\``);
    }
    out.push("");
  }
  if (m.tooBig.length) {
    out.push("## Left out: too big to send", "");
    for (const t of m.tooBig) out.push(`- ${t.folder} · ${t.title || "(nothing typed)"} · ${sizeLabel(t.gzBytes)} zipped`);
    out.push("");
  }
  writeFileSync(join(dir, "SUMMARY.md"), `${out.join("\n")}\n`);
}
