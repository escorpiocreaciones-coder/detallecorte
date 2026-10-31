import { DATA_VERSION, sanitizeWorkers } from './core.js';

export const SYNC_STORAGE_KEY = 'control-cortes.sync';

const DELETED_TTL_DAYS = 120;
const MAX_DELETED = 5000;
const THEMES = ['auto', 'light', 'dark'];

function emptyState() {
  return {
    config: { url: '', anonKey: '' },
    session: null,
    lastSyncedAt: '',
    lastError: ''
  };
}

export function normalizeSupabaseUrl(value) {
  const trimmed = String(value ?? '').trim().replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase().endsWith('.supabase.co')) return url.origin;
  } catch {}
  return trimmed;
}

export function isValidSupabaseUrl(value) {
  try {
    const url = new URL(normalizeSupabaseUrl(value));
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return host.endsWith('.supabase.co') && host.length > '.supabase.co'.length;
  } catch {
    return false;
  }
}

export function sanitizeDeleted(input) {
  const deleted = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return deleted;
  for (const [rawId, rawValue] of Object.entries(input)) {
    const id = String(rawId ?? '').trim();
    if (!id || id.length > 120) continue;
    const value = typeof rawValue === 'string' ? rawValue : rawValue?.at;
    const time = Date.parse(String(value ?? ''));
    if (Number.isNaN(time)) continue;
    deleted[id] = new Date(time).toISOString();
  }
  return deleted;
}

export function pruneDeleted(input, now = new Date()) {
  const deleted = sanitizeDeleted(input);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const cutoff = (Number.isNaN(nowMs) ? Date.now() : nowMs) - DELETED_TTL_DAYS * 24 * 60 * 60 * 1000;
  const entries = Object.entries(deleted)
    .filter(([, time]) => Date.parse(time) >= cutoff)
    .sort(([, a], [, b]) => Date.parse(b) - Date.parse(a))
    .slice(0, MAX_DELETED);
  return Object.fromEntries(entries);
}

function fichaTime(ficha) {
  const time = Date.parse(String(ficha?.updatedAt ?? ''));
  return Number.isNaN(time) ? 0 : time;
}

function normalizeFichas(value) {
  return Array.isArray(value) ? value.filter((ficha) => ficha && typeof ficha === 'object' && ficha.id) : [];
}

function mergeDeleted(...sources) {
  const merged = {};
  for (const source of sources) {
    for (const [id, time] of Object.entries(sanitizeDeleted(source))) {
      if (!merged[id] || Date.parse(time) > Date.parse(merged[id])) merged[id] = time;
    }
  }
  return merged;
}

export function mergeData(local, remote, now = new Date()) {
  const localData = local && typeof local === 'object' ? local : {};
  const remoteData = remote && typeof remote === 'object' ? remote : {};
  const deleted = mergeDeleted(remoteData.deleted, localData.deleted);

  const byId = new Map();
  for (const ficha of normalizeFichas(remoteData.fichas)) byId.set(String(ficha.id), ficha);
  for (const ficha of normalizeFichas(localData.fichas)) {
    const id = String(ficha.id);
    const previous = byId.get(id);
    if (!previous || fichaTime(ficha) >= fichaTime(previous)) byId.set(id, ficha);
  }

  const fichas = [];
  for (const [id, ficha] of byId) {
    const tombstone = deleted[id];
    if (tombstone) {
      if (fichaTime(ficha) > Date.parse(tombstone)) delete deleted[id];
      else continue;
    }
    fichas.push(ficha);
  }

  fichas.sort((a, b) => {
    const byDate = String(b.fecha ?? '').localeCompare(String(a.fecha ?? ''));
    if (byDate !== 0) return byDate;
    const byCreated = String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));
    if (byCreated !== 0) return byCreated;
    return String(a.numero ?? '').localeCompare(String(b.numero ?? ''), 'es', { numeric: true });
  });

  const localTheme = localData.settings?.theme;
  const remoteTheme = remoteData.settings?.theme;
  const theme = THEMES.includes(localTheme) ? localTheme : (THEMES.includes(remoteTheme) ? remoteTheme : 'auto');
  const trabajadores = sanitizeWorkers([
    ...(Array.isArray(localData.settings?.trabajadores) ? localData.settings.trabajadores : []),
    ...(Array.isArray(remoteData.settings?.trabajadores) ? remoteData.settings.trabajadores : [])
  ]);

  return {
    version: DATA_VERSION,
    fichas,
    settings: { theme, trabajadores },
    deleted: pruneDeleted(deleted, now)
  };
}

