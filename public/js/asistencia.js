/* ==========================================================
   CanchaControl — Registro de asistencia por sesión (HU-011)
   asistencia.html?cat={categoriaId}&ses={sesionId}
   ----------------------------------------------------------
   Entrenador: registra y corrige (desde el día de la sesión hasta 7 días después)
               solo en SUS categorías. Administrador: solo consulta.
   Los IDs de la URL NO dan permiso: cada lectura y escritura la valida
   firestore.rules (entrenador actual de la categoría, sesión real, nómina real).
   Un único estado local alimenta Tarjetas y Lista; Firestore se escribe solo
   al pulsar "Guardar asistencia" (lo nuevo o modificado, sin duplicados).
   ========================================================== */
import { protectPage } from "./authGuard.js";
import { ROLE, can, ACTION } from "./permissions.js";
import { auth, db } from "./auth.js";
import { mountShell } from "./shell.js";
import { toast, initFilterCards } from "./ui.js";
import { getFoto } from "./jugadores-data.js";
import { rangoLabel } from "./categorias-data.js";
import { ESTADOS, ESTADO_INFO, MSG, ventana, cargarSesion, cargarAsistencias, cargarNomina, guardarAsistencia, friendlyAsistenciaError } from "./asistencia-data.js";
import { createPlayer3DCard, setCardEstado, setCardPhoto, stateIcon, stateKey, stateLabel, posAbbr, iniciales, jerseyAvatar } from "./player-card.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const norm = (s) => String(s ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const fechaLarga = (iso) => { const [y, m, d] = iso.split("-").map(Number); const s = new Date(y, m - 1, d).toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long", year: "numeric" }); return s[0].toUpperCase() + s.slice(1); };
const fechaCorta = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString("es-CO", { day: "numeric", month: "long" }); };

const st = {
  uid: null, me: null, role: null, catId: null, sesId: null,
  cat: null, ses: null, coachName: "", win: null, editable: false,
  players: [], saved: new Map(), local: new Map(),
  cards: new Map(), rows: new Map(),
  filtro: "", q: "", view: "cards", saving: false,
  group: "none", collapsed: new Set(), groups: new Map(),
};

/* Agrupación por posición: usa la posición REAL del jugador (ficha = expediente; copia guardada si es histórico) */
const POS_GROUPS = Object.freeze([
  { key: "Portero", label: "Porteros", abbr: "POR" },
  { key: "Defensa", label: "Defensas", abbr: "DEF" },
  { key: "Mediocampista", label: "Mediocampistas", abbr: "MED" },
  { key: "Delantero", label: "Delanteros", abbr: "DEL" },
  { key: "__none", label: "Sin posición asignada", abbr: "—" },
]);
const posKey = (p) => (POS_GROUPS.some((g) => g.key === p.posicion) ? p.posicion : "__none");

protectPage({
  page: "asistencia",
  onReady(profile) {
    st.me = profile; st.uid = auth.currentUser?.uid;
    mountShell(profile, "entrenamientos");
    st.role = profile.rol === ROLE.ADMIN ? "admin" : profile.rol === ROLE.ENTRENADOR ? "coach" : null;
    const p = new URLSearchParams(location.search);
    st.catId = p.get("cat"); st.sesId = p.get("ses");
    if (!st.role || !st.uid || st.uid !== profile.uid) return fatal("No tienes permiso para consultar esta información.");
    if (!ID_RE.test(st.catId ?? "") || !ID_RE.test(st.sesId ?? "")) return fatal("La sesión indicada no es válida.", "Vuelve a Entrenamientos y elige una sesión.");
    try { const v = localStorage.getItem("cc-asis-view"); if (v === "list" || v === "cards") st.view = v; } catch { /* sin almacenamiento: vista por defecto */ }
    try { if (localStorage.getItem("cc-asis-group") === "pos") st.group = "pos"; } catch { /* opcional */ }
    wire();
    load();
  },
});

