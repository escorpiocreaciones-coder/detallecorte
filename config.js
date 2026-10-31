export const APP_CONFIG = {
  supabaseUrl: 'https://gxddocnoiwieehkbswbi.supabase.co',
  supabaseAnonKey: 'sb_publishable_Fxe06JqpVX1-FWRpkANOPQ_vSOrdbeA',
  appName: 'Administración de Corte Sergio',
  appVersion: '3.0.0',
  trialDays: 14,
  offlineGraceDays: 7,
  currency: 'USD',
  prices: {
    monthly: 9.99,
    yearly: 89.99
  },
  checkoutMonthlyUrl: '',
  checkoutYearlyUrl: '',
  manageSubscriptionUrl: '',
  supportWhatsApp: '',
  supportEmail: '',
  adminPath: './admin.html'
};

export const BACKEND_READY = Boolean(
  String(APP_CONFIG.supabaseUrl || '').trim()
  && String(APP_CONFIG.supabaseAnonKey || '').trim()
);

function normalizeSupabaseUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1$/i, '')
    .replace(/\/+$/, '');
}

export function backendConfig() {
  return {
    url: normalizeSupabaseUrl(APP_CONFIG.supabaseUrl),
    anonKey: String(APP_CONFIG.supabaseAnonKey || '').trim()
  };
}
