const db = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const $ = id => document.getElementById(id);
const money = n => '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
const num = n => (Number(n) || 0).toLocaleString('es-AR', { maximumFractionDigits: 2 });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mesLabel = d => new Date(d + 'T00:00:00').toLocaleDateString('es-AR', { month: 'short', year: 'numeric' });

const S = { precios: [], resumen: [], consumo: [], alertas: [], compras: [], sinMapear: [] };
let chartMes, chartHist;
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
  const [p, r, c, l, ins, al, co, sm] = await Promise.all([
    q('v_variacion_precios', { col: 'nombre' }),
    q('v_resumen_mensual', { col: 'mes' }),
    q('v_consumo_teorico', { col: 'mes', asc: false }),
    db.from('sync_log').select('created_at,error').order('created_at', { ascending: false }).limit(1),
    db.from('insumos').select('id,nombre,unidad'),
    db.from('v_alertas_insumos').select('*'), // existe desde supabase-costos-v2.sql
    db.from('v_compras_vs_consumo').select('*').order('mes', { ascending: false }), // supabase-compras.sql
    db.from('v_compras_sin_mapear').select('*').order('total', { ascending: false })
  ]);
  const err = [p, r, c].find(x => x.error);
  if (err) { $('msg').textContent = 'Error: ' + err.error.message; $('msg').classList.remove('hidden'); return; }
  S.precios = p.data; S.resumen = r.data; S.consumo = c.data;
  if (l.data?.[0]) $('sync').textContent = 'Última sync FUDO: ' + new Date(l.data[0].created_at).toLocaleString('es-AR') + (l.data[0].error ? ' (con error)' : '');
  // El consumo usa insumo_id; el nombre sale de la tabla insumos (incluye los que aún no tienen precio)
  const nombres = Object.fromEntries((ins.data || []).map(x => [x.id, x]));
  S.consumo = S.consumo.map(x => ({ ...x, nombre: nombres[x.insumo_id]?.nombre || x.insumo_id, unidad: nombres[x.insumo_id]?.unidad || '' }));
  S.alertas = al.data || [];
  S.compras = co.data || [];
  S.sinMapear = sm.data || [];
  renderResumen(); renderPrecios(); fillMeses(); renderAlertas(); renderCompras();
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

function renderResumen() {
  const u = S.resumen[S.resumen.length - 1];
  $('kpis').innerHTML = u ? [
    ['Ventas ' + mesLabel(u.mes), money(u.ventas)],
    ['Costo teórico', money(u.costo_teorico)],
    ['Costo s/ ventas (parcial)', u.ventas ? num(u.costo_teorico / u.ventas * 100) + '%' : '-'],
    ['Margen teórico', money(u.margen_teorico)]
  ].map(([a, b]) => `<div class="kpi"><small>${a}</small><b>${b}</b></div>`).join('') : '';
  $('tblMes').innerHTML = table([
    { h: 'Mes', f: r => mesLabel(r.mes) },
    { h: 'Ventas', n: 1, f: r => money(r.ventas) },
    { h: 'Costo teórico', n: 1, f: r => money(r.costo_teorico) },
    { h: 'Margen teórico', n: 1, f: r => money(r.margen_teorico) }
  ], [...S.resumen].reverse());
  chartMes?.destroy();
  chartMes = new Chart($('chartMes'), {
    type: 'bar',
    data: {
      labels: S.resumen.map(r => mesLabel(r.mes)),
      datasets: [
        { label: 'Ventas', data: S.resumen.map(r => r.ventas), backgroundColor: '#2D5F3F', borderRadius: 6 },
        { label: 'Costo teórico', data: S.resumen.map(r => r.costo_teorico), backgroundColor: '#E8A317', borderRadius: 6 }
      ]
    }
  });
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
    { h: 'Desde', f: r => esc(r.fecha_actual) }
  ], rows);
}

async function historial(id) {
  const ins = S.precios.find(x => x.insumo_id === id);
  const { data } = await db.from('precios_insumo').select('fecha,precio').eq('insumo_id', id).order('fecha');
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
  ['resumen', 'precios', 'consumo', 'compras', 'alertas'].forEach(s => $(s).classList.toggle('hidden', s !== t));
});
$('tblPrecios').addEventListener('click', e => { const id = e.target.dataset.h; if (id) { e.preventDefault(); historial(id); } });
['qPrecios', 'fPrecios'].forEach(i => $(i).addEventListener('input', renderPrecios));
$('mConsumo').addEventListener('change', renderConsumo);
$('mCompras').addEventListener('change', renderCompras);

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
