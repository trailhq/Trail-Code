/**
 * Force-directed graph view. d3-force drives the simulation (Barnes–Hut, so
 * large graphs stay interactive); rendering is persistent SVG — elements are
 * created when data changes and only attributes are updated per tick.
 *
 * Edge grammar (per the design spec):
 *   part of            thick · muted · no arrowhead · short spring
 *   uses-family        solid · open-chevron arrowhead
 *   extends/implements hollow arrowhead
 *   references         faint dots · no arrowhead
 *   inferred edges     dashed (trust is visible)
 * Focus mode: selecting a node paints outgoing edges amber ("depends on"),
 * incoming teal ("depended on by"), labels the verbs on just those edges,
 * and fades the rest of the graph.
 */
import {
  forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide,
  type Simulation, type SimulationNodeDatum,
} from "d3-force";
import { type VizGraph, type VizEdge, type NodeOwner, famOf, REST, chipKey, colorToken, cvar } from "./data.js";
import { initials } from "./detail.js";

interface SimNode extends SimulationNodeDatum {
  id: string;
  name: string;
  type: string;
  deg: number;
  r: number;
  owners?: NodeOwner[];
  fx?: number | null;
  fy?: number | null;
}

interface SimEdge {
  source: SimNode;
  target: SimNode;
  relation: string;
  description?: string;
  confidence?: string;
}

const NS = "http://www.w3.org/2000/svg";

/** Initials shown on a bubble before the rest become a count. Two faces read as
 * "someone else owns this"; five read as a pie chart nobody asked for. */
const MAX_BADGES = 2;

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/**
 * The contributor stack on a bubble: up to {@link MAX_BADGES} sets of initials,
 * then a `+N`, fanned out from the node's upper right.
 *
 * Drawn once at build time and only shown or hidden afterwards, because the
 * simulation moves the parent group rather than these — a per-tick redraw of two
 * circles per node is the one thing that would make a large graph stutter.
 */
function ownerBadges(node: SimNode): SVGGElement | null {
  const owners = node.owners ?? [];
  if (owners.length === 0) return null;
  const shown = owners.slice(0, MAX_BADGES);
  const rest = owners.length - shown.length;
  const chips = [...shown.map((o) => initials(o.handle ?? o.name)), ...(rest > 0 ? [`+${rest}`] : [])];

  const g = el("g", { "pointer-events": "none" });
  chips.forEach((text, i) => {
    // A 45° fan off the top-right, one radius out, so the stack never covers the
    // node's own colour and never collides with the name under it.
    const cx = node.r * 0.72 + i * 13;
    const cy = -node.r * 0.72 + i * 8;
    g.appendChild(el("circle", { cx, cy, r: 8, fill: cvar("--panel"), stroke: cvar("--con"), "stroke-width": 1.2 }));
    const t = el("text", {
      x: cx, y: cy + 3, "text-anchor": "middle", "font-size": 7.5, "font-weight": 700, fill: cvar("--con"),
    });
    t.textContent = text;
    const title = el("title", {});
    title.textContent = owners.map((o) => `${o.handle ? `@${o.handle}` : o.name} — ${o.commits} commits`).join("\n");
    g.append(t, title);
  });
  return g;
}

export class GraphView {
  private svg: SVGSVGElement;
  private defs!: SVGDefsElement;
  private viewport!: SVGGElement;
  private sim: Simulation<SimNode, undefined> | null = null;
  private nodes: SimNode[] = [];
  private edges: SimEdge[] = [];
  private edgeEls: { path: SVGPathElement; label: SVGTextElement; edge: SimEdge }[] = [];
  private nodeEls: { group: SVGGElement; circle: SVGCircleElement; ring: SVGCircleElement; label: SVGTextElement; badges: SVGGElement | null; node: SimNode }[] = [];
  private view = { x: 0, y: 0, k: 1 };
  /** True once the pointer moved past DRAG_THRESHOLD_PX since the last pointerdown:
   * the trailing `click` of a pan is then not a click on empty space. */
  private panMoved = false;
  private tab: "context" | "code" = "context";
  selected: string | null = null;
  query = "";
  hiddenRels: Record<string, boolean> = {};
  hiddenTypes: Record<string, boolean> = {};
  /** The contributor badges on each bubble. A decoration, not a filter — toggling
   * it never changes which nodes are on the canvas. */
  showOwners = true;
  onSelect: (id: string | null) => void = () => {};

  constructor(svg: SVGSVGElement) {
    this.svg = svg;
    this.buildChrome();
    this.bindPanZoom();
  }

