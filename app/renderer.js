import {
  DEFAULT_COLORS,
  computeLayout,
  createIndexes,
  getBounds,
  getArchitectureLayer,
  getNodeColor,
  getNodeKindLabel,
  getNodeGeometry,
  getNodeSearchText,
  getVisibleEdgeIds,
  getVisibleNodeIds
} from './graph-core.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_VIEW = { x: 0, y: 0, scale: 1, selectedId: null, search: '', activeKinds: new Set(), activeGroups: new Set(), activeEdgeKinds: new Set(), focusIds: null, positions: {}, labelEdges: false, layoutSpacing: 1, layoutMode: 'layered', nodeScale: 1, labelScale: 1, edgeOpacity: 0.85, inferredOpacity: 0.70, dottedOpacity: 0.85, solidWidth: 2.2, dashedWidth: 2.2, areaWidth: 1.5, areaNameSize: 23, edgeLabelMode: 'off', backgroundColor: '#18191b', animationEnabled: false, animationSpeed: 1, nodeLimit: 650, isolationMode: 'all', showInferred: true, linkDistance: 180, repulsion: 1 };

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function setAttributes(element, attributes) {
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) element.setAttribute(key, String(value));
  }
}

function createSvg(tag, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  setAttributes(element, attributes);
  return element;
}

