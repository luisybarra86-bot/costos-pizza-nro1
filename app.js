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

function table(cols, rows) {
  if (!rows.length) return '<div class="empty">Sin datos todavía.</div>';
  const head = cols.map(c => `<th class="${c.n ? 'n' : ''}">${c.h}</th>`).join('');
  const body = rows.map(r => '<tr>' + cols.map(c => `<td class="${c.n ? 'n' : ''}">${c.f(r)}</td>`).join('') + '</tr>').join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

async function cargar() {
  const q = (t, o) => db.from(t).select('*').order(o.col, { ascending: o.asc ?? true });
  const [p, c, l, ins, al, co, sm] = await Promise.all([
    q('v_variacion_precios', { col: 'nombre' }),
    q('v_consumo_teorico', { col: 'mes', asc: false }),
    db.from('sync_log').select('created_at,error').order('created_at', { ascending: false }).limit(1),
    db.from('insumos').select('id,nombre,unidad'),
    db.from('v_alertas_insumos').select('*'), // existe desde supabase-costos-v2.sql
    db.from('v_compras_vs_consumo').select('*').order('mes', { ascending: false }), // supabase-compras.sql
    db.from('v_compras_sin_mapear').select('*').order('total', { ascending: false })
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
  renderPrecios(); fillMeses(); renderAlertas(); renderCompras();
  cargarVentas();
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
  ], rows);
}

async function historial(id) {
  const ins = S.precios.find(x => x.insumo_id === id);
  const { data } = await db.from('v_historial_precios').select('fecha,precio').eq('insumo_id', id).order('fecha'); // supabase-precios.sql
  $('histTitle').textContent = 'Historial: ' + (ins?.nombre || '');
  chartHist?.destroy();
  chartHist = new Chart($('chartHist'), {
    type: 'line',
    data: { labels: (data || []).map(x => x.fecha), datasets: [{ label: 'Precio', data: (data || []).map(x => x.precio), borderColor: '#2D5F3F', backgroundColor: 'rgba(45,95,63,.12)', fill: true, pointBackgroundColor: '#2D5F3F', tension: .25 }] }
  });
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
  ['ventas', 'precios', 'consumo', 'compras', 'alertas'].forEach(s => $(s).classList.toggle('hidden', s !== t));
});
$('tblPrecios').addEventListener('click', e => { const id = e.target.dataset.h; if (id) { e.preventDefault(); historial(id); } });
['qPrecios', 'fPrecios'].forEach(i => $(i).addEventListener('input', renderPrecios));
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
