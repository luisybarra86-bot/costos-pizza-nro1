-- Ejecutar en Supabase SQL Editor (idempotente) DESPUÉS de supabase-stock.sql.
-- Pestaña Recetas: qué productos vendidos tienen receta y cuáles no, y qué insumos preparados no tienen receta propia.
--
-- Productos vendidos:
--   con_receta  -> la receta de FUDO descuenta insumos en cada venta (y el proyecto calcula su consumo)
--   directa     -> bebidas: se compran y se venden como el mismo producto, no necesitan receta
--   sin_receta  -> no descuenta ningún insumo (combos, promos u otros): su consumo no se cuenta
-- Insumos usados en recetas:
--   comprado              -> tiene precio (facturas o costo de FUDO)
--   con_receta_propia     -> se prepara en el local y FUDO tiene su receta (cuánto lleva de cada materia prima)
--   preparado_sin_receta  -> se prepara en el local (no se compra ni tiene costo) y no tiene receta propia:
--                            el consumo de sus materias primas (harina, levadura, tomate...) no se refleja

alter table insumos add column if not exists receta_propia boolean not null default false;

create or replace view v_recetas_productos as
with r as (
  select producto_fudo_id, count(*) as ingredientes from recetas group by 1
), v as (
  select producto_id, sum(cantidad) as unidades, sum(total) as monto
  from ventas_fudo_items
  where fecha >= (now() at time zone 'America/Argentina/Tucuman')::date - 30
  group by 1
)
select p.producto_id, p.nombre, coalesce(p.categoria, 'Sin categoría') as categoria,
       coalesce(r.ingredientes, 0)::int as ingredientes,
       coalesce(v.unidades, 0) as unidades_30d,
       coalesce(v.monto, 0) as monto_30d,
       case when p.categoria ilike '%bebida%' then 'directa'
            when r.ingredientes > 0 then 'con_receta'
            else 'sin_receta' end as estado,
       case when p.categoria ilike 'promos%' or p.categoria ilike 'pedidos ya%' then promo_porciones(p.nombre) end as porciones_nombre
from productos_fudo p
left join r on r.producto_fudo_id = p.producto_id
left join v on v.producto_id = p.producto_id
where coalesce(v.unidades, 0) > 0 or r.ingredientes > 0;
alter view v_recetas_productos set (security_invoker = true);

create or replace view v_recetas_insumos as
with u as (
  select insumo_id, count(distinct producto_fudo_id) as productos from recetas group by 1
), c as (
  select insumo_id, sum(cantidad) as consumo
  from v_consumo_diario
  where fecha >= (now() at time zone 'America/Argentina/Tucuman')::date - 30
  group by 1
)
select i.id as insumo_id, i.nombre, i.unidad, u.productos::int as productos,
       coalesce(c.consumo, 0) as consumo_30d,
       exists (select 1 from v_historial_precios h where h.insumo_id = i.id) as tiene_precio,
       i.receta_propia,
       case when i.receta_propia then 'con_receta_propia'
            when exists (select 1 from v_historial_precios h where h.insumo_id = i.id) then 'comprado'
            else 'preparado_sin_receta' end as estado
from insumos i
join u on u.insumo_id = i.id
left join c on c.insumo_id = i.id;
alter view v_recetas_insumos set (security_invoker = true);
