-- Ejecutar en Supabase: SQL Editor -> New query -> Run (una sola vez)
-- Proyecto PIZZA Nº1 - Costos, consumo y compra vs venta
-- Requiere que ya existan catalogo_pizza y pedidos_pizza (proyecto pedidos-pizza-nro1)

create table if not exists insumos (
  id uuid primary key default gen_random_uuid(),
  nombre text not null unique,          -- mismo nombre que catalogo_pizza.nombre
  unidad text not null default 'und',
  categoria text not null default 'General',
  fudo_ingredient_id text unique,       -- id del insumo en FUDO (si se vincula)
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

-- Cargar insumos desde el catálogo de pedidos (no modifica catalogo_pizza)
insert into insumos (nombre, unidad, categoria)
select nombre, unidad, categoria from catalogo_pizza
on conflict (nombre) do nothing;

create table if not exists precios_insumo (
  id uuid primary key default gen_random_uuid(),
  insumo_id uuid not null references insumos(id) on delete cascade,
  precio numeric(14,2) not null,        -- precio por unidad del insumo
  fecha date not null default current_date,
  proveedor text,
  fuente text not null default 'manual', -- manual | fudo
  created_at timestamptz not null default now()
);
create index if not exists precios_insumo_idx on precios_insumo (insumo_id, fecha desc);

create table if not exists compras (
  id uuid primary key default gen_random_uuid(),
  insumo_id uuid not null references insumos(id) on delete cascade,
  cantidad numeric(14,3) not null,
  precio_unit numeric(14,2) not null,
  fecha date not null default current_date,
  proveedor text,
  fudo_expense_id text unique,          -- evita duplicar al sincronizar
  created_at timestamptz not null default now()
);
create index if not exists compras_fecha_idx on compras (fecha);

-- Receta: cuánto insumo lleva cada producto vendido en FUDO
create table if not exists recetas (
  id uuid primary key default gen_random_uuid(),
  producto_fudo_id text not null,
  producto_nombre text not null,
  insumo_id uuid not null references insumos(id) on delete cascade,
  cantidad numeric(14,4) not null,      -- en la unidad del insumo, por unidad vendida
  unique (producto_fudo_id, insumo_id)
);

-- Ventas de FUDO a nivel producto (una fila por item vendido)
create table if not exists ventas_fudo_items (
  id uuid primary key default gen_random_uuid(),
  fudo_sale_id text not null,
  fudo_item_id text not null unique,
  fecha date not null,
  producto_id text not null,
  producto_nombre text not null,
  cantidad numeric(14,3) not null,
  total numeric(14,2) not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists ventas_items_fecha_idx on ventas_fudo_items (fecha);

create table if not exists sync_log (
  id uuid primary key default gen_random_uuid(),
  recurso text not null,
  desde date,
  hasta date,
  filas int not null default 0,
  error text,
  created_at timestamptz not null default now()
);

-- ============ Vistas ============

-- Último precio, anterior y variación %
create or replace view v_variacion_precios as
with r as (
  select insumo_id, precio, fecha,
         row_number() over (partition by insumo_id order by fecha desc, created_at desc) rn
  from precios_insumo
)
select i.id as insumo_id, i.nombre, i.unidad, i.categoria,
       a.precio as precio_actual, a.fecha as fecha_actual,
       b.precio as precio_anterior, b.fecha as fecha_anterior,
       round((a.precio - b.precio) / nullif(b.precio, 0) * 100, 1) as variacion_pct
from insumos i
join r a on a.insumo_id = i.id and a.rn = 1
left join r b on b.insumo_id = i.id and b.rn = 2;

-- Consumo teórico mensual = unidades vendidas × receta
create or replace view v_consumo_teorico as
select date_trunc('month', v.fecha)::date as mes, r.insumo_id,
       sum(v.cantidad * r.cantidad) as cantidad_teorica
from ventas_fudo_items v
join recetas r on r.producto_fudo_id = v.producto_id
group by 1, 2;

-- Compra vs consumo teórico por insumo y mes
create or replace view v_compra_vs_venta as
with c as (
  select date_trunc('month', fecha)::date as mes, insumo_id,
         sum(cantidad) as cantidad_comprada, sum(cantidad * precio_unit) as costo_comprado
  from compras group by 1, 2
)
select coalesce(c.mes, t.mes) as mes, i.id as insumo_id, i.nombre, i.unidad,
       coalesce(c.cantidad_comprada, 0) as cantidad_comprada,
       coalesce(c.costo_comprado, 0) as costo_comprado,
       coalesce(t.cantidad_teorica, 0) as cantidad_teorica,
       coalesce(c.cantidad_comprada, 0) - coalesce(t.cantidad_teorica, 0) as diferencia
from c
full join v_consumo_teorico t on t.mes = c.mes and t.insumo_id = c.insumo_id
join insumos i on i.id = coalesce(c.insumo_id, t.insumo_id);

-- Resumen mensual: ventas vs compras vs costo teórico
create or replace view v_resumen_mensual as
with v as (
  select date_trunc('month', fecha)::date as mes, sum(total) as ventas
  from ventas_fudo_items group by 1
), c as (
  select date_trunc('month', fecha)::date as mes, sum(cantidad * precio_unit) as compras
  from compras group by 1
), t as (
  select t.mes, sum(t.cantidad_teorica * coalesce(p.precio_actual, 0)) as costo_teorico
  from v_consumo_teorico t
  left join v_variacion_precios p on p.insumo_id = t.insumo_id
  group by 1
)
select coalesce(v.mes, c.mes, t.mes) as mes,
       coalesce(v.ventas, 0) as ventas,
       coalesce(c.compras, 0) as compras,
       coalesce(t.costo_teorico, 0) as costo_teorico,
       coalesce(v.ventas, 0) - coalesce(t.costo_teorico, 0) as margen_teorico
from v full join c using (mes) full join t using (mes);

-- Pedidos de los locales (pedidos_pizza) vs lo comprado, por insumo y mes
create or replace view v_pedido_vs_compra as
with p as (
  select date_trunc('month', pe.fecha)::date as mes, it->>'nombre' as nombre,
         sum((it->>'cantidad')::numeric) as cantidad_pedida
  from pedidos_pizza pe, jsonb_array_elements(pe.items) it
  where pe.estado <> 'cancelado'
  group by 1, 2
)
select coalesce(p.mes, c.mes) as mes, coalesce(p.nombre, c.nombre) as nombre,
       coalesce(p.cantidad_pedida, 0) as cantidad_pedida,
       coalesce(c.cantidad_comprada, 0) as cantidad_comprada,
       coalesce(c.cantidad_comprada, 0) - coalesce(p.cantidad_pedida, 0) as diferencia
from p full join v_compra_vs_venta c on c.mes = p.mes and c.nombre = p.nombre;

-- ============ Seguridad (RLS) ============
-- Los costos son sensibles: la web (anon) solo LEE. Escrituras: service_role
-- (Edge Function de sync) o el panel de Supabase.
alter table insumos enable row level security;
alter table precios_insumo enable row level security;
alter table compras enable row level security;
alter table recetas enable row level security;
alter table ventas_fudo_items enable row level security;
alter table sync_log enable row level security;

create policy "insumos_select" on insumos for select to anon using (true);
create policy "precios_select" on precios_insumo for select to anon using (true);
create policy "compras_select" on compras for select to anon using (true);
create policy "recetas_select" on recetas for select to anon using (true);
create policy "ventas_items_select" on ventas_fudo_items for select to anon using (true);
create policy "sync_log_select" on sync_log for select to anon using (true);

alter view v_variacion_precios set (security_invoker = true);
alter view v_consumo_teorico set (security_invoker = true);
alter view v_compra_vs_venta set (security_invoker = true);
alter view v_resumen_mensual set (security_invoker = true);
alter view v_pedido_vs_compra set (security_invoker = true);
-- pedidos_pizza ya permite select a anon (proyecto de pedidos)
