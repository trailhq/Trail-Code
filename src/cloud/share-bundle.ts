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
  /** Sessions the scrub failed on, left out. Absent in a copy made before trail kept it. */
  unreadable?: Array<{ folder: string; id: string; mtime: number }>;
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
  /** The scrub, bundleSession unless a test swaps it. */
  scrub?: typeof bundleSession;
}): Manifest {
  const now = opts.now ?? Date.now();
  const scrub = opts.scrub ?? bundleSession;
  const sessions = sessionsSince(opts.days, opts.home, now);
  mkdirSync(opts.out, { recursive: true });
  const items: BundleItem[] = [];
  const tooBig: Manifest["tooBig"] = [];
  const unreadable: NonNullable<Manifest["unreadable"]> = [];
  const redacted: Record<string, number> = {};
  const add = (r: Record<string, number>) => {
    for (const [k, n] of Object.entries(r)) redacted[k] = (redacted[k] ?? 0) + n;
  };
  const cwds = new Set<string>();
  let hidden = 0;
  let leftOut = 0;

  sessions.forEach((s, i) => {
    const cwd = sessionCwd(s);
    const folder = cwd ? anonymize(cwd, opts.who).text : (s.folder ?? "");
    let b: ReturnType<typeof bundleSession>;
    try {
      b = scrub(s, opts.who);
    } catch {
      // One session the scrub can't read is left out and named in the summary, never sent
      // unscrubbed; the rest still go. Before, it ended the whole share with nothing sent.
      unreadable.push({ folder, id: s.id, mtime: s.mtime });
      opts.onProgress?.(i + 1, sessions.length);
      return;
    }
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
    unreadable,
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
  // Only folders still in: one already left out is no longer on the list.
  return ns.every((n) => m.folders.some((f) => f.n === n && !m.dropped.includes(f.label))) ? ns : null;
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

/**
 * What to type after the preview: one line that says each answer and what it
 * does, then the `→` prompt, so nobody has to guess what a question with three
 * answers wants. Folder numbers are offered while more than one folder is in:
 * with "→ Send it? [y/N]" alone, a teammate didn't know folders could be kept
 * back. Enter still sends nothing. `rest`: asked again after some were left out.
 */
export function sendAsk(m: Manifest, rest = false): string {
  const kept = m.folders.filter((f) => !m.dropped.includes(f.label));
  const what = rest ? "the rest" : kept.length > 1 ? "it all" : "it";
  if (kept.length < 2) return `Type y to send ${what}, or n to send nothing.\n→ `;
  // The example never names every folder still in: that would send nothing but the setup.
  const example = kept.slice(kept.length > 2 ? -2 : -1).map((f) => f.n).join(" ");
  return `Type y to send ${what}, n to send nothing, or ${rest ? "more " : ""}folder numbers to leave out (like ${example}).\n→ `;
}

/**
 * What will be sent, for the person to say yes to, in four short sections:
 * what's sent, from which folders, what isn't, and what happens after yes.
 * `copy` is the folder as shown (`~/.trail/share/…`). The send question
 * (`sendAsk`) follows it, so nothing here may read like the last line.
 */
export function bundlePreviewLines(m: Manifest, copy: string, to: { url: string }, opts: { sync?: string } = {}): string[] {
  const sessions = m.items.filter((it) => it.kind === "session");
  const gz = m.items.reduce((n, it) => n + it.gzBytes, 0);
  const times = sessions.map((s) => s.mtime);
  const [first, last] = times.length ? [dayLabel(Math.min(...times)), dayLabel(Math.max(...times))] : ["", ""];
  const span = first === last ? first : `${first} – ${last}`;
  let host = to.url;
  try {
    host = new URL(to.url).host;
  } catch {
    // keep the address as it is
  }
  const days = `the last ${plural(m.days, "day")}`;
  const kept = m.folders.filter((f) => !m.dropped.includes(f.label));
  const shown = kept.slice(0, 8);
  // A long path keeps its start and end; SUMMARY.md has it whole.
  const short = (l: string) => (l.length > 48 ? `${l.slice(0, 20)}…${l.slice(-27)}` : l);
  const width = Math.max(0, ...shown.map((f) => short(f.label).length));
  const numWidth = Math.max(1, ...shown.map((f) => String(f.n).length));
  const countWidth = Math.max(0, ...shown.map((f) => plural(f.sessions, "session").length));
  const row = (label: string, value: string) => `  ${label.padEnd(11)}${value}`;
  const secrets = Object.values(m.redacted).reduce((a, c) => a + c, 0);
  const notSent = [
    ...(secrets ? [`${plural(secrets, "secret")}, like passwords, tokens and API keys`] : []),
    ...(m.hidden ? ["your name, email and home folder (other people's names stay)"] : []),
    ...(m.setup.mcp ? ["your MCP servers' env values and headers"] : []),
    ...(m.leftOut ? [plural(m.leftOut, "image or other file that isn't text", "images and other files that aren't text")] : []),
    ...(m.tooBig.length ? [`${plural(m.tooBig.length, "session")} over ${sizeLabel(MAX_GZ_BYTES)} zipped, too big to send`] : []),
    ...(m.unreadable?.length ? [`${plural(m.unreadable.length, "session")} trail couldn't scrub, so it isn't sent`] : []),
    ...(m.dropped.length ? [`${plural(m.dropped.length, "folder")} you left out: ${m.dropped.join(", ")}`] : []),
  ];
  return [
    `Send your Claude to the Trail team${opts.sync ? "" : ", once"}`,
    "",
    "What's sent",
    row("Sessions", sessions.length ? `${sessions.length} from ${days} (${span}), ${sizeLabel(gz)} zipped` : `none from ${days}`),
    row("Setup", setupLine(m.setup)),
    row("Memory", plural(m.setup.memory, "note")),
    ...(shown.length
      ? [
          "",
          "From these folders",
          ...shown.map((f) => `  ${String(f.n).padStart(numWidth)}  ${short(f.label).padEnd(width)}  ${plural(f.sessions, "session").padStart(countWidth)}`),
          ...(kept.length > 8 ? [`  …  ${plural(kept.length - 8, "more folder")}, numbered in SUMMARY.md`] : []),
        ]
      : []),
    "",
    "Removed before sending",
    ...(notSent.length ? notSent : ["no secrets or personal details found"]).map((s) => `  ${s}`),
    "",
    "After you say yes",
    `  · It goes to ${host}, without your name.`,
    ...(opts.sync ? ["  · Each new Claude Code session sends what changed (one hook in ~/.claude/settings.json).", `    Stop with: ${opts.sync}`] : []),
    "  · You get a code that deletes everything you sent.",
    "",
    `Read every file first: ${join(copy, "SUMMARY.md")}`,
  ];
}

function setupLine(c: Manifest["setup"]): string {
  const parts: Array<[number, string]> = [
    [c.mcp, plural(c.mcp, "MCP server")],
    [c.skills, plural(c.skills, "skill")],
    [c.agents, plural(c.agents, "agent")],
    [c.commands, plural(c.commands, "command")],
    [c.claudeMd, plural(c.claudeMd, "CLAUDE.md file")],
    [c.hooks, plural(c.hooks, "hook")],
    [c.plugins, plural(c.plugins, "plugin")],
  ];
  const some = parts.filter(([n]) => n > 0).map(([, text]) => text);
  return some.length ? some.join(", ") : "nothing beyond Claude Code's defaults";
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
  if (m.unreadable?.length) {
    out.push("## Left out: trail couldn't scrub these", "");
    for (const u of m.unreadable) out.push(`- ${u.folder} · ${dayLabel(u.mtime)} · session ${u.id.slice(0, 8)}`);
    out.push("");
  }
  writeFileSync(join(dir, "SUMMARY.md"), `${out.join("\n")}\n`);
}
