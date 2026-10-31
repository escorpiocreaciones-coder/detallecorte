import { APP_CONFIG, BACKEND_READY, backendConfig } from '../config.js';
import {
  adminAddAdmin,
  adminCreateAccessCode,
  adminExtendLicense,
  adminListAccessCodes,
  adminListAdmins,
  adminListTenants,
  adminMetrics,
  adminRecordPayment,
  adminRemoveAdmin,
  adminRevokeAccessCode,
  adminSetComped,
  adminSetStatus,
  adminSetTrial,
  adminTenantDetail,
  adminUpdateTenant,
  fetchMe,
  loadAuthState,
  refreshSession,
  saveAuthState,
  signIn,
  signOutRemote
} from './sync.js';
import { planLabel, statusLabel } from './license.js';
import { roleLabel } from './permissions.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const PLANS = ['trial', 'monthly', 'yearly', 'lifetime'];
const STATUSES = ['trialing', 'active', 'past_due', 'canceled', 'suspended', 'expired'];
const CURRENCIES = ['USD', 'CRC', 'MXN', 'GTQ', 'HNL', 'NIO', 'PAB', 'DOP', 'COP', 'PEN', 'CLP', 'ARS', 'EUR'];
const DIALOG_STATUS_LABELS = {
  active: 'Activa',
  trialing: 'En prueba',
  past_due: 'Pago pendiente',
  canceled: 'Cancelada',
  suspended: 'Suspendida',
  expired: 'Vencida'
};

const cached = loadAuthState();
const state = {
  session: cached.session,
  me: cached.me,
  metrics: {},
  tenants: [],
  admins: [],
  codes: [],
  codesError: '',
  codeResult: null,
  detail: null,
  search: '',
  loading: false,
  actionBusy: false,
  toastTimer: null
};

function escapeHTML(value) {
  const replacements = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, (character) => replacements[character]);
}

function money(cents, currency = 'USD') {
  const amount = Number(cents);
  if (!Number.isFinite(amount)) return '—';
  try {
    return new Intl.NumberFormat('es-CR', {
      style: 'currency',
      currency: currency || 'USD',
      maximumFractionDigits: 2
    }).format(amount / 100);
  } catch {
    return `$${(amount / 100).toFixed(2)}`;
  }
}

function dateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('es-CR', { dateStyle: 'short', timeStyle: 'short' });
}

function dayDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('es-CR', { dateStyle: 'medium' });
}

function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function toast(message) {
  const element = $('#admin-toast');
  if (!element) return;
  element.textContent = message;
  element.classList.add('is-visible');
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => element.classList.remove('is-visible'), 3200);
}

function showError(message) {
  const element = $('#admin-error');
  if (!element) return;
  element.textContent = message;
  element.hidden = !message;
}

function isAuthFailure(error) {
  if (error?.status === 401) return true;
  return /invalid refresh token|refresh token not found|jwt expired|invalid jwt|session.*expir/i.test(String(error?.message ?? ''));
}

function friendlyError(error) {
  if (isAuthFailure(error)) return 'La sesión expiró. Inicia sesión de nuevo.';
  const message = String(error?.message ?? '').trim();
  if (!message) return 'No se pudo completar la operación.';
  if (error?.offline || /failed to fetch|networkerror|load failed|fetch/i.test(message)) {
    return 'No se pudo conectar. Revisa tu internet.';
  }
  if (/invalid login credentials/i.test(message)) return 'Correo o contraseña incorrectos.';
  if (/no autorizado|not authorized/i.test(message)) return 'Esta cuenta no tiene permisos de administrador.';
  if (/row-level security|permission denied/i.test(message)) return 'Falta ejecutar supabase-setup.sql en Supabase.';
  if (/relation .* does not exist|does not exist/i.test(message)) return 'Faltan las tablas. Ejecuta supabase-setup.sql.';
  return message;
}

function persistAuth() {
  saveAuthState({
    session: state.session,
    me: state.me,
    verifiedAt: new Date().toISOString(),
    lastSyncedAt: cached.lastSyncedAt
  });
}

async function ensureSession() {
  if (!state.session) throw new Error('Inicia sesión.');
  if (!state.session.expiresAt || Date.now() < state.session.expiresAt - 60_000) return state.session;
  state.session = await refreshSession(backendConfig(), state.session);
  persistAuth();
  return state.session;
}

