-- Ejecutar en Supabase SQL Editor (idempotente). Compras automáticas desde FUDO.
-- FUDO carga las compras contra "productos de compra" (ej: "Cebolla kg"); acá se asocian a su insumo
-- con un factor: factor = cantidad de unidad del insumo que trae 1 unidad comprada.
--   ej: "Harina Campodonico Fuerza 25 kg" -> Harina Campodonico, factor 25 (comprar 5 = 125 kg)
-- El total de cada línea de FUDO es el precio NETO total de esa línea.

create table if not exists compras_fudo_items (
  fudo_item_id text primary key,
  fudo_expense_id text not null,
  fecha date not null,
  fudo_product_id text not null,
  producto_nombre text not null,
  cantidad numeric(14,3) not null,
  total numeric(14,2) not null,
  proveedor text,
  created_at timestamptz not null default now()
);
create index if not exists compras_fudo_items_fecha_idx on compras_fudo_items (fecha);
create index if not exists compras_fudo_items_prod_idx on compras_fudo_items (fudo_product_id);

create table if not exists compra_productos (
  fudo_product_id text primary key,
  producto_nombre text not null,
  insumo_id uuid references insumos(id) on delete set null,
  factor numeric(14,4) not null default 1 check (factor > 0),
  ignorar boolean not null default false   -- true = no es un insumo (bebidas, limpieza, etc.)
);

-- Mapeo inicial (solo completa los que aún no tienen insumo; no pisa cambios tuyos)
insert into compra_productos (fudo_product_id, producto_nombre, insumo_id, factor)
select v.id, v.nombre, i.id, v.factor
from (values
  ('147', 'Muzza Barraza kg', 'Muzzarella Barraza', 1),
  ('106', 'Muzza Arotcarena kg', 'Muzzarella Arotcarena', 1),
  ('108', 'Cebolla kg', 'Cebolla', 1),
  ('116', 'Tomate redondo', 'Tomate Redondo', 1),
  ('107', 'Albahacas', 'Albahaca', 1),
  ('100', 'Harina Campodonico Fuerza 25 kg', 'Harina Campodonico', 25),
  ('99', 'Aceite oliva Noble Cacique 5 lts', 'Aceite de Oliva Noble Cacique', 5),
  ('98', 'Pulpa tomate Tiempo libre 8kg', 'Pulpa Tomate', 8),
  ('97', 'Tomate triturado Tiempo libre 8kg', 'Tomate Triturado', 8),
  ('103', 'Pepperoni Cagnoli', 'Pepperoni Cagnoli', 1),
  ('83', 'Pepperoni', 'Pepperoni Cagnoli', 1),
  ('104', 'Levadura seca Mauripan 500gr', 'Levadura Seca Mauripan', 0.5),
  ('146', 'Aceituna negras copim 2kg', 'Aceitunas Negras', 2),
  ('145', 'Aceitunas Verde copim 2kg', 'Aceitunas Verdes', 2),
  ('101', 'Jamon cocido Cagnoli', 'Jamon Cocido Cagnoli', 1),
  ('127', 'Jamon cocido Klein', 'Jamón Cocido Klein', 1),
  ('126', 'Ricotta garcia 3kg', 'Ricotta Garcia', 3),
  ('118', 'Sal fina dos anclas 5kg', 'Sal Dos Anclas Fina', 5),
  ('167', 'Sal fina 500gr', 'Sal Dos Anclas Fina', 0.5),
  ('102', 'Queso azul La Quesera', 'Queso Azul Quesera', 1),
  ('134', 'Miel kg', 'Miel', 1),
  ('168', 'Reggianito Silvia kg', 'Reggianito Silvia', 1),
  ('105', 'Leche ilolay 1lts', 'Leche Entera Ilolay', 1),
  ('169', 'Stracciatella Festa x 1kg', 'Stracciatella', 1),
  ('148', 'Oregano en hoja copim 550g', 'Oregano', 0.55),
  ('115', 'Cabeza de ajo', 'Ajo', 0.045),
  ('120', 'Perejil atado', 'Perejil', 0.1),
  ('117', 'Azucar', 'Azucar', 10),
  ('133', 'Fontina Silvia kg', 'Fontina Barraza', 1),
  ('125', 'Crema de leche Tonadita 4lts', 'Crema de Leche Manfrey', 4),
  ('135', 'Aceite girasol', 'Aceite Girasol', 0.9),
  ('121', 'Morron campo solco 2,5', 'Morron Campo Solco', 2.5),
  ('114', 'Aji picante vaina', 'Aji Verde', 1),
  ('178', 'Harina 000 5 Estrellas Campodonico x 25', 'Harina Campodonico', 25),
  ('96', 'Folex 25x37 paq', 'Fólex grande', 1000),
  ('94', 'Folex 20x25 paq', 'Fólex chico', 1000)
) as v(id, nombre, insumo, factor)
join insumos i on i.nombre = v.insumo
on conflict (fudo_product_id) do update
  set insumo_id = excluded.insumo_id, factor = excluded.factor
  where compra_productos.insumo_id is null;

-- Compras ya expresadas en la unidad del insumo
create or replace view v_compras_insumo as
select c.fecha, date_trunc('month', c.fecha)::date as mes, p.insumo_id, i.nombre, i.unidad,
       c.cantidad * p.factor as cantidad, c.total,
       c.total / nullif(c.cantidad * p.factor, 0) as precio_unit,
       c.proveedor, c.producto_nombre
from compras_fudo_items c
join compra_productos p on p.fudo_product_id = c.fudo_product_id and p.insumo_id is not null and not p.ignorar
join insumos i on i.id = p.insumo_id;

-- Comprado vs consumo teórico (ventas x receta), por insumo y mes
create or replace view v_compras_vs_consumo as
with c as (
  select mes, insumo_id, sum(cantidad) as comprado, sum(total) as costo
  from v_compras_insumo group by 1, 2
)
select coalesce(c.mes, t.mes) as mes, i.id as insumo_id, i.nombre, i.unidad,
       coalesce(c.comprado, 0) as cantidad_comprada,
       coalesce(c.costo, 0) as costo_comprado,
       coalesce(t.cantidad_teorica, 0) as cantidad_teorica,
       coalesce(c.comprado, 0) - coalesce(t.cantidad_teorica, 0) as diferencia
from c
full join v_consumo_teorico t on t.mes = c.mes and t.insumo_id = c.insumo_id
join insumos i on i.id = coalesce(c.insumo_id, t.insumo_id);

-- Productos comprados que todavía no están asociados a un insumo (ordenados por gasto)
create or replace view v_compras_sin_mapear as
select p.fudo_product_id, p.producto_nombre, count(*) as veces, sum(c.total) as total
from compra_productos p
join compras_fudo_items c on c.fudo_product_id = p.fudo_product_id
where p.insumo_id is null and not p.ignorar
group by 1, 2;

-- Seguridad: solo usuarios con sesión
alter table compras_fudo_items enable row level security;
alter table compra_productos enable row level security;
drop policy if exists "compras_items_auth" on compras_fudo_items;
create policy "compras_items_auth" on compras_fudo_items for select to authenticated using (true);
drop policy if exists "compra_productos_auth" on compra_productos;
create policy "compra_productos_auth" on compra_productos for select to authenticated using (true);
alter view v_compras_insumo set (security_invoker = true);
alter view v_compras_vs_consumo set (security_invoker = true);
alter view v_compras_sin_mapear set (security_invoker = true);
