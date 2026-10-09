/* ==========================================================
   CanchaControl — Partidos, rendimiento y alineación táctica (HU-013)
   ----------------------------------------------------------
   Entrenador: gestiona SUS categorías (crear/editar partidos, convocar,
   registrar rendimiento y organizar la alineación libre).
   Administrador: consulta (solo lectura).
   Las tres pestañas trabajan sobre los MISMOS partidos y convocados.
   Nada se muestra como guardado antes de la confirmación de Firestore.
   ========================================================== */
import { protectPage } from "./authGuard.js";
import { ROLE } from "./permissions.js";
import { auth } from "./auth.js";
import { mountShell } from "./shell.js";
import { toast, initFilterCards } from "./ui.js";
import { subscribeCategorias, subscribeMisCategorias } from "./categorias-data.js";
import { getFoto } from "./jugadores-data.js";
import { cargarNomina } from "./asistencia-data.js";
import { createPlayer3DCard, setCardBadge, setCardPhoto, posAbbr } from "./player-card.js";
import { createPitch, ratingClass, ratingText, ICON } from "./pitch.js";
import {
  TIPOS, ESTADOS, FORMATOS, POS_TACTICAS, MSG, LIM, isoHoy, ventanaRendimiento, subscribePartidos,
  crearPartido, actualizarPartido, cargarParticipantes, guardarConvocatoria, cargarRendimientos,
  validarRendimiento, parseValoracion, guardarRendimiento, cargarAlineacion, guardarAlineacion, formacion, friendlyPartidoError,
} from "./partidos-data.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const norm = (s) => String(s ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
const MES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const fechaLarga = (iso) => { if (!iso) return "—"; const [y, m, d] = iso.split("-").map(Number); const s = new Date(y, m - 1, d).toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long", year: "numeric" }); return s[0].toUpperCase() + s.slice(1); };
const fechaCorta = (iso) => { const [y, m, d] = iso.split("-").map(Number); return `${d} ${MES[m - 1]} ${y}`; };
const key = (p) => `${p.categoriaId}/${p.id}`;
const POS_GROUPS = [["Portero", "Porteros", "POR"], ["Defensa", "Defensas", "DEF"], ["Mediocampista", "Mediocampistas", "MED"], ["Delantero", "Delanteros", "DEL"], ["__none", "Sin posición", "—"]];
const posGroup = (p) => (POS_TACTICAS.includes(p.posicion) ? p.posicion : "__none");
const toneRating = (v) => (typeof v !== "number" ? "pend" : v < 5 ? "falta" : v < 7 ? "atraso" : v < 8.5 ? "ok" : "oro");

const st = {
  me: null, uid: null, role: null, cats: new Map(), catKey: "", unsubP: null,
  partidos: [], loaded: false, error: null,
  filtro: "", q: "", catFil: "",
  tab: "partidos",
  cache: new Map(),          // key → { part, rend, alin }
  fotos: new Map(),
  rSel: "", aSel: "",
  pitch: null, alinSaved: null, alinWork: null, alinDirty: false,
  saving: false,
};

protectPage({
  page: "partidos",
  onReady(profile) {
    st.me = profile; st.uid = auth.currentUser?.uid;
    st.role = profile.rol === ROLE.ADMIN ? "admin" : profile.rol === ROLE.ENTRENADOR ? "coach" : null;
    mountShell(profile, "partidos");
    if (!st.role || !st.uid || st.uid !== profile.uid) return fatal(MSG.sinPermiso);
    $("new-btn").hidden = st.role !== "coach";
    if (st.role === "admin") $("mp-sub").textContent = "Consulta los partidos, el rendimiento y las alineaciones de todas las categorías.";
    wire();
    const onCats = (list) => setCats(list);
    const onErr = (err) => { console.error("[CanchaControl] Categorías:", err?.code || err); fatal(err?.code === "permission-denied" ? MSG.sinPermiso : MSG.errorCargar); };
    if (st.role === "admin") subscribeCategorias(onCats, onErr); else subscribeMisCategorias(st.uid, onCats, onErr);
    const h = location.hash.replace("#/", "");
    if (["partidos", "rend", "alin"].includes(h)) selectTab(h, false);
  },
});

const isCoachOf = (catId) => st.role === "coach" && st.cats.get(catId)?.entrenadorId === st.uid;
const partidoByKey = (k) => st.partidos.find((p) => key(p) === k) ?? null;
const catName = (id) => st.cats.get(id)?.nombre ?? "Categoría";

/* ==========================================================
   Datos
   ========================================================== */
function setCats(list) {
  st.cats = new Map(list.map((c) => [c.id, c]));
  const ids = [...st.cats.keys()].sort(); const k = ids.join("|");
  fillCatSelects();
  if (k === st.catKey) return;
  st.catKey = k; st.unsubP?.();
  st.loaded = false; renderAll();
  st.unsubP = subscribePartidos(ids, (l) => { st.partidos = l; st.loaded = true; st.error = null; renderAll(); },
    (err) => { console.error("[CanchaControl] Partidos:", err?.code || err); st.error = err; st.loaded = true; renderAll(); });
}

async function datos(k, { force = false } = {}) {
  const p = partidoByKey(k); if (!p) return null;
  let c = st.cache.get(k);
  if (!c || force) {
    const [part, rend, alin] = await Promise.all([cargarParticipantes(p.categoriaId, p.id), cargarRendimientos(p.categoriaId, p.id), cargarAlineacion(p.categoriaId, p.id)]);
    c = { part, rend, alin }; st.cache.set(k, c);
  }
  return c;
}
async function foto(jid) {
  if (st.fotos.has(jid)) return st.fotos.get(jid);
  let f = null; try { f = await getFoto(jid); } catch { f = null; }
  st.fotos.set(jid, f); return f;
}
const persona = (p) => ({ id: p.id, nombres: p.nombres ?? "", apellidos: p.apellidos ?? "", numeroCamiseta: p.numeroCamiseta ?? null, posicion: p.posicion ?? "", foto: st.fotos.get(p.id) ?? null });

/* ==========================================================
   Pestañas
   ========================================================== */
function selectTab(t, push = true) {
  if (st.tab === "alin" && t !== "alin" && st.alinDirty) { toast("info", "Guarda o descarta los cambios de la alineación antes de salir."); return; }
  st.tab = t;
  for (const b of document.querySelectorAll("[role=tab]")) { const on = b.dataset.tab === t; b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; }
  $("pan-partidos").hidden = t !== "partidos"; $("pan-rend").hidden = t !== "rend"; $("pan-alin").hidden = t !== "alin";
  if (push) history.replaceState(null, "", `#/${t}`);
  renderAll();
}
function renderAll() {
  renderPartidos();
  if (st.tab === "rend") renderRend();
  if (st.tab === "alin") renderAlin();
}

/* ==========================================================
   PARTIDOS
   ========================================================== */
function fillCatSelects() {
  const cats = [...st.cats.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  for (const id of ["p-cat", "r-cat"]) {
    const s = $(id), cur = s.value;
    s.replaceChildren(new Option(id === "p-cat" ? "Todas las categorías" : "Todas", ""), ...cats.map((c) => new Option(c.nombre, c.id)));
    s.value = st.cats.has(cur) ? cur : "";
  }
}

function renderPartidos() {
  const ul = $("p-list"), em = $("p-empty");
  if (!st.loaded) { ul.innerHTML = '<li><span class="skel" style="height:84px"></span></li><li><span class="skel" style="height:84px"></span></li>'; em.hidden = true; return; }
  if (st.error) { ul.replaceChildren(); return emptyBox(em, st.error.code === "permission-denied" ? MSG.sinPermiso : MSG.errorCargar, "", null); }
  const base = st.partidos.filter((p) => (!st.catFil || p.categoriaId === st.catFil) && (!st.q || norm(`${p.rival} ${p.lugar}`).includes(st.q)));
  $("pk-total").textContent = base.length;
  $("pk-prog").textContent = base.filter((p) => p.estado === "Programado").length;
  $("pk-disp").textContent = base.filter((p) => p.estado === "Disputado").length;
  $("pk-canc").textContent = base.filter((p) => p.estado === "Cancelado").length;
  const list = base.filter((p) => !st.filtro || p.estado === st.filtro);
  if (!st.partidos.length) { ul.replaceChildren(); return emptyBox(em, MSG.sinPartidos, st.role === "coach" ? "Crea el primero con «Nuevo partido»." : "", st.role === "coach" && st.cats.size ? ["+ Nuevo partido", () => openForm()] : null); }
  if (!list.length) { ul.replaceChildren(); return emptyBox(em, "No hay partidos con estos criterios.", "Prueba con otro filtro.", null); }
  em.hidden = true;
  ul.replaceChildren(...list.map(itemPartido));
}

function itemPartido(p) {
  const li = el("li", "mp-item"); li.dataset.key = key(p);
  const [y, m, d] = p.fecha.split("-");
  const date = el("div", "mp-date"); date.append(el("strong", "", String(Number(d))), el("span", "", `${MES[Number(m) - 1]} ${y}`));
  const main = el("div", "mp-item__main");
  main.append(el("p", "mp-item__t", `vs ${p.rival}`));
  const meta = el("p", "mp-item__meta");
  [catName(p.categoriaId), p.tipo, FORMATOS[p.formatoPartido]?.label, p.hora, p.lugar].filter(Boolean).forEach((t) => meta.append(el("span", "", t)));
  main.append(meta);
  const badge = el("span", `badge mp-estado is-${norm(p.estado)}`, p.estado);
  const acts = el("div", "mp-item__acts");
  const b = (label, fn, opts = {}) => { const x = el("button", `mp-act${opts.primary ? " is-primary" : ""}`, label); x.type = "button"; x.disabled = !!opts.disabled; if (opts.title) x.title = opts.title; x.addEventListener("click", fn); x.dataset.act = opts.act ?? ""; return x; };
  acts.append(b("Ver", () => openDetail(p), { act: "ver" }));
  if (isCoachOf(p.categoriaId)) acts.append(b("Editar", () => openForm(p), { act: "editar" }));
  acts.append(b(isCoachOf(p.categoriaId) ? "Convocados" : "Ver convocados", () => openConvocatoria(p), { act: "convocados" }));
  acts.append(b("Rendimiento", () => goRend(p), { act: "rend", disabled: p.estado !== "Disputado", title: p.estado !== "Disputado" ? MSG.soloDisputado : "" }));
  acts.append(b("Alineación", () => goAlin(p), { act: "alin" }));
  li.append(date, main, badge, acts);
  return li;
}

function goRend(p) { st.rSel = key(p); $("r-cat").value = ""; selectTab("rend"); }
function goAlin(p) { if (st.alinDirty && st.aSel !== key(p)) { toast("info", "Guarda o descarta los cambios de la alineación antes de cambiar de partido."); return; } st.aSel = key(p); selectTab("alin"); }

function openDetail(p) {
  $("pd-title").textContent = `vs ${p.rival}`;
  $("pd-sub").textContent = `${catName(p.categoriaId)} · ${fechaLarga(p.fecha)}`;
  const rows = [["Categoría", catName(p.categoriaId)], ["Fecha", fechaLarga(p.fecha)], ["Hora", p.hora], ["Rival", p.rival], ["Lugar", p.lugar || "—"],
    ["Tipo", p.tipo], ["Formato", `${FORMATOS[p.formatoPartido]?.label} (${FORMATOS[p.formatoPartido]?.titulares} titulares)`], ["Estado", p.estado],
    ["Observaciones", p.observaciones || "—"]];
  $("pd-list").replaceChildren(...rows.map(([k, v]) => { const w = el("div"); w.append(el("dt", "", k), el("dd", "", v)); return w; }));
  const acts = $("pd-actions"); acts.replaceChildren();
  const btn = (label, fn, cls = "btn btn-soft") => { const b = el("button", cls, label); b.type = "button"; b.addEventListener("click", () => { closePanel("pd-drawer"); fn(); }); return b; };
  if (isCoachOf(p.categoriaId)) acts.append(btn("Editar partido", () => openForm(p)));
  acts.append(btn("Convocados", () => openConvocatoria(p)));
  if (p.estado === "Disputado") acts.append(btn("Registrar rendimiento", () => goRend(p), "btn btn-primary"));
  acts.append(btn("Ver alineación", () => goAlin(p)));
  openPanel("pd-drawer", "[data-close].icon-btn");
}

/* ---------- Formulario de partido ---------- */
let pfEditing = null;
const PF = ["cat", "rival", "fecha", "hora", "lugar", "tipo", "formato", "estado"];
function setErr(f, m) { $(`pf-${f}-err`).textContent = m; $(`pf-${f}`).setAttribute("aria-invalid", "true"); $(`pf-${f}`).closest(".f-field")?.classList.add("has-error"); }
function clrErr(f) { $(`pf-${f}-err`).textContent = ""; $(`pf-${f}`).setAttribute("aria-invalid", "false"); $(`pf-${f}`).closest(".f-field")?.classList.remove("has-error"); }

async function openForm(p = null) {
  if (st.role !== "coach") return;
  pfEditing = p;
  $("pf-form").reset(); PF.forEach(clrErr); $("pf-alert").hidden = true;
  $("pf-title").textContent = p ? "Editar partido" : "Nuevo partido";
  $("pf-sub").textContent = p ? `${catName(p.categoriaId)} · vs ${p.rival}` : "Registra un encuentro de una de tus categorías.";
  const cats = [...st.cats.values()].filter((c) => c.entrenadorId === st.uid && (c.estado === "Activa" || c.id === p?.categoriaId))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  if (!p && !cats.length) { toast("info", "No tienes categorías activas para registrar partidos."); return; }
  $("pf-cat").replaceChildren(new Option("Selecciona una categoría…", ""), ...cats.map((c) => new Option(c.nombre, c.id)));
  $("pf-cat").disabled = !!p;
  $("pf-tipo").replaceChildren(...TIPOS.map((t) => new Option(t, t)));
  $("pf-formato").replaceChildren(...Object.entries(FORMATOS).map(([k, v]) => new Option(`${v.label} · ${v.titulares} titulares`, k)));
  $("pf-estado").replaceChildren(...ESTADOS.map((e) => { const o = new Option(e, e); if (p?.conRendimiento && e !== "Disputado") o.disabled = true; return o; }));
  if (p) {
    $("pf-cat").value = p.categoriaId; $("pf-rival").value = p.rival; $("pf-fecha").value = p.fecha; $("pf-hora").value = p.hora;
    $("pf-lugar").value = p.lugar; $("pf-tipo").value = p.tipo; $("pf-formato").value = p.formatoPartido; $("pf-estado").value = p.estado; $("pf-obs").value = p.observaciones;
    if (p.conRendimiento) { const a = $("pf-alert"); a.className = "info-alert"; a.textContent = MSG.bloqueoEstado; a.hidden = false; }
  } else {
    $("pf-tipo").value = "Amistoso"; $("pf-formato").value = "F11"; $("pf-estado").value = "Programado";
    if (st.catFil && cats.some((c) => c.id === st.catFil)) $("pf-cat").value = st.catFil;
  }
  openPanel("pf-drawer", p ? "#pf-rival" : "#pf-cat");
}

async function onSaveForm(e) {
  e.preventDefault();
  if (st.saving) return;
  PF.forEach(clrErr); const a = $("pf-alert"); a.hidden = true; a.className = "f-alert";
  const v = { cat: $("pf-cat").value, rival: $("pf-rival").value.replace(/\s+/g, " ").trim(), fecha: $("pf-fecha").value, hora: $("pf-hora").value,
    lugar: $("pf-lugar").value.trim(), tipo: $("pf-tipo").value, formatoPartido: $("pf-formato").value, estado: $("pf-estado").value, observaciones: $("pf-obs").value };
  let ok = true; const bad = (f, m) => { setErr(f, m); ok = false; };
  if (!v.cat || !st.cats.has(v.cat)) bad("cat", "Selecciona la categoría.");
  else if (!isCoachOf(v.cat)) bad("cat", MSG.sinPermiso);
  if (v.rival.length < 2) bad("rival", "Escribe el nombre del equipo rival.");
  else if (v.rival.length > LIM.RIVAL_MAX) bad("rival", `Máximo ${LIM.RIVAL_MAX} caracteres.`);
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(v.fecha)) bad("fecha", "Selecciona una fecha válida.");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v.hora)) bad("hora", "Indica la hora.");
  if (v.lugar.length > LIM.LUGAR_MAX) bad("lugar", `Máximo ${LIM.LUGAR_MAX} caracteres.`);
  if (!TIPOS.includes(v.tipo)) bad("tipo", "Tipo no válido.");
  if (!FORMATOS[v.formatoPartido]) bad("formato", "Formato no válido.");
  if (!ESTADOS.includes(v.estado)) bad("estado", "Estado no válido.");
  else if (v.estado === "Disputado" && v.fecha > isoHoy()) bad("estado", MSG.disputadoFuturo);
  if (pfEditing?.conRendimiento && v.estado !== "Disputado") bad("estado", MSG.bloqueoEstado);
  if (ok && pfEditing && v.formatoPartido !== pfEditing.formatoPartido) {
    try {
      const c = await datos(key(pfEditing), { force: true });
      const n = c?.alin?.ubicaciones.size ?? 0, max = FORMATOS[v.formatoPartido].titulares;
      if (n > max) bad("formato", `La alineación tiene ${n} titulares. Retira ${n - max} antes de cambiar a ${FORMATOS[v.formatoPartido].label}.`);
    } catch { /* las reglas lo verifican igualmente */ }
  }
  if (!ok) { $("pf-form").querySelector("[aria-invalid=true]")?.focus(); return; }
  setBtn("pf-save", true, "Guardar partido"); st.saving = true;
  try {
    if (pfEditing) await actualizarPartido(pfEditing.categoriaId, pfEditing.id, v, st.uid, pfEditing.version);
    else await crearPartido(v.cat, v, st.uid);
    closePanel("pf-drawer", true);
    toast("success", pfEditing ? "Partido actualizado correctamente." : "Partido creado correctamente.");
    if (pfEditing) st.cache.delete(key(pfEditing));
  } catch (err) {
    console.error("[CanchaControl] Partido:", err?.code || err);
    a.textContent = friendlyPartidoError(err); a.hidden = false;
  } finally { st.saving = false; setBtn("pf-save", false, "Guardar partido"); }
}

