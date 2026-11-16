/**
 * A JSX element is how a React component gets called (#382).
 *
 * `<Widget/>` and `Widget({children})` are the same invocation — the runtime does
 * the second when it sees the first — but only one of them parses as a
 * `call_expression`, so only one produced an edge. Since components are
 * essentially always used as elements, that left the component layer with no
 * incoming edges at all: `callers` reported none, and `blast` returned an empty
 * impact set for a diff that changed a provider five test files mount.
 *
 * Reproduced from a real merged pull request whose source change touched one
 * context provider and required updating the five test files that mount it. All
 * five imported it, all five were indexed, and the blast radius was `0 symbols in
 * 0 areas`; `grep` found them immediately, which is what pins this as a missing
 * edge rather than a missing file.
 *
 * What these pin:
 *  - the edge, for both element spellings and for `.jsx` as well as `.tsx`;
 *  - one edge per usage — the closing tag is not a second one;
 *  - a class component, which is a component too;
 *  - the two names that are not symbols: a lowercase host element, and a dotted
 *    element name with no receiver to type.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { tmpRepo } from "./helpers.js";
import type { GraphV1 } from "../src/graph/types.js";

async function buildJsx(files: Record<string, string>): Promise<GraphV1> {
  const root = tmpRepo("jsx-");
  for (const [rel, src] of Object.entries(files)) {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, src);
  }
  await buildGraph(root, { reuse: false });
  const graph = readGraph(wiringPath(join(root, "graft")));
  assert.ok(graph, "graph built");
  return graph!;
}

function callEdges(graph: GraphV1): Array<{ from: string; to: string }> {
  const name = (id: string): string => graph.nodes.find((n) => n.id === id)?.name ?? id;
  return graph.edges
    .filter((e) => e.relation === "calls")
    .map((e) => ({ from: name(e.source), to: name(e.target) }));
}

test("jsx: mounting a component makes the consumer a caller, both spellings and both extensions", async () => {
  const graph = await buildJsx({
    "lib/widget.tsx": `
export function Widget({ children }: { children?: unknown }) {
  return children;
}
`,
    "app/paired.tsx": `
import { Widget } from '../lib/widget';

export function renderPaired() {
  return <Widget>hi</Widget>;
}
`,
    "app/selfclosing.tsx": `
import { Widget } from '../lib/widget';

export function renderSelfClosing() {
  return <Widget />;
}
`,
    "app/legacy.jsx": `
import { Widget } from '../lib/widget';

export function renderFromJsxFile() {
  return <Widget>hi</Widget>;
}
`,
    "app/direct.tsx": `
import { Widget } from '../lib/widget';

export function renderAsCall() {
  return Widget({ children: 'hi' });
}
`,
  });
  const calls = callEdges(graph);
  const into = calls.filter((c) => c.to === "Widget").map((c) => c.from).sort();
  assert.deepEqual(into, [
    "renderAsCall",
    "renderFromJsxFile",
    "renderPaired",
    "renderSelfClosing",
  ]);
  // Exactly one edge per consumer: `</Widget>` closes the usage the opening tag
  // already recorded, and a paired element must not weigh twice as much as a
  // self-closing one in anything that ranks by in-degree.
  assert.equal(into.length, new Set(into).size, "one edge per mount, not one per tag");
});

test("jsx: a class component is a component", async () => {
  const graph = await buildJsx({
    "lib/boundary.tsx": `
import React from 'react';

export class Boundary extends React.Component {
  render() {
    return null;
  }
}
`,
    "app/shell.tsx": `
import { Boundary } from '../lib/boundary';

export function Shell() {
  return <Boundary />;
}
`,
  });
  assert.ok(
    callEdges(graph).some((c) => c.from === "Shell" && c.to === "Boundary"),
    "an element whose target is a class resolves like one whose target is a function",
  );
});

test("jsx: a host element and a dotted element name are not symbols", async () => {
  const graph = await buildJsx({
    "lib/panel.tsx": `
export function Panel({ children }: { children?: unknown }) {
  return children;
}
`,
    "lib/ui.tsx": `
export function Button() {
  return null;
}
`,
    "app/page.tsx": `
import { Panel } from '../lib/panel';
import * as UI from '../lib/ui';

export function Page() {
  return (
    <div className="page">
      <span>title</span>
      <Panel>body</Panel>
      <UI.Button />
    </div>
  );
}
`,
  });
  const from = callEdges(graph).filter((c) => c.from === "Page").map((c) => c.to).sort();
  // `div`/`span` are host elements React passes to the DOM as strings, so they are
  // not names in scope at all. `UI.Button` is a name in scope, but reaching it needs
  // the namespace import's type — resolving the trailing `Button` on its own is the
  // guess resolve.ts refuses to make for `ui.button()` either.
  assert.deepEqual(from, ["Panel"]);
});

test("jsx: the intrinsic test is JSX's own rule, not an A-Z check", async () => {
  // TypeScript states the rule as `ch >= 'a' && ch <= 'z' || name.includes("-")`
  // (isIntrinsicJsxName). Asking the opposite question — "does it start A-Z" — is not
  // the complement: it drops `_Widget`, `$Widget` and every non-ASCII capital, all of
  // which are ordinary bindings the grammar hands back as plain `identifier`. A
  // French-named component is not a DOM tag.
  const graph = await buildJsx({
    "lib/parts.tsx": `
export function Écran() {
  return null;
}

export function _Widget() {
  return null;
}

export function $Widget() {
  return null;
}
`,
    "app/page.tsx": `
import { Écran, _Widget, $Widget } from '../lib/parts';

export function Page() {
  return (
    <div className="page">
      <Écran />
      <_Widget />
      <$Widget />
      <my-element />
      <svg:circle />
    </div>
  );
}
`,
  });
  const from = callEdges(graph).filter((c) => c.from === "Page").map((c) => c.to).sort();
  // `my-element` is a custom element and `svg:circle` a namespaced name — both intrinsic,
  // and the namespaced one does not even arrive as an `identifier`.
  assert.deepEqual(from, ["$Widget", "_Widget", "Écran"]);
});