function showLogin(message = '') {
  $('#admin-loading').hidden = true;
  $('#admin-shell').hidden = true;
  $('#admin-setup').hidden = true;
  $('#admin-login').hidden = false;
  const error = $('#admin-login-error');
  if (error) {
    error.textContent = message;
    error.hidden = !message;
  }
  const email = $('#admin-email');
  if (email && !email.value) email.focus();
}

function showSetup() {
  $('#admin-loading').hidden = true;
  $('#admin-login').hidden = true;
  $('#admin-shell').hidden = true;
  $('#admin-setup').hidden = false;
}

function showShell() {
  $('#admin-loading').hidden = true;
  $('#admin-login').hidden = true;
  $('#admin-setup').hidden = true;
  $('#admin-shell').hidden = false;
}

function clearAuth(message = '') {
  const session = state.session;
  state.session = null;
  state.me = null;
  state.detail = null;
  state.tenants = [];
  state.codes = [];
  state.codesError = '';
  state.codeResult = null;
  saveAuthState({ session: null, me: null, verifiedAt: '', lastSyncedAt: '' });
  if (session) signOutRemote(backendConfig(), session);
  const dialog = $('#tenant-dialog');
  if (dialog?.open) dialog.close();
  showLogin(message);
}

function handleError(error) {
  if (isAuthFailure(error)) {
    clearAuth('La sesión expiró. Inicia sesión de nuevo.');
    return;
  }
  const message = friendlyError(error);
  showError(message);
  toast(message);
}

async function handleLogin(event) {
  event.preventDefault();
  if (state.actionBusy) return;
  const email = String($('#admin-email')?.value ?? '').trim();
  const password = String($('#admin-password')?.value ?? '');
  if (!email || !password) {
    showLogin('Escribe tu correo y contraseña.');
    return;
  }
  state.actionBusy = true;
  const button = $('#admin-login-btn');
  if (button) button.disabled = true;
  showLogin('');
  try {
    const session = await signIn(backendConfig(), email, password);
    const me = await fetchMe(backendConfig(), session);
    if (!me?.is_app_admin) {
      await signOutRemote(backendConfig(), session);
      throw new Error('Esta cuenta no tiene acceso al panel del vendedor.');
    }
    state.session = session;
    state.me = me;
    persistAuth();
    const passwordInput = $('#admin-password');
    if (passwordInput) passwordInput.value = '';
    showShell();
    renderUser();
    await loadAll();
  } catch (error) {
    const message = /no tiene acceso/i.test(String(error?.message ?? '')) ? error.message : friendlyError(error);
    showLogin(message);
  } finally {
    state.actionBusy = false;
    if (button) button.disabled = false;
  }
}

async function handleLogout() {
  const session = state.session;
  state.session = null;
  state.me = null;
  saveAuthState({ session: null, me: null, verifiedAt: '', lastSyncedAt: '' });
  if (session) await signOutRemote(backendConfig(), session);
  showLogin('');
  toast('Sesión cerrada.');
}

function renderUser() {
  const user = $('#admin-user');
  if (!user) return;
  user.textContent = state.me ? `${state.me.email || 'Administrador'} · ${state.me.tenant_name || ''}` : '';
}

async function loadAll(options = {}) {
  if (!state.session || state.loading) return;
  state.loading = true;
  showError('');
  try {
    const session = await ensureSession();
    const config = backendConfig();
    const [metrics, tenants, admins] = await Promise.all([
      adminMetrics(config, session),
      adminListTenants(config, session, state.search),
      adminListAdmins(config, session)
    ]);
    state.metrics = metrics && typeof metrics === 'object' ? metrics : {};
    state.tenants = Array.isArray(tenants) ? tenants : [];
    state.admins = Array.isArray(admins) ? admins : [];
    try {
      const codes = await adminListAccessCodes(config, session);
      state.codes = Array.isArray(codes) ? codes : [];
      state.codesError = '';
    } catch (error) {
      state.codes = [];
      state.codesError = friendlyError(error);
    }
    renderMetrics();
    renderTenants();
    renderAdmins();
    renderCodeTenants();
    renderCodes();
    if (options.notify) toast('Panel actualizado.');
  } catch (error) {
    handleError(error);
  } finally {
    state.loading = false;
  }
}

function metricCard(label, value, alert = false) {
  return `<div class="metric-card${alert ? ' is-alert' : ''}"><span>${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong></div>`;
}

