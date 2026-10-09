/* ==========================================================
   CanchaControl — Mi rendimiento (HU-014)
   ----------------------------------------------------------
   Solo el Jugador, solo lectura. Identidad:
     Auth UID → users/{uid}.jugadorId → jugadores/{jugadorId}
   (nunca un ID de la URL). Datos: los registros de HU-013, por
   collectionGroup('rendimientos') filtrado por SU jugadorId; el detalle
   de un partido solo se lee al abrirlo (las reglas exigen que haya sido
   convocado). Reutiliza la tarjeta 3D (HU-011/012) y la cancha (HU-013).
   ========================================================== */
import { protectPage } from "./authGuard.js";
import { ROLE } from "./permissions.js";
import { auth } from "./auth.js";
import { mountShell } from "./shell.js";
import { getFoto } from "./jugadores-data.js";
import { contextoJugador } from "./mi-jugador.js";
import { createPlayer3DCard, setCardBadge, setCardPhoto } from "./player-card.js";
import { createPitch, ratingClass, ICON } from "./pitch.js";
import { createMascota } from "./mascota.js";
import { MSG, PERIODOS, rangoPeriodo, enRango, misRendimientos, datosPartido, detalleAlineacion, resumen, hitos } from "./rendimiento-data.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const MES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const MES_C = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const toD = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
const fCorta = (iso) => { if (!iso) return "Sin fecha"; const d = toD(iso); return `${d.getDate()} ${MES_C[d.getMonth()]} ${d.getFullYear()}`; };
const fLarga = (iso) => { if (!iso) return "Sin fecha"; const d = toD(iso); return `${d.getDate()} de ${MES[d.getMonth()]} de ${d.getFullYear()}`; };
const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const pl = (n, s, p) => `${n} ${n === 1 ? s : p}`;
const tone = (v) => ({ "is-red": "red", "is-orange": "orange", "is-green": "green", "is-gold": "gold" }[ratingClass(v)] ?? "");
const SVGNS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

const ICONS = {
  partido: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><line x1="12" y1="5" x2="12" y2="19"/><circle cx="12" cy="12" r="2.6"/></svg>',
  gol: ICON.ball, asistencia: ICON.boot,
  minutos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="13" r="8"/><polyline points="12 9 12 13 15 15"/><line x1="10" y1="2.5" x2="14" y2="2.5"/></svg>',
  amarilla: '<span class="mr-yc"></span>', roja: '<span class="mr-rc"></span>',
  valoracion: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z"/></svg>',
  goles: ICON.ball,
  pin: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  layers: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/></svg>',
};

/* Mensajes: positivos, sin comparaciones ni presión; los que mencionan datos se arman con datos reales. */
const FRASES = [
  ["¡Siuuu! ¡Sigue entrenando con disciplina!", "celebracion"],
  ["¡Siuuu! ¡La disciplina te hace crecer!", "celebracion"],
  ["La constancia construye campeones.", "motivacion"],
  ["Cada entrenamiento cuenta.", "motivacion"],
  ["El talento ayuda, pero la disciplina marca la diferencia.", "motivacion"],
  ["Los grandes resultados empiezan con pequeños esfuerzos.", "motivacion"],
  ["Sigue entrenando, sigue aprendiendo.", "aplausos"],
  ["Tu próximo partido es una nueva oportunidad.", "motivacion"],
  ["La constancia es tu mejor jugada.", "aplausos"],
  ["Un gran jugador también aprende de los días difíciles.", "motivacion"],
  ["¡Vamos, campeón! Mantén el enfoque.", "celebracion"],
  ["Cada minuto de esfuerzo suma.", "aplausos"],
];

const st = {
  uid: null, profile: null, jugadorId: null, player: null, catActual: "",
  todos: null, regs: [], periodo: "todo", custom: { desde: "", hasta: "" }, rango: { desde: null, hasta: null },
  partidos: new Map(), alins: new Map(), shown: 10, card: null, mascota: null, lastFrase: -1, error: null,
  alPitch: null, alKey: "", mdPitch: null, returnFocus: null,
};

protectPage({
  page: "rendimiento",
  onReady(profile) {
    st.profile = profile; st.uid = auth.currentUser?.uid;
    mountShell(profile, "rendimiento");
    if (profile.rol !== ROLE.JUGADOR || !st.uid || st.uid !== profile.uid) return fatal(MSG.sinPermiso);
    buildPeriod(); wire();
    start().catch((err) => {
      console.error("[CanchaControl] Mi rendimiento:", err?.code || err);
      fatal(err?.code === "permission-denied" ? MSG.sinPermiso : MSG.error, "", err?.code !== "permission-denied");
    });
  },
});

