import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adminAddAdmin,
  adminCreateAccessCode,
  adminExtendLicense,
  adminListAccessCodes,
  adminListTenants,
  adminRecordPayment,
  adminRevokeAccessCode,
  adminSetComped,
  adminSetStatus,
  adminUpdateTenant,
  createInvitation,
  fetchMe,
  pullTenantData,
  pushTenantData,
  redeemAccessCode,
  setMemberRole,
  subscriptionEvents,
  tenantMembers
} from '../js/sync.js';

const config = { url: 'https://abc.supabase.co', anonKey: 'anon-key' };
const session = {
  accessToken: 'token-1',
  refreshToken: 'refresh-1',
  expiresAt: Date.now() + 3600_000,
  userId: 'user-1',
  email: 'ana@ejemplo.com'
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function mockFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options, calls.length - 1);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    }
  };
}

test('fetchMe llama al RPC app_me con el token de la sesión', async () => {
  const mock = mockFetch(() => jsonResponse({ user_id: 'user-1', tenant_id: 'tenant-1' }));
  try {
    const me = await fetchMe(config, session);
    assert.equal(me.tenant_id, 'tenant-1');
    assert.match(mock.calls[0].url, /\/rest\/v1\/rpc\/app_me$/);
    assert.equal(mock.calls[0].options.method, 'POST');
    assert.equal(mock.calls[0].options.headers.Authorization, 'Bearer token-1');
    assert.equal(mock.calls[0].options.headers.apikey, 'anon-key');
  } finally {
    mock.restore();
  }
});

test('pullTenantData y pushTenantData usan tenant_data', async () => {
  const mock = mockFetch((url) => {
    if (url.includes('select=data,updated_at')) return jsonResponse([{ data: { fichas: [] } }]);
    return new Response('', { status: 201 });
  });
  try {
    const remote = await pullTenantData(config, session, 'tenant-1');
    assert.deepEqual(remote, { fichas: [] });
    assert.match(mock.calls[0].url, /tenant_data\?select=data,updated_at&tenant_id=eq\.tenant-1/);
    assert.equal(mock.calls[0].options.headers.Authorization, 'Bearer token-1');

    await pushTenantData(config, session, 'tenant-1', { fichas: [] });
    assert.match(mock.calls[1].url, /tenant_data\?on_conflict=tenant_id/);
    assert.equal(mock.calls[1].options.headers.Prefer, 'resolution=merge-duplicates,return=minimal');
    const body = JSON.parse(mock.calls[1].options.body);
    assert.equal(body[0].tenant_id, 'tenant-1');
    assert.equal(body[0].updated_by, 'user-1');
    assert.deepEqual(body[0].data, { fichas: [] });
  } finally {
    mock.restore();
  }
});

test('subscriptionEvents consulta pagos del negocio', async () => {
  const mock = mockFetch(() => jsonResponse([]));
  try {
    await subscriptionEvents(config, session, 'tenant-9');
    assert.match(mock.calls[0].url, /subscription_events\?select=/);
    assert.match(mock.calls[0].url, /tenant_id=eq\.tenant-9/);
    assert.match(mock.calls[0].url, /order=created_at\.desc/);
    assert.equal(mock.calls[0].options.headers.Authorization, 'Bearer token-1');
  } finally {
    mock.restore();
  }
});

test('tenantMembers y createInvitation usan los RPC y argumentos correctos', async () => {
  const mock = mockFetch(() => jsonResponse([]));
  try {
    await tenantMembers(config, session);
    assert.match(mock.calls[0].url, /\/rpc\/tenant_members_list$/);

    await createInvitation(config, session, 'employee', 'nuevo@ejemplo.com');
    assert.match(mock.calls[1].url, /\/rpc\/create_invitation$/);
    assert.deepEqual(JSON.parse(mock.calls[1].options.body), {
      p_role: 'employee',
      p_email: 'nuevo@ejemplo.com'
    });

    await setMemberRole(config, session, 'user-2', 'admin');
    assert.match(mock.calls[2].url, /\/rpc\/set_member_role$/);
    assert.deepEqual(JSON.parse(mock.calls[2].options.body), {
      p_user_id: 'user-2',
      p_role: 'admin'
    });
  } finally {
    mock.restore();
  }
});