/* ---------------- Carga ---------------- */
async function load() {
  try {
    const c = await getDoc(doc(db, "categorias", st.catId));
    if (!c.exists()) return fatal("La sesión no existe o ya no está disponible.");
    st.cat = { id: c.id, ...c.data() };
    if (st.role === "coach" && st.cat.entrenadorId !== st.uid) return fatal("No tienes permiso para registrar la asistencia de esta sesión.", "Solo el entrenador de la categoría puede hacerlo.");
    st.ses = await cargarSesion(st.catId, st.sesId);
    if (!st.ses) return fatal("La sesión no existe o ya no está disponible.");
    const [saved, nomina] = await Promise.all([cargarAsistencias(st.catId, st.sesId), cargarNomina(st.catId)]);
    st.saved = saved;
    st.coachName = await nombreEntrenador(st.ses.entrenadorId);
    st.win = ventana(st.ses.fecha);
    st.editable = st.role === "coach" && st.win.abierta && can(st.me, "asistencia", st.saved.size ? ACTION.UPDATE : ACTION.CREATE);
    st.players = participantes(saved, nomina);
    st.local = new Map([...saved].map(([id, r]) => [id, r.estado]));
    renderHead(); build(); refresh();
    $("asis-body").hidden = false;
    $("asis-foot").hidden = !st.players.length;
    if (!st.players.length) {
      $("asis-body").hidden = true;
      showState("Esta categoría no tiene jugadores activos en su nómina.", "Cuando el Administrador vincule jugadores a la categoría podrás registrar su asistencia.");
    }
    lazyPhotos();
  } catch (err) {
    console.error("[CanchaControl] Asistencia:", err?.code || err);
    if (err?.code === "permission-denied") fatal("No tienes permiso para consultar esta sesión.", "Si crees que es un error, comunícate con el Administrador.");
    else fatal("No se pudo cargar la asistencia.", "Revisa tu conexión e intenta nuevamente.", true);
  }
}

async function nombreEntrenador(uid) {
  if (!uid) return "Sin asignar";
  if (uid === st.uid) return st.me.nombre;
  try { const u = await getDoc(doc(db, "users", uid)); return u.exists() ? u.data().nombre : "—"; } catch { return "Otro entrenador"; }
}

/**
 * Participantes:
 *  - Si ya hay asistencia guardada → los participantes son los guardados (histórico congelado).
 *    Datos visibles: los de la ficha actual si el jugador sigue en la categoría; si no, la copia guardada.
 *  - Si no hay → la nómina ACTIVA actual de la categoría.
 */
function participantes(saved, nomina) {
  const catName = st.cat.nombre ?? "";
  const toP = (id, f, historico) => ({ id, nombres: f.nombres ?? "", apellidos: f.apellidos ?? "", numeroCamiseta: f.numeroCamiseta ?? null,
    posicion: f.posicion ?? "", categoria: catName, historico, foto: null });
  const list = saved.size
    ? [...saved.values()].map((r) => nomina.has(r.jugadorId) ? toP(r.jugadorId, nomina.get(r.jugadorId), false) : toP(r.jugadorId, r.participante, true))
    : [...nomina.values()].filter((f) => f.estado !== "Inactivo").map((f) => toP(f.id, f, false));
  return list.sort((a, b) => `${a.nombres} ${a.apellidos}`.localeCompare(`${b.nombres} ${b.apellidos}`, "es", { sensitivity: "base" }));
}

