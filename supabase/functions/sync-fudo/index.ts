// Edge Function: sincroniza ventas, insumos (costos y stock), compras y recetas de FUDO hacia Supabase.
// Secrets requeridos (supabase secrets set ...):
//   FUDO_API_KEY, FUDO_API_SECRET   -> credenciales del usuario API de FUDO
//   SYNC_TOKEN                      -> token propio para invocar esta función (header x-sync-token)
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los inyecta Supabase automáticamente.
//
// Uso:
//   GET ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD   (por defecto últimos 3 días)
//   GET ?probe=sales|ingredients|products|expenses  (devuelve la 1ª página cruda de FUDO, sin guardar nada;
//       los demás parámetros de la URL se reenvían a FUDO)
//
// API FUDO v1alpha1 (https://dev.fu.do/api, spec: https://api.fu.do/v1alpha1/openapi.yml)
// Formato JSON:API: { data: [{id, type, attributes, relationships}], included: [...] }
// Los atributos solo llegan si se piden con fields[tipo]=...

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const FUDO_AUTH_URL = "https://auth.fu.do/api";
const FUDO_BASE_URL = "https://api.fu.do/v1alpha1";
const PAGE_SIZE = 500;
const AR_OFFSET_MS = -3 * 3600 * 1000; // Tucumán: UTC-3

async function fudoToken(): Promise<string> {
  const r = await fetch(FUDO_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      apiKey: Deno.env.get("FUDO_API_KEY"),
      apiSecret: Deno.env.get("FUDO_API_SECRET"),
    }),
  });
  if (!r.ok) throw new Error(`FUDO auth ${r.status}`);
  return (await r.json()).token;
}

