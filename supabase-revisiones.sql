-- Ejecutar en Supabase SQL Editor (idempotente) DESPUÉS de supabase-cargas.sql.
-- Tilde de "resuelto" en la pestaña Revisar cargas: recordatorio compartido entre dispositivos.
-- Solo un usuario con sesión puede leer, marcar y desmarcar. No toca ningún otro dato.

create table if not exists revisiones_marcadas (
  clave text primary key,                       -- identifica el aviso (tipo, fecha, comprobante, producto y montos)
  marcada_at timestamptz not null default now(),
  usuario uuid default auth.uid()
);
alter table revisiones_marcadas enable row level security;

drop policy if exists "revisiones_select" on revisiones_marcadas;
create policy "revisiones_select" on revisiones_marcadas for select to authenticated using (true);
drop policy if exists "revisiones_insert" on revisiones_marcadas;
create policy "revisiones_insert" on revisiones_marcadas for insert to authenticated with check (true);
drop policy if exists "revisiones_delete" on revisiones_marcadas;
create policy "revisiones_delete" on revisiones_marcadas for delete to authenticated using (true);

grant select, insert, delete on revisiones_marcadas to authenticated;