/* ---------------- Encabezado ---------------- */
function renderHead() {
  const c = st.cat, s = st.ses;
  $("h-cat").textContent = `${c.nombre} · ${rangoLabel(c)}`;
  const meta = [["Fecha", fechaLarga(s.fecha)], ["Horario", `${s.horaInicio} – ${s.horaFin}`], ["Lugar", s.lugar], ["Entrenador", st.coachName]];
  $("h-meta").replaceChildren(...meta.map(([k, v]) => { const d = el("div", "asis-meta__item"); d.append(el("dt", "", k), el("dd", "", v)); return d; }));
  const b = [el("span", "badge badge--success", `Sesión ${s.estado.toLowerCase()}`),
    el("span", `badge ${st.saved.size ? "badge--success" : "badge--neutral"}`, st.saved.size ? "Asistencia registrada" : "Asistencia sin registrar")];
  if (st.role === "admin") b.push(el("span", "badge badge--neutral", "Solo consulta"));
  else if (!st.win.abierta) b.push(el("span", "badge badge--warning", st.win.motivo === "futura" ? "Aún no disponible" : "Plazo cerrado"));
  else b.push(el("span", "badge badge--neutral", `Editable hasta el ${fechaCorta(st.win.hasta)}`));
  $("h-badges").replaceChildren(...b);
  document.title = `Asistencia ${c.nombre} · CanchaControl`;
  const note = $("f-note");
  const txt = st.role === "admin" ? "Solo consulta: el Administrador no modifica la asistencia."
    : st.win.motivo === "futura" ? MSG.futura
    : st.win.motivo === "cerrada" ? `${MSG.cerrada} (hasta el ${fechaCorta(st.win.hasta)}).` : "";
  note.textContent = txt; note.hidden = !txt;
  $("save-btn").hidden = !st.editable;
  $("mark-all").hidden = !st.editable;
}

/* ---------------- Construcción (una vez) ---------------- */
function build() {
  const body = $("list-body");
  st.cards.clear(); st.rows.clear();
  const cards = [], rows = [];
  for (const p of st.players) {
    const card = createPlayer3DCard(p, st.local.get(p.id) ?? null, { onSelect: select, readOnly: !st.editable });
    st.cards.set(p.id, card); cards.push(card);
    rows.push(buildRow(p));
  }
  body.replaceChildren(...rows);
  st.groups.clear();
  layoutCards();
  applyView();
}

/* Coloca las MISMAS tarjetas (mismos nodos, mismo estado) con o sin grupos. No toca datos ni Firestore. */
function layoutCards() {
  const grid = $("cards");
  $("group-by").value = st.group;
  if (st.group !== "pos") {
    grid.classList.remove("is-grouped");
    grid.replaceChildren(...st.players.map((p) => st.cards.get(p.id)));
    return;
  }
  grid.classList.add("is-grouped");
  const sections = [];
  for (const g of POS_GROUPS) {
    const members = st.players.filter((p) => posKey(p) === g.key);
    if (!members.length) continue;
    let ref = st.groups.get(g.key);
    if (!ref) ref = groupSection(g);
    ref.body.replaceChildren(...members.map((p) => st.cards.get(p.id)));
    ref.ids = members.map((p) => p.id);
    sections.push(ref.sec);
  }
  grid.replaceChildren(...sections);
}

function groupSection(g) {
  const sec = el("section", "pc-group"); sec.dataset.pos = g.key;
  const bodyId = `grp-${g.abbr === "—" ? "none" : g.abbr.toLowerCase()}`;
  const head = el("button", "pc-group__head"); head.type = "button";
  head.setAttribute("aria-controls", bodyId);
  const abbr = el("span", "pc-group__abbr", g.abbr); abbr.setAttribute("aria-hidden", "true");
  const label = el("span", "pc-group__label", g.label);
  const count = el("span", "pc-group__count");
  const line = el("span", "pc-group__line"); line.setAttribute("aria-hidden", "true");
  const chev = el("span", "pc-group__chev"); chev.setAttribute("aria-hidden", "true");
  chev.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
  head.append(abbr, label, count, line, chev);
  const body = el("div", "pc-group__grid"); body.id = bodyId;
  const setOpen = (open) => { head.setAttribute("aria-expanded", String(open)); body.hidden = !open; };
  setOpen(!st.collapsed.has(g.key));
  head.addEventListener("click", () => {
    const open = head.getAttribute("aria-expanded") !== "true";
    if (open) st.collapsed.delete(g.key); else st.collapsed.add(g.key);
    setOpen(open);
  });
  sec.append(head, body);
  const ref = { sec, head, body, count, label, ids: [], g };
  st.groups.set(g.key, ref);
  return ref;
}

