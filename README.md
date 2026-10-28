# Pizza Nº1 · Costos

Dashboard de costos: precios de insumos, consumo teórico (ventas FUDO × recetas), compra vs venta y pedidos de los locales vs compras. HTML/JS puro + Supabase (mismo proyecto que `pedidos-pizza-nro1`).

## Puesta en marcha

1. **Base de datos:** en Supabase (el mismo proyecto de pedidos pizza) → SQL Editor → pegar y ejecutar `supabase-costos.sql`.
2. **Config web:** copiar `config.example.js` a `config.js` y completar URL y anon key de Supabase.
3. **Credenciales FUDO** (nunca en el código ni en el frontend). En FUDO: Administración > Usuarios > usuario API > *Establecer* (se muestra la Secret una sola vez). Luego, en una terminal:

   ```bash
   supabase secrets set FUDO_API_KEY=xxxx FUDO_API_SECRET=xxxx SYNC_TOKEN=un-token-largo-y-propio
   ```
4. **Endpoints de FUDO:** la función ya usa la API v1alpha1 (auth, `/sales`, `/ingredients`). Con `?probe=sales|ingredients|products` devuelve la respuesta cruda de FUDO para confirmar campos y ajustar el mapeo de recetas y gastos.
5. **Desplegar la función:** `supabase functions deploy sync-fudo --no-verify-jwt`
6. **Programar** (Supabase → Database → Cron, o pg_cron) una llamada diaria con el header `x-sync-token`.
7. **Publicar:** subir a GitHub Pages (sin `config.js` si el repo es público: usar el flujo de deploy que ya usás en otros proyectos).

## Datos que cargás vos

- `recetas`: cuánto insumo lleva cada producto de FUDO (sin esto no hay consumo teórico).
- `precios_insumo` y `compras`: manual desde el panel de Supabase hasta que se mapeen los gastos de FUDO.

## Seguridad

- La web solo lee (RLS). Las escrituras las hace la Edge Function con service role.
- `config.js` solo contiene la anon key (pública por diseño). `.env` está en `.gitignore`.
- Si una API Secret se expuso en un chat o repo: regenerarla en FUDO.

## Pendiente

- **Costo por kg de las preparaciones propias** (Masa NY, Masa Molde, Salsa de Tomate, Chimichurri, salsas, pizzas XL): FUDO no las tiene con costo, por eso el costo teórico está subestimado. Se pueden cargar como precio manual en `precios_insumo` (fuente `manual`) o calcular a partir de sus ingredientes. Ver pestaña Alertas.
- Ejecutar `supabase-costos-v2.sql` (equivalencias, alertas, stock) y redesplegar la función.
- Verificar `?probe=expenses` y luego activar la sync de compras con `?compras=1`.

- Confirmar endpoints/campos reales de FUDO (hoy son suposiciones).
- Mapear gastos de FUDO → `compras` y `precios_insumo`.
- Pantalla para cargar recetas y precios desde la web (requiere login).
