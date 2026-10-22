/**
 * Registry of AI coding hosts Graft can write instructions for.
 * Adding a host = adding one entry here (plus a renderer if it needs
 * a new file format).
 *
 * kind: 'section' → upsert the fenced block into a shared file the user owns.
 * kind: 'owned'   → graft owns the whole file; overwrite it each run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { instructionBody, cursorRule, kiroSteering, windsurfRule } from './instructions.js';
import { skillTemplate } from '../claude/skill-template.js';
import { markersFor } from './sections.js';
import { repoWiredForTrail, type Brand } from '../brand.js';

export interface DetectProbe {
  home: string;
  repo: string;
  dirExists(path: string): boolean;
}

export interface HostTarget {
  id: string;
  name: string;
  kind: 'section' | 'owned';
  /** Target file, relative to the repo root, under graft's names (see `hostRelPath`). */
  relPath: string;
  /** The text, in the spelling of the repo's name for the tool. */
  content(name?: Brand): string;
  detect(probe: DetectProbe): boolean;
}

export const HOSTS: HostTarget[] = [
  {
    id: 'agents',
    name: 'AGENTS.md hosts (Codex-style CLIs, editors that read AGENTS.md)',
    kind: 'section',
    relPath: 'AGENTS.md',
    content: instructionBody,
    detect: (p) =>
      p.dirExists(join(p.home, '.codex')) ||
      p.dirExists(join(p.home, '.config', 'opencode')) ||
      p.dirExists(join(p.home, '.config', 'agents')),
  },
  {
    id: 'adal',
    name: 'AdaL',
    kind: 'owned',
    relPath: join('.adal', 'skills', 'graft', 'SKILL.md'),
    content: skillTemplate,
    detect: (p) => p.dirExists(join(p.home, '.adal')) || p.dirExists(join(p.repo, '.adal')),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    kind: 'owned',
    relPath: join('.cursor', 'rules', 'graft.mdc'),
    content: cursorRule,
    detect: (p) => p.dirExists(join(p.home, '.cursor')) || p.dirExists(join(p.repo, '.cursor')),
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    kind: 'section',
    relPath: 'GEMINI.md',
    content: instructionBody,
    detect: (p) => p.dirExists(join(p.home, '.gemini')),
  },
  {
    id: 'grok',
    name: 'Grok (xAI)',
    kind: 'owned',
    relPath: join('.grok', 'skills', 'graft', 'SKILL.md'),
    content: skillTemplate,
    detect: (p) => p.dirExists(join(p.home, '.grok')) || p.dirExists(join(p.repo, '.grok')),
  },
  {
    id: 'hermes',
    name: 'Hermes Agent (Nous Research)',
    kind: 'section',
    relPath: 'AGENTS.md',
    content: instructionBody,
    // Hermes is repo-aware: it reads AGENTS.md at the repo root (and the
    // Graft-for-Hermes plugin keeps the graph fresh on every session start).
    detect: (p) =>
      p.dirExists(join(p.home, '.hermes')) ||
      p.dirExists(join(p.home, 'AppData', 'Local', 'hermes')) ||
      p.dirExists(join(p.repo, '.hermes')),
  },
  {
    id: 'antigravity',
    name: 'Google Antigravity',
    kind: 'section',
    relPath: 'AGENTS.md',
    content: instructionBody,
    // Antigravity-specific markers, NOT the bare `~/.gemini` (which is also Gemini CLI's):
    // its global config dir (`~/.gemini/config/`, where mcp_config.json + hooks.json live)
    // or a workspace `.agents/` dir. Keeps a plain Gemini-CLI user from auto-selecting it.
    detect: (p) =>
      p.dirExists(join(p.home, '.gemini', 'config')) ||
      p.dirExists(join(p.home, '.gemini', 'antigravity-cli')) ||
      p.dirExists(join(p.repo, '.agents')),
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    kind: 'section',
    relPath: join('.github', 'copilot-instructions.md'),
    content: instructionBody,
    detect: (p) => p.dirExists(join(p.repo, '.github')),
  },
  {
    id: 'kiro',
    name: 'Kiro',
    kind: 'owned',
    relPath: join('.kiro', 'steering', 'graft.md'),
    content: kiroSteering,
    detect: (p) => p.dirExists(join(p.home, '.kiro')) || p.dirExists(join(p.repo, '.kiro')),
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    kind: 'owned',
    relPath: join('.windsurf', 'rules', 'graft.md'),
    content: windsurfRule,
    detect: (p) => p.dirExists(join(p.home, '.codeium', 'windsurf')) || p.dirExists(join(p.repo, '.windsurf')),
  },
];

export function hostIds(): string[] {
  return HOSTS.map((h) => h.id);
}

export function detectHosts(probe: DetectProbe): HostTarget[] {
  return HOSTS.filter((h) => h.detect(probe));
}

/**
 * A host's file under `name`. A file the tool owns carries its name, like
 * Claude Code's skill and shims do (`.cursor/rules/trail.mdc`,
 * `.adal/skills/trail/SKILL.md`); a shared file is the same file either way.
 */
export function hostRelPath(host: HostTarget, name: Brand): string {
  return name === 'trail' && host.kind === 'owned' ? host.relPath.replace(/\bgraft\b/g, 'trail') : host.relPath;
}

/** Cursor's hooks shim is repo-local, so it carries the repo's name too. */
export function cursorHookShimRelPath(name: Brand): string {
  return join('.cursor', 'hooks', `${name}-hooks.cjs`);
}

/**
 * Whether another agent's files in `repo` are already under trail's names: a
 * trail-named file, or a shared file holding trail's block.
 */
export function hostsWiredForTrail(repo: string): boolean {
  if (existsSync(join(repo, cursorHookShimRelPath('trail')))) return true;
  const seen = new Set<string>();
  for (const host of HOSTS) {
    const path = join(repo, hostRelPath(host, 'trail'));
    if (seen.has(path)) continue;
    seen.add(path);
    if (host.kind === 'owned') {
      if (existsSync(path)) return true;
      continue;
    }
    try {
      if (readFileSync(path, 'utf8').includes(markersFor('trail').start)) return true;
    } catch {
      /* not there */
    }
  }
  return false;
}

/**
 * The name the other agents' wiring goes by in `repo`, decided the way Claude
 * Code's is (`wiringName` in claude/init.ts): trail's where `trail init` is
 * wiring it now (`initBrand`) or the repo is already on trail, graft's
 * everywhere else. Read from the repo, not the machine, so a teammate on
 * graft refreshing the files writes the same ones and never flips them back.
 */
export function hostWiringName(repo: string, initBrand?: Brand): Brand {
  return initBrand === 'trail' || repoWiredForTrail(repo) || hostsWiredForTrail(repo) ? 'trail' : 'graft';
}