/* ---------------- Arranque ---------------- */
async function start() {
  const ctx = await contextoJugador(st.uid);
  if (ctx.estado === "sin-expediente") return fatal(MSG.sinExpediente, "Comunícate con la administración de la escuela.");
  const j = ctx.jugador;
  st.jugadorId = j.id;
  st.catActual = ctx.categoria?.nombre ?? "";
  st.player = { id: j.id, nombres: j.nombres, apellidos: j.apellidos, numeroCamiseta: j.numeroCamiseta, posicion: j.posicion,
    categoria: st.catActual || "Sin categoría", foto: null };

  // Bienvenida con el nombre REAL (expediente o cuenta); si falta, genérica
  const nombre = (j.nombres || st.profile.nombre || "").trim().split(/\s+/)[0] || "";
  $("mr-hola").textContent = nombre ? `¡Vamos, ${nombre}!` : "¡Bienvenido a tu carrera deportiva!";
  const chips = $("mr-chips"); chips.replaceChildren();
  const pos = j.posicion && j.posicion !== "Por definir" ? j.posicion : "Posición por definir";
  [pos, st.catActual || "Sin categoría actual", j.numeroCamiseta != null ? `Dorsal ${j.numeroCamiseta}` : null].filter(Boolean).forEach((t) => chips.append(el("li", "", t)));

  st.card = createPlayer3DCard(st.player, null, { presentational: true });
  $("card-slot").replaceChildren(st.card);
  setCardBadge(st.card, "pend", "Mi rendimiento");
  getFoto(st.jugadorId).then((f) => { if (f) { st.player.foto = f; if (st.card) setCardPhoto(st.card, st.player); } }).catch(() => {});

  st.mascota = createMascota($("mr-mascot"), $("mr-bubble"));
  st.mascota.say(nombre ? `¡Hola, ${nombre}! Qué bueno verte por aquí.` : "¡Hola! Qué bueno verte por aquí.", "saludo");
  await load();
}

async function load() {
  loading();
  try {
    st.todos = await misRendimientos(st.jugadorId);
    st.error = null;
  } catch (err) {
    console.error("[CanchaControl] Mi rendimiento:", err?.code, err?.message || err);
    if (err?.code === "failed-precondition") {
      console.warn("[CanchaControl] Falta el índice de Firestore (rendimientos · jugadorId · grupo de colecciones). "
        + "Créalo con el enlace anterior o con: firebase deploy --only firestore:indexes");
    }
    st.error = err?.code === "permission-denied" ? MSG.sinPermiso : MSG.error;
    return showError(st.error);
  }
  renderHitos();
  applyPeriod();
  celebrar();
}

/* ---------------- Período ---------------- */
function buildPeriod() {
  const g = $("period");
  for (const p of PERIODOS) {
    const b = el("button", "mr-seg__btn", p.label); b.type = "button"; b.dataset.period = p.key;
    b.setAttribute("aria-pressed", String(p.key === st.periodo));
    b.addEventListener("click", () => selectPeriod(p.key));
    g.append(b);
  }
}
function selectPeriod(key) {
  st.periodo = key;
  document.querySelectorAll(".mr-seg__btn").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.period === key)));
  $("range-form").hidden = key !== "rango"; $("range-err").textContent = "";
  if (key === "rango") { $("r-desde").focus(); if (!st.custom.desde || !st.custom.hasta) return; }
  applyPeriod();
}
function applyPeriod() {
  if (!st.todos) return;
  st.rango = rangoPeriodo(st.periodo, st.custom);
  const r = st.rango;
  $("period-label").textContent = !r.desde && !r.hasta ? "Mostrando todo tu historial." : `Mostrando del ${r.desde ? fCorta(r.desde) : "inicio"} al ${r.hasta ? fCorta(r.hasta) : "hoy"}.`;
  st.regs = st.todos.filter((x) => enRango(x.fecha, r));
  st.shown = 10;
  const res = resumen(st.regs);
  renderGauge(res); renderScore(res); renderCharts(); renderMatches(); renderAlinSelect();
}

/* ---------------- Hero: valoración promedio ---------------- */
function renderGauge(res) {
  const g = $("gauge"), bar = $("gauge-bar"), C = 2 * Math.PI * 50;
  bar.style.strokeDasharray = `${C}`;
  const per = PERIODOS.find((p) => p.key === st.periodo)?.label.toLowerCase() ?? "";
  if (res.promedio === null) {
    g.classList.add("is-empty"); g.dataset.tone = "";
    $("gauge-v").textContent = "–"; $("gauge-scale").textContent = "";
    $("gauge-n").textContent = `${MSG.sinCalificaciones}. ${MSG.sinValoracion}`;
    g.setAttribute("aria-label", `Valoración promedio: ${MSG.sinCalificaciones}`);
    bar.style.strokeDashoffset = `${C}`;
    if (st.card) setCardBadge(st.card, "pend", "Sin calificar");
    return;
  }
  g.classList.remove("is-empty"); g.dataset.tone = tone(res.promedio);
  $("gauge-v").textContent = res.promedio.toFixed(1); $("gauge-scale").textContent = "de 10";
  $("gauge-n").textContent = `Promedio de ${pl(res.valorados, "partido calificado", "partidos calificados")} · ${per}`;
  g.setAttribute("aria-label", `Valoración promedio ${res.promedio.toFixed(1)} de 10, ${pl(res.valorados, "partido calificado", "partidos calificados")}`);
  if (st.card) setCardBadge(st.card, { red: "falta", orange: "atraso", green: "ok", gold: "oro" }[tone(res.promedio)] ?? "pend", `Valoración ${res.promedio.toFixed(1)}`);
  const target = C * (1 - res.promedio / 10);
  if (reduce()) { bar.style.transition = "none"; bar.style.strokeDashoffset = `${target}`; return; }
  bar.style.transition = "none"; bar.style.strokeDashoffset = `${C}`;
  requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.transition = ""; bar.style.strokeDashoffset = `${target}`; }));
}

