/**
 * Renderers for a {@link BlastReport}: the Mermaid+markdown comment body a CI job
 * posts, and a plain-text report for a terminal.
 *
 * The diagram is the product here — a reviewer should see which areas a change
 * reaches, and whether its tests moved, before reading a single path — so the
 * markdown leads with it and keeps every per-symbol list collapsed underneath.
 * GitHub renders Mermaid natively in comments, so there is nothing to host.
 *
 * Both sides of the diagram are drawn at the same grain: areas, not files. The
 * first version drew one box per changed file, which cannot fit a real PR (24 files
 * against a cap of ten) and told a reviewer nothing per box — `src/graph/write.ts`
 * on its own is not a unit anyone reasons about.
 */
import type { BlastReport, ChangedArea, ImpactedModule, Impacted, TestSignal } from "./blast.js";
import type { Evidence } from "../viz/assemble.js";
import { fileReader, impactedEvidence, reachTerms } from "./evidence.js";
import { MAX_REVIEWERS, mention, sinceLabel, type Owner } from "./owners.js";
import { brand, cmd } from "../brand.js";

/** Diagram cap. Everything past it folds into one aggregate circle carrying the
 * dropped counts, so the picture shrinks but never lies. */
const MAX_MODULE_BOXES = 5;
/** Rows in the table under the diagram. */
const MAX_TABLE_ROWS = 6;
/** Symbols listed in the one collapsed list of everything. */
const MAX_SYMBOLS_LISTED = 60;
/** Rows in the collapsed ownership table. Past this it is a `git shortlog`, not a
 * hint about who to ask. */
const MAX_OWNER_ROWS = 8;

/**
 * A quoted Mermaid label. Every line is escaped on its own and only then joined
 * with `<br/>` — escaping the joined string would eat the tag's own angle brackets
 * and render the literal text "br/" inside the node.
 */
function label(...lines: string[]): string {
  return `"${lines.map(escapeLabel).join("<br/>")}"`;
}

