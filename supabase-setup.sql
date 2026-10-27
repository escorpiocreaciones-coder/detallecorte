-- Configuración de sincronización para Administración de Corte Sergio.
-- 1. Crea un proyecto gratis en https://supabase.com
-- 2. Entra a SQL Editor, pega todo este archivo y presiona Run.
-- 3. En Settings -> API copia la URL del proyecto y la clave "anon public".
-- 4. En la app (Ajustes -> Sincronización) pega esos datos y crea una cuenta.

create table if not exists public.corte_sync (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.corte_sync enable row level security;

drop policy if exists "corte_sync_own_rows" on public.corte_sync;
create policy "corte_sync_own_rows"
  on public.corte_sync
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.corte_sync to authenticated;

-- Opcional para uso personal: si no quieres confirmar el correo al crear la
-- cuenta, desactiva "Confirm email" en Authentication -> Sign In / Providers
-- -> Email. Si lo dejas activo, confirma el enlace antes de iniciar sesión.
