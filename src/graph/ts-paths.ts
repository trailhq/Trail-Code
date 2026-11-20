import { existsSync, readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { toPosixPath } from "../util/paths.js";

/** Compiled TypeScript path mappings. All stored paths are repo-relative and posix. */
export interface TsPathTarget {
  baseDir: string;
  prefix: string;
  suffix: string;
  wildcard: boolean;
}

export interface TsPathPattern {
  prefix: string;
  suffix: string;
  wildcard: boolean;
  targets: TsPathTarget[];
}

export interface TsPathConfig {
  /** Repo-relative directory that scopes this config to its importers. */
  dir: string;
  name: string;
  baseUrl?: string;
  patterns: TsPathPattern[];
}

const MAX_EXTENDS_DEPTH = 32;

interface ParsedConfig {
  extends?: string | string[];
  compilerOptions?: Record<string, unknown>;
}

interface EffectiveConfig {
  baseUrl?: string;
  paths?: TsPathPattern[];
}

/** `tsconfig.json`, `jsconfig.json` or `tsconfig.<name>.json`, by file name only.
 * String checks rather than one regex over the whole path: a path made of many
 * `/tsconfig.` segments made the regex backtrack polynomially (CodeQL). */
function isTsConfigFile(file: string): boolean {
  const name = file.slice(file.lastIndexOf("/") + 1);
  if (name === "tsconfig.json" || name === "jsconfig.json") return true;
  // `tsconfig.` + at least one character + `.json`
  return name.startsWith("tsconfig.") && name.endsWith(".json") && name.length > "tsconfig.".length + ".json".length;
}

/** Read and compile every visible TS config once for a build. `repoFiles` is the
 * same Git-ignore-aware walk used by graph extraction, so aliases never describe
 * a different repository view from the files that can become graph nodes. Config
 * `include` and `exclude` are deliberately ignored; graph membership comes from
 * graft's file walk, not the TypeScript program's compilation boundary. */
export function readTsAliases(root: string, repoFiles: string[]): TsPathConfig[] {
  const rootAbs = toPosixPath(resolve(root));
  const parsed = new Map<string, ParsedConfig | null>();
  const configs: TsPathConfig[] = [];
  const configFiles = repoFiles
    .map(toPosixPath)
    .filter(isTsConfigFile)
    .sort(comparePath);

  for (const file of configFiles) {
    const abs = posix.normalize(file);
    const effective = readEffectiveConfig(abs, rootAbs, parsed, new Set(), 0);
    if (!effective.baseUrl && !effective.paths?.length) continue;
    const relDir = posix.relative(rootAbs, posix.dirname(abs));
    configs.push({
      dir: relDir === "." ? "" : relDir,
      name: posix.basename(abs),
      ...(effective.baseUrl ? { baseUrl: posix.relative(rootAbs, effective.baseUrl) || "." } : {}),
      patterns: effective.paths ?? [],
    });
  }

  configs.sort((a, b) => {
    const depth = pathDepth(b.dir) - pathDepth(a.dir);
    if (depth !== 0) return depth;
    if (a.dir !== b.dir) return comparePath(a.dir, b.dir);
    if (a.name === "tsconfig.json") return b.name === "tsconfig.json" ? 0 : -1;
    if (b.name === "tsconfig.json") return 1;
    return comparePath(a.name, b.name);
  });
  return configs;
}

/** Resolve one bare specifier through the nearest in-scope config that lands on
 * an indexed file. `findFile` uses resolveEdges' in-memory node map, never disk. */
export function resolveTsAlias(
  specifier: string,
  importer: string,
  configs: TsPathConfig[] | undefined,
  findFile: (candidate: string) => string | null,
): string | null {
  if (!configs?.length) return null;
  const file = posix.normalize(toPosixPath(importer));
  for (const config of configs) {
    if (config.dir && file !== config.dir && !file.startsWith(`${config.dir}/`)) continue;

    const pattern = config.patterns.find((candidate) => matchPattern(candidate, specifier) !== null);
    if (pattern) {
      const capture = matchPattern(pattern, specifier)!;
      for (const target of pattern.targets) {
        const expanded = target.prefix + (target.wildcard ? capture : "") + target.suffix;
        const hit = findFile(posix.normalize(posix.join(target.baseDir, expanded)));
        if (hit) return hit;
      }
      // A matching paths key owns this lookup, even when none of its targets exists.
      continue;
    }

    if (config.baseUrl) {
      const hit = findFile(posix.normalize(posix.join(config.baseUrl, specifier)));
      if (hit) return hit;
    }
  }
  return null;
}

function readEffectiveConfig(
  file: string,
  root: string,
  parsed: Map<string, ParsedConfig | null>,
  active: Set<string>,
  depth: number,
): EffectiveConfig {
  const abs = posix.normalize(file);
  const local = readParsedConfig(abs, parsed);
  if (!local || active.has(abs)) return {};

  active.add(abs);
  try {
    const effective: EffectiveConfig = {};
    if (depth < MAX_EXTENDS_DEPTH) {
      const parents = typeof local.extends === "string"
        ? [local.extends]
        : Array.isArray(local.extends)
          ? local.extends.filter((value): value is string => typeof value === "string")
          : [];
      for (const parentRef of parents) {
        const parent = resolveRelativeExtends(abs, parentRef);
        if (!parent || active.has(parent)) continue;
        const inherited = readEffectiveConfig(parent, root, parsed, active, depth + 1);
        if (inherited.baseUrl !== undefined) effective.baseUrl = inherited.baseUrl;
        if (inherited.paths !== undefined) effective.paths = inherited.paths;
      }
    }

    const options = local.compilerOptions;
    if (!options) return effective;
    if (typeof options.baseUrl === "string") {
      effective.baseUrl = resolveConfigPath(posix.dirname(abs), options.baseUrl);
    }
    if (Object.prototype.hasOwnProperty.call(options, "paths")) {
      const base = effective.baseUrl ?? posix.dirname(abs);
      effective.paths = compilePaths(options.paths, base, root);
    }
    return effective;
  } finally {
    active.delete(abs);
  }
}

function readParsedConfig(file: string, cache: Map<string, ParsedConfig | null>): ParsedConfig | null {
  if (cache.has(file)) return cache.get(file) ?? null;
  let value: ParsedConfig | null = null;
  try {
    const parsed: unknown = JSON.parse(stripJsonCommentsAndTrailingCommas(readFileSync(file, "utf8")));
    if (isRecord(parsed)) {
      value = {
        ...(typeof parsed.extends === "string" || Array.isArray(parsed.extends) ? { extends: parsed.extends as string | string[] } : {}),
        ...(isRecord(parsed.compilerOptions) ? { compilerOptions: parsed.compilerOptions } : {}),
      };
    }
  } catch {
    /* unreadable or invalid JSONC — ignore this config */
  }
  cache.set(file, value);
  return value;
}

function resolveRelativeExtends(config: string, value: string): string | null {
  if (!value.startsWith(".")) return null; // package configs live outside the repo's path mapping
  const base = resolveConfigPath(posix.dirname(config), value);
  const candidates = value.endsWith(".json")
    ? [base]
    : [`${base}.json`, posix.join(base, "tsconfig.json")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveConfigPath(base: string, path: string): string {
  const normalized = toPosixPath(path);
  if (posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) return posix.normalize(normalized);
  return posix.normalize(posix.join(base, normalized));
}

function compilePaths(value: unknown, base: string, root: string): TsPathPattern[] {
  if (!isRecord(value)) return [];
  const patterns: TsPathPattern[] = [];
  for (const [key, rawTargets] of Object.entries(value)) {
    const keyStar = key.indexOf("*");
    if (keyStar !== key.lastIndexOf("*")) continue;
    const wildcard = keyStar >= 0;
    const prefix = wildcard ? key.slice(0, keyStar) : key;
    const suffix = wildcard ? key.slice(keyStar + 1) : "";
    if (!Array.isArray(rawTargets)) continue;
    const targets: TsPathTarget[] = [];
    for (const raw of rawTargets) {
      if (typeof raw !== "string") continue;
      const star = raw.indexOf("*");
      if (star !== raw.lastIndexOf("*") || (star >= 0 && !wildcard)) continue;
      const targetBase = posix.relative(root, base) || ".";
      targets.push({
        baseDir: targetBase,
        prefix: star >= 0 ? raw.slice(0, star) : raw,
        suffix: star >= 0 ? raw.slice(star + 1) : "",
        wildcard: star >= 0,
      });
    }
    patterns.push({ prefix, suffix, wildcard, targets });
  }
  patterns.sort((a, b) => b.prefix.length - a.prefix.length);
  return patterns;
}

function matchPattern(pattern: TsPathPattern, specifier: string): string | null {
  if (!pattern.wildcard) return specifier === pattern.prefix ? "" : null;
  if (!specifier.startsWith(pattern.prefix) || !specifier.endsWith(pattern.suffix)) return null;
  const end = specifier.length - pattern.suffix.length;
  if (end < pattern.prefix.length) return null;
  return specifier.slice(pattern.prefix.length, end);
}

/** JSONC comments and trailing commas are removed only outside quoted strings. */
function stripJsonCommentsAndTrailingCommas(source: string): string {
  const uncommented: string[] = [];
  let inString = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (inString) {
      uncommented.push(char);
      if (char === "\\" && i + 1 < source.length) uncommented.push(source[++i]);
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      uncommented.push(char);
    } else if (char === "/" && source[i + 1] === "/") {
      uncommented.push("  ");
      i += 2;
      while (i < source.length && source[i] !== "\n" && source[i] !== "\r") {
        uncommented.push(" ");
        i++;
      }
      if (i < source.length) uncommented.push(source[i]);
    } else if (char === "/" && source[i + 1] === "*") {
      uncommented.push("  ");
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        uncommented.push(source[i] === "\n" || source[i] === "\r" ? source[i] : " ");
        i++;
      }
      if (i < source.length) {
        uncommented.push("  ");
        i++;
      }
    } else {
      uncommented.push(char);
    }
  }

  const input = uncommented.join("");
  const output: string[] = [];
  inString = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (inString) {
      output.push(char);
      if (char === "\\" && i + 1 < input.length) output.push(input[++i]);
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      output.push(char);
    } else if (char === ",") {
      let next = i + 1;
      while (next < input.length && /\s/.test(input[next])) next++;
      if (input[next] !== "}" && input[next] !== "]") output.push(char);
    } else {
      output.push(char);
    }
  }
  return output.join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pathDepth(path: string): number {
  return path ? path.split("/").length : 0;
}

function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
