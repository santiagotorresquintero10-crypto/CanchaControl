/* ==========================================================
   CanchaControl — Historial y porcentaje de asistencia (HU-012)
   historial.html                       → Jugador: SU historial
   historial.html?jugador=ID&cat=CAT    → Entrenador: jugador de SU categoría
   ----------------------------------------------------------
   Solo lectura. La MISMA tarjeta 3D de HU-011 (modo presentación, sin botones).
   Los IDs de la URL no autorizan nada: el entrenador debe ser el entrenador
   actual de esa categoría y el jugador debe estar HOY en su nómina; además las
   reglas solo le entregan sesiones de sus categorías.
   ========================================================== */
import { protectPage } from "./authGuard.js";
import { ROLE } from "./permissions.js";
import { auth, db } from "./auth.js";
import { mountShell } from "./shell.js";
import { initFilterCards } from "./ui.js";
import { getFoto } from "./jugadores-data.js";
import { contextoJugador } from "./mi-jugador.js";
import { createPlayer3DCard, setCardBadge, setCardPhoto, stateIcon, posAbbr } from "./player-card.js";
import { MSG, PERIODOS, rangoPeriodo, enRango, resumen, historialJugador, historialEntrenador, categoriasDe, cubetas } from "./historial-data.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const MES_C = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const DIA = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const toD = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const KEY = { "Asistió": "ok", "Falta": "falta", "Excusa": "excusa", "Atraso": "atraso" };

const st = {
  role: null, uid: null, me: null, jugadorId: null, player: null, cats: [],
  periodo: "tres", custom: { desde: "", hasta: "" }, rango: null,
  all: null,            // Jugador: historial completo (se filtra por período en memoria)
  regs: [],             // registros del período actual
  filtro: "", gran: "mes", seq: 0, card: null,
  error: null,          // si la carga falló, NADA se presenta como "sin registros"
};

protectPage({
  page: "historial",
  onReady(profile) {
    st.me = profile; st.uid = auth.currentUser?.uid;
    st.role = profile.rol === ROLE.JUGADOR ? "player" : profile.rol === ROLE.ENTRENADOR ? "coach" : null;
    mountShell(profile, st.role === "coach" ? "jugadores" : "historial");
    if (!st.role || !st.uid || st.uid !== profile.uid) return fatal(MSG.sinPermiso);
    try { const g = localStorage.getItem("cc-hist-gran"); if (g === "semana" || g === "mes") st.gran = g; } catch { /* opcional */ }
    buildPeriod(); wire();
    start().catch((err) => {
      console.error("[CanchaControl] Historial:", err?.code || err);
      fatal(err?.code === "permission-denied" ? MSG.sinPermiso : MSG.error, "", err?.code !== "permission-denied");
    });
  },
});

/* ---------------- Arranque según rol ---------------- */
async function start() {
  if (st.role === "player") {
    const ctx = await contextoJugador(st.uid);
    if (ctx.estado === "sin-expediente") return fatal(MSG.sinExpediente, "Comunícate con la administración de la escuela.");
    const j = ctx.jugador;
    st.jugadorId = j.id;
    st.player = { id: j.id, nombres: j.nombres, apellidos: j.apellidos, numeroCamiseta: j.numeroCamiseta, posicion: j.posicion,
      categoria: ctx.categoria?.nombre ?? "Sin categoría", foto: null };
  } else {
    $("back-link").hidden = false;
    const p = new URLSearchParams(location.search);
    const jid = p.get("jugador"), cat = p.get("cat");
    if (!ID_RE.test(jid ?? "") || !ID_RE.test(cat ?? "")) return fatal(MSG.sinPermiso, "Abre el historial desde Mis jugadores.");
    let c, f;
    try {
      c = await getDoc(doc(db, "categorias", cat));
      if (!c.exists() || c.data().entrenadorId !== st.uid) return fatal(MSG.sinPermiso, "Solo puedes consultar jugadores de tus categorías.");
      f = await getDoc(doc(db, "categorias", cat, "nomina", jid));
    } catch (err) { if (err?.code === "permission-denied") return fatal(MSG.sinPermiso, "Solo puedes consultar jugadores de tus categorías."); throw err; }
    if (!f.exists()) return fatal(MSG.sinPermiso, "El jugador ya no pertenece a tu categoría.");
    const fd = f.data();
    st.jugadorId = jid;
    st.cats = await categoriasDe(st.uid);
    st.player = { id: jid, nombres: fd.nombres ?? "", apellidos: fd.apellidos ?? "", numeroCamiseta: fd.numeroCamiseta ?? null, posicion: fd.posicion ?? "",
      categoria: c.data().nombre ?? "", foto: null };
    const nombre = `${st.player.nombres} ${st.player.apellidos}`.trim();
    $("hp-title").textContent = "Historial de asistencia";
    $("hp-sub").textContent = `Entrenamientos, estadísticas y evolución de ${nombre} en tus categorías.`;
    $("stats-title").textContent = "Estadísticas de asistencia";
    $("chart-title").textContent = "Evolución de asistencia";
    $("tl-title").textContent = "Entrenamientos y asistencias";
    document.title = `Historial de ${nombre} · CanchaControl`;
  }
  renderCard();
  getFoto(st.jugadorId).then((f) => { if (f && st.card) { st.player.foto = f; setCardPhoto(st.card, st.player); } }).catch(() => {});
  await load();
}

