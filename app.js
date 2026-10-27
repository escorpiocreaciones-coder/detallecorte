import {
  ASSIGNMENT_STATUSES,
  DATA_VERSION,
  PROCESSES,
  STATUSES,
  assignmentStats,
  assignmentStatusLabel,
  assignmentsToCSV,
  colorNames,
  coloresFull,
  coloresSummary,
  computeColorTotal,
  computeFichaTotal,
  computeStats,
  countByStatus,
  fichaToText,
  filterAssignments,
  filterFichas,
  flattenAssignments,
  formatDate,
  isValidISODate,
  listWorkers,
  migrateFicha,
  normalize,
  processLabel,
  processProgress,
  sanitizeFicha,
  sanitizeWorkers,
  statusLabel,
  suggestNextNumero,
  tallasSummary,
  todayISO,
  toCSV,
  uid,
  validateBackup
} from './js/core.js';

const STORAGE_KEY = 'control-cortes.v1';
const THEME_KEY = 'control-cortes.theme';
const VALID_THEMES = ['auto', 'light', 'dark'];
const QUICK_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'Único'];
const VIEW_TITLES = { fichas: 'Fichas', reportes: 'Reportes', ajustes: 'Ajustes' };
const PROCESS_STATE_LABELS = {
  sin_asignar: 'Sin asignar',
  pendiente: 'Pendiente',
  en_proceso: 'En proceso',
  terminado: 'Terminado'
};
const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const state = {
  data: loadData(),
  query: '',
  status: 'todas',
  reportFrom: '',
  reportTo: '',
  reportWorker: '',
  reportProcess: '',
  route: null,
  sheet: null,
  deferredPrompt: null,
  toastTimer: null
};

let lastFocus = null;

function storedTheme() {
  try {
    const theme = localStorage.getItem(THEME_KEY);
    return VALID_THEMES.includes(theme) ? theme : 'auto';
  } catch {
    return 'auto';
  }
}

function loadData() {
  const fallback = {
    version: DATA_VERSION,
    fichas: [],
    settings: { theme: storedTheme(), trabajadores: [] }
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.fichas)) return fallback;
    const seen = new Set();
    const fichas = [];
    for (const item of parsed.fichas) {
      const ficha = migrateFicha(item);
      if (!ficha) continue;
      if (seen.has(ficha.id)) ficha.id = uid();
      seen.add(ficha.id);
      fichas.push(ficha);
    }
    const theme = VALID_THEMES.includes(parsed?.settings?.theme) ? parsed.settings.theme : storedTheme();
    const trabajadores = sanitizeWorkers([
      ...(Array.isArray(parsed?.settings?.trabajadores) ? parsed.settings.trabajadores : []),
      ...(Array.isArray(parsed?.trabajadores) ? parsed.trabajadores : [])
    ]);
    return { version: DATA_VERSION, fichas, settings: { theme, trabajadores } };
  } catch {
    return fallback;
  }
}

function persistData() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
    return true;
  } catch {
    toast('No se pudieron guardar los cambios en este teléfono.');
    return false;
  }
}

function persistMigrationIfNeeded() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.fichas) && parsed.version !== DATA_VERSION) persistData();
  } catch {}
}

function applyTheme(mode, options = {}) {
  const selected = VALID_THEMES.includes(mode) ? mode : 'auto';
  state.data.settings.theme = selected;
  try {
    localStorage.setItem(THEME_KEY, selected);
  } catch {
    if (options.notify) toast('No se pudo guardar el tema.');
  }
  const resolved = selected === 'auto' ? (darkMedia.matches ? 'dark' : 'light') : selected;
  document.documentElement.dataset.theme = resolved;
  const themeMeta = $('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute('content', resolved === 'dark' ? '#0b3d3a' : '#0f766e');
  $$('#theme-control [data-theme]').forEach((button) => {
    const active = button.dataset.theme === selected;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (options.persist) persistData();
}

function escapeHTML(value) {
  const replacements = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, (character) => replacements[character]);
}

function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Sin dato';
  return date.toLocaleString('es-CR', { dateStyle: 'short', timeStyle: 'short' });
}

function icon(id, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

function statusPill(statusId) {
  const pill = document.createElement('span');
  pill.className = `status-pill status-${statusId}`;
  pill.textContent = statusLabel(statusId);
  return pill;
}

function assignmentPill(statusId) {
  const pill = document.createElement('span');
  pill.className = `assignment-pill assignment-${statusId}`;
  pill.textContent = assignmentStatusLabel(statusId);
  return pill;
}

function toast(message) {
  const element = $('#toast');
  if (!element) return;
  element.textContent = message;
  element.classList.add('is-visible');
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => element.classList.remove('is-visible'), 2800);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function downloadText(text, filename, type) {
  downloadBlob(new Blob([text], { type }), filename);
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

function updateFab() {
  const view = state.route?.view ?? 'fichas';
  $('#fab-nueva').hidden = view !== 'fichas' || Boolean(state.sheet);
}

function setView(view) {
  $$('.view').forEach((section) => {
    section.hidden = section.dataset.view !== view;
  });
  $$('.nav-btn').forEach((button) => {
    const active = button.dataset.nav === view;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.title = `${VIEW_TITLES[view] ?? 'Fichas'} · Control de Cortes`;
  updateFab();
}

function sheetFocusables() {
  if (!state.sheet) return [];
  return $$('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', state.sheet.sheet)
    .filter((element) => element.getClientRects().length > 0);
}

function handleSheetKeydown(event) {
  if (!state.sheet) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    if (typeof state.sheet.onRequestClose === 'function') state.sheet.onRequestClose();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusables = sheetFocusables();
  if (focusables.length === 0) {
    event.preventDefault();
    state.sheet.sheet.focus();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === state.sheet.sheet)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function closeSheet(restoreFocus = true) {
  if (!state.sheet) return;
  document.removeEventListener('keydown', handleSheetKeydown, true);
  state.sheet.overlay.remove();
  document.body.classList.remove('modal-open');
  state.sheet = null;
  updateFab();
  if (restoreFocus && lastFocus && lastFocus.isConnected) {
    lastFocus.focus({ preventScroll: true });
  }
  lastFocus = null;
}

function mountSheet(options) {
  closeSheet(false);
  lastFocus = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const sheet = document.createElement('section');
  sheet.className = 'sheet';
  sheet.tabIndex = -1;
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', 'sheet-title');

  const head = document.createElement('div');
  head.className = 'sheet-head';
  const back = document.createElement('button');
  back.className = 'icon-btn small';
  back.type = 'button';
  back.setAttribute('aria-label', 'Volver');
  back.append(icon('i-arrow-left'));
  back.addEventListener('click', () => {
    if (typeof state.sheet?.onRequestClose === 'function') state.sheet.onRequestClose();
  });

  const titleWrap = document.createElement('div');
  const eyebrow = document.createElement('p');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = options.eyebrow ?? '';
  const title = document.createElement('h2');
  title.id = 'sheet-title';
  title.textContent = options.title ?? '';
  titleWrap.append(eyebrow, title);

  head.append(back, titleWrap);
  if (options.status) head.append(statusPill(options.status));
  sheet.append(head, options.body);
  if (options.actions) sheet.append(options.actions);

  overlay.append(sheet);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay && typeof state.sheet?.onRequestClose === 'function') state.sheet.onRequestClose();
  });

  $('#modal-root').replaceChildren(overlay);
  document.body.classList.add('modal-open');
  state.sheet = {
    overlay,
    sheet,
    body: options.body,
    onRequestClose: options.onRequestClose
  };
  document.addEventListener('keydown', handleSheetKeydown, true);
  updateFab();
  requestAnimationFrame(() => sheet.focus({ preventScroll: true }));
  return { overlay, sheet, body: options.body, actions: options.actions };
}

function parseRoute() {
  let parts = [];
  try {
    parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    parts = [];
  }
  if (!parts.length) return { view: 'fichas', sheet: null };
  const [first, second, third] = parts;
  if (first === 'ficha' && second) return { view: 'fichas', sheet: 'ficha', id: second };
  if (first === 'editar' && second) return { view: 'fichas', sheet: 'form', editId: second };
  if (first === 'procesos' && second && third) {
    return { view: 'fichas', sheet: 'procesos', id: second, colorId: third };
  }
  if (first === 'nueva') return { view: 'fichas', sheet: 'form', editId: null };
  if (Object.prototype.hasOwnProperty.call(VIEW_TITLES, first)) return { view: first, sheet: null };
  return { view: 'fichas', sheet: null };
}

function navigate(hash, options = {}) {
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  if (location.hash === target) {
    renderRoute();
    return;
  }
  if (options.replace) {
    history.replaceState(null, '', target);
    renderRoute();
  } else {
    location.hash = target;
  }
}

function renderRoute() {
  const previousView = state.route?.view ?? null;
  const route = parseRoute();
  state.route = route;
  closeSheet(false);
  setView(route.view);

  if (route.sheet === 'ficha') {
    const ficha = state.data.fichas.find((item) => item.id === route.id);
    if (!ficha) {
      toast('Esa ficha ya no existe.');
      navigate('#/fichas', { replace: true });
      return;
    }
    renderFichas();
    openFichaDetail(ficha);
  } else if (route.sheet === 'form') {
    const ficha = route.editId ? state.data.fichas.find((item) => item.id === route.editId) : null;
    if (route.editId && !ficha) {
      toast('Esa ficha ya no existe.');
      navigate('#/fichas', { replace: true });
      return;
    }
    renderFichas();
    openFichaForm(ficha);
  } else if (route.sheet === 'procesos') {
    const ficha = state.data.fichas.find((item) => item.id === route.id);
    const color = ficha?.colores?.find((item) => item.id === route.colorId);
    if (!ficha || !color) {
      toast('Ese color ya no existe.');
      navigate(ficha ? `#/ficha/${encodeURIComponent(ficha.id)}` : '#/fichas', { replace: true });
      return;
    }
    renderFichas();
    openProcessSheet(ficha, color);
  } else {
    renderFichas();
    if (route.view === 'reportes') renderReports();
    if (route.view === 'ajustes') renderSettings();
    if (previousView !== route.view) window.scrollTo({ top: 0, behavior: 'auto' });
  }

  updateFab();
}

function createFichaCard(ficha) {
  const card = document.createElement('a');
  card.className = `ficha-card status-${ficha.estado}`;
  card.href = `#/ficha/${encodeURIComponent(ficha.id)}`;
  card.setAttribute('aria-label', `Ficha ${ficha.numero}, ${ficha.modelo}, ${statusLabel(ficha.estado)}`);

  const top = document.createElement('div');
  top.className = 'ficha-top';
  const number = document.createElement('span');
  number.className = 'ficha-number';
  number.textContent = `N.º ${ficha.numero}`;
  top.append(number, statusPill(ficha.estado));

  const model = document.createElement('p');
  model.className = 'ficha-model';
  model.textContent = ficha.modelo;

  const sub = document.createElement('p');
  sub.className = 'ficha-sub';
  sub.textContent = [colorNames(ficha.colores), formatDate(ficha.fecha)].filter(Boolean).join(' · ');

  const foot = document.createElement('div');
  foot.className = 'ficha-foot';
  const pieces = document.createElement('span');
  pieces.className = 'ficha-pieces';
  const piecesStrong = document.createElement('strong');
  piecesStrong.textContent = String(ficha.total);
  pieces.append(piecesStrong, ' piezas');
  const sizes = document.createElement('span');
  sizes.className = 'ficha-sizes';
  sizes.textContent = coloresSummary(ficha.colores, 2, 2);
  foot.append(pieces, sizes);

  card.append(top, model, sub, foot);
  return card;
}

function renderFichas() {
  const total = state.data.fichas.length;
  const filtered = filterFichas(state.data.fichas, { query: state.query, status: state.status });
  const counts = countByStatus(state.data.fichas, state.query);
  const pieces = filtered.reduce((sum, ficha) => sum + (Number(ficha.total) || 0), 0);

  $('#head-stats').textContent = plural(total, 'ficha', 'fichas');
  $$('#status-filters [data-status]').forEach((button) => {
    const active = button.dataset.status === state.status;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  $$('#status-filters [data-count]').forEach((element) => {
    element.textContent = String(counts[element.dataset.count] ?? 0);
  });

  const search = $('#search-input');
  if (search.value !== state.query) search.value = state.query;
  $('#search-clear').hidden = !state.query;

  const filtering = Boolean(state.query) || state.status !== 'todas';
  $('#fichas-meta').textContent = filtering
    ? `${plural(filtered.length, 'ficha', 'fichas')} de ${total} · ${plural(pieces, 'pieza', 'piezas')}`
    : `${plural(total, 'ficha', 'fichas')} · ${plural(pieces, 'pieza', 'piezas')}`;

  $('#fichas-list').replaceChildren(...filtered.map(createFichaCard));
  const empty = $('#fichas-empty');
  empty.hidden = filtered.length > 0;

  if (filtered.length === 0) {
    const action = $('#empty-action');
    if (total === 0) {
      $('#empty-title').textContent = 'Aún no hay fichas';
      $('#empty-text').textContent = 'Crea tu primera ficha para controlar colores, tallas, procesos y responsables.';
      action.textContent = 'Crear primera ficha';
      action.href = '#/nueva';
      action.dataset.mode = 'create';
    } else {
      $('#empty-title').textContent = 'Sin resultados';
      $('#empty-text').textContent = 'No hay fichas que coincidan con la búsqueda o el estado seleccionado.';
      action.textContent = 'Limpiar filtros';
      action.href = '#/fichas';
      action.dataset.mode = 'clear';
    }
  }

  updateFab();
}

function clearFichaFilters() {
  state.query = '';
  state.status = 'todas';
  $('#search-input').value = '';
  renderFichas();
}

function bindFichasEvents() {
  const search = $('#search-input');
  search.addEventListener('input', () => {
    state.query = search.value;
    renderFichas();
  });
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      clearFichaFilters();
    }
  });
  $('#search-clear').addEventListener('click', () => {
    state.query = '';
    search.value = '';
    renderFichas();
    search.focus();
  });
  $('#status-filters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-status]');
    if (!button) return;
    state.status = button.dataset.status;
    renderFichas();
  });
  $('#empty-action').addEventListener('click', (event) => {
    if (event.currentTarget.dataset.mode === 'clear') {
      event.preventDefault();
      clearFichaFilters();
    }
  });
}

