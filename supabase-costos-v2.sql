-- Ejecutar en Supabase SQL Editor DESPUÉS de supabase-costos.sql (idempotente, se puede repetir)
-- v2: stock de FUDO, equivalencias catálogo -> insumos FUDO, alertas, pedido vs compra corregido

alter table insumos add column if not exists stock_fudo numeric;
alter table insumos add column if not exists stock_control boolean not null default false;

-- Equivalencias: cada ítem del catálogo de pedidos -> insumo de FUDO.
-- factor = cantidad de unidad FUDO (kg, litros, unidades) que trae 1 unidad de pedido.
--   ej: "Harina Campodonico x 25kg" -> Harina Campodonico, factor 25
create table if not exists equivalencias_catalogo (
  catalogo_nombre text primary key,
  insumo_id uuid not null references insumos(id) on delete cascade,
  factor numeric(14,4) not null check (factor > 0)
);
alter table equivalencias_catalogo enable row level security;
drop policy if exists "equiv_select" on equivalencias_catalogo;
create policy "equiv_select" on equivalencias_catalogo for select to anon using (true);

-- Propuesta inicial (revisar). patrón del catálogo (like) | nombre del insumo en FUDO | factor
insert into equivalencias_catalogo (catalogo_nombre, insumo_id, factor)
select c.nombre, i.id, v.factor
from (values
  ('Aceite Oliva Noble Cacique x 5lts%',  'Aceite de Oliva Noble Cacique', 5),
  ('Harina Campodonico x 25kg',           'Harina Campodonico',           25),
  ('Leche Ilolay',                        'Leche Entera Ilolay',          1),
  ('Muzzarella plancha Tradicional Barraza%', 'Muzzarella Barraza',       1),
  ('Muzzarella plancha Arotcarena%',      'Muzzarella Arotcarena',        1),
  ('Aceite girasol x 900cc',              'Aceite Girasol',               0.9),
  ('Aji cayena',                          'Aji Molido/Cayena',            1),
  ('Azucar',                              'Azucar',                       1),
  ('Levadura seca Mauripan x 500gr',      'Levadura Seca Mauripan',       0.5),
  ('Miel de abeja',                       'Miel',                         1),
  ('Oregano copim',                       'Oregano',                      1),
  ('Pimienta negra molida Alicante 25gr', 'Pimienta Negra Molida',        0.025),
  ('Pulpa de tomate%x 8kg',               'Pulpa Tomate',                 8),
  ('Sal fina 2 Anclas x 5kg',             'Sal Dos Anclas Fina',          5),
  ('Tomate triturado%x 8kg',              'Tomate Triturado',             8),
  ('Aceituna verde x 2kg',                'Aceitunas Verdes',             2),
  ('Aceitunas negra x2kg',                'Aceitunas Negras',             2),
  ('Morron Campo solco x 2kg',            'Morron Campo Solco',           2),
  ('Queso crema pouch Paulina x 4kg',     'Queso Crema Paulina',          4),
  ('Queso Fontina',                       'Fontina Barraza',              1),
  ('Queso Azul',                          'Queso Azul Quesera',           1),
  ('Jamon Cagnoli',                       'Jamon Cocido Cagnoli',         1),
  ('Ricotta Garcia x 3kg',                'Ricotta Garcia',               3),
  ('Vodka Smirnoff 700ml',                'Vodka Smirnoff',               0.7),
  ('Orma Reggianito Silvia',              'Reggianito Silvia',            1),
  ('Stracciatella Festa',                 'Stracciatella',                1)
) as v(patron, fudo_nombre, factor)
join catalogo_pizza c on c.nombre like v.patron
join insumos i on i.nombre = v.fudo_nombre
on conflict (catalogo_nombre) do nothing;

-- Pedido de los locales vs lo comprado (todo expresado en la unidad de FUDO)
drop view if exists v_pedido_vs_compra;
create view v_pedido_vs_compra as
with p as (
  select date_trunc('month', pe.fecha)::date as mes, e.insumo_id,
         sum((it->>'cantidad')::numeric * e.factor) as cantidad_pedida
  from pedidos_pizza pe
  cross join lateral jsonb_array_elements(pe.items) it
  join equivalencias_catalogo e on e.catalogo_nombre = it->>'nombre'
  where pe.estado <> 'cancelado'
  group by 1, 2
), c as (
  select date_trunc('month', fecha)::date as mes, insumo_id, sum(cantidad) as cantidad_comprada
  from compras group by 1, 2
)
select coalesce(p.mes, c.mes) as mes, i.nombre, i.unidad,
       coalesce(p.cantidad_pedida, 0) as cantidad_pedida,
       coalesce(c.cantidad_comprada, 0) as cantidad_comprada,
       coalesce(c.cantidad_comprada, 0) - coalesce(p.cantidad_pedida, 0) as diferencia
from p full join c on c.mes = p.mes and c.insumo_id = p.insumo_id
join insumos i on i.id = coalesce(p.insumo_id, c.insumo_id);
alter view v_pedido_vs_compra set (security_invoker = true);

-- Alertas: stock negativo en FUDO e insumos de recetas sin costo
drop view if exists v_alertas_insumos;
create view v_alertas_insumos as
select i.id as insumo_id, i.nombre, i.unidad, 'stock_negativo'::text as tipo, i.stock_fudo as valor
from insumos i where i.stock_control and i.stock_fudo < 0
union all
select i.id, i.nombre, i.unidad, 'sin_costo', null
from insumos i
where exists (select 1 from recetas r where r.insumo_id = i.id)
  and not exists (select 1 from precios_insumo p where p.insumo_id = i.id);
alter view v_alertas_insumos set (security_invoker = true);
