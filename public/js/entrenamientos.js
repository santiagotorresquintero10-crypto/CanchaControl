/* ==========================================================
   CanchaControl — Entrenamientos (HU-010)
   Administrador → todas las categorías (solo consulta).
   Entrenador    → SUS categorías (where entrenadorId == uid); programa sesiones.
   Jugador       → la sesiones de SU categoría (cadena uid → jugador → categoría).
   Los datos se piden por categoría y por mes; las reglas validan cada lectura.
   ========================================================== */
import { protectPage } from "./authGuard.js";
import { can, ACTION, readScope, SCOPE, ROLE } from "./permissions.js";
import { auth } from "./auth.js";
import { mountShell } from "./shell.js";
import { toast, initFilterCards } from "./ui.js";
import { subscribeCategorias, subscribeMisCategorias, rangoLabel } from "./categorias-data.js";
import { subscribeUsers } from "./users.js";
import { contextoJugador } from "./mi-jugador.js";
import { renderCalendar, rangoMes } from "./calendar.js";
import { tieneAsistencia, ventana, MSG as MSG_ASIS } from "./asistencia-data.js";
import { sesionesRango, crearSesion, friendlySesionError, hoyISO, ahoraHHMM, HORA_RE, FECHA_RE, LIMITS, ESTADO_SES, MSG } from "./entrenamientos-data.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const norm = (s) => String(s ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
const MES_CORTO = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

const now = new Date();
const st = {
  me: null, uid: null, role: null, canCreate: false,
  cats: new Map(), catsReady: false, users: new Map(),
  year: now.getFullYear(), month: now.getMonth(), selected: null,
  sesiones: [], loading: true, error: null, loadSeq: 0,
  filtro: "", q: "", cat: "",
  jugadorCtx: null,
};

protectPage({
  page: "entrenamientos",
  onReady(profile) {
    st.me = profile;
    st.uid = auth.currentUser?.uid;
    mountShell(profile, "entrenamientos");
    const scope = readScope(profile.rol, "entrenamientos");
    st.role = scope === SCOPE.ALL ? "admin" : scope === SCOPE.ASSIGNED ? "coach" : scope === SCOPE.OWN ? "player" : null;
    if (!st.uid || st.uid !== profile.uid || !st.role) { showEmpty("No tienes permiso para consultar esta información.", "", null); return; }
    st.canCreate = st.role === "coach" && can(profile, "entrenamientos", ACTION.CREATE);
    setupView();
    wire();
    if (st.role === "admin") {
      subscribeUsers((list) => { st.users = new Map(list.map((u) => [u.uid, u])); renderList(); }, () => {});
      subscribeCategorias(onCats, onCatsError);
    } else if (st.role === "coach") {
      subscribeMisCategorias(st.uid, onCats, onCatsError);
    } else {
      contextoJugador(st.uid).then((ctx) => {
        st.jugadorCtx = ctx;
        if (ctx.estado !== "ok") { st.catsReady = true; st.loading = false; renderAll(); return; }
        onCats([{ ...ctx.categoria }]);
      }).catch(onCatsError);
    }
  },
});

function setupView() {
  const sub = { admin: "Consulta las sesiones programadas en todas las categorías.", coach: "Programa y consulta las sesiones de tus categorías.", player: "Consulta las próximas actividades de tu categoría." };
  $("page-subtitle").textContent = sub[st.role];
  $("new-btn").hidden = !st.canCreate;
  if (st.role === "player") { $("filter-cat").hidden = true; document.querySelector('label[for="filter-cat"]').hidden = true; }
}