function buildRow(p) {
  const tr = el("tr"); tr.dataset.id = p.id;
  const nombre = `${p.nombres} ${p.apellidos}`.trim();
  const who = el("td"); const w = el("div", "asis-who");
  const av = el("span", "asis-av"); av.append(jerseyAvatar(p)); av.dataset.ini = iniciales(p.nombres, p.apellidos);
  const nm = el("div"); nm.append(el("p", "asis-who__n", nombre)); if (p.historico) nm.append(el("p", "asis-who__s", "Ya no está en la categoría (histórico)"));
  w.append(av, nm); who.append(w);
  const est = el("td"); est.append(el("span", "asis-pill"));
  const act = el("td"); const g = el("div", "asis-seg"); g.setAttribute("role", "group"); g.setAttribute("aria-label", `Asistencia de ${nombre}`);
  for (const e of ESTADOS) {
    const b = el("button", `asis-seg__btn asis-seg__btn--${ESTADO_INFO[e].key}`); b.type = "button"; b.dataset.estado = e;
    b.innerHTML = stateIcon(e, 16); b.append(el("span", "", ESTADO_INFO[e].label));
    b.setAttribute("aria-pressed", "false"); b.disabled = !st.editable;
    b.addEventListener("click", () => select(p.id, e));
    g.append(b);
  }
  act.append(g);
  tr.append(who, el("td", "asis-num", p.numeroCamiseta ?? "–"), el("td", "", p.posicion || "—"), est, act);
  st.rows.set(p.id, tr);
  paintRow(p.id);
  return tr;
}

function paintRow(id) {
  const tr = st.rows.get(id); const e = st.local.get(id) ?? null;
  tr.dataset.state = stateKey(e);
  const pill = tr.querySelector(".asis-pill"); pill.className = `asis-pill is-${stateKey(e)}`;
  pill.innerHTML = stateIcon(e, 14); pill.append(el("span", "", stateLabel(e)));
  tr.querySelectorAll(".asis-seg__btn").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.estado === e)));
  tr.classList.remove("is-missing");
}

/* ---------------- Selección (local; se escribe al Guardar) ---------------- */
function select(id, estado) {
  if (!st.editable || st.saving) return;
  if (!ESTADOS.includes(estado)) return;
  st.local.set(id, estado);                               // un solo estado por jugador (Map)
  setCardEstado(st.cards.get(id), estado);
  paintRow(id);
  refresh();
}

function cambios() {
  return st.players.filter((p) => st.local.has(p.id) && st.local.get(p.id) !== st.saved.get(p.id)?.estado)
    .map((p) => ({ jugadorId: p.id, estado: st.local.get(p.id), previo: st.saved.has(p.id) ? { version: st.saved.get(p.id).version } : null,
      participante: { nombres: p.nombres, apellidos: p.apellidos, numeroCamiseta: p.numeroCamiseta, posicion: p.posicion } }));
}
const pendientes = () => st.players.filter((p) => !st.local.has(p.id));

/* ---------------- KPI, filtros, progreso ---------------- */
function refresh() {
  const n = st.players.length, cnt = (e) => st.players.filter((p) => st.local.get(p.id) === e).length;
  const pend = pendientes().length;
  $("k-total").textContent = n; $("k-ok").textContent = cnt("Asistió"); $("k-falta").textContent = cnt("Falta");
  $("k-excusa").textContent = cnt("Excusa"); $("k-atraso").textContent = cnt("Atraso"); $("k-pend").textContent = pend;
  $("f-done").textContent = n - pend; $("f-total").textContent = n; $("f-pend").textContent = pend;
  const bar = $("f-bar"); bar.setAttribute("aria-valuemax", String(n)); bar.setAttribute("aria-valuenow", String(n - pend));
  $("f-bar-fill").style.width = `${n ? ((n - pend) / n) * 100 : 0}%`;
  const ch = cambios().length;
  const d = $("dirty"); d.hidden = !ch; d.textContent = ch ? `${ch} ${ch === 1 ? "cambio" : "cambios"} sin guardar` : "";
  $("mark-all").disabled = !pend;
  applyFilter();
}