  private buildChrome(): void {
    this.svg.textContent = "";
    this.defs = el("defs", {});
    this.svg.appendChild(this.defs);
    this.viewport = el("g", {});
    this.svg.appendChild(this.viewport);
    // A pan ends in a `click` on the svg too; only a still click on empty space deselects.
    this.svg.addEventListener("click", () => {
      if (this.panMoved) { this.panMoved = false; return; }
      this.select(null);
    });
  }

  private ensureMarkers(): void {
    this.defs.textContent = "";
    const chevron = el("marker", { id: "arr", viewBox: "0 0 10 10", refX: 8, refY: 5, markerWidth: 4.5, markerHeight: 4.5, orient: "auto-start-reverse" });
    chevron.appendChild(el("path", { d: "M2,1.5L8.5,5L2,8.5", fill: "none", stroke: cvar("--edge"), "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", opacity: 0.75 }));
    const hollow = el("marker", { id: "arrH", viewBox: "0 0 12 12", refX: 10, refY: 6, markerWidth: 6.5, markerHeight: 6.5, orient: "auto-start-reverse" });
    hollow.appendChild(el("path", { d: "M1.5,1.5L10.5,6L1.5,10.5z", fill: cvar("--canvas"), stroke: cvar("--edge"), "stroke-width": 1.4 }));
    const out = el("marker", { id: "arrOut", viewBox: "0 0 10 10", refX: 8, refY: 5, markerWidth: 5, markerHeight: 5, orient: "auto-start-reverse" });
    out.appendChild(el("path", { d: "M1,1L9,5L1,9z", fill: cvar("--fil") }));
    const inn = el("marker", { id: "arrIn", viewBox: "0 0 10 10", refX: 8, refY: 5, markerWidth: 5, markerHeight: 5, orient: "auto-start-reverse" });
    inn.appendChild(el("path", { d: "M1,1L9,5L1,9z", fill: cvar("--accent") }));
    for (const m of [chevron, hollow, out, inn]) this.defs.appendChild(m);
  }

  /** Load (or morph into) a new dataset. Nodes keep their positions by id. */
  setData(graph: VizGraph, tab: "context" | "code"): void {
    this.tab = tab;
    const prev = new Map(this.nodes.map((n) => [n.id, n]));
    const deg: Record<string, number> = {};
    for (const e of graph.edges) {
      deg[e.source] = (deg[e.source] ?? 0) + 1;
      deg[e.target] = (deg[e.target] ?? 0) + 1;
    }
    const W = this.svg.clientWidth || 800;
    const H = this.svg.clientHeight || 600;
    this.nodes = graph.nodes.map((n, i) => {
      const p = prev.get(n.id);
      const angle = (i / Math.max(1, graph.nodes.length)) * Math.PI * 2;
      const d = deg[n.id] ?? 0;
      return {
        id: n.id, name: n.name, type: n.type, owners: n.owners,
        deg: d, r: 11 + Math.min(13, d * 2.6),
        x: p?.x ?? W / 2 + Math.cos(angle) * Math.min(W, H) / 4,
        y: p?.y ?? H / 2 + Math.sin(angle) * Math.min(W, H) / 4,
        vx: p?.vx ?? 0, vy: p?.vy ?? 0,
      };
    });
    const byId = new Map(this.nodes.map((n) => [n.id, n]));
    this.edges = graph.edges
      .map((e: VizEdge) => ({
        source: byId.get(e.source)!, target: byId.get(e.target)!,
        relation: e.relation, description: e.description, confidence: e.confidence,
      }))
      .filter((e) => e.source && e.target);

    this.sim?.stop();
    this.sim = forceSimulation(this.nodes)
      .force("charge", forceManyBody().strength(-220))
      .force("link", forceLink(this.edges as unknown as { source: SimNode; target: SimNode }[])
        .distance((l) => REST[famOf((l as unknown as SimEdge).relation)])
        .strength(0.5))
      .force("center", forceCenter(W / 2, H / 2))
      .force("collide", forceCollide<SimNode>().radius((n) => n.r + 6))
      .on("tick", () => this.tick());

    this.buildElements();
    this.restyle();
  }