/** Quotes end a Mermaid label, and angle brackets would inject markup into it. */
function escapeLabel(text: string): string {
  return text.replace(/"/g, "#quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function depthLabel(depth: number): string {
  return Number.isFinite(depth) ? `depth ${depth}` : "full closure";
}

/**
 * Node colours, taken from `graft viz`'s own palette (viewer/style.css) so the two
 * pictures of the same graph read as one thing: teal is "depends on your change"
 * (`--k-method`), grey is the overflow circle (`--edge`). One hue for one kind of
 * thing, now that the diff itself is not drawn. Fill AND text colour are set
 * explicitly, because a GitHub comment renders in either theme and a node that
 * inherits one of them is illegible in the other.
 */
const VIZ = {
  reachedFill: "#D9EDF3", reachedStroke: "#3AA7C9", reachedInk: "#0E313C",
  tailFill: "#EEF2F3", tailStroke: "#9AA4A9", tailInk: "#3A4247",
} as const;

/** The glyph carried on a changed circle. Meaning lives in the diagram's key. */
const TEST_GLYPH: Record<TestSignal, string> = { changed: "✓", stale: "⚠", none: "✗", na: "–" };

/**
 * The diagram: one circle per area that can be affected, and nothing else.
 *
 * Everything about the changed side is gone on purpose. Drawing which of your edits
 * reaches which area is a many-to-many relation, so it can only ever render as a
 * mesh — nine arrows over eleven circles at its tidiest — and the reviewer has to
 * trace lines to read it. That relation still exists in the table's "Reached from"
 * column, where a reader can look it up when they want it, so the picture is free
 * to answer the only question it is asked at a glance: what can break?
 *
 * `TB`, not `LR`: with no edges, top-bottom is what lays unconnected nodes out as a
 * row instead of a tall column.
 *
 * Returns null when there is nothing to draw — an empty diagram frame reads as a
 * broken renderer, and the caller has a sentence for "no dependents found".
 */
export function mermaidDiagram(r: BlastReport): string | null {
  const shown = r.modules.slice(0, MAX_MODULE_BOXES);
  if (shown.length === 0) return null;
  const hidden = r.modules.slice(MAX_MODULE_BOXES);

  const lines = ["flowchart TB"];
  shown.forEach((m, i) => {
    lines.push(`  A${i}((${label(m.label, plural(m.symbols.length, "symbol"))}))`);
  });
  const TAIL = "AX";
  if (hidden.length > 0) {
    const symbols = hidden.reduce((n, m) => n + m.symbols.length, 0);
    lines.push(`  ${TAIL}((${label(plural(hidden.length, "smaller area"), plural(symbols, "symbol"))}))`);
  }

  lines.push(`  classDef reached fill:${VIZ.reachedFill},stroke:${VIZ.reachedStroke},stroke-width:1.5px,color:${VIZ.reachedInk};`);
  lines.push(`  class ${shown.map((_, i) => `A${i}`).join(",")} reached;`);
  if (hidden.length > 0) {
    lines.push(`  classDef tail fill:${VIZ.tailFill},stroke:${VIZ.tailStroke},stroke-width:1px,color:${VIZ.tailInk};`);
    lines.push(`  class ${TAIL} tail;`);
  }
  return lines.join("\n");
}

/**
 * The PR-comment body: diagram, then one table, then everything else collapsed.
 *
 * `root` is the repository the report was taken in. With it, the collapsed symbol
 * list quotes the line that reaches the diff — the same line the hosted page shows,
 * from the same helper. Without it the list is unchanged, so a caller that has no
 * checkout (a test, a piped report) loses nothing but the snippet.
 */
export function markdownReport(r: BlastReport, opts: { root?: string } = {}): string {
  const out: string[] = [];
  const symbols = r.modules.reduce((n, m) => n + m.symbols.length, 0);

  out.push(`### 🌱 ${brand()} blast radius`);
  out.push("");
  out.push(headline(r, symbols));
  const testLine = testHeadline(r);
  if (testLine) out.push(testLine);
  // Above the diagram on purpose: it is the one line in this comment the author
  // ACTS on rather than reads, and it costs a single row before the picture.
  const tag = tagLine(r);
  if (tag) out.push(tag);

  if (symbols > 0) {
    const diagram = mermaidDiagram(r);
    if (diagram) {
      out.push("");
      out.push("```mermaid");
      out.push(diagram);
      out.push("```");
    }
    out.push("");
    out.push(...impactTable(r));
  }

  const owners = ownerSection(r);
  if (owners.length > 0) {
    out.push("");
    out.push(...owners);
  }

  out.push("");
  const reach = reachTerms(r.seeds, r.changed);
  const read = fileReader(opts.root);
  out.push(...detailSections(r, symbols, (s) => impactedEvidence(s, reach, read)));

  const caveats = caveatLines(r);
  if (caveats.length > 0) {
    out.push("");
    for (const line of caveats) out.push(line);
  }
  out.push("");
  out.push(`<sub>\`${cmd("graft blast")}\` · ${r.basis} · ${depthLabel(r.depth)} · ${plural(r.changed.length, "changed file")}</sub>`);
  return out.join("\n") + "\n";
}

function headline(r: BlastReport, symbols: number): string {
  const areas = plural(r.areas.length, "area");
  if (symbols === 0) {
    return `**Nothing outside this diff depends on it.** ${areas} changed; no indexed dependents at ${depthLabel(r.depth)}.`;
  }
  return `**${areas} changed → ${plural(r.modules.length, "area")} can be affected.** ${plural(symbols, "dependent symbol")}, ${depthLabel(r.depth)}.`;
}

/**
 * One sentence on whether the diff brought its tests. Leads with the areas that
 * have no tests at all, since that is the only state worth a reviewer's comment.
 */
function testHeadline(r: BlastReport): string | null {
  if (r.areas.length === 0) return null;
  const none = r.areas.filter((a) => a.tests === "none");
  const stale = r.areas.filter((a) => a.tests === "stale");
  const changed = r.areas.filter((a) => a.tests === "changed");
  const parts: string[] = [];
  if (none.length > 0) parts.push(`**no test reaches ${none.map((a) => a.label).join(", ")}**`);
  if (stale.length > 0) parts.push(`${stale.map((a) => a.label).join(", ")} ${stale.length === 1 ? "has tests" : "have tests"} the diff did not touch`);
  if (changed.length > 0) parts.push(`${plural(changed.length, "area")} updated ${changed.length === 1 ? "its" : "their"} tests`);
  if (parts.length === 0) return null;
  return `Tests: ${parts.join("; ")}.`;
}

/**
 * The table replaces 31 collapsed sections that held one bullet each. One row per
 * affected area, with the nearest symbol to start reading at — a reviewer wants a
 * place to look, not an inventory.
 */
function impactTable(r: BlastReport): string[] {
  const shown = r.modules.slice(0, MAX_TABLE_ROWS);
  const hidden = r.modules.slice(MAX_TABLE_ROWS);
  const areaOf = new Map<string, string>();
  for (const a of r.areas) for (const f of a.files) areaOf.set(f, a.label);

  const rows = ["| Can be affected | Symbols | Nearest hop | Reached from |", "| --- | --: | --- | --- |"];
  for (const mod of shown) {
    const nearest = mod.symbols[0];
    const hop = nearest ? `\`${nearest.path}:${nearest.span}\` ${nearest.name} — ${nearest.relation}, depth ${nearest.depth}` : "—";
    // Two names, then a count. Six area names in one cell is what turned this
    // column into a wall wider than the rest of the table put together.
    const names = [...new Set(mod.from.map((f) => areaOf.get(f) ?? f))];
    const from = names.length === 0 ? "—"
      : names.length <= 2 ? names.join(", ")
      : `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
    rows.push(`| ${mod.label} | ${mod.symbols.length} | ${hop} | ${from} |`);
  }
  if (hidden.length > 0) {
    const symbols = hidden.reduce((n, m) => n + m.symbols.length, 0);
    rows.push(`| _${plural(hidden.length, "smaller area")}_ | ${symbols} | ${hidden.slice(0, 3).map((m) => m.label).join(", ")}${hidden.length > 3 ? ", …" : ""} | see below |`);
  }
  return rows;
}

/**
 * The tag line: who to ask, and why them.
 *
 * A handle is printed only where git carried one — `mention` never invents an
 * `@`, because a guessed mention pings a stranger who has nothing to do with the
 * change. A bare name is bolded instead, so it still reads as a person.
 *
 * Null on a repository where the author is the only name in the history: an
 * empty "Tag:" is worse than no line, and every solo project would carry one.
 */
function tagLine(r: BlastReport): string | null {
  const people = r.reviewers ?? [];
  if (people.length === 0) return null;
  const total = r.areas.length + r.modules.length;
  const bits = people.map((p) => {
    const who = p.handle !== undefined ? `@${p.handle}` : `**${p.name}**`;
    // Three or more areas is a count, not a list: naming eleven of them turns the
    // one actionable line in the comment into the longest paragraph in it.
    const why = p.areas.length >= 3 ? `${p.areas.length} of ${total} areas` : p.areas.join(", ");
    return `${who} — ${why}`;
  });
  return `Tag: ${bits.join(" · ")}`;
}

/** `Shrish Dwivedi — 57 commits, last 9d ago`, for one cell of the table. */
function ownerCell(owners: Owner[] | undefined, now: number): string {
  if (owners === undefined || owners.length === 0) {
    // Said in words rather than left blank: "nobody else" is a real answer, and an
    // empty cell reads as a renderer that failed.
    return "_only you — nobody else has touched these files_";
  }
  return owners
    .map((o) => `${mention(o)} — ${plural(o.commits, "commit")}, last ${sinceLabel(o.last, now)}`)
    .join(" · ");
}

/**
 * The collapsed evidence behind the tag line: one row per area, both sides.
 *
 * Kept collapsed and kept below the impact table because it justifies a decision
 * the author has already been handed at the top. Nothing here is a gate — the
 * caveat says so, since a table of names next to a diff invites being read as
 * CODEOWNERS.
 */
function ownerSection(r: BlastReport): string[] {
  if (r.reviewers === undefined) return []; // taken outside a git repository
  const rows: { label: string; side: string; owners?: Owner[] }[] = [
    ...r.areas.map((a: ChangedArea) => ({ label: a.label, side: "changed", owners: a.owners })),
    ...r.modules.map((m: ImpactedModule) => ({ label: m.label, side: "affected", owners: m.owners })),
  ];
  const named = rows.filter((row) => (row.owners?.length ?? 0) > 0);
  if (named.length === 0) return [];

  const now = Date.now();
  const people = new Set<string>();
  for (const row of rows) for (const o of row.owners ?? []) people.add(o.handle ?? o.name);

  const out = ["<details>"];
  out.push(
    `<summary><strong>Who knows this code</strong> — ${plural(people.size, "person", "people")} ` +
      `across ${plural(rows.length, "area")}</summary>`,
  );
  out.push("");
  out.push("| Area | Who knows it |");
  out.push("| --- | --- |");
  // Areas with names first: a row saying "only you" is context, not an answer, so
  // it must never be what the cap spends its budget on.
  const ordered = [...named, ...rows.filter((row) => !named.includes(row))];
  for (const row of ordered.slice(0, MAX_OWNER_ROWS)) {
    out.push(`| **${row.label}** · ${row.side} | ${ownerCell(row.owners, now)} |`);
  }
  if (ordered.length > MAX_OWNER_ROWS) {
    out.push(`| _…${plural(ordered.length - MAX_OWNER_ROWS, "further area")}_ | |`);
  }
  out.push("");
  out.push(
    "_Ownership is git history over each area's own files, weighted towards recent work " +
      "(120-day half-life). Merge commits and bots are dropped, and you are dropped from your own PR. " +
      "A name with no `@` has no GitHub handle in its commit email — tag them by hand, or add a " +
      "`.mailmap` entry. A suggestion from history, not a CODEOWNERS rule._",
  );
  out.push("");
  out.push("</details>");
  return out;
}

/**
 * Everything a reviewer might want and nobody reads by default, in three sections.
 *
 * The blank line after each `</summary>` is required: GitHub renders no markdown
 * inside a details block without it, and `<strong>` rather than `**` because it
 * processes no emphasis inside `<summary>` either.
 */
function detailSections(r: BlastReport, symbols: number, evidence?: (s: Impacted) => Evidence | null): string[] {
  const out: string[] = [];

  if (symbols > 0) {
    out.push("<details>");
    out.push(`<summary><strong>All ${plural(symbols, "dependent symbol")}</strong>, grouped by area</summary>`);
    out.push("");
    let listed = 0;
    for (const mod of r.modules) {
      out.push(`**${mod.label}** — ${plural(mod.symbols.length, "symbol")} in ${plural(mod.files.length, "file")}`);
      out.push("");
      for (const s of mod.symbols) {
        if (listed++ >= MAX_SYMBOLS_LISTED) break;
        out.push(`- \`${s.path}:${s.span}\` — ${s.name} (${s.relation}, depth ${s.depth})`);
        // The line that reaches the diff, quoted from the same helper the hosted
        // panel uses — a comment that disagreed with the page it links to would be
        // worse than one that said less. Collapsed, so the comment stays short.
        const [line] = evidence?.(s)?.lines ?? [];
        if (line) out.push(`  \`\`\`${line.n}: ${line.text.trim()}\`\`\``);
      }
      out.push("");
      if (listed >= MAX_SYMBOLS_LISTED) {
        out.push(`…${plural(symbols - listed, "further symbol")} not listed.`);
        out.push("");
        break;
      }
    }
    out.push("</details>");
  }

  if (r.areas.length > 0) {
    const by = (s: TestSignal) => r.areas.filter((a) => a.tests === s).length;
    const states = [
      by("changed") > 0 ? `${by("changed")} ✓` : "",
      by("stale") > 0 ? `${by("stale")} ⚠` : "",
      by("none") > 0 ? `${by("none")} ✗` : "",
      by("na") > 0 ? `${by("na")} –` : "",
    ].filter(Boolean).join(" · ");
    out.push("<details>");
    out.push(`<summary><strong>Test signal</strong> per changed area — ${states}</summary>`);
    out.push("");
    // The caveat leads, because the ratios below invite being read as coverage: a
    // test that drives the CLI in a subprocess produces no edge at all, so a
    // well-tested area can honestly report 1 of 25.
    out.push("_Reached = a node under a test path has a resolved edge into the changed symbol. It undercounts anything called indirectly — through a CLI, a spawned process or a dynamic import — so read a low ratio as “look here”, never as a coverage gate._");
    out.push("");
    for (const a of r.areas) {
      const bits = a.behavioural > 0 ? [`${a.reached} of ${a.behavioural} reached`] : [];
      if (a.changedTestFiles.length > 0) bits.push(`${plural(a.changedTestFiles.length, "test file")} changed here: ${a.changedTestFiles.map((f) => `\`${f}\``).join(", ")}`);
      else if (a.testFiles.length > 0) bits.push(`${plural(a.testFiles.length, "test file")} ${a.testFiles.length === 1 ? "reaches" : "reach"} it, none changed here`);
      else if (a.behavioural > 0) bits.push("no test file reaches it");
      else bits.push("no function, method or class changed here");
      out.push(`- ${TEST_GLYPH[a.tests]} **${a.label}** — ${bits.join(" · ")}`);
      if (a.unreached.length > 0) {
        out.push(`  - not reached: ${a.unreached.slice(0, 8).map((n) => `\`${n}\``).join(", ")}${a.unreached.length > 8 ? `, …${a.unreached.length - 8} more` : ""}`);
      }
    }
    out.push("");
    out.push("</details>");
  }

  if (r.testModules.length > 0) {
    const symbolCount = r.testModules.reduce((n, m) => n + m.symbols.length, 0);
    const files = new Set(r.testModules.flatMap((m) => m.files));
    out.push("<details>");
    out.push(`<summary>${plural(files.size, "test suite")} also ${files.size === 1 ? "references" : "reference"} this code</summary>`);
    out.push("");
    out.push(`${plural(symbolCount, "symbol")}, kept out of the diagram and the table so they cannot crowd out the areas a reviewer has to look at.`);
    out.push("");
    for (const f of [...files].sort().slice(0, 20)) out.push(`- \`${f}\``);
    if (files.size > 20) out.push(`- …${files.size - 20} more`);
    out.push("");
    out.push("</details>");
  }

  return out;
}