function visible(p) {
  const e = st.local.get(p.id) ?? null;
  if (st.filtro === "__pend" && e) return false;
  if (st.filtro && st.filtro !== "__pend" && e !== st.filtro) return false;
  if (st.q && !norm(`${p.nombres} ${p.apellidos}`).includes(st.q)) return false;
  return true;
}
function applyFilter() {
  let shown = 0;
  for (const p of st.players) {
    const v = visible(p); if (v) shown++;
    st.cards.get(p.id).hidden = !v; st.rows.get(p.id).hidden = !v;
  }
  $("filter-empty").hidden = shown > 0 || !st.players.length;
  if (st.group === "pos") {
    for (const ref of st.groups.values()) {
      if (!ref.sec.isConnected) continue;
      const n = ref.ids.filter((id) => !st.cards.get(id).hidden).length;   // solo los visibles con búsqueda + filtro
      ref.count.textContent = `${n} ${n === 1 ? "jugador" : "jugadores"}`;
      ref.head.setAttribute("aria-label", `${ref.g.label}: ${n} ${n === 1 ? "jugador" : "jugadores"}`);
      ref.sec.hidden = n === 0;
    }
  }
}
function applyView() {
  $("cards").hidden = st.view !== "cards"; $("list").hidden = st.view !== "list";
  $("group-by").hidden = st.view !== "cards";                // la agrupación aplica a la vista Tarjetas
  document.querySelectorAll(".seg__btn").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === st.view)));
}

/* ---------------- Fotos (diferidas: solo las tarjetas que se ven) ---------------- */
function lazyPhotos() {
  const load = async (id) => {
    const p = st.players.find((x) => x.id === id); if (!p || p.foto !== null) return;
    p.foto = false;
    const f = await getFoto(id);                         // sin permiso o sin foto → null (queda el avatar)
    if (!f) return;
    p.foto = f;
    setCardPhoto(st.cards.get(id), p);
    const av = st.rows.get(id)?.querySelector(".asis-av"); if (av) { const img = el("img"); img.src = f; img.alt = ""; av.replaceChildren(img); }
  };
  if (!("IntersectionObserver" in window)) { st.players.forEach((p) => load(p.id)); return; }
  const io = new IntersectionObserver((ents) => ents.forEach((en) => { if (en.isIntersecting) { io.unobserve(en.target); load(en.target.dataset.id); } }), { rootMargin: "200px" });
  st.cards.forEach((c) => io.observe(c)); st.rows.forEach((r) => io.observe(r));
}

/* ---------------- Guardar ---------------- */
async function guardar() {
  if (st.saving || !st.editable) return;
  hideAlert();
  const pend = pendientes();
  if (pend.length) {
    pend.forEach((p) => { st.cards.get(p.id).classList.add("is-missing"); st.rows.get(p.id).classList.add("is-missing"); });
    showAlert(MSG.pendientes);
    toast("error", MSG.pendientes);
    if (st.view === "cards" && st.group === "pos") {
      for (const p of pend) { const ref = st.groups.get(posKey(p)); if (ref && ref.head.getAttribute("aria-expanded") === "false") ref.head.click(); }
    }
    const first = (st.view === "cards" ? st.cards : st.rows).get(pend[0].id);
    if (!first.hidden) first.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
    return;
  }
  const ch = cambios();
  if (!ch.length) { toast("info", "No hay cambios por guardar."); return; }
  setSaving(true);
  try {
    await guardarAsistencia({ catId: st.catId, sesId: st.sesId, cambios: ch, actorUid: st.uid,
      sesionSnap: { fecha: st.ses.fecha, horaInicio: st.ses.horaInicio, horaFin: st.ses.horaFin, lugar: st.ses.lugar, categoriaNombre: st.cat.nombre } });
    st.saved = await cargarAsistencias(st.catId, st.sesId);   // confirmación del servidor (versiones nuevas)
    setSaving(false); renderHead(); refresh();
    toast("success", "Asistencia guardada correctamente.");
  } catch (err) {
    console.error("[CanchaControl] Guardar asistencia:", err?.code || err);
    setSaving(false);
    const msg = friendlyAsistenciaError(err);
    if (err?.code === "conflict" || err?.code === "partial") {
      try { st.saved = await cargarAsistencias(st.catId, st.sesId); } catch { /* se informa abajo */ }
      renderHead(); refresh();
    }
    showAlert(msg); toast("error", msg);
  }
}
function setSaving(on) {
  st.saving = on;
  const b = $("save-btn"); b.disabled = on;
  b.innerHTML = on ? '<span class="spinner" aria-hidden="true"></span><span class="btn-label">Guardando…</span>' : '<span class="btn-label">Guardar asistencia</span>';
  document.querySelectorAll(".pc__btn, .asis-seg__btn").forEach((x) => { x.disabled = on || !st.editable; });
  $("mark-all").disabled = on || !pendientes().length;
}
function showAlert(m) { const a = $("asis-alert"); a.textContent = m; a.hidden = false; }
function hideAlert() { $("asis-alert").hidden = true; }

