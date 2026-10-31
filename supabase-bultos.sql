-- Ejecutar en Supabase SQL Editor (idempotente) DESPUÉS de supabase-precios-compra.sql.
-- Normaliza las compras de bebidas a UNIDADES (botellas), sabiendo cuántas trae cada bulto (cajón / fardo).
--
-- En las facturas la cantidad a veces se cargó en bultos (1 = un cajón) y a veces en unidades (72 botellas).
-- Para cada producto con bulto se toma como referencia el precio por unidad de la última compra cargada en
-- unidades (cantidad >= unidades por bulto); si no hay, la mediana de precio/bulto. Cada línea se interpreta así:
--   precio entre 0,5x y 1,6x de la referencia            -> la cantidad está en unidades
--   precio entre 0,6x y 1,6x de (referencia x unidades)  -> la cantidad está en bultos (se multiplica)
--   cualquier otro caso                                   -> línea dudosa: no entra en precios ni variación
-- Para cambiar las unidades por bulto de un producto: editar la tabla producto_bulto y volver a correr este script.

create table if not exists producto_bulto (
  fudo_product_id text primary key references compra_productos(fudo_product_id) on delete cascade,
  unidades numeric(10,2) not null check (unidades > 0),
  nota text
);
alter table producto_bulto enable row level security;
drop policy if exists "producto_bulto_auth" on producto_bulto;
create policy "producto_bulto_auth" on producto_bulto for select to authenticated using (true);

insert into producto_bulto (fudo_product_id, unidades, nota)
select p.fudo_product_id, v.u, v.nota
from (values
  ('Coca-Cola Vidrio 350cc',          24, 'cajón x24'),
  ('Coca-Cola Zero Vidrio 350cc',     24, 'cajón x24'),
  ('Fanta Vidrio 350cc',              24, 'cajón x24'),
  ('Sprite Vidrio 350cc',             24, 'cajón x24'),
  ('Coca-Cola PET 375cc',             12, 'descartable x12'),
  ('Coca-Cola Zero PET 375cc',         6, 'descartable x6'),
  ('Coca-Cola PET 600ml',              6, 'descartable x6'),
  ('Fanta PET 375cc',                  6, 'descartable x6'),
  ('Fanta PET 500ml',                  6, 'descartable x6'),
  ('Sprite PET 375cc',                 6, 'descartable x6'),
  ('Sprite PET 600ml',                 6, 'descartable x6'),
  ('Agua Benedictino Vidrio 500cc',   15, 'cajón x15'),
  ('Agua Benedictino PET 500cc',      12, 'descartable x12'),
  ('Soda Benedictino Vidrio 500cc',   15, 'cajón x15'),
  ('Estrella Galicia Lata 473cc',      6, 'fardo x6'),
  ('Estrella Galicia Porroncito 355cc', 6, 'fardo x6'),
  ('Heineken Porroncito 330cc',       24, 'fardo x24'),
  ('Heineken Lata 473cc',             24, 'fardo x24')
) as v(nombre, u, nota)
join compra_productos p on lower(p.producto_nombre) = lower(v.nombre)
on conflict (fudo_product_id) do update set unidades = excluded.unidades, nota = excluded.nota;

-- Cada línea de compra con su cantidad llevada a unidades (null = línea dudosa)
create or replace view v_compras_norm as
with base as (
  select c.fudo_item_id, c.fudo_product_id, c.producto_nombre, c.proveedor, c.fecha, c.created_at,
         c.cantidad, c.total, c.total / c.cantidad as p, b.unidades as n
  from compras_fudo_items c
  left join producto_bulto b on b.fudo_product_id = c.fudo_product_id
  where c.cantidad > 0 and c.total > 0
), ref as (
  select r.fudo_product_id,
         coalesce(
           (select x.p from base x
            where x.fudo_product_id = r.fudo_product_id and x.cantidad >= x.n
            order by x.fecha desc, x.created_at desc, x.fudo_item_id desc limit 1),
           (select percentile_cont(0.5) within group (order by y.p / y.n) from base y
            where y.fudo_product_id = r.fudo_product_id and y.cantidad < y.n)
         ) as ref_unit
  from (select distinct fudo_product_id from base where n is not null) r
)
select b.fudo_item_id, b.fudo_product_id, b.producto_nombre, b.proveedor, b.fecha, b.created_at,
       b.cantidad as cantidad_cargada, b.total, b.n as unidades_por_bulto,
       case
         when b.n is null then b.cantidad
         when r.ref_unit is null then null
         when b.p between r.ref_unit * 0.5 and r.ref_unit * 1.6 then b.cantidad
         when b.p between r.ref_unit * b.n * 0.6 and r.ref_unit * b.n * 1.6 then b.cantidad * b.n
         else null
       end as unidades
from base b
left join ref r on r.fudo_product_id = b.fudo_product_id;
alter view v_compras_norm set (security_invoker = true);

-- Precios de compra por producto (reemplaza la versión anterior; usa las cantidades normalizadas)
drop view if exists v_precios_compra_producto;
create view v_precios_compra_producto as
with l as (
  select fudo_product_id, proveedor, fecha, unidades as cantidad, total, total / unidades as precio_unit,
         row_number() over (partition by fudo_product_id order by fecha desc, created_at desc, fudo_item_id desc) as rn,
         count(*) over (partition by fudo_product_id) as validas
  from v_compras_norm
  where unidades > 0
), d as (
  select fudo_product_id, count(*) as n from v_compras_norm where unidades is null group by 1
), u as (
  select distinct on (fudo_product_id) fudo_product_id, producto_nombre, proveedor
  from compras_fudo_items
  order by fudo_product_id, fecha desc, created_at desc
)
select u.fudo_product_id, u.producto_nombre, coalesce(a.proveedor, u.proveedor) as proveedor,
       a.fecha, a.cantidad, a.total,
       a.precio_unit::numeric(14,2) as precio_unit,
       b.fecha as fecha_anterior,
       b.precio_unit::numeric(14,2) as precio_anterior,
       case when a.precio_unit / b.precio_unit between 0.33 and 3
            then round((a.precio_unit - b.precio_unit) / b.precio_unit * 100, 1) end as variacion_pct,
       (b.precio_unit is not null and a.precio_unit / b.precio_unit not between 0.33 and 3) as cambio_unidad,
       coalesce(a.validas, 0)::int as compras,
       p.insumo_id,
       coalesce(d.n, 0)::int as lineas_dudosas,
       pb.unidades as unidades_por_bulto
from u
left join l a on a.fudo_product_id = u.fudo_product_id and a.rn = 1
left join l b on b.fudo_product_id = u.fudo_product_id and b.rn = 2
left join d on d.fudo_product_id = u.fudo_product_id
left join compra_productos p on p.fudo_product_id = u.fudo_product_id
left join producto_bulto pb on pb.fudo_product_id = u.fudo_product_id;
alter view v_precios_compra_producto set (security_invoker = true);
