-- Ejecutar en Supabase SQL Editor (idempotente). Corrige la sync de costos de FUDO.
-- La sync comparaba el costo de FUDO contra el precio de factura y agregaba filas repetidas en cada corrida.
-- Ahora compara contra el último costo de FUDO guardado (esta vista).

create or replace view v_costo_fudo_actual as
select distinct on (insumo_id) insumo_id, precio, fecha
from precios_insumo
where fuente = 'fudo'
order by insumo_id, fecha desc, created_at desc;
alter view v_costo_fudo_actual set (security_invoker = true);

-- Limpieza: borra los costos de FUDO que repiten el valor inmediatamente anterior del mismo insumo
-- (conserva los cambios reales, incluso si un precio vuelve a un valor anterior).
delete from precios_insumo
where id in (
  select id from (
    select id, precio,
           lag(precio) over (partition by insumo_id order by fecha, created_at, id) as anterior
    from precios_insumo
    where fuente = 'fudo'
  ) t
  where precio = anterior
);