/* ---------- Convocatoria ---------- */
let cv = null;
async function openConvocatoria(p) {
  const editable = isCoachOf(p.categoriaId) && p.estado !== "Cancelado";
  cv = { p, editable, sel: new Set(), part: null, rend: null, alin: null, nomina: null, cards: new Map() };
  $("cv-title").textContent = editable ? "Convocados del partido" : "Convocados";
  $("cv-sub").textContent = `vs ${p.rival} · ${catName(p.categoriaId)} · ${fechaLarga(p.fecha)}`;
  $("cv-list").innerHTML = '<div class="skel" style="height:220px"></div>'; $("cv-alert").hidden = true;
  $("cv-save").hidden = !editable; $("cv-all").hidden = !editable;
  openPanel("cv-drawer", "[data-close].icon-btn");
  try {
    const [c, nom] = await Promise.all([datos(key(p), { force: true }), cargarNomina(p.categoriaId)]);
    cv.part = c.part; cv.rend = c.rend; cv.alin = c.alin; cv.nomina = nom;
    cv.sel = new Set(c.part.keys());
    renderConvocatoria();
  } catch (err) {
    console.error("[CanchaControl] Convocatoria:", err?.code || err);
    $("cv-list").replaceChildren(el("p", "empty__text", err?.code === "permission-denied" ? MSG.sinPermiso : MSG.errorCargar));
  }
}
function cvPlayers() {
  const m = new Map();
  for (const f of cv.nomina.values()) if (f.estado !== "Inactivo" || cv.part.has(f.id)) m.set(f.id, { ...persona(f), historico: false });
  for (const pa of cv.part.values()) if (!m.has(pa.id)) m.set(pa.id, { ...persona(pa), historico: true });
  return [...m.values()].sort((a, b) => (a.numeroCamiseta ?? 999) - (b.numeroCamiseta ?? 999) || a.nombres.localeCompare(b.nombres, "es"));
}
function renderConvocatoria() {
  const players = cvPlayers();
  const box = $("cv-list");
  if (!players.length) { box.replaceChildren(el("p", "empty__text", "La categoría no tiene jugadores activos en su nómina.")); updCv(); return; }
  const grouped = $("cv-group").value === "pos";
  const mk = (p) => {
    const item = el("button", "mp-cv-item"); item.type = "button"; item.dataset.id = p.id;
    const card = createPlayer3DCard({ ...p, categoria: p.historico ? `${catName(cv.p.categoriaId)} · histórico` : catName(cv.p.categoriaId) }, null, { presentational: true });
    cv.cards.set(p.id, card);
    const lock = cv.rend.has(p.id) ? "Tiene estadísticas" : cv.alin?.ubicaciones.has(p.id) ? "En la alineación" : "";
    item.append(card);
    if (lock) item.append(el("span", "mp-cv-lock", lock));
    item.disabled = !cv.editable;
    item.addEventListener("click", () => {
      if (!cv.editable) return;
      if (cv.sel.has(p.id)) {
        if (cv.rend.has(p.id)) { toast("info", "No puedes quitarlo: ya tiene estadísticas registradas en este partido."); return; }
        if (cv.alin?.ubicaciones.has(p.id)) { toast("info", "Está en la alineación guardada. Envíalo al banco y guarda la alineación antes de quitarlo."); return; }
        cv.sel.delete(p.id);
      } else cv.sel.add(p.id);
      paintCv(p.id); updCv();
    });
    if (st.fotos.has(p.id)) { if (st.fotos.get(p.id)) setCardPhoto(card, { ...p, foto: st.fotos.get(p.id) }); }
    else foto(p.id).then((f) => { if (f) setCardPhoto(card, { ...p, foto: f }); });
    return item;
  };
  cv.cards.clear();
  if (!grouped) { const g = el("div", "mp-cv-grid"); players.forEach((p) => g.append(mk(p))); box.replaceChildren(g); }
  else {
    const out = [];
    for (const [k, label, abbr] of POS_GROUPS) {
      const ps = players.filter((p) => posGroup(p) === k); if (!ps.length) continue;
      const h = el("h3", "mp-grp"); h.append(el("span", "mp-grp__abbr", abbr), el("span", "", label), el("span", "mp-grp__n", String(ps.length)));
      const g = el("div", "mp-cv-grid"); ps.forEach((p) => g.append(mk(p)));
      out.push(h, g);
    }
    box.replaceChildren(...out);
  }
  players.forEach((p) => paintCv(p.id)); updCv();
}
function paintCv(id) {
  const card = cv.cards.get(id); const on = cv.sel.has(id);
  const item = card?.closest(".mp-cv-item"); if (!item) return;
  item.setAttribute("aria-pressed", String(on));
  setCardBadge(card, on ? "ok" : "pend", on ? "Convocado" : "No convocado", on ? "Asistió" : null);
}
function updCv() {
  const add = [...cv.sel].filter((id) => !cv.part.has(id)), rem = [...cv.part.keys()].filter((id) => !cv.sel.has(id));
  $("cv-count").textContent = `${cv.sel.size} convocados${add.length || rem.length ? ` · ${add.length + rem.length} cambios sin guardar` : ""}`;
}
async function saveConvocatoria() {
  if (!cv || !cv.editable || st.saving) return;
  const players = new Map(cvPlayers().map((p) => [p.id, p]));
  const add = [...cv.sel].filter((id) => !cv.part.has(id)).map((id) => players.get(id));
  const rem = [...cv.part.keys()].filter((id) => !cv.sel.has(id));
  if (!add.length && !rem.length) { closePanel("cv-drawer", true); return; }
  st.saving = true; setBtn("cv-save", true, "Guardar convocatoria");
  try {
    await guardarConvocatoria(cv.p.categoriaId, cv.p.id, add, rem, st.uid);
    st.cache.delete(key(cv.p));
    closePanel("cv-drawer", true);
    toast("success", "Convocatoria guardada correctamente.");
    renderAll();
  } catch (err) {
    console.error("[CanchaControl] Convocatoria:", err?.code || err);
    const a = $("cv-alert"); a.textContent = friendlyPartidoError(err); a.hidden = false;
    try { const c = await datos(key(cv.p), { force: true }); cv.part = c.part; cv.rend = c.rend; updCv(); } catch { /* sin recarga */ }
  } finally { st.saving = false; setBtn("cv-save", false, "Guardar convocatoria"); }
}

