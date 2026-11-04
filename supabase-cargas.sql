-- Ejecutar en Supabase SQL Editor (idempotente) DESPUÉS de supabase-bultos.sql.
-- Controles automáticos de las facturas cargadas en FUDO: qué cargas conviene revisar.
--
-- 1) El monto del gasto no cierra con la suma de sus líneas. El monto es el total de la factura (con IVA y
--    percepciones) y las líneas van en neto, así que monto / suma de líneas tiene que dar un valor típico del
--    proveedor (ej. Almasa 1,24 = IVA 21% + percepción 3%) o un IVA conocido (1,105 / 1,135 / 1,21 / 1,24).
-- 2) Hay líneas sin producto elegido (no se pueden contar en precios ni compras).
-- 3) El precio por unidad de una línea se va a más del doble (o menos de la mitad) de lo habitual del producto,
--    o en bebidas por bulto la cantidad no encaja ni en unidades ni en bultos.

-- Un registro por gasto vigente (lo completa la sync): monto, suma de sus líneas y líneas sin producto
create table if not exists gastos_control (
  fudo_expense_id text primary key,
  fecha date not null,
  proveedor text,
  comprobante text,
  monto numeric(14,2) not null default 0,
  suma_lineas numeric(14,2) not null default 0,
  lineas int not null default 0,
  lineas_sin_producto int not null default 0,
  sin_producto_total numeric(14,2) not null default 0,
  sin_producto_detalle text
);
create index if not exists gastos_control_fecha_idx on gastos_control (fecha);
alter table gastos_control enable row level security;
drop policy if exists "gastos_control_auth" on gastos_control;
create policy "gastos_control_auth" on gastos_control for select to authenticated using (true);

create or replace view v_cargas_revisar as
with t as (
  -- razón típica de cada proveedor (mediana de monto / suma de líneas, ignorando valores absurdos)
  select proveedor, count(*) as n,
         percentile_cont(0.5) within group (order by monto / suma_lineas) as tipica
  from gastos_control
  where suma_lineas > 0 and lineas_sin_producto = 0 and monto / suma_lineas between 0.99 and 1.5
  group by proveedor
), med as (
  -- precio por unidad habitual de cada producto
  select fudo_product_id, count(*) as n,
         percentile_cont(0.5) within group (order by total / unidades) as mediana
  from v_compras_norm
  where unidades > 0
  group by fudo_product_id
)
select 'monto'::text as motivo, g.fecha, g.proveedor, g.comprobante, null::text as producto,
       g.monto, g.suma_lineas, (g.monto / g.suma_lineas) as razon, t.tipica,
       null::numeric as cantidad, null::numeric as total, null::numeric as precio_unit,
       null::numeric as mediana, null::text as detalle
from gastos_control g
left join t on t.proveedor = g.proveedor and t.n >= 2
where g.suma_lineas > 0
  and g.lineas_sin_producto = 0   -- si hay líneas sin producto, ese aviso ya explica la diferencia
  and not (t.tipica is not null and abs(g.monto / g.suma_lineas / t.tipica - 1) <= 0.04)
  -- proveedores con impuesto interno (gaseosas, cervezas): la razón va de 1,30 a 1,50 según los productos de cada factura
  and not (t.tipica > 1.30 and g.monto / g.suma_lineas between 1.30 and 1.50)
  and not (abs(g.monto / g.suma_lineas - 1.105) <= 0.012 or abs(g.monto / g.suma_lineas - 1.135) <= 0.012
        or abs(g.monto / g.suma_lineas - 1.21) <= 0.012 or abs(g.monto / g.suma_lineas - 1.24) <= 0.012)
union all
select 'sin_producto', g.fecha, g.proveedor, g.comprobante, null,
       g.monto, g.suma_lineas, null, null,
       g.lineas_sin_producto::numeric, g.sin_producto_total, null, null, g.sin_producto_detalle
from gastos_control g
where g.lineas_sin_producto > 0
union all
select case when n.unidades is null then 'dudosa' else 'precio' end, n.fecha, n.proveedor, g.comprobante, n.producto_nombre,
       null, null, null, null,
       n.cantidad_cargada, n.total, case when n.unidades > 0 then n.total / n.unidades end, m.mediana, null
from v_compras_norm n
join compras_fudo_items i on i.fudo_item_id = n.fudo_item_id
left join gastos_control g on g.fudo_expense_id = i.fudo_expense_id
left join med m on m.fudo_product_id = n.fudo_product_id and m.n >= 3
where n.unidades is null
   or (m.mediana is not null
       and (n.total / n.unidades > 2 * m.mediana or n.total / n.unidades < 0.5 * m.mediana));
alter view v_cargas_revisar set (security_invoker = true);
