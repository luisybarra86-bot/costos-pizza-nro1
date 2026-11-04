const db = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const $ = id => document.getElementById(id);
const money = n => '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
const num = n => (Number(n) || 0).toLocaleString('es-AR', { maximumFractionDigits: 2 });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mesLabel = d => new Date(d + 'T00:00:00').toLocaleDateString('es-AR', { month: 'short', year: 'numeric' });

const S = { precios: [], consumo: [], alertas: [], compras: [], sinMapear: [], ventas: null };
let chartHist;
Chart.defaults.font.family = "'Poppins', system-ui, sans-serif";
Chart.defaults.color = '#8a8a8a';

// Todas las tablas son compactas: menos espacio entre columnas y los textos largos pasan a la línea siguiente
function table(cols, rows, cls = 'compacta') {
  if (!rows.length) return '<div class="empty">Sin datos todavía.</div>';
  const head = cols.map(c => `<th class="${c.n ? 'n' : ''}">${c.h}</th>`).join('');
  // c.w = columna de texto largo: puede ocupar varias líneas
  const body = rows.map(r => '<tr>' + cols.map(c => `<td class="${c.n ? 'n' : ''}${c.w ? ' largo' : ''}" data-l="${esc(c.h)}"><span>${c.f(r)}</span></td>`).join('') + '</tr>').join('');
  // Con 5 columnas o más, en celular cada fila pasa a ser una tarjeta (ver CSS "apila")
  return `<table class="${cls}${cols.length >= 5 ? ' apila' : ''}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

async function cargar() {
  const q = (t, o) => db.from(t).select('*').order(o.col, { ascending: o.asc ?? true });
  const [p, c, l, ins, al, co, sm, pc, rv, mk] = await Promise.all([
    q('v_variacion_precios', { col: 'nombre' }),
    q('v_consumo_teorico', { col: 'mes', asc: false }),
    db.from('sync_log').select('created_at,error').order('created_at', { ascending: false }).limit(1),
    db.from('insumos').select('id,nombre,unidad'),
    db.from('v_alertas_insumos').select('*'), // existe desde supabase-costos-v2.sql
    db.from('v_compras_vs_consumo').select('*').order('mes', { ascending: false }), // supabase-compras.sql
    db.from('v_compras_sin_mapear').select('*').order('total', { ascending: false }),
    db.from('v_precios_compra_producto').select('*').order('fecha', { ascending: false }), // supabase-precios-compra.sql
    db.from('v_cargas_revisar').select('*').order('fecha', { ascending: false }), // supabase-cargas.sql
    db.from('revisiones_marcadas').select('clave') // supabase-revisiones.sql
  ]);
  const err = [p, c].find(x => x.error);
  if (err) { $('msg').textContent = 'Error: ' + err.error.message; $('msg').classList.remove('hidden'); return; }
  S.precios = p.data; S.consumo = c.data;
  if (l.data?.[0]) $('sync').textContent = 'Última sync FUDO: ' + new Date(l.data[0].created_at).toLocaleString('es-AR') + (l.data[0].error ? ' (con error)' : '');
  // El consumo usa insumo_id; el nombre sale de la tabla insumos (incluye los que aún no tienen precio)
  const nombres = Object.fromEntries((ins.data || []).map(x => [x.id, x]));
  S.consumo = S.consumo.map(x => ({ ...x, nombre: nombres[x.insumo_id]?.nombre || x.insumo_id, unidad: nombres[x.insumo_id]?.unidad || '' }));
  S.alertas = al.data || [];
  S.compras = co.data || [];
  S.sinMapear = sm.data || [];
  S.prodCompra = pc.data || [];
  const provs = [...new Set(S.prodCompra.map(x => x.proveedor).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  $('fProv').innerHTML = '<option value="">Todos los proveedores</option>' + provs.map(x => `<option>${esc(x)}</option>`).join('');
  S.revisar = rv.data || [];
  S.marcadas = new Set((mk.data || []).map(x => x.clave));
  const provRev = [...new Set(S.revisar.map(x => x.proveedor).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  $('fRevProv').innerHTML = '<option value="">Todos los proveedores</option>' + provRev.map(x => `<option>${esc(x)}</option>`).join('');
  renderPrecios(); renderProdCompra(); fillMeses(); renderAlertas(); renderCompras(); renderRevisar();
  cargarVentas();
}

// Cargas para revisar (supabase-cargas.sql): monto que no cierra, líneas sin producto y precios fuera de lo habitual
// Clave estable de un aviso: si la carga cambia (otros montos o producto), el aviso nuevo vuelve a aparecer sin tilde
const claveRev = r => [r.motivo, r.fecha, r.comprobante || '', r.producto || '', r.detalle || '',
  Math.round(r.suma_lineas || 0), Math.round(r.monto || 0), Math.round(r.total || 0)].join('|');

async function marcarRevision(clave, marcar) {
  const msg = $('revMsg');
  const q = db.from('revisiones_marcadas');
  const { error } = marcar ? await q.insert({ clave }) : await q.delete().eq('clave', clave);
  if (error) {
    msg.textContent = 'No se pudo guardar el tilde: ' + error.message + ' (falta ejecutar supabase-revisiones.sql en Supabase).';
    msg.classList.remove('hidden');
    return false;
  }
  msg.classList.add('hidden');
  if (marcar) S.marcadas.add(clave); else S.marcadas.delete(clave);
  return true;
}

// Los avisos se agrupan por factura (fecha + proveedor + comprobante): una fila por factura con todo lo que hay que revisar.
// El tilde es por factura; si cambia algo de sus avisos (otros montos o producto), la fila vuelve sin tilde.
const hashRev = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
const ORDEN_REV = { sin_producto: 0, monto: 1, dudosa: 2, precio: 3 };
function gruposRev(avisos) {
  const m = new Map();
  for (const a of avisos) {
    const base = `${a.fecha}|${a.proveedor || ''}|${a.comprobante || ''}`;
    if (!m.has(base)) m.set(base, { base, fecha: a.fecha, proveedor: a.proveedor, comprobante: a.comprobante, items: [] });
    m.get(base).items.push(a);
  }
  return [...m.values()].map(g => {
    g.items.sort((x, y) => (ORDEN_REV[x.motivo] ?? 9) - (ORDEN_REV[y.motivo] ?? 9));
    g.clave = 'g:' + g.base + '#' + hashRev(g.items.map(claveRev).sort().join('||'));
    return g;
  }).sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
}

function renderRevisar() {
  const marcadas = S.marcadas || new Set();
  const dEsc = n => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
  const todos = gruposRev(S.revisar || []);
  // El contador de la pestaña cuenta las facturas pendientes de los últimos 60 días
  const corte60 = dEsc(60);
  const pendientes = todos.filter(g => g.fecha >= corte60 && !marcadas.has(g.clave));
  $('nRevisar').textContent = pendientes.length ? `(${pendientes.length})` : '';
  const mot = $('fRevMotivo').value, pv = $('fRevProv').value, vista = $('fRevVista').value, per = $('fRevPeriodo').value;
  const corte = per === 'todo' ? '0000-00-00' : dEsc(Number(per));
  const agrupa = m => (m === 'dudosa' ? 'precio' : m);
  const rows = todos.filter(g => g.fecha >= corte && (!pv || g.proveedor === pv)
    && (!mot || g.items.some(x => agrupa(x.motivo) === mot))
    && (vista === 'todas' || (vista === 'marcadas') === marcadas.has(g.clave)));
  const etiqueta = { monto: 'El monto no cierra', sin_producto: 'Línea sin producto', precio: 'Precio fuera de lo habitual', dudosa: 'Cantidad que no encaja' };
  const detalle = r => {
    if (r.motivo === 'monto') {
      const tip = r.tipica ? `; lo normal con este proveedor es ${num(r.tipica)}` : '';
      return `Las líneas suman ${money(r.suma_lineas)} y el monto es ${money(r.monto)} (monto ÷ líneas = ${num(r.razon)}${tip}). Revisá cantidades, precios o el monto: tiene que ser el total de la factura y las líneas, el neto.`;
    }
    if (r.motivo === 'sin_producto') {
      return `${num(r.cantidad)} línea(s) sin producto por ${money(r.total)}${r.detalle ? ': ' + esc(r.detalle) : ''}. Elegí el producto o, si era una prueba, cancelá la línea.`;
    }
    if (r.motivo === 'dudosa') {
      return `${esc(r.producto)}: cantidad ${num(r.cantidad)} por ${money(r.total)}. El precio no coincide ni con unidades ni con bultos; revisá la cantidad o el total.`;
    }
    return `${esc(r.producto)}: ${num(r.cantidad)} por ${money(r.total)} = ${money(r.precio_unit)} por unidad; lo habitual ronda ${money(r.mediana)}.`;
  };
  const lista = g => g.items.map(x => `• ${detalle(x)}`).join('<br>');
  $('tblRevisar').innerHTML = rows.length ? table([
    { h: 'Fecha', f: g => esc(g.fecha) },
    { h: 'Proveedor', f: g => esc(g.proveedor || '-') },
    { h: 'Comprobante', f: g => esc(g.comprobante || '-') },
    { h: 'Avisos', f: g => [...new Set(g.items.map(x => etiqueta[x.motivo] || x.motivo))].map(t => `<span class="chip">${esc(t)}</span>`).join(' ') },
    { h: 'Qué revisar', w: 1, f: g => marcadas.has(g.clave) ? `<span class="hecho">${lista(g)}</span>` : lista(g) },
    { h: 'Resuelto', n: 1, f: g => `<input type="checkbox" class="tilde" data-k="${encodeURIComponent(g.clave)}" ${marcadas.has(g.clave) ? 'checked' : ''} title="Marcar la factura como resuelta">` }
  ], rows) : `<div class="empty">${vista === 'marcadas' ? 'Todavía no marcaste ninguna como resuelta.' : 'No hay facturas pendientes para revisar en este período. 👌'}</div>`;
}

// Precios de compra por producto (lo que se carga en las facturas de FUDO, esté o no asociado a un insumo)
function renderProdCompra() {
  const q = $('qProd').value.toLowerCase(), pv = $('fProv').value;
  const rows = (S.prodCompra || []).filter(x => x.producto_nombre.toLowerCase().includes(q) && (!pv || x.proveedor === pv));
  $('tblProdCompra').innerHTML = table([
    { h: 'Producto', f: r => `<a href="#" data-p="${esc(r.fudo_product_id)}">${esc(r.producto_nombre)}</a>` + (r.unidades_por_bulto ? ` <small title="Los precios van por unidad: la cantidad se llevó a botellas">(bulto x${num(r.unidades_por_bulto)})</small>` : '') },
    { h: 'Proveedor', f: r => esc(r.proveedor || '-') },
    { h: 'Fecha', f: r => r.fecha ? esc(r.fecha) : '-' },
    { h: 'Precio unit.', n: 1, f: r => r.precio_unit == null ? '<span title="Ninguna compra encaja con el precio esperado">dudoso</span>' : money(r.precio_unit) },
    { h: 'Variación', n: 1, f: r => r.variacion_pct != null
        ? `<span class="${r.variacion_pct > 0 ? 'up' : r.variacion_pct < 0 ? 'down' : ''}">${r.variacion_pct > 0 ? '▲' : r.variacion_pct < 0 ? '▼' : ''} ${num(r.variacion_pct)}%</span>`
        : (r.cambio_unidad ? '<span title="La cantidad se cargó en otra unidad que en la compra anterior">otra unidad</span>' : '-') },
    { h: 'Anterior', n: 1, f: r => r.precio_anterior == null ? '-' : money(r.precio_anterior) },
    { h: 'Cantidad', n: 1, f: r => r.cantidad == null ? '-' : num(r.cantidad) },
    { h: 'Total', n: 1, f: r => r.total == null ? '-' : money(r.total) },
    { h: 'Compras', n: 1, f: r => r.compras + (r.lineas_dudosas ? ` <small title="Líneas cuyo precio no encaja con la cantidad cargada; no entran en el precio">(+${r.lineas_dudosas} dud.)</small>` : '') }
  ], rows, 'compacta');
}

// ---- Ventas: modo (salón / take away / delivery), rubros, horarios y cajas. El cálculo se hace en la base (ventas_panel) ----
const MODOS = { DELIVERY: 'Delivery', TAKEAWAY: 'Take away', 'EAT-IN': 'Salón' };
const DIAS = ['', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const bar = (v, max) => `<span class="bar"><i style="width:${max ? Math.round(v / max * 100) : 0}%"></i></span>`;
let ventasReq = 0;

function rango() {
  const v = $('vPeriodo').value, hoy = new Date(), h = iso(hoy);
  const atras = n => { const d = new Date(hoy); d.setDate(d.getDate() - n); return iso(d); };
  if (v === 'hoy') return [h, h];
  if (v === '7') return [atras(6), h];
  if (v === '30') return [atras(29), h];
  if (v === 'mes') return [iso(new Date(hoy.getFullYear(), hoy.getMonth(), 1)), h];
  return ['2000-01-01', h];
}

async function cargarVentas() {
  const req = ++ventasReq, [d, h] = rango();
  const { data, error } = await db.rpc('ventas_panel', { p_desde: d, p_hasta: h, p_modo: $('vModo').value || null });
  if (req !== ventasReq) return; // llegó una consulta más nueva
  const msg = $('vMsg');
  if (error) { msg.textContent = 'No se pudieron cargar las ventas: ' + error.message; msg.classList.remove('hidden'); return; }
  msg.classList.add('hidden');
  S.ventas = data;
  renderVentas();
}

function renderVentas() {
  const v = S.ventas; if (!v) return;
  const totalMonto = v.por_modo.reduce((a, m) => a + Number(m.monto), 0);
  $('vModos').innerHTML = v.por_modo.length ? v.por_modo.map(m => `<div class="kpi"><small>${MODOS[m.tipo] || esc(m.tipo)}</small><b>${money(m.monto)}</b>
    <div class="sub">${num(m.ventas)} ventas · ticket ${money(m.ticket)} · ${totalMonto ? num(m.monto / totalMonto * 100) : 0}%</div></div>`).join('')
    : '<div class="empty">No hay ventas en este período.</div>';

  const maxR = Math.max(0, ...v.por_rubro.map(r => Number(r.monto)));
  $('tblRubro').innerHTML = table([
    { h: 'Rubro', f: r => esc(r.rubro) },
    { h: 'Unidades', n: 1, f: r => num(r.unidades) },
    { h: 'Monto', n: 1, f: r => money(r.monto) + bar(r.monto, maxR) }
  ], v.por_rubro);
  $('tblProd').innerHTML = table([
    { h: 'Producto', f: r => esc(r.producto) },
    { h: 'Rubro', f: r => esc(r.rubro) },
    { h: 'Unidades', n: 1, f: r => num(r.unidades) },
    { h: 'Monto', n: 1, f: r => money(r.monto) }
  ], v.productos);

  const maxD = Math.max(0, ...v.por_dia.map(r => Number(r.ventas)));
  $('tblDia').innerHTML = table([
    { h: 'Día', f: r => DIAS[r.dow] || r.dow },
    { h: 'Ventas', n: 1, f: r => num(r.ventas) + bar(r.ventas, maxD) },
    { h: 'Monto', n: 1, f: r => money(r.monto) }
  ], v.por_dia);
  const maxF = Math.max(0, ...v.por_franja.map(r => Number(r.ventas)));
  $('tblFranja').innerHTML = table([
    { h: 'Franja', f: r => esc(String(r.franja).replace(/^\d · /, '')) },
    { h: 'Ventas', n: 1, f: r => num(r.ventas) + bar(r.ventas, maxF) },
    { h: 'Monto', n: 1, f: r => money(r.monto) }
  ], v.por_franja);

  const c = v.cajas, dias = Number(v.dias) || 0, porDia = n => dias ? num(n / dias) + ' por día' : '';
  $('vCajas').innerHTML = [
    ['Cajas grandes', c.grande_est, porDia(c.grande_est) + ' · cargadas en FUDO: ' + num(c.grande_cargadas)],
    ['Cajas chicas', c.chica_est, porDia(c.chica_est) + ' · cargadas en FUDO: ' + num(c.chica_cargadas)]
  ].map(([a, n, s]) => `<div class="kpi"><small>${a}</small><b>${num(n)}</b><div class="sub">${s}</div></div>`).join('');
  $('tblCajasModo').innerHTML = table([
    { h: 'Modo', f: r => MODOS[r.tipo] || esc(r.tipo) },
    { h: 'Cajas grandes', n: 1, f: r => num(r.grande) },
    { h: 'Cajas chicas', n: 1, f: r => num(r.chica) }
  ], v.cajas_modo);
}

function renderCompras() {
  const m = $('mCompras').value;
  $('tblCompras').innerHTML = table([
    { h: 'Insumo', f: r => esc(r.nombre) },
    { h: 'Comprado', n: 1, f: r => num(r.cantidad_comprada) + ' ' + esc(r.unidad) },
    { h: 'Gasto neto', n: 1, f: r => money(r.costo_comprado) },
    { h: 'Precio prom.', n: 1, f: r => r.cantidad_comprada > 0 ? money(r.costo_comprado / r.cantidad_comprada) + '/' + esc(r.unidad) : '-' },
    { h: 'Consumo teórico', n: 1, f: r => num(r.cantidad_teorica) + ' ' + esc(r.unidad) },
    { h: 'Diferencia', n: 1, f: r => `<span class="${r.diferencia < 0 ? 'up' : ''}">${num(r.diferencia)}</span>` }
  ], S.compras.filter(r => r.mes === m).sort((a, b) => b.costo_comprado - a.costo_comprado));
  $('tblSinMapear').innerHTML = table([
    { h: 'Producto comprado', f: r => esc(r.producto_nombre) },
    { h: 'Veces', n: 1, f: r => r.veces },
    { h: 'Gasto neto', n: 1, f: r => money(r.total) }
  ], S.sinMapear.slice(0, 40));
}

function renderAlertas() {
  const neg = S.alertas.filter(a => a.tipo === 'stock_negativo').sort((a, b) => a.valor - b.valor);
  const sin = S.alertas.filter(a => a.tipo === 'sin_costo');
  $('nAlertas').textContent = S.alertas.length ? `(${S.alertas.length})` : '';
  $('tblStockNeg').innerHTML = table([
    { h: 'Insumo', f: r => esc(r.nombre) },
    { h: 'Stock en FUDO', n: 1, f: r => `<span class="up">${num(r.valor)} ${esc(r.unidad)}</span>` }
  ], neg);
  $('tblSinCosto').innerHTML = table([
    { h: 'Insumo', f: r => esc(r.nombre) },
    { h: 'Unidad', f: r => esc(r.unidad) }
  ], sin);
}

function renderPrecios() {
  const q = $('qPrecios').value.toLowerCase(), f = $('fPrecios').value;
  const rows = S.precios.filter(x => x.nombre.toLowerCase().includes(q) &&
    (!f || (f === 'up' ? x.variacion_pct > 0 : x.variacion_pct < 0)));
  $('tblPrecios').innerHTML = table([
    { h: 'Insumo', f: r => `<a href="#" data-h="${r.insumo_id}">${esc(r.nombre)}</a>` },
    { h: 'Unidad', f: r => esc(r.unidad) },
    { h: 'Anterior', n: 1, f: r => r.precio_anterior == null ? '-' : money(r.precio_anterior) },
    { h: 'Actual', n: 1, f: r => money(r.precio_actual) },
    { h: 'Variación', n: 1, f: r => r.variacion_pct == null ? '-' : `<span class="${r.variacion_pct > 0 ? 'up' : r.variacion_pct < 0 ? 'down' : ''}">${r.variacion_pct > 0 ? '▲' : r.variacion_pct < 0 ? '▼' : ''} ${num(r.variacion_pct)}%</span>` },
    { h: 'Fecha', f: r => esc(r.fecha_actual) },
    { h: 'Origen', f: r => r.fuente === 'factura' ? 'Factura' : 'Costo FUDO' }
  ], rows, 'compacta');
}

async function historial(id) {
  const ins = S.precios.find(x => x.insumo_id === id);
  const { data } = await db.from('v_historial_precios').select('fecha,precio').eq('insumo_id', id).order('fecha'); // supabase-precios.sql
  $('histTitle').textContent = 'Historial: ' + (ins?.nombre || '');
  dibujarHist((data || []).map(x => x.fecha), (data || []).map(x => x.precio));
}

// Historial de un producto comprado: precio por unidad de cada compra (sin las líneas dudosas)
async function historialProducto(id) {
  const prod = (S.prodCompra || []).find(x => x.fudo_product_id === id);
  const { data } = await db.from('v_compras_norm').select('fecha,total,unidades')
    .eq('fudo_product_id', id).not('unidades', 'is', null).order('fecha'); // supabase-bultos.sql
  $('histTitle').textContent = 'Historial: ' + (prod?.producto_nombre || '') + ' (precio por unidad)';
  dibujarHist((data || []).map(x => x.fecha), (data || []).map(x => Math.round(x.total / x.unidades * 100) / 100));
}

function dibujarHist(labels, values) {
  chartHist?.destroy();
  chartHist = new Chart($('chartHist'), {
    type: 'line',
    data: { labels, datasets: [{ label: 'Precio', data: values, borderColor: '#2D5F3F', backgroundColor: 'rgba(45,95,63,.12)', fill: true, pointBackgroundColor: '#2D5F3F', tension: .25 }] }
  });
  $('histTitle').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function fillMeses() {
  const opts = ms => ms.map(m => `<option value="${m}">${mesLabel(m)}</option>`).join('');
  const uniq = rows => [...new Set(rows.map(r => r.mes))].sort().reverse();
  $('mConsumo').innerHTML = opts(uniq(S.consumo));
  $('mCompras').innerHTML = opts(uniq(S.compras));
  renderConsumo();
}

function renderConsumo() {
  const m = $('mConsumo').value;
  $('tblConsumo').innerHTML = table([
    { h: 'Insumo', f: r => esc(r.nombre) },
    { h: 'Consumo teórico', n: 1, f: r => num(r.cantidad_teorica) + ' ' + esc(r.unidad) }
  ], S.consumo.filter(r => r.mes === m).sort((a, b) => b.cantidad_teorica - a.cantidad_teorica));
}

$('tabs').addEventListener('click', e => {
  const t = e.target.dataset.t; if (!t) return;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b === e.target));
  ['ventas', 'precios', 'consumo', 'compras', 'alertas', 'revisar'].forEach(s => $(s).classList.toggle('hidden', s !== t));
});
$('tblPrecios').addEventListener('click', e => { const id = e.target.dataset.h; if (id) { e.preventDefault(); historial(id); } });
['qPrecios', 'fPrecios'].forEach(i => $(i).addEventListener('input', renderPrecios));
['qProd', 'fProv'].forEach(i => $(i).addEventListener('input', renderProdCompra));
['fRevMotivo', 'fRevProv', 'fRevVista', 'fRevPeriodo'].forEach(i => $(i).addEventListener('change', renderRevisar));
$('tblRevisar').addEventListener('change', async e => {
  const k = e.target.dataset?.k; if (!k) return;
  const ok = await marcarRevision(decodeURIComponent(k), e.target.checked);
  if (!ok) e.target.checked = !e.target.checked; // no se pudo guardar: se deja como estaba
  renderRevisar();
});
$('tblProdCompra').addEventListener('click', e => { const id = e.target.dataset.p; if (id) { e.preventDefault(); historialProducto(id); } });
$('mConsumo').addEventListener('change', renderConsumo);
$('mCompras').addEventListener('change', renderCompras);
['vPeriodo', 'vModo'].forEach(i => $(i).addEventListener('change', cargarVentas));

// ---- Login (Supabase Auth). Sin sesión no se muestra ni se pide ningún dato ----
function mostrar(conSesion) {
  $('login').classList.toggle('hidden', conSesion);
  $('app').classList.toggle('hidden', !conSesion);
}
$('formLogin').addEventListener('submit', async e => {
  e.preventDefault();
  $('loginErr').textContent = '';
  const { error } = await db.auth.signInWithPassword({ email: $('lEmail').value.trim(), password: $('lPass').value });
  if (error) { $('loginErr').textContent = 'Email o contraseña incorrectos'; return; }
  $('lPass').value = '';
  mostrar(true);
  cargar();
});
$('btnSalir').addEventListener('click', async () => { await db.auth.signOut(); mostrar(false); });
db.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT') mostrar(false); });
(async () => {
  const { data } = await db.auth.getSession();
  mostrar(!!data.session);
  if (data.session) cargar();
})();
