-- Ejecutar en Supabase SQL Editor (idempotente). Asocia productos de compra nuevos a su insumo.
-- factor = unidades del insumo (kg, litros) que trae 1 unidad comprada. Ej: lata de 5 kg -> factor 5.
-- El código del producto es el id de FUDO (productos > el producto). Si el producto todavía no apareció en una
-- factura sincronizada, esta fila lo crea ya asociado; la sync no pisa un mapeo existente.
-- Para sumar otro producto, copiar una fila de la lista (código, nombre en FUDO, insumo, factor).

insert into compra_productos (fudo_product_id, producto_nombre, insumo_id, factor)
select v.id, v.nombre, i.id, v.factor
from (values
  ('183', 'Aceitunas negras copim x 5kg', 'Aceitunas Negras', 5),
  ('190', 'Queso crema Paulina x 4kg', 'Queso Crema Paulina', 4)
) as v(id, nombre, insumo, factor)
join insumos i on i.nombre = v.insumo
on conflict (fudo_product_id) do update
  set insumo_id = excluded.insumo_id, factor = excluded.factor, producto_nombre = excluded.producto_nombre;
