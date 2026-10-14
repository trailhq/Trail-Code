/**
 * LSP server registry — maps graft language names to a language server command.
 * Only servers whose binary is actually on PATH are eligible; a missing binary
 * simply means that language gets no LSP enrichment (the AST graph stands alone).
 */
import { execSync } from "node:child_process";

export interface LspServer {
  /** graft language names (as produced by languageLabelOf/genericLangOf) this serves. */
  languages: string[];
  command: string;
  args: string[];
  /** the LSP `languageId` to tag opened documents with. */
  languageId: string;
}

/** First installed match per language wins; ordering is priority. */
export const LSP_SERVERS: readonly LspServer[] = [
  { languages: ["rust"], command: "rust-analyzer", args: [], languageId: "rust" },
  { languages: ["cpp", "c"], command: "clangd", args: ["--background-index"], languageId: "cpp" },
  { languages: ["go"], command: "gopls", args: [], languageId: "go" },
  { languages: ["python"], command: "pyright-langserver", args: ["--stdio"], languageId: "python" },
  { languages: ["typescript", "javascript", "tsx"], command: "typescript-language-server", args: ["--stdio"], languageId: "typescript" },
];

const resolved = new Map<string, string | null>();
/** Resolve a command to its ABSOLUTE path via the login shell's PATH. `spawn`
 * resolves against `process.env.PATH`, which often omits `~/.cargo/bin`,
 * `~/go/bin`, etc. where these servers live — so `command -v` can find a server
 * that `spawn(cmd)` then can't. Spawning the absolute path avoids that mismatch. */
function resolveCommand(cmd: string): string | null {
  if (resolved.has(cmd)) return resolved.get(cmd)!;
  let abs: string | null = null;
  try { abs = execSync(`command -v ${cmd}`, { encoding: "utf8" }).trim() || null; } catch { abs = null; }
  resolved.set(cmd, abs);
  return abs;
}

/** Pick servers for all covered languages, with absolute commands. Each language
 * is assigned once, and a server shared by several languages is started once. */
export function pickServers(languagesPresent: Set<string>): LspServer[] {
  const remaining = new Set(languagesPresent);
  const servers: LspServer[] = [];
  for (const s of LSP_SERVERS) {
    const languages = s.languages.filter((l) => remaining.has(l));
    if (!languages.length) continue;
    const abs = resolveCommand(s.command);
    if (!abs) continue;
    servers.push({ ...s, languages, command: abs });
    for (const language of languages) remaining.delete(language);
  }
  return servers;
}
