-- Ejecutar en Supabase SQL Editor (idempotente) DESPUÉS de supabase-recetas.sql y ANTES de redesplegar la función.
-- Insumos preparados (masas, salsas, pizzas XL): FUDO les calcula el costo desde su receta y descuenta sus materias
-- primas al vender, pero la API no muestra qué lleva cada uno. Este script:
--  1) guarda ese costo calculado y lo toma como precio del insumo (fuente "receta");
--  2) cambia el stock estimado: stock de FUDO + compras que FUDO no conoce (las cargadas contra productos de compra),
--     porque FUDO ya descuenta todo el consumo, incluido el que pasa por masas y salsas;
--  3) usa el consumo observado en las fotos de stock para calcular "para cuántos días alcanza";
--  4) ajusta la detección de conteos para insumos que se consumen a través de preparados.

alter table insumos add column if not exists costo_calculado numeric(14,4);

-- Último costo de FUDO guardado por insumo: ahora incluye el calculado por receta
create or replace view v_costo_fudo_actual as
select distinct on (insumo_id) insumo_id, precio, fecha
from precios_insumo
where fuente in ('fudo', 'receta')
order by insumo_id, fecha desc, created_at desc;
alter view v_costo_fudo_actual set (security_invoker = true);

-- Compras por insumo: se agrega el producto de compra (para separar las cargadas contra un insumo, que sí suman stock en FUDO)
create or replace view v_compras_insumo as
select c.fecha, date_trunc('month', c.fecha)::date as mes, p.insumo_id, i.nombre, i.unidad,
       c.cantidad * p.factor as cantidad, c.total,
       c.total / nullif(c.cantidad * p.factor, 0) as precio_unit,
       c.proveedor, c.producto_nombre,
       c.fudo_product_id
from compras_fudo_items c
join compra_productos p on p.fudo_product_id = c.fudo_product_id and p.insumo_id is not null and not p.ignorar
join insumos i on i.id = p.insumo_id;
alter view v_compras_insumo set (security_invoker = true);

-- Cada foto de stock contra la anterior (igual que antes) + si el insumo se consume a través de preparados (cascada)
-- y si la diferencia cuenta como conteo.
create or replace view v_stock_ajustes as
with s as (
  select tipo, item_id, nombre, categoria, unidad, fecha, stock,
         lag(stock) over w as stock_ant, lag(fecha) over w as fecha_ant
  from stock_snapshots
  where stock is not null
  window w as (partition by tipo, item_id order by fecha)
), e as (
  select s.*,
    case s.tipo
      when 'insumo' then coalesce((
        select sum(c.cantidad) from v_consumo_fudo_diario c
        join insumos i on i.id = c.insumo_id
        where i.fudo_ingredient_id = s.item_id and c.fecha >= s.fecha_ant and c.fecha < s.fecha), 0)
      else coalesce((
        select sum(v.cantidad) from v_ventas_producto_diario v
        where v.producto_id = s.item_id and v.fecha >= s.fecha_ant and v.fecha < s.fecha), 0)
    end as consumo,
    coalesce((
      select sum(k.cantidad) from v_compras_fudo_stock k
      where k.tipo = s.tipo and k.item_id = s.item_id and k.fecha_carga > s.fecha_ant and k.fecha_carga <= s.fecha), 0) as compras
  from s
  where s.stock_ant is not null
), c as (
  -- cascada: FUDO baja el stock bastante más de lo que explican las recetas directas (el insumo va dentro de masas o salsas)
  select tipo, item_id,
         (sum(greatest(stock_ant - stock, 0)) > 1.5 * sum(consumo) + 1) as cascada
  from e
  group by 1, 2
)
select e.fecha, e.tipo, e.item_id, e.nombre, e.categoria, e.unidad, e.stock_ant, e.consumo, e.compras,
       (e.stock_ant - e.consumo + e.compras) as stock_esperado,
       e.stock as stock_contado,
       e.stock - (e.stock_ant - e.consumo + e.compras) as diferencia,
       c.cascada,
       case
         -- en cascada la baja diaria es normal: solo cuentan los saltos hacia arriba o bajas muy grandes
         when c.cascada and e.tipo = 'insumo' then
              (e.stock - (e.stock_ant - e.consumo + e.compras)) >= greatest(0.5, 0.05 * e.consumo)
           or (e.stock - (e.stock_ant - e.consumo + e.compras)) <= -greatest(0.5, 0.05 * e.consumo, 0.5 * abs(e.stock_ant))
         else abs(e.stock - (e.stock_ant - e.consumo + e.compras)) >= greatest(0.5, 0.05 * e.consumo)
       end as es_conteo
from e
join c on c.tipo = e.tipo and c.item_id = e.item_id;
alter view v_stock_ajustes set (security_invoker = true);

