-- Ejecutar en Supabase SQL Editor (idempotente) DESPUÉS de supabase-compras.sql.
-- Los precios de los insumos pasan a salir de las FACTURAS de compra (precio neto real pagado).
-- Si un insumo no tiene facturas asociadas, se usa el costo que tiene cargado FUDO.
-- Esto también cambia el costo teórico: ahora se valúa con el último precio de factura.

-- Un punto por insumo y día de factura: total neto / cantidad (en la unidad del insumo)
create or replace view v_historial_precios as
select f.insumo_id, f.fecha, f.precio::numeric(14,2) as precio, 'factura'::text as fuente
from (
  select insumo_id, fecha, sum(total) / nullif(sum(cantidad), 0) as precio
  from v_compras_insumo
  group by insumo_id, fecha
) f
where f.precio > 0
union all
select p.insumo_id, p.fecha, p.precio, 'fudo'::text
from precios_insumo p
where not exists (select 1 from v_compras_insumo c where c.insumo_id = p.insumo_id);
alter view v_historial_precios set (security_invoker = true);

-- Último precio, anterior y variación % (mismas columnas de siempre + fuente al final)
create or replace view v_variacion_precios as
with r as (
  select insumo_id, precio, fecha, fuente,
         row_number() over (partition by insumo_id order by fecha desc) rn
  from v_historial_precios
)
select i.id as insumo_id, i.nombre, i.unidad, i.categoria,
       a.precio as precio_actual, a.fecha as fecha_actual,
       b.precio as precio_anterior, b.fecha as fecha_anterior,
       round((a.precio - b.precio) / nullif(b.precio, 0) * 100, 1) as variacion_pct,
       a.fuente
from insumos i
join r a on a.insumo_id = i.id and a.rn = 1
left join r b on b.insumo_id = i.id and b.rn = 2;
alter view v_variacion_precios set (security_invoker = true);

-- Alerta "sin costo": insumos de recetas que no tienen ni factura ni costo en FUDO
create or replace view v_alertas_insumos as
select i.id as insumo_id, i.nombre, i.unidad, 'stock_negativo'::text as tipo, i.stock_fudo as valor
from insumos i where i.stock_control and i.stock_fudo < 0
union all
select i.id, i.nombre, i.unidad, 'sin_costo', null
from insumos i
where exists (select 1 from recetas r where r.insumo_id = i.id)
  and not exists (select 1 from v_historial_precios h where h.insumo_id = i.id);
alter view v_alertas_insumos set (security_invoker = true);
