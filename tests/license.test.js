import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_OFFLINE_GRACE_DAYS,
  accessWarning,
  evaluateAccess,
  licenseState,
  planLabel,
  statusLabel
} from '../js/license.js';
import { can, isManager, roleLabel } from '../js/permissions.js';

const NOW = new Date('2026-05-20T12:00:00.000Z');

function me(overrides = {}) {
  return {
    tenant_id: 'tenant-1',
    status: 'active',
    plan: 'monthly',
    trial_ends_at: null,
    current_period_end: new Date(NOW.getTime() + 10 * 86400000).toISOString(),
    comped: false,
    is_app_admin: false,
    ...overrides
  };
}

test('planLabel y statusLabel traducen valores conocidos y desconocidos', () => {
  assert.equal(planLabel('yearly'), 'Anual');
  assert.equal(planLabel('otro'), 'otro');
  assert.equal(statusLabel('trialing'), 'En prueba');
  assert.equal(statusLabel(null), 'Sin estado');
});

test('licenseState permite trial mientras la fecha no vence', () => {
  const active = licenseState(me({
    status: 'trialing',
    plan: 'trial',
    trial_ends_at: new Date(NOW.getTime() + 2 * 86400000).toISOString()
  }), { now: NOW });
  assert.equal(active.active, true);
  assert.equal(active.reason, 'trial');
  assert.equal(active.daysLeft, 2);
});

test('licenseState rechaza trial vencido', () => {
  const expired = licenseState(me({
    status: 'trialing',
    plan: 'trial',
    trial_ends_at: new Date(NOW.getTime() - 1000).toISOString()
  }), { now: NOW });
  assert.equal(expired.active, false);
  assert.equal(expired.reason, 'trial_expired');
});

test('licenseState rechaza trial sin fecha', () => {
  const expired = licenseState(me({
    status: 'trialing',
    plan: 'trial',
    trial_ends_at: null,
    current_period_end: null
  }), { now: NOW });
  assert.equal(expired.active, false);
  assert.equal(expired.reason, 'trial_expired');
});

test('licenseState acepta suscripción activa hasta el final del periodo', () => {
  const active = licenseState(me(), { now: NOW });
  assert.equal(active.active, true);
  assert.equal(active.reason, 'active');
  assert.equal(active.daysLeft, 10);
});

test('licenseState no regala acceso activo sin periodo', () => {
  const expired = licenseState(me({ current_period_end: null }), { now: NOW });
  assert.equal(expired.active, false);
  assert.equal(expired.reason, 'expired');
});

test('licenseState permite plan de por vida sin periodo', () => {
  const active = licenseState(me({ plan: 'lifetime', current_period_end: null }), { now: NOW });
  assert.equal(active.active, true);
  assert.equal(active.reason, 'active');
  assert.equal(active.daysLeft, null);
});

test('licenseState rechaza suscripción activa vencida', () => {
  const expired = licenseState(me({
    current_period_end: new Date(NOW.getTime() - 1000).toISOString()
  }), { now: NOW });
  assert.equal(expired.active, false);
  assert.equal(expired.reason, 'expired');
});

test('licenseState da gracia por pago pendiente y luego bloquea', () => {
  const inGrace = licenseState(me({
    status: 'past_due',
    current_period_end: new Date(NOW.getTime() - 86400000).toISOString()
  }), { now: NOW, pastDueGraceDays: 3 });
  assert.equal(inGrace.active, true);
  assert.equal(inGrace.reason, 'past_due');

  const out = licenseState(me({
    status: 'past_due',
    current_period_end: new Date(NOW.getTime() - 5 * 86400000).toISOString()
  }), { now: NOW, pastDueGraceDays: 3 });
  assert.equal(out.active, false);
  assert.equal(out.reason, 'past_due_expired');
});

test('licenseState mantiene acceso cancelado hasta el final del periodo', () => {
  const active = licenseState(me({ status: 'canceled' }), { now: NOW });
  assert.equal(active.active, true);
  assert.equal(active.reason, 'canceled_active');

  const expired = licenseState(me({
    status: 'canceled',
    current_period_end: new Date(NOW.getTime() - 1000).toISOString()
  }), { now: NOW });
  assert.equal(expired.active, false);
  assert.equal(expired.reason, 'canceled');
});