/* ---------------- Estados de pantalla ---------------- */
function showState(title, text, retry = false) {
  const s = $("asis-state"); s.hidden = false;
  const box = el("div", "empty");
  box.append(el("p", "empty__title", title)); if (text) box.append(el("p", "empty__text", text));
  if (retry) { const b = el("button", "btn btn-primary empty__btn", "Intentar de nuevo"); b.type = "button"; b.addEventListener("click", () => location.reload()); box.append(b); }
  s.replaceChildren(box);
}
function fatal(title, text = "", retry = false) {
  $("asis-head").hidden = true; $("asis-body").hidden = true; $("asis-foot").hidden = true;
  showState(title, text, retry);
}

/* ---------------- Modales propios ---------------- */
let returnFocus = null;
function openModal(id) { returnFocus = document.activeElement; const m = $(id); m.classList.add("is-open"); m.setAttribute("aria-hidden", "false"); $("app").inert = true; setTimeout(() => m.querySelector("[data-cancel].btn")?.focus(), 50); }
function closeModal(id) { const m = $(id); m.classList.remove("is-open"); m.setAttribute("aria-hidden", "true"); $("app").inert = false; returnFocus?.focus?.(); }

/* ---------------- Eventos ---------------- */
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function wire() {
  initFilterCards($("asis-kpis"), (v) => { st.filtro = v; applyFilter(); }, "");
  $("search").addEventListener("input", debounce(() => { st.q = norm($("search").value); applyFilter(); }, 200));
  document.querySelectorAll(".seg__btn").forEach((b) => b.addEventListener("click", () => {
    st.view = b.dataset.view; applyView();
    try { localStorage.setItem("cc-asis-view", st.view); } catch { /* opcional */ }
  }));
  $("save-btn").addEventListener("click", guardar);
  $("group-by").addEventListener("change", (e) => {
    st.group = e.target.value === "pos" ? "pos" : "none";
    layoutCards(); applyFilter();
    try { localStorage.setItem("cc-asis-group", st.group); } catch { /* opcional */ }
  });
  $("mark-all").addEventListener("click", () => {
    const n = pendientes().length; if (!n || !st.editable) return;
    $("all-text").textContent = `Se marcarán como "Asistió" los ${n} jugadores pendientes. Los que ya marcaste no cambian y podrás corregir cualquiera antes de guardar.`;
    openModal("all-modal");
  });
  $("all-ok").addEventListener("click", () => {
    closeModal("all-modal");
    pendientes().forEach((p) => select(p.id, "Asistió"));
    toast("info", "Pendientes marcados como Asistió. Revisa las excepciones y guarda.");
  });
  $("back-link").addEventListener("click", (e) => { if (cambios().length && st.editable) { e.preventDefault(); openModal("leave-modal"); } });
  $("leave-ok").addEventListener("click", () => { st.leaving = true; location.href = "entrenamientos.html"; });
  for (const id of ["all-modal", "leave-modal"]) $(id).querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", () => closeModal(id)));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    for (const id of ["all-modal", "leave-modal"]) if ($(id).classList.contains("is-open")) { e.preventDefault(); closeModal(id); }
  });
  window.addEventListener("beforeunload", (e) => { if (!st.leaving && st.editable && cambios().length) { e.preventDefault(); e.returnValue = ""; } });
}
