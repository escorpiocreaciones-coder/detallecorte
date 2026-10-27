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

export async function signUp(config, email, password) {
  const payload = await request(config, '/auth/v1/signup', {
    method: 'POST',
    body: { email, password }
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