export function dataSignature(data) {
  if (!data || typeof data !== 'object') return '';
  const fichas = normalizeFichas(data.fichas)
    .map((ficha) => `${ficha.id}:${String(ficha.updatedAt ?? '')}`)
    .sort();
  const trabajadores = (Array.isArray(data.settings?.trabajadores) ? data.settings.trabajadores : [])
    .map((worker) => String(worker))
    .sort();
  const deleted = Object.entries(sanitizeDeleted(data.deleted))
    .map(([id, time]) => `${id}:${time}`)
    .sort();
  return JSON.stringify({ fichas, trabajadores, deleted });
}

export function loadSyncState() {
  const fallback = emptyState();
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = JSON.parse(localStorage.getItem(SYNC_STORAGE_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return fallback;
    const url = isValidSupabaseUrl(raw.config?.url) ? normalizeSupabaseUrl(raw.config.url) : '';
    const anonKey = typeof raw.config?.anonKey === 'string' ? raw.config.anonKey.trim() : '';
    const storedSession = raw.session;
    const session = storedSession
      && typeof storedSession.accessToken === 'string'
      && typeof storedSession.refreshToken === 'string'
      && typeof storedSession.userId === 'string'
      && storedSession.userId
      ? {
          accessToken: storedSession.accessToken,
          refreshToken: storedSession.refreshToken,
          expiresAt: Number(storedSession.expiresAt) || 0,
          userId: storedSession.userId,
          email: typeof storedSession.email === 'string' ? storedSession.email : ''
        }
      : null;
    return {
      config: { url, anonKey },
      session,
      lastSyncedAt: typeof raw.lastSyncedAt === 'string' ? raw.lastSyncedAt : '',
      lastError: typeof raw.lastError === 'string' ? raw.lastError : ''
    };
  } catch {
    return fallback;
  }
}

export function saveSyncState(state) {
  if (typeof localStorage === 'undefined') return false;
  try {
    const session = state?.session;
    localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify({
      config: {
        url: normalizeSupabaseUrl(state?.config?.url),
        anonKey: String(state?.config?.anonKey ?? '')
      },
      session: session?.accessToken
        ? {
            accessToken: session.accessToken,
            refreshToken: session.refreshToken,
            expiresAt: session.expiresAt,
            userId: session.userId,
            email: session.email
          }
        : null,
      lastSyncedAt: String(state?.lastSyncedAt ?? ''),
      lastError: String(state?.lastError ?? '')
    }));
    return true;
  } catch {
    return false;
  }
}

function createSession(payload, fallbackEmail = '') {
  if (!payload || typeof payload !== 'object' || !payload.access_token) return null;
  const expiresIn = Number(payload.expires_in);
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
    ? Date.now() + expiresIn * 1000
    : (Number(payload.expires_at) || 0) * 1000;
  return {
    accessToken: String(payload.access_token),
    refreshToken: String(payload.refresh_token ?? ''),
    expiresAt,
    userId: String(payload.user?.id ?? payload.user_id ?? ''),
    email: String(payload.user?.email ?? fallbackEmail ?? '')
  };
}

