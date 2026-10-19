/**
 * Antigravity-specific global writes that don't fit the per-repo host model.
 *
 * Antigravity loads "shared" skills — available to every workspace — from
 * `~/.gemini/skills/`. graft's skill card is the same one Claude Code and AdaL get;
 * placing it here is the skill half of first-class Antigravity support (#62). The
 * instruction file (AGENTS.md) and MCP registration are handled by the `antigravity`
 * host in the registry and `mcp-config.ts` respectively.
 *
 * `antigravitySkillTargets()` is the pure "which files would this touch" half (for
 * `graft init --dry-run` / the picker); `installAntigravitySkill()` does the write.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { skillTemplate } from '../claude/skill-template.js';
import type { PlannedWrite } from './plan.js';
import type { ConfigWrite } from './config-write.js';
import type { Brand } from '../brand.js';

/** The skill file path, under the user's global Antigravity skills dir. */
function skillPath(home: string, name: Brand = 'graft'): string {
  return join(home, '.gemini', 'skills', name, 'SKILL.md');
}

/** The files installing Antigravity's global skill would touch — pure, no writes. */
export function antigravitySkillTargets(home: string, name: Brand = 'graft'): PlannedWrite[] {
  return [
    {
      hostId: 'antigravity', id: 'antigravity-skill',
      path: skillPath(home, name),
      scope: 'global', kind: 'skill', what: `${name} skill (shared)`,
    },
  ];
}

/**
 * Write the skill into `~/.gemini/skills/graft/SKILL.md`, idempotently; under
 * trail into `skills/trail/`, in trail's text, and graft's copy goes so the
 * agent doesn't load two. Every workspace reads this one, so once trail's is
 * there a repo still on graft leaves it, rather than add graft's back beside
 * it; trail's text says what to run when only graft is installed.
 */
export function installAntigravitySkill(home: string, name: Brand = 'graft'): ConfigWrite[] {
  if (name === 'graft' && existsSync(skillPath(home, 'trail'))) {
    return [{ id: 'antigravity-skill', path: skillPath(home, 'trail'), action: 'unchanged' }];
  }
  if (name === 'trail') {
    const old = skillPath(home, 'graft');
    rmSync(old, { force: true });
    try { rmdirSync(dirname(old)); } catch { /* not empty, or not there */ }
  }
  const path = skillPath(home, name);
  const content = skillTemplate(name);
  const existed = existsSync(path);
  if (existed && readFileSync(path, 'utf8') === content) {
    return [{ id: 'antigravity-skill', path, action: 'unchanged' }];
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return [{ id: 'antigravity-skill', path, action: existed ? 'updated' : 'created' }];
}