function renderMetrics() {
  const container = $('#admin-metrics');
  if (!container) return;
  const metrics = state.metrics || {};
  const mrr = Number(metrics.mrr_cents) || 0;
  container.innerHTML = [
    metricCard('Negocios', String(metrics.tenants ?? 0)),
    metricCard('Con acceso', String(metrics.active ?? 0)),
    metricCard('Pagando', String(metrics.paying ?? 0)),
    metricCard('En prueba', String(metrics.trialing ?? 0)),
    metricCard('Vencen en 7 días', String(metrics.expiring_7d ?? 0), Number(metrics.expiring_7d) > 0),
    metricCard('Sin acceso', String(metrics.suspended ?? 0), Number(metrics.suspended) > 0),
    metricCard('MRR estimado', money(mrr, 'USD'))
  ].join('');
}

function subscriptionDate(tenant) {
  if (tenant.subscription_status === 'trialing') return tenant.trial_ends_at;
  return tenant.current_period_end;
}

function statusPill(tenant) {
  const status = String(tenant.subscription_status || '');
  const label = tenant.comped ? `${statusLabel(status)} · cortesía` : statusLabel(status);
  return `<span class="status-pill status-${escapeHTML(status)}">${escapeHTML(label)}</span>`;
}

function renderTenants() {
  const tbody = $('#admin-tenants');
  const count = $('#admin-count');
  if (!tbody) return;
  if (count) count.textContent = plural(state.tenants.length, 'negocio', 'negocios');
  if (state.tenants.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="muted">${state.search ? 'No hay negocios que coincidan con la búsqueda.' : 'Todavía no hay negocios registrados.'}</td></tr>`;
    return;
  }
  tbody.innerHTML = state.tenants.map((tenant) => `
    <tr>
      <td>
        <span class="tenant-name">${escapeHTML(tenant.name || 'Sin nombre')}</span>
        <small>${escapeHTML(tenant.tenant_id?.slice(0, 8) || '')} · desde ${escapeHTML(dayDate(tenant.created_at))}</small>
      </td>
      <td>${escapeHTML(tenant.owner_email || '—')}</td>
      <td>${escapeHTML(planLabel(tenant.plan))}</td>
      <td>${statusPill(tenant)}</td>
      <td>${escapeHTML(String(tenant.member_count ?? '—'))}</td>
      <td>
        ${escapeHTML(dayDate(subscriptionDate(tenant)))}
        <small>${tenant.last_sync ? `Sync ${escapeHTML(dateTime(tenant.last_sync))}` : 'Sin sincronizar'}</small>
      </td>
      <td>${escapeHTML(money(tenant.amount_cents, tenant.currency))}</td>
      <td><button class="btn btn-small" type="button" data-open-tenant="${escapeHTML(tenant.tenant_id)}">Ver</button></td>
    </tr>`).join('');
}

function renderAdmins() {
  const container = $('#admin-admins');
  if (!container) return;
  if (state.admins.length === 0) {
    container.innerHTML = '<p class="muted">No hay administradores registrados.</p>';
    return;
  }
  container.innerHTML = state.admins.map((admin) => {
    const isSelf = admin.user_id === state.me?.user_id;
    return `
      <div class="admin-admin-row">
        <div>
          <strong>${escapeHTML(admin.full_name || admin.email || 'Sin nombre')}</strong>
          <small>${escapeHTML(admin.email || '')} · desde ${escapeHTML(dayDate(admin.created_at))}</small>
        </div>
        ${isSelf ? '<span class="role-pill">Tú</span>' : `<button class="btn btn-small btn-danger" type="button" data-remove-admin="${escapeHTML(admin.user_id)}">Quitar</button>`}
      </div>`;
  }).join('');
}

function formatCode(code) {
  return String(code || '').replace(/(.{4})/g, '$1 ').trim();
}

function codeStatus(code) {
  if (code.revoked_at) return { key: 'revoked', label: 'Revocado' };
  if (!code.used_at) return { key: 'available', label: 'Disponible' };
  if (code.access_ends_at && Date.parse(code.access_ends_at) < Date.now()) {
    return { key: 'expired', label: 'Vencido' };
  }
  return { key: 'active', label: 'Activo' };
}

function renderCodeTenants() {
  const select = $('#admin-code-tenant');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">Nuevo cliente</option>'
    + state.tenants.map((tenant) => `<option value="${escapeHTML(tenant.tenant_id)}">${escapeHTML(tenant.name || 'Sin nombre')}</option>`).join('');
  if (current && state.tenants.some((tenant) => tenant.tenant_id === current)) {
    select.value = current;
  }
}

function renderCodeResult() {
  const container = $('#admin-code-result');
  if (!container) return;
  const result = state.codeResult;
  if (!result?.code) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }
  container.hidden = false;
  container.innerHTML = `
    <div>
      <span class="muted">Código para ${escapeHTML(result.label || 'nuevo cliente')}</span>
      <strong>${escapeHTML(formatCode(result.code))}</strong>
      <small>${escapeHTML(String(result.days || 30))} días desde la activación.</small>
    </div>
    <div class="btn-row">
      <button class="btn btn-primary btn-small" type="button" data-copy-code="${escapeHTML(result.code)}">Copiar</button>
      <button class="btn btn-small" type="button" data-clear-code-result>Listo</button>
    </div>`;
}

function renderCodes() {
  const tbody = $('#admin-codes');
  const count = $('#admin-code-count');
  if (!tbody) return;
  if (count) count.textContent = plural(state.codes.length, 'código', 'códigos');
  if (state.codesError) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">${escapeHTML(state.codesError)}</td></tr>`;
    return;
  }
  if (state.codes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">Todavía no hay códigos. Genera el primero arriba.</td></tr>';
    return;
  }
  tbody.innerHTML = state.codes.map((code) => {
    const status = codeStatus(code);
    const tenantName = code.tenant_name || code.label || 'Nuevo cliente';
    const usedBy = code.used_by_email || (code.used_at ? 'Dispositivo' : 'Sin usar');
    const actions = [
      `<button class="btn btn-small" type="button" data-copy-code="${escapeHTML(code.code)}">Copiar</button>`
    ];
    if (code.tenant_id) {
      actions.push(`<button class="btn btn-small" type="button" data-open-code-tenant="${escapeHTML(code.tenant_id)}">Ver</button>`);
    }
    if (code.used_at && code.tenant_id && code.revoked_at === null) {
      actions.push(`<button class="btn btn-small" type="button" data-extend-code="${escapeHTML(code.id)}">+30 días</button>`);
    }
    if (!code.revoked_at) {
      actions.push(`<button class="btn btn-small btn-danger" type="button" data-revoke-code="${escapeHTML(code.id)}">Revocar</button>`);
    }
    return `
      <tr>
        <td><span class="code-value">${escapeHTML(formatCode(code.code))}</span><small>${escapeHTML(code.notes || code.label || '')}</small></td>
        <td>${escapeHTML(tenantName)}<small>${escapeHTML(usedBy)}</small></td>
        <td><span class="status-pill status-${status.key}">${escapeHTML(status.label)}</span></td>
        <td>${code.used_at ? escapeHTML(dateTime(code.used_at)) : 'Sin usar'}</td>
        <td>${code.access_ends_at ? escapeHTML(dayDate(code.access_ends_at)) : '—'}</td>
        <td><div class="code-actions">${actions.join('')}</div></td>
      </tr>`;
  }).join('');
}