function truncate(value, maxLength) {
  const text = String(value ?? '');
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function clonePositions(positions) {
  const result = {};
  if (!isRecord(positions)) return result;
  for (const [id, position] of Object.entries(positions)) {
    if (!isRecord(position) || !Number.isFinite(position.x) || !Number.isFinite(position.y)) continue;
    result[id] = { x: position.x, y: position.y, pinned: position.pinned === true };
  }
  return result;
}

function setFrom(value) {
  if (value instanceof Set) return new Set(value);
  if (Array.isArray(value)) return new Set(value);
  return new Set();
}

function clamp(value, fallback, minimum, maximum) {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

function shouldShowEdgeLabel(mode, active) {
  if (mode === 'always') return true;
  if (mode === 'active') return Boolean(active);
  if (mode === 'off') return false;
  return Boolean(active);
}

export class GraphRenderer {
  constructor(svg, callbacks = {}) {
    this.svg = svg;
    this.callbacks = callbacks;
    this.document = null;
    this.indexes = createIndexes({ nodes: [], edges: [] });
    this.view = { ...DEFAULT_VIEW, activeKinds: new Set(), activeGroups: new Set(), activeEdgeKinds: new Set(), positions: {} };
    this.positions = {};
    this.layout = {};
    this.layoutKey = null;
    this.edgeOffsets = new Map();
    this.edgeRoutes = new Map();
    this.edgeObstacles = [];
    this.visibleNodeIds = new Set();
    this.visibleEdgeIds = new Set();
    this.drag = null;
    this.frame = null;
    this.root = null;
    this.edgeLayer = null;
    this.nodeLayer = null;
    this.boundHandlers = {};
    this.setup();
  }

  setup() {
    this.svg.replaceChildren();
    this.svg.setAttribute('role', 'application');
    this.svg.setAttribute('tabindex', '0');
    this.svg.setAttribute('aria-label', 'Interactive codebase knowledge graph');
    const defs = createSvg('defs');
    this.root = createSvg('g', { class: 'kg-map-viewport' });
    this.layerGuides = createSvg('g', { class: 'kg-layer-guides', 'aria-hidden': 'true', 'pointer-events': 'none' });
    this.edgeLayer = createSvg('g', { class: 'kg-map-edges', 'aria-hidden': 'true' });
    this.nodeLayer = createSvg('g', { class: 'kg-map-nodes' });
    this.layerLabels = createSvg('g', { class: 'kg-layer-labels', 'aria-hidden': 'true', 'pointer-events': 'none' });
    this.root.append(this.layerGuides, this.edgeLayer, this.layerLabels, this.nodeLayer);
    this.svg.append(defs, this.root);
    this.boundHandlers.pointerDown = (event) => this.onPointerDown(event);
    this.boundHandlers.pointerMove = (event) => this.onPointerMove(event);
    this.boundHandlers.pointerUp = (event) => this.onPointerUp(event);
    this.boundHandlers.pointerCancel = () => this.onPointerCancel();
    this.boundHandlers.wheel = (event) => this.onWheel(event);
    this.boundHandlers.keyDown = (event) => this.onKeyDown(event);
    this.boundHandlers.resize = () => {
      this.scheduleRender();
      if (this.document) this.fit();
    };
    this.svg.addEventListener('pointerdown', this.boundHandlers.pointerDown);
    this.svg.addEventListener('pointermove', this.boundHandlers.pointerMove);
    this.svg.addEventListener('pointerup', this.boundHandlers.pointerUp);
    this.svg.addEventListener('pointercancel', this.boundHandlers.pointerCancel);
    this.svg.addEventListener('wheel', this.boundHandlers.wheel, { passive: false });
    this.svg.addEventListener('keydown', this.boundHandlers.keyDown);
    window.addEventListener('resize', this.boundHandlers.resize);
  }

  setDocument(document) {
    this.document = document;
    this.indexes = createIndexes(document);
    this.layoutKey = null;
    this.edgeOffsets.clear();
    const pairs = new Map();
    for (const edge of document.edges) {
      const key = JSON.stringify([edge.source, edge.target]);
      if (!pairs.has(key)) pairs.set(key, []);
      pairs.get(key).push(edge.id);
    }
    for (const ids of pairs.values()) ids.forEach((id, index) => this.edgeOffsets.set(id, index * 22));
    this.view = { ...this.view, selectedId: null, search: '', focusIds: null, positions: clonePositions(document?.positions) };
    this.positions = clonePositions(document?.positions);
    this.scheduleRender();
  }

  setView(view) {
    const next = { ...this.view, ...(view ?? {}) };
    next.activeKinds = setFrom(next.activeKinds);
    next.activeGroups = setFrom(next.activeGroups);
    next.activeEdgeKinds = setFrom(next.activeEdgeKinds);
    next.focusIds = next.focusIds instanceof Set || Array.isArray(next.focusIds) ? next.focusIds : null;
    next.layoutSpacing = clamp(next.layoutSpacing, 1, 0.65, 1.6);
    next.layoutMode = ['layered', 'auto', 'force', 'grid'].includes(next.layoutMode) ? next.layoutMode : 'layered';
    next.nodeScale = clamp(next.nodeScale, 1, 0.7, 1.6);
    next.labelScale = clamp(next.labelScale, 1, 0.7, 1.6);
    next.edgeOpacity = clamp(next.edgeOpacity, 0.85, 0, 1);
    next.solidWidth = clamp(next.solidWidth, 2.2, 0.1, 6);
    next.dashedWidth = clamp(next.dashedWidth, 2.2, 0.1, 6);
    next.edgeLabelMode = ['light', 'active', 'always', 'off'].includes(next.edgeLabelMode) ? next.edgeLabelMode : 'light';
    next.backgroundColor = /^#[0-9a-f]{6}$/i.test(next.backgroundColor) ? next.backgroundColor : '#18191b';
    next.animationEnabled = next.animationEnabled !== false;
    next.animationSpeed = clamp(next.animationSpeed, 1, 0.25, 2);
    next.nodeLimit = clamp(next.nodeLimit, 650, 50, 650);
    next.isolationMode = ['all', 'connected', 'isolated'].includes(next.isolationMode) ? next.isolationMode : 'all';
    next.showInferred = next.showInferred !== false;
    next.linkDistance = clamp(next.linkDistance, 180, 0, 1500);
    next.repulsion = clamp(next.repulsion, 1, -10, 10);
    next.scale = clamp(next.scale, 1, 0.08, 3);
    next.x = Number.isFinite(next.x) ? next.x : 0;
    next.y = Number.isFinite(next.y) ? next.y : 0;
    this.positions = next.positions ? clonePositions(next.positions) : clonePositions(this.positions);
    next.positions = this.positions;
    this.view = next;
    this.scheduleRender();
  }

  getView() {
    return {
      ...this.view,
      activeKinds: new Set(this.view.activeKinds),
      activeGroups: new Set(this.view.activeGroups),
      activeEdgeKinds: new Set(this.view.activeEdgeKinds),
      focusIds: this.view.focusIds ? new Set(this.view.focusIds) : null,
      positions: clonePositions(this.positions)
    };
  }

  getSize() {
    const rect = this.svg.getBoundingClientRect();
    return {
      width: rect.width || this.svg.clientWidth || window.innerWidth || 1000,
      height: rect.height || this.svg.clientHeight || window.innerHeight || 700
    };
  }

  scheduleRender() {
    if (this.frame !== null) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = null;
      this.render();
    });
  }

  render() {
    if (!this.document) return;
    const size = this.getSize();
    this.svg.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`);
    this.visibleNodeIds = getVisibleNodeIds(this.document, this.view, this.indexes, this.callbacks.visibleLimit ?? this.document.nodes.length);
    // Idle visibility controls do not remove relationships from the layout.
    this.visibleEdgeIds = getVisibleEdgeIds(this.document, { ...this.view, showInferred: true }, this.visibleNodeIds, this.indexes);
    const visibleNodes = this.document.nodes.filter((node) => this.visibleNodeIds.has(node.id));
    const layoutKey = JSON.stringify([visibleNodes.map(node => node.id), [...this.visibleEdgeIds], this.positions, this.view.layoutSpacing, this.view.layoutMode, this.view.nodeScale, this.view.labelScale, this.view.linkDistance, this.view.repulsion, this.view.groupOffsets, this.view.areaNameSize]);
    if (layoutKey !== this.layoutKey) {
      this.layout = computeLayout(this.document, { nodes: visibleNodes, edges: this.document.edges.filter(edge => this.visibleEdgeIds.has(edge.id)), positions: this.positions, indexes: this.indexes, spacing: this.view.layoutSpacing, mode: this.view.layoutMode, labelScale: this.view.labelScale, nodeScale: this.view.nodeScale, linkDistance: this.view.linkDistance, repulsion: this.view.repulsion, areaNameSize: this.view.areaNameSize });
      if (this.view.layoutMode === 'grid') for (const node of visibleNodes) {
        const offset = this.view.groupOffsets?.[getArchitectureLayer(node)];
        if (offset && Number.isFinite(offset.x) && Number.isFinite(offset.y)) {
          this.layout[node.id].x += offset.x;
          this.layout[node.id].y += offset.y;
        }
      }
      this.layoutKey = layoutKey;
      this.edgeRoutes.clear();
      this.edgeObstacles = visibleNodes.map(node => ({ id: node.id, position: this.layout[node.id], geometry: getNodeGeometry(node, { nodeScale: this.view.nodeScale, labelScale: this.view.labelScale }) }));
    }
    this.svg.style.setProperty('--kg-motion-duration', `${Math.max(0.45, 3.2 / this.view.animationSpeed)}s`);
    this.svg.style.backgroundColor = this.view.backgroundColor === '#18191b' ? 'transparent' : this.view.backgroundColor;
    if (this.view.animationEnabled) this.svg.classList.remove('motion-paused');
    else this.svg.classList.add('motion-paused');
    this.edgeLayer.replaceChildren();
    this.edgeLabelPlacements = [];
    this.nodeLayer.replaceChildren();
    this.layerGuides.replaceChildren();
    this.layerLabels.replaceChildren();
    if (['auto', 'layered'].includes(this.view.layoutMode)) {
      const rings = new Map();
      for (const node of visibleNodes) {
        const p = this.layout[node.id];
        const radius = Math.round(Math.hypot(p.x, p.y));
        const key = getArchitectureLayer(node);
        if (!rings.has(key)) rings.set(key, { radii: [], angles: [], name: key, color: getNodeColor(node) });
        rings.get(key).radii.push(radius);
        rings.get(key).angles.push((Math.atan2(p.y, p.x) + Math.PI * 2) % (Math.PI * 2));
      }
      for (const ring of rings.values()) {
        ring.radii.sort((a, b) => a - b);
        ring.radius = this.layout.layerRadii?.[ring.name] ?? ring.radii[Math.floor(ring.radii.length / 2)];
        // Follow the ring in its largest gap, using the same world-space scale
        // as node text instead of growing headings when the graph zooms out.
        ring.angles.sort((a, b) => a - b);
        let gap = -1;
        let center = -Math.PI / 2;
        ring.angles.forEach((angle, index) => {
          const next = ring.angles[(index + 1) % ring.angles.length] + (index === ring.angles.length - 1 ? Math.PI * 2 : 0);
          if (next - angle > gap) { gap = next - angle; center = (angle + next) / 2; }
        });
        const fontSize = (this.view.areaNameSize ?? 23) * this.view.nodeScale * this.view.labelScale;
        const measure = createSvg('text', { 'font-size': fontSize, 'font-family': 'system-ui,sans-serif', 'font-weight': 500, visibility: 'hidden' });
        measure.textContent = ring.name;
        this.layerGuides.append(measure);
        const textWidth = measure.getComputedTextLength?.() || ring.name.length * fontSize * 0.6;
        measure.remove?.();
        const span = Math.min(Math.PI, (textWidth + 10) / Math.max(ring.radius, 1));
        const obstacles = visibleNodes.map(node => ({ p: this.layout[node.id], g: getNodeGeometry(node, { nodeScale: this.view.nodeScale, labelScale: this.view.labelScale }) }));
        let bestHits = Infinity;
        let bestCenter = -Math.PI / 2;
        for (let attempt = 0; attempt < 72; attempt++) {
          const step = Math.ceil(attempt / 2) * Math.PI / 216;
          const candidate = -Math.PI / 2 + (attempt % 2 === 0 ? step : -step);
          let hits = 0;
          for (let sample = 0; sample <= 16; sample++) {
            const angle = candidate + (sample / 16 - 0.5) * span;
            const x = Math.cos(angle) * ring.radius, y = Math.sin(angle) * ring.radius;
            for (const { p, g } of obstacles) {
              if (Math.abs(x - p.x) < g.width / 2 + fontSize && Math.abs(y - p.y) < g.height / 2 + fontSize) hits++;
            }
          }
          if (hits < bestHits) { bestHits = hits; bestCenter = candidate; }
          if (hits === 0) break;
        }
        center = this.layout.layerRadii ? -Math.PI / 2 : bestCenter;
        const gapStart = center - span / 2, gapEnd = center + span / 2;
        this.layerGuides.append(createSvg('path', {
          class: 'kg-layer-ring',
          d: `M ${Math.cos(gapEnd) * ring.radius} ${Math.sin(gapEnd) * ring.radius} A ${ring.radius} ${ring.radius} 0 1 1 ${Math.cos(gapStart) * ring.radius} ${Math.sin(gapStart) * ring.radius}`,
          fill: 'none', stroke: ring.color, 'stroke-opacity': this.view.dottedOpacity ?? 0.85, 'stroke-width': this.view.areaWidth ?? 1.5, 'stroke-dasharray': '0 6', 'stroke-linecap': 'round'
        }));
        const reverse = Math.sin(center) > 0;
        const start = center + (reverse ? span / 2 : -span / 2);
        const end = center + (reverse ? -span / 2 : span / 2);
        const id = `kg-layer-label-${this.layerGuides.children.length}`;
        const arc = createSvg('path', { id, d: `M ${Math.cos(start) * ring.radius} ${Math.sin(start) * ring.radius} A ${ring.radius} ${ring.radius} 0 0 ${reverse ? 0 : 1} ${Math.cos(end) * ring.radius} ${Math.sin(end) * ring.radius}`, fill: 'none', stroke: 'none' });
        const label = createSvg('text', { 'dominant-baseline': 'central', fill: ring.color, 'text-anchor': 'middle', 'font-size': fontSize, 'font-family': 'system-ui,sans-serif', 'font-weight': 500 });
        const textPath = createSvg('textPath', { href: `#${id}`, startOffset: '50%' });
        textPath.textContent = ring.name;
        label.append(textPath);
        this.layerGuides.append(arc);
        this.layerLabels.append(label);
      }
    }
    if (this.view.layoutMode === 'grid') {
      const groups = new Map();
      for (const node of visibleNodes) {
        const name = getArchitectureLayer(node);
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(node);
      }
      for (const [name, nodes] of groups) {
        const bounds = nodes.map(node => {
          const p = this.layout[node.id];
          const g = getNodeGeometry(node, { nodeScale: this.view.nodeScale, labelScale: this.view.labelScale });
          return { left: p.x - g.width / 2, right: p.x + g.width / 2, top: p.y - g.height / 2, bottom: p.y + g.height / 2 };
        });
        let left = Math.min(...bounds.map(b => b.left)) - 28;
        const headingWidth = `${name} · ${nodes.length}`.length * 11 * this.view.labelScale;
        let right = Math.max(...bounds.map(b => b.right)) + 28;
        const extraWidth = Math.max(0, headingWidth + 40 - (right - left));
        left -= extraWidth / 2;
        right += extraWidth / 2;
        const top = Math.min(...bounds.map(b => b.top)) - 64;
        const bottom = Math.max(...bounds.map(b => b.bottom)) + 28;
        const color = getNodeColor(nodes[0]);
        this.layerGuides.append(createSvg('rect', { x: left, y: top, width: right - left, height: bottom - top, rx: 14, fill: '#222426', 'fill-opacity': 0.92, stroke: color, 'stroke-opacity': 0.45, 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }));
        const heading = createSvg('text', { x: left + 20, y: top + 30, fill: color, 'font-size': 18 * this.view.labelScale, 'font-family': 'system-ui,sans-serif', 'font-weight': 600 });
        heading.textContent = `${name} · ${nodes.length}`;
        heading.setAttribute('data-group-name', name);
        heading.setAttribute('pointer-events', 'all');
        heading.style.cursor = 'grab';
        const handle = createSvg('rect', { x: left, y: top, width: right - left, height: 46, fill: 'transparent', 'data-group-name': name, 'pointer-events': 'all' });
        handle.style.cursor = 'grab';
        this.layerLabels.append(handle);
        this.layerLabels.append(heading);
      }
    }
    const drawnEdges = this.document.edges.filter(edge => {
      if (!this.visibleEdgeIds.has(edge.id)) return false;
      const selectedConnection = this.view.selectedId && (edge.source === this.view.selectedId || edge.target === this.view.selectedId);
      if (selectedConnection) return true;
      if (this.view.selectedId) return false;
      if (this.view.edgeDisplay === 'selected') return false;
      return edge.inferred ? this.view.showInferred !== false : this.view.showSolid !== false;
    });
    for (const edge of drawnEdges) this.drawEdge(edge);
    const selectedId = this.view.selectedId;
    const neighbors = this.getNeighborIds(selectedId);
    for (const [index, node] of visibleNodes.entries()) this.drawNode(node, neighbors, index);
    this.applyTransform();
    this.suppressEdgeLabelCollisions();
    this.callbacks.onVisibility?.({
      layers: [...new Map(visibleNodes.map(node => [getArchitectureLayer(node), { name: getArchitectureLayer(node), color: getNodeColor(node) }])).values()],
      visibleNodes: this.visibleNodeIds.size,
      totalNodes: this.document.nodes.length,
      visibleEdges: drawnEdges.length,
      totalEdges: this.document.edges.length,
      truncated: this.visibleNodeIds.size < getVisibleNodeIds(this.document, this.view, this.indexes, Infinity).size
    });
  }

  applyTransform() {
    this.root.setAttribute('transform', `translate(${this.view.x} ${this.view.y}) scale(${this.view.scale})`);
  }

  routeControl(edge, from, to, curve) {
    if (this.edgeRoutes.has(edge.id)) return this.edgeRoutes.get(edge.id);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy) || 1;
    let best = null;
    let bestHits = Infinity;
    const candidates = this.edgeObstacles.length <= 160 ? [curve, -curve, curve + 80, -curve - 80, curve + 180, -curve - 180] : [curve];
    for (const bend of candidates) {
      const control = { x: (from.x + to.x) / 2 - dy / distance * bend, y: (from.y + to.y) / 2 + dx / distance * bend };
      let hits = 0;
      for (const obstacle of this.edgeObstacles) {
        if (obstacle.id === edge.source || obstacle.id === edge.target) continue;
        const { position, geometry } = obstacle;
        const halfWidth = (geometry.boxLike ? geometry.width / 2 : geometry.radius) + 8;
        const halfHeight = (geometry.boxLike ? geometry.height / 2 : geometry.radius) + 8;
        if (position.x + halfWidth < Math.min(from.x, to.x, control.x) || position.x - halfWidth > Math.max(from.x, to.x, control.x) || position.y + halfHeight < Math.min(from.y, to.y, control.y) || position.y - halfHeight > Math.max(from.y, to.y, control.y)) continue;
        for (let step = 1; step < 32; step += 1) {
          const t = step / 32;
          const x = (1 - t) ** 2 * from.x + 2 * (1 - t) * t * control.x + t ** 2 * to.x;
          const y = (1 - t) ** 2 * from.y + 2 * (1 - t) * t * control.y + t ** 2 * to.y;
          if (Math.abs(x - position.x) < halfWidth && Math.abs(y - position.y) < halfHeight) { hits += 1; break; }
        }
        if (hits >= bestHits) break;
      }
      if (hits < bestHits) { best = control; bestHits = hits; }
      if (hits === 0) break;
    }
    this.edgeRoutes.set(edge.id, best);
    return best;
  }

  suppressEdgeLabelCollisions() {
    if (!this.nodeLayer.querySelectorAll || !this.edgeLayer.querySelectorAll) return;
    const occupied = [...this.nodeLayer.querySelectorAll('.kg-node-label, .kg-node-shape, .kg-node-kind'), ...this.layerLabels.querySelectorAll('text')].map(element => element.getBoundingClientRect());
    const intersects = (left, right) => left.left < right.right + 2 && left.right > right.left - 2 && left.top < right.bottom + 2 && left.bottom > right.top - 2;
    for (const { label, textPath, gapPath, gap, reverse } of this.edgeLabelPlacements ?? []) {
      let placed = false;
      for (const offset of [50, 42, 58, 34, 66, 26, 74, 18, 82]) {
        if (offset - gap / 2 < 5 || offset + gap / 2 > 95) continue;
        textPath.setAttribute('startOffset', `${offset}%`);
        const bounds = label.getBoundingClientRect();
        if (occupied.some(other => intersects(bounds, other))) continue;
        const center = reverse ? 100 - offset : offset;
        gapPath.setAttribute('stroke-dasharray', `0 ${center - gap / 2} ${gap} 100`);
        occupied.push(bounds);
        placed = true;
        break;
      }
      if (!placed) {
        label.setAttribute('visibility', 'hidden');
        gapPath.setAttribute('stroke', 'none');
      }
    }
  }

  drawEdge(edge) {
    const from = this.layout[edge.source];
    const to = this.layout[edge.target];
    if (!from || !to) return;
    const selected = this.view.selectedId;
    const active = selected && (edge.source === selected || edge.target === selected);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy) || 1;
    const curve = (edge.source === edge.target ? 34 : Math.min(70, Math.max(18, distance * 0.12))) + (this.edgeOffsets.get(edge.id) ?? 0);
    const control = this.routeControl(edge, from, to, curve);
    const controlX = control.x;
    const controlY = control.y;
    const source = this.edgeBoundary(edge.source, from, { x: controlX, y: controlY });
    const target = this.edgeBoundary(edge.target, to, { x: controlX, y: controlY }, 5);
    const loopNode = getNodeGeometry(this.indexes.nodesById.get(edge.source), { nodeScale: this.view.nodeScale, labelScale: this.view.labelScale });
    const loopTop = from.y - (loopNode.boxLike ? loopNode.height / 2 : loopNode.radius) - 4;
    const pathData = edge.source === edge.target
      ? `M ${from.x - 18} ${loopTop} C ${from.x - curve - 25} ${loopTop - curve - 35}, ${from.x + curve + 25} ${loopTop - curve - 35}, ${from.x + 18} ${loopTop}`
      : `M ${source.x} ${source.y} Q ${controlX} ${controlY} ${target.x} ${target.y}`;
    const path = createSvg('path', {
      d: pathData,
      class: `kg-edge${edge.inferred ? ' is-inferred' : ''}${active ? ' is-active' : ''}`,
      fill: 'none',
      stroke: edge.inferred ? '#c1a778' : '#a1b8ab',
      'stroke-width': active ? Math.max(2.2, edge.inferred ? this.view.dashedWidth : this.view.solidWidth) : (edge.inferred ? this.view.dashedWidth : this.view.solidWidth),
      'stroke-opacity': active ? Math.max(0.72, this.view.edgeOpacity) : (edge.inferred ? (this.view.inferredOpacity ?? this.view.edgeOpacity) : this.view.edgeOpacity),
      'stroke-dasharray': edge.inferred ? '6 5' : undefined,
      'data-edge-id': edge.id
    });
    const title = createSvg('title');
    title.textContent = `${edge.kind}: ${edge.source} → ${edge.target}`;
    path.append(title);
    let edgeLabel;
    if (active || this.view.labelEdges || shouldShowEdgeLabel(this.view.edgeLabelMode, active)) {
      const label = createSvg('text', { class: 'kg-edge-label', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': `${12 * this.view.labelScale}px`, stroke: 'none' });
      const names = { IMPORTS: 'imports', DEPENDS_ON: 'depends on', CALLS: 'calls', TARGETS: 'targets', DEFINES: 'defines', EXPOSES: 'exposes', DOCUMENTS: 'documents' };
      const name = names[edge.kind] ?? truncate(edge.kind, 24);
      const id = `kg-edge-text-path-${this.edgeLayer.children.length}`;
      // Reverse the text guide, not the relationship, to keep names upright.
      const reverse = source.x > target.x;
      const guideData = edge.source === edge.target ? pathData : reverse
        ? `M ${target.x} ${target.y} Q ${controlX} ${controlY} ${source.x} ${source.y}` : pathData;
      const guide = createSvg('path', { id, d: guideData, fill: 'none', stroke: 'none' });
      const textPath = createSvg('textPath', { href: `#${id}`, startOffset: '50%' });
      textPath.textContent = name;
      label.append(textPath);
      label.style.stroke = 'none';
      this.edgeLayer.append(guide, label);
      const length = guide.getTotalLength?.() ?? (Math.hypot(controlX - source.x, controlY - source.y) + Math.hypot(target.x - controlX, target.y - controlY));
      const textWidth = textPath.getComputedTextLength?.() ?? name.length * 12 * this.view.labelScale * 0.52;
      const gap = Math.min(80, (textWidth + 4) / Math.max(length, 1) * 100);
      const maskId = `${id}-gap`;
      const mask = createSvg('mask', { id: maskId, maskUnits: 'userSpaceOnUse', x: Math.min(source.x, target.x, controlX) - 200, y: Math.min(source.y, target.y, controlY, loopTop - curve - 35) - 200, width: Math.abs(dx) + curve * 2 + 600, height: Math.abs(dy) + curve * 2 + 600 });
      mask.append(createSvg('rect', { x: '-100000', y: '-100000', width: '200000', height: '200000', fill: 'white' }));
      const gapPath = createSvg('path', { d: pathData, pathLength: 100, fill: 'none', stroke: 'black', 'stroke-width': 12 * this.view.labelScale + 6, 'stroke-dasharray': `0 ${50 - gap / 2} ${gap} 100` });
      mask.append(gapPath);
      this.edgeLabelPlacements.push({ label, textPath, gapPath, gap, reverse });
      this.edgeLayer.append(mask);
      path.setAttribute('mask', `url(#${maskId})`);
      edgeLabel = label;
    }
    this.edgeLayer.append(path);
    if (this.view.animationEnabled && !edge.inferred) this.edgeLayer.append(createSvg('path', {
      d: pathData, class: 'kg-edge-flow', fill: 'none', stroke: '#ffffff',
      'stroke-width': Number(path.getAttribute('stroke-width')) + 1,
      'stroke-dasharray': '10 70', 'stroke-linecap': 'round', 'stroke-opacity': 1,
      mask: path.getAttribute('mask') ?? undefined, 'pointer-events': 'none'
    }));
    if (edgeLabel) this.edgeLayer.append(edgeLabel);
    if (active || this.view.scale >= 0.35) {
      const tip = edge.source === edge.target ? { x: from.x + 18, y: loopTop } : target;
      const tangent = edge.source === edge.target ? { x: from.x + curve + 25, y: loopTop - curve - 35 } : control;
      const length = Math.hypot(tip.x - tangent.x, tip.y - tangent.y) || 1;
      const ux = (tip.x - tangent.x) / length, uy = (tip.y - tangent.y) / length;
      const size = this.view.arrowSize ?? 13.5;
      const bx = tip.x - ux * size, by = tip.y - uy * size;
      this.edgeLayer.append(createSvg('path', {
        class: 'kg-arrow',
        d: `M ${tip.x} ${tip.y} L ${bx - uy * size * 0.45} ${by + ux * size * 0.45} L ${bx + uy * size * 0.45} ${by - ux * size * 0.45} Z`,
        fill: path.getAttribute('stroke'), opacity: path.getAttribute('stroke-opacity'), 'pointer-events': 'none'
      }));
    }
  }

  drawNode(node, neighborIds, index = 0) {
    const position = this.layout[node.id];
    if (!position) return;
    const selected = this.view.selectedId === node.id;
    const neighbor = neighborIds.has(node.id);
    const search = String(this.view.search ?? '').trim().toLowerCase();
    const searchMatch = Boolean(search && getNodeSearchText(node).includes(search));
    const degree = this.indexes.degree.get(node.id) ?? 0;
    const geometry = getNodeGeometry(node, { nodeScale: this.view.nodeScale, labelScale: this.view.labelScale, degree });
    const { radius, boxLike, width, height, fontSize } = geometry;
    const color = getNodeColor(node);
    const group = createSvg('g', {
      class: `kg-node${selected ? ' is-selected' : ''}${neighbor ? ' is-neighbor' : ''}${searchMatch ? ' is-search-match' : ''}${this.view.animationEnabled ? ' is-animated' : ''}`,
      transform: `translate(${position.x} ${position.y})`,
      style: `--kg-motion-delay: ${(index % 11) * -0.17}s`,
      tabindex: '0',
      role: 'button',
      'aria-label': `${node.label}, ${getNodeKindLabel(node)}`,
      'data-node-id': node.id
    });
    const title = createSvg('title');
    title.textContent = `${node.label}\n${getNodeKindLabel(node)}\n${degree} connection${degree === 1 ? '' : 's'}`;
    group.append(title);
    if (boxLike) {
      group.append(createSvg('rect', { x: -width / 2, y: -height / 2, width, height, rx: 10 * this.view.nodeScale, fill: color, stroke: color, class: 'kg-node-shape' }));
      group.append(createSvg('rect', { x: -width / 2 + 1, y: -height / 2 + 10, width: 3, height: height - 20, rx: 1.5, fill: color }));
    } else {
      group.append(createSvg('circle', { r: radius, fill: color, stroke: '#ced1d5', class: 'kg-node-shape' }));
    }
    const label = createSvg('text', { x: 0, y: boxLike ? -3 * this.view.nodeScale : -radius - 12, class: `kg-node-label${boxLike ? '' : ' kg-dot-label'}`, 'text-anchor': 'middle', 'font-size': `${fontSize}px` });
    if (boxLike) label.style.fill = '#181b1e';
    label.textContent = geometry.title;
    group.append(label);
    if (boxLike) {
      const kind = createSvg('text', { x: 0, y: 15 * this.view.nodeScale, class: 'kg-node-kind', 'text-anchor': 'middle', 'font-size': `${10 * this.view.nodeScale}px` });
      kind.style.fill = '#25292d';
      kind.textContent = geometry.subtitle;
      group.append(kind);
    }
    if (node.metadata?.unresolved === true) {
      const warning = createSvg('text', { x: 0, y: boxLike ? 0 : radius + 14, class: 'kg-node-warning', 'text-anchor': 'middle' });
      warning.textContent = '⚠';
      group.append(warning);
    }
    this.nodeLayer.append(group);
  }

  edgeBoundary(id, center, toward, padding = 2) {
    const node = this.indexes.nodesById.get(id);
    const { radius, boxLike, width, height } = getNodeGeometry(node, { nodeScale: this.view.nodeScale, labelScale: this.view.labelScale, degree: this.indexes.degree.get(id) ?? 0 });
    const dx = toward.x - center.x;
    const dy = toward.y - center.y;
    const distance = Math.hypot(dx, dy) || 1;
    const extent = boxLike ? Math.min((width / 2) / (Math.abs(dx) / distance || 1e-9), (height / 2) / (Math.abs(dy) / distance || 1e-9)) : radius;
    return { x: center.x + dx / distance * (extent + padding), y: center.y + dy / distance * (extent + padding) };
  }

  getNeighborIds(nodeId) {
    const result = new Set();
    if (!nodeId) return result;
    for (const edge of this.indexes.outgoing.get(nodeId) ?? []) result.add(edge.target);
    for (const edge of this.indexes.incoming.get(nodeId) ?? []) result.add(edge.source);
    return result;
  }

  selectNode(nodeId, focus = false) {
    if (!this.document?.nodes.some((node) => node.id === nodeId)) return;
    if (!this.visibleNodeIds.has(nodeId)) {
      this.callbacks.onRequestReveal?.(nodeId);
      this.render();
    }
    this.view.selectedId = nodeId;
    this.scheduleRender();
    this.callbacks.onSelect?.(nodeId);
    if (focus) this.focusNode(nodeId);
  }

  clearSelection() {
    this.view.selectedId = null;
    this.view.focusIds = null;
    this.scheduleRender();
  }

  focusNode(nodeId) {
    const position = this.layout[nodeId];
    if (!position) return;
    const size = this.getSize();
    const scale = Math.max(0.7, Math.min(1.8, this.view.scale));
    this.view.scale = scale;
    this.view.x = size.width / 2 - position.x * scale;
    this.view.y = size.height / 2 - position.y * scale;
    this.applyTransform();
    this.callbacks.onViewChange?.(this.getView());
  }

  fit() {
    this.render();
    const bounds = getBounds(this.layout);
    for (const node of this.document?.nodes ?? []) {
      const position = this.layout[node.id];
      if (!position) continue;
      const geometry = getNodeGeometry(node, { nodeScale: this.view.nodeScale, labelScale: this.view.labelScale });
      bounds.left = Math.min(bounds.left, position.x - geometry.width / 2);
      bounds.right = Math.max(bounds.right, position.x + geometry.width / 2);
      bounds.top = Math.min(bounds.top, position.y - (geometry.boxLike ? geometry.height / 2 : geometry.radius + geometry.fontSize + 18));
      bounds.bottom = Math.max(bounds.bottom, position.y + (geometry.boxLike ? geometry.height / 2 : geometry.radius));
    }
    bounds.width = bounds.right - bounds.left;
    bounds.height = bounds.bottom - bounds.top;
    if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return;
    const size = this.getSize();
    const padding = Math.max(55, Math.min(90, Math.min(size.width, size.height) * 0.1));
    const availableWidth = Math.max(120, size.width - padding * 2);
    const availableHeight = Math.max(120, size.height - padding * 2);
    const scale = Math.max(0.08, Math.min(1.35, Math.min(availableWidth / Math.max(bounds.width, 1), availableHeight / Math.max(bounds.height, 1))));
    this.view.scale = scale;
    this.view.x = size.width / 2 - (bounds.left + bounds.width / 2) * scale;
    this.view.y = size.height / 2 - (bounds.top + bounds.height / 2) * scale;
    this.render();
    this.callbacks.onViewChange?.(this.getView());
  }

  resetPositions() {
    this.positions = {};
    this.view.groupOffsets = {};
    this.view.positions = this.positions;
    this.scheduleRender();
    this.callbacks.onViewChange?.(this.getView());
  }

  zoomBy(factor) {
    const size = this.getSize();
    this.zoomAt(size.width / 2, size.height / 2, factor);
  }

  zoomAt(clientX, clientY, factor) {
    const size = this.getSize();
    const rect = this.svg.getBoundingClientRect();
    const localX = ((clientX - rect.left) / Math.max(rect.width, 1)) * size.width;
    const localY = ((clientY - rect.top) / Math.max(rect.height, 1)) * size.height;
    const oldScale = this.view.scale;
    const newScale = Math.max(0.12, Math.min(3, oldScale * factor));
    const worldX = (localX - this.view.x) / oldScale;
    const worldY = (localY - this.view.y) / oldScale;
    this.view.scale = newScale;
    this.view.x = localX - worldX * newScale;
    this.view.y = localY - worldY * newScale;
    this.applyTransform();
    this.scheduleRender();
    this.callbacks.onViewChange?.(this.getView());
  }

  localPoint(event) {
    const size = this.getSize();
    const rect = this.svg.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / Math.max(rect.width, 1)) * size.width,
      y: ((event.clientY - rect.top) / Math.max(rect.height, 1)) * size.height
    };
  }

  worldPoint(event) {
    const point = this.localPoint(event);
    return { x: (point.x - this.view.x) / this.view.scale, y: (point.y - this.view.y) / this.view.scale };
  }

  onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    const nodeElement = event.target.closest?.('[data-node-id]');
    const groupElement = this.view.layoutMode === 'grid' && event.target.closest?.('[data-group-name]');
    const point = this.localPoint(event);
    if (groupElement) {
      const name = groupElement.getAttribute('data-group-name');
      const offset = this.view.groupOffsets?.[name] ?? { x: 0, y: 0 };
      this.drag = { type: 'group', name, originX: offset.x, originY: offset.y, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
    } else if (nodeElement) {
      this.drag = { type: 'node', id: nodeElement.dataset.nodeId, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false, point };
    } else {
      this.drag = { type: 'pan', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: this.view.x, originY: this.view.y, moved: false, point };
    }
    this.svg.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  onPointerMove(event) {
    if (!this.drag || (this.drag.pointerId !== undefined && event.pointerId !== this.drag.pointerId)) return;
    if (this.drag.type === 'group') {
      const dx = (event.clientX - this.drag.startX) / this.view.scale;
      const dy = (event.clientY - this.drag.startY) / this.view.scale;
      this.drag.moved = Math.hypot(dx, dy) > 3;
      this.view.groupOffsets = { ...this.view.groupOffsets, [this.drag.name]: { x: this.drag.originX + dx, y: this.drag.originY + dy } };
      this.scheduleRender();
      event.preventDefault();
      return;
    } else if (this.drag.type === 'node') {
      if (Math.hypot(event.clientX - this.drag.startX, event.clientY - this.drag.startY) > 3) this.drag.moved = true;
      event.preventDefault();
      return;
    } else {
      this.view.x = this.drag.originX + event.clientX - this.drag.startX;
      this.view.y = this.drag.originY + event.clientY - this.drag.startY;
      if (Math.hypot(event.clientX - this.drag.startX, event.clientY - this.drag.startY) > 3) this.drag.moved = true;
      this.applyTransform();
    }
    event.preventDefault();
  }

  onPointerUp(event) {
    if (!this.drag || (this.drag.pointerId !== undefined && event.pointerId !== this.drag.pointerId)) return;
    const drag = this.drag;
    this.drag = null;
    this.svg.releasePointerCapture?.(event.pointerId);
    if (drag.type === 'group') {
      this.callbacks.onViewChange?.(this.getView());
    } else if (drag.type === 'node') {
      if (drag.moved) this.callbacks.onViewChange?.(this.getView());
      else this.selectNode(drag.id);
    } else if (drag.moved) {
      this.callbacks.onViewChange?.(this.getView());
    } else {
      this.clearSelection();
      this.callbacks.onEscape?.();
    }
  }

  onPointerCancel() {
    this.drag = null;
  }

  onWheel(event) {
    event.preventDefault();
    this.zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? 1.12 : 0.89);
  }

  onKeyDown(event) {
    const nodeElement = event.target.closest?.('[data-node-id]');
    if (nodeElement && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      this.selectNode(nodeElement.dataset.nodeId, true);
      return;
    }
    if (event.key === 'f' && this.view.selectedId) {
      event.preventDefault();
      this.focusNode(this.view.selectedId);
      return;
    }
    if (event.key === 'Escape') {
      this.callbacks.onEscape?.();
      return;
    }
    const step = 60 / this.view.scale;
    if (event.key === 'ArrowLeft') this.view.x += step;
    else if (event.key === 'ArrowRight') this.view.x -= step;
    else if (event.key === 'ArrowUp') this.view.y -= step;
    else if (event.key === 'ArrowDown') this.view.y += step;
    else if (event.key === '+' || event.key === '=') this.zoomBy(1.15);
    else if (event.key === '-') this.zoomBy(0.87);
    else return;
    event.preventDefault();
    this.applyTransform();
    this.callbacks.onViewChange?.(this.getView());
  }

  exportSvg() {
    const clone = this.svg.cloneNode(true);
    clone.setAttribute('xmlns', SVG_NS);
    clone.setAttribute('width', this.getSize().width);
    clone.setAttribute('height', this.getSize().height);
    const style = createSvg('style');
    style.textContent = '.kg-edge{fill:none}.kg-edge.is-inferred{stroke-dasharray:6 5}.kg-node-shape{stroke-width:1.2px}.kg-node-label,.kg-node-kind,.kg-edge-label{font-family:system-ui,sans-serif}.kg-node-label{fill:#ececed;font-weight:600}.kg-node-kind{fill:#afb3b8}.kg-dot-label,.kg-edge-label{paint-order:stroke;stroke:#18191b;stroke-width:4px;stroke-linejoin:round}.kg-edge-label{fill:#c1c4c9}.kg-node-warning{fill:#f5b6a7}';
    clone.insertBefore(createSvg('rect', { x: 0, y: 0, width: '100%', height: '100%', fill: this.view.backgroundColor }), clone.firstChild);
    clone.insertBefore(style, clone.firstChild);
    return new XMLSerializer().serializeToString(clone);
  }

  destroy() {
    if (this.frame !== null) window.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.svg.removeEventListener('pointerdown', this.boundHandlers.pointerDown);
    this.svg.removeEventListener('pointermove', this.boundHandlers.pointerMove);
    this.svg.removeEventListener('pointerup', this.boundHandlers.pointerUp);
    this.svg.removeEventListener('pointercancel', this.boundHandlers.pointerCancel);
    this.svg.removeEventListener('wheel', this.boundHandlers.wheel);
    this.svg.removeEventListener('keydown', this.boundHandlers.keyDown);
    window.removeEventListener('resize', this.boundHandlers.resize);
    this.svg.replaceChildren();
  }
}

export function getRendererSummary(renderer) {
  const view = renderer.getView();
  return {
    scale: view.scale,
    positions: Object.keys(view.positions).length,
    selectedId: view.selectedId
  };
}

export { DEFAULT_COLORS };
