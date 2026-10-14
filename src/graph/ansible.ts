/**
 * Ansible tier — YAML whose meaning is in its KEY NAMES, not its syntax.
 *
 * Ansible is the case none of the other three tiers can reach. The depth tier
 * (extract.ts) and the breadth tier (generic.ts) both ask a grammar "what
 * definitions does this syntax declare?", and YAML's answer is always the same:
 * mappings and sequences. A `tags.scm` over tree-sitter-yaml would capture every
 * key in every YAML file in the repo — Kubernetes manifests, CI workflows, lock
 * files — and call them definitions, which is worse than not indexing at all.
 * The container tier (container.ts) does not apply either: there is no embedded
 * language to hand off, the YAML *is* the program.
 *
 * So this tier uses the grammar only as a reader (key/value pairs and their
 * exact lines) and puts the semantics here, in code: a mapping with `hosts:` is
 * a play, a sequence item with a module key is a task, `notify:` names a
 * handler, `include_tasks:` names a file. That is the layer that makes an
 * Ansible repo navigable, and it is not recoverable from the syntax tree.
 *
 * **Detection is the whole risk here.** `.yml` is the most overloaded extension
 * in a modern repo; claiming it wrongly would flood the graph with nodes for
 * things that are not Ansible and quietly inflate every coverage number graft
 * reports. The rule is deliberately narrow, and its load-bearing half is
 * structural: a *sequence* at the document root whose items are Ansible-shaped
 * mappings. Kubernetes manifests, Compose files, and GitHub workflows are all
 * mapping-rooted, so they cannot reach the accept path at all. The one
 * mapping-rooted Ansible shape — a vars file — is admitted only from a path that
 * Ansible itself gives meaning to (`group_vars/`, a role's `defaults/`, ...).
 * A file that fails detection produces ZERO nodes, not an empty file node, so a
 * repo of non-Ansible YAML is indistinguishable from one graft never walked.
 *
 * What it emits:
 *   - `file`     one per Ansible file
 *   - `module`   a role, minted at `roles/<name>/tasks/main.yml`
 *   - `class`    a play (`- hosts: web`)
 *   - `function` a task or a handler
 *   - `variable` a var from a vars/defaults file, a `vars:` block, or `set_fact`
 * wired by `contains`, plus the two edges that make it a graph rather than an
 * outline: `imports` for `include_tasks`/`import_tasks` (resolved to the file)
 * and `calls` for `include_role`/`import_role`/`roles:` (to the role module) and
 * `notify:`/`listen:` (to the handler).
 *
 * Variable *references* (`{{ foo }}`) are deliberately NOT edges. resolve.ts
 * only resolves a bare-name `references` edge for generic-origin nodes, so every
 * one emitted here would be built and then dropped; and a name-only match across
 * a repo-wide var namespace is exactly the guess that was measured to halve call
 * precision elsewhere in this codebase. Definitions are indexed; uses are grep.
 */
import { contentHash } from "../util/id.js";
import { loadWasmLanguage, parseWasm, type TsNode } from "./generic.js";
import type { ExtractResult, RawEdge } from "./extract.js";
import type { Kind, NodeV1 } from "./types.js";

/** Extensions this tier claims. Must not collide with the depth/breadth tiers. */
const EXTS = [".yml", ".yaml"] as const;

export function ansibleExtensions(): string[] {
  return [...EXTS];
}

/** True if the path *could* be Ansible. Content still decides — this only avoids
 * reading and parsing files no extension check could ever admit. */
export function ansibleClaims(path: string): boolean {
  const p = path.toLowerCase();
  return EXTS.some((e) => p.endsWith(e));
}

let grammar: unknown | null = null;
let warmed = false;

/** Warm the YAML grammar. Same contract as `warmGenericGrammars`: await once
 * before the synchronous parse loop; an unavailable grammar is skipped rather
 * than fatal (Ansible files then extract to nothing, as if the tier were off). */
export async function warmAnsibleGrammar(): Promise<void> {
  if (warmed) return;
  warmed = true;
  grammar = await loadWasmLanguage("yaml");
}

export function isAnsibleWarm(): boolean {
  return grammar !== null;
}

/** Swap the grammar out in tests (mirrors generic.ts's `swapGrammarForTest`). */
export function swapAnsibleGrammarForTest(g: unknown | null): unknown | null {
  const prior = grammar;
  grammar = g;
  warmed = true;
  return prior;
}