/* ---------------- Tarjeta 3D (Player3DCard, modo presentación) ---------------- */
function renderCard() {
  st.card = createPlayer3DCard(st.player, null, { presentational: true });
  $("card-slot").replaceChildren(st.card);
  setCardBadge(st.card, "pend", "Asistencia");   // nunca "Sin marcar" en el perfil
  const pos = st.player.posicion && st.player.posicion !== "Por definir" ? st.player.posicion : "Posición por definir";
  $("card-cap").textContent = `${st.player.categoria} · ${pos}${st.player.numeroCamiseta !== null ? ` · Dorsal ${st.player.numeroCamiseta}` : ""}`;
}
function paintCardBadge(res) {
  if (!st.card) return;
  if (res.pct === null) setCardBadge(st.card, "pend", "Sin datos");
  else setCardBadge(st.card, "ok", `${res.pct} % asistencia`, "Asistió");
}

/* ---------------- Período ---------------- */
function buildPeriod() {
  const g = $("period");
  for (const p of PERIODOS) {
    const b = el("button", "hp-seg__btn", p.label); b.type = "button"; b.dataset.period = p.key;
    b.setAttribute("aria-pressed", String(p.key === st.periodo));
    b.addEventListener("click", () => selectPeriod(p.key));
    g.append(b);
  }
}
function selectPeriod(key) {
  st.periodo = key;
  document.querySelectorAll(".hp-seg__btn").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.period === key)));
  $("range-form").hidden = key !== "rango";
  $("range-err").textContent = "";
  if (key === "rango") { $("r-desde").focus(); if (!st.custom.desde || !st.custom.hasta) return; }
  load();
}
function periodLabel(r) {
  const f = (iso) => { const d = toD(iso); return `${d.getDate()} ${MES_C[d.getMonth()]} ${d.getFullYear()}`; };
  if (!r.desde && !r.hasta) return "Mostrando todo el historial.";
  return `Mostrando del ${r.desde ? f(r.desde) : "inicio"} al ${r.hasta ? f(r.hasta) : "hoy"}.`;
}