function onCats(list) {
  st.cats = new Map(list.map((c) => [c.id, c]));
  st.catsReady = true;
  const sel = $("filter-cat"), cur = sel.value;
  const cats = [...st.cats.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" }));
  sel.replaceChildren(new Option("Todas las categorías", ""), ...cats.map((c) => new Option(c.nombre, c.id)));
  sel.value = st.cats.has(cur) ? cur : ""; st.cat = sel.value;
  load();
}
function onCatsError(err) {
  console.error("[CanchaControl] Categorías:", err?.code || err);
  st.catsReady = true; st.loading = false; st.error = err; renderAll();
}

/* ---------- Carga del mes (una consulta por categoría autorizada) ---------- */
async function load() {
  const seq = ++st.loadSeq;
  st.loading = true; st.error = null; renderAll();
  const ids = [...st.cats.keys()];
  if (!ids.length) { st.sesiones = []; st.loading = false; renderAll(); return; }
  const [desde, hasta] = rangoMes(st.year, st.month);
  try {
    const list = await sesionesRango(ids, desde, hasta);
    if (seq !== st.loadSeq) return;
    st.sesiones = list; st.loading = false; renderAll();
  } catch (err) {
    if (seq !== st.loadSeq) return;
    console.error("[CanchaControl] Sesiones:", err?.code || err);
    st.loading = false; st.error = err; renderAll();
  }
}

/* ---------- Render ---------- */
const hashIdx = (s, n) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % n; };
const tone = (catId) => { const c = st.cats.get(catId); return hashIdx(c?.nombreNormalizado || c?.nombre || catId, 8); };
const esProxima = (s) => s.fecha > hoyISO() || (s.fecha === hoyISO() && s.horaFin > ahoraHHMM());

function visibles({ ignoreDay = false } = {}) {
  return st.sesiones.filter((s) => {
    if (st.filtro === ESTADO_SES.PROGRAMADA && s.estado !== ESTADO_SES.PROGRAMADA) return false;
    if (st.filtro === "__proximas" && !esProxima(s)) return false;
    if (st.cat && s.categoriaId !== st.cat) return false;
    if (st.q) {
      const q = norm(st.q), c = st.cats.get(s.categoriaId);
      if (!norm(s.lugar).includes(q) && !norm(c?.nombre).includes(q)) return false;
    }
    if (!ignoreDay && st.selected && s.fecha !== st.selected) return false;
    return true;
  });
}

function renderAll() { renderKpis(); renderCal(); renderList(); }

function renderKpis() {
  if (st.loading) return;
  const base = st.sesiones.filter((s) => (!st.cat || s.categoriaId === st.cat));
  $("k-total").textContent = String(base.length);
  $("k-prog").textContent = String(base.filter((s) => s.estado === ESTADO_SES.PROGRAMADA).length);
  $("k-prox").textContent = String(base.filter(esProxima).length);
}

function renderCal() {
  if (!st.catsReady) return;
  const events = visibles({ ignoreDay: true }).map((s) => ({ fecha: s.fecha, id: s.id, tone: tone(s.categoriaId), label: `${s.horaInicio} ${st.cats.get(s.categoriaId)?.nombre ?? ""}` }));
  renderCalendar($("cal"), {
    year: st.year, month: st.month, today: hoyISO(), selected: st.selected, events,
    onSelect: (iso) => { st.selected = iso; renderCal(); renderList(); },
    onMonth: (d) => {
      if (d === 0) { st.year = now.getFullYear(); st.month = now.getMonth(); }
      else { const m = new Date(st.year, st.month + d, 1); st.year = m.getFullYear(); st.month = m.getMonth(); }
      st.selected = null; load();
    },
  });
}

const ICO = {
  clock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>',
  pin: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  user: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 20v-1a7 7 0 0 1 14 0v1"/></svg>',
};
function coachName(s) {
  if (st.role === "coach") return s.entrenadorId === st.uid ? st.me.nombre : "Otro entrenador";
  if (st.role === "player") return st.jugadorCtx?.entrenador?.nombre ?? "";
  return st.users.get(s.entrenadorId)?.nombre ?? "";
}