// ---------------------------------------------------------------------------
// CST helpers. tree-sitter-yaml shape:
//   stream > document > block_node > block_mapping   > block_mapping_pair(key,value)
//   stream > document > block_node > block_sequence  > block_sequence_item > block_node
// Scalars are `flow_node`; nested structures are `block_node`.
// ---------------------------------------------------------------------------

function named(n: TsNode): TsNode[] {
  const out: TsNode[] = [];
  for (let i = 0; i < (n.namedChildCount ?? 0); i++) {
    const c = n.namedChild?.(i);
    if (c) out.push(c);
  }
  return out;
}

/** Nodes that carry no meaning of their own and only wrap the real value. */
const WRAPPERS = new Set(["document", "block_node", "flow_node"]);

/** Named children minus the ones that carry no value. `comment` is a NAMED node
 * in tree-sitter-yaml and sits as a sibling of the content it precedes, so a
 * commented playbook's `document` has thirteen comment children before its
 * `block_node` — an unwrap that took the first named child would take a comment
 * and conclude the file was not a sequence. */
function content(n: TsNode): TsNode[] {
  return named(n).filter((c) => c.type !== "comment");
}

/**
 * Strip wrapper nodes to reach the value a node actually holds.
 *
 * This walks DOWN THROUGH WRAPPERS ONLY — it must never search the subtree. An
 * earlier version used a recursive first-descendant-of-type search, and it read
 * every mapping-rooted data file in the repo as a sequence: `aggregates:\n  -
 * name: san-hosts` is a MAPPING whose value happens to contain a sequence, and a
 * recursive search finds that inner sequence and hands it back as if it were the
 * document root. Eight declarative config files were misdetected as Ansible task
 * files that way. Structure at *this* level is the entire detection signal, so
 * the unwrap has to preserve it.
 */
function unwrap(n: TsNode | null): TsNode | null {
  let cur = n;
  while (cur && WRAPPERS.has(cur.type)) {
    const kids = content(cur);
    if (kids.length !== 1) return kids.length ? kids[0] : null;
    cur = kids[0];
  }
  return cur;
}

const MAPPING = new Set(["block_mapping", "flow_mapping"]);
const SEQUENCE = new Set(["block_sequence", "flow_sequence"]);

/** The mapping this node directly holds, or null if it holds something else. */
function asMapping(n: TsNode | null): TsNode | null {
  const u = unwrap(n);
  return u && MAPPING.has(u.type) ? u : null;
}

/** The sequence this node directly holds, or null if it holds something else. */
function asSequence(n: TsNode | null): TsNode | null {
  const u = unwrap(n);
  return u && SEQUENCE.has(u.type) ? u : null;
}

/** key → value nodes of a mapping, in source order. Duplicate keys keep the first
 * (Ansible itself warns on them; picking one is better than emitting two nodes). */
function pairs(mapping: TsNode): Array<{ key: string; value: TsNode | null; pair: TsNode }> {
  const out: Array<{ key: string; value: TsNode | null; pair: TsNode }> = [];
  const seen = new Set<string>();
  for (const c of content(mapping)) {
    if (c.type !== "block_mapping_pair" && c.type !== "flow_pair") continue;
    const k = c.childForFieldName?.("key");
    if (!k) continue;
    const key = scalar(k);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, value: c.childForFieldName?.("value") ?? null, pair: c });
  }
  return out;
}

function keysOf(mapping: TsNode): Set<string> {
  return new Set(pairs(mapping).map((p) => p.key));
}

function get(mapping: TsNode, key: string): TsNode | null {
  return pairs(mapping).find((p) => p.key === key)?.value ?? null;
}