test('los RPC de administración envían los nombres de parámetros que espera SQL', async () => {
  const mock = mockFetch(() => jsonResponse({}));
  try {
    await adminListTenants(config, session, 'confecciones');
    assert.match(mock.calls[0].url, /\/rpc\/admin_list_tenants$/);
    assert.deepEqual(JSON.parse(mock.calls[0].options.body), { p_search: 'confecciones' });

    await adminExtendLicense(config, session, 'tenant-1', 30, 'monthly', 'active');
    assert.match(mock.calls[1].url, /\/rpc\/admin_extend_license$/);
    assert.deepEqual(JSON.parse(mock.calls[1].options.body), {
      p_tenant_id: 'tenant-1',
      p_days: 30,
      p_plan: 'monthly',
      p_status: 'active'
    });

    await adminRecordPayment(config, session, 'tenant-1', {
      amountCents: 999,
      currency: 'USD',
      concept: 'Mensualidad',
      days: 30,
      plan: 'monthly'
    });
    assert.match(mock.calls[2].url, /\/rpc\/admin_record_payment$/);
    assert.deepEqual(JSON.parse(mock.calls[2].options.body), {
      p_tenant_id: 'tenant-1',
      p_amount_cents: 999,
      p_currency: 'USD',
      p_concept: 'Mensualidad',
      p_days: 30,
      p_plan: 'monthly'
    });

    await adminSetStatus(config, session, 'tenant-1', 'suspended', 'falta de pago');
    assert.deepEqual(JSON.parse(mock.calls[3].options.body), {
      p_tenant_id: 'tenant-1',
      p_status: 'suspended',
      p_notes: 'falta de pago'
    });

    await adminSetComped(config, session, 'tenant-1', true);
    assert.deepEqual(JSON.parse(mock.calls[4].options.body), {
      p_tenant_id: 'tenant-1',
      p_comped: true
    });

    await adminUpdateTenant(config, session, 'tenant-1', {
      name: 'Nuevo nombre',
      amountCents: 1200,
      notes: 'nota'
    });
    assert.deepEqual(JSON.parse(mock.calls[5].options.body), {
      p_tenant_id: 'tenant-1',
      p_name: 'Nuevo nombre',
      p_amount_cents: 1200,
      p_notes: 'nota'
    });

    await adminAddAdmin(config, session, 'jefe@ejemplo.com');
    assert.deepEqual(JSON.parse(mock.calls[6].options.body), { p_email: 'jefe@ejemplo.com' });
  } finally {
    mock.restore();
  }
});

test('los RPC de códigos de acceso usan los argumentos esperados', async () => {
  const mock = mockFetch(() => jsonResponse({}));
  try {
    const created = await adminCreateAccessCode(config, session, {
      label: 'Cliente Nuevo',
      days: 30,
      tenantId: 'tenant-1',
      notes: 'primer equipo'
    });
    assert.deepEqual(created, {});
    assert.match(mock.calls[0].url, /\/rpc\/admin_create_access_code$/);
    assert.deepEqual(JSON.parse(mock.calls[0].options.body), {
      p_label: 'Cliente Nuevo',
      p_days: 30,
      p_tenant_id: 'tenant-1',
      p_notes: 'primer equipo'
    });

    await adminListAccessCodes(config, session);
    assert.match(mock.calls[1].url, /\/rpc\/admin_list_access_codes$/);

    await redeemAccessCode(config, session, 'ABCD1234');
    assert.match(mock.calls[2].url, /\/rpc\/redeem_access_code$/);
    assert.deepEqual(JSON.parse(mock.calls[2].options.body), { p_code: 'ABCD1234' });

    await adminRevokeAccessCode(config, session, 'code-1');
    assert.match(mock.calls[3].url, /\/rpc\/admin_revoke_access_code$/);
    assert.deepEqual(JSON.parse(mock.calls[3].options.body), { p_id: 'code-1' });
  } finally {
    mock.restore();
  }
});