function refreshWorkerOptions() {
  const datalist = $('#workers-list');
  if (!datalist) return;
  const workers = listWorkers(state.data.fichas, state.data.settings.trabajadores);
  datalist.replaceChildren(...workers.map((worker) => {
    const option = document.createElement('option');
    option.value = worker;
    return option;
  }));
}

function reportFichas() {
  const base = filterFichas(state.data.fichas, { from: state.reportFrom, to: state.reportTo });
  if (!state.reportWorker && !state.reportProcess) return base;
  const rows = filterAssignments(flattenAssignments(base), {
    worker: state.reportWorker,
    process: state.reportProcess
  });
  const ids = new Set(rows.map((row) => row.fichaId));
  return base.filter((ficha) => ids.has(ficha.id));
}

function reportAssignments() {
  return filterAssignments(flattenAssignments(state.data.fichas), {
    from: state.reportFrom,
    to: state.reportTo,
    worker: state.reportWorker,
    process: state.reportProcess
  });
}

function fillReportWorkerOptions(workers) {
  const select = $('#report-worker');
  const current = state.reportWorker;
  select.replaceChildren(new Option('Todos los trabajadores', ''));
  for (const worker of workers) select.append(new Option(worker, worker));
  if (current && !workers.includes(current)) select.append(new Option(current, current));
  select.value = current;
}

function fillReportProcessOptions() {
  const select = $('#report-process');
  select.replaceChildren(new Option('Todos los procesos', ''));
  for (const process of PROCESSES) select.append(new Option(process.label, process.id));
  select.value = state.reportProcess;
}

function renderReports() {
  $('#report-from').value = state.reportFrom;
  $('#report-to').value = state.reportTo;
  fillReportWorkerOptions(listWorkers(state.data.fichas, state.data.settings.trabajadores));
  fillReportProcessOptions();

  const fichas = reportFichas();
  const assignments = reportAssignments();
  const stats = computeStats(fichas);
  const assignmentSummary = assignmentStats(assignments);

  $('#stat-fichas').textContent = String(stats.totalFichas);
  $('#stat-piezas').textContent = String(stats.totalPiezas);
  $('#stat-asignadas').textContent = String(assignmentSummary.cantidad);
  $('#stat-terminadas').textContent = String(assignmentSummary.terminado);
  $('#report-count').textContent = plural(fichas.length, 'ficha', 'fichas');

  renderStatusBreakdown(stats);
  renderWorkerBreakdown(assignmentSummary);
  renderProcessBreakdown(assignmentSummary);
  renderAssignmentList(assignments);
  renderReportFichas(fichas);
}

function renderStatusBreakdown(stats) {
  const breakdown = $('#status-breakdown');
  breakdown.replaceChildren();
  for (const status of STATUSES) {
    const data = stats.byStatus[status.id] ?? { count: 0, piezas: 0 };
    const row = document.createElement('div');
    row.className = `breakdown-row status-${status.id}`;
    const top = document.createElement('div');
    top.className = 'breakdown-top';
    const dot = document.createElement('span');
    dot.className = 'breakdown-dot';
    const label = document.createElement('span');
    label.textContent = status.label;
    const value = document.createElement('span');
    value.className = 'breakdown-value';
    value.textContent = `${plural(data.count, 'ficha', 'fichas')} · ${plural(data.piezas, 'pieza', 'piezas')}`;
    top.append(dot, label, value);
    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('span');
    fill.className = 'bar-fill';
    const percent = stats.totalFichas > 0 ? (data.count / stats.totalFichas) * 100 : 0;
    fill.style.width = `${percent}%`;
    track.append(fill);
    row.append(top, track);
    breakdown.append(row);
  }
}

