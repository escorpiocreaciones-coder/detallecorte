export const DEFAULT_OFFLINE_GRACE_DAYS = 7;
export const DEFAULT_PAST_DUE_GRACE_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

export const PLAN_LABELS = {
  trial: 'Prueba',
  monthly: 'Mensual',
  yearly: 'Anual',
  lifetime: 'De por vida'
};

export const STATUS_LABELS = {
  trialing: 'En prueba',
  active: 'Activa',
  past_due: 'Pago pendiente',
  canceled: 'Cancelada',
  suspended: 'Suspendida',
  expired: 'Vencida'
};

const PAID_REASONS = new Set(['active', 'trial', 'past_due', 'canceled_active', 'comped']);

export function planLabel(plan) {
  return PLAN_LABELS[plan] ?? String(plan ?? 'Sin plan');
}

export function statusLabel(status) {
  return STATUS_LABELS[status] ?? String(status ?? 'Sin estado');
}

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysBetween(from, to) {
  return Math.ceil((to.getTime() - from.getTime()) / DAY_MS);
}

export function licenseState(me, options = {}) {
  const now = toDate(options.now) ?? new Date();
  const pastDueGraceDays = Number.isFinite(Number(options.pastDueGraceDays))
    ? Math.max(0, Number(options.pastDueGraceDays))
    : DEFAULT_PAST_DUE_GRACE_DAYS;

  const result = {
    active: false,
    reason: 'no_account',
    status: '',
    plan: '',
    isTrial: false,
    pastDue: false,
    comped: false,
    isAdmin: false,
    until: null,
    daysLeft: null
  };

  if (!me || typeof me !== 'object' || !me.tenant_id) return result;

  const status = String(me.status ?? '');
  const plan = String(me.plan ?? '');
  const trialEnd = toDate(me.trial_ends_at);
  const periodEnd = toDate(me.current_period_end);
  const comped = Boolean(me.comped);
  const isAdmin = Boolean(me.is_app_admin);

  Object.assign(result, {
    status,
    plan,
    isTrial: status === 'trialing' || plan === 'trial',
    pastDue: status === 'past_due',
    comped,
    isAdmin
  });

  if (isAdmin) {
    return { ...result, active: true, reason: 'admin' };
  }

  if (comped) {
    return { ...result, active: true, reason: 'comped', until: periodEnd, daysLeft: periodEnd ? daysBetween(now, periodEnd) : null };
  }

  if (status === 'trialing') {
    const daysLeft = trialEnd ? daysBetween(now, trialEnd) : null;
    if (trialEnd && now <= trialEnd) {
      return { ...result, active: true, reason: 'trial', until: trialEnd, daysLeft };
    }
    return { ...result, reason: 'trial_expired', until: trialEnd, daysLeft };
  }

  if (status === 'active') {
    const lifetime = plan === 'lifetime';
    if (lifetime || (periodEnd && now <= periodEnd)) {
      return { ...result, active: true, reason: 'active', until: periodEnd, daysLeft: periodEnd ? daysBetween(now, periodEnd) : null };
    }
    return { ...result, reason: 'expired', until: periodEnd, daysLeft: periodEnd ? daysBetween(now, periodEnd) : null };
  }

  if (status === 'past_due') {
    const graceUntil = periodEnd ? new Date(periodEnd.getTime() + pastDueGraceDays * DAY_MS) : null;
    if (graceUntil && now <= graceUntil) {
      return {
        ...result,
        active: true,
        reason: 'past_due',
        until: graceUntil,
        daysLeft: daysBetween(now, graceUntil)
      };
    }
    return { ...result, reason: 'past_due_expired', until: graceUntil, daysLeft: graceUntil ? daysBetween(now, graceUntil) : null };
  }

  if (status === 'canceled') {
    if (periodEnd && now <= periodEnd) {
      return { ...result, active: true, reason: 'canceled_active', until: periodEnd, daysLeft: daysBetween(now, periodEnd) };
    }
    return { ...result, reason: 'canceled', until: periodEnd, daysLeft: periodEnd ? daysBetween(now, periodEnd) : null };
  }

  if (status === 'suspended') {
    return { ...result, reason: 'suspended' };
  }

  if (status === 'expired') {
    return { ...result, reason: 'expired' };
  }

  return { ...result, reason: 'inactive' };
}

export function evaluateAccess(me, options = {}) {
  const now = toDate(options.now) ?? new Date();
  const offline = Boolean(options.offline);
  const graceDays = Number.isFinite(Number(options.graceDays))
    ? Math.max(0, Number(options.graceDays))
    : DEFAULT_OFFLINE_GRACE_DAYS;

  const current = licenseState(me, { now, pastDueGraceDays: options.pastDueGraceDays });
  if (current.active) return { ...current, source: 'server', offline: false };

  if (!me || !me.tenant_id) return { ...current, source: 'none', offline };

  const verifiedAt = toDate(options.verifiedAt);
  if (!offline || !verifiedAt) return { ...current, source: 'server', offline };

  const cached = licenseState(me, { now: verifiedAt, pastDueGraceDays: options.pastDueGraceDays });
  const elapsedDays = Math.max(0, daysBetween(verifiedAt, now));
  const withinGrace = elapsedDays <= graceDays;
  const paidAccess = cached.active && PAID_REASONS.has(cached.reason);

  if (paidAccess && withinGrace) {
    return {
      ...cached,
      active: true,
      reason: 'offline_grace',
      source: 'cache',
      offline: true,
      until: new Date(verifiedAt.getTime() + graceDays * DAY_MS),
      daysLeft: graceDays - elapsedDays
    };
  }

  return {
    ...current,
    reason: current.reason === 'no_account' ? 'no_account' : 'offline_expired',
    source: 'cache',
    offline: true
  };
}

export function accessWarning(access) {
  if (!access?.active) return '';
  if (access.reason === 'offline_grace') return 'Sin conexión: usando acceso temporal.';
  if (access.reason === 'past_due') return 'Tu pago está pendiente. Actualiza tu método de pago.';
  if (access.reason === 'canceled_active') return 'Tu suscripción fue cancelada y vence pronto.';
  if (access.isTrial && Number.isFinite(access.daysLeft) && access.daysLeft <= 3) {
    return access.daysLeft <= 0 ? 'Tu prueba vence hoy.' : `Tu prueba vence en ${access.daysLeft} día${access.daysLeft === 1 ? '' : 's'}.`;
  }
  if (Number.isFinite(access.daysLeft) && access.daysLeft >= 0 && access.daysLeft <= 5) {
    return `Tu suscripción vence en ${access.daysLeft} día${access.daysLeft === 1 ? '' : 's'}.`;
  }
  return '';
}
