-- ============================================================
-- Corte Sergio 3.1 - Backend central para suscripciones
-- ============================================================
-- 1. Crea un proyecto en https://supabase.com
-- 2. Abre SQL Editor, pega TODO este archivo y presiona Run.
-- 3. En Project Settings -> API copia la URL y la clave "anon public".
-- 4. Pega esos valores en config.js.
-- 5. Habilita Authentication -> Providers -> Anonymous sign-ins.
-- 6. Los clientes entran con un código de acceso generado en admin.html.
--    Cada código es de un solo uso y la duración empieza al canjearlo.
-- 7. Para crear otra cuenta administradora, crea el usuario en
--    Authentication -> Users y ejecuta el INSERT de administrador del final.
--
-- IMPORTANTE: este script no borra datos existentes. La tabla antigua
-- corte_sync queda intacta por si necesitas recuperar respaldos.
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- Tablas
-- ------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null default '',
  full_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references auth.users (id) on delete restrict,
  plan text not null default 'trial'
    check (plan in ('trial', 'monthly', 'yearly', 'lifetime')),
  subscription_status text not null default 'trialing'
    check (subscription_status in ('trialing', 'active', 'past_due', 'canceled', 'suspended', 'expired')),
  trial_ends_at timestamptz default (now() + interval '14 days'),
  current_period_end timestamptz,
  comped boolean not null default false,
  currency text not null default 'USD',
  amount_cents integer not null default 0 check (amount_cents >= 0),
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tenants
  alter column trial_ends_at set default (now() + interval '14 days');

-- Si cambias APP_CONFIG.trialDays en config.js, ajusta también los 14 días
-- de este archivo (trigger de alta y valor por defecto).
update public.tenants
set trial_ends_at = created_at + interval '14 days'
where subscription_status = 'trialing' and trial_ends_at is null;

