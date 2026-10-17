import {
  createIndexes,
  createEmptyDocument,
  createSampleDocument,
  fingerprintDocument,
  getNodeColor,
  getNodeKindLabel,
  getVisibleNodeIds,
  normalizeGraphDocument
} from './graph-core.js';
import { createCodebaseGraph, shouldIgnorePath } from './codebase-parser.js';
import { GraphRenderer } from './renderer.js';

const dom = {
  body: document.body,
  graphSvg: document.getElementById('graph-svg'),
  dropOverlay: document.getElementById('drop-overlay'),
  dropMessage: document.getElementById('drop-message'),
  emptyState: document.getElementById('empty-state'),
  graphStatus: document.getElementById('graph-status'),
  graphStats: document.getElementById('graph-stats'),
  search: document.getElementById('search-input'),
  searchClear: document.getElementById('search-clear'),
  groupFilters: document.getElementById('group-filters'),
  kindFilters: document.getElementById('kind-filters'),
  edgeFilters: document.getElementById('edge-filters'),
  filterSummary: document.getElementById('filter-summary'),
  inspector: document.getElementById('inspector-content'),
  nodeList: document.getElementById('node-list'),
  listCount: document.getElementById('list-count'),
  diagnostics: document.getElementById('diagnostics'),
  toast: document.getElementById('toast'),
  sidebar: document.getElementById('sidebar'),
  inspectorPanel: document.getElementById('inspector-panel'),
  sidebarLauncher: document.getElementById('sidebar-launcher'),
  inspectorLauncher: document.getElementById('inspector-launcher'),
  fileInput: document.getElementById('file-input'),
  folderInput: document.getElementById('folder-input'),
  viewInput: document.getElementById('view-input'),
  searchShortcut: document.getElementById('search-shortcut'),
  settingsDock: document.getElementById('settings-dock'),
  layoutMode: document.getElementById('layout-mode'),
  layoutSpacing: document.getElementById('layout-spacing'),
  layoutSpacingValue: document.getElementById('spacing-value'),
  labelScale: document.getElementById('label-scale'),
  labelScaleValue: document.getElementById('label-scale-value'),
  edgeOpacity: document.getElementById('edge-opacity'),
  edgeOpacityValue: document.getElementById('edge-opacity-value'),
  motionToggle: document.getElementById('motion-toggle'),
  animationSpeed: document.getElementById('animation-speed'),
  animationSpeedValue: document.getElementById('animation-speed-value'),
  edgeLabelMode: document.getElementById('edge-label-mode'),
  backgroundColor: document.getElementById('background-color'),
  resetSettings: document.getElementById('reset-settings'),
  settingsFit: document.getElementById('settings-fit')
};

const state = {
  document: createEmptyDocument({ name: 'Choose a project' }),
  view: null,
  visibility: { visibleNodes: 0, totalNodes: 0, visibleEdges: 0, totalEdges: 0, truncated: false },
  busy: false,
  dragDepth: 0
};

const defaultViewSettings = Object.freeze({
  layoutSpacing: 1,
  layoutMode: 'layered',
  nodeScale: 1,
  labelScale: 1,
  edgeOpacity: 0.85,
  inferredOpacity: 0.70,
  dottedOpacity: 0.85,
  showSolid: true,
  edgeDisplay: 'all',
  edgeLabelMode: 'off',
  backgroundColor: '#0c1220',
  animationEnabled: true,
  animationSpeed: 1,
  nodeLimit: 650,
  isolationMode: 'all',
  showInferred: true,
  linkDistance: 180,
  repulsion: 1,
  overviewMode: 'all'
});

let renderer;
let toastTimer;
let activeParserJob = null;
let documentSequence = 0;
let importStartedAt = Date.now();
let projectNoticeTimer;
let serverAutoPromise = null;

// Every path that can replace the loaded document takes a token. A token is minted when
// the user expresses an intent and re-checked immediately before any state mutation, so a
// slow auto-discovery or folder read can never overwrite a newer explicit import.
function beginDocumentOperation() {
  documentSequence += 1;
  importStartedAt = Date.now();
  return documentSequence;
}

function isCurrentDocumentOperation(operation) {
  return operation === documentSequence;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, className, action) {
  const node = element('button', className, text);
  node.type = 'button';
  if (action) node.addEventListener('click', action);
  return node;
}

function setText(node, text) {
  if (node) node.textContent = text;
}

function emptyView(document) {
  return {
    x: 0,
    y: 0,
    scale: 1,
    selectedId: null,
    search: '',
    activeKinds: new Set(),
    activeGroups: new Set(),
    activeEdgeKinds: new Set(),
    focusIds: null,
    positions: { ...(document?.positions ?? {}) },
    labelEdges: false,
    ...defaultViewSettings,
    overviewMode: 'all'
  };
}

