-- Ejecutar en Supabase SQL Editor (idempotente). Precios de compra por PRODUCTO comprado (bebidas, limpieza,
-- descartables, etc.), tal como se cargan las facturas en FUDO, sin necesidad de asociarlos a un insumo.
--
-- precio_unit = total de la línea / cantidad, en la unidad en que se cargó la cantidad.
-- Ojo: si una vez se cargó "1" (un cajón) y otra "72" (botellas), el precio unitario no es comparable.
-- Por eso la variación % solo se calcula cuando las dos compras tienen una escala de precio parecida.

create or replace view v_precios_compra_producto as
with l as (
  select fudo_product_id, producto_nombre, proveedor, fecha, cantidad, total,
         total / cantidad as precio_unit,
         row_number() over (partition by fudo_product_id order by fecha desc, created_at desc, fudo_item_id desc) as rn,
         count(*) over (partition by fudo_product_id) as compras
  from compras_fudo_items
  where cantidad > 0 and total > 0
)
select a.fudo_product_id, a.producto_nombre, a.proveedor, a.fecha, a.cantidad, a.total,
       a.precio_unit::numeric(14,2) as precio_unit,
       b.fecha as fecha_anterior,
       b.precio_unit::numeric(14,2) as precio_anterior,
       case when a.precio_unit / b.precio_unit between 0.33 and 3
            then round((a.precio_unit - b.precio_unit) / b.precio_unit * 100, 1) end as variacion_pct,
       (b.precio_unit is not null and a.precio_unit / b.precio_unit not between 0.33 and 3) as cambio_unidad,
       a.compras::int as compras,
       p.insumo_id
from l a
left join l b on b.fudo_product_id = a.fudo_product_id and b.rn = 2
left join compra_productos p on p.fudo_product_id = a.fudo_product_id
where a.rn = 1;
alter view v_precios_compra_producto set (security_invoker = true);