/* ==========================================================
   RENDIMIENTO
   ========================================================== */
let rendSeq = 0;
function rScope() {
  const cat = $("r-cat").value, desde = $("r-desde").value, hasta = $("r-hasta").value;
  return st.partidos.filter((p) => p.estado === "Disputado" && (!cat || p.categoriaId === cat) && (!desde || p.fecha >= desde) && (!hasta || p.fecha <= hasta));
}
async function renderRend() {
  const seq = ++rendSeq;
  const err = $("r-err"); err.textContent = "";
  const desde = $("r-desde").value, hasta = $("r-hasta").value;
  if (desde && hasta && desde > hasta) { err.textContent = "La fecha inicial no puede ser posterior a la final."; return; }
  if (!st.loaded) { $("r-stats").innerHTML = '<div class="skel" style="height:96px"></div>'; return; }
  const scope = rScope();
  // selector de partido (solo disputados del alcance)
  const sel = $("r-partido"); const prev = st.rSel || sel.value;
  sel.replaceChildren(new Option("Todos los disputados", ""), ...scope.map((p) => new Option(`${p.fecha} · vs ${p.rival} · ${catName(p.categoriaId)}`, key(p))));
  const pSel = partidoByKey(prev);
  if (pSel && pSel.estado !== "Disputado") { sel.append(new Option(`${pSel.fecha} · vs ${pSel.rival} (${pSel.estado})`, key(pSel))); }
  sel.value = pSel ? key(pSel) : ""; st.rSel = sel.value;
  const partidos = st.rSel ? [partidoByKey(st.rSel)] : scope;
  $("r-stats").innerHTML = '<div class="skel" style="height:96px"></div>';
  try {
    const cs = await Promise.all(partidos.map((p) => datos(key(p))));
    if (seq !== rendSeq) return;
    // jugadores del alcance (con rendimiento)
    const jugadores = new Map();
    cs.forEach((c) => c.rend.forEach((r, jid) => { const pa = c.part.get(jid); if (!jugadores.has(jid)) jugadores.set(jid, pa ? `${pa.nombres} ${pa.apellidos}` : jid); }));
    const js = $("r-jugador"), jcur = js.value;
    js.replaceChildren(new Option("Todos", ""), ...[...jugadores].sort((a, b) => a[1].localeCompare(b[1], "es")).map(([id, n]) => new Option(n, id)));
    js.value = jugadores.has(jcur) ? jcur : "";
    renderStats(partidos, cs, js.value);
    await renderRendMatch(seq);
  } catch (e) {
    if (seq !== rendSeq) return;
    console.error("[CanchaControl] Rendimiento:", e?.code || e);
    $("r-stats").replaceChildren(el("p", "mp-stats__err", e?.code === "permission-denied" ? MSG.sinPermiso : MSG.errorCargar));
  }
}
function renderStats(partidos, cs, jid) {
  let jugados = 0; const jugadoresCon = new Set();
  const tot = { goles: 0, asistencias: 0, minutosJugados: 0, tarjetasAmarillas: 0, tarjetasRojas: 0 }; const notas = [];
  partidos.forEach((p, i) => {
    const c = cs[i]; let cuenta = !jid && p.estado === "Disputado";
    c.rend.forEach((r, id) => {
      if (jid && id !== jid) return;
      jugadoresCon.add(id);
      for (const k of Object.keys(tot)) tot[k] += r[k];
      if (typeof r.valoracionFinal === "number") notas.push(r.valoracionFinal);
      if (jid && r.minutosJugados > 0) cuenta = true;
    });
    if (cuenta) jugados++;
  });
  const prom = notas.length ? Math.round((notas.reduce((a, b) => a + b, 0) / notas.length) * 10) / 10 : null;
  const card = (label, value, cls = "", sub = "") => { const a = el("article", `mp-stat ${cls}`); a.append(el("span", "mp-stat__v", value), el("span", "mp-stat__l", label)); if (sub) a.append(el("span", "mp-stat__s", sub)); return a; };
  const promCard = card("Promedio de valoración", prom === null ? "–" : prom.toFixed(1), `mp-stat--rating ${ratingClass(prom)}`, prom === null ? "Sin calificaciones" : `${notas.length} calificacion${notas.length === 1 ? "" : "es"}`);
  $("r-stats").replaceChildren(
    card(jid ? "Partidos jugados" : "Partidos disputados", String(jugados)),
    card("Jugadores con rendimiento", String(jugadoresCon.size)),
    card("Goles", String(tot.goles), "mp-stat--goal"), card("Asistencias", String(tot.asistencias), "mp-stat--assist"),
    card("Minutos jugados", String(tot.minutosJugados)), card("Amarillas", String(tot.tarjetasAmarillas), "mp-stat--y"),
    card("Rojas", String(tot.tarjetasRojas), "mp-stat--r"), promCard);
}
async function renderRendMatch(seq) {
  const body = $("r-body"); const p = partidoByKey(st.rSel);
  const g = $("r-group");
  if (!p) {
    $("r-sec-sub").textContent = "";
    g.hidden = true;
    body.replaceChildren(emptyInline("Elige un partido disputado en el filtro «Partido» para registrar o corregir el rendimiento de sus convocados."));
    return;
  }
  g.hidden = false;
  const w = ventanaRendimiento(p.fecha);
  const editable = isCoachOf(p.categoriaId) && p.estado === "Disputado" && w.abierta;
  $("r-sec-sub").textContent = `vs ${p.rival} · ${catName(p.categoriaId)} · ${fechaLarga(p.fecha)}${editable ? ` · Editable hasta el ${fechaCorta(w.hasta)}` : ""}`;
  if (p.estado !== "Disputado") { body.replaceChildren(emptyInline(MSG.soloDisputado)); return; }
  const c = await datos(key(p)); if (seq !== rendSeq) return;
  if (!c.part.size) {
    const box = emptyInline(MSG.sinParticipantes);
    if (isCoachOf(p.categoriaId)) { const b = el("button", "btn btn-primary empty__btn", "Gestionar convocados"); b.type = "button"; b.addEventListener("click", () => openConvocatoria(p)); box.append(b); }
    body.replaceChildren(box); return;
  }
  const out = [];
  if (!c.rend.size) out.push(el("p", "mp-note", MSG.sinRendimiento));
  if (st.role === "coach" && !w.abierta) out.push(el("p", "mp-note is-warn", MSG.ventana));
  const players = [...c.part.values()].map(persona).sort((a, b) => (a.numeroCamiseta ?? 999) - (b.numeroCamiseta ?? 999));
  const mk = (pl) => {
    const r = c.rend.get(pl.id); const pa = c.part.get(pl.id);
    const it = el("button", "mp-rcard"); it.type = "button"; it.dataset.id = pl.id;
    const card = createPlayer3DCard({ ...pl, categoria: pa.rol === "Titular" ? "Titular" : r?.minutosJugados > 0 ? "Ingresó desde el banco" : "Suplente" }, null, { presentational: true });
    setCardBadge(card, toneRating(r?.valoracionFinal), typeof r?.valoracionFinal === "number" ? r.valoracionFinal.toFixed(1) : MSG.sinValoracion);
    if (!st.fotos.has(pl.id)) foto(pl.id).then((f) => { if (f) setCardPhoto(card, { ...pl, foto: f }); });
    it.append(card, statLine(r));
    it.setAttribute("aria-label", `${pl.nombres} ${pl.apellidos}: ${r ? "ver o corregir rendimiento" : "registrar rendimiento"}`);
    it.addEventListener("click", () => openRendForm(p, pl, editable));
    return it;
  };
  if (g.value === "pos") {
    for (const [k, label, abbr] of POS_GROUPS) {
      const ps = players.filter((x) => posGroup(x) === k); if (!ps.length) continue;
      const h = el("h3", "mp-grp"); h.append(el("span", "mp-grp__abbr", abbr), el("span", "", label), el("span", "mp-grp__n", String(ps.length)));
      const grid = el("div", "mp-rgrid"); ps.forEach((x) => grid.append(mk(x))); out.push(h, grid);
    }
  } else { const grid = el("div", "mp-rgrid"); players.forEach((x) => grid.append(mk(x))); out.push(grid); }
  body.replaceChildren(...out);
}
function statLine(r) {
  const s = el("div", "mp-sline");
  if (!r) { s.append(el("span", "mp-sline__none", "Sin estadísticas")); return s; }
  const add = (html, n, title) => { const x = el("span", "mp-sline__i"); x.innerHTML = html; x.append(el("b", "", String(n))); x.title = title; s.append(x); };
  add(ICON.ball, r.goles, "Goles"); add(ICON.boot, r.asistencias, "Asistencias");
  const m = el("span", "mp-sline__i mp-sline__min", `${r.minutosJugados}'`); m.title = "Minutos jugados"; s.append(m);
  if (r.tarjetasAmarillas) { const y = el("span", "pt-card pt-card--y"); if (r.tarjetasAmarillas > 1) y.textContent = String(r.tarjetasAmarillas); y.title = "Amarillas"; s.append(y); }
  if (r.tarjetasRojas) { const x = el("span", "pt-card pt-card--r"); x.title = "Roja"; s.append(x); }
  return s;
}