async function copyCode(code) {
  try {
    await navigator.clipboard.writeText(code);
    toast('Código copiado.');
  } catch {
    window.prompt('Copia el código:', code);
  }
}

async function handleCreateCode(event) {
  event.preventDefault();
  if (state.actionBusy) return;
  const label = String($('#admin-code-label')?.value ?? '').trim();
  const tenantId = String($('#admin-code-tenant')?.value ?? '') || null;
  const notes = String($('#admin-code-notes')?.value ?? '').trim();
  const days = Number($('#admin-code-days')?.value);
  if (!tenantId && !label) {
    toast('Escribe el nombre del cliente o elige un negocio.');
    return;
  }
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    toast('Los días deben estar entre 1 y 3650.');
    return;
  }
  state.actionBusy = true;
  try {
    const session = await ensureSession();
    const result = await adminCreateAccessCode(backendConfig(), session, {
      label,
      days,
      tenantId,
      notes
    });
    state.codeResult = result;
    renderCodeResult();
    const labelInput = $('#admin-code-label');
    const notesInput = $('#admin-code-notes');
    if (labelInput) labelInput.value = '';
    if (notesInput) notesInput.value = '';
    toast('Código generado.');
    await loadAll();
  } catch (error) {
    handleError(error);
  } finally {
    state.actionBusy = false;
  }
}