function renderList() {
  const ul = $("ses-items");
  $("clear-day").hidden = !st.selected;
  const [, , d] = (st.selected ?? "").split("-");
  $("list-title").textContent = st.selected ? `Sesiones del ${Number(d)} de ${MES_CORTO[Number(st.selected.split("-")[1]) - 1]}` : "Sesiones del mes";
  if (st.role === "player" && st.jugadorCtx && st.jugadorCtx.estado !== "ok") {
    ul.replaceChildren(); $("toolbar").hidden = true;
    return showEmpty("Aún no tienes una categoría asignada.", "Cuando el Administrador te vincule a una categoría, verás aquí sus entrenamientos.", null);
  }
  if (!st.catsReady || st.loading) { ul.innerHTML = '<li><span class="skel" style="height:56px"></span></li><li><span class="skel" style="height:56px"></span></li>'; $("ses-empty").hidden = true; return; }
  if (st.error) {
    ul.replaceChildren();
    return st.error.code === "permission-denied"
      ? showEmpty("No tienes permiso para consultar esta información.", "Si crees que es un error, comunícate con el Administrador.", null)
      : showEmpty("No se pudo cargar la información", "Ocurrió un problema al consultar las sesiones. Intenta nuevamente.", "Intentar de nuevo", load);
  }
  if (!st.cats.size) { ul.replaceChildren(); $("toolbar").hidden = true; return showEmpty(st.role === "coach" ? "Aún no tienes categorías asignadas." : "No hay categorías registradas.", st.role === "coach" ? "Cuando un administrador te asigne una categoría, podrás programar sesiones." : "", null); }
  $("toolbar").hidden = false;
  const list = visibles();
  if (!list.length) {
    ul.replaceChildren();
    const filtering = st.q || st.cat || st.filtro || st.selected;
    return showEmpty(filtering ? "No hay sesiones con estos criterios." : "No hay sesiones programadas este mes.",
      filtering ? "Prueba con otro filtro o día." : st.canCreate ? "Programa la primera sesión del mes." : "Cuando se programen entrenamientos, aparecerán aquí.",
      !filtering && st.canCreate ? "+ Nueva sesión" : null, openForm);
  }
  $("ses-empty").hidden = true;
  ul.replaceChildren(...list.map((s) => {
    const li = el("li");
    const b = el("button", "ses-item"); b.type = "button"; b.dataset.id = s.id;
    const [, m, dd] = s.fecha.split("-");
    const date = el("span", `ses-date tile-${tone(s.categoriaId)}`);
    date.append(el("span", "ses-date__d", String(Number(dd))), el("span", "ses-date__m", MES_CORTO[Number(m) - 1]));
    const main = el("span", "ses-main");
    const c = st.cats.get(s.categoriaId);
    main.append(el("p", "ses-main__t", c?.nombre ?? "Categoría"));
    const sub = el("p", "ses-main__s");
    const piece = (ico, txt) => { const sp = el("span"); sp.innerHTML = ico; sp.append(document.createTextNode(txt)); return sp; };
    sub.append(piece(ICO.clock, `${s.horaInicio} – ${s.horaFin}`), piece(ICO.pin, s.lugar));
    if (st.role === "admin" && coachName(s)) sub.append(piece(ICO.user, coachName(s)));
    main.append(sub);
    b.append(date, main, el("span", "badge badge--success", s.estado));
    b.addEventListener("click", () => openDetail(s));
    li.append(b); return li;
  }));
}

function showEmpty(title, text, actionLabel, onAction) {
  $("ses-empty-title").textContent = title;
  $("ses-empty-text").textContent = text;
  const b = $("ses-empty-action");
  b.hidden = !actionLabel;
  if (actionLabel) { b.textContent = actionLabel; b.onclick = onAction; }
  $("ses-empty").hidden = false;
}

