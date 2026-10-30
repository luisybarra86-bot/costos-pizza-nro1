-- Ejecutar en Supabase SQL Editor (idempotente) DESPUÉS de supabase-compras.sql y supabase-precios.sql.
-- Ventas por modo (salón / take away / delivery), qué se vendió por rubro, cuándo, y cajas estimadas.

create table if not exists ventas_fudo (
  fudo_sale_id text primary key,
  fecha date not null,                 -- día argentino de cierre
  cerrada_at timestamptz not null,
  tipo text not null,                  -- EAT-IN (salón) | TAKEAWAY | DELIVERY
  total numeric(14,2) not null default 0
);
create index if not exists ventas_fudo_fecha_idx on ventas_fudo (fecha);

-- Catálogo de FUDO: producto -> categoría
create table if not exists productos_fudo (
  producto_id text primary key,
  nombre text not null,
  categoria text
);

alter table ventas_fudo enable row level security;
alter table productos_fudo enable row level security;
drop policy if exists "ventas_fudo_auth" on ventas_fudo;
create policy "ventas_fudo_auth" on ventas_fudo for select to authenticated using (true);
drop policy if exists "productos_fudo_auth" on productos_fudo;
create policy "productos_fudo_auth" on productos_fudo for select to authenticated using (true);

-- Porciones que trae un combo/promo, a partir de su nombre ("2 Cheese Slice + Coca" = 2; "1 Cheese Slice + 1 Vodka Slice + Coca" = 2).
-- Si el nombre dice grande/molde/precocida/plus es pizza entera (0 porciones).
create or replace function promo_porciones(n text) returns numeric
language sql immutable as $$
  select case when n ~* 'grande|molde|precocida|plus' then 0
    else coalesce((
      select sum(coalesce(nullif(substring(seg from '^\s*(\d+)'), '')::numeric, 1))
      from regexp_split_to_table(n, '\s*\+\s*') as seg
      where seg ~* 'slice|porci|\mxl\M|\mny\M'
    ), 0) end
$$;

-- Cada item vendido, con su rubro, porciones y pizzas enteras (una mitad cuenta 0,5)
create or replace view v_items_clasif as
with b as (
  select v.fudo_sale_id, v.fecha, v.producto_id, v.producto_nombre, v.cantidad, v.total,
         coalesce(p.categoria, 'Sin categoría') as categoria,
         case
           when p.categoria ilike '%porci%' then 'Porción'
           when p.categoria ilike 'NY Grande%' then 'NY Grande'
           when p.categoria ilike '%molde%' then 'Molde'
           when p.categoria ilike '%media masa%' then 'Media masa'
           when p.categoria ilike '%bebida%' then 'Bebida'
           when p.categoria ilike '%dip%' then 'Dip'
           when p.categoria ilike '%packaging%' then 'Packaging'
           when p.categoria ilike 'promos%' or p.categoria ilike 'pedidos ya%' then 'Promo'
           else 'Otro'
         end as rubro
  from ventas_fudo_items v
  left join productos_fudo p on p.producto_id = v.producto_id
)
select b.*,
  case b.rubro
    when 'Porción' then b.cantidad
    when 'Promo' then b.cantidad * promo_porciones(b.producto_nombre)
    else 0 end as porciones,
  case b.rubro
    when 'NY Grande' then b.cantidad * (case when b.producto_nombre ilike 'mitad%' then 0.5 else 1 end)
    when 'Molde' then b.cantidad
    when 'Media masa' then b.cantidad
    when 'Promo' then b.cantidad * (case when b.producto_nombre ~* 'grande|molde|precocida|plus' then 1 else 0 end)
    else 0 end as pizzas
from b;

-- Cajas por venta según la regla del local:
--   pizza entera (NY Grande, molde, media masa) = 1 caja grande por pizza (2 mitades = 1);
--   porciones sueltas: 1 o 2 -> 1 caja chica, 3 o más -> 1 caja grande; salón no usa caja.
-- Se compara contra las "Caja chica"/"Caja grande" que se cargaron realmente en FUDO.
create or replace view v_ventas_cajas as
with it as (
  select fudo_sale_id,
         sum(porciones) as porc, sum(pizzas) as pizzas,
         sum(case when producto_nombre ilike 'caja chica%' then cantidad else 0 end) as chica_cargada,
         sum(case when producto_nombre ilike 'caja grande%' then cantidad else 0 end) as grande_cargada
  from v_items_clasif group by 1
)
select s.fudo_sale_id, s.fecha, s.tipo, s.cerrada_at, s.total,
       extract(hour from s.cerrada_at at time zone 'America/Argentina/Tucuman')::int as hora,
       extract(isodow from s.cerrada_at at time zone 'America/Argentina/Tucuman')::int as dow,
       coalesce(it.porc, 0) as porciones,
       coalesce(it.pizzas, 0) as pizzas,
       case when s.tipo = 'EAT-IN' then 0
            else ceil(coalesce(it.pizzas, 0))::int + case when coalesce(it.porc, 0) >= 3 then 1 else 0 end
       end as cajas_grande_est,
       case when s.tipo = 'EAT-IN' then 0
            when coalesce(it.porc, 0) between 1 and 2 then 1 else 0
       end as cajas_chica_est,
       coalesce(it.grande_cargada, 0) as cajas_grande_cargadas,
       coalesce(it.chica_cargada, 0) as cajas_chica_cargadas