async function handleCodeClick(event) {
  const copy = event.target.closest('[data-copy-code]');
  if (copy) {
    await copyCode(copy.dataset.copyCode);
    return;
  }
  if (event.target.closest('[data-clear-code-result]')) {
    state.codeResult = null;
    renderCodeResult();
    return;
  }
  const open = event.target.closest('[data-open-code-tenant]');
  if (open) {
    await openTenant(open.dataset.openCodeTenant);
    return;
  }
  const extend = event.target.closest('[data-extend-code]');
  if (extend) {
    const code = state.codes.find((item) => item.id === extend.dataset.extendCode);
    if (!code?.tenant_id) return;
    if (!window.confirm('¿Agregar 30 días a este negocio?')) return;
    if (state.actionBusy) return;
    state.actionBusy = true;
    try {
      const session = await ensureSession();
      await adminExtendLicense(backendConfig(), session, code.tenant_id, 30, null, 'active');
      toast('30 días agregados.');
      await loadAll();
    } catch (error) {
      handleError(error);
    } finally {
      state.actionBusy = false;
    }
    return;
  }
  const revoke = event.target.closest('[data-revoke-code]');
  if (revoke) {
    if (!window.confirm('¿Revocar este código? No podrá usarse para activar otro dispositivo.')) return;
    if (state.actionBusy) return;
    state.actionBusy = true;
    try {
      const session = await ensureSession();
      await adminRevokeAccessCode(backendConfig(), session, revoke.dataset.revokeCode);
      toast('Código revocado.');
      await loadAll();
    } catch (error) {
      handleError(error);
    } finally {
      state.actionBusy = false;
    }
  }
}

function handleCodeTenantChange() {
  const select = $('#admin-code-tenant');
  const input = $('#admin-code-label');
  if (!select?.value || !input || input.value.trim()) return;
  const tenant = state.tenants.find((item) => item.tenant_id === select.value);
  if (tenant?.name) input.value = tenant.name;
}

function options(values, selected, labeler = (value) => value) {
  return values.map((value) => `<option value="${escapeHTML(value)}" ${value === selected ? 'selected' : ''}>${escapeHTML(labeler(value))}</option>`).join('');
}

function detailRow(title, subtitle, badge = '') {
  return `
    <div class="detail-row">
      <div><strong>${escapeHTML(title)}</strong><small>${escapeHTML(subtitle)}</small></div>
      ${badge}
    </div>`;
}

