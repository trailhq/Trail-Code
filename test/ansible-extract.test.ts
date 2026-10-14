/**
 * The Ansible tier: YAML whose meaning is in its key names.
 *
 * Two things are load-bearing here and each has a failure mode that is worse
 * than not indexing at all.
 *
 * DETECTION. `.yml` is the most overloaded extension in a modern repo, so a
 * false accept does not merely add a wrong node — it inflates every coverage
 * number graft reports and buries the real Ansible in noise. The negative cases
 * below are therefore not an afterthought: a mapping-rooted data file that
 * happens to contain a `- name:` list is the exact shape that broke the first
 * implementation, and `nested sequence` pins it.
 *
 * SPANS. Same rule as the container tier: a `file:line` that is plausible but
 * wrong sends the reader somewhere else with full confidence. Every fixture is
 * an array of lines joined, so an expected line number is its index + 1 and can
 * be read off the source instead of counted by hand.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  warmAnsibleGrammar,
  extractAnsible,
  ansibleClaims,
  ansibleExtensions,
  isAnsibleWarm,
} from "../src/graph/ansible.js";
import { supportedExtensions } from "../src/graph/source-files.js";
import { buildGraph } from "../src/graph/build.js";
import { checkGraph } from "../src/graph/check.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { NodeV1 } from "../src/graph/types.js";

await warmAnsibleGrammar();

/** Line N of the fixture is `lines[N - 1]` — that is the whole point. */
function yml(lines: string[]): string {
  return lines.join("\n") + "\n";
}

function names(nodes: { name: string }[]): string[] {
  return nodes.map((n) => n.name);
}

