-- Ejecutar en Supabase SQL Editor (idempotente) DESPUÉS de supabase-cron.sql (usa el mismo token guardado en Vault).
-- Botón "Actualizar ahora" del dashboard: dispara una sincronización con FUDO sin esperar a las 6:00.
--
-- El token de la sync NO viaja al navegador: lo lee esta función desde el Vault y llama a la Edge Function.
-- Solo un usuario con sesión puede ejecutarla, y no deja lanzar otra si hubo actividad en los últimos 90 segundos.

create or replace function sync_manual() returns jsonb
language plpgsql security definer set search_path = public, vault, extensions as $$
declare
  tok text;
  req bigint;
begin
  if auth.uid() is null then
    raise exception 'Hace falta iniciar sesión';
  end if;
  if exists (select 1 from sync_log where created_at > now() - interval '90 seconds') then
    return jsonb_build_object('ok', false, 'motivo', 'reciente');
  end if;
  select decrypted_secret into tok from vault.decrypted_secrets where name = 'sync_token_costos';
  if tok is null then
    raise exception 'Falta el token de la sync en Vault (ejecutar supabase-cron.sql)';
  end if;
  select net.http_post(
    url := 'https://evvapjphhldhxfdidvqe.supabase.co/functions/v1/sync-fudo',
    headers := jsonb_build_object('x-sync-token', tok),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  ) into req;
  return jsonb_build_object('ok', true, 'request_id', req);
end
$$;

revoke all on function sync_manual() from public, anon;
grant execute on function sync_manual() to authenticated;