function settingNumber(value, fallback, minimum, maximum) {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

function settingBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function settingColor(value, fallback) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function viewForStorage(view) {
  return {
    x: Number.isFinite(view.x) ? view.x : 0,
    y: Number.isFinite(view.y) ? view.y : 0,
    scale: Number.isFinite(view.scale) ? view.scale : 1,
    selectedId: view.selectedId ?? null,
    search: view.search ?? '',
    activeKinds: [...(view.activeKinds ?? [])],
    activeGroups: [...(view.activeGroups ?? [])],
    activeEdgeKinds: [...(view.activeEdgeKinds ?? [])],
    focusIds: view.focusIds ? [...view.focusIds] : null,
    positions: Object.fromEntries(Object.entries(view.positions ?? {}).map(([id, position]) => [id, { x: position.x, y: position.y, pinned: position.pinned === true }])),
    labelEdges: view.labelEdges === true,
    layoutSpacing: view.layoutSpacing,
    layoutMode: view.layoutMode,
    nodeScale: view.nodeScale,
    labelScale: view.labelScale,
    edgeOpacity: view.edgeOpacity,
    appearanceVersion: 3,
    groupOffsets: view.groupOffsets ?? {},
    solidWidth: view.solidWidth,
    areaWidth: view.areaWidth,
    areaNameSize: view.areaNameSize,
    arrowSize: view.arrowSize,
    dashedWidth: view.dashedWidth,
    inferredOpacity: view.inferredOpacity,
    dottedOpacity: view.dottedOpacity,
    edgeDisplay: view.edgeDisplay,
    edgeLabelMode: view.edgeLabelMode,
    backgroundColor: view.backgroundColor,
    animationEnabled: view.animationEnabled,
    animationSpeed: view.animationSpeed,
    nodeLimit: view.nodeLimit,
    isolationMode: view.isolationMode,
    showInferred: view.showInferred,
    showSolid: view.showSolid,
    linkDistance: view.linkDistance,
    repulsion: view.repulsion,
    overviewMode: view.overviewMode
  };
}

function normalizeSavedView(saved, document) {
  if (!saved || typeof saved !== 'object') return null;
  const validIds = new Set(document.nodes.map((node) => node.id));
  const positions = {};
  for (const [id, position] of Object.entries(saved.positions ?? {})) {
    if (!validIds.has(id) || !position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) continue;
    positions[id] = { x: position.x, y: position.y, pinned: position.pinned === true };
  }
  return {
    x: Number.isFinite(saved.x) ? saved.x : 0,
    y: Number.isFinite(saved.y) ? saved.y : 0,
    scale: Number.isFinite(saved.scale) ? saved.scale : 1,
    selectedId: validIds.has(saved.selectedId) ? saved.selectedId : null,
    search: typeof saved.search === 'string' ? saved.search.slice(0, 200) : '',
    activeKinds: new Set((Array.isArray(saved.activeKinds) ? saved.activeKinds : []).filter((value) => value === '__none__' || document.nodes.some((node) => node.kind === value))),
    activeGroups: new Set((Array.isArray(saved.activeGroups) ? saved.activeGroups : []).filter((value) => value === '__none__' || document.nodes.some((node) => node.group === value))),
    activeEdgeKinds: new Set((Array.isArray(saved.activeEdgeKinds) ? saved.activeEdgeKinds : []).filter((value) => value === '__none__' || document.edges.some((edge) => edge.kind === value))),
    focusIds: Array.isArray(saved.focusIds) ? new Set(saved.focusIds.filter((id) => validIds.has(id))) : null,
    positions,
    labelEdges: saved.labelEdges === true,
    layoutSpacing: settingNumber(saved.layoutSpacing, defaultViewSettings.layoutSpacing, 0.65, 1.6),
    layoutMode: ['layered', 'auto', 'force', 'grid'].includes(saved.layoutMode) ? saved.layoutMode : defaultViewSettings.layoutMode,
    nodeScale: 1,
    labelScale: settingNumber(saved.labelScale, defaultViewSettings.labelScale, 0.7, 1.6),
    edgeDisplay: saved.edgeDisplay === 'selected' ? 'selected' : 'all',
    inferredOpacity: saved.appearanceVersion === 3 ? settingNumber(saved.inferredOpacity, 0.70, 0, 1) : 0.70,
    solidWidth: 2.2,
    areaWidth: 1.5,
    areaNameSize: 23,
    arrowSize: 13.5,
    groupOffsets: Object.fromEntries(Object.entries(saved.groupOffsets ?? {}).filter(([, offset]) => offset && Number.isFinite(offset.x) && Number.isFinite(offset.y))),
    dashedWidth: 2.2,
    dottedOpacity: 0.85,
    edgeOpacity: saved.appearanceVersion === 3 ? settingNumber(saved.edgeOpacity, defaultViewSettings.edgeOpacity, 0, 1) : 0.85,
    edgeLabelMode: saved.edgeLabelMode === 'light' ? 'active' : ['active', 'always', 'off'].includes(saved.edgeLabelMode) ? saved.edgeLabelMode : defaultViewSettings.edgeLabelMode,
    backgroundColor: saved.appearanceVersion === 3 ? settingColor(saved.backgroundColor, defaultViewSettings.backgroundColor) : '#0c1220',
    animationEnabled: settingBoolean(saved.animationEnabled, defaultViewSettings.animationEnabled),
    animationSpeed: settingNumber(saved.animationSpeed, defaultViewSettings.animationSpeed, 0.25, 2),
    nodeLimit: settingNumber(saved.nodeLimit, 650, 50, 650),
    isolationMode: 'all',
    showInferred: saved.showInferred !== false,
    showSolid: saved.showSolid !== false,
    linkDistance: settingNumber(saved.linkDistance, 180, 0, 1500),
    repulsion: settingNumber(saved.repulsion, 1, -10, 10),
    overviewMode: saved.overviewMode === 'files' ? 'files' : 'all'
  };
}

function showToast(message, tone = 'normal') {
  setText(dom.toast, message);
  dom.toast.className = `toast is-visible ${tone}`;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    dom.toast.className = 'toast';
  }, 4200);
}

function setBusy(value, message = '') {
  state.busy = value;
  dom.body.classList.toggle('is-busy', value);
  if (message) setText(dom.dropMessage, message);
  const loading = document.getElementById('project-loading');
  if (loading) loading.hidden = !value;
  if (value) {
    setText(document.getElementById('loading-message'), message || 'Building your map…');
    const notice = document.getElementById('project-notice');
    if (notice) notice.hidden = true;
  }
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value ?? 0);
}

function sourceLine(node) {
  const source = node.source ?? {};
  if (!source.startLine) return source.path ?? node.file ?? 'No source path';
  if (source.endLine && source.endLine !== source.startLine) return `${source.path}:${source.startLine}-${source.endLine}`;
  return `${source.path}:${source.startLine}`;
}

function isGraphDocument(value) {
  return value !== null && typeof value === 'object' && Array.isArray(value.nodes);
}

function isViewDocument(value) {
  return value !== null && typeof value === 'object' && ['codeweb-view', 'codemesh-view', 'kg-map-view'].includes(value.type) && value.view && typeof value.view === 'object';
}

const serverProjectFileNames = new Set(['package.json', 'tsconfig.json', 'jsconfig.json', 'dockerfile', 'makefile', 'readme.md', 'license']);

function isServerTextCandidate(path) {
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  if (name === 'kg-map.html' || name === 'kgmap.html' || name === 'codeweb.html' || name === 'codemesh.html' || name === 'codeatlas.html') return false;
  if (serverProjectFileNames.has(name)) return true;
  return /\.(?:html?|js|jsx|mjs|cjs|ts|tsx|mts|cts|py|pyw|go|rs|java|kt|kts|cs|rb|php|swift|c|h|cc|cpp|cxx|hpp|hh|css|scss|sass|less|json|jsonc|yaml|yml|toml|xml|graphql|gql|sql|prisma|md|mdx|sh|bash|zsh|ps1|bat|cmd|vue|svelte|astro)$/i.test(name);
}

async function readServerListing(url) {
  try {
    const response = await fetch(url, { cache: 'no-store', headers: { Accept: 'text/html' } });
    if (!response.ok || (response.url && response.url !== url.href) || !String(response.headers.get('content-type') ?? '').includes('text/html')) return null;
    const html = await response.text();
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const links = [...parsed.querySelectorAll('a[href]')].map((link) => link.getAttribute('href')).filter(Boolean);
    const looksLikeListing = links.some((href) => !/^(?:https?:|\/\/|#|\?)/i.test(href) && (href.endsWith('/') || isServerTextCandidate(href)));
    if (!looksLikeListing) return null;
    return { links: [...new Set(links)], baseUrl: url };
  } catch {
    return null;
  }
}

async function crawlServerDirectory(listing) {
  const queue = [{ url: listing.baseUrl, path: '' }];
  const visited = new Set([listing.baseUrl.href]);
  const records = [];
  const seenFiles = new Set();
  let fileCount = 0;
  let totalBytes = 0;
  while (queue.length > 0 && fileCount < 5000 && totalBytes < 40 * 1024 * 1024) {
    const current = queue.shift();
    const childListing = current.url.href === listing.baseUrl.href ? listing : await readServerListing(current.url);
    if (!childListing) continue;
    for (const href of childListing.links) {
      if (href.startsWith('?') || href.startsWith('#') || href === '../' || href === '/') continue;
      let resolved;
      try {
        resolved = new URL(href, current.url);
      } catch {
        continue;
      }
      if (resolved.origin !== listing.baseUrl.origin || resolved.search || resolved.hash || !resolved.pathname.startsWith(current.url.pathname) || !resolved.pathname.startsWith(listing.baseUrl.pathname)) continue;
      let relativePath;
      try { relativePath = decodeURIComponent(resolved.pathname.slice(listing.baseUrl.pathname.length)); } catch { continue; }
      if (!relativePath || relativePath.split('/').some(part => part === '..' || part === '.') || relativePath.includes('\\')) continue;
      if (shouldIgnorePath(relativePath)) continue;
      if (resolved.pathname.endsWith('/')) {
        if (!visited.has(resolved.href)) {
          visited.add(resolved.href);
          queue.push({ url: resolved, path: relativePath });
        }
        continue;
      }
      if (!isServerTextCandidate(relativePath) || seenFiles.has(resolved.href)) continue;
      seenFiles.add(resolved.href);
      try {
        const response = await fetch(resolved, { cache: 'no-store' });
        if (!response.ok || (response.url && response.url !== resolved.href)) continue;
        if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) continue;
        const text = await response.text();
        const bytes = new TextEncoder().encode(text).byteLength;
        if (bytes > 2 * 1024 * 1024 || text.includes('\0')) continue;
        if (totalBytes + bytes > 40 * 1024 * 1024) break;
        totalBytes += bytes;
        fileCount += 1;
        records.push({ path: relativePath, text, bytes });
      } catch {
        continue;
      }
    }
  }
  return records;
}

async function discoverServerProject() {
  if (window.location.protocol === 'file:') return null;
  // The HTML directory is the boundary. Never probe parents or import an arbitrary
  // adjacent graph export in place of the source tree.
  const baseUrl = new URL('./', window.location.href);
  const listing = await readServerListing(baseUrl);
  if (!listing) return null;
  const records = await crawlServerDirectory(listing);
  return records.length > 0 ? { type: 'codebase', records, source: 'auto · this folder' } : null;
}

async function autoLoadServerProject(notify = false, operation = documentSequence) {
  if (serverAutoPromise) return serverAutoPromise;
  const promise = (async () => {
    const discovered = await discoverServerProject();
    if (!discovered) return false;
    if (!isCurrentDocumentOperation(operation)) return false;
    if (discovered.type === 'graph') {
      return adoptDocument(discovered.value, discovered.source, operation);
    }
    const parsed = await parseCodebase(discovered.records, { stripCommonRoot: false, name: discovered.source });
    if (parsed.cancelled) return false;
    if (parsed.error) throw parsed.error;
    if (parsed.document.nodes.length === 0) return false;
    if (!adoptDocument(parsed.document, discovered.source, operation)) return false;
    if (notify) showToast(`Auto-discovered ${formatNumber(parsed.document.nodes.length)} nodes from this project.`);
    return true;
  })();
  serverAutoPromise = promise;
  try {
    const result = await promise;
    if (!result) serverAutoPromise = null;
    return result;
  } catch (error) {
    serverAutoPromise = null;
    throw error;
  }
}

function readTextFile(file) {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read file.'));
    reader.readAsText(file);
  });
}