/* ---------- Formulario de rendimiento ---------- */
let rf = null;
const RF_NUM = [["goles", "Goles", LIM.GOLES], ["asistencias", "Asistencias", LIM.ASIST], ["minutosJugados", "Minutos jugados", LIM.MIN],
  ["tarjetasAmarillas", "Tarjetas amarillas", LIM.AMA], ["tarjetasRojas", "Tarjetas rojas", LIM.ROJ]];
async function openRendForm(p, pl, editable) {
  const c = await datos(key(p));
  const r = c.rend.get(pl.id) ?? null;
  rf = { p, pl, editable, previo: r ? { version: r.version } : null };
  $("rf-title").textContent = `${pl.nombres} ${pl.apellidos}`;
  $("rf-sub").textContent = `vs ${p.rival} · ${fechaLarga(p.fecha)}`;
  const card = createPlayer3DCard({ ...pl, categoria: catName(p.categoriaId) }, null, { presentational: true });
  setCardBadge(card, toneRating(r?.valoracionFinal), typeof r?.valoracionFinal === "number" ? r.valoracionFinal.toFixed(1) : MSG.sinValoracion);
  const f = st.fotos.get(pl.id); if (f) setCardPhoto(card, { ...pl, foto: f });
  rf.card = card;
  $("rf-card").replaceChildren(card);
  const box = $("rf-fields"); box.replaceChildren();
  if (!editable) {
    const note = el("p", "mp-note is-warn", st.role === "admin" ? "Solo consulta." : p.estado !== "Disputado" ? MSG.soloDisputado : MSG.ventana);
    box.append(note);
  }
  for (const [k, label, max] of RF_NUM) {
    const fld = el("div", "mp-step"); fld.dataset.k = k;
    const lab = el("label", "mp-step__l", label); lab.htmlFor = `rf-${k}`;
    const minus = el("button", "mp-step__b", "−"); minus.type = "button"; minus.setAttribute("aria-label", `Restar ${label.toLowerCase()}`);
    const inp = el("input", "field-input mp-step__in"); inp.id = `rf-${k}`; inp.type = "number"; inp.min = "0"; inp.max = String(max); inp.step = "1"; inp.inputMode = "numeric";
    inp.value = String(r ? r[k] : 0);
    const plus = el("button", "mp-step__b", "+"); plus.type = "button"; plus.setAttribute("aria-label", `Sumar ${label.toLowerCase()}`);
    const stepv = k === "minutosJugados" ? 5 : 1;
    minus.addEventListener("click", () => { inp.value = String(Math.max(0, (parseInt(inp.value, 10) || 0) - stepv)); clrRfErr(k); });
    plus.addEventListener("click", () => { inp.value = String(Math.min(max, (parseInt(inp.value, 10) || 0) + stepv)); clrRfErr(k); });
    inp.addEventListener("input", () => clrRfErr(k));
    [minus, inp, plus].forEach((x) => { x.disabled = !editable; });
    const ctl = el("div", "mp-step__ctl"); ctl.append(minus, inp, plus);
    fld.append(lab, ctl, el("p", "f-error mp-step__err"));
    box.append(fld);
  }
  const vf = el("div", "mp-step mp-step--rating"); vf.dataset.k = "valoracionFinal";
  const vl = el("label", "mp-step__l", "Valoración final (1 a 10)"); vl.htmlFor = "rf-val";
  const vi = el("input", "field-input mp-rating-in"); vi.id = "rf-val"; vi.inputMode = "decimal"; vi.placeholder = "Sin calificar"; vi.autocomplete = "off"; vi.maxLength = 4;
  vi.value = typeof r?.valoracionFinal === "number" ? r.valoracionFinal.toFixed(1) : ""; vi.disabled = !editable;
  const prev = el("span", "mp-rating-prev");
  const paintPrev = () => {
    const v = parseValoracion(vi.value);
    prev.className = `mp-rating-prev ${typeof v === "number" && !Number.isNaN(v) && v >= 1 && v <= 10 ? ratingClass(v) : "is-none"}`;
    prev.textContent = v === null ? "Sin calificar" : Number.isNaN(v) || v < 1 || v > 10 ? "Inválida" : v.toFixed(1);
  };
  vi.addEventListener("input", () => { clrRfErr("valoracionFinal"); paintPrev(); }); paintPrev();
  const vctl = el("div", "mp-step__ctl"); vctl.append(vi, prev);
  vf.append(vl, vctl, el("p", "mp-help", "La asigna el entrenador (no se calcula). Déjala vacía si aún no lo evalúas. Ej.: 6.8 · 7.5 · 8.7"), el("p", "f-error mp-step__err"));
  box.append(vf, Object.assign(el("div", "f-alert"), { id: "rf-alert", hidden: true }));
  $("rf-save").hidden = !editable;
  openPanel("rf-drawer", editable ? "#rf-goles" : "[data-close].icon-btn");
}
function rfErr(k, m) { const f = document.querySelector(`.mp-step[data-k="${k}"]`); f.classList.add("has-error"); f.querySelector(".mp-step__err").textContent = m; }
function clrRfErr(k) { const f = document.querySelector(`.mp-step[data-k="${k}"]`); if (!f) return; f.classList.remove("has-error"); f.querySelector(".mp-step__err").textContent = ""; }
async function onSaveRend(e) {
  e.preventDefault();
  if (!rf || !rf.editable || st.saving) return;
  const num = (k) => { const s = $(`rf-${k}`).value.trim(); return /^\d+$/.test(s) ? parseInt(s, 10) : NaN; };
  const datosR = { goles: num("goles"), asistencias: num("asistencias"), minutosJugados: num("minutosJugados"),
    tarjetasAmarillas: num("tarjetasAmarillas"), tarjetasRojas: num("tarjetasRojas"), valoracionFinal: parseValoracion($("rf-val").value) };
  const errs = validarRendimiento(datosR);
  if (Number.isNaN(datosR.valoracionFinal)) errs.valoracionFinal = "Escribe un número entre 1 y 10 con máximo un decimal (ej. 7.5).";
  for (const [k, m] of Object.entries(errs)) rfErr(k, m);
  if (Object.keys(errs).length) { document.querySelector(".mp-step.has-error input")?.focus(); return; }
  const a = $("rf-alert"); a.hidden = true;
  st.saving = true; setBtn("rf-save", true, "Guardar rendimiento");
  try {
    await guardarRendimiento({ cat: rf.p.categoriaId, pid: rf.p.id, jid: rf.pl.id, datos: datosR, previo: rf.previo, uid: st.uid,
      partidoSnap: { fecha: rf.p.fecha, rival: rf.p.rival, tipo: rf.p.tipo, categoriaNombre: catName(rf.p.categoriaId) } });
    await datos(key(rf.p), { force: true });          // confirmación del servidor
    closePanel("rf-drawer", true);
    toast("success", "Rendimiento guardado correctamente.");
    if (st.tab === "rend") renderRend();
    if (st.tab === "alin" && st.pitch && st.aSel === key(rf.p)) { const c = st.cache.get(st.aSel); st.pitch.setStats(c.rend); renderAlinMeta(); }
  } catch (err) {
    console.error("[CanchaControl] Rendimiento:", err?.code || err);
    a.textContent = err?.code === "permission-denied" ? `${MSG.errorGuardar} (${MSG.sinPermiso})` : friendlyPartidoError(err); a.hidden = false;
    if (err?.code === "conflict") { const c = await datos(key(rf.p), { force: true }).catch(() => null); const r = c?.rend.get(rf.pl.id); rf.previo = r ? { version: r.version } : null; }
  } finally { st.saving = false; setBtn("rf-save", false, "Guardar rendimiento"); }
}