/**
 * What the report cannot see. These are the lines that keep a diagram honest: a
 * reader who is not told that four changed files are unindexed will read "no
 * dependents" as "safe".
 */
function caveatLines(r: BlastReport): string[] {
  const out: string[] = [];
  if (r.deleted.length > 0) {
    out.push(
      `⚠️ ${plural(r.deleted.length, "deleted file")} (${r.deleted.slice(0, 5).join(", ")}) — ` +
        "their dependents cannot be computed from a graph built at this commit, since the files are gone from it.",
    );
  }
  if (r.unindexed.length > 0) {
    out.push(
      `⚠️ ${plural(r.unindexed.length, "changed file")} not in the graph (${r.unindexed.slice(0, 5).join(", ")}) — ` +
        "no parser claims the extension, or the index predates the file.",
    );
  }
  return out;
}

/** Terminal report: same content, no markdown scaffolding. */
export function textReport(r: BlastReport): string {
  const symbols = r.modules.reduce((n, m) => n + m.symbols.length, 0);
  const lines = [
    `blast radius — ${r.basis} (${depthLabel(r.depth)})`,
    `  changed: ${plural(r.changed.length, "file")} in ${plural(r.areas.length, "area")}, ${plural(r.seeds.length, "seed symbol")}`,
    `  impacted: ${plural(symbols, "symbol")} in ${plural(r.modules.length, "area")}`,
    "",
  ];

  for (const a of r.areas) {
    lines.push(`${TEST_GLYPH[a.tests]} ${a.label} — ${plural(a.files.length, "changed file")}, ${a.reached}/${a.behavioural} reached by a test`);
  }
  if (r.areas.length > 0) lines.push("");

  for (const mod of r.modules) {
    lines.push(`${mod.label} — ${plural(mod.symbols.length, "symbol")} in ${plural(mod.files.length, "file")}`);
    for (const s of mod.symbols.slice(0, 25)) {
      lines.push(`  ${s.relation} ← ${s.name} (${s.path}:${s.span}) [depth ${s.depth}]`);
    }
    const hidden = mod.symbols.length - 25;
    if (hidden > 0) lines.push(`  …${plural(hidden, "more symbol")}`);
    lines.push("");
  }
  if (symbols === 0) lines.push("no indexed dependents outside the changed files themselves", "");
  if (r.testModules.length > 0) {
    const files = new Set(r.testModules.flatMap((m) => m.files));
    lines.push(`${plural(files.size, "test suite")} also ${files.size === 1 ? "references" : "reference"} this code (not listed)`, "");
  }
  if (r.reviewers !== undefined && r.reviewers.length > 0) {
    const now = Date.now();
    lines.push("who to tag");
    for (const p of r.reviewers.slice(0, MAX_REVIEWERS)) {
      const why = p.areas.length >= 3 ? `${p.areas.length} areas` : p.areas.join(", ");
      lines.push(`  ${mention(p)} — ${why} · ${plural(p.commits, "commit")}, last ${sinceLabel(p.last, now)}`);
    }
    lines.push("");
  }
  for (const line of caveatLines(r)) lines.push(line.replace(/⚠️ /, "⚠ "), "");
  return lines.join("\n").replace(/\n+$/, "\n");
}

