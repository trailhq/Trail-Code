/**
 * D116 item 2: the hook-script guard blocks running Trail's hook script by
 * hand, never reading it. An agent looking into Trail's wiring greps, seds,
 * cats, pages or heads `.claude/helpers/trail-hooks.cjs`; that is a read.
 * Running it stays denied whatever runs it: node, a shell, `./`, xargs, a
 * substitution, npx, an env prefix, or a read piped into one of them.
 * Made-up repos and paths only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentGuard } from '../src/skills/risk.js';
import { preBashSkills } from '../src/claude/pre-bash-skills.js';
import { tamperOf } from '../src/trace/tamper.js';

const ENV = { HOME: '/tmp/hook-read-home', TRAIL_HOME: '/tmp/hook-read-home/.trail' };
const input = (command: string) => ({ session_id: 'sess-hook-read', tool_name: 'Bash', tool_input: { command } });
const CTX = { trailHome: '/home/dev/.trail', transcriptPath: '/home/dev/.claude/projects/-home-dev-shop/s.jsonl', home: '/home/dev', folder: '/home/dev/shop' };
const H = '.claude/helpers/trail-hooks.cjs';

const READS = [
  // The lab's two reads (H2, H4), in synthetic form.
  `grep -n "skillsGate\\|preBash" ${H}`,
  `sed -n '1,400p' ${H} | grep -n "prompt"`,
  `cat ${H}`,
  `less ${H}`,
  `head -40 ${H}`,
  `tail -n 20 ${H} | wc -l`,
  `wc -l ${H} /home/dev/shop/.claude/helpers/graft-hooks.cjs`,
  `cd /home/dev/shop && grep -c main ${H}`,
  `grep "skills on" .claude/trail-hooks.cjs`,
  `cat .claude/helpers/* | grep -n require`,
  `rg -n "stop" ${H} > /dev/null && echo found`,
  `git log --oneline -- ${H}`,
  `git diff -- ${H}`,
];

const RUNS = [
  `node ${H} stop < payload.json`,
  `sh ${H} prompt`,
  `bash ${H} session-start`,
  `./${H} prompt`,
  `echo ${H} | xargs node`,
  `ls ${H} | xargs -I{} node {} stop`,
  `node -e "$(cat ${H})"`,
  `$(cat ${H}) stop`,
  `npx node ${H} stop`,
  `env CLAUDE_PROJECT_DIR=/home/dev/shop node ${H} stop`,
  `FOO=1 node ${H} stop`,
  `cat ${H} | node - stop`,
  `cat ${H} | sh`,
  `head -100 ${H} > /tmp/h.cjs`,
  `cat .claude/helpers/* > /tmp/h.cjs`,
  `grep -n x $(node ${H} stop)`,
  `less '+!node ${H} stop' README.md`,
  `head -1 ${H}; node ${H} stop`,
  `sed -i 's/a/b/' ${H}`,
  `rg --pre node stop ${H}`,
  `find .claude -name trail-hooks.cjs -exec node {} stop \\;`,
  `cat <(node ${H} stop)`,
];

test('reading the hook script (grep, sed, cat, less, head, tail, wc, git log) is not running it: no deny, no tamper mark', async () => {
  for (const cmd of READS) {
    assert.equal(agentGuard(cmd), null, cmd);
    const d = await preBashSkills(input(cmd), '/tmp', ENV, cmd);
    assert.notEqual(d?.permissionDecision, 'deny', cmd);
    assert.equal(tamperOf('Bash', { command: cmd }, cmd, CTX), null, cmd);
  }
});

test('running the hook script stays denied, through node, a shell, ./, xargs, a substitution, npx, env, a pipe or a copy', async () => {
  for (const cmd of RUNS) {
    assert.equal(agentGuard(cmd)?.hit, 'hook-script', cmd);
    const d = await preBashSkills(input(cmd), '/tmp', ENV, cmd);
    assert.equal(d?.permissionDecision, 'deny', cmd);
    assert.match(tamperOf('Bash', { command: cmd }, cmd, CTX) ?? '', /^Bash /, cmd);
  }
});

// fix-lab5: the 1b lab's hook replay found 11 commands in Trail's own development that only mention a hook script:
// a python heredoc that edits source naming the shim, `cat >> notes <<EOF` prose, a hooks.json written from a heredoc.
// Also deleting a stale copy, a syntax check, an existence test and git bookkeeping. None of them runs it.
const MENTIONS = [
  `python3 - <<'EOF'\nfrom pathlib import Path\nimport subprocess\nroot = Path('/tmp/report')\nroot.mkdir(parents=True, exist_ok=True)\np = Path('/tmp/source')\n(root / p.name).write_bytes(p.read_bytes())\nr = subprocess.run(['git', 'diff', '--binary', '--', '${H}'], cwd=worktree, capture_output=True, check=True)\n(root / 'diff.patch').write_bytes(r.stdout)\n(root / 'report.md').write_text('''Report mentions subprocess.run() and os.execlp(), but runs neither here.''')\nprint(root, len(r.stdout))\nEOF`,
  `python3 - <<'EOF'\nimport subprocess\nr = subprocess.run(['git', 'diff', '--binary', '--', '${H}', 'AGENTS.md'], cwd=worktree, capture_output=True, check=True)\nEOF`,
  `python3 -c "import subprocess; subprocess.check_output(['git', 'diff', '--', '${H}'])"`,
  `python3 - <<'EOF'\nimport subprocess\nsubprocess.run([\"/usr/bin/git\", \"diff\", \"--no-ext-diff\", \"--no-textconv\", \"--\", \"${H}\"], text=True, stdout=subprocess.PIPE)\nEOF`,
  `git diff -- ${H}`,
  `ls -la ${H}`,
  'rm -f /tmp/x/box/.claude/helpers/trail-hooks.cjs',
  'rm -rf /tmp/x/box/.claude/helpers/graft-hooks.cjs /tmp/x/box/.claude/helpers/graft-statusline.cjs',
  `node --check ${H}`,
  `node -c ${H} && echo ok`,
  `test -f ${H} && echo wired`,
  `[ -e ${H} ] || echo missing`,
  `git add ${H} src/claude/shim-template.ts`,
  `git checkout -- ${H}`,
  'git commit -q -m "docs: say trail-hooks.cjs fails open"',
  `cd /home/dev/trail && python3 - <<'EOF'\np='src/claude/hook-owner.ts'\ns=open(p).read()\ns=s.replace("if (!existsSync(join(dir, '.claude', 'helpers', 'graft-hooks.cjs'))) return false;", "if (!shimThere(dir)) return false;")\nopen(p,'w').write(s)\nEOF`,
  `python3 -I - <<'EOF'\np='test/hook-owner.test.ts'\ns=open(p).read()\ns=s.replace("writeFileSync(join(repo, '.claude', 'helpers', 'graft-hooks.cjs'), '// shim')", "writeShim(repo)")\nopen(p,'w').write(s)\nEOF`,
  `cat >> docs/notes.md <<'EOF'\n- The hook-script guard blocks running trail-hooks.cjs, never reading it.\nEOF`,
  `cat > hooks/hooks.json <<'EOF'\n{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"node \\"\${PLUGIN_ROOT}/scripts/hook.cjs\\" stop"}]}]}}\nEOF`,
  `node -e 'const s = require(process.argv[1]); console.log(Object.keys(s.hooks))' .claude/settings.json`,
  `cat >> test/settings-merge.test.ts <<'EOF'\nconst entry = { command: \`node "\${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/graft-hooks.cjs" stop\` };\nEOF`,
];

const STILL_RUNS = [
  `python3 - <<'EOF'\nimport subprocess\nr = subprocess.run(['git', 'diff', '--', '${H}'])\nprint: object = subprocess.os.execlp\nprint('node', 'node', r.args[3], 'stop')\nEOF`,
  `python3 - <<'EOF'\nimport subprocess\nr = subprocess.run(['git', 'diff', '--', '${H}'])\nprint, unused = subprocess.os.execlp, None\nprint('node', 'node', r.args[3], 'stop')\nEOF`,
  `python3 - <<'EOF'\nimport subprocess\nr = subprocess.run(['git', 'diff', '--', '${H}'])\nPath: object = subprocess.os.execlp\nPath('node', 'node', r.args[3], 'stop')\nEOF`,
  `python3 - <<'EOF'\nimport subprocess\nr = subprocess.run(['git', 'diff', '--', '${H}'])\np.write_text: object = subprocess.os.execlp\np.write_text('node', 'node', r.args[3], 'stop')\nEOF`,
  `python3 - <<'EOF'\nimport subprocess\nr = subprocess.run(['git', 'diff', '--', '${H}'])\np.__dict__['write_text'] = subprocess.os.execlp\np.write_text('node', 'node', r.args[3], 'stop')\nEOF`,
  `python3 - <<'EOF'\nimport subprocess\nimport os\nr = subprocess.run(['git', 'diff', '--', '${H}'])\nos.execlp('node', 'node', r.args[3], 'stop')\nEOF`,
  `python3 - <<'EOF'\nimport subprocess\nr = subprocess.run(['git', 'diff', '--', '${H}'])\nsubprocess.os.posix_spawnp('node', ['node', r.args[3], 'stop'], {})\nEOF`,
  `python3 - <<'EOF'\nimport subprocess\nr = subprocess.run(['git', 'diff', '--', '${H}'])\ngetattr(subprocess.os, 'execlp')('node', 'node', r.args[3], 'stop')\nEOF`,
  `python3 - <<'EOF'\nimport subprocess\nr = subprocess.run(['git', 'diff', '--', '${H}'])\nprint(f"{subprocess.os.execlp('node', 'node', r.args[3], 'stop')}")\nEOF`,
  `python3 - <<'EOF'\nimport subprocess\nr = subprocess.run(['git', 'diff', '--', '${H}'])\nprint = subprocess.os.execlp\nprint('node', 'node', r.args[3], 'stop')\nEOF`,
  `python3 - <<'EOF'\nimport subprocess\nr = subprocess.run(['git', 'diff', '--', '${H}'])\nclass Run:\n def write_text(self):\n  pass\nRun().write_text()\nEOF`,
  `python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['node', subprocess.run(['git', 'diff', '--', '${H}']).args[3], 'stop'])\nEOF`,
  `python3 - <<'EOF'\nimport subprocess\nr = subprocess.run(['git', 'diff', '--', '${H}'])\nsubprocess.run(['node', r.args[3], 'stop'])\nEOF`,
  `python3 - <<'EOF'\nimport subprocess\nr = subprocess.run(['git', 'diff', '--', '${H}'], capture_output=True)\nexec(r.stdout)\nEOF`,
  `python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['git', 'diff', '--', '${H}'], shell=True)\nEOF`,
  `python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['git', 'diff', '--', '${H}'], executable='node')\nEOF`,
  `python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['git', 'diff', '--', '${H}'], preexec_fn=run_hook)\nEOF`,
  `python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['git', 'diff', '--', '${H}'], env=custom_env)\nEOF`,
  `python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['git', 'diff', '--', '${H}'])\nsubprocess.run(['node', '${H}', 'stop'])\nEOF`,
  `python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['git', '-c', 'alias.diff=!node ${H}', 'diff', '--', '${H}'])\nEOF`,
  `python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['git', 'diff', '--', '${H}'] + extra)\nEOF`,
  `python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['node', '.claude/helpers/trail-hooks.cjs', 'stop'])\nEOF`,
  `python3 -c "import os; os.system('node .claude/helpers/trail-hooks.cjs stop')"`,
  `node -e "require('./.claude/helpers/trail-hooks.cjs')"`,
  `node - <<'EOF'\nrequire('child_process').execFileSync(process.execPath, ['.claude/helpers/graft-hooks.cjs', 'prompt'])\nEOF`,
  `node -r ./.claude/helpers/trail-hooks.cjs app.js`,
  `cat > ${H} <<'EOF'\n// mine now\nEOF`,
  `rm -f ${H}.bak && node ${H} stop`,
  `node --check ${H} && node ${H} stop`,
  `rm -f $(node ${H} stop)`,
  `test -f ${H} && sh ${H} prompt`,
  `H=${H}; node $H stop`,
  `git add ${H} && git commit -m x && node ${H} stop`,
  `cat > /tmp/x/run.sh <<'EOF'\nnode .claude/helpers/trail-hooks.cjs stop\nEOF\nsh /tmp/x/run.sh`,
  `tee /tmp/x/run.cjs <<'EOF'\nrequire('/home/dev/shop/.claude/helpers/trail-hooks.cjs')\nEOF`,
];

test('a command that only mentions a hook script (edits other files, deletes a stale copy, checks it) is not denied (fix-lab5)', async () => {
  for (const cmd of MENTIONS) {
    assert.equal(agentGuard(cmd), null, cmd);
    const d = await preBashSkills(input(cmd), '/tmp', ENV, cmd);
    assert.notEqual(d?.permissionDecision, 'deny', cmd);
  }
});

test('running it stays denied, also from code an interpreter is given, a heredoc into the hook, or a chain after a mention', async () => {
  for (const cmd of STILL_RUNS) {
    assert.equal(agentGuard(cmd)?.hit, 'hook-script', cmd);
    const d = await preBashSkills(input(cmd), '/tmp', ENV, cmd);
    assert.equal(d?.permissionDecision, 'deny', cmd);
  }
});