/* ==========================================================
   ALINEACIÓN TÁCTICA
   ========================================================== */
let alinSeq = 0;
async function renderAlin() {
  const seq = ++alinSeq;
  const sel = $("a-partido");
  const list = st.partidos;
  if (!st.loaded) { $("a-body").innerHTML = '<div class="skel" style="height:420px"></div>'; return; }
  sel.replaceChildren(new Option(list.length ? "Selecciona un partido…" : "No hay partidos", ""), ...list.map((p) => new Option(`${p.fecha} · vs ${p.rival} · ${catName(p.categoriaId)} · ${p.estado}`, key(p))));
  if (!st.aSel && list.length) { const prox = [...list].reverse().find((p) => p.estado === "Programado" && p.fecha >= isoHoy()) ?? list[0]; st.aSel = key(prox); }
  sel.value = partidoByKey(st.aSel) ? st.aSel : "";
  const p = partidoByKey(sel.value);
  const body = $("a-body");
  $("a-save").hidden = true; $("a-discard").hidden = true; $("a-help").hidden = true; $("a-meta").replaceChildren();
  if (!p) { st.pitch = null; body.replaceChildren(emptyInline(list.length ? "Elige un partido para ver o preparar su alineación." : MSG.sinPartidos)); return; }
  if (st.pitch && st.pitch.key === key(p) && st.alinDirty) { renderAlinMeta(); return; }   // no perder cambios sin guardar
  body.innerHTML = '<div class="skel" style="height:420px"></div>';
  try {
    const c = await datos(key(p));
    if (seq !== alinSeq) return;
    const editable = isCoachOf(p.categoriaId) && p.estado !== "Cancelado";
    if (!c.part.size) {
      st.pitch = null;
      const box = emptyInline(MSG.sinParticipantes);
      if (isCoachOf(p.categoriaId)) { const b = el("button", "btn btn-primary empty__btn", "Gestionar convocados"); b.type = "button"; b.addEventListener("click", () => openConvocatoria(p)); box.append(b); }
      body.replaceChildren(box); return;
    }
    const players = new Map([...c.part.values()].map((pa) => [pa.id, persona(pa)]));
    st.alinSaved = new Map(c.alin?.ubicaciones ?? []);
    for (const k of [...st.alinSaved.keys()]) if (!players.has(k)) st.alinSaved.delete(k);
    st.alinWork = new Map(st.alinSaved); st.alinDirty = false;
    const holder = el("div", "mp-alin");
    body.replaceChildren(holder);
    if (!c.alin) holder.before(el("p", "mp-note", MSG.sinAlineacion));
    st.pitch = createPitch(holder, {
      editable, max: FORMATOS[p.formatoPartido].titulares, players, stats: c.rend, ubicaciones: st.alinWork,
      onChange: (m) => { st.alinWork = m; st.alinDirty = !sameUbic(m, st.alinSaved); renderAlinMeta(); },
      onSelect: (jid) => openJugadorAlin(p, jid),
      onLimit: (max) => toast("info", `Máximo ${max} titulares en ${FORMATOS[p.formatoPartido].label}. Envía uno al banco o suelta al nuevo sobre un titular para intercambiarlos.`),
    });
    st.pitch.key = key(p); st.pitch.editable = editable;
    $("a-help").hidden = !editable;
    renderAlinMeta();
    // fotos diferidas
    Promise.all([...players.keys()].map((id) => foto(id))).then(() => {
      if (seq !== alinSeq || !st.pitch) return;
      st.pitch.setPlayers(new Map([...c.part.values()].map((pa) => [pa.id, persona(pa)])));
    });
  } catch (e) {
    if (seq !== alinSeq) return;
    console.error("[CanchaControl] Alineación:", e?.code || e);
    body.replaceChildren(emptyInline(e?.code === "permission-denied" ? MSG.sinPermiso : MSG.errorCargar));
  }
}
const sameUbic = (a, b) => a.size === b.size && [...a].every(([k, u]) => { const v = b.get(k); return v && Math.abs(v.x - u.x) < 1e-4 && Math.abs(v.y - u.y) < 1e-4 && v.posicionTactica === u.posicionTactica; });
function renderAlinMeta() {
  const p = partidoByKey(st.aSel); if (!p || !st.pitch) return;
  const c = st.cache.get(key(p));
  const max = FORMATOS[p.formatoPartido].titulares, n = st.alinWork.size, f = formacion(st.alinWork);
  const meta = $("a-meta"); meta.replaceChildren();
  const chip = (t, cls = "") => meta.append(el("span", `mp-chip ${cls}`, t));
  chip(FORMATOS[p.formatoPartido].label);
  chip(f ? `Formación ${f}` : "Sin formación", "is-strong");
  chip(`${n}/${max} titulares`);
  if (n < max) chip(`Faltan ${max - n}`, "is-warn");
  const gk = [...st.alinWork.values()].some((u) => u.posicionTactica === "Portero");
  if (n && !gk) chip("Sin portero asignado", "is-warn");
  chip(c?.alin ? (c.alin.estado === "Completa" ? "Guardada · Completa" : "Guardada · Borrador") : "Sin guardar");
  if (st.alinDirty) chip("Cambios sin guardar", "is-dirty");
  $("a-save").hidden = !st.pitch.editable; $("a-discard").hidden = !st.pitch.editable || !st.alinDirty;
  $("a-save").disabled = !st.alinDirty;
}
async function saveAlin() {
  const p = partidoByKey(st.aSel); if (!p || !st.pitch?.editable || st.saving || !st.alinDirty) return;
  const c = st.cache.get(key(p));
  st.saving = true; setBtn("a-save", true, "Guardar alineación");
  try {
    const estado = await guardarAlineacion({ cat: p.categoriaId, pid: p.id, ubicaciones: st.alinWork, formato: p.formatoPartido,
      previo: c.alin ? { version: c.alin.version } : null, uid: st.uid, participantes: c.part });
    const nc = await datos(key(p), { force: true });                   // confirmación del servidor
    st.alinSaved = new Map(nc.alin?.ubicaciones ?? []); st.alinDirty = false;
    toast("success", estado === "Completa" ? "Alineación guardada correctamente." : "Alineación guardada como borrador.");
  } catch (err) {
    console.error("[CanchaControl] Alineación:", err?.code || err);
    toast("error", friendlyPartidoError(err));
    if (err?.code === "conflict") { await datos(key(p), { force: true }).catch(() => null); }
  } finally { st.saving = false; setBtn("a-save", false, "Guardar alineación"); renderAlinMeta(); }
}
function discardAlin() { if (!st.pitch) return; st.alinWork = new Map(st.alinSaved); st.alinDirty = false; st.pitch.setUbicaciones(st.alinWork); renderAlinMeta(); }