function renderDetail() {
  const detail = state.detail;
  const dialog = $('#tenant-dialog');
  const title = $('#tenant-dialog-title');
  const container = $('#tenant-detail');
  if (!container || !detail?.tenant) return;
  const tenant = detail.tenant;
  const members = Array.isArray(detail.members) ? detail.members : [];
  const invitations = Array.isArray(detail.invitations) ? detail.invitations : [];
  const events = Array.isArray(detail.events) ? detail.events : [];
  const audit = Array.isArray(detail.audit) ? detail.audit : [];
  if (title) title.textContent = tenant.name || 'Negocio';

  const defaultAmount = tenant.amount_cents
    ? (Number(tenant.amount_cents) / 100).toFixed(2)
    : (tenant.plan === 'yearly' ? Number(APP_CONFIG.prices?.yearly || 0) : Number(APP_CONFIG.prices?.monthly || 0)).toFixed(2);
  const status = tenant.subscription_status || 'active';
  const plan = tenant.plan || 'trial';
  const currency = tenant.currency || 'USD';
  const extendPlan = plan === 'trial' ? 'monthly' : plan;

  container.innerHTML = `
    <div class="detail-facts">
      <div><span>Dueño</span><strong>${escapeHTML(tenant.owner_email || '—')}</strong></div>
      <div><span>Estado</span><strong>${escapeHTML(statusLabel(status))}${tenant.comped ? ' · cortesía' : ''}</strong></div>
      <div><span>Plan</span><strong>${escapeHTML(planLabel(plan))}</strong></div>
      <div><span>Miembros</span><strong>${escapeHTML(String(members.length))}</strong></div>
      <div><span>Prueba hasta</span><strong>${escapeHTML(dateTime(tenant.trial_ends_at))}</strong></div>
      <div><span>Periodo hasta</span><strong>${escapeHTML(dateTime(tenant.current_period_end))}</strong></div>
      <div><span>Monto</span><strong>${escapeHTML(money(tenant.amount_cents, currency))}</strong></div>
      <div><span>Actualizado</span><strong>${escapeHTML(dateTime(tenant.updated_at))}</strong></div>
      <div><span>Creado</span><strong>${escapeHTML(dateTime(tenant.created_at))}</strong></div>
      <div><span>Notas</span><strong>${escapeHTML(tenant.notes || '—')}</strong></div>
    </div>

    <div class="detail-actions">
      <details open>
        <summary>Extender licencia</summary>
        <form class="detail-action-form" data-action="extend">
          <label>Días
            <input name="days" type="number" min="1" max="3650" step="1" value="30" required>
          </label>
          <label>Plan
            <select name="plan">${options(PLANS, extendPlan, planLabel)}</select>
          </label>
          <label>Estado
            <select name="status">${options(STATUSES, 'active', (value) => DIALOG_STATUS_LABELS[value] || value)}</select>
          </label>
          <div class="form-actions"><button class="btn btn-primary btn-small" type="submit">Aplicar extensión</button></div>
        </form>
      </details>

      <details>
        <summary>Registrar pago</summary>
        <form class="detail-action-form" data-action="payment">
          <label>Monto (${escapeHTML(currency)})
            <input name="amount" type="number" min="0" step="0.01" value="${escapeHTML(defaultAmount)}" required>
          </label>
          <label>Moneda
            <select name="currency">${options(CURRENCIES, currency)}</select>
          </label>
          <label>Días
            <input name="days" type="number" min="1" max="3650" step="1" value="${plan === 'yearly' ? 365 : 30}" required>
          </label>
          <label>Plan
            <select name="plan">${options(PLANS.slice(1), plan === 'trial' ? 'monthly' : plan, planLabel)}</select>
          </label>
          <label>Concepto
            <input name="concept" type="text" maxlength="120" value="Suscripción ${escapeHTML(planLabel(plan))}">
          </label>
          <div class="form-actions"><button class="btn btn-primary btn-small" type="submit">Registrar pago</button></div>
        </form>
      </details>

      <details>
        <summary>Estado, prueba y cortesía</summary>
        <form class="detail-action-form" data-action="status">
          <label>Estado
            <select name="status">${options(STATUSES, status, (value) => DIALOG_STATUS_LABELS[value] || value)}</select>
          </label>
          <label>Notas
            <input name="notes" type="text" maxlength="2000" value="${escapeHTML(tenant.notes || '')}">
          </label>
          <div class="form-actions"><button class="btn btn-small" type="submit">Cambiar estado</button></div>
        </form>
        <form class="detail-action-form" data-action="trial">
          <label>Días de prueba
            <input name="days" type="number" min="1" max="365" step="1" value="14" required>
          </label>
          <div class="form-actions"><button class="btn btn-small" type="submit">Reiniciar prueba</button></div>
        </form>
        <div class="form-actions" style="margin-top:10px">
          <button class="btn btn-small" type="button" data-quick-status="suspended">Suspender</button>
          <button class="btn btn-small" type="button" data-quick-status="expired">Marcar vencida</button>
          <button class="btn btn-small" type="button" data-comped="${tenant.comped ? '0' : '1'}">${tenant.comped ? 'Quitar cortesía' : 'Dar cortesía'}</button>
        </div>
      </details>

      <details>
        <summary>Editar negocio</summary>
        <form class="detail-action-form" data-action="update">
          <label>Nombre
            <input name="name" type="text" maxlength="120" value="${escapeHTML(tenant.name || '')}">
          </label>
          <label>Monto por periodo (${escapeHTML(currency)})
            <input name="amount" type="number" min="0" step="0.01" value="${escapeHTML(defaultAmount)}">
          </label>
          <label>Notas
            <textarea name="notes" maxlength="2000">${escapeHTML(tenant.notes || '')}</textarea>
          </label>
          <div class="form-actions"><button class="btn btn-primary btn-small" type="submit">Guardar cambios</button></div>
        </form>
      </details>
    </div>

    <section class="detail-section">
      <h3>Miembros (${members.length})</h3>
      <div class="detail-list">
        ${members.length ? members.map((member) => detailRow(
          member.full_name || member.email || 'Sin nombre',
          `${member.email || ''} · desde ${dayDate(member.created_at)}`,
          `<span class="role-pill">${escapeHTML(roleLabel(member.role))}</span>`
        )).join('') : '<p class="detail-empty">Sin miembros.</p>'}
      </div>
    </section>

    <section class="detail-section">
      <h3>Invitaciones (${invitations.length})</h3>
      <div class="detail-list">
        ${invitations.length ? invitations.map((invite) => {
          const statusLabelText = invite.accepted_at
            ? 'Aceptada'
            : Date.parse(invite.expires_at) < Date.now() ? 'Vencida' : 'Activa';
          return detailRow(
            invite.email || 'Enlace abierto',
            `${roleLabel(invite.role)} · vence ${dateTime(invite.expires_at)}`,
            `<span class="role-pill">${escapeHTML(statusLabelText)}</span>`
          );
        }).join('') : '<p class="detail-empty">Sin invitaciones.</p>'}
      </div>
    </section>

    <section class="detail-section">
      <h3>Pagos (${events.length})</h3>
      <div class="detail-list">
        ${events.length ? events.map((event) => detailRow(
          `${money(event.amount_cents, event.currency)} · ${event.concept || 'Pago'}`,
          `${dateTime(event.created_at)} · ${event.provider || 'manual'} · ${event.status || ''}`,
          ''
        )).join('') : '<p class="detail-empty">Sin pagos registrados.</p>'}
      </div>
    </section>

    <section class="detail-section">
      <h3>Auditoría (${audit.length})</h3>
      <div class="detail-list">
        ${audit.length ? audit.map((entry) => detailRow(
          entry.action,
          dateTime(entry.created_at),
          `<small>${escapeHTML(JSON.stringify(entry.details || {}).slice(0, 120))}</small>`
        )).join('') : '<p class="detail-empty">Sin movimientos.</p>'}
      </div>
    </section>`;

  if (dialog && !dialog.open) {
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }
}