create table if not exists public.tenant_members (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'employee'
    check (role in ('owner', 'admin', 'employee')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create unique index if not exists tenant_members_one_tenant_per_user
  on public.tenant_members (user_id);
create unique index if not exists tenant_members_one_owner
  on public.tenant_members (tenant_id) where role = 'owner';
create index if not exists tenant_members_tenant_idx
  on public.tenant_members (tenant_id);

create table if not exists public.tenant_data (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

create table if not exists public.invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  email text,
  role text not null default 'employee' check (role in ('admin', 'employee')),
  token uuid not null unique default gen_random_uuid(),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null
);

create index if not exists invitations_tenant_idx on public.invitations (tenant_id);

create table if not exists public.access_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  label text not null default '',
  days integer not null default 30 check (days between 1 and 3650),
  tenant_id uuid references public.tenants (id) on delete cascade,
  notes text not null default '',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  used_by uuid references auth.users (id) on delete set null,
  used_at timestamptz,
  revoked_at timestamptz
);

create index if not exists access_codes_created_idx
  on public.access_codes (created_at desc);
create index if not exists access_codes_tenant_idx
  on public.access_codes (tenant_id);

create table if not exists public.subscription_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  provider text not null default 'manual',
  event_type text not null,
  status text not null default 'paid' check (status in ('paid', 'pending', 'failed', 'refunded')),
  amount_cents integer not null default 0 check (amount_cents >= 0),
  currency text not null default 'USD',
  concept text not null default '',
  period_start timestamptz,
  period_end timestamptz,
  external_id text,
  payload jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists subscription_events_tenant_idx
  on public.subscription_events (tenant_id, created_at desc);

create table if not exists public.admin_audit (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users (id) on delete set null,
  action text not null,
  tenant_id uuid references public.tenants (id) on delete set null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_created_idx on public.admin_audit (created_at desc);

-- ------------------------------------------------------------
-- Helpers
-- ------------------------------------------------------------

create or replace function public.is_app_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.app_admins where user_id = auth.uid());
$$;

create or replace function public.my_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select tenant_id from public.tenant_members where user_id = auth.uid() limit 1;
$$;

create or replace function public.my_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.tenant_members where user_id = auth.uid() limit 1;
$$;

create or replace function public.tenant_license_active(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (public.is_app_admin() or p_tenant_id = public.my_tenant_id())
    and exists (
      select 1
      from public.tenants t
      where t.id = p_tenant_id
        and (
          t.comped
          or (t.subscription_status = 'active'
              and (t.plan = 'lifetime'
                   or (t.current_period_end is not null and t.current_period_end > now())))
          or (t.subscription_status = 'past_due'
              and t.current_period_end is not null
              and t.current_period_end + interval '3 days' > now())
          or (t.subscription_status = 'trialing'
              and t.trial_ends_at is not null
              and t.trial_ends_at > now())
          or (t.subscription_status = 'canceled'
              and t.current_period_end is not null
              and t.current_period_end > now())
        )
    );
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists tenants_touch on public.tenants;
create trigger tenants_touch before update on public.tenants
  for each row execute function public.touch_updated_at();

create or replace function public.touch_tenant_data()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  if auth.uid() is not null then
    new.updated_by = auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists tenant_data_touch on public.tenant_data;
create trigger tenant_data_touch before insert or update on public.tenant_data
  for each row execute function public.touch_tenant_data();

-- ------------------------------------------------------------
-- Alta de usuarios: crea perfil, negocio y membresía.
-- Si viene un código de invitación válido, se une al negocio.
-- ------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid;
  v_invite public.invitations%rowtype;
  v_code text;
  v_tenant_name text;
  v_full_name text;
begin
  if coalesce((to_jsonb(new)->>'is_anonymous')::boolean, false) then
    return new;
  end if;

  v_full_name := left(coalesce(new.raw_user_meta_data->>'full_name', ''), 120);
  insert into public.profiles (id, email, full_name)
  values (new.id, coalesce(new.email, ''), v_full_name)
  on conflict (id) do update
    set email = excluded.email,
        full_name = case when excluded.full_name <> '' then excluded.full_name else profiles.full_name end;

  v_code := nullif(trim(new.raw_user_meta_data->>'invite_code'), '');
  if v_code is not null then
    select * into v_invite
    from public.invitations
    where token::text = v_code
      and accepted_at is null
      and expires_at > now()
    for update;

    if not found then
      raise exception 'La invitación no existe o ya venció.';
    end if;

    if v_invite.email is not null and lower(coalesce(new.email, '')) <> lower(v_invite.email) then
      raise exception 'Esta invitación fue emitida para otro correo.';
    end if;

    insert into public.tenant_members (tenant_id, user_id, role)
    values (v_invite.tenant_id, new.id, v_invite.role)
    on conflict do nothing;

    update public.invitations
    set accepted_at = now(), accepted_by = new.id
    where id = v_invite.id;

    return new;
  end if;

  v_tenant_name := left(coalesce(nullif(trim(new.raw_user_meta_data->>'tenant_name'), ''), 'Mi negocio'), 120);

  insert into public.tenants (name, owner_id, trial_ends_at)
  values (v_tenant_name, new.id, now() + interval '14 days')
  returning id into v_tenant_id;

  insert into public.tenant_members (tenant_id, user_id, role)
  values (v_tenant_id, new.id, 'owner');

  insert into public.tenant_data (tenant_id, data)
  values (v_tenant_id, '{}'::jsonb)
  on conflict (tenant_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.app_admins enable row level security;
alter table public.tenants enable row level security;
alter table public.tenant_members enable row level security;
alter table public.tenant_data enable row level security;
alter table public.invitations enable row level security;
alter table public.access_codes enable row level security;
alter table public.subscription_events enable row level security;
alter table public.admin_audit enable row level security;

revoke all on public.access_codes from anon, authenticated;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_app_admin());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

drop policy if exists app_admins_select on public.app_admins;
create policy app_admins_select on public.app_admins
  for select to authenticated
  using (public.is_app_admin());

drop policy if exists tenants_select_member on public.tenants;
create policy tenants_select_member on public.tenants
  for select to authenticated
  using (
    public.is_app_admin()
    or (id = public.my_tenant_id() and public.my_role() in ('owner', 'admin'))
  );

drop policy if exists tenant_members_select on public.tenant_members;
create policy tenant_members_select on public.tenant_members
  for select to authenticated
  using (
    public.is_app_admin()
    or (tenant_id = public.my_tenant_id() and public.my_role() in ('owner', 'admin'))
  );

drop policy if exists tenant_data_member_all on public.tenant_data;
drop policy if exists tenant_data_member_select on public.tenant_data;
create policy tenant_data_member_select on public.tenant_data
  for select to authenticated
  using (tenant_id = public.my_tenant_id());

drop policy if exists tenant_data_member_insert on public.tenant_data;
create policy tenant_data_member_insert on public.tenant_data
  for insert to authenticated
  with check (tenant_id = public.my_tenant_id() and public.tenant_license_active(tenant_id));

drop policy if exists tenant_data_member_update on public.tenant_data;
create policy tenant_data_member_update on public.tenant_data
  for update to authenticated
  using (tenant_id = public.my_tenant_id() and public.tenant_license_active(tenant_id))
  with check (tenant_id = public.my_tenant_id() and public.tenant_license_active(tenant_id));

drop policy if exists tenant_data_member_delete on public.tenant_data;
create policy tenant_data_member_delete on public.tenant_data
  for delete to authenticated
  using (tenant_id = public.my_tenant_id() and public.tenant_license_active(tenant_id));

drop policy if exists invitations_managers_select on public.invitations;
create policy invitations_managers_select on public.invitations
  for select to authenticated
  using (
    public.is_app_admin()
    or (tenant_id = public.my_tenant_id() and public.my_role() in ('owner', 'admin'))
  );

drop policy if exists subscription_events_managers_select on public.subscription_events;
create policy subscription_events_managers_select on public.subscription_events
  for select to authenticated
  using (
    public.is_app_admin()
    or (tenant_id = public.my_tenant_id() and public.my_role() = 'owner')
  );

drop policy if exists admin_audit_select on public.admin_audit;
create policy admin_audit_select on public.admin_audit
  for select to authenticated
  using (public.is_app_admin());

grant usage on schema public to authenticated;
grant select on public.profiles, public.app_admins, public.tenants, public.tenant_members,
  public.tenant_data, public.invitations, public.subscription_events, public.admin_audit
  to authenticated;
grant insert, update, delete on public.tenant_data to authenticated;
grant update (full_name) on public.profiles to authenticated;

-- ------------------------------------------------------------
-- API de la app (mi cuenta y equipo)
-- ------------------------------------------------------------

create or replace function public.app_me()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'user_id', u.id,
    'email', u.email,
    'full_name', coalesce(p.full_name, ''),
    'tenant_id', t.id,
    'tenant_name', t.name,
    'role', m.role,
    'plan', t.plan,
    'status', t.subscription_status,
    'trial_ends_at', t.trial_ends_at,
    'current_period_end', t.current_period_end,
    'comped', t.comped,
    'currency', t.currency,
    'amount_cents', t.amount_cents,
    'is_app_admin', public.is_app_admin(),
    'member_count', (select count(*) from public.tenant_members tm where tm.tenant_id = t.id),
    'created_at', t.created_at
  )
  from auth.users u
  left join public.profiles p on p.id = u.id
  left join public.tenant_members m on m.user_id = u.id
  left join public.tenants t on t.id = m.tenant_id
  where u.id = auth.uid();
$$;

drop function if exists public.tenant_members_list();

create or replace function public.tenant_members_list()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'user_id', tm.user_id,
      'email', coalesce(nullif(p.email, ''), nullif(u.email, ''), case when u.is_anonymous then 'Dispositivo' else '' end),
      'full_name', coalesce(p.full_name, ''),
      'role', tm.role,
      'created_at', tm.created_at
    )
    order by case tm.role when 'owner' then 0 when 'admin' then 1 else 2 end, coalesce(p.email, u.email, '')
  ), '[]'::jsonb)
  from public.tenant_members tm
  join auth.users u on u.id = tm.user_id
  left join public.profiles p on p.id = tm.user_id
  where tm.tenant_id = public.my_tenant_id()
    and public.my_role() in ('owner', 'admin');