function openJugadorAlin(p, jid) {
  const c = st.cache.get(key(p)); const pa = c.part.get(jid); if (!pa) return;
  const pl = persona(pa); const r = c.rend.get(jid); const u = st.alinWork.get(jid);
  const editable = st.pitch?.editable;
  $("aj-title").textContent = `${pl.nombres} ${pl.apellidos}`;
  $("aj-sub").textContent = u ? `Titular · ${u.posicionTactica}` : "Banco de suplentes";
  const card = createPlayer3DCard({ ...pl, categoria: catName(p.categoriaId) }, null, { presentational: true });
  setCardBadge(card, toneRating(r?.valoracionFinal), typeof r?.valoracionFinal === "number" ? r.valoracionFinal.toFixed(1) : MSG.sinValoracion);
  const cardBox = el("div", "mp-aj-card"); cardBox.append(card);
  const rows = [["Dorsal", pl.numeroCamiseta ?? "—"], ["Posición habitual", pl.posicion || "Sin posición"], ["Posición táctica", u ? u.posicionTactica : "En el banco"],
    ["Valoración final", typeof r?.valoracionFinal === "number" ? r.valoracionFinal.toFixed(1) : MSG.sinValoracion],
    ["Goles", r ? r.goles : "—"], ["Asistencias", r ? r.asistencias : "—"], ["Minutos", r ? r.minutosJugados : "—"],
    ["Amarillas", r ? r.tarjetasAmarillas : "—"], ["Rojas", r ? r.tarjetasRojas : "—"]];
  const dl = el("dl", "detail-list"); rows.forEach(([k, v]) => { const w = el("div"); w.append(el("dt", "", k), el("dd", "", String(v))); dl.append(w); });
  const parts = [cardBox];
  if (editable && u) {
    const f = el("div", "f-field mp-aj-pos"); const l = el("label", "f-label", "Cambiar posición táctica"); l.htmlFor = "aj-pos";
    const s = el("select", "field-input field-select"); s.id = "aj-pos"; POS_TACTICAS.forEach((x) => s.append(new Option(x, x))); s.value = u.posicionTactica;
    s.addEventListener("change", () => { st.pitch.setPosicion(jid, s.value); $("aj-sub").textContent = `Titular · ${s.value}`; });
    f.append(l, s, el("p", "mp-help", "Solo para este partido: no cambia la posición del expediente."));
    parts.push(f);
  }
  parts.push(dl);
  $("aj-body").replaceChildren(...parts);
  const foot = $("aj-foot"); foot.replaceChildren();
  const btn = (label, cls, fn) => { const b = el("button", cls, label); b.type = "button"; b.addEventListener("click", fn); foot.append(b); return b; };
  if (editable && u) btn("Enviar al banco", "btn btn-soft", () => { st.pitch.toBench(jid); closePanel("aj-drawer"); });
  if (editable && !u) btn("Ubicar en la cancha", "btn btn-soft", () => { closePanel("aj-drawer"); st.pitch.startPlacing(jid, pl.nombres); });
  if (isCoachOf(p.categoriaId) && p.estado === "Disputado") btn("Editar rendimiento", "btn btn-primary", () => { closePanel("aj-drawer"); openRendForm(p, pl, ventanaRendimiento(p.fecha).abierta); });
  btn("Cerrar", "btn btn-ghost", () => closePanel("aj-drawer"));
  openPanel("aj-drawer", "[data-close].icon-btn");
}