/* ---------------- 2 · Estadísticas ---------------- */
function renderScore(res) {
  const box = $("mr-score");
  if (!st.regs.length) { box.replaceChildren(emptyBox("chart", st.todos.length ? MSG.sinStats : "Aún no hay estadísticas", st.todos.length ? "" : MSG.sinPartidos)); box.classList.add("is-empty"); return; }
  box.classList.remove("is-empty");
  const items = [
    ["partido", res.jugados, "Partidos jugados", "#146434"], ["gol", res.goles, "Goles", "var(--c-gol)"], ["asistencia", res.asistencias, "Asistencias", "var(--c-asi)"],
    ["minutos", res.minutos, "Minutos", "var(--c-min)"], ["amarilla", res.amarillas, "Tarjetas amarillas", "var(--c-ama)"], ["roja", res.rojas, "Tarjetas rojas", "var(--c-roj)"],
  ];
  box.replaceChildren(...items.map(([ic, v, l, c], i) => {
    const a = el("article", `mr-stat${reduce() ? "" : " is-in"}`); a.style.setProperty("--c", c); a.style.setProperty("--i", i);
    const icon = el("span", "mr-stat__ic"); icon.innerHTML = ICONS[ic]; icon.setAttribute("aria-hidden", "true");
    const vv = el("strong", "mr-stat__v", String(v)); vv.dataset.k = ic;
    a.append(icon, vv, el("span", "mr-stat__l", l));
    return a;
  }));
}

/* ---------------- 3 · Gráficos (SVG propio, sin librerías) ---------------- */
function renderCharts() {
  const asc = [...st.regs].reverse();
  renderLine(asc); renderGA(asc); renderMin(asc);
}
let W = 720; const H = 220, PAD = { l: 34, r: 14, t: 14, b: 32 };
function frame(id, ymax, ticks, label) {
  // Ancho real del contenedor: el texto conserva su tamaño en cualquier pantalla
  W = Math.max(280, Math.round($(id).clientWidth || 720));
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": label });
  const y = (v) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / ymax);
  for (const t of ticks) {
    svg.append(svgEl("line", { class: "ch-grid", x1: PAD.l, x2: W - PAD.r, y1: y(t), y2: y(t) }));
    const tx = svgEl("text", { class: "ch-axis", x: PAD.l - 8, y: y(t) + 4, "text-anchor": "end" }); tx.textContent = String(t); svg.append(tx);
  }
  $(id).replaceChildren(svg);
  return { svg, y };
}
function xLabels(svg, items, xOf, labelOf) {
  const every = Math.max(1, Math.ceil(items.length / Math.max(2, Math.floor((W - PAD.l) / 64))));
  items.forEach((it, i) => {
    if (i % every && i !== items.length - 1) return;
    const t = svgEl("text", { class: "ch-axis", x: xOf(i), y: H - 10, "text-anchor": "middle" }); t.textContent = labelOf(it); svg.append(t);
  });
}
const lblMatch = (r) => { if (!r.fecha) return "—"; const d = toD(r.fecha); return `${d.getDate()} ${MES_C[d.getMonth()]}`; };
const tipMatch = (r) => `${fCorta(r.fecha)} · vs ${r.rival}`;

