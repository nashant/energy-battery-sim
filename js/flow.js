// Animated power-flow diagram: Grid, House, Battery, with three edges.
// Charge and discharge never occur in the same slot (one cycle per day), so the
// Grid<->Battery edge can carry both directions on one path without ambiguity.

const NODES = {
  grid: { x: 90, y: 190, label: 'Grid' },
  house: { x: 400, y: 88, label: 'House' },
  batt: { x: 400, y: 292, label: 'Battery' },
};

const EDGES = [
  { id: 'gh', from: 'grid', to: 'house' },
  { id: 'gb', from: 'grid', to: 'batt' },
  { id: 'bh', from: 'batt', to: 'house' },
];

const SVG_NS = 'http://www.w3.org/2000/svg';
const el = (n, attrs = {}) => {
  const e = document.createElementNS(SVG_NS, n);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

export class FlowDiagram {
  constructor(host) {
    this.host = host;
    this.build();
  }

  build() {
    this.host.innerHTML = '';
    const svg = el('svg', { viewBox: '0 0 520 380', class: 'flow-svg' });
    this.svg = svg;

    const defs = el('defs');
    defs.innerHTML = `
      <marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5"
              orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker>`;
    svg.appendChild(defs);

    this.edges = {};
    for (const e of EDGES) {
      const a = NODES[e.from], b = NODES[e.to];
      const g = el('g');
      const base = el('line', {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        class: 'flow-base', 'stroke-width': 5,
      });
      const live = el('line', {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        class: 'flow-live', 'stroke-width': 0, 'marker-end': 'url(#ah)',
      });
      const lbl = el('text', {
        x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 10, class: 'flow-label',
        'text-anchor': 'middle',
      });
      g.append(base, live, lbl);
      svg.appendChild(g);
      this.edges[e.id] = { base, live, lbl, a, b };
    }

    this.nodes = {};
    for (const [k, n] of Object.entries(NODES)) {
      const g = el('g');
      const r = el('rect', {
        x: n.x - 62, y: n.y - 38, width: 124, height: 76, rx: 12,
        class: `node node-${k}`,
      });
      const t = el('text', { x: n.x, y: n.y - 12, class: 'node-label', 'text-anchor': 'middle' });
      t.textContent = n.label;
      const v = el('text', { x: n.x, y: n.y + 12, class: 'node-value', 'text-anchor': 'middle' });
      const s = el('text', { x: n.x, y: n.y + 29, class: 'node-sub', 'text-anchor': 'middle' });
      g.append(r, t, v, s);
      svg.appendChild(g);
      this.nodes[k] = { value: v, sub: s, rect: r };
    }

    // battery state-of-charge bar
    this.socTrack = el('rect', { x: 338, y: 340, width: 124, height: 12, rx: 6, class: 'soc-track' });
    this.socFill = el('rect', { x: 338, y: 340, width: 0, height: 12, rx: 6, class: 'soc-fill' });
    this.socText = el('text', { x: 400, y: 370, class: 'node-sub', 'text-anchor': 'middle' });
    svg.append(this.socTrack, this.socFill, this.socText);

    this.host.appendChild(svg);
  }

  // kWh per half-hour -> kW, and a stroke width that stays readable at low power
  static width(kwh) {
    const kw = kwh * 2;
    return kw <= 0.001 ? 0 : Math.min(22, 2.5 + Math.sqrt(kw) * 3.4);
  }

  setEdge(id, kwh, reverse, cls) {
    const e = this.edges[id];
    const w = FlowDiagram.width(kwh);
    e.live.setAttribute('stroke-width', w);
    e.live.setAttribute('class', `flow-live ${w > 0 ? 'active' : ''} ${cls || ''}`);
    // direction: swap the endpoints so the arrow marker points the right way
    const [p, q] = reverse ? [e.b, e.a] : [e.a, e.b];
    e.live.setAttribute('x1', p.x); e.live.setAttribute('y1', p.y);
    e.live.setAttribute('x2', q.x); e.live.setAttribute('y2', q.y);
    // dash cycle time shortens as power rises, so faster flow reads as more power
    const kw = kwh * 2;
    e.live.style.animationDuration = w > 0 ? `${Math.max(0.35, 2.2 - Math.min(1.7, kw / 6))}s` : '0s';
    e.lbl.textContent = w > 0 ? `${kw.toFixed(2)} kW` : '';
    e.lbl.setAttribute('class', `flow-label ${cls || ''}`);
  }

  update(slot, cap) {
    if (!slot) return;
    this.setEdge('gh', slot.gridToHouse, false, 'import');
    this.setEdge('bh', slot.disLoad, false, 'battery');
    // charging and exporting share the Grid<->Battery edge; they are mutually exclusive
    if (slot.chg > 1e-9) this.setEdge('gb', slot.chg, false, 'import');
    else this.setEdge('gb', slot.disExp, true, 'export');

    const net = slot.gridImp - slot.gridExp;
    this.nodes.grid.value.textContent = slot.gridExp > 1e-9
      ? `${(slot.gridExp * 2).toFixed(2)} kW out`
      : `${(slot.gridImp * 2).toFixed(2)} kW in`;
    this.nodes.grid.sub.textContent =
      `${slot.imp.toFixed(2)}p in · ${slot.exp.toFixed(2)}p out`;
    this.nodes.grid.rect.setAttribute(
      'class', `node node-grid ${slot.gridExp > 1e-9 ? 'exporting' : (net > 1e-9 ? 'importing' : '')}`);

    this.nodes.house.value.textContent = `${(slot.load * 2).toFixed(2)} kW`;
    this.nodes.house.sub.textContent = slot.disLoad > 1e-9
      ? `${(100 * slot.disLoad / Math.max(slot.load, 1e-9)).toFixed(0)}% from battery`
      : 'all from grid';

    const flow = slot.chg > 1e-9 ? slot.chg : -(slot.disLoad + slot.disExp);
    this.nodes.batt.value.textContent = Math.abs(flow) < 1e-9
      ? 'idle' : `${flow > 0 ? '+' : ''}${(flow * 2).toFixed(2)} kW`;
    this.nodes.batt.sub.textContent = `${slot.soc.toFixed(1)} kWh stored`;
    this.nodes.batt.rect.setAttribute(
      'class', `node node-batt ${slot.chg > 1e-9 ? 'charging' : (flow < -1e-9 ? 'discharging' : '')}`);

    this.socFill.setAttribute('width', 124 * Math.min(1, slot.soc / cap));
    this.socText.textContent = `state of charge ${slot.socPct.toFixed(0)}% of ${cap} kWh`;
  }
}