/* ---------- Detalle (solo lectura) ---------- */
let returnFocus = null;
function openPanel(id, focusSel) {
  returnFocus = document.activeElement;
  const d = $(id); d.classList.add("is-open"); d.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open"); $("app").inert = true;
  setTimeout(() => d.querySelector(focusSel)?.focus(), 60);
}
function closePanel(id) {
  const d = $(id); if (!d.classList.contains("is-open")) return;
  d.classList.remove("is-open"); d.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open"); $("app").inert = false;
  returnFocus?.focus?.();
}
function fechaLarga(iso) { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long", year: "numeric" }); }
function openDetail(s) {
  const c = st.cats.get(s.categoriaId);
  $("det-title").textContent = c?.nombre ?? "Sesión de entrenamiento";
  $("det-sub").textContent = fechaLarga(s.fecha);
  const rows = [["Categoría", c ? `${c.nombre} · ${rangoLabel(c)}` : "—"], ["Fecha", fechaLarga(s.fecha)], ["Horario", `${s.horaInicio} – ${s.horaFin}`],
    ["Lugar", s.lugar], ["Estado", s.estado], ["Entrenador", coachName(s) || "—"], ["Observaciones", s.observaciones || "—"]];
  $("det-list").replaceChildren(...rows.map(([k, v]) => { const w = el("div"); w.append(el("dt", "", k), el("dd", "", v)); return w; }));
  renderAsistenciaAccess(s);
  openPanel("det-drawer", "[data-close].btn");
}

/* ---------- HU-011: acceso a la asistencia desde el detalle ---------- */
let asisSeq = 0;
async function renderAsistenciaAccess(s) {
  const box = $("det-asis");
  if (st.role === "player") { box.hidden = true; return; }
  const seq = ++asisSeq;
  box.hidden = false; box.replaceChildren(el("span", "skel", ""));
  box.firstChild.style.cssText = "display:block;height:46px";
  let has = false;
  try { has = await tieneAsistencia(s.categoriaId, s.id); }
  catch { if (seq !== asisSeq) return; box.replaceChildren(el("p", "det-asis__note", "No fue posible consultar la asistencia de esta sesión.")); return; }
  if (seq !== asisSeq) return;
  const w = ventana(s.fecha);
  const href = `asistencia.html?cat=${encodeURIComponent(s.categoriaId)}&ses=${encodeURIComponent(s.id)}`;
  const link = (label, primary = true) => { const a = el("a", `btn ${primary ? "btn-primary" : "btn-soft"} det-asis__btn`, label); a.href = href; a.id = "asis-link"; return a; };
  const note = (t) => el("p", "det-asis__note", t);
  const out = [el("p", "det-asis__title", "Asistencia")];
  if (st.role === "coach") {
    if (w.abierta) out.push(link(has ? "Ver / Editar asistencia" : "Registrar asistencia"));
    else if (w.motivo === "futura") { const b = el("button", "btn btn-soft det-asis__btn", "Registrar asistencia"); b.type = "button"; b.disabled = true; b.id = "asis-link"; out.push(b, note(MSG_ASIS.futura)); }
    else if (has) out.push(link("Ver asistencia", false), note("El plazo de corrección terminó."));
    else out.push(note("No se registró asistencia y el plazo para hacerlo terminó."));
  } else {
    out.push(has ? link("Ver asistencia", false) : note("Sin asistencia registrada."));
  }
  box.replaceChildren(...out);
}

/* ---------- Nueva sesión (Entrenador) ---------- */
let saving = false;
function setErr(f, msg) { $(`f-${f}-err`).textContent = msg; $(`f-${f}`).closest(".f-field").classList.add("has-error"); $(`f-${f}`).setAttribute("aria-invalid", "true"); }
function clearErr(f) { $(`f-${f}-err`).textContent = ""; $(`f-${f}`).closest(".f-field").classList.remove("has-error"); $(`f-${f}`).setAttribute("aria-invalid", "false"); }
const FIELDS = ["cat", "fecha", "ini", "fin", "lugar"];

function openForm() {
  if (!st.canCreate) { toast("error", MSG.noPermission); return; }
  const activas = [...st.cats.values()].filter((c) => c.estado === "Activa").sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" }));
  if (!activas.length) { toast("info", "No tienes categorías activas para programar sesiones."); return; }
  $("ses-form").reset(); FIELDS.forEach(clearErr); $("form-alert").hidden = true;
  $("f-cat").replaceChildren(new Option("Selecciona una categoría…", ""), ...activas.map((c) => new Option(`${c.nombre} (${rangoLabel(c)})`, c.id)));
  if (st.cat && activas.some((c) => c.id === st.cat)) $("f-cat").value = st.cat;
  $("f-fecha").min = hoyISO();
  $("f-fecha").value = st.selected && st.selected >= hoyISO() ? st.selected : "";
  openPanel("ses-drawer", "#f-cat");
}

function validate() {
  FIELDS.forEach(clearErr);
  let ok = true;
  const bad = (f, m) => { setErr(f, m); ok = false; };
  const cat = $("f-cat").value, fecha = $("f-fecha").value, ini = $("f-ini").value, fin = $("f-fin").value, lugar = $("f-lugar").value.trim();
  const c = st.cats.get(cat);
  if (!cat) bad("cat", "Selecciona la categoría.");
  else if (!c) bad("cat", MSG.notMine);
  else if (c.estado !== "Activa") bad("cat", MSG.catInactive);
  if (!fecha) bad("fecha", "Selecciona la fecha.");
  else if (!FECHA_RE.test(fecha)) bad("fecha", "Ingresa una fecha válida.");
  else if (fecha < hoyISO()) bad("fecha", "No puedes programar sesiones en fechas pasadas.");
  if (!ini) bad("ini", "Indica la hora de inicio.");
  else if (!HORA_RE.test(ini)) bad("ini", "Hora no válida.");
  else if (fecha === hoyISO() && ini <= ahoraHHMM()) bad("ini", "Esa hora ya pasó hoy.");
  if (!fin) bad("fin", "Indica la hora de finalización.");
  else if (!HORA_RE.test(fin)) bad("fin", "Hora no válida.");
  else if (ini && HORA_RE.test(ini) && fin <= ini) bad("fin", "Debe ser posterior a la hora de inicio.");
  if (!lugar) bad("lugar", "Indica el lugar.");
  else if (lugar.length > LIMITS.LUGAR_MAX) bad("lugar", `Máximo ${LIMITS.LUGAR_MAX} caracteres.`);
  if (!ok) $("ses-form").querySelector(".has-error .field-input")?.focus();
  return ok ? { cat, fecha, horaInicio: ini, horaFin: fin, lugar, observaciones: $("f-obs").value.slice(0, LIMITS.OBS_MAX) } : null;
}

function setSaving(on) {
  saving = on;
  const b = $("save-btn"); b.disabled = on;
  b.innerHTML = on ? '<span class="spinner" aria-hidden="true"></span><span class="btn-label">Guardando…</span>' : '<span class="btn-label">Programar sesión</span>';
  $("ses-drawer").querySelectorAll("[data-close]").forEach((x) => { x.disabled = on; });
}

async function onSubmit(e) {
  e.preventDefault();
  if (saving) return;                 // sin duplicados por doble clic
  $("form-alert").hidden = true;
  const v = validate(); if (!v) return;
  setSaving(true);
  try {
    await crearSesion(v.cat, v, st.uid);
    setSaving(false); closePanel("ses-drawer");
    toast("success", "Sesión programada correctamente.");
    const [y, m] = v.fecha.split("-").map(Number);
    st.year = y; st.month = m - 1; st.selected = v.fecha;
    load();
  } catch (err) {
    console.error("[CanchaControl] Programar sesión:", err?.code || err);
    setSaving(false);
    const msg = friendlySesionError(err);
    if (err?.code === "overlap") setErr("ini", msg);
    const a = $("form-alert"); a.textContent = msg; a.hidden = false;
    toast("error", msg);
  }
}

/* ---------- Eventos ---------- */
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function wire() {
  initFilterCards($("ses-kpis"), (v) => { st.filtro = v; renderCal(); renderList(); });
  $("new-btn").addEventListener("click", openForm);
  $("search").addEventListener("input", debounce(() => { st.q = $("search").value; renderCal(); renderList(); }, 300));
  $("filter-cat").addEventListener("change", (e) => { st.cat = e.target.value; renderAll(); });
  $("clear-day").addEventListener("click", () => { st.selected = null; renderCal(); renderList(); });
  $("ses-form").addEventListener("submit", onSubmit);
  ["cat", "fecha", "ini", "fin", "lugar"].forEach((f) => $(`f-${f}`).addEventListener("input", () => clearErr(f)));
  for (const id of ["ses-drawer", "det-drawer"]) $(id).querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => { if (!saving) closePanel(id); }));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if ($("ses-drawer").classList.contains("is-open") && !saving) { e.preventDefault(); closePanel("ses-drawer"); }
    else if ($("det-drawer").classList.contains("is-open")) { e.preventDefault(); closePanel("det-drawer"); }
  });
}