from ventas_fudo s
left join it on it.fudo_sale_id = s.fudo_sale_id;

-- Consumo teórico: igual que antes, pero el packaging (caja y fólex) se calcula con las cajas
-- ESTIMADAS por la regla, porque en FUDO casi no se cargan "Caja chica/grande" en las ventas.
create or replace view v_consumo_teorico as
select mes, insumo_id, sum(c) as cantidad_teorica
from (
  select date_trunc('month', v.fecha)::date as mes, r.insumo_id, v.cantidad * r.cantidad as c
  from ventas_fudo_items v
  join recetas r on r.producto_fudo_id = v.producto_id
  where v.producto_id not in (select producto_id from productos_fudo where categoria ilike '%packaging%')
  union all
  select date_trunc('month', c.fecha)::date, r.insumo_id, c.cajas_chica_est * r.cantidad
  from v_ventas_cajas c
  join productos_fudo p on p.nombre ilike 'caja chica%'
  join recetas r on r.producto_fudo_id = p.producto_id
  union all
  select date_trunc('month', c.fecha)::date, r.insumo_id, c.cajas_grande_est * r.cantidad
  from v_ventas_cajas c
  join productos_fudo p on p.nombre ilike 'caja grande%'
  join recetas r on r.producto_fudo_id = p.producto_id
) x
group by 1, 2;

-- Panel de ventas: todo el cálculo en la base (las tablas son grandes para traerlas al navegador)
-- p_modo: null = todos | 'DELIVERY' | 'TAKEAWAY' | 'EAT-IN'.  Las tarjetas por modo ignoran el filtro.
create or replace function ventas_panel(p_desde date, p_hasta date, p_modo text default null)
returns jsonb language sql stable security invoker as $$
with s as (select * from v_ventas_cajas where fecha between p_desde and p_hasta),
     sm as (select * from s where p_modo is null or tipo = p_modo),
     it as (
       select i.*, sv.tipo
       from v_items_clasif i join ventas_fudo sv on sv.fudo_sale_id = i.fudo_sale_id
       where i.fecha between p_desde and p_hasta and (p_modo is null or sv.tipo = p_modo)
     )
select jsonb_build_object(
  'por_modo', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select tipo, count(*) as ventas, sum(total) as monto, round(avg(total)) as ticket
      from s group by tipo order by sum(total) desc) x),
  'por_rubro', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select rubro, sum(cantidad) as unidades, sum(total) as monto
      from it where rubro <> 'Packaging' group by rubro order by sum(total) desc) x),
  'productos', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select producto_nombre as producto, rubro, sum(cantidad) as unidades, sum(total) as monto
      from it where rubro <> 'Packaging' group by producto_nombre, rubro
      order by sum(cantidad) desc limit 30) x),
  'por_dia', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select dow, count(*) as ventas, sum(total) as monto from sm group by dow order by dow) x),
  'por_franja', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select case when hora between 11 and 14 then '1 · Mediodía (11 a 15)'
                  when hora between 15 and 18 then '2 · Tarde (15 a 19)'
                  when hora between 19 and 23 then '3 · Noche (19 a 24)'
                  else '4 · Otro horario' end as franja,
             count(*) as ventas, sum(total) as monto
      from sm group by 1 order by 1) x),
  'cajas', (select jsonb_build_object(
      'grande_est', coalesce(sum(cajas_grande_est), 0), 'chica_est', coalesce(sum(cajas_chica_est), 0),
      'grande_cargadas', coalesce(sum(cajas_grande_cargadas), 0), 'chica_cargadas', coalesce(sum(cajas_chica_cargadas), 0))
      from sm),
  'cajas_modo', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select tipo, sum(cajas_grande_est) as grande, sum(cajas_chica_est) as chica
      from s group by tipo order by tipo) x),
  'dias', (select count(distinct fecha) from sm)
);
$$;
revoke execute on function ventas_panel(date, date, text) from public, anon;
grant execute on function ventas_panel(date, date, text) to authenticated;

alter view v_items_clasif set (security_invoker = true);
alter view v_ventas_cajas set (security_invoker = true);
alter view v_consumo_teorico set (security_invoker = true);