/** A scalar's text with surrounding quotes and whitespace removed. */
function scalar(n: TsNode | null): string {
  if (!n) return "";
  const t = n.text.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

/** The items of a sequence node, each unwrapped past `block_sequence_item`. */
function items(seq: TsNode): TsNode[] {
  const out: TsNode[] = [];
  for (const c of content(seq)) {
    if (c.type === "block_sequence_item") {
      const inner = content(c)[0];
      if (inner) out.push(inner);
    } else {
      out.push(c);
    }
  }
  return out;
}

/** A scalar-or-sequence-of-scalars value read as a list of strings. `notify:` and
 * `roles:` are both spelled either way in real playbooks. */
function stringList(v: TsNode | null): string[] {
  if (!v) return [];
  const seq = asSequence(v);
  if (seq) {
    return items(seq)
      .map((i) => {
        // `- role: common` / `- name: common` (a role entry with params)
        const m = asMapping(i);
        if (m) return scalar(get(m, "role") ?? get(m, "name"));
        return scalar(i);
      })
      .filter(Boolean);
  }
  const s = scalar(v);
  return s ? [s] : [];
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Keys that only a play has. */
const PLAY_KEYS = new Set(["hosts", "import_playbook", "ansible.builtin.import_playbook"]);

/** Keys that mark a mapping as a task. Directives (always spelled bare) plus the
 * include/import family — NOT a general module list, which would never be
 * complete and would drift with every collection release. A task without any of
 * these but with a `name:` is caught by the module-key heuristic below. */
const TASK_DIRECTIVES = new Set([
  "block", "rescue", "always",
  "include_tasks", "import_tasks", "include_role", "import_role", "include_vars", "include",
  "when", "register", "notify", "listen", "loop", "with_items", "with_dict", "with_fileglob",
  "with_nested", "with_subelements", "with_together", "with_sequence", "until", "retries",
  "delay", "become", "become_user", "delegate_to", "run_once", "changed_when", "failed_when",
  "ignore_errors", "no_log", "check_mode", "environment", "args", "action", "local_action",
  "set_fact", "tags", "vars", "loop_control", "any_errors_fatal", "throttle",
  "remote_user", "connection", "collections", "module_defaults", "diff", "async", "poll",
  "timeout", "debugger", "port", "become_method", "become_flags", "failed_when_result",
]);

/** `name:` is a task's label, never its module. It is excluded from the module
 * scan separately from the directive list because the two uses differ: a
 * directive disqualifies a mapping from *needing* a module to be a task, whereas
 * `name` is the very thing that makes the module scan necessary. Leaving it in
 * TASK_DIRECTIVES would make every `- name: x` mapping in any YAML file a task. */
const NOT_A_MODULE = new Set(["name"]);

/**
 * Bare (non-FQCN) module names that may stand alone as evidence of a task.
 *
 * A bare lowercase key cannot be accepted on its own shape: `- name: alice` +
 * `description: an admin` is a roster entry, not a task, and "any lowercase
 * identifier is a module" reads it as one. Since Ansible has no `description`
 * module, the discriminator is the module NAME — so bare keys are matched
 * against this list, while a fully-qualified key (`community.general.ufw`) is
 * accepted structurally because the FQCN shape is itself unambiguous.
 *
 * ansible.builtin plus the collection modules common enough to be written bare
 * in the wild. The consequence of the list being incomplete is a false NEGATIVE
 * — a task spelled with an uncommon bare module and no directive is not indexed
 * — which is the right way round: the FQCN spelling (recommended since 2.10)
 * and any directive (`when`, `become`, `register`, ...) both still work, and a
 * missed task costs coverage while a false accept costs trust in every count
 * graft prints.
 */
const BARE_MODULES = new Set([
  // ansible.builtin
  "add_host", "apt", "apt_key", "apt_repository", "assemble", "assert", "async_status",
  "blockinfile", "command", "copy", "cron", "debconf", "debug", "dnf", "dpkg_selections",
  "expect", "fail", "fetch", "file", "find", "gather_facts", "get_url", "getent", "git",
  "group", "group_by", "hostname", "iptables", "known_hosts", "lineinfile", "meta", "mount",
  "package", "package_facts", "pause", "ping", "pip", "raw", "reboot", "replace", "rpm_key",
  "script", "service", "service_facts", "set_stats", "setup", "shell", "slurp", "stat",
  "subversion", "systemd", "systemd_service", "sysvinit", "tempfile", "template", "unarchive",
  "uri", "user", "validate_argument_spec", "wait_for", "wait_for_connection", "yum",
  "yum_repository",
  // commonly written bare from collections
  "acl", "alternatives", "archive", "authorized_key", "docker_container", "docker_image",
  "docker_network", "docker_volume", "filesystem", "firewalld", "htpasswd", "ini_file",
  "k8s", "locale_gen", "lvg", "lvol", "make", "modprobe", "mysql_db", "mysql_user", "npm",
  "openssl_certificate", "pam_limits", "parted", "postgresql_db", "postgresql_user", "seboolean",
  "sefcontext", "selinux", "snap", "sysctl", "timezone", "ufw", "x509_certificate", "xml",
]);

/** A key that invokes a module: an FQCN (`ansible.builtin.apt`), whose shape is
 * unambiguous on its own, or a bare name from {@link BARE_MODULES}. */
function looksLikeModuleKey(key: string): boolean {
  if (TASK_DIRECTIVES.has(key) || PLAY_KEYS.has(key) || NOT_A_MODULE.has(key)) return false;
  if (/^[a-z0-9_]+(\.[a-z0-9_]+){2,}$/.test(key)) return true; // FQCN
  return BARE_MODULES.has(key);
}

function isTaskMapping(m: TsNode): boolean {
  const keys = keysOf(m);
  for (const k of keys) if (TASK_DIRECTIVES.has(k)) return true;
  // `- name: x` + a module key. `name` alone is not enough: a list of named
  // things is the single most common shape in all of YAML.
  if (keys.has("name")) {
    for (const k of keys) if (looksLikeModuleKey(k)) return true;
  }
  return false;
}

function isPlayMapping(m: TsNode): boolean {
  const keys = keysOf(m);
  for (const k of keys) if (PLAY_KEYS.has(k)) return true;
  return false;
}

/** Path shapes Ansible itself assigns meaning to. Anchored on a path SEGMENT so
 * `my_group_vars/` cannot match. */
const RE_ROLE_TASKS_MAIN = /(^|\/)roles\/([^/]+)\/tasks\/main\.ya?ml$/;
const RE_VARS_FILE = /(^|\/)(group_vars|host_vars)\//;
const RE_ROLE_VARS = /(^|\/)roles\/[^/]+\/(defaults|vars)\//;
const RE_ROLE_META = /(^|\/)roles\/[^/]+\/meta\/main\.ya?ml$/;
const RE_ROLE_HANDLERS = /(^|\/)roles\/[^/]+\/handlers\//;

/** Cheap textual veto for formats that are definitely not Ansible, so a large
 * manifest tree is rejected before the parse. Each pattern is anchored at column
 * zero: a nested `kind:` inside an Ansible task is not a Kubernetes manifest. */
function vetoed(source: string): boolean {
  const head = source.slice(0, 4000);
  if (/^apiVersion:/m.test(head) && /^kind:/m.test(head)) return true; // Kubernetes
  if (/^on:/m.test(head) && /^jobs:/m.test(head)) return true; // GitHub Actions
  if (/^services:/m.test(head) && /^(version|networks|volumes):/m.test(head)) return true; // Compose
  return false;
}

export type AnsibleShape = "playbook" | "tasks" | "handlers" | "vars" | "meta";

/** What kind of Ansible file this is, or null if it is not Ansible at all. */
export function ansibleShape(rel: string, root: TsNode, source: string): AnsibleShape | null {
  if (vetoed(source)) return null;

  // Structural path: a document whose root is a SEQUENCE of Ansible-shaped
  // mappings. This is the only way a playbook or tasks file can be spelled, and
  // no mapping-rooted format can reach it.
  for (const doc of content(root)) {
    if (doc.type !== "document") continue;
    const seq = asSequence(doc);
    if (seq) {
      const mappings = items(seq)
        .map((i) => asMapping(i))
        .filter((m): m is TsNode => m !== null);
      if (mappings.length === 0) continue;
      if (mappings.some(isPlayMapping)) return "playbook";
      if (mappings.some(isTaskMapping)) {
        return RE_ROLE_HANDLERS.test(rel) ? "handlers" : "tasks";
      }
      continue;
    }
    // Mapping-rooted: only admitted from a path Ansible gives meaning to.
    const map = asMapping(doc);
    if (!map) continue;
    if (RE_ROLE_META.test(rel)) return "meta";
    if (RE_VARS_FILE.test(rel) || RE_ROLE_VARS.test(rel)) return "vars";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * `L<start>-L<end>`, 1-based, with the trailing-newline row trimmed.
 *
 * A YAML block node that runs to the end of its parent swallows the newline that
 * terminates its last line, so tree-sitter reports `endPosition` as row N+1
 * column 0 — a line the definition does not occupy, and in a file ending with a
 * newline, a line that does not exist. Left uncorrected every last-in-parent
 * play, task and block reads one line too long, which is precisely the
 * plausible-but-wrong span this tier must not produce.
 */
function span(n: TsNode): string {
  const start = n.startPosition.row;
  let end = n.endPosition.row;
  if (n.endPosition.column === 0 && end > start) end -= 1;
  return `L${start + 1}-L${end + 1}`;
}

/** Ansible names are free text ("Install the base packages"). They are the only
 * handle a `notify:` has, so they are kept verbatim as the node name; only the
 * id is normalised, and only enough to stay a usable id. */
function idPart(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 120);
}

class Emitter {
  readonly nodes: NodeV1[] = [];
  readonly rawEdges: RawEdge[] = [];
  private minted = new Set<string>();

  constructor(
    private rel: string,
    private source: string,
  ) {
    this.minted.add(rel);
    this.nodes.push({
      id: rel,
      name: rel.split("/").pop() ?? rel,
      kind: "file",
      path: rel,
      span: `L1-L${Math.max(1, source.split("\n").length)}`,
      signature: null,
      exported: true,
      origin: "ast",
      body_hash: contentHash(source),
      chars: Buffer.byteLength(source),
      summary_state: "pending",
      summary: null,
      crux: null,
    });
  }

  node(name: string, kind: Kind, n: TsNode, signature: string | null, parent: string): string {
    const base = `${this.rel}#${idPart(name)}`;
    let id = base;
    let k = 2;
    while (this.minted.has(id)) id = `${base}~${k++}`;
    this.minted.add(id);
    const body = this.source.slice(n.startIndex, n.endIndex);
    this.nodes.push({
      id,
      name,
      kind,
      path: this.rel,
      span: span(n),
      signature,
      exported: true,
      origin: "ast",
      body_hash: contentHash(body),
      body_text: body.replace(/\s+/g, " ").slice(0, 5000),
      summary_state: "pending",
      summary: null,
      crux: null,
    });
    this.rawEdges.push({ source: parent, relation: "contains", targetId: id, file: this.rel });
    return id;
  }

  /** A `calls` edge resolved by bare name against `kinds`. */
  call(source: string, name: string, kinds: Kind[]): void {
    if (!name || name.includes("{{")) return; // templated target — unknowable statically
    this.rawEdges.push({ source, relation: "calls", name, kinds, file: this.rel });
  }

  /** An `imports` edge to another file in the repo, as a file-relative specifier
   * so resolve.ts's `resolveImport` settles it against the node index. */
  importPath(source: string, target: string): void {
    if (!target || target.includes("{{")) return;
    this.rawEdges.push({ source, relation: "imports", specifier: `./${target}`, file: this.rel });
  }
}

/** `include_tasks: setup.yml` names a path relative to the including file (close
 * enough for both the playbook and the role case, which is why role task files
 * live beside each other). Strips a leading `./` so the specifier is canonical. */
function includedPath(v: TsNode | null): string {
  if (!v) return "";
  const m = asMapping(v);
  const raw = m ? scalar(get(m, "file") ?? get(m, "_raw_params")) : scalar(v);
  return raw.replace(/^\.\//, "");
}

/** `include_role: {name: common}` / `import_role: {name: common}`. */
function includedRole(v: TsNode | null): string {
  if (!v) return "";
  const m = asMapping(v);
  return m ? scalar(get(m, "name")) : scalar(v);
}

/** Emit one task (or handler) and everything it points at. Recurses through
 * `block:`/`rescue:`/`always:`, which nest tasks arbitrarily deep. */
function emitTask(e: Emitter, m: TsNode, whole: TsNode, parent: string, kind: Kind): void {
  const ps = pairs(m);
  const nameVal = ps.find((p) => p.key === "name")?.value ?? null;
  const moduleKey = ps.find((p) => looksLikeModuleKey(p.key))?.key ?? null;
  const name = scalar(nameVal) || moduleKey || "task";
  const id = e.node(name, kind, whole, moduleKey, parent);

  for (const { key, value } of ps) {
    switch (key) {
      case "notify":
      case "listen":
        for (const h of stringList(value)) e.call(id, h, ["function"]);
        break;
      case "include_tasks":
      case "import_tasks":
      case "include":
        e.importPath(id, includedPath(value));
        break;
      case "include_role":
      case "import_role": {
        const role = includedRole(value);
        if (role) e.call(id, role, ["module"]);
        break;
      }
      case "set_fact": {
        const facts = asMapping(value);
        if (facts) for (const f of pairs(facts)) e.node(f.key, "variable", f.pair, null, id);
        break;
      }
      case "vars": {
        const vars = asMapping(value);
        if (vars) for (const v of pairs(vars)) e.node(v.key, "variable", v.pair, null, id);
        break;
      }
      case "block":
      case "rescue":
      case "always": {
        const seq = asSequence(value);
        if (seq) {
          for (const it of items(seq)) {
            const im = asMapping(it);
            if (im) emitTask(e, im, it, id, kind);
          }
        }
        break;
      }
    }
  }
}

function emitTaskList(e: Emitter, v: TsNode | null, parent: string, kind: Kind): void {
  const seq = asSequence(v);
  if (!seq) return;
  for (const it of items(seq)) {
    const m = asMapping(it);
    if (m) emitTask(e, m, it, parent, kind);
  }
}

/** Extract one Ansible file. Synchronous; needs `warmAnsibleGrammar()` awaited.
 * Returns zero nodes when the file is not Ansible — see the header note. */
export function extractAnsible(rel: string, source: string): ExtractResult {
  const empty: ExtractResult = { nodes: [], rawEdges: [] };
  if (!grammar) return empty;

  let root: TsNode | null;
  try {
    root = parseWasm(grammar, source);
  } catch (err) {
    throw new Error(`yaml grammar threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!root) return empty;

  const shape = ansibleShape(rel, root, source);
  if (!shape) return empty;

  const e = new Emitter(rel, source);

  // A role's entry point mints the role itself, so `include_role: name: X` has
  // something to resolve to. Its tasks hang off the role, not the file — the
  // same file→class→method shape a class-bearing source file produces.
  const roleMatch = RE_ROLE_TASKS_MAIN.exec(rel);
  const roleId = roleMatch
    ? e.node(roleMatch[2], "module", root, `role ${roleMatch[2]}`, rel)
    : null;
  const topParent = roleId ?? rel;

  for (const doc of content(root)) {
    if (doc.type !== "document") continue;

    if (shape === "vars" || shape === "meta") {
      const map = asMapping(doc);
      if (!map) continue;
      if (shape === "vars") {
        for (const p of pairs(map)) e.node(p.key, "variable", p.pair, null, rel);
      } else {
        // meta/main.yml — `dependencies:` are role→role edges.
        for (const dep of stringList(get(map, "dependencies"))) e.call(rel, dep, ["module"]);
      }
      continue;
    }

    const seq = asSequence(doc);
    if (!seq) continue;

    for (const it of items(seq)) {
      const m = asMapping(it);
      if (!m) continue;

      if (shape === "playbook" && isPlayMapping(m)) {
        const hosts = scalar(get(m, "hosts"));
        const playName = scalar(get(m, "name")) || (hosts ? `play: ${hosts}` : "play");
        const playId = e.node(playName, "class", it, hosts ? `hosts: ${hosts}` : null, rel);

        // `- import_playbook: other.yml` is a play-shaped include.
        const ip = get(m, "import_playbook") ?? get(m, "ansible.builtin.import_playbook");
        if (ip) e.importPath(playId, includedPath(ip));

        for (const role of stringList(get(m, "roles"))) e.call(playId, role, ["module"]);
        for (const vf of stringList(get(m, "vars_files"))) e.importPath(playId, vf);
        const vars = asMapping(get(m, "vars"));
        if (vars) for (const v of pairs(vars)) e.node(v.key, "variable", v.pair, null, playId);

        emitTaskList(e, get(m, "pre_tasks"), playId, "function");
        emitTaskList(e, get(m, "tasks"), playId, "function");
        emitTaskList(e, get(m, "post_tasks"), playId, "function");
        emitTaskList(e, get(m, "handlers"), playId, "function");
        continue;
      }

      // A bare tasks/handlers file: every item is a task at the top level.
      if (isTaskMapping(m)) emitTask(e, m, it, topParent, "function");
    }
  }

  return { nodes: e.nodes, rawEdges: e.rawEdges };
}