function renderLine(asc) {
  const pts = asc.filter((r) => r.valoracion !== null);
  if (!st.regs.length) { $("ch-val").replaceChildren(emptyBox("chart", MSG.sinStats, "")); return; }
  if (!pts.length) { $("ch-val").replaceChildren(emptyBox("chart", MSG.sinCalificaciones, MSG.sinValoracion)); return; }
  const { svg, y } = frame("ch-val", 10, [0, 2, 4, 6, 8, 10], `Valoración por partido: ${pts.length} partidos calificados`);
  const n = pts.length, iw = W - PAD.l - PAD.r;
  const x = (i) => (n === 1 ? PAD.l + iw / 2 : PAD.l + 16 + (i * (iw - 32)) / (n - 1));
  const defs = svgEl("defs"); const lg = svgEl("linearGradient", { id: "ch-grad", x1: 0, x2: 0, y1: 0, y2: 1 });
  lg.append(svgEl("stop", { offset: "0", "stop-color": "#22c55e", "stop-opacity": ".22" }), svgEl("stop", { offset: "1", "stop-color": "#22c55e", "stop-opacity": "0" }));
  defs.append(lg); svg.prepend(defs);
  if (n > 1) {
    const d = pts.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(r.valoracion).toFixed(1)}`).join(" ");
    svg.append(svgEl("path", { class: "ch-area", d: `${d} L${x(n - 1).toFixed(1)} ${y(0)} L${x(0).toFixed(1)} ${y(0)} Z` }));
    svg.append(svgEl("path", { class: "ch-line", d }));
  }
  pts.forEach((r, i) => {
    const hit = svgEl("circle", { class: "ch-hit", cx: x(i), cy: y(r.valoracion), r: 14, tabindex: 0, role: "button",
      "aria-label": `${tipMatch(r)}: valoración ${r.valoracion.toFixed(1)}. Abrir detalle` });
    const dot = svgEl("circle", { class: `ch-pt ${ratingClass(r.valoracion)}`, cx: x(i), cy: y(r.valoracion), r: 5.5 });
    dot.style.pointerEvents = "none";
    tip(hit, `${tipMatch(r)}\nValoración ${r.valoracion.toFixed(1)} · ${r.minutos} min`);
    activate(hit, () => openDetalle(r));
    svg.append(hit, dot);
  });
  xLabels(svg, pts, x, lblMatch);
}

/** Por partido; si hay muchos, se agrupa por mes (se indica en el gráfico). */
function grupos(asc) {
  if (asc.length <= 16) return { porMes: false, items: asc.map((r) => ({ label: lblMatch(r), tip: tipMatch(r), reg: r, goles: r.goles, asistencias: r.asistencias, minutos: r.minutos, n: 1 })) };
  const m = new Map();
  for (const r of asc) {
    const k = (r.fecha || "").slice(0, 7);
    if (!m.has(k)) { const d = r.fecha ? toD(r.fecha) : null; m.set(k, { label: d ? `${MES_C[d.getMonth()]} ${String(d.getFullYear()).slice(2)}` : "—", tip: d ? `${MES[d.getMonth()]} ${d.getFullYear()}` : "Sin fecha", goles: 0, asistencias: 0, minutos: 0, n: 0 }); }
    const g = m.get(k); g.goles += r.goles; g.asistencias += r.asistencias; g.minutos += r.minutos; g.n++;
  }
  return { porMes: true, items: [...m.values()] };
}
const roundTop = (x, y, w, h, r) => { if (h <= 0) return ""; const rr = Math.min(r, h, w / 2); return `M${x} ${y + h}V${y + rr}Q${x} ${y} ${x + rr} ${y}H${x + w - rr}Q${x + w} ${y} ${x + w} ${y + rr}V${y + h}Z`; };
function niceMax(v) { if (v <= 4) return Math.max(1, v); const step = Math.ceil(v / 4); return step * 4; }
function ticksFor(max) { if (max <= 4) return Array.from({ length: max + 1 }, (_, i) => i); const s = max / 4; return [0, s, 2 * s, 3 * s, max]; }

function renderGA(asc) {
  if (!st.regs.length) { $("ch-ga").replaceChildren(emptyBox("chart", MSG.sinStats, "")); return; }
  const { porMes, items } = grupos(asc);
  const top = Math.max(...items.map((g) => Math.max(g.goles, g.asistencias)));
  if (!top) { $("ch-ga").replaceChildren(emptyBox("chart", "Sin goles ni asistencias en este período", "Cada partido es una nueva oportunidad.")); return; }
  const max = niceMax(top);
  const { svg, y } = frame("ch-ga", max, ticksFor(max), `Goles y asistencias ${porMes ? "por mes" : "por partido"}`);
  const n = items.length, iw = W - PAD.l - PAD.r, slot = iw / n, bw = Math.min(22, (slot - 10) / 2);
  const cx = (i) => PAD.l + slot * i + slot / 2;
  items.forEach((g, i) => {
    const grp = svgEl("g", { class: "ch-col", tabindex: 0, role: g.reg ? "button" : "img",
      "aria-label": `${g.tip}: ${pl(g.goles, "gol", "goles")}, ${pl(g.asistencias, "asistencia", "asistencias")}${g.reg ? ". Abrir detalle" : ""}` });
    grp.append(svgEl("rect", { class: "ch-colbg", x: PAD.l + slot * i + 2, y: PAD.t, width: slot - 4, height: H - PAD.t - PAD.b, rx: 6 }));
    const x0 = cx(i) - bw - 1;
    if (g.goles) grp.append(svgEl("path", { class: "ch-bar ch-bar--gol", d: roundTop(x0, y(g.goles), bw, y(0) - y(g.goles), 4) }));
    if (g.asistencias) grp.append(svgEl("path", { class: "ch-bar ch-bar--asi", d: roundTop(x0 + bw + 2, y(g.asistencias), bw, y(0) - y(g.asistencias), 4) }));
    tip(grp, `${g.tip}${porMes ? ` (${pl(g.n, "partido", "partidos")})` : ""}\nGoles ${g.goles} · Asistencias ${g.asistencias}`);
    if (g.reg) activate(grp, () => openDetalle(g.reg));
    svg.append(grp);
  });
  xLabels(svg, items, cx, (g) => g.label);
  if (porMes) $("ch-ga").append(el("p", "mr-note", "Muchos partidos en el período: se agrupan por mes."));
}

function renderMin(asc) {
  if (!st.regs.length) { $("ch-min").replaceChildren(emptyBox("chart", MSG.sinStats, "")); return; }
  const { porMes, items } = grupos(asc);
  const top = Math.max(...items.map((g) => g.minutos));
  const max = top <= 0 ? 90 : Math.ceil(top / 30) * 30;
  const { svg, y } = frame("ch-min", max, ticksFor(max).map((v) => Math.round(v)), `Minutos jugados ${porMes ? "por mes" : "por partido"}`);
  const n = items.length, iw = W - PAD.l - PAD.r, slot = iw / n, bw = Math.min(30, slot - 12);
  const cx = (i) => PAD.l + slot * i + slot / 2;
  items.forEach((g, i) => {
    const grp = svgEl("g", { class: "ch-col", tabindex: 0, role: g.reg ? "button" : "img",
      "aria-label": `${g.tip}: ${g.minutos} minutos${g.reg ? ". Abrir detalle" : ""}` });
    grp.append(svgEl("rect", { class: "ch-colbg", x: PAD.l + slot * i + 2, y: PAD.t, width: slot - 4, height: H - PAD.t - PAD.b, rx: 6 }));
    if (g.minutos) grp.append(svgEl("path", { class: "ch-bar ch-bar--min", d: roundTop(cx(i) - bw / 2, y(g.minutos), bw, y(0) - y(g.minutos), 4) }));
    else { const t = svgEl("text", { class: "ch-nul", x: cx(i), y: y(0) - 5, "text-anchor": "middle" }); t.textContent = "0"; grp.append(t); }
    tip(grp, `${g.tip}${porMes ? ` (${pl(g.n, "partido", "partidos")})` : ""}\n${g.minutos} minutos${!porMes && !g.minutos ? " · convocado, sin minutos" : ""}`);
    if (g.reg) activate(grp, () => openDetalle(g.reg));
    svg.append(grp);
  });
  xLabels(svg, items, cx, (g) => g.label);
}
function activate(node, fn) {
  node.addEventListener("click", fn);
  node.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } });
}
function tip(target, text) {
  const t = $("mr-tip");
  const show = () => {
    t.textContent = text; t.hidden = false;
    const r = target.getBoundingClientRect();
    let x = r.left + r.width / 2 - t.offsetWidth / 2; x = Math.max(8, Math.min(x, innerWidth - t.offsetWidth - 8));
    let yy = r.top - t.offsetHeight - 8; if (yy < 8) yy = r.bottom + 8;
    t.style.left = `${x}px`; t.style.top = `${yy}px`;
  };
  const hide = () => { t.hidden = true; };
  target.addEventListener("mouseenter", show); target.addEventListener("mouseleave", hide);
  target.addEventListener("focus", show); target.addEventListener("blur", hide);
}

/* ---------------- 4 · Mis partidos ---------------- */
function lugarDe(r) {
  if (!st.partidos.has(r.key)) st.partidos.set(r.key, datosPartido(r.catId, r.pid).catch((err) => { console.error("[CanchaControl] Partido:", err?.code || err); return null; }));
  return st.partidos.get(r.key);
}
function statIcons(r) {
  const s = el("div", "mr-mt__stats");
  const add = (cls, html, n, label) => { const x = el("span", `mr-ic${n ? "" : " is-zero"}${cls}`); x.innerHTML = html; x.append(document.createTextNode(String(n))); x.title = label; x.setAttribute("aria-label", label); s.append(x); };
  add("", ICONS.gol, r.goles, pl(r.goles, "gol", "goles"));
  add("", ICONS.asistencia, r.asistencias, pl(r.asistencias, "asistencia", "asistencias"));
  add("", ICONS.minutos, r.minutos, `${r.minutos} minutos`);
  if (r.amarillas) add("", ICONS.amarilla, r.amarillas, pl(r.amarillas, "tarjeta amarilla", "tarjetas amarillas"));
  if (r.rojas) add("", ICONS.roja, r.rojas, "Tarjeta roja");
  return s;
}
function rateBox(v) {
  const b = el("div", `mr-rate ${ratingClass(v)}`);
  if (v === null) { b.textContent = "Sin calificar"; b.title = MSG.sinValoracion; }
  else { b.textContent = v.toFixed(1); b.append(el("small", "", "Valoración")); b.setAttribute("aria-label", `Valoración ${v.toFixed(1)}`); }
  return b;
}
function renderMatches() {
  const box = $("matches");
  $("mp-count").textContent = st.regs.length ? pl(st.regs.length, "partido", "partidos") : "";
  if (!st.todos.length) { box.replaceChildren(emptyBox("ball", "Tu historia deportiva está comenzando", MSG.sinPartidos)); return; }
  if (!st.regs.length) { box.replaceChildren(emptyBox("filter", "Sin partidos en este período", "Elige otro período para ver más partidos.")); return; }
  const list = st.regs.slice(0, st.shown);
  const nodes = list.map((r) => {
    const a = el("article", `mr-mt${r.minutos > 0 ? "" : " is-bench"}`); a.dataset.key = r.key;
    const d = r.fecha ? toD(r.fecha) : null;
    const date = el("div", "mr-mt__date"); date.setAttribute("aria-hidden", "true");
    date.append(el("strong", "", d ? String(d.getDate()) : "—"), el("span", "", d ? `${MES_C[d.getMonth()]} ${d.getFullYear()}` : ""));
    const main = el("div", "mr-mt__main");
    main.append(el("p", "mr-mt__vs", `vs ${r.rival || "Rival"}`));
    const meta = el("p", "mr-mt__meta");
    const tipo = el("span", "mr-mt__tipo", r.tipo || "Partido");
    const cat = el("span"); cat.innerHTML = ICONS.layers; cat.append(document.createTextNode(r.categoriaNombre || "Categoría"));
    const lug = el("span", "mr-mt__lugar"); lug.innerHTML = ICONS.pin; const lt = document.createTextNode("…"); lug.append(lt);
    meta.append(tipo, cat, lug);
    if (r.minutos === 0) meta.append(el("span", "", "Convocado · sin minutos"));
    main.append(meta);
    lugarDe(r).then((p) => { lt.textContent = p?.lugar || "Lugar no disponible"; });
    const side = el("div", "mr-mt__side");
    const btn = el("button", "btn btn-soft mr-mt__btn", "Ver detalle"); btn.type = "button";
    btn.setAttribute("aria-label", `Ver detalle del partido contra ${r.rival}, ${fLarga(r.fecha)}`);
    btn.addEventListener("click", () => openDetalle(r));
    side.append(rateBox(r.valoracion), btn);
    a.append(date, main, statIcons(r), side);
    return a;
  });
  if (st.regs.length > st.shown) {
    const more = el("button", "btn btn-soft mr-more", `Mostrar más (${st.regs.length - st.shown})`); more.type = "button";
    more.addEventListener("click", () => { st.shown += 10; renderMatches(); });
    nodes.push(more);
  }
  box.replaceChildren(...nodes);
}

/* ---------------- 5 · Alineaciones (cancha de HU-013, solo lectura) ---------------- */
function alinDe(r) {
  if (!st.alins.has(r.key)) {
    const p = detalleAlineacion(r.catId, r.pid);
    st.alins.set(r.key, p);
    p.catch(() => st.alins.delete(r.key));        // un error no queda en caché
  }
  return st.alins.get(r.key);
}
function renderAlinSelect() {
  const sel = $("al-sel");
  sel.replaceChildren(...st.regs.map((r) => new Option(`${fCorta(r.fecha)} · vs ${r.rival}`, r.key)));
  sel.disabled = !st.regs.length;
  if (!st.regs.length) {
    st.alKey = "";
    $("al-pitch").replaceChildren(emptyBox("ball", st.todos.length ? "Sin partidos en este período" : "Aún no hay alineaciones", st.todos.length ? "Elige otro período." : MSG.sinPartidos));
    $("al-info").hidden = true; return;
  }
  if (!st.regs.some((r) => r.key === st.alKey)) st.alKey = st.regs[0].key;
  sel.value = st.alKey;
  showAlin();
}
async function showAlin() {
  const r = st.regs.find((x) => x.key === st.alKey); if (!r) return;
  const box = $("al-pitch"), info = $("al-info");
  box.innerHTML = '<div class="skel" style="height:420px;border-radius:18px"></div>'; info.hidden = true;
  const key = r.key;
  try {
    const d = await alinDe(r);
    if (key !== st.alKey) return;
    if (!d.ubicaciones) { box.replaceChildren(emptyBox("ball", MSG.sinAlineacion, "")); info.hidden = true; return; }
    st.alPitch = pitchRO(box, d, (jid) => paintInfo(info, d, jid));
    info.hidden = false; paintInfo(info, d, st.jugadorId);
  } catch (err) {
    if (key !== st.alKey) return;
    console.error("[CanchaControl] Alineación:", err?.code || err);
    box.replaceChildren(errorBox(err?.code === "permission-denied" ? MSG.sinPermiso : MSG.error, () => showAlin()));
  }
}
function pitchRO(box, d, onSelect) {
  const players = new Map([...d.players].map(([k, p]) => [k, k === st.jugadorId ? { ...p, foto: st.player.foto } : p]));
  const wrap = el("div", "mr-pitch-ro"); box.replaceChildren(wrap);
  return createPitch(wrap, { editable: false, max: 11, players, stats: d.stats, ubicaciones: d.ubicaciones, highlightId: st.jugadorId, onSelect });
}
function paintInfo(info, d, jid) {
  const p = d.players.get(jid), s = d.stats.get(jid), u = d.ubicaciones?.get(jid);
  if (!p) return;
  const me = jid === st.jugadorId;
  const h = el("h3", "", me ? `Tú · ${p.nombres} ${p.apellidos}`.trim() : `${p.nombres} ${p.apellidos}`.trim());
  const sub = el("p", "", [p.numeroCamiseta != null ? `Dorsal ${p.numeroCamiseta}` : "", u ? `Titular · ${u.posicionTactica}` : "Suplente"].filter(Boolean).join(" · "));
  const kv = el("dl", "mr-kv");
  const add = (k, v) => { const w = el("div"); w.append(el("dt", "", k), el("dd", "", v)); kv.append(w); };
  if (s) {
    add("Minutos", String(s.minutosJugados)); add("Goles", String(s.goles)); add("Asistencias", String(s.asistencias));
    add("Amarillas", String(s.tarjetasAmarillas)); add("Rojas", String(s.tarjetasRojas)); add("Valoración", s.valoracionFinal === null ? "–" : s.valoracionFinal.toFixed(1));
    info.replaceChildren(h, sub, kv);
    if (s.valoracionFinal === null && me) info.append(el("p", "md-msg", MSG.sinValoracion));
  } else info.replaceChildren(h, sub, el("p", "md-msg", "Sin estadísticas registradas para este jugador en el partido."));
  if (!me) info.append(el("p", "mr-note", "Toca tu ficha (Tú) para volver a tus datos."));
}

/* ---------------- Detalle de un partido (solo lectura) ---------------- */
async function openDetalle(r) {
  $("md-title").textContent = `vs ${r.rival || "Rival"}`;
  $("md-sub").textContent = `${fLarga(r.fecha)} · ${r.tipo || "Partido"}`;
  const body = $("md-body");
  const top = el("div", "md-top");
  const cardBox = el("div", "md-card");
  const historico = !!(r.categoriaNombre && st.catActual && r.categoriaNombre !== st.catActual);
  const c = createPlayer3DCard({ ...st.player, categoria: r.categoriaNombre || st.player.categoria, historico }, null, { presentational: true });
  if (r.valoracion !== null) setCardBadge(c, { red: "falta", orange: "atraso", green: "ok", gold: "oro" }[tone(r.valoracion)] ?? "pend", `Valoración ${r.valoracion.toFixed(1)}`);
  else setCardBadge(c, "pend", "Sin calificar");
  cardBox.append(c);
  const right = el("div");
  const dl = el("dl", "detail-list md-dl");
  const row = (k, v) => { const w = el("div"); w.append(el("dt", "", k), el("dd", "", v)); dl.append(w); return w.querySelector("dd"); };
  row("Fecha", fLarga(r.fecha)); const hora = row("Hora", "…"); row("Rival", r.rival || "—"); row("Tipo de partido", r.tipo || "—");
  const lugar = row("Lugar", "…"); row("Categoría (de ese día)", r.categoriaNombre || "—"); const fmt = row("Formato", "…");
  const kv = el("dl", "mr-kv md-stats");
  const add = (k, v) => { const w = el("div"); w.append(el("dt", "", k), el("dd", "", v)); kv.append(w); };
  add("Minutos", String(r.minutos)); add("Goles", String(r.goles)); add("Asistencias", String(r.asistencias));
  add("Amarillas", String(r.amarillas)); add("Rojas", String(r.rojas)); add("Valoración final", r.valoracion === null ? "–" : r.valoracion.toFixed(1));
  right.append(dl, kv);
  if (r.valoracion === null) right.append(el("p", "md-msg", MSG.sinValoracion));
  top.append(cardBox, right);
  const sec = el("section", "md-sec"); sec.append(el("h3", "", "Alineación del partido"));
  const pbox = el("div"); pbox.innerHTML = '<div class="skel" style="height:360px;border-radius:18px"></div>'; sec.append(pbox);
  body.replaceChildren(top, sec);
  openPanel();
  lugarDe(r).then((p) => {
    hora.textContent = p?.hora || "—"; lugar.textContent = p?.lugar || "Lugar no disponible";
    fmt.textContent = p?.formato ? `Fútbol ${p.formato.slice(1)}` : "—";
  });
  try {
    const d = await alinDe(r);
    if (!d.ubicaciones) { pbox.replaceChildren(el("p", "md-msg", MSG.sinAlineacion)); return; }
    st.mdPitch = pitchRO(pbox, d, () => {});
  } catch (err) {
    console.error("[CanchaControl] Detalle de partido:", err?.code || err);
    pbox.replaceChildren(el("p", "md-msg", err?.code === "permission-denied" ? MSG.sinPermiso : MSG.error));
  }
}
function openPanel() {
  st.returnFocus = document.activeElement;
  const d = $("md-drawer"); d.classList.add("is-open"); d.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open"); $("app").inert = true;
  setTimeout(() => d.querySelector(".icon-btn[data-close]")?.focus(), 60);
}
function closePanel() {
  const d = $("md-drawer"); if (!d.classList.contains("is-open")) return;
  d.classList.remove("is-open"); d.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open"); $("app").inert = false;
  $("mr-tip").hidden = true;
  st.returnFocus?.focus?.();
}

/* ---------------- Hitos y celebraciones (solo con datos reales) ---------------- */
const HITO_ICON = { partido: ICONS.partido, gol: ICON.ball, asistencia: ICON.boot, valoracion: ICONS.valoracion, goles: ICON.ball };
function renderHitos() {
  const box = $("hitos");
  const hs = hitos(st.todos);
  if (!hs.length) {
    const li = el("li"); li.append(emptyBox("star", "Tus momentos destacados aparecerán aquí", "Se basan solo en partidos registrados por tu entrenador.")); li.style.gridColumn = "1 / -1";
    box.replaceChildren(li); return;
  }
  box.replaceChildren(...hs.map((h) => {
    const li = el("li", "mr-hito");
    const ic = el("span", "mr-hito__ic"); ic.innerHTML = HITO_ICON[h.tipo]; ic.setAttribute("aria-hidden", "true");
    const t = el("div");
    const titulo = h.tipo === "valoracion" ? `${h.titulo}: ${h.valor.toFixed(1)}` : h.tipo === "goles" ? `${h.titulo}: ${h.valor}` : h.titulo;
    t.append(el("p", "mr-hito__t", titulo), el("p", "mr-hito__d", `vs ${h.reg.rival} · ${fCorta(h.reg.fecha)}`));
    li.append(ic, t);
    return li;
  }));
}
/**
 * Celebra UNA vez el hito más reciente que aún no se había mostrado en este dispositivo.
 * Solo se guardan los identificadores de hitos ya vistos (sin datos personales). Si el
 * almacenamiento no está disponible, no se celebra automáticamente (evita repeticiones).
 */
function celebrar() {
  const KEY = `cc-rend-hitos:${st.jugadorId}`;
  let vistos = null;
  try { const raw = localStorage.getItem(KEY); vistos = raw ? JSON.parse(raw) : []; if (!Array.isArray(vistos)) vistos = []; } catch { vistos = null; }
  if (vistos === null) return;
  const hs = hitos(st.todos);
  const nuevos = hs.filter((h) => !vistos.includes(h.id));
  try { localStorage.setItem(KEY, JSON.stringify(hs.map((h) => h.id))); } catch { /* opcional */ }
  if (!nuevos.length) return;
  const prio = { valoracion: 5, goles: 4, gol: 3, asistencia: 2, partido: 1 };
  const h = nuevos.sort((a, b) => (a.reg.fecha < b.reg.fecha ? 1 : a.reg.fecha > b.reg.fecha ? -1 : prio[b.tipo] - prio[a.tipo]))[0];
  const habiaMejor = vistos.some((id) => id.startsWith("mejor-valoracion:"));
  const texto = h.tipo === "valoracion" && !habiaMejor ? `Tu mejor valoración registrada: ${h.valor.toFixed(1)}. ¡Sigue superándote!` : h.texto;
  const msg = `${texto} (vs ${h.reg.rival} · ${fCorta(h.reg.fecha)})`;
  const anim = h.tipo === "asistencia" || h.tipo === "partido" ? "aplausos" : "celebracion";
  if (reduce()) { st.mascota.say(msg, anim); return; }
  setTimeout(() => st.mascota.say(msg, anim), 1800);
}
function motivar() {
  const pool = [...FRASES];
  if (st.todos?.length) {
    const tot = resumen(st.todos);
    if (tot.goles > 0) pool.push([`Llevas ${pl(tot.goles, "gol registrado", "goles registrados")}. ¡Siuuu!`, "celebracion"]);
    if (tot.asistencias > 0) pool.push([`Has dado ${pl(tot.asistencias, "asistencia registrada", "asistencias registradas")}. ¡Gran aporte al equipo!`, "aplausos"]);
    const ult = st.todos[0];
    if (ult && ult.valoracion !== null && ult.valoracion >= 7) pool.push([`Tu último partido registrado (vs ${ult.rival}) tuvo valoración ${ult.valoracion.toFixed(1)}. ¡Gran partido! Sigue superándote.`, "celebracion"]);
  }
  let i; do { i = Math.floor(Math.random() * pool.length); } while (pool.length > 1 && i === st.lastFrase);
  st.lastFrase = i;
  const [t, a] = pool[i];
  st.mascota.say(t, a);
}

/* ---------------- Estados ---------------- */
const EMPTY_ICON = {
  chart: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4-2v-4z"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  alert: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="13"/><circle cx="12" cy="16.5" r=".6" fill="currentColor"/>',
  ball: '<circle cx="12" cy="12" r="9"/><path d="m12 7.5 4 2.9-1.5 4.6h-5L8 10.4z"/>',
  star: '<path d="m12 3 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z"/>',
};
function emptyBox(icon, title, text) {
  const e = el("div", "empty mr-empty");
  const i = el("div", "state__icon"); i.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${EMPTY_ICON[icon]}</svg>`;
  e.append(i, el("p", "empty__title", title)); if (text) e.append(el("p", "empty__text", text));
  return e;
}
function errorBox(msg, retry) {
  const box = emptyBox("alert", msg, "");
  const b = el("button", "btn btn-primary empty__btn", "Intentar de nuevo"); b.type = "button"; b.addEventListener("click", retry); box.append(b);
  return box;
}
function loading() {
  const sk = (h) => `<div class="skel" style="height:${h}px;border-radius:18px"></div>`;
  $("mr-score").innerHTML = sk(110);
  ["ch-val", "ch-ga", "ch-min"].forEach((id) => { $(id).innerHTML = sk(200); });
  $("matches").innerHTML = sk(84) + sk(84);
  $("hitos").innerHTML = "";
  $("al-pitch").innerHTML = sk(300); $("al-info").hidden = true;
}
function showError(msg) {
  const retry = () => load();
  $("gauge-v").textContent = "–"; $("gauge-n").textContent = ""; $("gauge-scale").textContent = "";
  $("mr-score").replaceChildren(errorBox(msg, retry));
  ["ch-val", "ch-ga", "ch-min"].forEach((id) => $(id).replaceChildren(emptyBox("alert", msg, "")));
  $("matches").replaceChildren(errorBox(msg, retry));
  $("al-pitch").replaceChildren(emptyBox("alert", msg, "")); $("al-sel").replaceChildren(); $("al-sel").disabled = true;
  $("hitos").replaceChildren();
  $("mp-count").textContent = ""; $("period-label").textContent = "";
  if (st.card) setCardBadge(st.card, "pend", "Sin datos");
}
function fatal(title, text = "", retry = false) {
  $("mr-body").hidden = true;
  const s = $("mr-state"); s.hidden = false;
  const box = emptyBox(retry ? "alert" : "lock", title, text);
  if (retry) { const b = el("button", "btn btn-primary empty__btn", "Intentar de nuevo"); b.type = "button"; b.addEventListener("click", () => location.reload()); box.append(b); }
  s.replaceChildren(box);
}

/* ---------------- Eventos ---------------- */
function wire() {
  $("motivame").addEventListener("click", motivar);
  let rz = 0, lastW = innerWidth;
  addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (st.todos && !st.error && innerWidth !== lastW) { lastW = innerWidth; renderCharts(); } }, 200); });
  $("al-sel").addEventListener("change", (e) => { st.alKey = e.target.value; showAlin(); });
  $("range-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const d = $("r-desde").value, h = $("r-hasta").value;
    $("range-err").textContent = "";
    if (!d || !h) { $("range-err").textContent = "Selecciona la fecha inicial y la final."; return; }
    if (d > h) { $("range-err").textContent = MSG.rango; $("r-desde").setAttribute("aria-invalid", "true"); return; }
    $("r-desde").setAttribute("aria-invalid", "false");
    st.custom = { desde: d, hasta: h };
    applyPeriod();
  });
  $("md-drawer").querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closePanel));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("md-drawer").classList.contains("is-open")) { e.preventDefault(); closePanel(); } });
}
