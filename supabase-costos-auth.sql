-- Ejecutar en Supabase SQL Editor (idempotente). Protege los datos de costos:
-- solo un usuario con sesión (Supabase Auth) puede leer. La clave pública (anon) deja de ver todo.
-- La Edge Function usa service_role y no se ve afectada.

do $$
declare t text;
begin
  foreach t in array array[
    'insumos','precios_insumo','compras','recetas','ventas_fudo_items','sync_log','equivalencias_catalogo'
  ] loop
    -- elimina las políticas de lectura pública de las versiones anteriores
    execute format('drop policy if exists %I on %I', t || '_anon_select', t);
  end loop;
end $$;

drop policy if exists "insumos_select" on insumos;
drop policy if exists "precios_select" on precios_insumo;
drop policy if exists "compras_select" on compras;
drop policy if exists "recetas_select" on recetas;
drop policy if exists "ventas_items_select" on ventas_fudo_items;
drop policy if exists "sync_log_select" on sync_log;
drop policy if exists "equiv_select" on equivalencias_catalogo;

drop policy if exists "insumos_auth" on insumos;
create policy "insumos_auth" on insumos for select to authenticated using (true);
drop policy if exists "precios_auth" on precios_insumo;
create policy "precios_auth" on precios_insumo for select to authenticated using (true);
drop policy if exists "compras_auth" on compras;
create policy "compras_auth" on compras for select to authenticated using (true);
drop policy if exists "recetas_auth" on recetas;
create policy "recetas_auth" on recetas for select to authenticated using (true);
drop policy if exists "ventas_items_auth" on ventas_fudo_items;
create policy "ventas_items_auth" on ventas_fudo_items for select to authenticated using (true);
drop policy if exists "sync_log_auth" on sync_log;
create policy "sync_log_auth" on sync_log for select to authenticated using (true);
drop policy if exists "equiv_auth" on equivalencias_catalogo;
create policy "equiv_auth" on equivalencias_catalogo for select to authenticated using (true);

-- La vista v_pedido_vs_compra lee pedidos_pizza: el usuario con sesión también debe poder leerla
-- (no se toca la política pública que ya usa la app de pedidos).
drop policy if exists "pedidos_pizza_select_auth" on pedidos_pizza;
create policy "pedidos_pizza_select_auth" on pedidos_pizza for select to authenticated using (true);