async function fudoGet(token: string, path: string, params: Record<string, string>) {
  const qs = new URLSearchParams(params);
  const r = await fetch(`${FUDO_BASE_URL}/${path}?${qs}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`FUDO ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

// Pagina hasta agotar; devuelve data e included juntos
async function fudoList(token: string, path: string, params: Record<string, string>) {
  const data: any[] = [];
  const included: any[] = [];
  for (let page = 1; page < 200; page++) {
    const body = await fudoGet(token, path, {
      ...params,
      "page[size]": String(PAGE_SIZE),
      "page[number]": String(page),
    });
    const rows = body.data ?? [];
    data.push(...rows);
    included.push(...(body.included ?? []));
    if (rows.length < PAGE_SIZE) break;
  }
  return { data, included };
}

const fechaAR = (iso: string) => new Date(new Date(iso).getTime() + AR_OFFSET_MS).toISOString().slice(0, 10);
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.headers.get("x-sync-token") !== Deno.env.get("SYNC_TOKEN")) {
    return new Response("unauthorized", { status: 401 });
  }
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const url = new URL(req.url);
  const hoy = fechaAR(new Date().toISOString());
  const hasta = url.searchParams.get("hasta") ?? hoy;
  const desde = url.searchParams.get("desde") ?? fechaAR(new Date(Date.now() - 3 * 864e5).toISOString());
  const hastaExcl = new Date(new Date(hasta + "T00:00:00Z").getTime() + 864e5).toISOString().slice(0, 10);
  // Las facturas se cargan con fecha propia y a veces días después: las compras se revisan siempre
  // sobre los últimos 45 días (o desde `desde`, si es anterior). Reprocesar es idempotente.
  const desde45 = fechaAR(new Date(Date.now() - 45 * 864e5).toISOString());
  const desdeCompras = desde < desde45 ? desde : desde45;
  const probe = url.searchParams.get("probe");

  let token: string;
  try {
    token = await fudoToken();
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }

  // Modo diagnóstico: muestra la forma real de los datos para ajustar mapeos
  if (probe) {
    const cfg: Record<string, [string, Record<string, string>]> = {
      sales: ["sales", { include: "items,items.product", "filter[saleState]": "in.(CLOSED)", "page[size]": "2" }],
      ingredients: ["ingredients", { include: "unit,recipeCard", "page[size]": "5" }],
      products: ["products", { include: "recipeCard,proportions,proportions.ingredient", "page[size]": "2" }],
      expenses: ["expenses", { include: "expenseItems,expenseItems.ingredient,provider", "page[size]": "3", sort: "-date" }],
    };
    if (!cfg[probe]) return json({ ok: false, error: "probe: sales|ingredients|products|expenses" }, 400);
    // Cualquier otro parámetro de la URL se reenvía a FUDO (fields[...], filter[...], page[size]...)
    const extras: Record<string, string> = {};
    for (const [k, v] of url.searchParams) {
      if (!["probe", "desde", "hasta"].includes(k)) extras[k] = v;
    }
    try {
      return json(await fudoGet(token, cfg[probe][0], { ...cfg[probe][1], ...extras }));
    } catch (e) {
      return json({ ok: false, error: String(e) }, 500);
    }
  }

  const resultado: Record<string, number> = {};
  const log = (recurso: string, filas: number, error?: string) =>
    db.from("sync_log").insert({ recurso, desde, hasta, filas, error: error ?? null });

  // ---------- Ventas (cabecera por modo + items de ventas cerradas + catálogo de productos) ----------
  // Se piden solo los campos necesarios de la venta (no se guardan datos de clientes).
  try {
    const { data: ventas, included } = await fudoList(token, "sales", {
      include: "items,items.product,items.product.productCategory",
      "fields[sale]": "closedAt,createdAt,saleType,total,items",
      "filter[saleState]": "in.(CLOSED)",
      // día argentino = 03:00Z del día hasta 03:00Z del siguiente
      "filter[closedAt]": `and(gte.${desde}T03:00:00Z,lt.${hastaExcl}T03:00:00Z)`,
    });
    const itemsInc = new Map(included.filter((x) => x.type === "Item").map((x) => [String(x.id), x]));
    const prodInc = new Map(included.filter((x) => x.type === "Product").map((x) => [String(x.id), x]));
    const catInc = new Map(included.filter((x) => x.type === "ProductCategory").map((x) => [String(x.id), String(x.attributes?.name ?? "")]));

    // Catálogo: producto -> categoría (base de la clasificación porción / pizza / bebida / etc.)
    const catalogo = [...prodInc.entries()].map(([id, p]) => ({
      producto_id: id,
      nombre: String(p.attributes?.name ?? id),
      categoria: catInc.get(String(p.relationships?.productCategory?.data?.id)) || null,
    }));
    for (let i = 0; i < catalogo.length; i += 500) {
      const { error } = await db.from("productos_fudo").upsert(catalogo.slice(i, i + 500), { onConflict: "producto_id" });
      if (error) throw new Error(error.message);
    }

    // Cabecera de cada venta: modo (EAT-IN salón, TAKEAWAY, DELIVERY), hora de cierre y total
    const cabeceras = ventas.map((s: any) => {
      const cerrada = String(s.attributes?.closedAt ?? s.attributes?.createdAt);
      return {
        fudo_sale_id: String(s.id),
        fecha: fechaAR(cerrada),
        cerrada_at: cerrada,
        tipo: String(s.attributes?.saleType ?? "OTRO"),
        total: Number(s.attributes?.total ?? 0),
      };
    });
    for (let i = 0; i < cabeceras.length; i += 500) {
      const { error } = await db.from("ventas_fudo").upsert(cabeceras.slice(i, i + 500), { onConflict: "fudo_sale_id" });
      if (error) throw new Error(error.message);
    }
    resultado.ventas = cabeceras.length;

    const filas: any[] = [];
    for (const s of ventas) {
      const fecha = fechaAR(s.attributes?.closedAt ?? s.attributes?.createdAt);
      for (const ref of s.relationships?.items?.data ?? []) {
        const it = itemsInc.get(String(ref.id));
        if (!it || it.attributes?.canceled) continue;
        const pid = String(it.relationships?.product?.data?.id ?? "");
        if (!pid) continue;
        const cant = Number(it.attributes?.quantity ?? 1);
        filas.push({
          fudo_sale_id: String(s.id),
          fudo_item_id: String(it.id),
          fecha,
          producto_id: pid,
          producto_nombre: String(prodInc.get(pid)?.attributes?.name ?? pid),
          cantidad: cant,
          // `price` del item es el total de la línea (no el unitario)
          total: Number(it.attributes?.price ?? 0),
        });
      }
    }
    for (let i = 0; i < filas.length; i += 500) {
      const { error } = await db.from("ventas_fudo_items").upsert(filas.slice(i, i + 500), { onConflict: "fudo_item_id" });
      if (error) throw new Error(error.message);
    }
    resultado.ventas_items = filas.length;
    await log("ventas", filas.length);
  } catch (e) {
    const msg = e instanceof Error ? e.message : JSON.stringify(e);
    await log("ventas", 0, msg);
    return json({ ok: false, recurso: "ventas", error: msg }, 500);
  }

  // ---------- Precios de insumos (ingredients.cost) ----------
  try {
    const { data: ings, included: incIng } = await fudoList(token, "ingredients", { include: "unit" });
    const unidades = new Map(incIng.filter((x) => x.type === "Unit").map((u) => [String(u.id), String(u.attributes?.name ?? "und")]));
    const { data: insumos0 } = await db.from("insumos").select("id,nombre,fudo_ingredient_id");
    const porFudo0 = new Map((insumos0 ?? []).filter((i) => i.fudo_ingredient_id).map((i) => [i.fudo_ingredient_id, i]));
    const porNombre = new Map((insumos0 ?? []).map((i) => [i.nombre.trim().toLowerCase(), i]));

    // Vincula por id de FUDO o por nombre; los que no existen se crean (categoría FUDO)
    const aCrear: any[] = [];
    for (const g of ings) {
      const fid = String(g.id);
      const nombre = String(g.attributes?.name ?? "").trim();
      if (porFudo0.has(fid)) continue;
      const porN = porNombre.get(nombre.toLowerCase());
      if (porN) {
        await db.from("insumos").update({ fudo_ingredient_id: fid }).eq("id", porN.id);
      } else if (nombre) {
        aCrear.push({
          nombre,
          unidad: unidades.get(String(g.relationships?.unit?.data?.id)) ?? "und",
          categoria: "FUDO",
          fudo_ingredient_id: fid,
        });
      }
    }
    if (aCrear.length) {
      const { error } = await db.from("insumos").upsert(aCrear, { onConflict: "fudo_ingredient_id" });
      if (error) throw new Error(error.message);
    }
    resultado.insumos_creados = aCrear.length;

    const { data: insumos } = await db.from("insumos").select("id,fudo_ingredient_id");
    const idPorFudo = new Map((insumos ?? []).filter((i) => i.fudo_ingredient_id).map((i) => [i.fudo_ingredient_id, i.id]));
    // Se compara contra el último costo de FUDO guardado (no contra el precio de factura, que es otro dato)
    const { data: actuales } = await db.from("v_costo_fudo_actual").select("insumo_id,precio");
    const precioActual = new Map((actuales ?? []).map((a) => [a.insumo_id, Number(a.precio)]));

    // Stock actual de FUDO (para alertas de stock negativo)
    const conStock = ings.filter((g) => idPorFudo.has(String(g.id)));
    for (let i = 0; i < conStock.length; i += 20) {
      await Promise.all(conStock.slice(i, i + 20).map((g) =>
        db.from("insumos").update({
          stock_fudo: g.attributes?.stock ?? null,
          stock_control: Boolean(g.attributes?.stockControl),
        }).eq("id", idPorFudo.get(String(g.id)))
      ));
    }

    const nuevos: any[] = [];
    for (const g of ings) {
      const insId = idPorFudo.get(String(g.id));
      const costo = Number(g.attributes?.cost ?? 0);
      if (insId && costo > 0 && precioActual.get(insId) !== costo) {
        nuevos.push({ insumo_id: insId, precio: costo, fecha: hoy, fuente: "fudo" });
      }
    }
    if (nuevos.length) {
      const { error } = await db.from("precios_insumo").insert(nuevos);
      if (error) throw new Error(error.message);
    }
    resultado.precios_nuevos = nuevos.length;
    await log("ingredientes", nuevos.length);
  } catch (e) {
    const msg = e instanceof Error ? e.message : JSON.stringify(e);
    await log("ingredientes", 0, msg);
    return json({ ok: false, recurso: "ingredientes", parcial: resultado, error: msg }, 500);
  }

  // ---------- Compras (gastos con detalle) ----------
  // Cada línea del gasto apunta a un producto de compra (ej. "Cebolla kg") o, a veces, a un insumo.
  // `price` es el total NETO de la línea. Se guardan todas las líneas; el mapeo a insumo (tabla
  // compra_productos) lo resuelve la vista v_compras_insumo, así que cambiarlo no requiere re-sincronizar.
  try {
    const { data: gastos, included } = await fudoList(token, "expenses", {
      include: "expenseItems,expenseItems.product,expenseItems.ingredient,provider",
      "fields[expense]": "date,canceled,expenseItems,provider",
      "fields[expenseItem]": "quantity,price,detail,canceled,product,ingredient",
      "fields[product]": "name",
      "fields[ingredient]": "name",
      "filter[date]": `and(gte.${desdeCompras},lte.${hasta})`,
    });
    const eItems = new Map(included.filter((x) => x.type === "ExpenseItem").map((x) => [String(x.id), x]));
    const prodN = new Map(included.filter((x) => x.type === "Product").map((x) => [String(x.id), String(x.attributes?.name ?? "")]));
    const ingN = new Map(included.filter((x) => x.type === "Ingredient").map((x) => [String(x.id), String(x.attributes?.name ?? "")]));
    const provN = new Map(included.filter((x) => x.type === "Provider").map((x) => [String(x.id), String(x.attributes?.name ?? "")]));
    const { data: insumosC } = await db.from("insumos").select("id,fudo_ingredient_id");
    const idPorFudoC = new Map((insumosC ?? []).filter((i) => i.fudo_ingredient_id).map((i) => [i.fudo_ingredient_id, i.id]));

    const lineas: any[] = [];
    const productos = new Map<string, any>();
    let sinVinculo = 0;
    for (const g of gastos) {
      if (g.attributes?.canceled || !g.attributes?.date) continue;
      const proveedor = provN.get(String(g.relationships?.provider?.data?.id)) || null;
      for (const ref of g.relationships?.expenseItems?.data ?? []) {
        const it = eItems.get(String(ref.id));
        if (!it || it.attributes?.canceled) continue;
        const cant = Number(it.attributes?.quantity ?? 0);
        const iid = it.relationships?.ingredient?.data?.id;
        const pid = it.relationships?.product?.data?.id;
        let prodId: string;
        let nombre: string;
        if (iid) {
          prodId = `ING-${iid}`;
          nombre = ingN.get(String(iid)) || `Insumo ${iid}`;
          productos.set(prodId, {
            fudo_product_id: prodId, producto_nombre: nombre,
            insumo_id: idPorFudoC.get(String(iid)) ?? null, factor: 1,
          });
        } else if (pid) {
          prodId = String(pid);
          nombre = prodN.get(prodId) || `Producto ${pid}`;
          productos.set(prodId, { fudo_product_id: prodId, producto_nombre: nombre, insumo_id: null, factor: 1 });
        } else { sinVinculo++; continue; }
        if (!(cant > 0)) continue;
        lineas.push({
          fudo_item_id: String(it.id),
          fudo_expense_id: String(g.id),
          fecha: String(g.attributes.date).slice(0, 10),
          fudo_product_id: prodId,
          producto_nombre: nombre,
          cantidad: cant,
          total: Number(it.attributes?.price ?? 0),
          proveedor,
        });
      }
    }
    // Productos nuevos entran sin insumo; los ya existentes (con su mapeo) no se tocan
    const listaProd = [...productos.values()];
    for (let i = 0; i < listaProd.length; i += 500) {
      const { error } = await db.from("compra_productos")
        .upsert(listaProd.slice(i, i + 500), { onConflict: "fudo_product_id", ignoreDuplicates: true });
      if (error) throw new Error(error.message);
    }
    for (let i = 0; i < lineas.length; i += 500) {
      const { error } = await db.from("compras_fudo_items").upsert(lineas.slice(i, i + 500), { onConflict: "fudo_item_id" });
      if (error) throw new Error(error.message);
    }
    resultado.compras_lineas = lineas.length;
    resultado.compras_sin_vinculo = sinVinculo;
    await log("compras", lineas.length);
  } catch (e) {
    const msg = e instanceof Error ? e.message : JSON.stringify(e);
    await log("compras", 0, msg);
    return json({ ok: false, recurso: "compras", parcial: resultado, error: msg }, 500);
  }

  // ---------- Recetas (products.proportions: cantidad de insumo por unidad vendida) ----------
  try {
    const { data: prods, included } = await fudoList(token, "products", {
      include: "proportions,proportions.ingredient",
      "fields[product]": "name,proportions",
      "fields[proportion]": "amount,ingredient",
      "fields[ingredient]": "name",
    });
    const props = new Map(included.filter((x) => x.type === "Proportion").map((x) => [String(x.id), x]));
    const { data: insumos } = await db.from("insumos").select("id,fudo_ingredient_id");
    const idPorFudo = new Map((insumos ?? []).filter((i) => i.fudo_ingredient_id).map((i) => [i.fudo_ingredient_id, i.id]));

    const recetas: any[] = [];
    const conReceta: string[] = [];
    for (const p of prods) {
      // Un insumo repetido en la misma receta se suma (la tabla es única por producto+insumo)
      const porInsumo = new Map<string, any>();
      for (const ref of p.relationships?.proportions?.data ?? []) {
        const pr = props.get(String(ref.id));
        const insId = idPorFudo.get(String(pr?.relationships?.ingredient?.data?.id));
        const cant = Number(pr?.attributes?.amount ?? 0);
        if (!insId || !(cant > 0)) continue;
        const f = porInsumo.get(insId);
        if (f) f.cantidad += cant;
        else porInsumo.set(insId, {
          producto_fudo_id: String(p.id),
          producto_nombre: String(p.attributes?.name ?? p.id),
          insumo_id: insId,
          cantidad: cant,
        });
      }
      if (porInsumo.size) {
        conReceta.push(String(p.id));
        recetas.push(...porInsumo.values());
      }
    }
    // Reemplaza la receta completa de cada producto (por si se quitó un insumo en FUDO)
    for (let i = 0; i < conReceta.length; i += 100) {
      const { error } = await db.from("recetas").delete().in("producto_fudo_id", conReceta.slice(i, i + 100));
      if (error) throw new Error(error.message);
    }
    for (let i = 0; i < recetas.length; i += 500) {
      const { error } = await db.from("recetas").upsert(recetas.slice(i, i + 500), { onConflict: "producto_fudo_id,insumo_id" });
      if (error) throw new Error(error.message);
    }
    resultado.productos_con_receta = conReceta.length;
    resultado.lineas_receta = recetas.length;
    await log("recetas", recetas.length);
  } catch (e) {
    const msg = e instanceof Error ? e.message : JSON.stringify(e);
    await log("recetas", 0, msg);
    return json({ ok: false, recurso: "recetas", parcial: resultado, error: msg }, 500);
  }

  return json({ ok: true, desde, hasta, ...resultado });
});