function renderSummaryRows(container, empty, rows, emptyText) {
  container.replaceChildren();
  empty.hidden = rows.length > 0;
  for (const row of rows) {
    const item = document.createElement('div');
    item.className = 'summary-row';
    const top = document.createElement('div');
    top.className = 'summary-top';
    const title = document.createElement('span');
    title.className = 'summary-title';
    title.textContent = row.title;
    const meta = document.createElement('span');
    meta.className = 'summary-meta';
    meta.textContent = `${plural(row.cantidad, 'pieza asignada', 'piezas asignadas')} · ${row.terminado} terminadas`;
    top.append(title, meta);
    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('span');
    fill.className = 'bar-fill';
    fill.style.width = `${row.cantidad > 0 ? Math.min(100, Math.round((row.terminado / row.cantidad) * 100)) : 0}%`;
    track.append(fill);
    item.append(top, track);
    container.append(item);
  }
  if (rows.length === 0) empty.textContent = emptyText;
}

function renderWorkerBreakdown(summary) {
  const rows = summary.trabajadores.map((row) => ({
    title: row.trabajador,
    cantidad: row.cantidad,
    terminado: row.terminado
  }));
  renderSummaryRows(
    $('#worker-breakdown'),
    $('#worker-breakdown-empty'),
    rows,
    'No hay trabajadores con asignaciones en este filtro.'
  );
}

function renderProcessBreakdown(summary) {
  const rows = summary.procesos
    .filter((row) => row.count > 0)
    .map((row) => ({
      title: row.label,
      cantidad: row.cantidad,
      terminado: row.terminado
    }));
  renderSummaryRows(
    $('#process-breakdown'),
    $('#process-breakdown-empty'),
    rows,
    'No hay procesos con asignaciones en este filtro.'
  );
}

function renderAssignmentList(assignments) {
  const list = $('#assignment-list');
  list.replaceChildren(...assignments.map(createAssignmentReportRow));
  $('#assignment-count').textContent = plural(assignments.length, 'asignación', 'asignaciones');
  $('#assignment-empty').hidden = assignments.length > 0;
}

function createAssignmentReportRow(row) {
  const link = document.createElement('a');
  link.className = 'assignment-report-row';
  link.href = `#/ficha/${encodeURIComponent(row.fichaId)}`;
  const number = document.createElement('span');
  number.className = 'report-number';
  number.textContent = row.numero;
  const main = document.createElement('span');
  main.className = 'report-main';
  const title = document.createElement('strong');
  title.textContent = row.trabajador;
  const detail = document.createElement('small');
  detail.textContent = `${row.color} · ${row.proceso} · ${formatDate(row.fecha)}`;
  main.append(title, detail);
  const pieces = document.createElement('span');
  pieces.className = 'report-pieces';
  pieces.textContent = `${row.cantidad} pzs`;
  link.append(number, main, pieces, assignmentPill(row.estado));
  return link;
}

function renderReportFichas(fichas) {
  const list = $('#report-list');
  list.replaceChildren(...fichas.map(createReportRow));
  $('#report-empty').hidden = fichas.length > 0;
}

function createReportRow(ficha) {
  const row = document.createElement('a');
  row.className = `report-row status-${ficha.estado}`;
  row.href = `#/ficha/${encodeURIComponent(ficha.id)}`;
  const number = document.createElement('span');
  number.className = 'report-number';
  number.textContent = ficha.numero;
  const main = document.createElement('span');
  main.className = 'report-main';
  const model = document.createElement('strong');
  model.textContent = ficha.modelo;
  const detail = document.createElement('small');
  detail.textContent = [formatDate(ficha.fecha), colorNames(ficha.colores)].filter(Boolean).join(' · ');
  main.append(model, detail);
  const pieces = document.createElement('span');
  pieces.className = 'report-pieces';
  pieces.textContent = `${ficha.total} pzs`;
  const status = document.createElement('span');
  status.className = 'report-status';
  status.title = statusLabel(ficha.estado);
  row.append(number, main, pieces, status);
  return row;
}

function bindReportEvents() {
  const apply = () => {
    const from = $('#report-from').value;
    const to = $('#report-to').value;
    if (from && !isValidISODate(from)) {
      toast('La fecha desde no es válida.');
      return;
    }
    if (to && !isValidISODate(to)) {
      toast('La fecha hasta no es válida.');
      return;
    }
    if (from && to && from > to) {
      toast('La fecha desde no puede ser posterior a la fecha hasta.');
      return;
    }
    state.reportFrom = from;
    state.reportTo = to;
    state.reportWorker = $('#report-worker').value;
    state.reportProcess = $('#report-process').value;
    renderReports();
  };
  $('#report-apply').addEventListener('click', apply);
  ['#report-from', '#report-to'].forEach((selector) => {
    $(selector).addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        apply();
      }
    });
  });
  $('#report-clear').addEventListener('click', () => {
    state.reportFrom = '';
    state.reportTo = '';
    state.reportWorker = '';
    state.reportProcess = '';
    renderReports();
  });
  $('#export-csv').addEventListener('click', () => {
    const fichas = reportFichas();
    if (fichas.length === 0) {
      toast('No hay fichas para exportar.');
      return;
    }
    downloadText(toCSV(fichas), `fichas-corte-${todayISO()}.csv`, 'text/csv;charset=utf-8');
    toast('Archivo CSV de fichas descargado.');
  });
  $('#export-assignments-csv').addEventListener('click', () => {
    const rows = reportAssignments();
    if (rows.length === 0) {
      toast('No hay asignaciones para exportar.');
      return;
    }
    downloadText(assignmentsToCSV(rows), `procesos-${todayISO()}.csv`, 'text/csv;charset=utf-8');
    toast('Archivo CSV de procesos descargado.');
  });
  $('#print-report').addEventListener('click', () => {
    const fichas = reportFichas();
    const rows = reportAssignments();
    if (fichas.length === 0 && rows.length === 0) {
      toast('No hay datos para imprimir.');
      return;
    }
    printReport(fichas, rows);
  });
}

