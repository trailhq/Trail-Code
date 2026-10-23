/**
 * Register the graft MCP server in each host's config.
 * JSON hosts get a keyed merge (other servers preserved; unparseable files
 * are never rewritten). The TOML host gets an append-if-absent section.
 *
 * `mcpTargets()` is the pure "which files would this touch" half, so `graft
 * init --dry-run` and the picker can report paths without writing;
 * `registerMcpConfigs()` walks that same list to do the writing.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { PlannedWrite } from './plan.js';
import { readJsonObject, type ConfigWrite } from './config-write.js';
import { trailOnPath, type Brand } from '../brand.js';

/** MCP registration reports the same write-result record every installer does. */
export type McpWrite = ConfigWrite;

/** A planned MCP write, plus the detail needed to actually perform it. */
export interface McpTarget extends PlannedWrite {
  format: 'json' | 'toml';
  /** JSON only: the top-level key holding the server map. */
  topKey?: string;
  /** JSON only: the server entry to merge in under `key`. */
  entry?: object;
  /** The server's name in the file: `graft`, or `trail` in a repo that uses trail. */
  key: Brand;
}

/**
 * How to launch the MCP server, decided once at init time.
 *
 * `npx -y` resolves the package before it can serve: measured at a 211 ms
 * spawn→`initialize` handshake against 80 ms for the installed binary, five runs
 * each. The harness registers a server's tools only once that handshake lands, and
 * a slow one can miss the first request entirely — in a traced session graft's
 * tools arrived 13.9 s in, four model turns too late to shape the approach. (That
 * 13.9 s is NOT explained by 130 ms; the gap's cause is still unknown. This is the
 * cheap half of the fix, not the whole of it.)
 *
 * Deliberately a bare command name, never an absolute path: these files get
 * committed and shared, and this repo carried the scar of the alternative — a
 * checked-in hook shim with another machine's home directory baked into it. A
 * bare `graft` works on any machine that has it installed; `npx` remains the
 * fallback for machines that don't.
 */
const NPX_LAUNCH = { command: 'npx', args: ['-y', '@nanonets/graft', 'mcp'] };
const BIN_LAUNCH = { command: 'graft', args: ['mcp'] };
// The same server under trail's name, for a repo that uses trail: its tools are
// `trail_*` (and it still answers `graft_*`).
const TRAIL_NPX_LAUNCH = { command: 'npx', args: ['-y', '@trailhq/trail-code', 'mcp'] };
const TRAIL_BIN_LAUNCH = { command: 'trail', args: ['mcp'] };

function graftOnPath(): boolean {
  const r = spawnSync('graft', ['--version'], { stdio: 'ignore', timeout: 5000 });
  return r.status === 0;
}

/**
 * JSON hosts: `{ command, args }`.
 *
 * `GRAFT_MCP_NPX=1` forces the `npx` form — the escape hatch for a machine whose
 * global install is stale or shadowed, and what the tests set so their expectations
 * don't depend on whether the machine running them happens to have graft installed.
 * `opts.onPath` is the same override for direct unit tests of both branches.
 */
export function serverEntry(opts: { onPath?: boolean; brand?: 'graft' | 'trail' } = {}): { command: string; args: string[] } {
  const trail = opts.brand === 'trail';
  const forced = process.env.GRAFT_MCP_NPX;
  if (forced !== undefined && forced !== '' && forced !== '0' && forced !== 'false') return trail ? TRAIL_NPX_LAUNCH : NPX_LAUNCH;
  if (trail) return (opts.onPath ?? trailOnPath()) ? TRAIL_BIN_LAUNCH : TRAIL_NPX_LAUNCH;
  return (opts.onPath ?? graftOnPath()) ? BIN_LAUNCH : NPX_LAUNCH;
}


function opencodeEntry(name: Brand = 'graft'): object {
  const { command, args } = serverEntry({ brand: name });
  return { type: 'local', command: [command, ...args], enabled: true };
}