async function request(config, path, options = {}) {
  if (!isValidSupabaseUrl(config?.url)) throw new Error('La URL de Supabase no es válida.');
  if (!config?.anonKey) throw new Error('Falta la clave anon de Supabase.');
  const headers = {
    apikey: config.anonKey,
    'Content-Type': 'application/json',
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    ...(options.headers ?? {})
  };
  let response;
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), 20_000) : null;
  try {
    response = await fetch(`${normalizeSupabaseUrl(config.url)}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      ...(controller ? { signal: controller.signal } : {})
    });
  } catch {
    const error = new Error('No se pudo conectar con Supabase. Revisa tu internet.');
    error.offline = true;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message = payload?.msg
      || payload?.message
      || payload?.error_description
      || payload?.error
      || `Error ${response.status} de Supabase.`;
    const error = new Error(String(message));
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function signUp(config, email, password, metadata = null) {
  const body = { email, password };
  if (metadata && typeof metadata === 'object') body.data = metadata;
  const payload = await request(config, '/auth/v1/signup', {
    method: 'POST',
    body
  });
  const data = payload?.session ?? payload;
  return {
    session: createSession(data, email),
    needsConfirmation: !data?.access_token
  };
}

export async function signIn(config, email, password) {
  const payload = await request(config, '/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email, password }
  });
  const session = createSession(payload, email);
  if (!session || !session.userId) throw new Error('Supabase no devolvió una sesión válida.');
  return session;
}

export async function refreshSession(config, session) {
  if (!session?.refreshToken) throw new Error('La sesión expiró. Inicia sesión de nuevo.');
  const payload = await request(config, '/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    body: { refresh_token: session.refreshToken }
  });
  const next = createSession(payload, session.email);
  if (!next) throw new Error('No se pudo renovar la sesión.');
  if (!next.userId) next.userId = session.userId;
  if (!next.refreshToken) next.refreshToken = session.refreshToken;
  if (!next.email) next.email = session.email;
  return next;
}

export async function pullData(config, session) {
  const rows = await request(
    config,
    `/rest/v1/corte_sync?select=data,updated_at&user_id=eq.${encodeURIComponent(session.userId)}`,
    { token: session.accessToken }
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0]?.data ?? null;
}

export async function pushData(config, session, data) {
  await request(config, '/rest/v1/corte_sync?on_conflict=user_id', {
    method: 'POST',
    token: session.accessToken,
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: [{
      user_id: session.userId,
      data,
      updated_at: new Date().toISOString()
    }]
  });
}

export async function signOutRemote(config, session) {
  if (!session?.accessToken || !isValidSupabaseUrl(config?.url)) return;
  try {
    await request(config, '/auth/v1/logout', { method: 'POST', token: session.accessToken });
  } catch {}
}

export async function resetPassword(config, email) {
  return request(config, '/auth/v1/recover', {
    method: 'POST',
    body: { email }
  });
}

// ------------------------------------------------------------
// Sesión y licencia (modelo central por negocio)
// ------------------------------------------------------------

export const AUTH_STORAGE_KEY = 'control-cortes.auth.v2';

function normalizeSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.accessToken !== 'string' || typeof raw.refreshToken !== 'string') return null;
  if (typeof raw.userId !== 'string' || !raw.userId) return null;
  return {
    accessToken: raw.accessToken,
    refreshToken: raw.refreshToken,
    expiresAt: Number(raw.expiresAt) || 0,
    userId: raw.userId,
    email: typeof raw.email === 'string' ? raw.email : ''
  };
}

export function loadAuthState() {
  const fallback = { session: null, me: null, verifiedAt: '', lastSyncedAt: '' };
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return fallback;
    const session = normalizeSession(raw.session);
    const me = session && raw.me && typeof raw.me === 'object' ? raw.me : null;
    return {
      session,
      me,
      verifiedAt: typeof raw.verifiedAt === 'string' ? raw.verifiedAt : '',
      lastSyncedAt: typeof raw.lastSyncedAt === 'string' ? raw.lastSyncedAt : ''
    };
  } catch {
    return fallback;
  }
}

export function saveAuthState(state) {
  if (typeof localStorage === 'undefined') return false;
  try {
    const session = normalizeSession(state?.session);
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({
      session,
      me: session && state?.me && typeof state.me === 'object' ? state.me : null,
      verifiedAt: session ? String(state?.verifiedAt ?? '') : '',
      lastSyncedAt: session ? String(state?.lastSyncedAt ?? '') : ''
    }));
    return true;
  } catch {
    return false;
  }
}

export async function rpc(config, session, functionName, args = {}) {
  return request(config, `/rest/v1/rpc/${encodeURIComponent(functionName)}`, {
    method: 'POST',
    token: session?.accessToken,
    body: args
  });
}

export async function fetchMe(config, session) {
  const me = await rpc(config, session, 'app_me');
  if (!me || typeof me !== 'object' || !me.user_id) {
    throw new Error('No se pudo cargar la cuenta.');
  }
  return me;
}

export async function pullTenantData(config, session, tenantId) {
  if (!tenantId) return null;
  const rows = await request(
    config,
    `/rest/v1/tenant_data?select=data,updated_at&tenant_id=eq.${encodeURIComponent(tenantId)}`,
    { token: session.accessToken }
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0]?.data ?? null;
}

export async function pushTenantData(config, session, tenantId, data) {
  if (!tenantId) throw new Error('Falta el negocio.');
  await request(config, '/rest/v1/tenant_data?on_conflict=tenant_id', {
    method: 'POST',
    token: session.accessToken,
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: [{
      tenant_id: tenantId,
      data,
      updated_by: session.userId,
      updated_at: new Date().toISOString()
    }]
  });
}

export async function subscriptionEvents(config, session, tenantId) {
  if (!tenantId) return [];
  return request(
    config,
    `/rest/v1/subscription_events?select=id,status,amount_cents,currency,concept,period_start,period_end,created_at&tenant_id=eq.${encodeURIComponent(tenantId)}&order=created_at.desc&limit=24`,
    { token: session.accessToken }
  );
}

// ------------------------------------------------------------
// Equipo y roles dentro de la app
// ------------------------------------------------------------

export async function tenantMembers(config, session) {
  return rpc(config, session, 'tenant_members_list');
}

export async function tenantInvitations(config, session) {
  return rpc(config, session, 'tenant_invitations');
}

export async function createInvitation(config, session, role = 'employee', email = '') {
  return rpc(config, session, 'create_invitation', { p_role: role, p_email: email });
}

export async function revokeInvitation(config, session, invitationId) {
  return rpc(config, session, 'revoke_invitation', { p_id: invitationId });
}

export async function acceptInvitation(config, session, code) {
  return rpc(config, session, 'accept_invitation', { p_code: code });
}

export async function setMemberRole(config, session, userId, role) {
  return rpc(config, session, 'set_member_role', { p_user_id: userId, p_role: role });
}

export async function removeMember(config, session, userId) {
  return rpc(config, session, 'remove_member', { p_user_id: userId });
}

export async function renameTenant(config, session, name) {
  return rpc(config, session, 'rename_tenant', { p_name: name });
}

// ------------------------------------------------------------
// Panel del vendedor (solo is_app_admin)
// ------------------------------------------------------------

export async function adminMetrics(config, session) {
  return rpc(config, session, 'admin_metrics');
}

export async function adminListTenants(config, session, search = '') {
  return rpc(config, session, 'admin_list_tenants', { p_search: search });
}

export async function adminTenantDetail(config, session, tenantId) {
  return rpc(config, session, 'admin_tenant_detail', { p_tenant_id: tenantId });
}

export async function adminExtendLicense(config, session, tenantId, days, plan = null, status = 'active') {
  return rpc(config, session, 'admin_extend_license', {
    p_tenant_id: tenantId,
    p_days: days,
    p_plan: plan,
    p_status: status
  });
}

export async function adminRecordPayment(config, session, tenantId, payload) {
  return rpc(config, session, 'admin_record_payment', {
    p_tenant_id: tenantId,
    p_amount_cents: payload.amountCents,
    p_currency: payload.currency ?? 'USD',
    p_concept: payload.concept ?? 'Suscripción',
    p_days: payload.days ?? 30,
    p_plan: payload.plan ?? null
  });
}

export async function adminSetStatus(config, session, tenantId, status, notes = null) {
  return rpc(config, session, 'admin_set_status', {
    p_tenant_id: tenantId,
    p_status: status,
    p_notes: notes
  });
}

export async function adminSetTrial(config, session, tenantId, days) {
  return rpc(config, session, 'admin_set_trial', { p_tenant_id: tenantId, p_days: days });
}

export async function adminSetComped(config, session, tenantId, comped) {
  return rpc(config, session, 'admin_set_comped', { p_tenant_id: tenantId, p_comped: Boolean(comped) });
}

export async function adminUpdateTenant(config, session, tenantId, payload) {
  return rpc(config, session, 'admin_update_tenant', {
    p_tenant_id: tenantId,
    p_name: payload.name ?? null,
    p_amount_cents: payload.amountCents ?? null,
    p_notes: payload.notes ?? null
  });
}

export async function adminListAdmins(config, session) {
  return rpc(config, session, 'admin_list_admins');
}

export async function adminAddAdmin(config, session, email) {
  return rpc(config, session, 'admin_add_admin', { p_email: email });
}

export async function adminRemoveAdmin(config, session, userId) {
  return rpc(config, session, 'admin_remove_admin', { p_user_id: userId });
}
