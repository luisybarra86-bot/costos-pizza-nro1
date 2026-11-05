-- Ejecutar en Supabase SQL Editor (idempotente) DESPUÉS de supabase-revisiones.sql.
-- Pestaña Stock: foto diaria del stock de FUDO + stock estimado del proyecto + conteos detectados.
--
-- Cómo funciona:
--  * La sync guarda cada día el stock de FUDO de los insumos y de las bebidas con control de stock (stock_snapshots).
--  * Insumos: en FUDO el stock solo BAJA con las ventas (las facturas se cargan contra productos de compra, no contra
--    insumos). El proyecto calcula un stock ESTIMADO = stock del último conteo + compras asociadas al insumo
--    - consumo teórico (ventas x recetas). Hasta el primer conteo detectado, parte de la primera foto.
--  * Bebidas: se compran y se venden como el mismo producto, así que el stock de FUDO ya es correcto.
--  * Conteo detectado: un cambio de stock entre dos fotos que no se explica por las ventas ni por las compras
--    cargadas en FUDO. La diferencia es lo que apareció o faltó al contar (merma o error de carga).

create table if not exists stock_snapshots (
  fecha date not null,                         -- día argentino de la foto
  tipo text not null check (tipo in ('insumo', 'producto')),
  item_id text not null,                       -- id de FUDO (ingrediente o producto)
  nombre text not null,
  categoria text,                              -- categoría de FUDO (productos)
  unidad text,
  stock numeric(14,4),
  stock_minimo numeric(14,4),
  primary key (fecha, tipo, item_id)
);
alter table stock_snapshots enable row level security;
drop policy if exists "stock_snapshots_auth" on stock_snapshots;
create policy "stock_snapshots_auth" on stock_snapshots for select to authenticated using (true);

-- Lo que FUDO descuenta por las ventas (receta de cada producto, incluidas las cajas que sí se cargaron)
create or replace view v_consumo_fudo_diario as
select v.fecha, r.insumo_id, sum(v.cantidad * r.cantidad) as cantidad
from ventas_fudo_items v
join recetas r on r.producto_fudo_id = v.producto_id
group by 1, 2;
alter view v_consumo_fudo_diario set (security_invoker = true);

-- Consumo teórico del proyecto por día (las cajas y el fólex se calculan con las cajas estimadas)
create or replace view v_consumo_diario as
select fecha, insumo_id, sum(c) as cantidad
from (
  select v.fecha, r.insumo_id, v.cantidad * r.cantidad as c
  from ventas_fudo_items v
  join recetas r on r.producto_fudo_id = v.producto_id
  where v.producto_id not in (select producto_id from productos_fudo where categoria ilike '%packaging%')
  union all
  select c.fecha, r.insumo_id, c.cajas_chica_est * r.cantidad
  from v_ventas_cajas c
  join productos_fudo p on p.nombre ilike 'caja chica%'
  join recetas r on r.producto_fudo_id = p.producto_id
  union all
  select c.fecha, r.insumo_id, c.cajas_grande_est * r.cantidad
  from v_ventas_cajas c
  join productos_fudo p on p.nombre ilike 'caja grande%'
  join recetas r on r.producto_fudo_id = p.producto_id
) x
group by 1, 2;
alter view v_consumo_diario set (security_invoker = true);

-- Unidades vendidas por producto y día (bebidas)
create or replace view v_ventas_producto_diario as
select fecha, producto_id, sum(cantidad) as cantidad
from ventas_fudo_items
group by 1, 2;
alter view v_ventas_producto_diario set (security_invoker = true);

-- Compras que suman stock en FUDO: las cargadas contra un insumo (ING-) o contra el mismo producto (bebidas).
-- Se toma el día en que la sync vio la línea por primera vez, que es cuando aparece en el stock de FUDO.
create or replace view v_compras_fudo_stock as
select (created_at at time zone 'America/Argentina/Tucuman')::date as fecha_carga,
       case when fudo_product_id like 'ING-%' then 'insumo' else 'producto' end as tipo,
       case when fudo_product_id like 'ING-%' then substr(fudo_product_id, 5) else fudo_product_id end as item_id,
       cantidad
from compras_fudo_items;
alter view v_compras_fudo_stock set (security_invoker = true);

-- Cada foto contra la anterior: qué stock se esperaba (anterior - ventas + compras cargadas) y cuál apareció
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
)
select fecha, tipo, item_id, nombre, categoria, unidad, stock_ant, consumo, compras,
       (stock_ant - consumo + compras) as stock_esperado,
       stock as stock_contado,
       stock - (stock_ant - consumo + compras) as diferencia
from e;
alter view v_stock_ajustes set (security_invoker = true);

-- Estado de cada insumo y bebida con control de stock (lo que muestra la pestaña)
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
  where abs(diferencia) >= greatest(0.5, 0.05 * consumo)
  order by tipo, item_id, fecha desc
), b as (
  select u.tipo, u.item_id, u.nombre, u.unidad, u.stock as stock_fudo, u.stock_minimo,
         coalesce(c.fecha_conteo, p.fecha0) as fecha_base,
         coalesce(c.stock_contado, p.stock0) as stock_base,
         c.fecha_conteo, i.id as insumo_id
  from ult u
  left join prim p on p.tipo = u.tipo and p.item_id = u.item_id
  left join cont c on c.tipo = u.tipo and c.item_id = u.item_id
  left join insumos i on u.tipo = 'insumo' and i.fudo_ingredient_id = u.item_id
  where u.tipo = 'insumo' or u.categoria ilike 'bebida%'
), m as (
  select b.*,
    case b.tipo
      when 'insumo' then (select coalesce(sum(x.cantidad), 0) from v_consumo_diario x
                          where x.insumo_id = b.insumo_id and x.fecha >= (now() at time zone 'America/Argentina/Tucuman')::date - 30) / 30.0
      else (select coalesce(sum(x.cantidad), 0) from v_ventas_producto_diario x
            where x.producto_id = b.item_id and x.fecha >= (now() at time zone 'America/Argentina/Tucuman')::date - 30) / 30.0
    end as consumo_diario,
    case b.tipo
      when 'insumo' then
        b.stock_base
        + (select coalesce(sum(k.cantidad), 0) from v_compras_insumo k where k.insumo_id = b.insumo_id and k.fecha >= b.fecha_base)
        - (select coalesce(sum(x.cantidad), 0) from v_consumo_diario x where x.insumo_id = b.insumo_id and x.fecha >= b.fecha_base)
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

-- Conteos detectados (diferencias que no explican ni las ventas ni las compras cargadas), con su precio para valuarlas
create or replace view v_stock_diferencias as
select a.fecha, case a.tipo when 'insumo' then 'insumo' else 'bebida' end as tipo, a.item_id, a.nombre, a.unidad,
       a.stock_esperado, a.stock_contado, a.diferencia,
       case a.tipo
         when 'insumo' then (select p.precio_actual from v_variacion_precios p
                             join insumos i on i.id = p.insumo_id where i.fudo_ingredient_id = a.item_id)
         else (select p.precio_unit from v_precios_compra_producto p where p.fudo_product_id = a.item_id)
       end as precio
from v_stock_ajustes a
where abs(a.diferencia) >= greatest(0.5, 0.05 * a.consumo)
  and (a.tipo = 'insumo' or a.categoria ilike 'bebida%');
alter view v_stock_diferencias set (security_invoker = true);