function startPrint(html) {
  const area = $('#print-area');
  area.innerHTML = html;
  area.setAttribute('aria-hidden', 'false');
  const cleanup = () => {
    area.replaceChildren();
    area.setAttribute('aria-hidden', 'true');
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  window.print();
}

function reportFilterLabel() {
  const parts = [];
  if (state.reportWorker) parts.push(`Trabajador: ${state.reportWorker}`);
  if (state.reportProcess) parts.push(`Proceso: ${processLabel(state.reportProcess)}`);
  return parts.join(' · ');
}

function printReport(fichas, assignments) {
  const stats = computeStats(fichas);
  const assignmentSummary = assignmentStats(assignments);
  const period = state.reportFrom || state.reportTo
    ? `Del ${state.reportFrom ? formatDate(state.reportFrom) : 'inicio'} al ${state.reportTo ? formatDate(state.reportTo) : 'hoy'}`
    : 'Todas las fichas';
  const filters = reportFilterLabel();
  const generated = new Date().toLocaleString('es-CR', { dateStyle: 'long', timeStyle: 'short' });
  const summary = STATUSES.map((status) => {
    const data = stats.byStatus[status.id] ?? { count: 0, piezas: 0 };
    return `<span>${escapeHTML(status.label)}: ${data.count} fichas · ${data.piezas} pzs</span>`;
  }).join('');
  const fichaRows = fichas.map((ficha) => `
    <tr class="print-list-row">
      <td>${escapeHTML(ficha.numero)}</td>
      <td>${escapeHTML(formatDate(ficha.fecha))}</td>
      <td><strong>${escapeHTML(ficha.modelo)}</strong><br><small>${escapeHTML(colorNames(ficha.colores))}</small></td>
      <td>${escapeHTML(coloresFull(ficha.colores))}</td>
      <td>${escapeHTML(statusLabel(ficha.estado))}</td>
      <td>${ficha.total}</td>
    </tr>`).join('');
  const assignmentRows = assignments.map((row) => `
    <tr class="print-list-row">
      <td>${escapeHTML(row.numero)}</td>
      <td>${escapeHTML(formatDate(row.fecha))}</td>
      <td>${escapeHTML(row.color)}</td>
      <td>${escapeHTML(row.proceso)}</td>
      <td>${escapeHTML(row.trabajador)}</td>
      <td>${row.cantidad}</td>
      <td>${escapeHTML(assignmentStatusLabel(row.estado))}</td>
    </tr>`).join('');

  startPrint(`
    <article class="print-doc">
      <header class="print-header">
        <div class="print-brand">Control de Cortes<small>Fichas de costura</small></div>
        <div class="print-generated">Generado el ${escapeHTML(generated)}</div>
      </header>
      <h1 class="print-title">Reporte de cortes y procesos</h1>
      <p class="print-subtitle">${escapeHTML(period)}${filters ? ` · ${escapeHTML(filters)}` : ''}</p>
      <div class="print-summary">
        <span>${plural(stats.totalFichas, 'ficha', 'fichas')}</span>
        <span>${plural(stats.totalPiezas, 'pieza', 'piezas')}</span>
        <span>${plural(assignmentSummary.cantidad, 'pieza asignada', 'piezas asignadas')}</span>
        <span>${plural(assignmentSummary.terminado, 'pieza terminada', 'piezas terminadas')}</span>
        ${summary}
      </div>
      <h2 class="print-section-title">Fichas</h2>
      <table class="print-table">
        <thead>
          <tr><th>Ficha</th><th>Fecha</th><th>Modelo / colores</th><th>Colores y tallas</th><th>Estado</th><th>Piezas</th></tr>
        </thead>
        <tbody>${fichaRows || '<tr><td colspan="6">Sin fichas en este filtro.</td></tr>'}</tbody>
      </table>
      <h2 class="print-section-title">Asignaciones de procesos</h2>
      <table class="print-table">
        <thead>
          <tr><th>Ficha</th><th>Fecha</th><th>Color</th><th>Proceso</th><th>Trabajador</th><th>Cantidad</th><th>Estado</th></tr>
        </thead>
        <tbody>${assignmentRows || '<tr><td colspan="7">Sin asignaciones en este filtro.</td></tr>'}</tbody>
      </table>
      <p class="print-footer">Control de Cortes · Datos guardados en el teléfono</p>
    </article>`);
}

function printFicha(ficha) {
  const generated = new Date().toLocaleString('es-CR', { dateStyle: 'long', timeStyle: 'short' });
  const colorSections = (ficha.colores ?? []).map((color) => {
    const sizeRows = (color.tallas ?? []).map((row) => `
      <tr><td>${escapeHTML(row.talla)}</td><td>${row.cantidad}</td></tr>`).join('');
    const assignments = [];
    for (const process of PROCESSES) {
      for (const row of color.procesos?.[process.id] ?? []) {
        assignments.push(`
          <tr>
            <td>${escapeHTML(process.label)}</td>
            <td>${escapeHTML(row.trabajador)}</td>
            <td>${row.cantidad}</td>
            <td>${escapeHTML(assignmentStatusLabel(row.estado))}</td>
          </tr>`);
      }
    }
    return `
      <section class="print-color">
        <h2 class="print-color-title">${escapeHTML(color.color)}<span>${plural(computeColorTotal(color), 'pieza', 'piezas')}</span></h2>
        <table class="print-table">
          <thead><tr><th>Talla</th><th>Cantidad</th></tr></thead>
          <tbody>${sizeRows}</tbody>
        </table>
        ${assignments.length ? `
          <table class="print-table">
            <thead><tr><th>Proceso</th><th>Trabajador</th><th>Cantidad</th><th>Estado</th></tr></thead>
            <tbody>${assignments.join('')}</tbody>
          </table>` : '<p class="print-empty">Sin procesos asignados.</p>'}
      </section>`;
  }).join('');

  startPrint(`
    <article class="print-doc">
      <header class="print-header">
        <div class="print-brand">Control de Cortes<small>Fichas de costura</small></div>
        <div class="print-generated">Generado el ${escapeHTML(generated)}</div>
      </header>
      <h1 class="print-title">Ficha de corte N.º ${escapeHTML(ficha.numero)}</h1>
      <p class="print-subtitle">${escapeHTML(ficha.modelo)}</p>
      <div class="print-grid">
        <div class="print-grid-item"><span>Fecha</span><strong>${escapeHTML(formatDate(ficha.fecha))}</strong></div>
        <div class="print-grid-item"><span>Colores</span><strong>${plural(ficha.colores.length, 'color', 'colores')}</strong></div>
        <div class="print-grid-item"><span>Estado</span><strong class="print-status">${escapeHTML(statusLabel(ficha.estado))}</strong></div>
        <div class="print-grid-item"><span>Total</span><strong>${plural(ficha.total, 'pieza', 'piezas')}</strong></div>
      </div>
      ${colorSections}
      <div class="print-total"><span>Total de piezas</span><strong>${ficha.total}</strong></div>
      ${ficha.notas ? `<div class="print-notes">${escapeHTML(ficha.notas)}</div>` : ''}
      <div class="print-signatures">
        <div class="print-signature">Cortado por</div>
        <div class="print-signature">Recibido por</div>
      </div>
      <p class="print-footer">Control de Cortes · Datos guardados en el teléfono</p>
    </article>`);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function isStandalone() {
  return state.installed || window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function updateInstallUI() {
  const installButton = $('#install-btn');
  const installTop = $('#install-top');
  const status = $('#install-status');
  if (isStandalone()) {
    installButton.hidden = true;
    installTop.hidden = true;
    status.textContent = 'La app ya está instalada en este teléfono.';
    return;
  }
  if (state.deferredPrompt) {
    installButton.hidden = false;
    installTop.hidden = false;
    status.textContent = 'Puedes instalarla como app y abrirla sin conexión.';
    return;
  }
  installButton.hidden = true;
  installTop.hidden = true;
  status.textContent = 'Si el botón no aparece, abre el menú del navegador y elige “Instalar aplicación”.';
}

function renderWorkersSettings() {
  const container = $('#settings-workers');
  if (!container) return;
  const workers = state.data.settings.trabajadores;
  container.replaceChildren();
  if (workers.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'Aún no hay trabajadores guardados.';
    container.append(empty);
    return;
  }
  for (const worker of workers) {
    const chip = document.createElement('span');
    chip.className = 'worker-chip';
    const name = document.createElement('span');
    name.textContent = worker;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.dataset.removeWorker = worker;
    remove.setAttribute('aria-label', `Quitar a ${worker}`);
    remove.append(icon('i-x', 'icon'));
    chip.append(name, remove);
    container.append(chip);
  }
}

function renderSettings() {
  applyTheme(state.data.settings.theme);
  updateInstallUI();
  renderWorkersSettings();
  const count = state.data.fichas.length;
  let bytes = 0;
  try {
    bytes = new Blob([JSON.stringify(state.data)]).size;
  } catch {
    bytes = 0;
  }
  $('#storage-info').textContent = `${plural(count, 'ficha guardada', 'fichas guardadas')} · ${formatBytes(bytes)} en este teléfono.`;
}

function addWorker() {
  const input = $('#worker-name');
  const name = input.value.trim();
  if (!name) {
    toast('Escribe el nombre del trabajador.');
    return;
  }
  if (name.length > 80) {
    toast('El nombre no puede pasar de 80 caracteres.');
    return;
  }
  const next = sanitizeWorkers([...state.data.settings.trabajadores, name]);
  if (next.length === state.data.settings.trabajadores.length) {
    toast('Ese trabajador ya está en la lista.');
    return;
  }
  state.data.settings.trabajadores = next;
  if (!persistData()) return;
  input.value = '';
  renderWorkersSettings();
  refreshWorkerOptions();
  toast('Trabajador agregado.');
}

function bindSettingsEvents() {
  $('#theme-control').addEventListener('click', (event) => {
    const button = event.target.closest('[data-theme]');
    if (!button) return;
    applyTheme(button.dataset.theme, { persist: true, notify: true });
  });
  $('#install-btn').addEventListener('click', promptInstall);
  $('#install-top').addEventListener('click', promptInstall);
  $('#worker-add').addEventListener('click', addWorker);
  $('#worker-name').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addWorker();
    }
  });
  $('#settings-workers').addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-worker]');
    if (!button) return;
    const worker = button.dataset.removeWorker;
    state.data.settings.trabajadores = state.data.settings.trabajadores.filter((name) => name !== worker);
    if (!persistData()) return;
    renderWorkersSettings();
    refreshWorkerOptions();
    toast('Trabajador quitado de las sugerencias.');
  });
  $('#backup-export').addEventListener('click', () => {
    const backup = {
      version: DATA_VERSION,
      app: 'control-fichas-corte',
      exportedAt: new Date().toISOString(),
      trabajadores: state.data.settings.trabajadores,
      fichas: state.data.fichas
    };
    downloadText(JSON.stringify(backup, null, 2), `respaldo-cortes-${todayISO()}.json`, 'application/json;charset=utf-8');
    toast('Respaldo descargado.');
  });
  $('#backup-import').addEventListener('click', () => $('#backup-file').click());
  $('#backup-file').addEventListener('change', importBackup);
  $('#clear-data').addEventListener('click', () => {
    const count = state.data.fichas.length;
    if (count === 0) {
      toast('No hay fichas para borrar.');
      return;
    }
    if (!window.confirm(`Se borrarán ${plural(count, 'ficha', 'fichas')} de este teléfono. Esta acción no se puede deshacer. ¿Continuar?`)) return;
    state.data.fichas = [];
    if (!persistData()) return;
    refreshWorkerOptions();
    renderFichas();
    renderReports();
    renderSettings();
    toast('Se borraron todas las fichas.');
    navigate('#/fichas', { replace: true });
  });
}

