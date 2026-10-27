import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dataSignature,
  isValidSupabaseUrl,
  mergeData,
  normalizeSupabaseUrl,
  pruneDeleted,
  pullData,
  pushData,
  sanitizeDeleted,
  signIn
} from '../js/sync.js';

function ficha(id, updatedAt, extra = {}) {
  return {
    id,
    numero: extra.numero ?? id,
    fecha: '2026-10-20',
    modelo: 'Blusa básica',
    colores: [],
    total: 0,
    estado: 'costura',
    notas: '',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt,
    ...extra
  };
}

function data(fichas, overrides = {}) {
  return {
    version: 2,
    fichas,
    settings: { theme: 'light', trabajadores: [] },
    deleted: {},
    ...overrides
  };
}

test('mergeData une fichas y trabajadores de ambos dispositivos', () => {
  const local = data([ficha('a', '2026-10-20T10:00:00.000Z')], {
    settings: { theme: 'dark', trabajadores: ['Ana'] }
  });
  const remote = data([ficha('b', '2026-10-20T11:00:00.000Z')], {
    settings: { theme: 'light', trabajadores: ['ana', 'Luis'] }
  });
  const merged = mergeData(local, remote, new Date('2026-10-27T00:00:00.000Z'));
  assert.deepEqual(merged.fichas.map((item) => item.id), ['a', 'b']);
  assert.deepEqual(merged.settings.trabajadores, ['Ana', 'Luis']);
  assert.equal(merged.settings.theme, 'dark');
});

test('mergeData deja ganar la ficha con updatedAt más reciente', () => {
  const older = data([ficha('a', '2026-10-21T10:00:00.000Z', { modelo: 'Vieja' })]);
  const newer = data([ficha('a', '2026-10-22T10:00:00.000Z', { modelo: 'Nueva' })]);
  assert.equal(mergeData(older, newer).fichas[0].modelo, 'Nueva');
  assert.equal(mergeData(newer, older).fichas[0].modelo, 'Nueva');
});

test('mergeData respeta los borrados y no resucita fichas viejas', () => {
  const local = data([ficha('a', '2026-10-20T10:00:00.000Z')], {
    deleted: { a: '2026-10-21T10:00:00.000Z' }
  });
  const remote = data([ficha('a', '2026-10-19T10:00:00.000Z'), ficha('b', '2026-10-19T10:00:00.000Z')]);
  const merged = mergeData(local, remote);
  assert.deepEqual(merged.fichas.map((item) => item.id), ['b']);
  assert.equal(merged.deleted.a, '2026-10-21T10:00:00.000Z');
});

test('mergeData conserva una ficha editada después del borrado y quita el tombstone', () => {
  const local = data([ficha('a', '2026-10-22T10:00:00.000Z')], {
    deleted: { a: '2026-10-21T10:00:00.000Z' }
  });
  const merged = mergeData(local, data([]));
  assert.deepEqual(merged.fichas.map((item) => item.id), ['a']);
  assert.equal(merged.deleted.a, undefined);
});

test('mergeData funciona cuando todavía no existe fila remota', () => {
  const local = data([ficha('a', '2026-10-22T10:00:00.000Z')], {
    settings: { theme: 'auto', trabajadores: ['Ana'] }
  });
  const merged = mergeData(local, null);
  assert.equal(merged.fichas.length, 1);
  assert.deepEqual(merged.settings.trabajadores, ['Ana']);
});

test('dataSignature no depende del orden ni del tema, pero sí de los cambios', () => {
  const one = data([ficha('a', '2026-10-22T10:00:00.000Z'), ficha('b', '2026-10-21T10:00:00.000Z')], {
    settings: { theme: 'light', trabajadores: ['Ana', 'Luis'] }
  });
  const two = data([ficha('b', '2026-10-21T10:00:00.000Z'), ficha('a', '2026-10-22T10:00:00.000Z')], {
    settings: { theme: 'dark', trabajadores: ['Luis', 'Ana'] }
  });
  assert.equal(dataSignature(one), dataSignature(two));
  const changed = data([ficha('a', '2026-10-23T10:00:00.000Z'), ficha('b', '2026-10-21T10:00:00.000Z')], {
    settings: { theme: 'light', trabajadores: ['Ana', 'Luis'] }
  });
  assert.notEqual(dataSignature(one), dataSignature(changed));
  const deleted = { ...one, deleted: { b: '2026-10-22T10:00:00.000Z' } };
  assert.notEqual(dataSignature(one), dataSignature(deleted));
});

test('sanitizeDeleted y pruneDeleted descartan valores inválidos y viejos', () => {
  const now = new Date('2026-10-27T00:00:00.000Z');
  const cleaned = sanitizeDeleted({
    a: '2026-10-20T10:00:00.000Z',
    b: { at: '2026-10-21T10:00:00.000Z' },
    c: 'no es fecha',
    '': '2026-10-20T10:00:00.000Z'
  });
  assert.deepEqual(Object.keys(cleaned), ['a', 'b']);
  const pruned = pruneDeleted({
    viejo: '2025-01-01T00:00:00.000Z',
    reciente: '2026-10-26T00:00:00.000Z'
  }, now);
  assert.deepEqual(Object.keys(pruned), ['reciente']);
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

test('signIn, pullData y pushData usan los endpoints y cabeceras de Supabase', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/auth/v1/token?grant_type=password')) {
      return jsonResponse({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
        user: { id: 'user-1', email: 'ana@ejemplo.com' }
      });
    }
    if (String(url).includes('/rest/v1/corte_sync?select=')) {
      return jsonResponse([{ data: { fichas: [] } }]);
    }
    if (String(url).includes('/rest/v1/corte_sync?on_conflict=user_id')) {
      return new Response('', { status: 201 });
    }
    throw new Error(`URL inesperada: ${url}`);
  };
  try {
    const config = { url: 'https://abc.supabase.co', anonKey: 'anon-key' };
    const session = await signIn(config, 'ana@ejemplo.com', 'secreto');
    assert.equal(session.userId, 'user-1');
    assert.equal(session.email, 'ana@ejemplo.com');
    assert.equal(calls[0].options.headers.apikey, 'anon-key');
    assert.equal(JSON.parse(calls[0].options.body).email, 'ana@ejemplo.com');

    const remote = await pullData(config, session);
    assert.deepEqual(remote, { fichas: [] });
    assert.match(calls[1].url, /user_id=eq\.user-1/);
    assert.equal(calls[1].options.headers.Authorization, 'Bearer access-1');

    await pushData(config, session, { fichas: [] });
    assert.equal(calls[2].options.headers.Prefer, 'resolution=merge-duplicates,return=minimal');
    assert.equal(JSON.parse(calls[2].options.body)[0].user_id, 'user-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('isValidSupabaseUrl solo acepta URLs https de proyectos Supabase', () => {
  assert.equal(isValidSupabaseUrl('https://abcdefgh.supabase.co'), true);
  assert.equal(isValidSupabaseUrl('https://abcdefgh.supabase.co/'), true);
  assert.equal(normalizeSupabaseUrl(' https://abcdefgh.supabase.co/// '), 'https://abcdefgh.supabase.co');
  assert.equal(isValidSupabaseUrl('http://abcdefgh.supabase.co'), false);
  assert.equal(isValidSupabaseUrl('https://supabase.co'), false);
  assert.equal(isValidSupabaseUrl('https://ejemplo.com'), false);
  assert.equal(isValidSupabaseUrl(''), false);
});
