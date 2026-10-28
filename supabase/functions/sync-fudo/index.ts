// Edge Function: sincroniza ventas e insumos (precios) de FUDO hacia Supabase.
// Secrets requeridos (supabase secrets set ...):
//   FUDO_API_KEY, FUDO_API_SECRET   -> credenciales del usuario API de FUDO
//   SYNC_TOKEN                      -> token propio para invocar esta función (header x-sync-token)
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los inyecta Supabase automáticamente.
//
// Uso:
//   GET ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD   (por defecto últimos 3 días)
//   GET ?probe=sales|ingredients|products    (devuelve la 1ª página cruda de FUDO, sin guardar nada)
//
// API FUDO v1alpha1 (https://dev.fu.do/api, spec: https://api.fu.do/v1alpha1/openapi.yml)
// Formato JSON:API: { data: [{id, type, attributes, relationships}], included: [...] }
// Pendiente de confirmar con respuestas reales (usar ?probe=): receta (recipeCard) y gastos.

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

  // ---------- Ventas (items de ventas cerradas) ----------
  try {
    const { data: ventas, included } = await fudoList(token, "sales", {
      include: "items,items.product",
      "filter[saleState]": "in.(CLOSED)",
      // día argentino = 03:00Z del día hasta 03:00Z del siguiente
      "filter[closedAt]": `and(gte.${desde}T03:00:00Z,lt.${hastaExcl}T03:00:00Z)`,
    });
    const itemsInc = new Map(included.filter((x) => x.type === "Item").map((x) => [String(x.id), x]));
    const prodInc = new Map(included.filter((x) => x.type === "Product").map((x) => [String(x.id), x]));

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
          total: Number(it.attributes?.price ?? 0) * cant,
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
    const { data: actuales } = await db.from("v_variacion_precios").select("insumo_id,precio_actual");
    const precioActual = new Map((actuales ?? []).map((a) => [a.insumo_id, Number(a.precio_actual)]));

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

  // ---------- Compras (expenses.expenseItems) ----------
  // Apagado por defecto hasta verificar el formato real con ?probe=expenses.
  //   ?compras=1&dry=1  -> muestra lo que guardaría (y compara con el monto del gasto) sin escribir
  //   ?compras=1        -> guarda en la tabla compras
  //   &precio=total     -> si expenseItem.price es el total de la línea (por defecto es precio unitario)
  if (url.searchParams.get("compras") === "1") {
    try {
      const dry = url.searchParams.get("dry") === "1";
      const precioTotal = url.searchParams.get("precio") === "total";
      const { data: gastos, included } = await fudoList(token, "expenses", {
        include: "expenseItems,expenseItems.ingredient,provider",
        "filter[date]": `and(gte.${desde},lte.${hasta})`,
      });
      const eItems = new Map(included.filter((x) => x.type === "ExpenseItem").map((x) => [String(x.id), x]));
      const provs = new Map(included.filter((x) => x.type === "Provider").map((x) => [String(x.id), String(x.attributes?.name ?? "")]));
      const { data: insumos } = await db.from("insumos").select("id,fudo_ingredient_id");
      const idPorFudo = new Map((insumos ?? []).filter((i) => i.fudo_ingredient_id).map((i) => [i.fudo_ingredient_id, i.id]));

      const filas: any[] = [];
      const control: any[] = [];
      let sinInsumo = 0;
      for (const g of gastos) {
        if (g.attributes?.canceled) continue;
        let suma = 0;
        for (const ref of g.relationships?.expenseItems?.data ?? []) {
          const it = eItems.get(String(ref.id));
          const cant = Number(it?.attributes?.quantity ?? 0);
          const precio = Number(it?.attributes?.price ?? 0);
          suma += precioTotal ? precio : cant * precio;
          const insId = idPorFudo.get(String(it?.relationships?.ingredient?.data?.id));
          if (!insId) { sinInsumo++; continue; }
          if (!(cant > 0)) continue;
          filas.push({
            insumo_id: insId,
            cantidad: cant,
            precio_unit: precioTotal ? precio / cant : precio,
            fecha: String(g.attributes?.date ?? "").slice(0, 10),
            proveedor: provs.get(String(g.relationships?.provider?.data?.id)) || null,
            fudo_expense_id: `${g.id}-${ref.id}`,
          });
        }
        control.push({ gasto: g.id, monto: g.attributes?.amount, suma_items: Math.round(suma * 100) / 100 });
      }
      if (!dry) {
        for (let i = 0; i < filas.length; i += 500) {
          const { error } = await db.from("compras").upsert(filas.slice(i, i + 500), { onConflict: "fudo_expense_id" });
          if (error) throw new Error(error.message);
        }
        await log("compras", filas.length);
      }
      resultado.compras_lineas = filas.length;
      resultado.compras_items_sin_insumo = sinInsumo;
      if (dry) return json({ ok: true, dry: true, ...resultado, muestra: filas.slice(0, 5), control: control.slice(0, 8) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : JSON.stringify(e);
      await log("compras", 0, msg);
      return json({ ok: false, recurso: "compras", parcial: resultado, error: msg }, 500);
    }
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