/* ---------------- Carga (sin mezclar períodos) ---------------- */
async function load() {
  const seq = ++st.seq;
  const r = rangoPeriodo(st.periodo, st.custom);
  st.rango = r;
  $("period-label").textContent = periodLabel(r);
  loading();
  try {
    let regs;
    if (st.role === "player") {
      if (!st.all) st.all = await historialJugador(st.jugadorId);   // una sola consulta; los cambios de período no vuelven a consultar
      regs = st.all.filter((x) => enRango(x.fecha, r) || (x.incompleto && !r.desde && !r.hasta));
    } else {
      regs = await historialEntrenador(st.jugadorId, st.cats, r);
    }
    if (seq !== st.seq) return;                                      // llegó otro período mientras tanto
    st.regs = regs; st.error = null;
    $("hp-state").hidden = true; $("hp-body").hidden = false;
    render();
  } catch (err) {
    if (seq !== st.seq) return;
    // Mensaje completo en la consola (si falta el índice, Firestore incluye el enlace para crearlo).
    console.error("[CanchaControl] Historial:", err?.code, err?.message || err);
    if (err?.code === "failed-precondition") {
      console.warn("[CanchaControl] Falta el índice de Firestore para el historial (asistencias · jugadorId · grupo de colecciones). "
        + "Créalo con el enlace anterior o con: firebase deploy --only firestore:indexes");
    }
    st.regs = [];
    st.error = err?.code === "permission-denied" ? MSG.sinPermiso : MSG.error;
    // No se muestran resultados parciales como definitivos
    showError(st.error);
    if (st.card) setCardBadge(st.card, "pend", "Sin datos");
  }
}

function loading() {
  ["k-total", "k-ok", "k-falta", "k-excusa", "k-atraso"].forEach((k) => { $(k).innerHTML = '<span class="skel" style="width:34px;height:26px;display:inline-block"></span>'; });
  $("ring-value").innerHTML = '<span class="skel" style="width:70px;height:34px;display:inline-block"></span>';
  $("chart").innerHTML = '<div class="skel" style="height:220px"></div>';
  $("timeline").innerHTML = '<div class="skel" style="height:64px;margin-bottom:10px"></div><div class="skel" style="height:64px;margin-bottom:10px"></div><div class="skel" style="height:64px"></div>';
}

/* ---------------- Render ---------------- */
function render() {
  const res = resumen(st.regs);
  $("k-total").textContent = res.total; $("k-ok").textContent = res.ok; $("k-falta").textContent = res.falta;
  $("k-excusa").textContent = res.excusa; $("k-atraso").textContent = res.atraso;
  renderRing(res); paintCardBadge(res);
  renderChart(); renderTimeline();
}

function renderRing(res) {
  const bar = $("ring-bar"), C = 2 * Math.PI * 50;
  bar.style.strokeDasharray = `${C}`;
  const ring = $("ring");
  if (res.pct === null) {
    ring.classList.add("is-empty");
    $("ring-value").textContent = MSG.sinDatos; $("ring-label").textContent = "";
    bar.style.strokeDashoffset = `${C}`;
    $("ring-note").textContent = res.total ? "Solo hay excusas en este período: no afectan el porcentaje." : "No hay registros en este período.";
    ring.setAttribute("aria-label", MSG.sinDatos);
    return;
  }
  ring.classList.remove("is-empty");
  $("ring-value").textContent = `${res.pct} %`; $("ring-label").textContent = "Asistencia";
  $("ring-note").textContent = `${res.ok + res.atraso} de ${res.evaluables} sesiones evaluables${res.excusa ? ` · ${res.excusa} con excusa (no cuentan)` : ""}`;
  ring.setAttribute("aria-label", `Asistencia ${res.pct} por ciento`);
  const target = C * (1 - res.pct / 100);
  if (reduce()) { bar.style.transition = "none"; bar.style.strokeDashoffset = `${target}`; return; }
  bar.style.transition = "none"; bar.style.strokeDashoffset = `${C}`;
  requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.transition = ""; bar.style.strokeDashoffset = `${target}`; }));
}