async function importBackup(event) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    window.alert('El archivo es demasiado grande para ser un respaldo válido.');
    return;
  }
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const result = validateBackup(parsed);
    if (!result.ok) {
      window.alert(`No se pudo restaurar el respaldo:\n\n${result.errors.join('\n')}`);
      return;
    }
    const count = result.fichas.length;
    if (!window.confirm(`Se reemplazarán las fichas actuales por ${plural(count, 'ficha', 'fichas')} del respaldo. ¿Continuar?`)) return;
    state.data.fichas = result.fichas;
    state.data.settings.trabajadores = result.trabajadores;
    if (!persistData()) return;
    refreshWorkerOptions();
    renderFichas();
    renderReports();
    renderSettings();
    toast('Respaldo restaurado.');
    navigate('#/fichas', { replace: true });
  } catch {
    window.alert('No se pudo leer el archivo. Asegúrate de que sea un respaldo JSON válido.');
  }
}

async function promptInstall() {
  if (!state.deferredPrompt) {
    toast('Abre el menú del navegador y elige “Instalar aplicación”.');
    return;
  }
  const promptEvent = state.deferredPrompt;
  state.deferredPrompt = null;
  promptEvent.prompt();
  const choice = await promptEvent.userChoice;
  updateInstallUI();
  if (choice.outcome === 'accepted') toast('Instalación iniciada.');
  else toast('Instalación cancelada.');
}

function colorAssignmentCount(ficha, colorId) {
  const color = ficha?.colores?.find((item) => item.id === colorId);
  if (!color) return 0;
  return PROCESSES.reduce((sum, process) => sum + (color.procesos?.[process.id]?.length ?? 0), 0);
}

function processItemsHTML(ficha, color) {
  return PROCESSES.map((process) => {
    const progress = processProgress(color, process.id);
    return `
      <a class="process-item process-${progress.estado}" href="#/procesos/${encodeURIComponent(ficha.id)}/${encodeURIComponent(color.id)}">
        <span class="process-name">${escapeHTML(process.label)}</span>
        <span class="process-count">${progress.assigned}/${progress.total}</span>
        <span class="process-state">${escapeHTML(PROCESS_STATE_LABELS[progress.estado])}</span>
        <span class="process-track"><span style="width:${progress.percent}%"></span></span>
      </a>`;
  }).join('');
}

function colorDetailHTML(ficha, color) {
  const sizeChips = (color.tallas ?? []).map((row) => (
    `<span class="size-chip">${escapeHTML(row.talla)} <strong>${row.cantidad}</strong></span>`
  )).join('');
  return `
    <section class="color-detail">
      <div class="color-detail-head">
        <div>
          <p class="eyebrow">Color</p>
          <h3>${escapeHTML(color.color)}</h3>
        </div>
        <span class="total-badge">${plural(computeColorTotal(color), 'pieza', 'piezas')}</span>
      </div>
      <div class="size-list">${sizeChips}</div>
      <div class="process-grid">${processItemsHTML(ficha, color)}</div>
      <a class="color-manage" href="#/procesos/${encodeURIComponent(ficha.id)}/${encodeURIComponent(color.id)}">
        <svg class="icon" aria-hidden="true"><use href="#i-edit"></use></svg>
        Gestionar procesos y responsables
      </a>
    </section>`;
}

function openFichaDetail(ficha) {
  const body = document.createElement('div');
  body.className = 'detail-body';
  const statusButtons = STATUSES.map((status) => {
    const active = status.id === ficha.estado;
    return `<button type="button" class="status-${status.id}${active ? ' is-active' : ''}" data-status="${status.id}" aria-pressed="${active}">${status.label}</button>`;
  }).join('');
  const notes = ficha.notas
    ? `<div class="panel"><h3>Notas</h3><p class="notes-text">${escapeHTML(ficha.notas)}</p></div>`
    : '';
  const whatsapp = `https://wa.me/?text=${encodeURIComponent(fichaToText(ficha))}`;

  body.innerHTML = `
    <div class="detail-hero">
      <p class="detail-number">Ficha de corte N.º ${escapeHTML(ficha.numero)}</p>
      <h3 class="detail-model">${escapeHTML(ficha.modelo)}</h3>
      <p class="detail-meta">${[colorNames(ficha.colores), formatDate(ficha.fecha)].filter(Boolean).map(escapeHTML).join(' · ')}</p>
    </div>
    <div class="info-grid">
      <div class="info-item"><span>Fecha</span><strong>${escapeHTML(formatDate(ficha.fecha))}</strong></div>
      <div class="info-item"><span>Colores</span><strong>${plural(ficha.colores.length, 'color', 'colores')}</strong></div>
      <div class="info-item"><span>Total</span><strong>${plural(ficha.total, 'pieza', 'piezas')}</strong></div>
      <div class="info-item"><span>Actualizada</span><strong data-detail-updated>${escapeHTML(formatDateTime(ficha.updatedAt))}</strong></div>
    </div>
    <div class="panel">
      <h3>Estado general</h3>
      <div class="segmented status-segmented" id="detail-status">${statusButtons}</div>
    </div>
    <div class="color-detail-list">${ficha.colores.map((color) => colorDetailHTML(ficha, color)).join('')}</div>
    ${notes}
    <div class="action-grid">
      <a class="action-btn" href="#/editar/${encodeURIComponent(ficha.id)}">
        <svg class="icon" aria-hidden="true"><use href="#i-edit"></use></svg>
        Editar
      </a>
      <button class="action-btn" id="detail-share" type="button">
        <svg class="icon" aria-hidden="true"><use href="#i-share"></use></svg>
        Compartir
      </button>
      <a class="action-btn" href="${whatsapp}" target="_blank" rel="noopener">
        <svg class="icon" aria-hidden="true"><use href="#i-share"></use></svg>
        WhatsApp
      </a>
      <button class="action-btn" id="detail-print" type="button">
        <svg class="icon" aria-hidden="true"><use href="#i-print"></use></svg>
        Imprimir
      </button>
      <button class="action-btn danger" id="detail-delete" type="button">
        <svg class="icon" aria-hidden="true"><use href="#i-trash"></use></svg>
        Borrar
      </button>
    </div>`;

  const mounted = mountSheet({
    eyebrow: 'Detalle de corte',
    title: `Ficha N.º ${ficha.numero}`,
    status: ficha.estado,
    body,
    onRequestClose: () => navigate('#/fichas', { replace: true })
  });

  body.querySelector('#detail-status').addEventListener('click', (event) => {
    const button = event.target.closest('[data-status]');
    if (!button) return;
    const updated = changeFichaStatus(ficha.id, button.dataset.status);
    if (updated) ficha = updated;
  });
  body.querySelector('#detail-share').addEventListener('click', () => shareFicha(ficha));
  body.querySelector('#detail-print').addEventListener('click', () => printFicha(ficha));
  body.querySelector('#detail-delete').addEventListener('click', () => deleteFicha(ficha));
  mounted.sheet.dataset.fichaId = ficha.id;
}