$$;

create or replace function public.rename_tenant(p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := public.my_tenant_id();
  v_name text := left(trim(coalesce(p_name, '')), 120);
begin
  if public.my_role() not in ('owner', 'admin') then
    raise exception 'Solo el dueño o un administrador puede cambiar el nombre del negocio.';
  end if;
  if v_name = '' then
    raise exception 'Escribe el nombre del negocio.';
  end if;
  update public.tenants set name = v_name where id = v_tenant_id;
  return public.app_me();
end;
$$;

create or replace function public.create_invitation(p_role text default 'employee', p_email text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := public.my_tenant_id();
  v_role text := coalesce(nullif(trim(p_role), ''), 'employee');
  v_email text := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_token uuid;
  v_count integer;
begin
  if public.my_role() not in ('owner', 'admin') then
    raise exception 'Solo el dueño o un administrador puede invitar.';
  end if;
  if v_role not in ('admin', 'employee') then
    raise exception 'Rol de invitación inválido.';
  end if;
  if v_role = 'admin' and public.my_role() <> 'owner' then
    raise exception 'Solo el dueño puede invitar administradores.';
  end if;

  select count(*) into v_count
  from public.invitations
  where tenant_id = v_tenant_id and accepted_at is null and expires_at > now();
  if v_count >= 20 then
    raise exception 'Hay demasiadas invitaciones activas. Revoca algunas.';
  end if;

  insert into public.invitations (tenant_id, email, role, created_by)
  values (v_tenant_id, v_email, v_role, auth.uid())
  returning token into v_token;

  return jsonb_build_object(
    'token', v_token,
    'role', v_role,
    'email', v_email,
    'expires_at', now() + interval '14 days'
  );
end;
$$;

drop function if exists public.tenant_invitations();

create or replace function public.tenant_invitations()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', i.id,
      'email', coalesce(i.email, ''),
      'role', i.role,
      'token', i.token,
      'created_at', i.created_at,
      'expires_at', i.expires_at,
      'accepted_at', i.accepted_at
    )
    order by i.created_at desc
  ), '[]'::jsonb)
  from (
    select id, email, role, token, created_at, expires_at, accepted_at
    from public.invitations
    where tenant_id = public.my_tenant_id()
      and public.my_role() in ('owner', 'admin')
    order by created_at desc
    limit 30
  ) i;
$$;