function joinEntryPath(parent, name) {
  return parent ? `${parent}/${name}` : name;
}

function readDirectoryEntries(directory) {
  return new Promise((resolve, reject) => {
    const reader = directory.createReader();
    const entries = [];
    const readBatch = () => reader.readEntries((batch) => {
      if (!batch.length) {
        resolve(entries);
        return;
      }
      entries.push(...batch);
      readBatch();
    }, reject);
    readBatch();
  });
}

async function readEntry(entry, parentPath = '') {
  if (shouldIgnorePath(joinEntryPath(parentPath, entry.name))) return [];
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    const path = joinEntryPath(parentPath, entry.name);
    if ((file.size ?? 0) > 40 * 1024 * 1024) return [{ path, text: '', bytes: file.size ?? 0 }];
    return [{ path, text: await readTextFile(file), bytes: file.size ?? 0 }];
  }
  if (entry.isDirectory) {
    const path = joinEntryPath(parentPath, entry.name);
    const children = await readDirectoryEntries(entry);
    const records = [];
    for (const child of children) records.push(...await readEntry(child, path));
    return records;
  }
  return [];
}

async function recordsFromDataTransfer(dataTransfer) {
  const entries = [...(dataTransfer.items ?? [])]
    .map((item) => typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null)
    .filter(Boolean);
  if (entries.length > 0) {
    const records = [];
    for (const entry of entries) records.push(...await readEntry(entry));
    return records;
  }
  const records = [];
  for (const file of [...(dataTransfer.files ?? [])]) {
    const path = file.webkitRelativePath || file.name;
    if ((file.size ?? 0) > 40 * 1024 * 1024) records.push({ path, text: '', bytes: file.size ?? 0 });
    else records.push({ path, text: await readTextFile(file), bytes: file.size ?? 0 });
  }
  return records;
}

async function recordsFromFileList(fileList) {
  const records = [];
  for (const file of [...fileList]) {
    const path = file.webkitRelativePath || file.name;
    if (shouldIgnorePath(path)) continue;
    if ((file.size ?? 0) > 40 * 1024 * 1024) records.push({ path, text: '', bytes: file.size ?? 0 });
    else records.push({ path, text: await readTextFile(file), bytes: file.size ?? 0 });
  }
  return records;
}

async function recordsFromDirectoryHandle(directory, parentPath = '') {
  const records = [];
  for await (const [name, entry] of directory.entries()) {
    const path = joinEntryPath(parentPath, name);
    if (shouldIgnorePath(path)) continue;
    if (entry.kind === 'file') {
      const file = await entry.getFile();
      if ((file.size ?? 0) > 40 * 1024 * 1024) records.push({ path, text: '', bytes: file.size ?? 0 });
      else records.push({ path, text: await readTextFile(file), bytes: file.size ?? 0 });
    } else if (entry.kind === 'directory') {
      records.push(...await recordsFromDirectoryHandle(entry, path));
    }
  }
  return records;
}