function changeFichaStatus(id, statusId) {
  if (!STATUSES.some((status) => status.id === statusId)) return null;
  const index = state.data.fichas.findIndex((ficha) => ficha.id === id);
  if (index < 0) return null;
  const current = state.data.fichas[index];
  if (current.estado === statusId) return current;
  const updated = { ...current, estado: statusId, updatedAt: new Date().toISOString() };
  state.data.fichas[index] = updated;
  if (!persistData()) return null;

  const body = state.sheet?.body;
  if (body) {
    $$('#detail-status [data-status]', body).forEach((button) => {
      const active = button.dataset.status === statusId;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const updatedAt = body.querySelector('[data-detail-updated]');
    if (updatedAt) updatedAt.textContent = formatDateTime(updated.updatedAt);
  }
  const pill = state.sheet?.sheet.querySelector('.sheet-head .status-pill');
  if (pill) {
    pill.className = `status-pill status-${statusId}`;
    pill.textContent = statusLabel(statusId);
  }
  renderFichas();
  renderReports();
  toast('Estado actualizado.');
  return updated;
}

async function shareFicha(ficha) {
  const text = fichaToText(ficha);
  try {
    if (navigator.share) {
      await navigator.share({ title: `Ficha ${ficha.numero}`, text });
      return;
    }
    await copyText(text);
    toast('Texto de la ficha copiado.');
  } catch (error) {
    if (error?.name !== 'AbortError') toast('No se pudo compartir la ficha.');
  }
}

function deleteFicha(ficha) {
  if (!window.confirm(`¿Borrar la ficha N.º ${ficha.numero} (${ficha.modelo})? Esta acción no se puede deshacer.`)) return;
  state.data.fichas = state.data.fichas.filter((item) => item.id !== ficha.id);
  if (!persistData()) return;
  refreshWorkerOptions();
  renderFichas();
  renderReports();
  renderSettings();
  toast('Ficha borrada.');
  navigate('#/fichas', { replace: true });
}

function sizeRowMarkup(row = {}) {
  const talla = String(row.talla ?? '');
  const cantidad = row.cantidad ?? '';
  return `
    <div class="size-row" data-size-row>
      <input type="text" data-size-name maxlength="20" placeholder="Talla" aria-label="Talla" autocomplete="off" value="${escapeHTML(talla)}">
      <input type="number" data-size-quantity min="0" step="1" inputmode="numeric" placeholder="Cant." aria-label="Cantidad" value="${escapeHTML(String(cantidad))}">
      <button class="icon-btn" type="button" data-remove-size aria-label="Quitar talla">
        <svg class="icon" aria-hidden="true"><use href="#i-trash"></use></svg>
      </button>
      <small class="field-error"></small>
    </div>`;
}

function quickSizesMarkup() {
  return QUICK_SIZES.map((size) => (
    `<button type="button" data-quick-size="${escapeHTML(size)}">${escapeHTML(size)}</button>`
  )).join('');
}

function colorBlockMarkup(color = {}) {
  const tallas = color.tallas?.length ? color.tallas : [{ talla: '', cantidad: '' }];
  const id = String(color.id ?? '');
  return `
    <section class="color-block" data-color-block data-color-id="${escapeHTML(id)}">
      <div class="color-block-head">
        <div class="field color-name-field">
          <span class="field-label">Color <span class="required">*</span></span>
          <input type="text" data-color-name maxlength="80" autocomplete="off" placeholder="Ej. Negro" value="${escapeHTML(color.color ?? '')}">
        </div>
        <div class="color-block-side">
          <span class="total-badge">Total: <strong data-color-total>0</strong></span>
          <button class="icon-btn color-remove" type="button" data-remove-color aria-label="Quitar color">
            <svg class="icon" aria-hidden="true"><use href="#i-trash"></use></svg>
          </button>
        </div>
      </div>
      <small class="field-error" data-color-error></small>
      <div class="quick-sizes">${quickSizesMarkup()}</div>
      <div class="sizes-rows" data-sizes-rows>${tallas.map((row) => sizeRowMarkup(row)).join('')}</div>
      <button class="btn btn-dashed" type="button" data-add-size>
        <svg class="icon" aria-hidden="true"><use href="#i-plus"></use></svg>
        Agregar talla
      </button>
      <small class="field-error" data-sizes-error></small>
    </section>`;
}

function addSizeRow(container, row = {}, shouldFocus = false) {
  container.insertAdjacentHTML('beforeend', sizeRowMarkup(row));
  const added = container.lastElementChild;
  if (shouldFocus) added.querySelector('[data-size-name]').focus();
  return added;
}

function addColorBlock(container, color = {}, shouldFocus = false) {
  container.insertAdjacentHTML('beforeend', colorBlockMarkup(color));
  const added = container.lastElementChild;
  updateColorLabels(container);
  updateFormTotals(container.closest('form'));
  if (shouldFocus) added.querySelector('[data-color-name]').focus();
  return added;
}

function updateColorLabels(form) {
  $$('[data-color-block]', form).forEach((block, index) => {
    const label = block.querySelector('.color-name-field .field-label');
    if (label) {
      label.innerHTML = `Color ${index + 1} <span class="required">*</span>`;
    }
  });
}

function updateFormTotals(form) {
  if (!form) return;
  let grandTotal = 0;
  for (const block of $$('[data-color-block]', form)) {
    const total = $$('[data-size-quantity]', block).reduce((sum, input) => {
      const quantity = Number(input.value);
      return sum + (Number.isInteger(quantity) && quantity > 0 ? quantity : 0);
    }, 0);
    const badge = block.querySelector('[data-color-total]');
    if (badge) badge.textContent = String(total);
    grandTotal += total;
  }
  const badge = $('#form-total', form);
  if (badge) badge.textContent = String(grandTotal);
}

function clearFormErrors(form) {
  const alert = $('#form-alert', form);
  if (alert) {
    alert.hidden = true;
    alert.textContent = '';
  }
  $$('.field-error', form).forEach((element) => {
    element.textContent = '';
  });
  $$('.is-invalid', form).forEach((element) => element.classList.remove('is-invalid'));
}

function markInvalid(element) {
  if (element) element.classList.add('is-invalid');
}

function showFormErrors(form, errors) {
  const alert = $('#form-alert', form);
  if (alert) {
    alert.textContent = 'Revisa los campos marcados antes de guardar.';
    alert.hidden = false;
  }
  const blocks = $$('[data-color-block]', form);
  let firstFocus = null;

  for (const [key, message] of Object.entries(errors)) {
    const colorMatch = key.match(/^color_(\d+)$/);
    const sizeMatch = key.match(/^talla_(\d+)_(\d+)$/);
    const sizesMatch = key.match(/^tallas_(\d+)$/);
    const processMatch = key.match(/^(?:proceso|asignacion)_(\d+)_/);

    if (colorMatch) {
      const block = blocks[Number(colorMatch[1])];
      if (!block) continue;
      const input = block.querySelector('[data-color-name]');
      const error = block.querySelector('[data-color-error]');
      markInvalid(input);
      if (error) error.textContent = message;
      if (!firstFocus) firstFocus = input;
      continue;
    }

    if (sizeMatch) {
      const block = blocks[Number(sizeMatch[1])];
      const row = block ? $$('[data-size-row]', block)[Number(sizeMatch[2])] : null;
      if (!row) continue;
      const name = row.querySelector('[data-size-name]');
      const quantity = row.querySelector('[data-size-quantity]');
      const error = row.querySelector('.field-error');
      markInvalid(name);
      markInvalid(quantity);
      if (error) error.textContent = message;
      if (!firstFocus) firstFocus = /cantidad/i.test(message) ? quantity : name;
      continue;
    }

    if (sizesMatch) {
      const block = blocks[Number(sizesMatch[1])];
      if (!block) continue;
      const error = block.querySelector('[data-sizes-error]');
      if (error) error.textContent = message;
      const firstRow = block.querySelector('[data-size-row]');
      if (firstRow) {
        markInvalid(firstRow.querySelector('[data-size-name]'));
        markInvalid(firstRow.querySelector('[data-size-quantity]'));
        if (!firstFocus) firstFocus = firstRow.querySelector('[data-size-name]');
      }
      continue;
    }

    if (processMatch) {
      const block = blocks[Number(processMatch[1])];
      if (!block) continue;
      const error = block.querySelector('[data-color-error]');
      if (error) {
        error.textContent = `${message} Corrige las asignaciones o ajusta las tallas.`;
      }
      continue;
    }

    const error = form.querySelector(`[data-error-for="${key}"]`);
    if (!error) continue;
    error.textContent = message;
    const field = error.closest('.field');
    const input = field?.querySelector('input, textarea');
    markInvalid(input);
    if (!firstFocus && input) firstFocus = input;
  }

  requestAnimationFrame(() => {
    if (firstFocus) {
      firstFocus.focus({ preventScroll: true });
      firstFocus.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } else if (alert) {
      alert.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  });
}

function openFichaForm(ficha) {
  const editing = Boolean(ficha);
  const values = {
    numero: ficha?.numero ?? suggestNextNumero(state.data.fichas),
    fecha: ficha?.fecha ?? todayISO(),
    modelo: ficha?.modelo ?? '',
    notas: ficha?.notas ?? '',
    estado: ficha?.estado ?? 'cortado',
    colores: ficha?.colores?.length ? ficha.colores : [{}]
  };
  const statusButtons = STATUSES.map((status) => {
    const active = status.id === values.estado;
    return `<button type="button" class="status-${status.id}${active ? ' is-active' : ''}" data-status="${status.id}" aria-pressed="${active}">${status.label}</button>`;
  }).join('');

  const form = document.createElement('form');
  form.className = 'form-body';
  form.id = 'ficha-form';
  form.noValidate = true;
  form.innerHTML = `
    <div class="form-alert" id="form-alert" hidden></div>
    <div class="form-grid two">
      <label class="field">
        <span class="field-label">Número <span class="required">*</span></span>
        <input id="form-numero" name="numero" type="text" maxlength="40" autocomplete="off" value="${escapeHTML(values.numero)}">
        <small class="field-error" data-error-for="numero"></small>
      </label>
      <label class="field">
        <span class="field-label">Fecha <span class="required">*</span></span>
        <input id="form-fecha" name="fecha" type="date" value="${escapeHTML(values.fecha)}">
        <small class="field-error" data-error-for="fecha"></small>
      </label>
    </div>
    <label class="field">
      <span class="field-label">Modelo <span class="required">*</span></span>
      <input id="form-modelo" name="modelo" type="text" maxlength="120" autocomplete="off" value="${escapeHTML(values.modelo)}">
      <small class="field-error" data-error-for="modelo"></small>
    </label>
    <div class="field">
      <span class="field-label">Estado general</span>
      <div class="segmented status-segmented" id="form-status">${statusButtons}</div>
    </div>
    <div class="colors-block">
      <div class="colors-head">
        <div>
          <span class="field-label">Colores y tallas <span class="required">*</span></span>
          <p class="field-hint">Cada color lleva sus propias tallas y cantidades.</p>
        </div>
        <span class="total-badge">Total: <strong id="form-total">0</strong></span>
      </div>
      <div id="color-blocks">${values.colores.map((color) => colorBlockMarkup(color)).join('')}</div>
      <button class="btn btn-dashed" id="add-color" type="button">
        <svg class="icon" aria-hidden="true"><use href="#i-plus"></use></svg>
        Agregar color
      </button>
      <small class="field-error" data-error-for="colores"></small>
    </div>
    <label class="field">
      <span class="field-label">Notas</span>
      <textarea id="form-notas" name="notas" maxlength="2000" rows="3" placeholder="Instrucciones, entregas, detalles...">${escapeHTML(values.notas)}</textarea>
      <small class="field-error" data-error-for="notas"></small>
    </label>`;

  const actions = document.createElement('div');
  actions.className = 'sheet-actions';
  actions.innerHTML = `
    <button class="btn" id="form-cancel" type="button">Cancelar</button>
    <button class="btn btn-primary" id="form-save" type="submit" form="ficha-form">${editing ? 'Guardar cambios' : 'Crear ficha'}</button>`;

  const returnHash = editing ? `#/ficha/${encodeURIComponent(ficha.id)}` : '#/fichas';
  const requestClose = () => navigate(returnHash, { replace: true });

  mountSheet({
    eyebrow: editing ? `Ficha N.º ${values.numero}` : 'Control de cortes',
    title: editing ? 'Editar ficha' : 'Nueva ficha',
    body: form,
    actions,
    onRequestClose: requestClose
  });

  const blocks = $('#color-blocks', form);
  $('#form-cancel', actions).addEventListener('click', requestClose);
  $('#add-color', form).addEventListener('click', () => addColorBlock(blocks, {}, true));

  blocks.addEventListener('click', (event) => {
    const quick = event.target.closest('[data-quick-size]');
    if (quick) {
      const block = quick.closest('[data-color-block]');
      const rows = block.querySelector('[data-sizes-rows]');
      const size = quick.dataset.quickSize;
      const names = $$('[data-size-name]', rows);
      const existing = names.find((input) => normalize(input.value) === normalize(size));
      if (existing) {
        existing.closest('[data-size-row]').querySelector('[data-size-quantity]').focus();
        return;
      }
      const empty = names.find((input) => !input.value.trim());
      const row = empty ? empty.closest('[data-size-row]') : addSizeRow(rows);
      const nameInput = row.querySelector('[data-size-name]');
      nameInput.value = size;
      nameInput.classList.remove('is-invalid');
      row.querySelector('[data-size-quantity]').focus();
      updateFormTotals(form);
      return;
    }

    const addSize = event.target.closest('[data-add-size]');
    if (addSize) {
      const block = addSize.closest('[data-color-block]');
      addSizeRow(block.querySelector('[data-sizes-rows]'), {}, true);
      updateFormTotals(form);
      return;
    }

    const removeSize = event.target.closest('[data-remove-size]');
    if (removeSize) {
      const row = removeSize.closest('[data-size-row]');
      const rows = row.parentElement;
      row.remove();
      if (rows.children.length === 0) addSizeRow(rows);
      updateFormTotals(form);
      return;
    }

    const removeColor = event.target.closest('[data-remove-color]');
    if (removeColor) {
      const block = removeColor.closest('[data-color-block]');
      const colorId = block.dataset.colorId;
      if (editing && colorId && colorAssignmentCount(ficha, colorId) > 0) {
        if (!window.confirm('Ese color tiene procesos asignados. Si lo quitas al guardar, también se perderán esas asignaciones. ¿Continuar?')) return;
      }
      block.remove();
      if (blocks.children.length === 0) addColorBlock(blocks, {});
      updateColorLabels(form);
      updateFormTotals(form);
    }
  });

  blocks.addEventListener('input', (event) => {
    const target = event.target;
    if (!target.matches('input')) return;
    target.classList.remove('is-invalid');
    const error = target.closest('.field, [data-size-row]')?.querySelector('.field-error');
    if (error) error.textContent = '';
    const block = target.closest('[data-color-block]');
    if (block) {
      const colorError = block.querySelector('[data-color-error]');
      const sizesError = block.querySelector('[data-sizes-error]');
      if (colorError) colorError.textContent = '';
      if (sizesError) sizesError.textContent = '';
    }
    updateFormTotals(form);
  });

  form.addEventListener('click', (event) => {
    const button = event.target.closest('#form-status [data-status]');
    if (!button) return;
    $$('#form-status [data-status]', form).forEach((item) => {
      const active = item === button;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-pressed', String(active));
    });
  });

  form.addEventListener('input', (event) => {
    if (!event.target.matches('input, textarea')) return;
    event.target.classList.remove('is-invalid');
    const field = event.target.closest('.field');
    const error = field?.querySelector('.field-error');
    if (error) error.textContent = '';
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    clearFormErrors(form);
    const selectedStatus = $('#form-status .is-active', form)?.dataset.status ?? 'cortado';
    const colores = $$('[data-color-block]', form).map((block) => {
      const colorId = block.dataset.colorId;
      const existingColor = colorId ? ficha?.colores?.find((color) => color.id === colorId) : null;
      return {
        id: colorId || undefined,
        color: block.querySelector('[data-color-name]').value,
        tallas: $$('[data-size-row]', block).map((row) => ({
          talla: row.querySelector('[data-size-name]').value,
          cantidad: row.querySelector('[data-size-quantity]').value
        })),
        procesos: existingColor?.procesos ?? {}
      };
    });
    const proposal = {
      numero: $('#form-numero', form).value,
      fecha: $('#form-fecha', form).value,
      modelo: $('#form-modelo', form).value,
      notas: $('#form-notas', form).value,
      estado: selectedStatus,
      colores
    };
    const result = sanitizeFicha(proposal, {
      fichas: state.data.fichas,
      currentId: ficha?.id ?? null
    });
    if (!result.ok) {
      showFormErrors(form, result.errors);
      return;
    }
    const previousFichas = state.data.fichas;
    if (editing) {
      const index = state.data.fichas.findIndex((item) => item.id === ficha.id);
      state.data.fichas = state.data.fichas.map((item) => (item.id === ficha.id ? result.ficha : item));
      if (index < 0) state.data.fichas.unshift(result.ficha);
    } else {
      state.data.fichas = [result.ficha, ...state.data.fichas];
    }
    if (!persistData()) {
      state.data.fichas = previousFichas;
      return;
    }
    refreshWorkerOptions();
    renderFichas();
    renderReports();
    renderSettings();
    toast(editing ? 'Ficha actualizada.' : 'Ficha creada.');
    navigate(`#/ficha/${encodeURIComponent(result.ficha.id)}`, { replace: true });
  });

  updateColorLabels(form);
  updateFormTotals(form);
  const firstColor = $('#color-blocks [data-color-name]', form);
  if (!editing && firstColor) requestAnimationFrame(() => firstColor.focus({ preventScroll: true }));
}

function assignmentRowMarkup(row = {}) {
  const options = ASSIGNMENT_STATUSES.map((status) => (
    `<option value="${status.id}"${(row.estado ?? 'pendiente') === status.id ? ' selected' : ''}>${escapeHTML(status.label)}</option>`
  )).join('');
  return `
    <div class="assignment-row" data-assignment-row data-assignment-id="${escapeHTML(row.id ?? '')}">
      <input type="text" data-worker list="workers-list" maxlength="80" autocomplete="off" placeholder="Trabajador" aria-label="Trabajador" value="${escapeHTML(row.trabajador ?? '')}">
      <input type="number" data-quantity min="1" step="1" inputmode="numeric" placeholder="Cant." aria-label="Cantidad" value="${escapeHTML(String(row.cantidad ?? ''))}">
      <select data-assignment-status aria-label="Estado del trabajo">${options}</select>
      <button class="icon-btn" type="button" data-remove-assignment aria-label="Quitar asignación">
        <svg class="icon" aria-hidden="true"><use href="#i-trash"></use></svg>
      </button>
      <small class="field-error"></small>
    </div>`;
}

function processEditorMarkup(color, process) {
  const progress = processProgress(color, process.id);
  const rows = color.procesos?.[process.id] ?? [];
  return `
    <section class="process-editor" data-process="${process.id}">
      <div class="process-editor-head">
        <div>
          <h3>${escapeHTML(process.label)}</h3>
          <p class="process-hint" data-process-count>${progress.assigned}/${progress.total} piezas asignadas</p>
        </div>
        <span class="process-state-pill state-${progress.estado}" data-process-state>${escapeHTML(PROCESS_STATE_LABELS[progress.estado])}</span>
      </div>
      <div class="assignment-rows" data-assignment-rows>
        ${rows.map((row) => assignmentRowMarkup(row)).join('')}
      </div>
      <button class="btn btn-dashed" type="button" data-add-assignment>
        <svg class="icon" aria-hidden="true"><use href="#i-plus"></use></svg>
        Agregar responsable
      </button>
      <small class="field-error" data-process-error></small>
    </section>`;
}

function updateProcessEditor(section, total) {
  let assigned = 0;
  let finished = 0;
  let inProgress = 0;
  let hasRows = false;
  for (const row of $$('[data-assignment-row]', section)) {
    const worker = row.querySelector('[data-worker]').value.trim();
    const quantity = Number(row.querySelector('[data-quantity]').value);
    const status = row.querySelector('[data-assignment-status]').value;
    if (!worker && (!Number.isInteger(quantity) || quantity <= 0)) continue;
    hasRows = true;
    if (Number.isInteger(quantity) && quantity > 0) {
      assigned += quantity;
      if (status === 'terminado') finished += quantity;
      else if (status === 'en_proceso') inProgress += quantity;
    }
  }
  let status = 'sin_asignar';
  if (hasRows) {
    if (finished >= total && assigned >= total) status = 'terminado';
    else if (finished > 0 || inProgress > 0) status = 'en_proceso';
    else status = 'pendiente';
  }
  const counter = section.querySelector('[data-process-count]');
  if (counter) {
    counter.textContent = `${assigned}/${total} piezas asignadas`;
    counter.classList.toggle('is-over', assigned > total);
  }
  const pill = section.querySelector('[data-process-state]');
  if (pill) {
    pill.className = `process-state-pill state-${status}`;
    pill.textContent = PROCESS_STATE_LABELS[status];
  }
}

function clearProcessErrors(form) {
  const alert = $('#process-alert', form);
  if (alert) {
    alert.hidden = true;
    alert.textContent = '';
  }
  $$('.field-error', form).forEach((element) => {
    element.textContent = '';
  });
  $$('.is-invalid', form).forEach((element) => element.classList.remove('is-invalid'));
}

function showProcessErrors(form, errors, colorIndex) {
  const alert = $('#process-alert', form);
  if (alert) {
    alert.textContent = 'Revisa las asignaciones marcadas antes de guardar.';
    alert.hidden = false;
  }
  let firstFocus = null;
  const unmapped = [];

  for (const [key, message] of Object.entries(errors)) {
    const rowMatch = key.match(new RegExp(`^asignacion_${colorIndex}_([a-z_]+)_(\\d+)$`));
    if (rowMatch) {
      const section = form.querySelector(`[data-process="${rowMatch[1]}"]`);
      const row = section ? $$('[data-assignment-row]', section)[Number(rowMatch[2])] : null;
      if (!row) {
        unmapped.push(message);
        continue;
      }
      const error = row.querySelector('.field-error');
      if (error) error.textContent = message;
      const worker = row.querySelector('[data-worker]');
      const quantity = row.querySelector('[data-quantity]');
      markInvalid(worker);
      markInvalid(quantity);
      if (!firstFocus) firstFocus = /cantidad/i.test(message) ? quantity : worker;
      continue;
    }

    const processMatch = key.match(new RegExp(`^proceso_${colorIndex}_([a-z_]+)$`));
    if (processMatch) {
      const section = form.querySelector(`[data-process="${processMatch[1]}"]`);
      const error = section?.querySelector('[data-process-error]');
      if (error) error.textContent = message;
      section?.classList.add('is-invalid');
      if (!firstFocus && section) firstFocus = section.querySelector('[data-worker]');
      continue;
    }

    unmapped.push(message);
  }

  if (alert && unmapped.length > 0) {
    alert.textContent = unmapped.join(' ');
  }

  requestAnimationFrame(() => {
    if (firstFocus) {
      firstFocus.focus({ preventScroll: true });
      firstFocus.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } else if (alert) {
      alert.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  });
}

function openProcessSheet(ficha, color) {
  refreshWorkerOptions();
  const colorIndex = ficha.colores.findIndex((item) => item.id === color.id);
  const total = computeColorTotal(color);
  const body = document.createElement('div');
  body.className = 'process-body';
  body.innerHTML = `
    <div class="process-hero">
      <p class="eyebrow">Color</p>
      <h3>${escapeHTML(color.color)}</h3>
      <p>${plural(total, 'pieza', 'piezas')} · ${escapeHTML(tallasSummary(color.tallas, 10))}</p>
    </div>
    <div class="form-alert" id="process-alert" hidden></div>
    <p class="panel-text process-intro">Puedes dividir cada proceso entre varios responsables. La suma asignada no debe pasar del total del color.</p>
    <div id="process-editors">${PROCESSES.map((process) => processEditorMarkup(color, process)).join('')}</div>`;

  const form = document.createElement('form');
  form.className = 'form-body';
  form.id = 'process-form';
  form.noValidate = true;
  form.append(body);

  const actions = document.createElement('div');
  actions.className = 'sheet-actions';
  actions.innerHTML = `
    <button class="btn" id="process-cancel" type="button">Cancelar</button>
    <button class="btn btn-primary" id="process-save" type="submit" form="process-form">Guardar procesos</button>`;

  const returnHash = `#/ficha/${encodeURIComponent(ficha.id)}`;
  const requestClose = () => navigate(returnHash, { replace: true });

  mountSheet({
    eyebrow: `Ficha N.º ${ficha.numero}`,
    title: `Procesos · ${color.color}`,
    status: ficha.estado,
    body: form,
    actions,
    onRequestClose: requestClose
  });

  const editors = $('#process-editors', body);
  $('#process-cancel', actions).addEventListener('click', requestClose);
  editors.addEventListener('click', (event) => {
    const add = event.target.closest('[data-add-assignment]');
    if (add) {
      const section = add.closest('[data-process]');
      section.querySelector('[data-assignment-rows]').insertAdjacentHTML('beforeend', assignmentRowMarkup({}));
      updateProcessEditor(section, total);
      section.querySelector('[data-assignment-row]:last-child [data-worker]')?.focus();
      return;
    }
    const remove = event.target.closest('[data-remove-assignment]');
    if (remove) {
      const section = remove.closest('[data-process]');
      remove.closest('[data-assignment-row]').remove();
      updateProcessEditor(section, total);
    }
  });
  editors.addEventListener('input', (event) => {
    const section = event.target.closest('[data-process]');
    if (!section) return;
    if (event.target.matches('input, select')) {
      event.target.classList.remove('is-invalid');
      const row = event.target.closest('[data-assignment-row]');
      const error = row?.querySelector('.field-error');
      if (error) error.textContent = '';
      section.classList.remove('is-invalid');
      const processError = section.querySelector('[data-process-error]');
      if (processError) processError.textContent = '';
      updateProcessEditor(section, total);
    }
  });
  editors.addEventListener('change', (event) => {
    const section = event.target.closest('[data-process]');
    if (section) updateProcessEditor(section, total);
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    clearProcessErrors(form);
    const procesos = {};
    for (const section of $$('.process-editor', form)) {
      procesos[section.dataset.process] = $$('[data-assignment-row]', section).map((row) => ({
        id: row.dataset.assignmentId || undefined,
        trabajador: row.querySelector('[data-worker]').value,
        cantidad: row.querySelector('[data-quantity]').value,
        estado: row.querySelector('[data-assignment-status]').value
      }));
    }
    const updatedColors = ficha.colores.map((item) => (
      item.id === color.id ? { ...item, procesos } : item
    ));
    const result = sanitizeFicha(
      {
        numero: ficha.numero,
        fecha: ficha.fecha,
        modelo: ficha.modelo,
        notas: ficha.notas,
        estado: ficha.estado,
        colores: updatedColors
      },
      { fichas: state.data.fichas, currentId: ficha.id }
    );
    if (!result.ok) {
      showProcessErrors(form, result.errors, colorIndex);
      return;
    }
    const index = state.data.fichas.findIndex((item) => item.id === ficha.id);
    if (index < 0) return;
    state.data.fichas[index] = result.ficha;
    if (!persistData()) return;
    refreshWorkerOptions();
    renderFichas();
    renderReports();
    renderSettings();
    toast('Procesos actualizados.');
    navigate(returnHash, { replace: true });
  });

  for (const section of $$('.process-editor', body)) updateProcessEditor(section, total);
}

function updateOnlineStatus() {
  const banner = $('#offline-banner');
  banner.hidden = navigator.onLine;
}

function setupInstallEvents() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.deferredPrompt = event;
    updateInstallUI();
  });
  window.addEventListener('appinstalled', () => {
    state.installed = true;
    state.deferredPrompt = null;
    updateInstallUI();
    toast('La app quedó instalada.');
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  const register = () => {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

function init() {
  applyTheme(state.data.settings.theme);
  persistMigrationIfNeeded();
  updateOnlineStatus();
  refreshWorkerOptions();
  bindFichasEvents();
  bindReportEvents();
  bindSettingsEvents();
  setupInstallEvents();
  darkMedia.addEventListener('change', () => {
    if (state.data.settings.theme === 'auto') applyTheme('auto');
  });
  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);
  window.addEventListener('hashchange', renderRoute);
  if (!location.hash) history.replaceState(null, '', '#/fichas');
  renderRoute();
  registerServiceWorker();
}

init();