create or replace function public.revoke_invitation(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.my_role() not in ('owner', 'admin') then
    raise exception 'No autorizado.';
  end if;
  delete from public.invitations
  where id = p_id and tenant_id = public.my_tenant_id();
end;
$$;

create or replace function public.accept_invitation(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.invitations%rowtype;
begin
  if exists (select 1 from public.tenant_members where user_id = auth.uid()) then
    raise exception 'Ya perteneces a un negocio.';
  end if;

  select * into v_invite
  from public.invitations
  where token::text = trim(p_code)
    and accepted_at is null
    and expires_at > now()
  for update;

  if not found then
    raise exception 'La invitación no existe o ya venció.';
  end if;

  if v_invite.email is not null and lower(coalesce(auth.email(), '')) <> lower(v_invite.email) then
    raise exception 'Esta invitación fue emitida para otro correo.';
  end if;

  insert into public.tenant_members (tenant_id, user_id, role)
  values (v_invite.tenant_id, auth.uid(), v_invite.role);

  update public.invitations
  set accepted_at = now(), accepted_by = auth.uid()
  where id = v_invite.id;

  return public.app_me();
end;
$$;

create or replace function public.set_member_role(p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.my_role() <> 'owner' then
    raise exception 'Solo el dueño puede cambiar roles.';
  end if;
  if p_role not in ('admin', 'employee') then
    raise exception 'Rol inválido.';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'No puedes cambiar tu propio rol.';
  end if;
  update public.tenant_members
  set role = p_role
  where tenant_id = public.my_tenant_id()
    and user_id = p_user_id
    and role <> 'owner';
end;
$$;

create or replace function public.remove_member(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.my_role() <> 'owner' then
    raise exception 'Solo el dueño puede quitar miembros.';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'No puedes quitarte a ti mismo.';
  end if;
  delete from public.tenant_members
  where tenant_id = public.my_tenant_id()
    and user_id = p_user_id
    and role <> 'owner';
end;
$$;

-- ------------------------------------------------------------
-- Administración del vendedor
-- ------------------------------------------------------------

create or replace function public.admin_metrics()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not public.is_app_admin() then
    raise exception 'No autorizado.';
  end if;

  select jsonb_build_object(
    'tenants', count(*),
    'active', count(*) filter (
      where comped
        or (subscription_status in ('active', 'past_due') and (current_period_end is null or current_period_end > now()))
        or (subscription_status = 'trialing' and (trial_ends_at is null or trial_ends_at > now()))
    ),
    'paying', count(*) filter (
      where not comped and subscription_status in ('active', 'past_due')
    ),
    'trialing', count(*) filter (
      where subscription_status = 'trialing' and (trial_ends_at is null or trial_ends_at > now())
    ),
    'expiring_7d', count(*) filter (
      where (subscription_status = 'trialing' and trial_ends_at between now() and now() + interval '7 days')
         or (subscription_status in ('active', 'past_due') and current_period_end between now() and now() + interval '7 days')
    ),
    'suspended', count(*) filter (where subscription_status in ('suspended', 'expired', 'canceled')),
    'mrr_cents', coalesce(sum(
      case
        when comped or subscription_status not in ('active', 'past_due') then 0
        when plan = 'yearly' then round(amount_cents / 12.0)
        when plan = 'monthly' then amount_cents
        else 0
      end
    ), 0)::integer
  ) into v_result
  from public.tenants;

  return v_result;
end;
$$;

drop function if exists public.admin_list_tenants(text);
drop function if exists public.admin_list_tenants();

create or replace function public.admin_list_tenants(p_search text default '')
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_search text := trim(coalesce(p_search, ''));
  v_result jsonb;
begin
  if not public.is_app_admin() then
    raise exception 'No autorizado.';
  end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.updated_at desc), '[]'::jsonb)
  into v_result
  from (
    select
      t.id as tenant_id,
      t.name,
      coalesce(nullif(u.email, ''), case when u.is_anonymous then 'Dispositivo' else '' end) as owner_email,
      t.plan,
      t.subscription_status,
      t.trial_ends_at,
      t.current_period_end,
      t.comped,
      t.amount_cents,
      t.currency,
      t.notes,
      t.created_at,
      t.updated_at,
      (select count(*) from public.tenant_members tm where tm.tenant_id = t.id) as member_count,
      (select td.updated_at from public.tenant_data td where td.tenant_id = t.id) as last_sync
    from public.tenants t
    join auth.users u on u.id = t.owner_id
    where v_search = ''
       or t.name ilike '%' || v_search || '%'
       or u.email ilike '%' || v_search || '%'
    order by t.updated_at desc
    limit 300
  ) x;

  return v_result;
end;
$$;

create or replace function public.admin_tenant_detail(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not public.is_app_admin() then
    raise exception 'No autorizado.';
  end if;

  select jsonb_build_object(
    'tenant', (
      select to_jsonb(t) || jsonb_build_object(
        'owner_email',
        coalesce(nullif(u.email, ''), case when u.is_anonymous then 'Dispositivo' else '' end)
      )
      from public.tenants t
      join auth.users u on u.id = t.owner_id
      where t.id = p_tenant_id
    ),
    'members', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'user_id', tm.user_id,
          'email', coalesce(nullif(p.email, ''), nullif(u.email, ''), case when u.is_anonymous then 'Dispositivo' else '' end),
          'full_name', coalesce(p.full_name, ''),
          'role', tm.role,
          'created_at', tm.created_at
        )
        order by case tm.role when 'owner' then 0 when 'admin' then 1 else 2 end,
                 coalesce(nullif(p.email, ''), nullif(u.email, ''), case when u.is_anonymous then 'Dispositivo' else '' end)
      )
      from public.tenant_members tm
      join auth.users u on u.id = tm.user_id
      left join public.profiles p on p.id = tm.user_id
      where tm.tenant_id = p_tenant_id
    ), '[]'::jsonb),
    'invitations', coalesce((
      select jsonb_agg(to_jsonb(i) order by i.created_at desc)
      from (
        select id, email, role, token, created_at, expires_at, accepted_at
        from public.invitations
        where tenant_id = p_tenant_id
        order by created_at desc
        limit 20
      ) i
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.created_at desc)
      from (
        select id, provider, event_type, status, amount_cents, currency, concept,
               period_start, period_end, external_id, created_at
        from public.subscription_events
        where tenant_id = p_tenant_id
        order by created_at desc
        limit 30
      ) e
    ), '[]'::jsonb),
    'audit', coalesce((
      select jsonb_agg(to_jsonb(a) order by a.created_at desc)
      from (
        select id, action, details, created_at
        from public.admin_audit
        where tenant_id = p_tenant_id
        order by created_at desc
        limit 30
      ) a
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

create or replace function public.admin_extend_license(
  p_tenant_id uuid,
  p_days integer,
  p_plan text default null,
  p_status text default 'active'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant public.tenants%rowtype;
  v_base timestamptz;
  v_end timestamptz;
begin
  if not public.is_app_admin() then
    raise exception 'No autorizado.';
  end if;
  if p_days is null or p_days < 1 or p_days > 3650 then
    raise exception 'Los días deben estar entre 1 y 3650.';
  end if;
  if p_plan is not null and p_plan not in ('trial', 'monthly', 'yearly', 'lifetime') then
    raise exception 'Plan inválido.';
  end if;
  if p_status not in ('trialing', 'active', 'past_due', 'canceled', 'suspended', 'expired') then
    raise exception 'Estado inválido.';
  end if;

  select case
    when p_status = 'trialing' then greatest(coalesce(trial_ends_at, now()), now())
    else greatest(coalesce(current_period_end, now()), now())
  end into v_base
  from public.tenants
  where id = p_tenant_id;

  if not found then
    raise exception 'El negocio no existe.';
  end if;

  v_end := v_base + make_interval(days => p_days);

  update public.tenants
  set current_period_end = v_end,
      trial_ends_at = case when p_status = 'trialing' then v_end else trial_ends_at end,
      plan = coalesce(p_plan, plan),
      subscription_status = p_status,
      updated_at = now()
  where id = p_tenant_id
  returning * into v_tenant;

  insert into public.admin_audit (actor_id, action, tenant_id, details)
  values (auth.uid(), 'license.extend', p_tenant_id,
    jsonb_build_object('days', p_days, 'plan', p_plan, 'status', p_status));

  return to_jsonb(v_tenant);
end;
$$;

create or replace function public.admin_record_payment(
  p_tenant_id uuid,
  p_amount_cents integer,
  p_currency text default 'USD',
  p_concept text default 'Suscripción',
  p_days integer default 30,
  p_plan text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.subscription_events%rowtype;
  v_end timestamptz;
  v_currency text;
begin
  if not public.is_app_admin() then
    raise exception 'No autorizado.';
  end if;
  if p_amount_cents is null or p_amount_cents < 0 then
    raise exception 'Monto inválido.';
  end if;
  if p_days is null or p_days < 1 or p_days > 3650 then
    raise exception 'Los días deben estar entre 1 y 3650.';
  end if;
  if p_plan is not null and p_plan not in ('trial', 'monthly', 'yearly', 'lifetime') then
    raise exception 'Plan inválido.';
  end if;

  v_currency := upper(coalesce(nullif(trim(p_currency), ''), 'USD'));
  v_end := greatest(now(), coalesce((select current_period_end from public.tenants where id = p_tenant_id), now()))
    + make_interval(days => p_days);

  insert into public.subscription_events (
    tenant_id, provider, event_type, status, amount_cents, currency, concept,
    period_start, period_end, created_by
  )
  values (
    p_tenant_id, 'manual', 'payment', 'paid', p_amount_cents, v_currency,
    coalesce(nullif(trim(p_concept), ''), 'Suscripción'),
    now(), v_end, auth.uid()
  )
  returning * into v_event;

  update public.tenants
  set current_period_end = v_end,
      plan = coalesce(p_plan, plan),
      subscription_status = 'active',
      amount_cents = p_amount_cents,
      currency = v_currency,
      updated_at = now()
  where id = p_tenant_id;

  insert into public.admin_audit (actor_id, action, tenant_id, details)
  values (auth.uid(), 'payment.manual', p_tenant_id,
    jsonb_build_object('amount_cents', p_amount_cents, 'currency', v_currency, 'days', p_days, 'plan', p_plan));

  return to_jsonb(v_event);
end;
$$;

create or replace function public.admin_set_status(
  p_tenant_id uuid,
  p_status text,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant public.tenants%rowtype;
begin
  if not public.is_app_admin() then
    raise exception 'No autorizado.';
  end if;
  if p_status not in ('trialing', 'active', 'past_due', 'canceled', 'suspended', 'expired') then
    raise exception 'Estado inválido.';
  end if;

  update public.tenants
  set subscription_status = p_status,
      notes = coalesce(left(p_notes, 2000), notes),
      updated_at = now()
  where id = p_tenant_id
  returning * into v_tenant;

  if not found then
    raise exception 'El negocio no existe.';
  end if;

  insert into public.admin_audit (actor_id, action, tenant_id, details)
  values (auth.uid(), 'tenant.status', p_tenant_id, jsonb_build_object('status', p_status));

  return to_jsonb(v_tenant);
end;
$$;

create or replace function public.admin_set_trial(p_tenant_id uuid, p_days integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant public.tenants%rowtype;
begin
  if not public.is_app_admin() then
    raise exception 'No autorizado.';
  end if;
  if p_days is null or p_days < 1 or p_days > 365 then
    raise exception 'Los días de prueba deben estar entre 1 y 365.';
  end if;

  update public.tenants
  set plan = 'trial',
      subscription_status = 'trialing',
      trial_ends_at = now() + make_interval(days => p_days),
      current_period_end = null,
      updated_at = now()
  where id = p_tenant_id
  returning * into v_tenant;

  if not found then
    raise exception 'El negocio no existe.';
  end if;

  insert into public.admin_audit (actor_id, action, tenant_id, details)
  values (auth.uid(), 'tenant.trial', p_tenant_id, jsonb_build_object('days', p_days));

  return to_jsonb(v_tenant);
end;
$$;

create or replace function public.admin_set_comped(p_tenant_id uuid, p_comped boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant public.tenants%rowtype;
begin
  if not public.is_app_admin() then
    raise exception 'No autorizado.';
  end if;

  update public.tenants
  set comped = coalesce(p_comped, false),
      subscription_status = case when coalesce(p_comped, false) then 'active' else subscription_status end,
      updated_at = now()
  where id = p_tenant_id
  returning * into v_tenant;

  if not found then
    raise exception 'El negocio no existe.';
  end if;

  insert into public.admin_audit (actor_id, action, tenant_id, details)
  values (auth.uid(), 'tenant.comped', p_tenant_id, jsonb_build_object('comped', p_comped));

  return to_jsonb(v_tenant);
end;
$$;

create or replace function public.admin_update_tenant(
  p_tenant_id uuid,
  p_name text default null,
  p_amount_cents integer default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant public.tenants%rowtype;
  v_name text := nullif(trim(coalesce(p_name, '')), '');
begin
  if not public.is_app_admin() then
    raise exception 'No autorizado.';
  end if;
  if p_amount_cents is not null and p_amount_cents < 0 then
    raise exception 'Monto inválido.';
  end if;

  update public.tenants
  set name = coalesce(left(v_name, 120), name),
      amount_cents = coalesce(p_amount_cents, amount_cents),
      notes = coalesce(left(p_notes, 2000), notes),
      updated_at = now()
  where id = p_tenant_id
  returning * into v_tenant;

  if not found then
    raise exception 'El negocio no existe.';
  end if;

  insert into public.admin_audit (actor_id, action, tenant_id, details)
  values (auth.uid(), 'tenant.update', p_tenant_id,
    jsonb_build_object('name', v_name, 'amount_cents', p_amount_cents));

  return to_jsonb(v_tenant);
end;
$$;

drop function if exists public.admin_list_admins();

create or replace function public.admin_list_admins()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not public.is_app_admin() then
    raise exception 'No autorizado.';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'user_id', a.user_id,
      'email', coalesce(u.email, ''),
      'full_name', coalesce(p.full_name, ''),
      'created_at', a.created_at
    )
    order by a.created_at
  ), '[]'::jsonb)
  into v_result
  from public.app_admins a
  join auth.users u on u.id = a.user_id
  left join public.profiles p on p.id = a.user_id;

  return v_result;
end;
$$;

create or replace function public.admin_add_admin(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_user_id uuid;
begin
  if not public.is_app_admin() then
    raise exception 'No autorizado.';
  end if;
  if v_email = '' then
    raise exception 'Escribe el correo.';
  end if;

  select id into v_user_id from auth.users where lower(email) = v_email;
  if v_user_id is null then
    raise exception 'No existe una cuenta con ese correo. La persona debe crear su cuenta primero.';
  end if;

  insert into public.app_admins (user_id) values (v_user_id)
  on conflict (user_id) do nothing;

  insert into public.admin_audit (actor_id, action, details)
  values (auth.uid(), 'admin.add', jsonb_build_object('email', v_email));

  return jsonb_build_object('user_id', v_user_id, 'email', v_email);
end;
$$;

create or replace function public.admin_remove_admin(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_app_admin() then
    raise exception 'No autorizado.';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'No puedes quitarte a ti mismo.';
  end if;

  delete from public.app_admins where user_id = p_user_id;

  insert into public.admin_audit (actor_id, action, details)
  values (auth.uid(), 'admin.remove', jsonb_build_object('user_id', p_user_id));
end;
$$;

-- ------------------------------------------------------------
-- Códigos de acceso de clientes
-- ------------------------------------------------------------

create or replace function public.admin_create_access_code(
  p_label text default '',
  p_days integer default 30,
  p_tenant_id uuid default null,
  p_notes text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_code_id uuid;
  v_label text := left(trim(coalesce(p_label, '')), 120);
  v_notes text := left(trim(coalesce(p_notes, '')), 2000);
  v_tenant_name text;
  v_record public.access_codes%rowtype;
begin
  if not public.is_app_admin() then
    raise exception 'No autorizado.';
  end if;
  if p_days is null or p_days < 1 or p_days > 3650 then
    raise exception 'Los días deben estar entre 1 y 3650.';
  end if;

  if p_tenant_id is not null then
    select name into v_tenant_name from public.tenants where id = p_tenant_id;
    if not found then
      raise exception 'El negocio no existe.';
    end if;
    if v_label = '' then
      v_label := v_tenant_name;
    end if;
  end if;

  loop
    v_code := upper(substr(md5(gen_random_uuid()::text), 1, 8));
    begin
      insert into public.access_codes (code, label, days, tenant_id, notes, created_by)
      values (v_code, v_label, p_days, p_tenant_id, v_notes, auth.uid())
      returning id into v_code_id;
      exit;
    exception when unique_violation then
      null;
    end;
  end loop;

  select * into v_record from public.access_codes where id = v_code_id;

  insert into public.admin_audit (actor_id, action, tenant_id, details)
  values (auth.uid(), 'access_code.create', p_tenant_id,
    jsonb_build_object('code_id', v_code_id, 'label', v_label, 'days', p_days));

  return jsonb_build_object(
    'id', v_record.id,
    'code', v_record.code,
    'label', v_record.label,
    'days', v_record.days,
    'tenant_id', v_record.tenant_id,
    'tenant_name', coalesce(v_tenant_name, ''),
    'created_at', v_record.created_at
  );
end;
$$;

create or replace function public.admin_list_access_codes()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not public.is_app_admin() then
    raise exception 'No autorizado.';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', ac.id,
      'code', ac.code,
      'label', ac.label,
      'days', ac.days,
      'tenant_id', ac.tenant_id,
      'tenant_name', coalesce(t.name, ''),
      'notes', ac.notes,
      'created_at', ac.created_at,
      'used_at', ac.used_at,
      'revoked_at', ac.revoked_at,
      'used_by_email', coalesce(u.email, ''),
      'access_ends_at', case
        when ac.used_at is null then null
        when t.id is not null then t.current_period_end
        else ac.used_at + make_interval(days => ac.days)
      end,
      'subscription_status', coalesce(t.subscription_status, '')
    )
    order by ac.created_at desc
  ), '[]'::jsonb)
  into v_result
  from (
    select * from public.access_codes order by created_at desc limit 200
  ) ac
  left join public.tenants t on t.id = ac.tenant_id
  left join auth.users u on u.id = ac.used_by;

  return v_result;
end;
$$;

create or replace function public.admin_revoke_access_code(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_record public.access_codes%rowtype;
begin
  if not public.is_app_admin() then
    raise exception 'No autorizado.';
  end if;

  update public.access_codes
  set revoked_at = now()
  where id = p_id and revoked_at is null
  returning * into v_record;

  if not found then
    raise exception 'El código no existe o ya fue revocado.';
  end if;

  insert into public.admin_audit (actor_id, action, tenant_id, details)
  values (auth.uid(), 'access_code.revoke', v_record.tenant_id,
    jsonb_build_object('code_id', v_record.id));

  return jsonb_build_object('id', v_record.id, 'revoked_at', v_record.revoked_at);
end;
$$;

create or replace function public.redeem_access_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code_text text := upper(regexp_replace(coalesce(p_code, ''), '[^a-zA-Z0-9]', '', 'g'));
  v_record public.access_codes%rowtype;
  v_existing_tenant uuid;
  v_tenant_id uuid;
  v_tenant_name text;
  v_plan text;
  v_base timestamptz;
  v_end timestamptz;
  v_email text;
  v_full_name text;
begin
  if auth.uid() is null then
    raise exception 'Inicia sesión para canjear el código.';
  end if;
  if length(v_code_text) < 4 or length(v_code_text) > 32 then
    raise exception 'Código inválido.';
  end if;

  select * into v_record
  from public.access_codes
  where code = v_code_text
  for update;

  if not found then
    raise exception 'Código inválido.';
  end if;
  if v_record.revoked_at is not null then
    raise exception 'Este código fue revocado.';
  end if;
  if v_record.used_at is not null then
    raise exception 'Este código ya fue utilizado.';
  end if;

  select tenant_id into v_existing_tenant
  from public.tenant_members
  where user_id = auth.uid()
  limit 1;
  if found then
    raise exception 'Esta cuenta ya tiene un negocio asignado.';
  end if;

  select coalesce(email, ''), left(coalesce(raw_user_meta_data->>'full_name', ''), 120)
  into v_email, v_full_name
  from auth.users
  where id = auth.uid();

  insert into public.profiles (id, email, full_name)
  values (auth.uid(), coalesce(v_email, ''), coalesce(v_full_name, ''))
  on conflict (id) do nothing;

  if v_record.tenant_id is not null then
    select name,
           greatest(coalesce(current_period_end, now()), coalesce(trial_ends_at, now()), now()),
           case when plan in ('monthly', 'yearly', 'lifetime') then plan else 'monthly' end
    into v_tenant_name, v_base, v_plan
    from public.tenants
    where id = v_record.tenant_id;

    if not found then
      raise exception 'El negocio del código no existe.';
    end if;

    v_tenant_id := v_record.tenant_id;
    v_end := v_base + make_interval(days => v_record.days);

    update public.tenants
    set current_period_end = v_end,
        trial_ends_at = case when subscription_status = 'trialing' then v_end else trial_ends_at end,
        plan = v_plan,
        subscription_status = 'active',
        updated_at = now()
    where id = v_tenant_id;

    insert into public.tenant_members (tenant_id, user_id, role)
    values (v_tenant_id, auth.uid(), 'admin')
    on conflict do nothing;
  else
    v_tenant_name := left(coalesce(nullif(v_record.label, ''), 'Mi negocio'), 120);
    v_end := now() + make_interval(days => v_record.days);

    insert into public.tenants (
      name, owner_id, plan, subscription_status, trial_ends_at,
      current_period_end, amount_cents, currency, notes
    )
    values (
      v_tenant_name, auth.uid(), 'monthly', 'active', now(),
      v_end, 0, 'USD', v_record.notes
    )
    returning id into v_tenant_id;

    insert into public.tenant_members (tenant_id, user_id, role)
    values (v_tenant_id, auth.uid(), 'owner');

    insert into public.tenant_data (tenant_id, data)
    values (v_tenant_id, '{}'::jsonb)
    on conflict (tenant_id) do nothing;
  end if;

  update public.access_codes
  set used_by = auth.uid(), used_at = now(), tenant_id = v_tenant_id
  where id = v_record.id;

  insert into public.subscription_events (
    tenant_id, provider, event_type, status, amount_cents, currency,
    concept, period_start, period_end, external_id, payload, created_by
  )
  values (
    v_tenant_id, 'access_code', 'access_code', 'paid', 0, 'USD',
    'Código de acceso', now(), v_end, v_record.code,
    jsonb_build_object('code_id', v_record.id, 'days', v_record.days), auth.uid()
  );

  insert into public.admin_audit (actor_id, action, tenant_id, details)
  values (auth.uid(), 'access_code.redeem', v_tenant_id,
    jsonb_build_object('code_id', v_record.id, 'label', v_record.label, 'days', v_record.days));

  return public.app_me();
end;
$$;

-- ------------------------------------------------------------
-- Permisos de ejecución de RPC (solo usuarios autenticados)
-- ------------------------------------------------------------

do $$
declare
  v_sig regprocedure;
begin
  foreach v_sig in array array[
    'public.app_me()'::regprocedure,
    'public.tenant_license_active(uuid)'::regprocedure,
    'public.tenant_members_list()'::regprocedure,
    'public.rename_tenant(text)'::regprocedure,
    'public.create_invitation(text,text)'::regprocedure,
    'public.tenant_invitations()'::regprocedure,
    'public.revoke_invitation(uuid)'::regprocedure,
    'public.accept_invitation(text)'::regprocedure,
    'public.set_member_role(uuid,text)'::regprocedure,
    'public.remove_member(uuid)'::regprocedure,
    'public.admin_metrics()'::regprocedure,
    'public.admin_list_tenants(text)'::regprocedure,
    'public.admin_tenant_detail(uuid)'::regprocedure,
    'public.admin_extend_license(uuid,integer,text,text)'::regprocedure,
    'public.admin_record_payment(uuid,integer,text,text,integer,text)'::regprocedure,
    'public.admin_set_status(uuid,text,text)'::regprocedure,
    'public.admin_set_trial(uuid,integer)'::regprocedure,
    'public.admin_set_comped(uuid,boolean)'::regprocedure,
    'public.admin_update_tenant(uuid,text,integer,text)'::regprocedure,
    'public.admin_list_admins()'::regprocedure,
    'public.admin_add_admin(text)'::regprocedure,
    'public.admin_remove_admin(uuid)'::regprocedure,
    'public.admin_create_access_code(text,integer,uuid,text)'::regprocedure,
    'public.admin_list_access_codes()'::regprocedure,
    'public.admin_revoke_access_code(uuid)'::regprocedure,
    'public.redeem_access_code(text)'::regprocedure
  ]
  loop
    begin
      execute format('revoke all on function %s from public', v_sig);
      execute format('grant execute on function %s to authenticated', v_sig);
    end;
  end loop;
end;
$$;

-- ============================================================
-- PASO FINAL: conviértete en administrador del vendedor.
-- Crea primero tu cuenta desde la app, luego ejecuta (cambia el correo):
--
-- insert into public.app_admins (user_id)
-- select id from auth.users where lower(email) = lower('tu@correo.com')
-- on conflict (user_id) do nothing;
-- ============================================================