async function chooseCodebaseFolder() {
  const operation = beginDocumentOperation();
  cancelParserJob();
  // Open during the user gesture; explicit selection must replace auto-discovery.
  if ('webkitdirectory' in dom.folderInput || typeof window.showDirectoryPicker !== 'function') {
    dom.folderInput.click();
    return;
  }
  try {
    const handle = await window.showDirectoryPicker();
    if (!isCurrentDocumentOperation(operation)) return;
    setBusy(true, 'Reading selected codebase…');
    try {
      const records = await recordsFromDirectoryHandle(handle);
      await handleRecords(records, 'selected codebase', operation);
    } finally {
      if (isCurrentDocumentOperation(operation)) setBusy(false);
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;
    dom.folderInput.click();
  }
}

function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = element('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function localViewKey(document) {
  return `codeweb:view:${document.fingerprint ?? fingerprintDocument(document)}`;
}

function getLocalView(document) {
  try {
    const raw = window.localStorage.getItem(localViewKey(document)) ?? window.localStorage.getItem(`kg-map:view:${document.fingerprint ?? fingerprintDocument(document)}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function updateStats() {
  const document = state.document;
  const coverageNote = document.coverage.partial ? ' · partial coverage' : '';
  setText(dom.graphStats, `${formatNumber(document.nodes.length)} nodes · ${formatNumber(document.edges.length)} edges · ${document.repository.revision === 'unknown' ? 'unscoped revision' : document.repository.revision}${coverageNote}`);
  const warningCount = document.diagnostics.filter((item) => item.severity !== 'info').length;
  setText(dom.diagnostics, warningCount > 0 ? `${warningCount} import diagnostic${warningCount === 1 ? '' : 's'}` : 'No blocking diagnostics');
  dom.diagnostics.classList.toggle('has-warning', warningCount > 0);
}

function updateFilterSummary() {
  const active = state.view.activeKinds.size + state.view.activeGroups.size + state.view.activeEdgeKinds.size + (state.view.search ? 1 : 0) + (state.view.isolationMode !== 'all' ? 1 : 0) + (!state.view.showInferred ? 1 : 0);
  setText(dom.filterSummary, active === 0 ? 'Showing all nodes' : `${active} filter${active === 1 ? '' : 's'} active`);
  dom.searchClear.hidden = !state.view.search;
  if (dom.search.value !== state.view.search) dom.search.value = state.view.search;
}

function renderFilterGroup(container, title, entries, activeSet, stateKey) {
  container.replaceChildren();
  const details = element('details');
  details.open = stateKey === 'activeKinds';
  const summary = element('summary', 'filter-summary-title', `${title} (${entries.length})`);
  details.append(summary);
  const list = element('div', 'filter-list');
  for (const entry of entries) {
    const label = element('label', 'filter-row');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = activeSet.size === 0 || activeSet.has(entry.value);
    input.addEventListener('change', () => {
      const allValues = entries.map((item) => item.value);
      const next = activeSet.size === 0 ? new Set(allValues) : new Set([...activeSet].filter(value => value !== '__none__'));
      if (input.checked) next.add(entry.value);
      else next.delete(entry.value);
      if (next.size === allValues.length) state.view[stateKey] = new Set();
      else state.view[stateKey] = next.size ? next : new Set(['__none__']);
      state.view.focusIds = null;
      syncView();
    });
    const text = element('span', 'filter-label', entry.label);
    const count = element('span', 'filter-count', formatNumber(entry.count));
    label.append(input, text, count);
    list.append(label);
  }
  if (entries.length > 1) {
    const clear = button('Select all', 'text-action', () => {
      state.view[stateKey] = new Set();
      state.view.focusIds = null;
      syncView();
    });
    details.append(clear, list);
  } else {
    details.append(list);
  }
  container.append(details);
}

function renderFilters() {
  const document = state.document;
  const groups = new Map();
  const kinds = new Map();
  const edgeKinds = new Map();
  for (const node of document.nodes) {
    groups.set(node.group, (groups.get(node.group) ?? 0) + 1);
    kinds.set(node.kind, (kinds.get(node.kind) ?? 0) + 1);
  }
  for (const edge of document.edges) edgeKinds.set(edge.kind, (edgeKinds.get(edge.kind) ?? 0) + 1);
  const names = { file: 'Files', module: 'Code files', route: 'API endpoints', 'api-call': 'API calls', model: 'Data models', schema: 'Schemas', configuration: 'Configuration', external: 'Dependencies', unresolved: 'Unresolved imports', documentation: 'Documentation', test: 'Tests', IMPORTS: 'Imports', DEPENDS_ON: 'Dependencies', DEFINES: 'Definitions', EXPOSES: 'Endpoints', CALLS: 'Calls', TARGETS: 'API targets', DOCUMENTS: 'Documentation' };
  const toEntries = (map) => [...map.entries()].sort((left, right) => left[0].localeCompare(right[0])).map(([value, count]) => ({ value, label: names[value] ?? value, count }));
  renderFilterGroup(dom.groupFilters, 'Node groups', toEntries(groups), state.view.activeGroups, 'activeGroups');
  renderFilterGroup(dom.kindFilters, 'Node kinds', toEntries(kinds), state.view.activeKinds, 'activeKinds');
  renderFilterGroup(dom.edgeFilters, 'Relationship kinds', toEntries(edgeKinds), state.view.activeEdgeKinds, 'activeEdgeKinds');
  updateFilterSummary();
}

function relationEvidence(edge) {
  const evidence = edge.evidence ?? {};
  const parts = [];
  if (evidence.path) parts.push(evidence.path);
  if (evidence.startLine) parts.push(`line ${evidence.startLine}${evidence.endLine && evidence.endLine !== evidence.startLine ? `-${evidence.endLine}` : ''}`);
  if (evidence.extractor) parts.push(evidence.extractor);
  if (evidence.revision) parts.push(`rev ${evidence.revision}`);
  if (edge.resolution) parts.push(edge.resolution);
  if (edge.inferred === true) parts.push(`inferred${Number.isFinite(edge.confidence) ? ` ${Math.round(edge.confidence * 100)}%` : ''}`);
  else if (edge.inferred === false) parts.push('observed');
  else parts.push('inference state not supplied');
  return parts.join(' · ') || 'No evidence supplied';
}

function addBadge(parent, text, color) {
  const badge = element('span', 'badge', text);
  if (color) {
    badge.style.backgroundColor = color;
    const hex = color.replace('#', '');
    const channels = hex.length === 6 ? [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16)) : [255, 255, 255];
    badge.style.color = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722 > 140 ? '#0c1424' : '#e9eef8';
  }
  parent.append(badge);
}

function addMetadataInspector(parent, metadata) {
  const entries = Object.entries(metadata ?? {}).filter(([, value]) => value !== undefined && value !== null && typeof value !== 'object');
  if (entries.length === 0) return;
  const details = element('details', 'inspector-section');
  details.append(element('summary', '', 'Metadata'));
  const table = element('div', 'metadata-grid');
  for (const [key, value] of entries.slice(0, 40)) {
    const row = element('div', 'metadata-row');
    row.append(element('span', 'metadata-key', key), element('span', 'metadata-value', String(value)));
    table.append(row);
  }
  details.append(table);
  parent.append(details);
}

function addRelationshipSection(parent, title, edges, indexes, direction) {
  const section = element('details', 'inspector-section');
  section.open = edges.length > 0;
  section.append(element('summary', 'section-title', `${direction === 'incoming' ? 'Referenced by' : 'Connects to'} (${edges.length})`));
  if (edges.length === 0) {
    section.append(element('p', 'muted', 'None recorded.'));
    parent.append(section);
    return;
  }
  const list = element('div', 'relationship-list');
  for (const edge of edges) {
    const otherId = direction === 'incoming' ? edge.source : edge.target;
    const other = indexes.nodesById.get(otherId);
    const item = element('div', 'relationship-item');
    const top = element('button', 'relationship-top');
    top.type = 'button';
    top.append(element('span', 'relationship-label', other?.label ?? otherId), element('span', 'relationship-kind', edge.kind.toLowerCase().replaceAll('_', ' ')));
    const evidence = element('details', 'edge-evidence');
    evidence.append(element('summary', '', edge.inferred ? `Evidence · inferred ${Math.round((edge.confidence ?? 0) * 100)}%` : 'Source evidence'), element('p', 'relationship-evidence', relationEvidence(edge)));
    item.append(top, evidence);
    top.addEventListener('click', () => selectNode(otherId));
    list.append(item);
  }
  section.append(list);
  parent.append(section);
}

function traceFromSelected() {
  const selected = state.document.nodes.find((node) => node.id === state.view.selectedId);
  if (!selected) return;
  const indexes = createIndexes(state.document);
  const queue = [[selected.id]];
  const visited = new Set([selected.id]);
  while (queue.length > 0) {
    const path = queue.shift();
    const last = path[path.length - 1];
    const edges = [...(indexes.outgoing.get(last) ?? [])];
    for (const edge of edges) {
      if (visited.has(edge.target)) continue;
      visited.add(edge.target);
      const nextPath = [...path, edge.target];
      if (nextPath.length >= 3) {
        selectNode(edge.target, true);
        showToast(`Trace found ${nextPath.length - 1} hops to ${indexes.nodesById.get(edge.target)?.label ?? edge.target}.`);
        return;
      }
      queue.push(nextPath);
    }
  }
  showToast('No downstream path was found from the selected node.');
}

function renderInspector() {
  const container = dom.inspector;
  container.replaceChildren();
  const selected = state.document.nodes.find((node) => node.id === state.view.selectedId);
  if (!selected) {
    const heading = element('h2', 'inspector-title', 'Codebase overview');
    container.append(heading, element('p', 'muted', 'Select a node on the canvas or in the accessible list to inspect source, relationships, and extraction evidence.'));
    const metrics = element('div', 'overview-metrics');
    addBadge(metrics, `${formatNumber(state.document.nodes.length)} nodes`, '#1d3557');
    addBadge(metrics, `${formatNumber(state.document.edges.length)} edges`, '#173b45');
    addBadge(metrics, `${formatNumber(state.document.diagnostics.length)} diagnostics`, '#3c2d1d');
    container.append(metrics);
    const source = element('p', 'source-line', `${state.document.repository.name} · ${state.document.repository.revision}`);
    container.append(source);
    if (state.document.diagnostics.length > 0) {
      const details = element('details', 'inspector-section');
      details.append(element('summary', '', 'Import diagnostics'));
      const list = element('div', 'diagnostic-list');
      for (const item of state.document.diagnostics.slice(0, 30)) list.append(element('p', `diagnostic diagnostic-${item.severity}`, `${item.severity.toUpperCase()}: ${item.message}`));
      details.append(list);
      container.append(details);
    }
    return;
  }
  const indexes = createIndexes(state.document);
  const color = getNodeColor(selected);
  const heading = element('h2', 'inspector-title', selected.label);
  container.append(heading);
  const badges = element('div', 'badge-row');
  const typeNames = { module: 'Code file', file: 'Code file', route: 'Endpoint', 'api-call': 'API call', model: 'Data model', external: 'Dependency', configuration: 'Configuration', schema: 'Schema' };
  addBadge(badges, typeNames[selected.kind] ?? getNodeKindLabel(selected), color);
  addBadge(badges, `${(indexes.degree.get(selected.id) ?? 0)} connections`, '#26364d');
  container.append(badges);
  const revision = selected.source?.revision && !['browser-import', 'sample'].includes(selected.source.revision) ? ` · rev ${selected.source.revision}` : '';
  const source = element('p', 'source-line', `${sourceLine(selected)}${revision}`);
  if (state.document.repository.url) {
    const link = element('a', 'source-link', 'Open repository source');
    link.href = state.document.repository.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    container.append(source, link);
  } else {
    container.append(source);
  }
  const actions = element('div', 'inspector-actions');
  actions.append(button('Center', 'small-button', () => selectNode(selected.id, true)));
  actions.append(button('Show neighbors', 'small-button', () => {
    const neighbors = new Set([selected.id]);
    const allowed = edge => (state.view.showInferred || !edge.inferred) && (state.view.activeEdgeKinds.size === 0 || state.view.activeEdgeKinds.has(edge.kind));
    for (const edge of indexes.outgoing.get(selected.id) ?? []) if (allowed(edge)) neighbors.add(edge.target);
    for (const edge of indexes.incoming.get(selected.id) ?? []) if (allowed(edge)) neighbors.add(edge.source);
    state.view.overviewMode = 'all';
    state.view.activeKinds = new Set();
    state.view.activeGroups = new Set();
    state.view.search = '';
    state.view.focusIds = neighbors;
    syncView();
    requestAnimationFrame(() => renderer.fit());
    showToast(`Focused ${neighbors.size} visible neighborhood nodes.`);
  }));
  if (state.view.focusIds) actions.append(button('Show full map', 'small-button', () => {
    state.view.focusIds = null;
    syncView();
    requestAnimationFrame(() => renderer.fit());
  }));
  const more = element('details', 'node-more');
  more.append(element('summary', '', 'More'), button('Trace dependencies', 'small-button', traceFromSelected));
  actions.append(more);
  container.append(actions);
  addMetadataInspector(container, selected.metadata);
  addRelationshipSection(container, 'Outgoing relationships', indexes.outgoing.get(selected.id) ?? [], indexes, 'outgoing');
  addRelationshipSection(container, 'Incoming relationships', indexes.incoming.get(selected.id) ?? [], indexes, 'incoming');
}

function renderList(info) {
  const nodes = state.document.nodes.filter((node) => renderer.visibleNodeIds.has(node.id));
  dom.nodeList.replaceChildren();
  setText(dom.listCount, `${formatNumber(nodes.length)} visible`);
  for (const node of nodes.slice(0, 650)) {
    const item = button(`${node.label} · ${getNodeKindLabel(node)}`, 'list-node', () => selectNode(node.id));
    item.setAttribute('aria-pressed', String(state.view.selectedId === node.id));
    if (state.view.selectedId === node.id) item.classList.add('is-selected');
    dom.nodeList.append(item);
  }
  if (nodes.length === 0) dom.nodeList.append(element('p', 'muted', 'No nodes match the current filters.'));
  if (info.truncated) dom.nodeList.append(element('p', 'muted', `Showing up to ${state.view.nodeLimit} nodes. Search or increase the node limit in View to reveal more.`));
}

function updateStatus(info) {
  state.visibility = info;
  const legend = document.getElementById('layer-legend');
  legend.replaceChildren();
  if (['layered', 'auto'].includes(state.view.layoutMode)) {
    for (const layer of info.layers ?? []) {
      const item = element('span', '', layer.name);
      item.style.setProperty('--layer-color', layer.color);
      legend.append(item);
    }
  }
  const edgeText = `${formatNumber(info.visibleEdges)} / ${formatNumber(info.totalEdges)}`;
  setText(dom.graphStatus, `${formatNumber(info.visibleNodes)} / ${formatNumber(info.totalNodes)} nodes · ${edgeText} connections${state.view.edgeDisplay === 'selected' ? ' shown · select a node to explore' : ''}${info.truncated ? ' · node limit reached' : ''}`);
  dom.emptyState.hidden = info.visibleNodes > 0;
  const unloaded = state.document.nodes.length === 0;
  setText(document.getElementById('empty-title'), unloaded ? 'Open your codebase' : 'No matching nodes');
  setText(document.getElementById('empty-description'), unloaded ? 'Drop this folder onto the map, or select Open project. Browsers need your permission to read local files.' : 'Change your search or clear the filters.');
  setText(document.getElementById('empty-clear'), unloaded ? 'Open project' : 'Clear filters');
  renderList(info);
  updateFilterSummary();
}

function updateSettingsControls() {
  if (!dom.layoutSpacing) return;
  const spacing = Math.round(state.view.layoutSpacing * 100);
  const nodeScale = Math.round(state.view.nodeScale * 100);
  const labelScale = Math.round(state.view.labelScale * 100);
  const edgeOpacity = Math.round(state.view.edgeOpacity * 100);
  const animationSpeed = Math.round(state.view.animationSpeed * 100);
  dom.layoutSpacing.value = String(spacing);
  document.getElementById('background-connections').checked = state.view.edgeDisplay !== 'selected';
  dom.layoutMode.value = state.view.layoutMode;
  dom.labelScale.value = String(labelScale);
  dom.edgeOpacity.value = String(edgeOpacity);
  dom.animationSpeed.value = String(animationSpeed);
  dom.layoutSpacingValue.textContent = `${spacing}%`;
  dom.labelScaleValue.textContent = `${labelScale}%`;
  dom.edgeOpacityValue.textContent = `${edgeOpacity}%`;
  dom.animationSpeedValue.textContent = `${animationSpeed}%`;
  dom.motionToggle.checked = state.view.animationEnabled === true;
  dom.edgeLabelMode.checked = state.view.edgeLabelMode === 'always';
  dom.backgroundColor.value = state.view.backgroundColor;
  document.getElementById('theme-custom').value = state.view.backgroundColor;
  let presetTheme = false;
  for (const [id, color] of [['theme-night', '#0c1220'], ['theme-slate', '#202936'], ['theme-black', '#080a0e']]) {
    const active = state.view.backgroundColor === color;
    document.getElementById(id).setAttribute('aria-pressed', String(active));
    presetTheme ||= active;
  }
  document.getElementById('theme-custom').parentElement?.classList.toggle('is-active', !presetTheme);
  const controls = { 'link-distance': state.view.linkDistance, repulsion: Math.round(state.view.repulsion * 100), 'overview-mode': state.view.overviewMode, 'connection-display': state.view.edgeDisplay, 'inferred-opacity': Math.round(state.view.inferredOpacity * 100) };
  for (const [id, value] of Object.entries(controls)) {
    const control = document.getElementById(id);
    if (control) control.value = String(value);
    const output = document.getElementById(`${id}-value`);
    if (output) output.textContent = `${value}${['repulsion', 'inferred-opacity'].includes(id) ? '%' : ''}`;
  }
  document.getElementById('legend-solid').checked = state.view.showSolid !== false;
  document.getElementById('legend-inferred').checked = state.view.showInferred !== false;
  const inferredToggle = document.getElementById('show-inferred');
  if (inferredToggle) inferredToggle.checked = state.view.showInferred;
}

function syncView() {
  state.view = { ...state.view, positions: state.view.positions ?? {} };
  if (document.getElementById('label-edges')) document.getElementById('label-edges').checked = state.view.labelEdges === true;
  updateSettingsControls();
  renderer.setView(state.view);
  updateStats();
  renderFilters();
  renderInspector();
}

function adoptDocument(input, sourceLabel, operation = beginDocumentOperation()) {
  if (!isCurrentDocumentOperation(operation)) return false;
  const normalized = normalizeGraphDocument(input);
  if (normalized.nodes.length === 0) throw new Error('The graph contains no usable nodes.');
  state.document = normalized;
  setText(document.getElementById('source-hint'), `${sourceLabel} · ${formatNumber(normalized.nodes.length)} nodes loaded`);
  state.view = emptyView(normalized);
  setPanel(dom.inspectorPanel, false);
  renderer.setDocument(normalized);
  syncView();
  requestAnimationFrame(() => {
    if (!isCurrentDocumentOperation(operation)) return;
    renderer.fit();
    setText(document.getElementById('project-notice-time'), `Loaded in ${((Date.now() - importStartedAt) / 1000).toFixed(1)} s · device-dependent`);
  });
  updateStatus({ visibleNodes: normalized.nodes.length, totalNodes: normalized.nodes.length, visibleEdges: normalized.edges.length, totalEdges: normalized.edges.length, truncated: false });
  const count = normalized.nodes.length;
  const guidance = count <= 300 ? 'Within the recommended everyday viewing range.' : count <= 1000 ? 'For a smoother view, keep Architecture layers and use filters or Show neighbors.' : 'Large map: explore smaller neighborhoods. Force layout may be slow.';
  setText(document.getElementById('project-notice-count'), `${formatNumber(count)} nodes · ${formatNumber(normalized.edges.length)} connections`);
  setText(document.getElementById('project-notice-guidance'), guidance + (normalized.coverage.partial ? ' Partial coverage: some files were skipped.' : ''));
  setText(document.getElementById('project-notice-time'), `Preparing map…`);
  const notice = document.getElementById('project-notice');
  if (notice) notice.hidden = false;
  window.clearTimeout(projectNoticeTimer);
  projectNoticeTimer = window.setTimeout(() => { if (notice) notice.hidden = true; }, 14000);
  return true;
}

function applySavedView(payload, quiet = false, operation = beginDocumentOperation()) {
  if (!isCurrentDocumentOperation(operation)) return false;
  if (!payload || payload.fingerprint !== state.document.fingerprint) {
    if (!quiet) showToast('Saved view revision or graph fingerprint does not match the loaded graph.', 'warning');
    return false;
  }
  const normalized = normalizeSavedView(payload.view, state.document);
  if (!normalized) return false;
  state.view = normalized;
  syncView();
  setPanel(dom.inspectorPanel, Boolean(state.view.selectedId), false);
  if (!quiet) showToast('Saved view restored.');
  return true;
}

function saveView() {
  const payload = {
    type: 'codeweb-view',
    schemaVersion: 'codeweb-view/1',
    fingerprint: state.document.fingerprint,
    repository: state.document.repository,
    savedAt: new Date().toISOString(),
    view: viewForStorage(renderer.getView())
  };
  try {
    window.localStorage.setItem(localViewKey(state.document), JSON.stringify(payload));
    showToast('Saved this view in browser storage. Use Export view to share a file.');
  } catch {
    showToast('Browser storage is unavailable. Use Export view instead.', 'warning');
  }
}

function exportFilename(kind, extension) {
  const name = (state.document.repository?.name || 'CodeWeb').replace(/[<>:"/\\|?*\s]+/g, '-').replace(/^-+|-+$/g, '') || 'CodeWeb';
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
  return `${name}-${time}-${kind}.${extension}`;
}

function exportView() {
  const payload = {
    type: 'codeweb-view',
    schemaVersion: 'codeweb-view/1',
    fingerprint: state.document.fingerprint,
    repository: state.document.repository,
    savedAt: new Date().toISOString(),
    view: viewForStorage(renderer.getView())
  };
  downloadBlob(JSON.stringify(payload, null, 2), exportFilename('view', 'json'), 'application/json');
  showToast('Saved view exported.');
}

function exportGraph() {
  const view = renderer.getView();
  const document = { ...state.document, positions: view.positions, stats: { ...state.document.stats, visibleNodes: renderer.visibleNodeIds.size } };
  downloadBlob(JSON.stringify(document, null, 2), exportFilename('graph', 'json'), 'application/json');
  showToast('Graph JSON exported.');
}

function exportSvg() {
  downloadBlob(renderer.exportSvg(), exportFilename('diagram', 'svg'), 'image/svg+xml');
  showToast('SVG diagram exported.');
}

function clearFilters() {
  state.view.overviewMode = 'all';
  state.view.isolationMode = 'all';
  state.view.showInferred = true;
  state.view.activeKinds = new Set();
  state.view.activeGroups = new Set();
  state.view.activeEdgeKinds = new Set();
  state.view.search = '';
  state.view.focusIds = null;
  syncView();
}

function selectNode(nodeId, focus = false) {
  if (!state.document.nodes.some((node) => node.id === nodeId)) return;
  state.view.focusIds = null;
  state.view.selectedId = nodeId;
  if (!renderer.visibleNodeIds.has(nodeId)) {
    state.view.search = '';
    state.view.activeKinds = new Set();
    state.view.activeGroups = new Set();
    state.view.activeEdgeKinds = new Set();
    state.view.focusIds = null;
    state.view.overviewMode = 'all';
  }
  syncView();
  renderInspector();
  setPanel(dom.inspectorPanel, true);
  if (focus) requestAnimationFrame(() => renderer.focusNode(nodeId));
}

function handleViewFile(file, operation = beginDocumentOperation()) {
  return readTextFile(file).then((text) => {
    if (!isCurrentDocumentOperation(operation)) return;
    const value = JSON.parse(text);
    if (isViewDocument(value)) {
      applySavedView(value, false, operation);
      return;
    }
    if (isGraphDocument(value)) {
      adoptDocument(value, file.name, operation);
      return;
    }
    throw new Error('The JSON file is not a compatible CodeWeb graph or saved view.');
  });
}

function cancelParserJob() {
  if (!activeParserJob) return;
  const job = activeParserJob;
  activeParserJob = null;
  job.settled = true;
  if (job.timer) window.clearTimeout(job.timer);
  job.worker?.terminate();
  job.resolve({ cancelled: true });
}

async function parseCodebase(records, options) {
  const operation = documentSequence;
  cancelParserJob();
  if (document.visibilityState === 'visible') await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  if (!isCurrentDocumentOperation(operation)) return { cancelled: true };
  const fallback = () => createCodebaseGraph(records, options);
  if (typeof Worker !== 'function') return Promise.resolve({ document: fallback() });
  const job = { worker: null, resolve: null, timer: null, settled: false };
  const promise = new Promise((resolve) => {
    job.resolve = resolve;
  });
  activeParserJob = job;
  try {
    const worker = new Worker(new URL('./parser-worker.js', import.meta.url), { type: 'module' });
    job.worker = worker;
    const finish = (result) => {
      if (job.settled) return;
      job.settled = true;
      if (job.timer) window.clearTimeout(job.timer);
      if (activeParserJob === job) activeParserJob = null;
      worker.terminate();
      job.resolve(result);
    };
    worker.addEventListener('message', (event) => {
      if (event.data?.type === 'result') finish({ document: event.data.document });
      else finish({ error: new Error(event.data?.message ?? 'Codebase parser worker failed.') });
    });
    worker.addEventListener('error', () => {
      try {
        finish({ document: fallback() });
      } catch (error) {
        finish({ error });
      }
    });
    job.timer = window.setTimeout(() => finish({ error: new Error('Codebase parsing exceeded the browser time limit.') }), 30000);
    worker.postMessage({ records, options });
  } catch {
    activeParserJob = null;
    return Promise.resolve({ document: fallback() });
  }
  return promise;
}

async function handleRecords(records, sourceLabel, operation = beginDocumentOperation()) {
  if (records.length === 0) throw new Error('No files were found in the selection.');
  if (!isCurrentDocumentOperation(operation)) return;
  const graphCandidates = [];
  for (const record of records) {
    if (!record.path.toLowerCase().endsWith('.json') || record.bytes > 40 * 1024 * 1024) continue;
    try {
      const value = JSON.parse(record.text);
      if (isGraphDocument(value) || isViewDocument(value)) graphCandidates.push({ record, value });
    } catch {
      continue;
    }
  }
  if (graphCandidates.length > 1) throw new Error('More than one graph JSON was found. Drop one graph export or a source folder without graph exports.');
  if (graphCandidates.length === 1) {
    const candidate = graphCandidates[0];
    if (isViewDocument(candidate.value)) applySavedView(candidate.value, false, operation);
    else adoptDocument(candidate.value, candidate.record.path, operation);
    return;
  }
  setBusy(true, 'Finding nodes and connections…');
  const parsed = await parseCodebase(records, { stripCommonRoot: true, name: sourceLabel });
  if (parsed.cancelled) return;
  if (parsed.error) throw parsed.error;
  adoptDocument(parsed.document, sourceLabel, operation);
}

async function processFileList(fileList, sourceLabel) {
  const operation = beginDocumentOperation();
  cancelParserJob();
  setBusy(true, 'Reading dropped files…');
  try {
    const records = await recordsFromFileList(fileList);
    if (!isCurrentDocumentOperation(operation)) return;
    await handleRecords(records, sourceLabel, operation);
  } catch (error) {
    if (isCurrentDocumentOperation(operation)) showToast(error instanceof Error ? error.message : String(error), 'warning');
  } finally {
    if (isCurrentDocumentOperation(operation)) setBusy(false);
  }
}

async function processDrop(dataTransfer) {
  const operation = beginDocumentOperation();
  cancelParserJob();
  setBusy(true, 'Reading dropped files…');
  try {
    const records = await recordsFromDataTransfer(dataTransfer);
    if (!isCurrentDocumentOperation(operation)) return;
    await handleRecords(records, 'dropped selection', operation);
  } catch (error) {
    if (isCurrentDocumentOperation(operation)) showToast(error instanceof Error ? error.message : String(error), 'warning');
  } finally {
    if (isCurrentDocumentOperation(operation)) setBusy(false);
  }
}

function setPanel(panel, open, fitView = false) {
  const changed = panel.classList.contains('is-open') !== open;
  const other = panel === dom.sidebar ? dom.inspectorPanel : dom.sidebar;
  if (open && other.classList.contains('is-open')) setPanel(other, false, fitView);
  panel.classList.toggle('is-open', open);
  panel.classList.toggle('is-collapsed', !open);
  const launcher = panel === dom.sidebar ? dom.sidebarLauncher : dom.inspectorLauncher;
  launcher.hidden = panel === dom.inspectorPanel && !state.view.selectedId;
  launcher.setAttribute('aria-expanded', String(open));
  dom.body.classList.toggle(panel === dom.sidebar ? 'sidebar-closed' : 'inspector-closed', !open);
  if (changed && fitView) requestAnimationFrame(() => renderer.fit());
}

function setupDropTarget() {
  document.getElementById('dismiss-project-notice')?.addEventListener('click', () => { document.getElementById('project-notice').hidden = true; });
  const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');
  document.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    state.dragDepth += 1;
    dom.dropOverlay.classList.add('is-visible');
  });
  document.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (state.dragDepth === 0) dom.dropOverlay.classList.remove('is-visible');
  });
  document.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    state.dragDepth = 0;
    dom.dropOverlay.classList.remove('is-visible');
    processDrop(event.dataTransfer);
  });
}

function setupControls() {
  dom.search.addEventListener('input', () => {
    state.view.search = dom.search.value;
    state.view.focusIds = null;
    syncView();
  });
  dom.search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const first = getVisibleNodeIds(state.document, state.view, createIndexes(state.document), 1).values().next().value;
      if (first) selectNode(first, true);
    }
    if (event.key === 'Escape') {
      dom.search.value = '';
      state.view.search = '';
      syncView();
    }
  });
  dom.searchClear.addEventListener('click', () => {
    dom.search.value = '';
    state.view.search = '';
    syncView();
    dom.search.focus();
  });
  document.getElementById('empty-clear').addEventListener('click', () => {
    if (state.document.nodes.length === 0) document.getElementById('open-folder').click();
    else clearFilters();
  });
  document.getElementById('clear-filters').addEventListener('click', clearFilters);
  document.getElementById('fit-graph').addEventListener('click', () => renderer.fit());
  document.getElementById('reset-layout').addEventListener('click', () => {
    state.view.positions = {};
    renderer.resetPositions();
    requestAnimationFrame(() => renderer.fit());
    showToast('Dragged positions and pins were cleared.');
  });
  document.getElementById('zoom-in').addEventListener('click', () => renderer.zoomBy(1.2));
  document.getElementById('zoom-out').addEventListener('click', () => renderer.zoomBy(0.83));
  document.getElementById('clear-selection').addEventListener('click', () => {
    state.view.selectedId = null;
    syncView();
    setPanel(dom.inspectorPanel, false);
  });
  document.getElementById('label-edges').addEventListener('change', (event) => {
    state.view.labelEdges = event.target.checked;
    syncView();
  });
  dom.layoutMode.addEventListener('change', (event) => {
    state.view.layoutMode = event.target.value;
    state.view.positions = Object.fromEntries(Object.entries(state.view.positions).filter(([, position]) => position.pinned));
    syncView();
    requestAnimationFrame(() => renderer.fit());
  });
  dom.layoutSpacing.addEventListener('input', (event) => {
    state.view.layoutSpacing = settingNumber(Number(event.target.value) / 100, defaultViewSettings.layoutSpacing, 0.65, 1.6);
    state.view.positions = Object.fromEntries(Object.entries(state.view.positions).filter(([, position]) => position.pinned));
    syncView();
  });

  dom.labelScale.addEventListener('input', (event) => {
    state.view.labelScale = settingNumber(Number(event.target.value) / 100, defaultViewSettings.labelScale, 0.7, 1.6);
    syncView();
  });
  dom.edgeOpacity.addEventListener('input', (event) => {
    state.view.edgeOpacity = settingNumber(Number(event.target.value) / 100, defaultViewSettings.edgeOpacity, 0, 1);
    syncView();
  });
  dom.motionToggle.addEventListener('change', (event) => {
    state.view.animationEnabled = event.target.checked;
    syncView();
  });
  dom.animationSpeed.addEventListener('input', (event) => {
    state.view.animationSpeed = settingNumber(Number(event.target.value) / 100, defaultViewSettings.animationSpeed, 0.25, 2);
    syncView();
  });
  dom.edgeLabelMode.addEventListener('change', (event) => {
    state.view.edgeLabelMode = event.target.checked ? 'always' : 'off';
    state.view.labelEdges = false;
    syncView();
  });
  dom.backgroundColor.addEventListener('input', (event) => {
    state.view.backgroundColor = settingColor(event.target.value, defaultViewSettings.backgroundColor);
    syncView();
  });
  dom.resetSettings.addEventListener('click', () => {
    Object.assign(state.view, defaultViewSettings, { labelEdges: false });
    syncView();
    showToast('Graph settings reset.');
  });
  for (const [id, key, divisor, minimum, maximum] of [

    ['link-distance', 'linkDistance', 1, 0, 1500],
    ['repulsion', 'repulsion', 100, -10, 10]
  ]) {
    const control = document.getElementById(id);
    control?.addEventListener('input', (event) => {
      state.view[key] = settingNumber(Number(event.target.value) / divisor, defaultViewSettings[key], minimum, maximum);
      if (key === 'linkDistance' || key === 'repulsion') state.view.layoutMode = 'force';
      if (key === 'linkDistance' || key === 'repulsion') state.view.positions = Object.fromEntries(Object.entries(state.view.positions).filter(([, position]) => position.pinned));
      syncView();
    });
  }

  document.getElementById('overview-mode')?.addEventListener('change', event => {
    state.view.overviewMode = event.target.value;
    state.view.activeKinds = new Set();
    state.view.activeGroups = new Set();
    state.view.search = '';
    state.view.focusIds = null;
    syncView();
    requestAnimationFrame(() => renderer.fit());
  });
  for (const [id, color] of [['theme-night', '#0c1220'], ['theme-slate', '#202936'], ['theme-black', '#080a0e']]) {
    document.getElementById(id).addEventListener('click', () => { state.view.backgroundColor = color; syncView(); });
  }
  document.getElementById('theme-custom').addEventListener('input', event => {
    state.view.backgroundColor = settingColor(event.target.value, defaultViewSettings.backgroundColor);
    syncView();
  });

  document.getElementById('inferred-opacity').addEventListener('input', event => {
    state.view.inferredOpacity = Number(event.target.value) / 100;
    syncView();
  });
  document.getElementById('legend-solid').addEventListener('change', event => {
    state.view.showSolid = event.target.checked;
    syncView();
  });
  document.getElementById('legend-inferred').addEventListener('change', event => {
    state.view.showInferred = event.target.checked;
    syncView();
  });
  document.getElementById('legend-toggle').addEventListener('click', () => {
    const collapsed = document.getElementById('legend-panel').classList.toggle('is-collapsed');
    const handle = document.getElementById('legend-toggle');
    handle.setAttribute('aria-expanded', String(!collapsed));
    handle.textContent = collapsed ? 'Legend ▴' : 'Legend ▾';
  });
  document.getElementById('background-connections').addEventListener('change', event => {
    state.view.edgeDisplay = event.target.checked ? 'all' : 'selected';
    syncView();
  });
  document.getElementById('connection-display').addEventListener('change', event => {
    state.view.edgeDisplay = event.target.value;
    syncView();
  });
  document.getElementById('show-inferred')?.addEventListener('change', event => {
    state.view.showInferred = event.target.checked;
    syncView();
  });
  for (const id of ['open-menu', 'export-menu']) {
    const menu = document.getElementById(id);
    menu.addEventListener('click', event => {
      if (event.target.closest?.('summary') && !menu.open) document.getElementById(id === 'open-menu' ? 'export-menu' : 'open-menu').open = false;
    });
    menu?.addEventListener('click', event => { if (event.target.tagName === 'BUTTON') menu.open = false; });
  }
  dom.settingsFit.addEventListener('click', () => renderer.fit());
  document.getElementById('export-svg').addEventListener('click', exportSvg);
  document.getElementById('export-graph').addEventListener('click', exportGraph);
  document.getElementById('export-view').addEventListener('click', exportView);
  document.getElementById('open-files').addEventListener('click', () => dom.fileInput.click());
  document.getElementById('open-folder').addEventListener('click', chooseCodebaseFolder);
  dom.fileInput.addEventListener('change', () => {
    if (dom.fileInput.files?.length) processFileList(dom.fileInput.files, 'selected files');
    dom.fileInput.value = '';
  });
  dom.folderInput.addEventListener('change', () => {
    if (dom.folderInput.files?.length) processFileList(dom.folderInput.files, 'selected folder');
    dom.folderInput.value = '';
  });

  dom.viewInput.addEventListener('change', async () => {
    const file = dom.viewInput.files?.[0];
    dom.viewInput.value = '';
    if (!file) return;
    const operation = beginDocumentOperation();
    try {
      await handleViewFile(file, operation);
    } catch (error) {
      if (isCurrentDocumentOperation(operation)) showToast(error instanceof Error ? error.message : String(error), 'warning');
    }
  });
  dom.sidebarLauncher.addEventListener('click', () => setPanel(dom.sidebar, !dom.sidebar.classList.contains('is-open')));
  dom.inspectorLauncher.addEventListener('click', () => setPanel(dom.inspectorPanel, !dom.inspectorPanel.classList.contains('is-open')));
  document.getElementById('close-sidebar').addEventListener('click', () => setPanel(dom.sidebar, false));
  document.getElementById('close-inspector').addEventListener('click', () => setPanel(dom.inspectorPanel, false));
  dom.searchShortcut.addEventListener('click', () => dom.search.focus());
  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && document.activeElement !== dom.search) {
      event.preventDefault();
      dom.search.focus();
    }
  });
}

function initialize() {
  state.view = emptyView(state.document);
  renderer = new GraphRenderer(dom.graphSvg, {
    
    onVisibility: updateStatus,
    onSelect: (nodeId) => selectNode(nodeId),
    onViewChange: (view) => {
      state.view = view;
      updateFilterSummary();
      updateSettingsControls();
    },
    onRequestReveal: (nodeId) => {
      state.view.search = '';
      state.view.activeKinds = new Set();
      state.view.activeGroups = new Set();
      state.view.activeEdgeKinds = new Set();
      state.view.focusIds = null;
      state.view.selectedId = nodeId;
      syncView();
    },
    onEscape: () => {
      state.view.selectedId = null;
      state.view.focusIds = null;
      syncView();
      setPanel(dom.inspectorPanel, false);
    }
  });
  renderer.setDocument(state.document);
  renderer.setView(state.view);
  setupDropTarget();
  setupControls();
  setPanel(dom.sidebar, false);
  setPanel(dom.inspectorPanel, false);
  updateStats();
  updateSettingsControls();
  renderFilters();
  renderInspector();
  requestAnimationFrame(() => renderer.fit());
  void autoLoadServerProject(false, beginDocumentOperation()).catch(() => false);
}

initialize();

// Release checks never include imported project data.
const APP_VERSION = '0.2.3';
const updateButton = document.getElementById('check-updates');
async function checkForUpdates() {
  if (!updateButton || updateButton.disabled) return;
  const releaseLink = document.getElementById('release-link');
  const status = (value, message) => {
    updateButton.dataset.state = value;
    updateButton.title = message;
    updateButton.setAttribute('aria-label', message + '. Click to check again.');
  };
  releaseLink.hidden = true;
  updateButton.disabled = true;
  status('unknown', 'Checking for updates');
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('https://api.github.com/repos/4Raisan/CodeWeb/releases/latest', { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    if (!response.ok) throw new Error('Release check unavailable');
    const release = await response.json();
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(release.tag_name || '');
    if (!match) throw new Error('Unrecognized release version');
    const latest = match.slice(1).map(Number);
    const current = APP_VERSION.split('.').map(Number);
    let newer = false;
    for (let i = 0; i < 3; i++) { if (latest[i] !== current[i]) { newer = latest[i] > current[i]; break; } }
    status(newer ? 'available' : 'current', newer ? `CodeWeb ${release.tag_name} is available` : `CodeWeb ${APP_VERSION} is up to date`);
    releaseLink.hidden = !newer;
  } catch {
    status('unknown', 'Offline or update check unavailable');
    releaseLink.hidden = true;
  } finally {
    window.clearTimeout(timeout);
    updateButton.disabled = false;
  }
}
updateButton?.addEventListener('click', checkForUpdates);
window.setTimeout(() => { void checkForUpdates(); }, 0);