-- Estado de cada insumo y bebida (lo que muestra la pestaña Stock)
create or replace view v_stock_panel as
with ult as (
  select distinct on (tipo, item_id) tipo, item_id, nombre, categoria, unidad, stock, stock_minimo
  from stock_snapshots
  order by tipo, item_id, fecha desc
), prim as (
  select distinct on (tipo, item_id) tipo, item_id, fecha as fecha0, stock as stock0
  from stock_snapshots
  where stock is not null
  order by tipo, item_id, fecha
), cont as (
  select distinct on (tipo, item_id) tipo, item_id, fecha as fecha_conteo, stock_contado
  from v_stock_ajustes
  where es_conteo
  order by tipo, item_id, fecha desc
), obs as (
  -- consumo observado: cuánto bajó el stock de FUDO por día en las últimas dos semanas
  select tipo, item_id,
         sum(greatest(stock_ant - stock, 0)) / nullif((max(fecha) - min(fecha_ant))::numeric, 0) as consumo_obs
  from (
    select tipo, item_id, fecha, stock, lag(stock) over w as stock_ant, lag(fecha) over w as fecha_ant
    from stock_snapshots
    where stock is not null and fecha >= (now() at time zone 'America/Argentina/Tucuman')::date - 14
    window w as (partition by tipo, item_id order by fecha)
  ) z
  where stock_ant is not null
  group by 1, 2
), b as (
  select u.tipo, u.item_id, u.nombre, u.unidad, u.stock as stock_fudo, u.stock_minimo,
         coalesce(c.fecha_conteo, p.fecha0) as fecha_base,
         c.fecha_conteo, i.id as insumo_id, o.consumo_obs
  from ult u
  left join prim p on p.tipo = u.tipo and p.item_id = u.item_id
  left join cont c on c.tipo = u.tipo and c.item_id = u.item_id
  left join obs o on o.tipo = u.tipo and o.item_id = u.item_id
  left join insumos i on u.tipo = 'insumo' and i.fudo_ingredient_id = u.item_id
  where u.tipo = 'insumo' or u.categoria ilike 'bebida%'
), m as (
  select b.*,
    case b.tipo
      when 'insumo' then greatest(
        (select coalesce(sum(x.cantidad), 0) from v_consumo_diario x
         where x.insumo_id = b.insumo_id and x.fecha >= (now() at time zone 'America/Argentina/Tucuman')::date - 30) / 30.0,
        coalesce(b.consumo_obs, 0))
      else (select coalesce(sum(x.cantidad), 0) from v_ventas_producto_diario x
            where x.producto_id = b.item_id and x.fecha >= (now() at time zone 'America/Argentina/Tucuman')::date - 30) / 30.0
    end as consumo_diario,
    case b.tipo
      -- FUDO ya descuenta todo el consumo (también el que pasa por masas y salsas); se suman las compras que FUDO no conoce:
      -- las cargadas contra productos de compra (las cargadas contra el propio insumo, ING-, FUDO ya las sumó)
      when 'insumo' then b.stock_fudo + (
        select coalesce(sum(k.cantidad), 0) from v_compras_insumo k
        where k.insumo_id = b.insumo_id and k.fecha >= b.fecha_base and k.fudo_product_id not like 'ING-%')
      else b.stock_fudo
    end as stock_estimado,
    case b.tipo
      when 'insumo' then (select p.precio_actual from v_variacion_precios p where p.insumo_id = b.insumo_id)
      else (select p.precio_unit from v_precios_compra_producto p where p.fudo_product_id = b.item_id)
    end as precio
  from b
)
select case tipo when 'insumo' then 'insumo' else 'bebida' end as tipo,
       item_id, nombre, unidad, stock_fudo, stock_minimo, stock_estimado,
       fecha_conteo, (fecha_conteo is not null) as contado,
       round(consumo_diario, 3) as consumo_diario,
       case when stock_estimado > 0 and consumo_diario > 0 then round(stock_estimado / consumo_diario, 1) end as dias_cobertura,
       case when stock_estimado is not null then greatest(0, round(7 * consumo_diario - greatest(stock_estimado, 0), 2)) end as comprar_7d,
       precio,
       round(precio * greatest(stock_estimado, 0), 2) as valor,
       case when stock_estimado is null then 'sin_contar'
            when stock_estimado < 0 then 'negativo'
            when stock_minimo is not null and stock_estimado < stock_minimo then 'bajo_minimo'
            when consumo_diario > 0 and stock_estimado / consumo_diario < 3 then 'por_acabarse'
            else 'ok' end as estado
from m;
alter view v_stock_panel set (security_invoker = true);

-- Conteos detectados
create or replace view v_stock_diferencias as
select a.fecha, case a.tipo when 'insumo' then 'insumo' else 'bebida' end as tipo, a.item_id, a.nombre, a.unidad,
       a.stock_esperado, a.stock_contado, a.diferencia,
       case a.tipo
         when 'insumo' then (select p.precio_actual from v_variacion_precios p
                             join insumos i on i.id = p.insumo_id where i.fudo_ingredient_id = a.item_id)
         else (select p.precio_unit from v_precios_compra_producto p where p.fudo_product_id = a.item_id)
       end as precio
from v_stock_ajustes a
where a.es_conteo
  and (a.tipo = 'insumo' or a.categoria ilike 'bebida%');
alter view v_stock_diferencias set (security_invoker = true);

-- Insumos usados en recetas de venta: se agrega el costo calculado por FUDO
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
            else 'preparado_sin_receta' end as estado,
       i.costo_calculado
from insumos i
join u on u.insumo_id = i.id
left join c on c.insumo_id = i.id;
alter view v_recetas_insumos set (security_invoker = true);