function byName(nodes: NodeV1[], name: string): NodeV1 {
  const hit = nodes.find((n) => n.name === name);
  assert.ok(hit, `no node named ${name} — got ${JSON.stringify(names(nodes))}`);
  return hit!;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("the tier is warm and claims the yaml extensions", () => {
  assert.equal(isAnsibleWarm(), true, "the bundled yaml grammar should load");
  assert.deepEqual(ansibleExtensions().sort(), [".yaml", ".yml"]);
  assert.equal(ansibleClaims("playbooks/site.yml"), true);
  assert.equal(ansibleClaims("env/lab/hosts.YAML"), true);
  assert.equal(ansibleClaims("src/main.py"), false);
});

test("supportedExtensions advertises yaml, so `-e` and the walker agree", () => {
  const exts = supportedExtensions();
  assert.ok(exts.includes(".yml"), ".yml must be walkable");
  assert.ok(exts.includes(".yaml"), ".yaml must be walkable");
});

// ---------------------------------------------------------------------------
// Detection — the negative cases first, because they are the risk
// ---------------------------------------------------------------------------

test("declines a Kubernetes manifest", () => {
  const src = yml(["apiVersion: apps/v1", "kind: Deployment", "metadata:", "  name: web"]);
  assert.deepEqual(extractAnsible("k8s/deploy.yaml", src).nodes, []);
});

test("declines a docker-compose file", () => {
  const src = yml(["version: '3'", "services:", "  web:", "    image: nginx"]);
  assert.deepEqual(extractAnsible("docker-compose.yml", src).nodes, []);
});

test("declines a GitHub Actions workflow", () => {
  const src = yml(["on:", "  push:", "jobs:", "  build:", "    steps:", "      - name: checkout", "        uses: actions/checkout@v4"]);
  assert.deepEqual(extractAnsible(".github/workflows/ci.yml", src).nodes, []);
});

test("declines a mapping-rooted data file whose value is a `- name:` sequence", () => {
  // The regression that motivated the strict unwrap: this is a MAPPING at the
  // document root. A recursive search for a sequence finds the inner one and
  // reads the file as a tasks file, which is how eight config files in a real
  // repo were misdetected.
  const src = yml([
    "aggregates:",
    "  - name: san-hosts",
    "    metadata:",
    "      storage: san",
    "  - name: local-hosts",
    "    metadata:",
    "      storage: local",
  ]);
  assert.deepEqual(extractAnsible("config/placement.yaml", src).nodes, []);
});

test("declines a plain list of named things with no module key", () => {
  const src = yml(["- name: alice", "  description: an admin", "- name: bob", "  description: a user"]);
  assert.deepEqual(extractAnsible("data/people.yaml", src).nodes, []);
});

test("a declined file contributes NO file node, not an empty one", () => {
  const src = yml(["apiVersion: v1", "kind: ConfigMap"]);
  const { nodes, rawEdges } = extractAnsible("k8s/cm.yaml", src);
  assert.equal(nodes.length, 0, "a non-Ansible file must be invisible, not an empty shell");
  assert.equal(rawEdges.length, 0);
});

// ---------------------------------------------------------------------------
// Playbooks
// ---------------------------------------------------------------------------

const PLAYBOOK = yml([
  /*  1 */ "---",
  /*  2 */ "# A comment block, because real playbooks open with one and `comment`",
  /*  3 */ "# is a NAMED node that sits before the content it describes.",
  /*  4 */ "- name: configure the computes",
  /*  5 */ "  hosts: computes",
  /*  6 */ "  become: true",
  /*  7 */ "  vars:",
  /*  8 */ "    pkg_state: present",
  /*  9 */ "  roles:",
  /* 10 */ "    - common",
  /* 11 */ "  tasks:",
  /* 12 */ "    - name: install nginx",
  /* 13 */ "      ansible.builtin.apt:",
  /* 14 */ "        name: nginx",
  /* 15 */ "        state: present",
  /* 16 */ "      notify: restart nginx",
  /* 17 */ "    - name: pull in the storage tasks",
  /* 18 */ "      include_tasks: storage.yml",
  /* 19 */ "  handlers:",
  /* 20 */ "    - name: restart nginx",
  /* 21 */ "      ansible.builtin.service:",
  /* 22 */ "        name: nginx",
  /* 23 */ "        state: restarted",
]);

test("a play becomes a class carrying its hosts, on the right line", () => {
  const { nodes } = extractAnsible("playbooks/site.yml", PLAYBOOK);
  const play = byName(nodes, "configure the computes");
  assert.equal(play.kind, "class");
  assert.equal(play.signature, "hosts: computes");
  assert.equal(play.span, "L4-L23", "the play spans from its `- name:` to the last handler line");
});

test("a task becomes a function whose signature is its MODULE, not its name key", () => {
  const { nodes } = extractAnsible("playbooks/site.yml", PLAYBOOK);
  const task = byName(nodes, "install nginx");
  assert.equal(task.kind, "function");
  assert.equal(task.span, "L12-L16");
  assert.equal(task.signature, "ansible.builtin.apt", "`name` must never be read as the module");
});

test("comments before the document body do not defeat detection", () => {
  // Three comment lines precede the sequence. An unwrap that takes the first
  // named child of `document` takes a comment and concludes "not a sequence".
  const { nodes } = extractAnsible("playbooks/site.yml", PLAYBOOK);
  assert.ok(nodes.length > 1, "a commented playbook must still extract");
});

test("play vars become variable nodes on their own lines", () => {
  const { nodes } = extractAnsible("playbooks/site.yml", PLAYBOOK);
  const v = byName(nodes, "pkg_state");
  assert.equal(v.kind, "variable");
  assert.equal(v.span, "L8-L8");
});

test("notify, roles and include_tasks each emit the edge that names them", () => {
  const { nodes, rawEdges } = extractAnsible("playbooks/site.yml", PLAYBOOK);
  const task = byName(nodes, "install nginx");
  const includer = byName(nodes, "pull in the storage tasks");
  const play = byName(nodes, "configure the computes");

  const notify = rawEdges.find((e) => e.relation === "calls" && e.name === "restart nginx");
  assert.ok(notify, "notify: must emit a calls edge");
  assert.equal(notify!.source, task.id);

  const role = rawEdges.find((e) => e.relation === "calls" && e.name === "common");
  assert.ok(role, "roles: must emit a calls edge");
  assert.equal(role!.source, play.id);
  assert.deepEqual(role!.kinds, ["module"], "a role resolves to a module, not a function");

  const inc = rawEdges.find((e) => e.relation === "imports");
  assert.ok(inc, "include_tasks: must emit an imports edge");
  assert.equal(inc!.specifier, "./storage.yml", "file-relative so resolveImport settles it");
  assert.equal(inc!.source, includer.id);
});

test("a templated target is not guessed at", () => {
  const src = yml([
    "- hosts: all",
    "  tasks:",
    "    - name: dynamic",
    "      include_tasks: '{{ step }}.yml'",
    "      notify: '{{ handler_name }}'",
  ]);
  const { rawEdges } = extractAnsible("playbooks/dyn.yml", src);
  assert.equal(
    rawEdges.filter((e) => e.relation !== "contains").length,
    0,
    "a `{{ }}` target is unknowable statically and must not become an edge",
  );
});

// ---------------------------------------------------------------------------
// Roles, handlers, blocks
// ---------------------------------------------------------------------------

test("a role's tasks/main.yml mints the role itself, and its tasks hang off it", () => {
  const src = yml([
    "- name: install the base packages",
    "  ansible.builtin.package:",
    "    name: curl",
  ]);
  const { nodes, rawEdges } = extractAnsible("roles/common/tasks/main.yml", src);
  const role = byName(nodes, "common");
  assert.equal(role.kind, "module");
  assert.equal(role.signature, "role common");

  const roleId = role.id;
  const task = byName(nodes, "install the base packages");
  const contains = rawEdges.find(
    (e) => e.relation === "contains" && e.targetId === task.id,
  );
  assert.equal(contains!.source, roleId, "tasks belong to the role, not directly to the file");
});

test("a tasks file outside a role has no role node", () => {
  const src = yml(["- name: a task", "  ansible.builtin.command: true"]);
  const { nodes } = extractAnsible("playbooks/tasks/extra.yml", src);
  assert.equal(nodes.filter((n) => n.kind === "module").length, 0);
});

test("block / rescue / always nest their tasks under the enclosing task", () => {
  const src = yml([
    "- name: guarded",
    "  block:",
    "    - name: try it",
    "      ansible.builtin.command: /bin/true",
    "  rescue:",
    "    - name: clean up",
    "      ansible.builtin.command: /bin/false",
  ]);
  const { nodes, rawEdges } = extractAnsible("playbooks/tasks/b.yml", src);
  const outer = byName(nodes, "guarded");
  for (const child of ["try it", "clean up"]) {
    const c = byName(nodes, child);
    const edge = rawEdges.find((e) => e.relation === "contains" && e.targetId === c.id);
    assert.equal(edge!.source, outer.id, `${child} must nest under the block's task`);
  }
  assert.equal(byName(nodes, "try it").span, "L3-L4");
  assert.equal(byName(nodes, "clean up").span, "L6-L7");
});

test("set_fact keys become variables owned by the task that sets them", () => {
  const src = yml([
    "- name: compute a fact",
    "  set_fact:",
    "    lv_size: 110G",
  ]);
  const { nodes, rawEdges } = extractAnsible("playbooks/tasks/f.yml", src);
  const v = byName(nodes, "lv_size");
  assert.equal(v.kind, "variable");
  assert.equal(v.span, "L3-L3");
  const owner = byName(nodes, "compute a fact");
  const edge = rawEdges.find((e) => e.relation === "contains" && e.targetId === v.id);
  assert.equal(edge!.source, owner.id);
});

test("a vars file is admitted only from a path Ansible gives meaning to", () => {
  const src = yml(["ntp_server: 10.0.0.1", "dns_server: 10.0.0.2"]);
  assert.equal(extractAnsible("group_vars/all.yml", src).nodes.length, 3, "file + two vars");
  assert.equal(extractAnsible("roles/common/defaults/main.yml", src).nodes.length, 3);
  assert.deepEqual(extractAnsible("config/settings.yml", src).nodes, [], "same content, meaningless path");
});

test("role meta dependencies become role→role edges", () => {
  const src = yml(["dependencies:", "  - role: base", "  - common"]);
  const { rawEdges } = extractAnsible("roles/web/meta/main.yml", src);
  const deps = rawEdges.filter((e) => e.relation === "calls").map((e) => e.name);
  assert.deepEqual(deps.sort(), ["base", "common"]);
});

// ---------------------------------------------------------------------------
// End to end: build + check must agree, or `check` reports permanent drift
// ---------------------------------------------------------------------------

function scratchRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-ansible-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

test("build resolves notify/roles/include across files, and check sees the same nodes", async () => {
  const dir = scratchRepo({
    "site.yml": yml([
      "- name: the play",
      "  hosts: all",
      "  roles:",
      "    - common",
    ]),
    "roles/common/tasks/main.yml": yml([
      "- name: stage the CA",
      "  ansible.builtin.copy:",
      "    src: ca.crt",
      "    dest: /usr/local/share/ca-certificates/ca.crt",
      "  notify: update-ca-certificates",
      "- name: bring in storage",
      "  include_tasks: storage.yml",
    ]),
    "roles/common/tasks/storage.yml": yml(["- name: make a vg", "  ansible.builtin.command: vgcreate"]),
    "roles/common/handlers/main.yml": yml(["- name: update-ca-certificates", "  ansible.builtin.command: update-ca-certificates"]),
    "k8s/deploy.yaml": yml(["apiVersion: apps/v1", "kind: Deployment"]),
  });
  const outDir = join(dir, "graft");
  await buildGraph(dir, { reuse: false });
  const graph = readGraph(wiringPath(outDir))!;

  const id = (name: string) => graph.nodes.find((n) => n.name === name)?.id;

  // The Kubernetes manifest must be absent entirely — not present-but-empty.
  assert.equal(
    graph.nodes.some((n) => n.path === "k8s/deploy.yaml"),
    false,
    "a declined file must leave no trace in the graph",
  );

  const edge = (rel: string, from: string, to: string) =>
    graph.edges.some((e) => e.relation === rel && e.source === from && e.target === to);

  assert.ok(edge("calls", id("the play")!, id("common")!), "roles: → the role module");
  assert.ok(
    edge("calls", id("stage the CA")!, id("update-ca-certificates")!),
    "notify: → the handler in another file",
  );
  assert.ok(
    edge("imports", id("bring in storage")!, "roles/common/tasks/storage.yml"),
    "include_tasks: → the included file",
  );

  // #236: a tier the build extracts but `check` cannot see reports every one of
  // its nodes as `removed`, forever, and the rebuild it advises never repairs it.
  const drift = await checkGraph(dir, { contextDir: outDir });
  assert.equal(drift.removed.length, 0, `check must see the ansible tier: ${JSON.stringify(drift.removed)}`);
  assert.equal(drift.added.length, 0, `check must not invent nodes: ${JSON.stringify(drift.added)}`);
});