/* ==========================================================
   Utilidades UI
   ========================================================== */
function emptyBox(box, title, text, action) {
  box.replaceChildren(el("p", "empty__title", title));
  if (text) box.append(el("p", "empty__text", text));
  if (action) { const b = el("button", "btn btn-primary empty__btn", action[0]); b.type = "button"; b.addEventListener("click", action[1]); box.append(b); }
  box.hidden = false;
}
function emptyInline(text) { const d = el("div", "empty mp-empty"); d.append(el("p", "empty__text", text)); return d; }
function fatal(msg) { const s = $("mp-state"); s.hidden = false; s.replaceChildren(emptyInline(msg)); ["pan-partidos", "pan-rend", "pan-alin"].forEach((id) => { $(id).hidden = true; }); document.querySelector(".mp-tabs").hidden = true; $("new-btn").hidden = true; }
function setBtn(id, on, label) { const b = $(id); b.disabled = on; b.innerHTML = on ? '<span class="spinner" aria-hidden="true"></span><span class="btn-label">Guardando…</span>' : `<span class="btn-label">${label}</span>`; }

let returnFocus = null;
function openPanel(id, focusSel) {
  returnFocus = document.activeElement;
  const d = $(id); d.classList.add("is-open"); d.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open"); $("app").inert = true;
  setTimeout(() => d.querySelector(focusSel)?.focus(), 60);
}
function closePanel(id, force = false) {
  const d = $(id); if (!d.classList.contains("is-open")) return;
  if (st.saving && !force) return;
  d.classList.remove("is-open"); d.setAttribute("aria-hidden", "true");
  if (!document.querySelector(".drawer.is-open")) { document.body.classList.remove("modal-open"); $("app").inert = false; }
  returnFocus?.focus?.();
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function wire() {
  initFilterCards($("p-kpis"), (v) => { st.filtro = v; renderPartidos(); });
  $("p-search").addEventListener("input", debounce(() => { st.q = norm($("p-search").value); renderPartidos(); }, 250));
  $("p-cat").addEventListener("change", (e) => { st.catFil = e.target.value; renderPartidos(); });
  $("new-btn").addEventListener("click", () => openForm());
  $("pf-form").addEventListener("submit", onSaveForm);
  $("cv-save").addEventListener("click", saveConvocatoria);
  $("cv-all").addEventListener("click", () => { if (!cv) return; cvPlayers().forEach((p) => cv.sel.add(p.id)); cvPlayers().forEach((p) => paintCv(p.id)); updCv(); });
  $("cv-group").addEventListener("change", () => { if (cv?.part) renderConvocatoria(); });
  $("rf-form").addEventListener("submit", onSaveRend);
  for (const id of ["r-cat", "r-desde", "r-hasta"]) $(id).addEventListener("change", () => { st.rSel = ""; renderRend(); });
  $("r-partido").addEventListener("change", (e) => { st.rSel = e.target.value; renderRend(); });
  $("r-jugador").addEventListener("change", () => renderRend());
  $("r-group").addEventListener("change", () => renderRend());
  $("a-partido").addEventListener("change", (e) => {
    if (st.alinDirty) { e.target.value = st.aSel; toast("info", "Guarda o descarta los cambios de la alineación antes de cambiar de partido."); return; }
    st.aSel = e.target.value; st.pitch = null; renderAlin();
  });
  $("a-save").addEventListener("click", saveAlin);
  $("a-discard").addEventListener("click", discardAlin);
  const tabs = [...document.querySelectorAll("[role=tab]")];
  tabs.forEach((b, i) => {
    b.addEventListener("click", () => selectTab(b.dataset.tab));
    b.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0; if (!d) return;
      e.preventDefault(); const n = tabs[(i + d + tabs.length) % tabs.length]; n.focus(); selectTab(n.dataset.tab);
    });
  });
  for (const id of ["pf-drawer", "pd-drawer", "cv-drawer", "rf-drawer", "aj-drawer"]) $(id).querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => closePanel(id)));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = [...document.querySelectorAll(".drawer.is-open")].pop();
    if (open) { e.preventDefault(); closePanel(open.id); }
    else if (st.pitch) st.pitch.cancelPlacing();
  });
  window.addEventListener("beforeunload", (e) => { if (st.alinDirty) { e.preventDefault(); e.returnValue = ""; } });
}