  private buildElements(): void {
    this.ensureMarkers();
    this.viewport.textContent = "";
    this.edgeEls = this.edges.map((edge) => {
      const path = el("path", { fill: "none", "stroke-linecap": "round" });
      const title = el("title", {});
      title.textContent = edge.relation.replace(/_/g, " ") + (edge.description ? ` — ${edge.description}` : "");
      path.appendChild(title);
      const label = el("text", { "text-anchor": "middle", "font-size": 9.5, "font-weight": 700, "stroke-width": 3, "paint-order": "stroke", display: "none" });
      label.textContent = edge.relation.replace(/_/g, " ");
      this.viewport.appendChild(path);
      this.viewport.appendChild(label);
      return { path, label, edge };
    });
    this.nodeEls = this.nodes.map((node) => {
      const group = el("g", { cursor: "pointer" });
      const ring = el("circle", { fill: "none", "stroke-width": 1.6, opacity: 0, r: node.r + 5 });
      const circle = el("circle", { r: node.r, opacity: 0.92 });
      const label = el("text", { y: node.r + 15, "text-anchor": "middle", "font-size": 11.5, "font-weight": 600 });
      label.textContent = node.name;
      const badges = ownerBadges(node);
      group.append(ring, circle, label);
      if (badges) group.appendChild(badges);
      group.addEventListener("click", (ev) => { ev.stopPropagation(); this.select(node.id); });
      this.bindDrag(group, node);
      this.viewport.appendChild(group);
      return { group, circle, ring, label, badges, node };
    });
  }

  private tick(): void {
    for (const { path, label, edge } of this.edgeEls) {
      const a = edge.source, b = edge.target;
      const dx = (b.x ?? 0) - (a.x ?? 0), dy = (b.y ?? 0) - (a.y ?? 0);
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const ux = dx / d, uy = dy / d;
      const sx = (a.x ?? 0) + ux * (a.r + 2), sy = (a.y ?? 0) + uy * (a.r + 2);
      const tx = (b.x ?? 0) - ux * (b.r + 6), ty = (b.y ?? 0) - uy * (b.r + 6);
      const mx = (sx + tx) / 2 - uy * 10, my = (sy + ty) / 2 + ux * 10;
      path.setAttribute("d", `M${sx},${sy} Q${mx},${my} ${tx},${ty}`);
      label.setAttribute("x", String((sx + tx) / 2 - uy * 14));
      label.setAttribute("y", String((sy + ty) / 2 + ux * 14));
    }
    for (const { group, node } of this.nodeEls) {
      group.setAttribute("transform", `translate(${node.x ?? 0},${node.y ?? 0})`);
    }
  }

  /** Re-apply all style attributes (theme, filters, focus, search). */
  restyle(): void {
    this.ensureMarkers();
    const neighbors = new Set<string>();
    if (this.selected) {
      for (const e of this.edges) {
        if (e.source.id === this.selected) neighbors.add(e.target.id);
        if (e.target.id === this.selected) neighbors.add(e.source.id);
      }
    }
    const q = this.query.toLowerCase();
    const nodeShown = (n: SimNode) => !this.hiddenTypes[n.type];

    for (const { path, label, edge } of this.edgeEls) {
      const visible = nodeShown(edge.source) && nodeShown(edge.target) && !this.hiddenRels[chipKey(edge.relation)];
      path.style.display = visible ? "" : "none";
      label.setAttribute("display", "none");
      if (!visible) continue;
      const fam = famOf(edge.relation);
      let stroke = cvar("--edge"), width = 1.3, dash = "none", opacity = 0.5, marker = "url(#arr)";
      if (fam === "structure") { width = 2.4; opacity = 0.32; marker = "none"; }
      else if (fam === "dependency") { width = 1.5; opacity = 0.55; }
      else if (fam === "contract") { opacity = 0.55; marker = "url(#arrH)"; }
      else { dash = "2 5"; width = 1.2; opacity = 0.28; marker = "none"; }
      if (edge.confidence === "inferred") dash = "5 4";
      if (q) opacity = 0.12;
      const role = this.selected
        ? (edge.source.id === this.selected ? "out" : edge.target.id === this.selected ? "in" : "far")
        : "none";
      if (role === "out") { stroke = cvar("--fil"); opacity = 0.95; width += 0.7; marker = "url(#arrOut)"; }
      else if (role === "in") { stroke = cvar("--accent"); opacity = 0.95; width += 0.7; marker = "url(#arrIn)"; }
      else if (role === "far") { opacity = 0.06; }
      path.setAttribute("stroke", stroke);
      path.setAttribute("stroke-width", String(width));
      path.setAttribute("stroke-dasharray", dash);
      path.setAttribute("opacity", String(opacity));
      if (marker === "none") path.removeAttribute("marker-end");
      else path.setAttribute("marker-end", marker);
      if (role === "out" || role === "in") {
        label.removeAttribute("display");
        label.setAttribute("fill", stroke);
        label.setAttribute("stroke", cvar("--canvas"));
      }
    }

    for (const { group, circle, ring, label, badges, node } of this.nodeEls) {
      const shown = nodeShown(node);
      group.style.display = shown ? "" : "none";
      if (!shown) continue;
      const match = !q || node.name.toLowerCase().includes(q);
      let opacity = match ? 1 : 0.22;
      if (this.selected && node.id !== this.selected && !neighbors.has(node.id)) opacity = Math.min(opacity, 0.2);
      group.setAttribute("opacity", String(opacity));
      const color = cvar(colorToken(this.tab, node.type));
      circle.setAttribute("fill", color);
      ring.setAttribute("stroke", color);
      ring.setAttribute("opacity", node.id === this.selected ? "0.55" : "0");
      label.setAttribute("fill", cvar("--ink"));
      if (badges) badges.style.display = this.showOwners ? "" : "none";
    }
  }