function dirExists(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/**
 * `key` is the server's name in the file (`graft`, or `trail` in a repo that
 * uses trail); `drop` names entries this write replaces, so a repo moving to
 * trail doesn't start the same server twice.
 */
export function mergeJsonKey(id: string, path: string, topKey: string, entry: object, key = 'graft', drop: string[] = []): McpWrite {
  const loaded = readJsonObject(path);
  if (loaded === 'unparseable') return { id, path, action: 'skipped-unparseable' };
  const { root, existed } = loaded;
  const bucket = (root[topKey] ??= {});
  if (typeof bucket !== 'object' || bucket === null || Array.isArray(bucket)) {
    return { id, path, action: 'skipped-unparseable' };
  }
  const dropping = drop.filter((k) => k in bucket);
  if (JSON.stringify(bucket[key]) === JSON.stringify(entry) && dropping.length === 0) return { id, path, action: 'unchanged' };
  const action = existed ? 'updated' : 'created';
  for (const k of dropping) delete bucket[k];
  bucket[key] = entry;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`);
  return { id, path, action };
}

/** The `[mcp_servers.graft]` (or `.trail`) table header, as written and as matched. */
function tomlHeader(name: Brand): string {
  return `[mcp_servers.${name}]`;
}

type TomlStringQuote = '"' | "'";

/** Carry multiline string context across lines without interpreting their text as tables. */
function nextTomlMultilineQuote(line: string, carried: TomlStringQuote | null): TomlStringQuote | null {
  let quote = carried;
  let multiline = carried !== null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote !== null) {
      if (quote === '"' && char === '\\') {
        i++; // Basic strings escape the next character; literal strings do not.
      } else if (char === quote) {
        if (!multiline) {
          quote = null;
        } else if (line.startsWith(quote.repeat(3), i)) {
          const closing = quote;
          quote = null;
          multiline = false;
          i += 2;
          // Four/five closing quotes include one/two literal quotes, not a new string.
          while (line[i + 1] === closing) i++;
        }
      }
    } else {
      if (char === '#') break;
      if (char === '"' || char === "'") {
        quote = char;
        multiline = line.startsWith(char.repeat(3), i);
        if (multiline) i += 2;
      }
    }
  }
  return multiline ? quote : null;
}

/**
 * Remove every canonical table owned by `name` from a TOML config, returning the rest.
 *
 * Line-based on purpose: a real parse-and-reserialize would reformat the user's
 * whole file. An owned table is `[mcp_servers.<name>]` itself or any dotted
 * subtable below it (`[mcp_servers.<name>.*]`, which TOML scopes under the
 * parent) — wherever it appears in the file, contiguous or not, and even when
 * the parent is gone and only an orphaned subtable remains. Anything else
 * starting a new table (`[mcp_servers.other]`, `[mcp_servers.graft2]`,
 * `[other.graft]`) is foreign and preserved. Exported so the writer and
 * `retract.ts` can never disagree about what "graft's section" means.
 */
export function stripTomlSection(text: string, name: Brand = 'graft'): { rest: string; found: boolean } {
  const lines = text.split(/(?<=\n)/);
  const ownedHeader = tomlHeader(name);
  // The trailing dot keeps similarly-named tables (`[mcp_servers.graft2]`,
  // `[other.graft]`) out of the family.
  const familyPrefix = `${ownedHeader.slice(0, -1)}.`;
  const isFamilyHeader = (line: string): boolean => {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('[')) return false;
    const header = trimmed.split(/\s+/)[0];
    return header === ownedHeader || header.startsWith(familyPrefix);
  };
  let multiline: TomlStringQuote | null = null;
  let found = false;
  let inOwned = false;
  const kept: string[] = [];
  for (const line of lines) {
    if (multiline === null && line.trimStart().startsWith('[')) {
      inOwned = isFamilyHeader(line);
      found ||= inOwned;
    }
    if (!inOwned) kept.push(line);
    multiline = nextTomlMultilineQuote(line, multiline);
  }
  if (!found) return { rest: text, found: false };
  // Interior blank lines can be multiline string data; preserve them verbatim.
  const rest = kept
    .join('')
    .replace(/^\n+/, '');
  return { rest, found: true };
}

/**
 * Register graft in a TOML config, replacing any section a previous version left.
 *
 * The old behaviour was to skip entirely once the header existed, which froze the
 * launch command at whatever the first init wrote: a repo wired when graft wasn't
 * on PATH kept the slow `npx` form forever, and no upgrade could correct it. Strip
 * and re-append instead, so this converges like every other writer — foreign
 * tables are untouched either way.
 */
function upsertCodexToml(id: string, path: string, name: Brand = 'graft'): McpWrite {
  const existed = existsSync(path);
  const text = existed ? readFileSync(path, 'utf8') : '';
  const { command, args } = serverEntry({ brand: name });
  const argList = args.map((a) => JSON.stringify(a)).join(", ");
  const section = `${tomlHeader(name)}\ncommand = \"${command}\"\nargs = [${argList}]\n`;

  const own = stripTomlSection(text, name);
  // Under trail, graft's table goes: the same server, listed once.
  const { rest, found: oldFound } = name === 'trail' ? stripTomlSection(own.rest, 'graft') : { rest: own.rest, found: false };
  const found = own.found && !oldFound;
  // Byte-identical already: don't rewrite the file just to reorder it.
  if (found && text === appendSection(rest, section)) return { id, path, action: 'unchanged' };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, appendSection(rest, section));
  return { id, path, action: existed ? 'updated' : 'created' };
}

/** Append a section after exactly one blank line, or at the top of an empty file. */
function appendSection(text: string, section: string): string {
  if (text.trim() === '') return section;
  const sep = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return `${text}${sep}${section}`;
}