async function openTenant(tenantId) {
  if (!tenantId || state.actionBusy) return;
  state.actionBusy = true;
  try {
    const session = await ensureSession();
    const detail = await adminTenantDetail(backendConfig(), session, tenantId);
    if (!detail?.tenant) throw new Error('No se encontró el negocio.');
    state.detail = detail;
    renderDetail();
  } catch (error) {
    handleError(error);
  } finally {
    state.actionBusy = false;
  }
}

async function refreshDetail() {
  const tenantId = state.detail?.tenant?.id;
  if (!tenantId) return;
  const session = await ensureSession();
  state.detail = await adminTenantDetail(backendConfig(), session, tenantId);
  renderDetail();
}

async function runAction(action, successMessage) {
  if (state.actionBusy) return;
  state.actionBusy = true;
  try {
    const session = await ensureSession();
    await action(session);
    toast(successMessage);
    await refreshDetail();
    await loadAll();
  } catch (error) {
    handleError(error);
  } finally {
    state.actionBusy = false;
  }
}

async function handleDetailSubmit(event) {
  const form = event.target.closest('form[data-action]');
  if (!form) return;
  event.preventDefault();
  if (state.actionBusy) return;
  const tenantId = state.detail?.tenant?.id;
  if (!tenantId) return;
  const data = new FormData(form);
  const action = form.dataset.action;

  if (action === 'extend') {
    const days = Number(data.get('days'));
    const plan = String(data.get('plan') || '');
    const status = String(data.get('status') || 'active');
    if (!Number.isInteger(days) || days < 1) {
      toast('Escribe una cantidad de días válida.');
      return;
    }
    await runAction(
      (session) => adminExtendLicense(backendConfig(), session, tenantId, days, plan, status),
      'Licencia extendida.'
    );
    return;
  }

  if (action === 'payment') {
    const amount = Number(data.get('amount'));
    const days = Number(data.get('days'));
    if (!Number.isFinite(amount) || amount < 0) {
      toast('Escribe un monto válido.');
      return;
    }
    if (!Number.isInteger(days) || days < 1) {
      toast('Escribe una cantidad de días válida.');
      return;
    }
    const currency = String(data.get('currency') || 'USD');
    const plan = String(data.get('plan') || '');
    const concept = String(data.get('concept') || '').trim() || 'Suscripción';
    await runAction(
      (session) => adminRecordPayment(backendConfig(), session, tenantId, {
        amountCents: Math.round(amount * 100),
        currency,
        concept,
        days,
        plan
      }),
      'Pago registrado y licencia actualizada.'
    );
    return;
  }

  if (action === 'trial') {
    const days = Number(data.get('days'));
    if (!Number.isInteger(days) || days < 1) {
      toast('Escribe una cantidad de días válida.');
      return;
    }
    await runAction(
      (session) => adminSetTrial(backendConfig(), session, tenantId, days),
      'Prueba reiniciada.'
    );
    return;
  }

  if (action === 'status') {
    const status = String(data.get('status') || '');
    const notes = String(data.get('notes') || '').trim();
    await runAction(
      (session) => adminSetStatus(backendConfig(), session, tenantId, status, notes || null),
      'Estado actualizado.'
    );
    return;
  }

  if (action === 'update') {
    const name = String(data.get('name') || '').trim();
    const amount = Number(data.get('amount'));
    const notes = String(data.get('notes') || '').trim();
    if (!name) {
      toast('Escribe el nombre del negocio.');
      return;
    }
    if (!Number.isFinite(amount) || amount < 0) {
      toast('Escribe un monto válido.');
      return;
    }
    await runAction(
      (session) => adminUpdateTenant(backendConfig(), session, tenantId, {
        name,
        amountCents: Math.round(amount * 100),
        notes
      }),
      'Negocio actualizado.'
    );
  }
}

