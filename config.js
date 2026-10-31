export const APP_CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: '',
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

export function backendConfig() {
  return {
    url: String(APP_CONFIG.supabaseUrl || '').trim().replace(/\/+$/, ''),
    anonKey: String(APP_CONFIG.supabaseAnonKey || '').trim()
  };
}