function jsonTarget(
  hostId: string,
  id: string,
  path: string,
  topKey: string,
  entry: object,
  scope: PlannedWrite['scope'] = 'repo',
  key: Brand = 'graft',
): McpTarget {
  return { hostId, id, path, scope, kind: 'mcp', what: `${topKey}.${key}`, format: 'json', topKey, entry, key };
}

/**
 * The MCP config files selecting these hosts would touch — pure, no writes.
 * Codex's target is the user-level `~/.codex/config.toml`, so it is scoped
 * 'global': registering there affects every project on the machine.
 *
 * `name` is the repo's name for the tool: under trail the server is `trail`,
 * launched as `trail mcp` (or `npx -y @trailhq/trail-code mcp`). The files
 * are the same either way.
 */
export function mcpTargets(
  repo: string,
  ids: string[],
  opts: { home?: string; name?: Brand } = {},
): McpTarget[] {
  const home = opts.home ?? homedir();
  const name = opts.name ?? 'graft';
  const entry = serverEntry({ brand: name });
  const json = (hostId: string, id: string, path: string, topKey: string, e: object, scope: PlannedWrite['scope'] = 'repo') =>
    jsonTarget(hostId, id, path, topKey, e, scope, name);
  const out: McpTarget[] = [];
  for (const id of ids) {
    switch (id) {
      case 'cursor':
        out.push(json(id, id, join(repo, '.cursor', 'mcp.json'), 'mcpServers', entry));
        break;
      case 'gemini':
        out.push(json(id, id, join(repo, '.gemini', 'settings.json'), 'mcpServers', entry));
        break;
      case 'antigravity':
        // Antigravity reads MCP from its OWN registry, separate from Gemini CLI's
        // `.gemini/settings.json` — a global `~/.gemini/config/mcp_config.json` (the
        // gap #62 reported). Standard `{command,args}` under `mcpServers`. Global
        // scope: it applies to every workspace opened in Antigravity.
        out.push(
          json(id, 'antigravity', join(home, '.gemini', 'config', 'mcp_config.json'), 'mcpServers', entry, 'global'),
        );
        break;
      case 'kiro':
        out.push(json(id, id, join(repo, '.kiro', 'settings', 'mcp.json'), 'mcpServers', entry));
        break;
      case 'grok':
        // Grok reads MCP from repo-level `.grok/config.toml` (`[mcp_servers.<name>]`),
        // the same TOML shape Codex uses at ~/.codex/config.toml.
        out.push({
          hostId: id, id: 'grok', path: join(repo, '.grok', 'config.toml'),
          scope: 'repo', kind: 'mcp', what: tomlHeader(name), format: 'toml', key: name,
        });
        break;
      case 'agents':
        // Guarded on the CLI actually being installed, so a plan only ever
        // lists files a real run would touch.
        if (dirExists(join(home, '.codex'))) {
          out.push({
            hostId: id, id: 'codex', path: join(home, '.codex', 'config.toml'),
            scope: 'global', kind: 'mcp', what: tomlHeader(name), format: 'toml', key: name,
          });
        }
        if (dirExists(join(home, '.config', 'opencode'))) {
          out.push(json(id, 'opencode', join(repo, 'opencode.json'), 'mcp', opencodeEntry(name)));
        }
        break;
      default:
        break; // copilot / windsurf / adal: no MCP target in this phase
    }
  }
  return out;
}

/**
 * Whether a machine-wide config already runs the server under trail's name.
 * Every repo on the machine reads it, and `trail mcp` serves a repo still on
 * graft too, so a graft repo leaves it alone rather than list the server twice.
 */
function trailServerIn(t: McpTarget): boolean {
  if (t.format === 'toml') {
    try {
      return stripTomlSection(readFileSync(t.path, 'utf8'), 'trail').found;
    } catch {
      return false;
    }
  }
  const loaded = readJsonObject(t.path);
  const bucket = loaded === 'unparseable' ? undefined : loaded.root[t.topKey!];
  return typeof bucket === 'object' && bucket !== null && !Array.isArray(bucket) && 'trail' in bucket;
}

export function registerMcpConfigs(
  repo: string,
  ids: string[],
  opts: { home?: string; global?: boolean; name?: Brand } = {},
): McpWrite[] {
  const name = opts.name ?? 'graft';
  return mcpTargets(repo, ids, opts)
    .filter((t) => opts.global !== false || t.scope !== 'global')
    .map((t) => {
      if (name === 'graft' && t.scope === 'global' && trailServerIn(t)) return { id: t.id, path: t.path, action: 'unchanged' as const };
      return t.format === 'toml'
        ? upsertCodexToml(t.id, t.path, name)
        : mergeJsonKey(t.id, t.path, t.topKey!, t.entry!, name, name === 'trail' ? ['graft'] : []);
    });
}