  select(id: string | null): void {
    this.selected = id;
    this.restyle();
    this.onSelect(id);
  }

  /** Center the view on a node and select it (used by search). */
  focus(id: string): void {
    const node = this.nodes.find((n) => n.id === id);
    if (!node) return;
    const W = this.svg.clientWidth, H = this.svg.clientHeight;
    this.view.k = Math.max(this.view.k, 1.4);
    this.view.x = W / 2 - (node.x ?? 0) * this.view.k;
    this.view.y = H / 2 - (node.y ?? 0) * this.view.k;
    this.applyView();
    this.select(id);
  }

  firstMatch(): SimNode | undefined {
    const q = this.query.toLowerCase();
    return this.nodes.find((n) => !this.hiddenTypes[n.type] && n.name.toLowerCase().includes(q));
  }

  private applyView(): void {
    this.viewport.setAttribute("transform", `translate(${this.view.x},${this.view.y}) scale(${this.view.k})`);
  }

  zoomBy(factor: number): void {
    const W = this.svg.clientWidth / 2, H = this.svg.clientHeight / 2;
    const k = Math.max(0.35, Math.min(3, this.view.k * factor));
    this.view.x = W - (W - this.view.x) * (k / this.view.k);
    this.view.y = H - (H - this.view.y) * (k / this.view.k);
    this.view.k = k;
    this.applyView();
  }

  resetView(): void {
    this.view = { x: 0, y: 0, k: 1 };
    this.applyView();
  }

  reheat(): void {
    this.sim?.alpha(0.6).restart();
  }

  private bindDrag(group: SVGGElement, node: SimNode): void {
    group.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      group.setPointerCapture(ev.pointerId);
      const move = (mv: PointerEvent) => {
        const rect = this.svg.getBoundingClientRect();
        node.fx = (mv.clientX - rect.left - this.view.x) / this.view.k;
        node.fy = (mv.clientY - rect.top - this.view.y) / this.view.k;
        this.sim?.alphaTarget(0.25).restart();
      };
      const up = () => {
        node.fx = null; node.fy = null;
        this.sim?.alphaTarget(0);
        group.removeEventListener("pointermove", move);
        group.removeEventListener("pointerup", up);
      };
      group.addEventListener("pointermove", move);
      group.addEventListener("pointerup", up);
    });
  }

  private bindPanZoom(): void {
    const DRAG_THRESHOLD_PX = 4;
    let panStart: { x: number; y: number } | null = null;
    let downAt = { x: 0, y: 0 };
    this.svg.addEventListener("pointerdown", (ev) => {
      panStart = { x: ev.clientX - this.view.x, y: ev.clientY - this.view.y };
      downAt = { x: ev.clientX, y: ev.clientY };
      this.panMoved = false;
    });
    this.svg.addEventListener("pointermove", (ev) => {
      if (!panStart) return;
      if (!this.panMoved && Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) > DRAG_THRESHOLD_PX) this.panMoved = true;
      this.view.x = ev.clientX - panStart.x;
      this.view.y = ev.clientY - panStart.y;
      this.applyView();
    });
    window.addEventListener("pointerup", () => { panStart = null; });
    this.svg.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const rect = this.svg.getBoundingClientRect();
      const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
      const k = Math.max(0.35, Math.min(3, this.view.k * Math.exp(-ev.deltaY * 0.0016)));
      this.view.x = px - (px - this.view.x) * (k / this.view.k);
      this.view.y = py - (py - this.view.y) * (k / this.view.k);
      this.view.k = k;
      this.applyView();
    }, { passive: false });
  }
}
