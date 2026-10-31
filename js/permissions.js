export const ROLE_LABELS = {
  owner: 'Dueño',
  admin: 'Administrador',
  employee: 'Empleado'
};

const ROLE_PERMISSIONS = {
  owner: new Set([
    'edit',
    'delete_ficha',
    'manage_workers',
    'backup',
    'clear_data',
    'members',
    'invite',
    'manage_roles',
    'rename',
    'billing'
  ]),
  admin: new Set([
    'edit',
    'delete_ficha',
    'manage_workers',
    'backup',
    'members',
    'invite',
    'rename'
  ]),
  employee: new Set(['edit'])
};

export function roleLabel(role) {
  return ROLE_LABELS[role] ?? String(role ?? 'Sin rol');
}

export function can(role, action, options = {}) {
  if (options.isAppAdmin) return true;
  const permissions = ROLE_PERMISSIONS[role];
  return Boolean(permissions && permissions.has(action));
}

export function isManager(role) {
  return role === 'owner' || role === 'admin';
}