test('licenseState suspende y vence de inmediato', () => {
  assert.equal(licenseState(me({ status: 'suspended' }), { now: NOW }).reason, 'suspended');
  assert.equal(licenseState(me({ status: 'expired' }), { now: NOW }).reason, 'expired');
});

test('licenseState reconoce comped y administradores del vendedor', () => {
  assert.equal(licenseState(me({ comped: true }), { now: NOW }).reason, 'comped');
  assert.equal(licenseState(me({ status: 'suspended', is_app_admin: true }), { now: NOW }).reason, 'admin');
});

test('licenseState sin negocio no está activo', () => {
  const result = licenseState(null, { now: NOW });
  assert.equal(result.active, false);
  assert.equal(result.reason, 'no_account');
});

test('evaluateAccess usa la licencia del servidor cuando hay conexión', () => {
  const access = evaluateAccess(me(), { now: NOW, offline: false, verifiedAt: NOW.toISOString() });
  assert.equal(access.active, true);
  assert.equal(access.source, 'server');
});

test('evaluateAccess permite gracia offline para planes pagados', () => {
  const verifiedAt = new Date(NOW.getTime() - 2 * 86400000).toISOString();
  const access = evaluateAccess(me({
    current_period_end: new Date(NOW.getTime() - 86400000).toISOString()
  }), {
    now: NOW,
    offline: true,
    verifiedAt,
    graceDays: DEFAULT_OFFLINE_GRACE_DAYS
  });
  assert.equal(access.active, true);
  assert.equal(access.reason, 'offline_grace');
  assert.equal(access.source, 'cache');
  assert.equal(access.daysLeft, 5);
});

test('evaluateAccess también da gracia offline durante la prueba', () => {
  const verifiedAt = new Date(NOW.getTime() - 2 * 86400000).toISOString();
  const access = evaluateAccess(me({
    status: 'trialing',
    plan: 'trial',
    trial_ends_at: new Date(NOW.getTime() - 86400000).toISOString()
  }), {
    now: NOW,
    offline: true,
    verifiedAt,
    graceDays: 7
  });
  assert.equal(access.active, true);
  assert.equal(access.reason, 'offline_grace');
});

test('evaluateAccess bloquea si la gracia offline expiró', () => {
  const access = evaluateAccess(me({
    current_period_end: new Date(NOW.getTime() - 8 * 86400000).toISOString()
  }), {
    now: NOW,
    offline: true,
    verifiedAt: new Date(NOW.getTime() - 9 * 86400000).toISOString(),
    graceDays: 7
  });
  assert.equal(access.active, false);
  assert.equal(access.reason, 'offline_expired');
});

test('evaluateAccess bloquea si no hay verificación previa', () => {
  const access = evaluateAccess(me({
    current_period_end: new Date(NOW.getTime() - 86400000).toISOString()
  }), { now: NOW, offline: true, verifiedAt: '' });
  assert.equal(access.active, false);
  assert.equal(access.offline, true);
});

test('accessWarning avisa de gracia, pago pendiente y vencimientos', () => {
  assert.match(accessWarning({ active: true, reason: 'offline_grace' }), /Sin conexión/);
  assert.match(accessWarning({ active: true, reason: 'past_due' }), /pago está pendiente/);
  assert.match(accessWarning({ active: true, reason: 'active', daysLeft: 4 }), /vence en 4 días/);
  assert.match(accessWarning({ active: true, reason: 'trial', isTrial: true, daysLeft: 1 }), /prueba vence en 1 día/);
  assert.equal(accessWarning({ active: false, reason: 'expired' }), '');
});

test('permissions define acciones por rol', () => {
  assert.equal(can('owner', 'billing'), true);
  assert.equal(can('admin', 'billing'), false);
  assert.equal(can('admin', 'invite'), true);
  assert.equal(can('admin', 'clear_data'), false);
  assert.equal(can('employee', 'edit'), true);
  assert.equal(can('employee', 'manage_workers'), false);
  assert.equal(can('employee', 'invite', { isAppAdmin: true }), true);
  assert.equal(can('', 'edit'), false);
});

test('isManager y roleLabel identifican dueños y administradores', () => {
  assert.equal(isManager('owner'), true);
  assert.equal(isManager('admin'), true);
  assert.equal(isManager('employee'), false);
  assert.equal(roleLabel('employee'), 'Empleado');
  assert.equal(roleLabel(null), 'Sin rol');
});
