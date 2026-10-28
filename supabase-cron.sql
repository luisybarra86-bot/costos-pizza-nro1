-- Sync diaria automática con FUDO (Supabase SQL Editor, se ejecuta una vez; se puede repetir)
-- Reemplazar TU_SYNC_TOKEN por el valor del secret SYNC_TOKEN antes de ejecutar.
-- Corre todos los días a las 06:00 hora Argentina (09:00 UTC) y trae los últimos 3 días.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- El token queda en Vault (cifrado), no escrito en la tarea
select vault.create_secret('TU_SYNC_TOKEN', 'sync_token_costos')
where not exists (select 1 from vault.secrets where name = 'sync_token_costos');

select cron.schedule(
  'sync-fudo-diaria',
  '0 9 * * *',
  $$
  select net.http_post(
    url := 'https://evvapjphhldhxfdidvqe.supabase.co/functions/v1/sync-fudo',
    headers := jsonb_build_object(
      'x-sync-token',
      (select decrypted_secret from vault.decrypted_secrets where name = 'sync_token_costos')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