/* ---------- Gráfico de barras apiladas (HTML/CSS, sin librerías) ---------- */
const SERIES = [["Asistió", "ok", "Asistió"], ["Atraso", "atraso", "Atraso"], ["Excusa", "excusa", "Excusa"], ["Falta", "falta", "Falta"]];
function renderChart() {
  const box = $("chart");
  document.querySelectorAll("[data-gran]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.gran === st.gran)));
  const cs = cubetas(st.regs, st.gran, st.rango ?? {});
  if (!st.regs.length || !cs.length) {
    box.replaceChildren(emptyBox("chart", "Sin datos para graficar", "Cuando haya registros de asistencia en el período, aquí verás su evolución."));
    return;
  }
  const max = Math.max(1, ...cs.map((c) => c.res.total));
  const ticks = [max, Math.round(max / 2), 0].filter((v, i, a) => a.indexOf(v) === i);
  const wrap = el("div", "hp-chart__wrap");
  const axis = el("div", "hp-chart__axis"); axis.setAttribute("aria-hidden", "true");
  ticks.forEach((t) => { const s = el("span", "", String(t)); s.style.bottom = `${(t / max) * 100}%`; axis.append(s); });
  const plot = el("div", "hp-chart__plot");
  ticks.forEach((t) => { const g = el("span", "hp-chart__grid"); g.style.bottom = `calc(26px + ${(t / max) * 210}px)`; plot.append(g); });
  const cols = el("div", "hp-chart__cols"); cols.style.setProperty("--n", cs.length);
  if (cs.length > 14) cols.classList.add("is-dense");
  for (const c of cs) {
    const col = el("div", "hp-col");
    const pct = el("span", "hp-col__pct", c.res.pct === null ? "" : `${c.res.pct}%`);
    const stack = el("div", "hp-col__stack"); stack.style.height = `${(c.res.total / max) * 100}%`;
    stack.tabIndex = c.res.total ? 0 : -1;
    for (const [estado, key] of SERIES) {
      const n = c.res[key]; if (!n) continue;
      const seg = el("span", `hp-col__seg hp-sw--${key}`); seg.style.flexGrow = String(n);
      stack.append(seg);
    }
    const tipTxt = `${c.largo}: ${c.res.total} ${c.res.total === 1 ? "sesión" : "sesiones"} · Asistió ${c.res.ok} · Atraso ${c.res.atraso} · Excusa ${c.res.excusa} · Falta ${c.res.falta}${c.res.pct === null ? "" : ` · ${c.res.pct} %`}`;
    stack.setAttribute("aria-label", tipTxt);
    tip(stack, tipTxt);
    const bar = el("div", "hp-col__bar"); bar.append(pct, stack);
    col.append(bar, el("span", "hp-col__lbl", c.label));
    cols.append(col);
  }
  plot.append(cols);
  wrap.append(axis, plot);
  box.replaceChildren(wrap);
}
function tip(target, text) {
  const t = $("hp-tip");
  const show = () => {
    t.textContent = text; t.hidden = false;
    const r = target.getBoundingClientRect();
    let x = r.left + r.width / 2 - t.offsetWidth / 2; x = Math.max(8, Math.min(x, innerWidth - t.offsetWidth - 8));
    let y = r.top - t.offsetHeight - 8; if (y < 8) y = r.bottom + 8;
    t.style.left = `${x}px`; t.style.top = `${y}px`;
  };
  const hide = () => { t.hidden = true; };
  target.addEventListener("mouseenter", show); target.addEventListener("mouseleave", hide);
  target.addEventListener("focus", show); target.addEventListener("blur", hide);
}

/* ---------- Línea de tiempo ---------- */
function renderTimeline() {
  if (st.error) return;                      // tras un error se mantiene el mensaje (nunca "Sin registros")
  const box = $("timeline");
  const list = st.regs.filter((r) => !st.filtro || r.estado === st.filtro);
  $("tl-count").textContent = st.regs.length ? `${list.length} de ${st.regs.length}` : "";
  if (!st.regs.length) {
    box.replaceChildren(emptyBox("calendar", MSG.vacioTitulo, st.role === "player" ? MSG.vacio : MSG.vacioCoach));
    return;
  }
  if (!list.length) { box.replaceChildren(emptyBox("filter", "Sin registros con este estado", "Elige otra tarjeta para ver más registros del período.")); return; }
  const frag = [];
  let mesActual = "";
  let ul = null;
  for (const r of list) {
    const d = r.fecha ? toD(r.fecha) : null;
    const mk = d ? `${MES[d.getMonth()]} ${d.getFullYear()}` : "Sin fecha";
    if (mk !== mesActual) {
      mesActual = mk;
      const h = el("h3", "hp-tl__month", mk[0].toUpperCase() + mk.slice(1));
      ul = el("ol", "hp-tl__list");
      frag.push(h, ul);
    }
    const li = el("li", `hp-tl__item is-${KEY[r.estado] ?? "pend"}`);
    const date = el("div", "hp-tl__date");
    date.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><line x1="3.5" y1="10" x2="20.5" y2="10"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/></svg>';
    if (d) { date.append(el("strong", "", String(d.getDate())), el("span", "", `${DIA[d.getDay()]} · ${MES_C[d.getMonth()]}`)); }
    else date.append(el("strong", "", "—"));
    const main = el("div", "hp-tl__main");
    main.append(el("p", "hp-tl__cat", r.categoriaNombre || "Categoría"));
    const meta = el("p", "hp-tl__meta");
    if (r.incompleto) meta.textContent = "Datos de la sesión no disponibles";
    else meta.append(piece("clock", `${r.horaInicio} – ${r.horaFin}`), piece("pin", r.lugar));
    main.append(meta);
    const badge = el("span", `hp-badge is-${KEY[r.estado] ?? "pend"}`); badge.innerHTML = stateIcon(r.estado, 14); badge.append(el("span", "", r.estado));
    li.append(date, main, badge);
    ul.append(li);
  }
  box.replaceChildren(...frag);
}
function piece(icon, text) {
  const s = el("span");
  const ic = icon === "clock" ? '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>' : '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>';
  s.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">${ic}</svg>`;
  s.append(document.createTextNode(text)); return s;
}

/* ---------- Estados ---------- */
const EMPTY_ICON = {
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><line x1="3.5" y1="10" x2="20.5" y2="10"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/>',
  chart: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4-2v-4z"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  alert: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="13"/><circle cx="12" cy="16.5" r=".6" fill="currentColor"/>',
};
function emptyBox(icon, title, text) {
  const e = el("div", "empty hp-empty");
  const i = el("div", "state__icon"); i.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${EMPTY_ICON[icon]}</svg>`;
  e.append(i, el("p", "empty__title", title)); if (text) e.append(el("p", "empty__text", text));
  return e;
}
function showError(msg) {
  ["k-total", "k-ok", "k-falta", "k-excusa", "k-atraso"].forEach((k) => { $(k).textContent = "–"; });
  $("ring-value").textContent = "–"; $("ring-label").textContent = ""; $("ring-note").textContent = "";
  $("chart").replaceChildren(emptyBox("alert", msg, ""));
  const box = emptyBox("alert", msg, "");
  const b = el("button", "btn btn-primary empty__btn", "Intentar de nuevo"); b.type = "button";
  b.addEventListener("click", () => { st.all = null; st.error = null; load(); }); box.append(b);
  $("timeline").replaceChildren(box);
  $("tl-count").textContent = "";
}
function fatal(title, text = "", retry = false) {
  $("hp-body").hidden = true;
  document.querySelector(".hp-period").hidden = true;
  const s = $("hp-state"); s.hidden = false;
  const box = emptyBox(retry ? "alert" : "lock", title, text);
  if (retry) { const b = el("button", "btn btn-primary empty__btn", "Intentar de nuevo"); b.type = "button"; b.addEventListener("click", () => location.reload()); box.append(b); }
  s.replaceChildren(box);
}

/* ---------------- Eventos ---------------- */
function wire() {
  initFilterCards($("hp-kpis"), (v) => { st.filtro = v; renderTimeline(); }, "");
  document.querySelectorAll("[data-gran]").forEach((b) => b.addEventListener("click", () => {
    st.gran = b.dataset.gran; renderChart();
    try { localStorage.setItem("cc-hist-gran", st.gran); } catch { /* opcional */ }
  }));
  $("range-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const d = $("r-desde").value, h = $("r-hasta").value;
    $("range-err").textContent = "";
    if (!d || !h) { $("range-err").textContent = "Selecciona la fecha inicial y la final."; return; }
    if (d > h) { $("range-err").textContent = MSG.rango; $("r-desde").setAttribute("aria-invalid", "true"); return; }
    $("r-desde").setAttribute("aria-invalid", "false");
    st.custom = { desde: d, hasta: h };
    load();
  });
}