async function handleDialogClick(event) {
  if (event.target.closest('#tenant-dialog-close')) {
    $('#tenant-dialog')?.close();
    return;
  }
  const tenantId = state.detail?.tenant?.id;
  if (!tenantId) return;

  const quick = event.target.closest('[data-quick-status]');
  if (quick) {
    const status = quick.dataset.quickStatus;
    if (!window.confirm(`¿Cambiar el estado de este negocio a “${DIALOG_STATUS_LABELS[status] || status}”?`)) return;
    await runAction(
      (session) => adminSetStatus(backendConfig(), session, tenantId, status, null),
      'Estado actualizado.'
    );
    return;
  }

  const comped = event.target.closest('[data-comped]');
  if (comped) {
    const next = comped.dataset.comped === '1';
    if (!window.confirm(next ? '¿Dar acceso de cortesía a este negocio?' : '¿Quitar el acceso de cortesía?')) return;
    await runAction(
      (session) => adminSetComped(backendConfig(), session, tenantId, next),
      next ? 'Cortesía activada.' : 'Cortesía retirada.'
    );
  }
}

async function handleRemoveAdmin(button) {
  const userId = button.dataset.removeAdmin;
  if (!userId) return;
  if (!window.confirm('¿Quitar el acceso de administrador a esta cuenta?')) return;
  try {
    const session = await ensureSession();
    await adminRemoveAdmin(backendConfig(), session, userId);
    toast('Administrador quitado.');
    await loadAll();
  } catch (error) {
    handleError(error);
  }
}

async function handleAddAdmin(event) {
  event.preventDefault();
  if (state.actionBusy) return;
  const input = $('#admin-add-email');
  const email = String(input?.value ?? '').trim();
  if (!email) {
    toast('Escribe el correo.');
    return;
  }
  state.actionBusy = true;
  try {
    const session = await ensureSession();
    await adminAddAdmin(backendConfig(), session, email);
    if (input) input.value = '';
    toast('Administrador agregado.');
    await loadAll();
  } catch (error) {
    handleError(error);
  } finally {
    state.actionBusy = false;
  }
}

async function boot() {
  if (!BACKEND_READY) {
    showSetup();
    return;
  }
  if (!state.session) {
    showLogin('');
    return;
  }
  try {
    const session = await ensureSession();
    const me = await fetchMe(backendConfig(), session);
    if (!me?.is_app_admin) {
      showLogin('Esta cuenta no tiene acceso al panel del vendedor. Puedes volver a la app o entrar con otra cuenta.');
      return;
    }
    state.session = session;
    state.me = me;
    persistAuth();
    showShell();
    renderUser();
    await loadAll();
  } catch (error) {
    if (isAuthFailure(error)) {
      clearAuth('La sesión expiró. Inicia sesión de nuevo.');
    } else {
      state.session = null;
      state.me = null;
      saveAuthState({ session: null, me: null, verifiedAt: '', lastSyncedAt: '' });
      showLogin(friendlyError(error));
    }
  }
}

function bindEvents() {
  $('#admin-login-form')?.addEventListener('submit', handleLogin);
  $('#admin-logout')?.addEventListener('click', handleLogout);
  $('#admin-refresh')?.addEventListener('click', () => loadAll({ notify: true }));

  $('#admin-search')?.addEventListener('submit', (event) => {
    event.preventDefault();
    state.search = String($('#admin-search-input')?.value ?? '').trim();
    loadAll();
  });

  $('#admin-tenants')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-open-tenant]');
    if (button) openTenant(button.dataset.openTenant);
  });

  $('#admin-admins')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-admin]');
    if (button) handleRemoveAdmin(button);
  });

  $('#admin-add-form')?.addEventListener('submit', handleAddAdmin);
  $('#admin-code-form')?.addEventListener('submit', handleCreateCode);
  $('#admin-code-tenant')?.addEventListener('change', handleCodeTenantChange);
  $('#admin-codes')?.addEventListener('click', handleCodeClick);
  $('#admin-code-result')?.addEventListener('click', handleCodeClick);

  const dialog = $('#tenant-dialog');
  dialog?.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
    handleDialogClick(event);
  });
  dialog?.addEventListener('submit', handleDetailSubmit);
}

bindEvents();
boot();
