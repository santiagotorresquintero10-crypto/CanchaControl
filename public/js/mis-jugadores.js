/* ==========================================================
   CanchaControl — "Mis jugadores" (HU-009) · Entrenador · SOLO CONSULTA
   Rutas:  #                         → listado (selector de categoría + nómina)
           #/ficha/{categoria}/{id}  → ficha del jugador (solo consulta)
   Mis categorías → where("entrenadorId","==", auth.currentUser.uid)
   Nómina         → categorias/{categoriaId}/nomina   (ficha deportiva)
   Foto           → jugadorFotos/{id}, solo por ID (las reglas verifican que el
                    jugador esté HOY en una categoría de este entrenador).
   El Entrenador NUNCA lee jugadores/{id}: las reglas lo niegan.
   Un id de categoría o de jugador que venga en la URL NO autoriza nada: solo
   se acepta si está entre MIS categorías y en la nómina que Firestore entregó.
   ========================================================== */
import { auth } from "./auth.js";
import { initials } from "./shell.js";
import { toast } from "./ui.js";
import { subscribeMisCategorias, periodoLabel, rangoLabel, currentPeriodo } from "./categorias-data.js";
import { subscribeFichas, nombreCompleto, edad, parseFecha, getFoto, TIPO_DOC_LABEL } from "./jugadores-data.js";

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 10;
const norm = (s) => String(s ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

const st = {
  uid: null, cats: new Map(), catsLoaded: false, season: null, sel: "",
  fichas: [], fichasLoaded: false, error: null, stop: null, q: "", page: 1,
  route: { name: "list" }, tab: "general",
};

/** Lista blanca de lo que el Entrenador ve en la ficha (acordada para HU-009). */
export const CAMPOS_FICHA = Object.freeze(["Nombres", "Apellidos", "Tipo de documento", "Número de documento", "Fecha de nacimiento", "Edad", "Género",
  "Categoría", "Posición", "Número de camiseta", "Estado", "Foto"]);

const ICONS = {
  search: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  team: '<svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="6.5" r="2.6"/><circle cx="5.5" cy="8" r="2.1"/><circle cx="18.5" cy="8" r="2.1"/><path d="M7.5 18v-1.5a4.5 4.5 0 0 1 9 0V18Z"/><path d="M1.5 18v-1a3.8 3.8 0 0 1 5.3-3.5A6 6 0 0 0 6 16.5V18Z"/><path d="M22.5 18v-1a3.8 3.8 0 0 0-5.3-3.5 6 6 0 0 1 .8 3V18Z"/></svg>',
  layers: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 9 4.5-9 4.5-9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/></svg>',
  error: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="6" x2="12" y2="13.5"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>',
  lock: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  chart: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/></svg>',
  eye: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
};

export function start(profile) {
  const uid = auth.currentUser?.uid;
  $("view-coach").hidden = false;
  if (!uid || uid !== profile.uid) { stateBox("error", "No se pudo cargar la información", "Ocurrió un problema al consultar los jugadores. Por favor, intenta nuevamente.", "Intentar de nuevo", () => location.reload()); return; }
  st.uid = uid;
  wire();
  subscribeMisCategorias(uid,
    (list) => { st.cats = new Map(list.map((c) => [c.id, c])); st.catsLoaded = true; onCats(); onRoute(); },
    (err) => {
      console.error("[CanchaControl] Mis categorías:", err?.code || err); st.catsLoaded = true; stopNomina();
      lockBar();
      if (err?.code === "permission-denied") stateBox("lock", "No tienes permiso para consultar esta información.", "Si crees que es un error, comunícate con el Administrador.");
      else stateBox("error", "No se pudo cargar la información", "Ocurrió un problema al consultar los jugadores. Por favor, intenta nuevamente.", "Intentar de nuevo", () => location.reload());
    }
  );
  window.addEventListener("hashchange", onRoute);
}

/* ==========================================================
   Rutas
   ========================================================== */
function parseHash() {
  const m = /^#\/ficha\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,64})$/.exec(location.hash);
  return m ? { name: "ficha", cat: m[1], id: m[2] } : { name: "list" };
}
function onRoute() {
  if (!st.catsLoaded) return;
  st.route = parseHash();
  if (st.route.name === "ficha") {
    // La categoría de la URL solo vale si es MÍA; si no, se ignora.
    if (!st.cats.has(st.route.cat)) { denyFicha(); return; }
    if (st.sel !== st.route.cat) { $("coach-cat").value = st.route.cat; selectCat(st.route.cat); }
    $("view-coach").hidden = true; $("view-ficha").hidden = false;
    st.tab = "general";
    renderFicha();
  } else {
    $("view-ficha").hidden = true; $("view-coach").hidden = false;
    document.title = "Mis jugadores · CanchaControl";
  }
  window.scrollTo({ top: 0 });
}
function denyFicha() {
  toast("error", "No tienes permiso para consultar este jugador.");
  history.replaceState(null, "", location.pathname);
  st.route = { name: "list" };
  $("view-ficha").hidden = true; $("view-coach").hidden = false;
}

/* ==========================================================
   Temporada y categorías (solo las mías)
   ========================================================== */
function lockBar() { $("coach-cat").disabled = true; $("coach-toolbar").hidden = true; $("coach-kpis").hidden = true; $("season-wrap").hidden = true; }

function onCats() {
  const cats = [...st.cats.values()];
  if (!cats.length) {
    stopNomina(); st.sel = "";
    $("coach-cat").replaceChildren(new Option("Sin categorías asignadas", "")); lockBar();
    $("coach-cat-dot").classList.add("is-off");
    stateBox("layers", "Aún no tienes categorías asignadas.", "Cuando un administrador te asigne una categoría, aparecerá aquí.");
    return;
  }
  // Temporada: períodos REALES de mis categorías
  const seasons = [...new Set(cats.map((c) => c.periodoLectivo).filter(Boolean))].sort().reverse();
  const sea = $("coach-season");
  if (st.season === null) st.season = seasons.includes(currentPeriodo()) ? currentPeriodo() : "";
  if (st.season && !seasons.includes(st.season)) st.season = "";
  sea.replaceChildren(new Option("Todas las temporadas", ""), ...seasons.map((p) => new Option(p === currentPeriodo() ? `Temporada actual (${periodoLabel(p)})` : `Temporada ${periodoLabel(p)}`, p)));
  sea.value = st.season;
  $("season-wrap").hidden = seasons.length < 1;
  fillCatSelect();
}

function fillCatSelect() {
  const sel = $("coach-cat");
  const lost = st.sel && !st.cats.has(st.sel);
  const visible = [...st.cats.values()].filter((c) => !st.season || c.periodoLectivo === st.season)
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" }));
  if (lost) toast("info", "Una de tus categorías fue reasignada. Ya no puedes consultar sus jugadores.");
  if (!visible.length) {
    stopNomina(); st.sel = "";
    sel.replaceChildren(new Option("Sin categorías en esta temporada", "")); sel.disabled = true;
    $("coach-toolbar").hidden = true; $("coach-kpis").hidden = true;
    stateBox("layers", "No tienes categorías en esta temporada.", "Elige otra temporada para ver tus categorías.");
    return;
  }
  sel.disabled = false; $("coach-kpis").hidden = false;
  sel.replaceChildren(...visible.map((c) => new Option(`${c.nombre} (${rangoLabel(c)})${c.estado !== "Activa" ? " · inactiva" : ""}`, c.id)));
  const next = visible.some((c) => c.id === st.sel) ? st.sel : visible[0].id;
  sel.value = next;
  if (next !== st.sel) selectCat(next); else paintDot();
}
function paintDot() { $("coach-cat-dot").classList.toggle("is-off", st.cats.get(st.sel)?.estado !== "Activa"); }

/** Cambia de categoría: SOLO si es una de las mías (nunca un id manipulado). */
function selectCat(id) {
  if (!st.cats.has(id)) { toast("error", "No tienes permiso para consultar esta categoría."); $("coach-cat").value = st.sel; return; }
  stopNomina();
  st.sel = id; st.fichas = []; st.fichasLoaded = false; st.error = null; st.q = ""; st.page = 1;
  $("coach-search").value = ""; $("coach-search-clear").hidden = true;
  paintDot(); render();
  st.stop = subscribeFichas(id,
    (list) => { if (st.sel !== id) return; st.fichas = list; st.fichasLoaded = true; st.error = null; render(); if (st.route.name === "ficha") renderFicha(); },
    (err) => { if (st.sel !== id) return; console.error("[CanchaControl] Nómina:", err?.code || err); st.fichasLoaded = true; st.error = err; st.fichas = []; render(); if (st.route.name === "ficha") renderFicha(); }
  );
}
function stopNomina() { st.stop?.(); st.stop = null; }

/* ==========================================================
   Nómina
   ========================================================== */
const edadLabel = (f) => { const n = edad(f); return n === null ? "—" : `${n} ${n === 1 ? "año" : "años"}`; };
function matches(f) {
  if (!st.q) return true;
  const q = norm(st.q);
  return norm(f.nombres).includes(q) || norm(f.apellidos).includes(q) || norm(nombreCompleto(f)).includes(q);
}
function pic(f, cls = "") {
  const box = el("span", `pic ${cls}`.trim(), initials(nombreCompleto(f)));
  box.setAttribute("aria-hidden", "true");
  getFoto(f.id).then((src) => { if (!src) return; const img = new Image(); img.alt = ""; img.src = src; box.append(img); });
  return box;
}

function render() {
  const body = $("coach-body");
  if (!st.sel) return;
  if (!st.fichasLoaded) {
    $("ck-total").innerHTML = '<span class="skel skel--num"></span>';
    body.innerHTML = '<tr class="skel-row"><td colspan="7"><span class="skel"></span></td></tr><tr class="skel-row"><td colspan="7"><span class="skel"></span></td></tr>';
    $("coach-table").hidden = false; $("coach-empty").hidden = true; $("coach-pagination").hidden = true; $("coach-toolbar").hidden = false; return;
  }
  const catName = st.cats.get(st.sel)?.nombre ?? "";
  if (st.error) {
    $("ck-total").textContent = "—"; body.replaceChildren(); $("coach-toolbar").hidden = true;
    if (st.error.code === "permission-denied") stateBox("lock", "No tienes permiso para consultar esta categoría.", "Si crees que es un error, comunícate con el Administrador.");
    else stateBox("error", "No se pudo cargar la información", "Ocurrió un problema al consultar los jugadores. Por favor, intenta nuevamente.", "Intentar de nuevo", () => selectCat(st.sel));
    return;
  }
  const all = st.fichas;
  $("ck-total").textContent = String(all.length);
  $("coach-toolbar").hidden = false;
  if (!all.length) { body.replaceChildren(); stateBox("team", "Esta categoría no tiene jugadores", `Actualmente no hay jugadores registrados en la categoría ${catName}.`); return; }
  const rows = all.filter(matches);
  if (!rows.length) { body.replaceChildren(); stateBox("search", "No se encontraron jugadores", `No hay coincidencias para “${st.q.trim()}” en la categoría ${catName}. Intenta con otro nombre.`); return; }
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (st.page > pages) st.page = pages;
  const start = (st.page - 1) * PAGE_SIZE;
  const vis = rows.slice(start, start + PAGE_SIZE);
  body.replaceChildren(...vis.map((f, i) => rowFor(f, start + i + 1)));
  $("coach-table").hidden = false; $("coach-empty").hidden = true;
  renderPagination(rows.length, start, vis.length, pages);
}

function rowFor(f, n) {
  const tr = document.createElement("tr");
  tr.dataset.id = f.id;
  const name = nombreCompleto(f);
  const tf = el("td", "c-foto"); tf.append(pic(f));
  const tn = el("td", "c-name"); tn.append(el("span", "cell-strong", name));
  const ok = f.estado === "Activo";
  const te = el("td", "c-estado"); te.append(el("span", `badge ${ok ? "badge--success" : "badge--danger"}`, ok ? "Activo" : "Inactivo"));
  const ta = el("td", "col-actions");
  const a = el("a", "btn-ficha act-ficha"); a.href = `#/ficha/${st.sel}/${f.id}`;
  a.setAttribute("aria-label", `Ver ficha de ${name}`); a.innerHTML = `${ICONS.eye}<span>Ver ficha</span>`;
  ta.append(a, histLink(f.id, name, "btn-ficha act-hist", "Historial"));
  tr.append(el("td", "col-n", String(n)), tf, tn, el("td", "c-edad", edadLabel(f.fechaNacimiento)),
    el("td", "c-pos", [f.posicion || "Por definir", f.numeroCamiseta !== null ? `#${f.numeroCamiseta}` : null].filter(Boolean).join(" · ")), te, ta);
  return tr;
}

/** HU-012: abre el perfil de asistencia (solo lectura) del jugador de ESTA categoría. */
function histLink(jugadorId, name, cls, label) {
  const h = el("a", cls); h.href = `historial.html?jugador=${encodeURIComponent(jugadorId)}&cat=${encodeURIComponent(st.sel)}`;
  h.setAttribute("aria-label", `Ver historial de asistencia de ${name}`); h.innerHTML = `${ICONS.chart}<span>${label}</span>`;
  return h;
}

function stateBox(icon, title, text, actionLabel, onAction) {
  const ic = $("coach-empty-icon");
  ic.innerHTML = ICONS[icon] ?? ""; ic.classList.toggle("is-error", icon === "error");
  $("coach-empty-title").textContent = title;
  $("coach-empty-text").textContent = text;
  const b = $("coach-empty-action");
  b.hidden = !actionLabel;
  if (actionLabel) { b.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><polyline points="21 3 21 9 15 9"/></svg><span>${actionLabel}</span>`; b.onclick = onAction; }
  $("coach-empty").hidden = false; $("coach-table").hidden = true; $("coach-pagination").hidden = true;
}

function renderPagination(total, start, shown, pages) {
  $("coach-pagination").hidden = false;
  $("coach-page-info").textContent = `Mostrando ${start + 1} a ${start + shown} de ${total} ${total === 1 ? "jugador" : "jugadores"}`;
  const mk = (label, page, { disabled = false, current = false, aria } = {}) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "page-btn"; b.innerHTML = label;
    if (aria) b.setAttribute("aria-label", aria);
    if (current) b.setAttribute("aria-current", "page");
    b.disabled = disabled;
    b.addEventListener("click", () => { st.page = page; render(); });
    return b;
  };
  const arrow = (d) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><polyline points="${d}"/></svg>`;
  const items = [mk(arrow("15 18 9 12 15 6"), st.page - 1, { disabled: st.page === 1, aria: "Página anterior" })];
  for (let p = 1; p <= pages; p++) items.push(mk(String(p), p, { current: p === st.page, aria: `Página ${p}` }));
  items.push(mk(arrow("9 18 15 12 9 6"), st.page + 1, { disabled: st.page === pages, aria: "Página siguiente" }));
  $("coach-page-nav").replaceChildren(...items);
}

/* ==========================================================
   Ficha (modoConsulta = true: sin ninguna acción de edición)
   ========================================================== */
function fechaCorta(f) { const d = parseFecha(f); return d ? `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}` : "—"; }

function renderFicha() {
  const card = $("ficha-card");
  if (!st.fichasLoaded) { $("ficha-crumb").textContent = "…"; card.innerHTML = '<div class="empty state"><span class="spinner" aria-hidden="true"></span><p class="empty__text">Cargando ficha…</p></div>'; return; }
  const f = st.fichas.find((x) => x.id === st.route.id);
  if (!f) {   // no está en MI nómina (otro entrenador, traslado o ID inventado)
    $("ficha-crumb").textContent = "Sin acceso";
    const e = el("div", "empty state");
    const ic = el("div", "state__icon"); ic.innerHTML = ICONS.lock;
    const back = el("a", "btn btn-outline empty__btn", "Volver al listado"); back.href = "#";
    e.append(ic, el("p", "empty__title", "No tienes permiso para consultar este jugador."), el("p", "empty__text", "Solo puedes ver las fichas de los jugadores de tus categorías."), back);
    card.replaceChildren(e);
    return;
  }
  const c = st.cats.get(st.sel);
  const name = nombreCompleto(f);
  $("ficha-crumb").textContent = name;
  document.title = `${name} · Mis jugadores · CanchaControl`;

  const head = el("header", "ficha-head");
  const main = el("div", "ficha-head__main");
  main.append(el("h1", "ficha-head__name", name), el("p", "ficha-head__sub", c ? `${c.nombre} (${rangoLabel(c)})` : "—"));
  const side = el("div", "ficha-head__side");
  const ok = f.estado === "Activo";
  side.append(el("span", `badge ${ok ? "badge--success" : "badge--danger"}`, ok ? "Activo" : "Inactivo"),
    el("span", "ficha-head__num", `Nº camiseta: ${f.numeroCamiseta ?? "—"}`));
  head.append(pic(f, "pic--xl"), main, side);

  const tabs = el("div", "exp-tabs"); tabs.setAttribute("role", "tablist");
  for (const [k, label] of [["general", "Información general"], ["deportiva", "Información deportiva"]]) {
    const b = el("button", "", label); b.type = "button"; b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(st.tab === k)); b.dataset.tab = k;
    b.addEventListener("click", () => { st.tab = k; renderFicha(); });
    tabs.append(b);
  }

  const rows = st.tab === "general" ? [
    ["Nombres", f.nombres], ["Apellidos", f.apellidos],
    ["Tipo de documento", TIPO_DOC_LABEL[f.tipoDocumento] ?? f.tipoDocumento], ["Número de documento", f.numeroDocumento],
    ["Fecha de nacimiento", fechaCorta(f.fechaNacimiento)], ["Edad", edadLabel(f.fechaNacimiento)], ["Género", f.genero],
  ] : [
    ["Categoría", c ? `${c.nombre} · ${c.codigoGrupo}` : "—"], ["Rango", c ? rangoLabel(c) : "—"],
    ["Temporada", c ? periodoLabel(c.periodoLectivo) : "—"], ["Posición", f.posicion || "Por definir"],
    ["Número de camiseta", f.numeroCamiseta === null ? "—" : String(f.numeroCamiseta)], ["Estado deportivo", f.estado || "—"],
  ];
  const dl = el("dl", "ficha-rows"); dl.id = "ficha-rows"; dl.setAttribute("role", "tabpanel");
  rows.forEach(([k, v]) => dl.append(el("dt", "", k), el("dd", "", v || "—")));

  const sideCol = el("div", "ficha-side");
  const note = el("div", "ficha-note");
  note.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
  const nt = el("div"); nt.append(el("strong", "", "Vista de consulta"), document.createTextNode("Como entrenador puedes ver la información autorizada del jugador. La edición de datos administrativos está restringida."));
  note.append(nt);
  const jersey = el("div", "jersey");
  jersey.innerHTML = '<svg width="64" height="64" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8.2 3 3.5 5.6l1.8 4.6 2.2-.9V21h9V9.3l2.2.9 1.8-4.6L15.8 3a3.8 3.8 0 0 1-7.6 0Z"/></svg>';
  jersey.append(el("span", "jersey__l", "Nº camiseta"), el("span", "jersey__n", f.numeroCamiseta === null ? "—" : String(f.numeroCamiseta)));
  sideCol.append(note, jersey);

  const bodyEl = el("div", "ficha-body"); bodyEl.append(dl, sideCol);
  const foot = el("div", "ficha-foot");
  const back = el("a", "btn btn-outline"); back.href = "#"; back.id = "ficha-back";
  back.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="11 6 5 12 11 18"/></svg><span>Volver al listado</span>';
  const hist = histLink(f.id, name, "btn btn-primary ficha-hist", "Ver historial de asistencia"); hist.id = "ficha-hist";
  foot.append(back, hist);
  card.replaceChildren(head, tabs, bodyEl, foot);
}

/* ==========================================================
   Eventos
   ========================================================== */
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function wire() {
  $("coach-cat").addEventListener("change", (e) => selectCat(e.target.value));
  $("coach-season").addEventListener("change", (e) => { st.season = e.target.value; fillCatSelect(); });
  $("coach-search").addEventListener("input", debounce(() => { st.q = $("coach-search").value; $("coach-search-clear").hidden = !st.q; st.page = 1; render(); }, 350));
  $("coach-search-clear").addEventListener("click", () => { $("coach-search").value = ""; st.q = ""; $("coach-search-clear").hidden = true; st.page = 1; render(); $("coach-search").focus(); });
  // Rutas administrativas (#/nuevo, #/jugador/ID…) no existen para el Entrenador
  if (location.hash && !parseHash().name.startsWith("ficha")) history.replaceState(null, "", location.pathname);
}
