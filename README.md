# Pizza Nº1 · Costos

Dashboard de costos alimentado automáticamente desde FUDO: ventas, precios de insumos, consumo teórico (ventas × recetas) y alertas de stock. HTML/JS puro + Supabase (mismo proyecto que `pedidos-pizza-nro1`), publicado en GitHub Pages.

Pestañas: **Resumen** · **Precios de insumos** · **Consumo** · **Alertas**.

Todo viene de FUDO sin carga manual: no hay compras por insumo ni cruce con los pedidos de los locales, porque FUDO no entrega compras asociadas a insumos.

## Cómo funciona

1. Una Edge Function de Supabase (`supabase/functions/sync-fudo`) consulta la API de FUDO y guarda ventas, insumos, costos, recetas y stock.
2. `pg_cron` la ejecuta todos los días a las 6:00 (hora Argentina) y trae los últimos 3 días.
3. El dashboard lee los datos con Supabase Auth (solo usuarios con sesión).

## Puesta en marcha (orden de los SQL)

1. `supabase-costos.sql` → tablas y vistas.
2. `supabase-costos-v2.sql` → stock, alertas y vistas auxiliares.
3. `supabase-costos-auth.sql` → solo usuarios con sesión pueden leer.
4. `supabase-cron.sql` → sync diaria (reemplazar `TU_SYNC_TOKEN`).

Además:
- **Config web:** copiar `config.example.js` a `config.js` (URL y anon key de Supabase).
- **Credenciales FUDO** (nunca en el código ni en el frontend), como secrets de Supabase: `FUDO_API_KEY`, `FUDO_API_SECRET`, `SYNC_TOKEN`.
- **Función:** pegar `supabase/functions/sync-fudo/index.ts` en Edge Functions con *Verify JWT* desactivado (se protege con `SYNC_TOKEN`).
- **Auth:** crear el usuario en Supabase y desactivar *Allow new users to sign up*.
- **Diagnóstico:** `?probe=sales|ingredients|products|expenses` en la función devuelve la respuesta cruda de FUDO sin guardar nada.

## Seguridad

- Las tablas solo se leen con sesión (RLS). Las escrituras las hace la Edge Function con service role.
- `config.js` solo contiene la anon key (pública por diseño). `.env` está en `.gitignore`.
- Si una API Secret se expuso en un chat o repo: regenerarla en FUDO.

## Para que los números sean confiables

- **Stock negativo:** cargar compras en FUDO con el detalle de insumos (Gastos > Agregar detalle) y hacer un conteo de inventario inicial y periódico.
- **Costo de las preparaciones propias** (masa, salsas, pizzas XL): FUDO no las tiene con costo, por eso el costo teórico y el margen están subestimados.
- **Recetas:** el consumo teórico solo cuenta productos con receta cargada en FUDO.
- **IVA:** los costos de FUDO son netos y las ventas incluyen IVA, así que el margen sale más alto de lo real.

## Pendiente

- Costos de preparaciones y cobertura de recetas (dependen de FUDO).
- Ajuste de IVA en las ventas del dashboard.
- Logo propio y ajustes de diseño.
