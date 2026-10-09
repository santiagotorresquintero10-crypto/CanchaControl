/* ==========================================================
   CanchaControl — Pantalla Jugadores (HU-007) · solo Administrador
   Vistas en una sola página (sin recargar):
     #                   → listado
     #/nuevo             → nuevo jugador (4 pasos)
     #/jugador/ID        → expediente
     #/jugador/ID/editar → editar (mismos 4 pasos)
   Conocer el ID en la URL NO da acceso: firestore.rules solo deja leer
   expedientes al Administrador.
   El expediente se vincula a una cuenta EXISTENTE con rol Jugador
   (users/{uid}) creada en Gestión de usuarios. Aquí NO se crean cuentas.
   ========================================================== */
import { protectPage } from "./authGuard.js";
import { can, ACTION, ROLE, ESTADO, readScope, SCOPE } from "./permissions.js";
import { mountShell, initials } from "./shell.js";
import { toast, initFilterCards } from "./ui.js";
import { isValidEmail } from "./auth.js";
import { subscribeUsers } from "./users.js";
import {
  TIPOS_DOC, TIPO_DOC_LABEL, PARENTESCOS, POSICIONES, GENEROS, ESTADO_JUG, LIMITS, MSG,
  normalizeDocumento, cleanText, parseFecha, edad, todayISO, nombreCompleto,
  subscribeJugadores, createJugador, updateJugador, friendlyJugadorError, getFoto, prepararFoto,
  asignarCategoria, sincronizarFichas,
} from "./jugadores-data.js";
import { subscribeCategorias, periodoLabel, rangoLabel } from "./categorias-data.js";

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 10;
const norm = (s) => String(s ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();

const state = {
  me: null, canCreate: false, canUpdate: false,
  users: new Map(), usersLoaded: false, usersError: false,
  jugadores: [], loaded: false, loadError: null,
  cats: new Map(), catsLoaded: false, catsError: false,   // HU-008: categorías reales
  q: "", estado: "", cat: "", page: 1,
  route: { name: "list" },
};

protectPage({
  page: "jugadores",
  onReady(profile) {
    state.me = profile;
    mountShell(profile, "jugadores");
    // HU-009: el Entrenador usa la vista "Mis jugadores" (solo fichas de SUS categorías).
    // No se carga nada de la vista administrativa: ni users, ni expedientes, ni categorías ajenas.
    if (readScope(profile.rol, "jugadores") === SCOPE.ASSIGNED) {
      $("view-list").remove(); $("view-form").remove(); $("view-detail").remove();
      import("./mis-jugadores.js").then((m) => m.start(profile));
      return;
    }
    $("view-coach").remove(); $("view-ficha").remove();
    state.canCreate = can(profile, "jugadores", ACTION.CREATE);
    state.canUpdate = can(profile, "jugadores", ACTION.UPDATE);
    $("new-btn").hidden = !state.canCreate;
    fillStaticSelects();
    wireUi();
    subscribeUsers(
      (list) => { state.users = new Map(list.map((u) => [u.uid, u])); state.usersLoaded = true; state.usersError = false; refresh(); refreshAccountList(); },
      (err) => { console.error("[CanchaControl] Usuarios:", err?.code || err); state.usersLoaded = true; state.usersError = true; refresh(); refreshAccountList(); }
    );
    subscribeJugadores(
      (list) => { state.jugadores = list; state.loaded = true; state.loadError = null; refresh(); refreshAccountList(); refreshCatList(); syncFichasOnce(); },
      (err) => { console.error("[CanchaControl] Jugadores:", err?.code || err); state.loaded = true; state.loadError = err; refresh(); }
    );
    // HU-008: categorías reales (Administrador lee todas por reglas)
    subscribeCategorias(
      (list) => { state.cats = new Map(list.map((c) => [c.id, c])); state.catsLoaded = true; state.catsError = false; refreshCatFilter(); refresh(); refreshCatList(); },
      (err) => { console.error("[CanchaControl] Categorías:", err?.code || err); state.catsLoaded = true; state.catsError = true; refresh(); refreshCatList(); }
    );
    window.addEventListener("hashchange", onRoute);
    onRoute();
  },
});

/* HU-009 — Al abrir Jugadores, el Administrador pone al día (una vez) las fichas
   deportivas de expedientes vinculados antes de HU-009. Idempotente. */
let fichasSynced = false;
function syncFichasOnce() {
  if (fichasSynced || !state.canUpdate) return;
  fichasSynced = true;
  sincronizarFichas(state.jugadores)
    .then((n) => { if (n) toast("info", `Se actualizaron ${n} ${n === 1 ? "ficha deportiva" : "fichas deportivas"} para los entrenadores.`); })
    .catch((err) => console.error("[CanchaControl] Sincronizar fichas:", err?.code || err));
}

/* ==========================================================
   Rutas
   ========================================================== */
function parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  if (h === "nuevo") return { name: "new" };
  let m = /^jugador\/([A-Za-z0-9_-]{1,64})\/editar$/.exec(h);
  if (m) return { name: "edit", id: m[1] };
  m = /^jugador\/([A-Za-z0-9_-]{1,64})$/.exec(h);
  if (m) return { name: "detail", id: m[1] };
  return { name: "list" };
}
function go(hash) { if (location.hash === hash || (hash === "#" && !location.hash)) onRoute(); else location.hash = hash; }
const sameRoute = (a, b) => a.name === b.name && a.id === b.id;
const hashFor = (r) => r.name === "new" ? "#/nuevo" : r.name === "edit" ? `#/jugador/${r.id}/editar` : r.name === "detail" ? `#/jugador/${r.id}` : "#";

let skipGuard = false;
function onRoute() {
  const next = parseHash();
  // Salir del formulario con cambios sin guardar → confirmar
  if (!skipGuard && ["new", "edit"].includes(state.route.name) && isDirty() && !sameRoute(next, state.route)) {
    const back = state.route;
    askDiscard().then((ok) => {
      if (ok) { form.dirtyBase = null; skipGuard = true; onRoute(); skipGuard = false; }
      else history.replaceState(null, "", hashFor(back));
    });
    return;
  }
  state.route = next;
  ["view-list", "view-form", "view-detail"].forEach((v) => { $(v).hidden = true; });
  if (next.name === "list") { $("view-list").hidden = false; document.title = "Jugadores · CanchaControl"; refresh(); }
  else if (next.name === "new") {
    if (!state.canCreate) { toast("error", MSG.noPermission); return go("#"); }
    $("view-form").hidden = false; startCreate();
  } else if (next.name === "edit") {
    if (!state.canUpdate) { toast("error", MSG.noPermission); return go(`#/jugador/${next.id}`); }
    $("view-form").hidden = false; startEdit(next.id);
  } else { $("view-detail").hidden = false; renderDetail(); }
  window.scrollTo({ top: 0 });
}

/** Cada vez que llegan datos en vivo: repinta lo que esté a la vista. */
function refresh() {
  const r = state.route.name;
  if (r === "list") renderList();
  else if (r === "detail") renderDetail();
  else if (r === "edit" && form.pending) startEdit(state.route.id);
  else if (r === "new" || r === "edit") renderConfirm();
}

/* ==========================================================
   Relaciones (siempre por UID / id, nunca por nombre o correo)
   ========================================================== */
const linkedUserIds = () => new Set(state.jugadores.map((j) => j.userId).filter(Boolean));
function availableAccounts() {
  const linked = linkedUserIds();
  return [...state.users.values()]
    .filter((u) => u.rol === ROLE.JUGADOR && u.estado === ESTADO.ACTIVO && !u.jugadorId && !linked.has(u.uid))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" }));
}
function accountInfo(j) {
  if (!state.usersLoaded) return { kind: "loading" };
  const u = state.users.get(j.userId);
  if (!u) return { kind: "missing" };
  return { kind: u.estado === ESTADO.ACTIVO ? "ok" : "inactive", user: u, consistent: u.jugadorId === j.id && u.rol === ROLE.JUGADOR };
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

/* ---------- Foto o iniciales ---------- */
function pic(j, cls = "") {
  const box = el("span", `pic ${cls}`.trim(), initials(nombreCompleto(j)));
  box.setAttribute("aria-hidden", "true");
  getFoto(j.id).then((src) => {
    if (!src) return;
    const img = new Image(); img.alt = ""; img.src = src;
    box.append(img);
  });
  return box;
}

/* ==========================================================
   LISTADO
   ========================================================== */
function matches(j) {
  // Tarjeta activa (HU-010): Activo / Inactivo / Sin categoría
  if (state.estado === "__sincat" && j.categoriaId) return false;
  if ((state.estado === "Activo" || state.estado === "Inactivo") && j.estado !== state.estado) return false;
  if (state.cat && j.categoriaId !== state.cat) return false;
  if (state.q) {
    const q = norm(state.q), qDoc = normalizeDocumento(state.q);
    if (!norm(nombreCompleto(j)).includes(q) && !(qDoc && j.documentoNormalizado.includes(qDoc))) return false;
  }
  return true;
}

function renderList() {
  if (!state.loaded) return;
  if (state.loadError) return showLoadError(state.loadError);
  const all = state.jugadores;
  $("kpi-total").textContent = String(all.length);
  $("kpi-activos").textContent = String(all.filter((j) => j.estado === ESTADO_JUG.ACTIVO).length);
  $("kpi-inactivos").textContent = String(all.filter((j) => j.estado === ESTADO_JUG.INACTIVO).length);
  $("kpi-pendientes").textContent = state.usersLoaded && !state.usersError ? String(availableAccounts().length) : "—";
  $("kpi-sincat").textContent = String(all.filter((j) => !j.categoriaId).length);

  const rows = all.filter(matches);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (state.page > pages) state.page = pages;
  const start = (state.page - 1) * PAGE_SIZE;
  const visible = rows.slice(start, start + PAGE_SIZE);
  $("jug-body").replaceChildren(...visible.map((j, i) => rowFor(j, start + i + 1)));
  $("jug-table").hidden = rows.length === 0;
  $("toolbar").hidden = all.length === 0;

  if (all.length === 0) {
    showEmpty("Aún no hay jugadores registrados.", "Vincula una cuenta con rol Jugador y completa su expediente.",
      state.canCreate ? "+ Registrar primer jugador" : null, () => go("#/nuevo"));
    $("pagination").hidden = true; return;
  }
  if (rows.length === 0) {
    showEmpty("No encontramos jugadores con estos criterios.", "Prueba con otro nombre o documento, o cambia el filtro.", "Limpiar filtros", clearFilters, "btn-outline");
    $("pagination").hidden = true; return;
  }
  $("empty-state").hidden = true;
  renderPagination(rows.length, start, visible.length, pages);
}

function showEmpty(title, text, actionLabel, onAction, variant = "btn-primary") {
  $("empty-title").textContent = title;
  $("empty-text").textContent = text;
  const b = $("empty-action");
  b.hidden = !actionLabel;
  if (actionLabel) { b.textContent = actionLabel; b.className = `btn ${variant} empty__btn`; b.onclick = onAction; }
  $("empty-state").hidden = false;
  $("jug-table").hidden = true;
}

function showLoadError(err) {
  $("jug-body").replaceChildren();
  $("pagination").hidden = true; $("toolbar").hidden = true;
  ["kpi-total", "kpi-activos", "kpi-inactivos", "kpi-pendientes"].forEach((id) => { $(id).textContent = "—"; });
  if (err?.code === "permission-denied") showEmpty("No tienes permisos para consultar los expedientes.", "Si crees que es un error, comunícate con el Administrador.", null);
  else showEmpty("No fue posible cargar los jugadores.", navigator.onLine ? "El servicio no respondió. Intenta nuevamente en unos segundos." : "Parece que no tienes conexión a internet.", "Reintentar", () => location.reload());
}

function renderPagination(total, start, shown, pages) {
  $("pagination").hidden = false;
  $("page-info").textContent = `Mostrando ${start + 1} a ${start + shown} de ${total} ${total === 1 ? "jugador" : "jugadores"}`;
  const mk = (label, page, { disabled = false, current = false, aria } = {}) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "page-btn"; b.innerHTML = label;
    if (aria) b.setAttribute("aria-label", aria);
    if (current) b.setAttribute("aria-current", "page");
    b.disabled = disabled;
    b.addEventListener("click", () => { state.page = page; renderList(); });
    return b;
  };
  const arrow = (d) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><polyline points="${d}"/></svg>`;
  const items = [mk(arrow("15 18 9 12 15 6"), state.page - 1, { disabled: state.page === 1, aria: "Página anterior" })];
  for (let p = 1; p <= pages; p++) items.push(mk(String(p), p, { current: p === state.page, aria: `Página ${p}` }));
  items.push(mk(arrow("9 18 15 12 9 6"), state.page + 1, { disabled: state.page === pages, aria: "Página siguiente" }));
  $("page-nav").replaceChildren(...items);
}

const td = (cls, text) => el("td", cls, text);
const ICON = {
  eye: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
  cat: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 8 4-8 4-8-4z"/><path d="m4 12 8 4 4-2"/><line x1="19" y1="14" x2="19" y2="20"/><line x1="16" y1="17" x2="22" y2="17"/></svg>',
  edit: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
};
function iconLink(cls, label, title, icon, href) {
  const a = document.createElement("a");
  a.className = `icon-action ${cls}`; a.href = href; a.title = title;
  a.setAttribute("aria-label", label); a.innerHTML = icon;
  return a;
}
const edadLabel = (f) => { const n = edad(f); return n === null ? "—" : `${n} ${n === 1 ? "año" : "años"}`; };
function fechaCorta(f) { const d = parseFecha(f); return d ? `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}` : "—"; }
function fechaLarga(f) { const d = parseFecha(f); return d ? d.toLocaleDateString("es-CO", { day: "numeric", month: "long", year: "numeric" }) : "—"; }

function rowFor(j, n) {
  const tr = document.createElement("tr");
  tr.dataset.id = j.id;
  const name = nombreCompleto(j);
  const t0 = td("col-n", String(n));
  const t1 = td("c-name");
  const ent = el("div", "row-entity");
  const who = el("div");
  who.append(el("span", "cell-strong", name));
  const acc = accountInfo(j);
  if (acc.kind === "inactive") who.append(el("span", "cell-flag", "Cuenta inactiva"));
  if (acc.kind === "missing") who.append(el("span", "cell-flag", "Cuenta no encontrada"));
  ent.append(pic(j), who); t1.append(ent);
  const tc = catCell(j);
  const t2 = td("c-doc", `${j.tipoDocumento} ${j.numeroDocumento}`);
  const t3 = td("c-fecha", fechaCorta(j.fechaNacimiento));
  t3.append(el("span", "cell-sub", edadLabel(j.fechaNacimiento)));
  const t4 = td("c-contacto cell-muted", j.telefono || j.correoContacto || "—");
  const t5 = td("c-estado");
  const activo = j.estado === ESTADO_JUG.ACTIVO;
  t5.append(el("span", `badge ${activo ? "badge--success" : "badge--danger"}`, activo ? "Activo" : "Inactivo"));
  const t6 = td("col-actions");
  t6.style.gap = ".4rem";
  t6.append(iconLink("act-view", `Ver expediente de ${name}`, "Ver expediente", ICON.eye, `#/jugador/${j.id}`));
  if (state.canUpdate) t6.append(iconLink("act-edit", `Editar expediente de ${name}`, "Editar", ICON.edit, `#/jugador/${j.id}/editar`));
  if (state.canUpdate) {
    const label = j.categoriaId ? "Cambiar categoría" : "Asignar categoría";
    const b = el("button", "icon-action icon-action--cat act-cat");
    b.type = "button"; b.title = label; b.setAttribute("aria-label", `${label} de ${name}`); b.innerHTML = ICON.cat;
    b.addEventListener("click", () => openCatDrawer(j.id));
    t6.append(b);
  }
  tr.append(t0, t1, tc, t2, t3, t4, t5, t6);
  return tr;
}

/* ---------- Categoría del jugador (derivada de categorias/{categoriaId}, nunca copiada) ---------- */
function catInfo(j) {
  if (!j.categoriaId) return { kind: "none" };
  if (!state.catsLoaded) return { kind: "loading" };
  const c = state.cats.get(j.categoriaId);
  if (!c) return { kind: "missing" };
  return { kind: c.estado === "Activa" ? "ok" : "inactive", cat: c };
}
function catCell(j) {
  const cell = td("c-cat");
  const info = catInfo(j);
  if (info.kind === "none") cell.append(el("span", "cell-nocat", "Sin categoría"));
  else if (info.kind === "loading") cell.append(el("span", "skel", ""));
  else if (info.kind === "missing") cell.append(el("span", "cell-strong", "Categoría no encontrada"));
  else {
    cell.append(el("span", "cell-cat", info.cat.nombre));
    if (info.kind === "inactive") cell.append(el("span", "cell-flag", "Categoría inactiva"));
  }
  return cell;
}
const catNombre = (id) => (id ? state.cats.get(id)?.nombre ?? "Categoría no encontrada" : "Sin categoría");

function refreshCatFilter() {
  const sel = $("filter-cat");
  const cur = sel.value;
  const cats = [...state.cats.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" }));
  sel.replaceChildren(new Option("Todas las categorías", ""),
    ...cats.map((c) => new Option(c.estado === "Activa" ? c.nombre : `${c.nombre} (inactiva)`, c.id)));
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : "";
  state.cat = sel.value;
}

let jugCards = null;
function clearFilters() {
  state.q = state.estado = state.cat = ""; $("search").value = ""; jugCards?.set(""); $("filter-cat").value = "";
  state.page = 1; renderList(); $("search").focus();
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/* ==========================================================
   EXPEDIENTE (solo lectura; sin credenciales ni UID)
   ========================================================== */
const SVG = (p) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  doc: SVG('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M6.5 16c.5-1.5 1.5-2.2 2.5-2.2s2 .7 2.5 2.2"/><line x1="14" y1="10" x2="18" y2="10"/><line x1="14" y1="14" x2="17" y2="14"/>'),
  cal: SVG('<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><line x1="3.5" y1="10" x2="20.5" y2="10"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/>'),
  user: SVG('<circle cx="12" cy="8" r="3.5"/><path d="M5 20v-1a7 7 0 0 1 14 0v1"/>'),
  pin: SVG('<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>'),
  note: SVG('<path d="M5 4h10l4 4v12H5z"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="13" y2="16"/>'),
  phone: SVG('<path d="M5 4h3.5l1.5 4-2 1.5a11 11 0 0 0 6.5 6.5L16 14l4 1.5V19a1.5 1.5 0 0 1-1.6 1.5C10.5 20 4 13.5 3.5 5.6A1.5 1.5 0 0 1 5 4Z"/>'),
  mail: SVG('<rect x="3" y="5.5" width="18" height="13" rx="2"/><polyline points="3.5 7 12 13 20.5 7"/>'),
  home: SVG('<path d="m3 10.5 9-7 9 7"/><path d="M5 9.5V20h14V9.5"/>'),
  heart: SVG('<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z"/>'),
  shirt: SVG('<path d="M8 3 4 5.5 5.5 10H8v11h8V10h2.5L20 5.5 16 3a4 4 0 0 1-8 0Z"/>'),
  flag: SVG('<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>'),
  run: SVG('<circle cx="14" cy="4.5" r="2"/><path d="m7 21 3-6 3 2v4"/><path d="m6 11 3-3 4 1 3 4h3"/>'),
  layers: SVG('<path d="m12 3 9 4.5-9 4.5-9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>'),
  key: SVG('<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9"/><path d="m17 6 2 2"/>'),
};

function renderDetail() {
  const box = $("exp-card");
  const id = state.route.id;
  if (!state.loaded) { box.innerHTML = '<div class="empty"><span class="spinner" aria-hidden="true"></span><p class="empty__text">Cargando expediente…</p></div>'; $("detail-crumb").textContent = "…"; return; }
  if (state.loadError) {
    $("detail-crumb").textContent = "Expediente";
    const e = el("div", "empty");
    e.append(el("p", "empty__title", "No fue posible cargar el expediente."), el("p", "empty__text", "Revisa tu conexión e intenta nuevamente."));
    box.replaceChildren(e); return;
  }
  const j = state.jugadores.find((x) => x.id === id);
  if (!j) {
    $("detail-crumb").textContent = "Expediente no encontrado";
    const e = el("div", "empty");
    e.append(el("p", "empty__title", "Este expediente no existe o ya no está disponible."), el("p", "empty__text", "Vuelve al listado de jugadores."));
    const a = el("a", "btn btn-outline empty__btn", "Volver a Jugadores"); a.href = "#";
    e.append(a); box.replaceChildren(e); return;
  }
  const name = nombreCompleto(j);
  $("detail-crumb").textContent = name;
  document.title = `${name} · Jugadores · CanchaControl`;

  // Encabezado: foto, nombre, posición | número | estado
  const head = el("header", "exp-head");
  const main = el("div", "exp-head__main");
  main.append(el("h1", "exp-head__name", name));
  const meta = el("div", "exp-head__meta");
  const parts = [j.posicion && j.posicion !== "Por definir" ? j.posicion : null, j.numeroCamiseta !== null ? `#${j.numeroCamiseta}` : null].filter(Boolean);
  parts.forEach((p, i) => { if (i) meta.append(el("span", "sep", "|")); meta.append(el("span", "", p)); });
  const activo = j.estado === ESTADO_JUG.ACTIVO;
  meta.append(el("span", `badge ${activo ? "badge--success" : "badge--danger"}`, activo ? "Activo" : "Inactivo"));
  const acc = accountInfo(j);
  if (acc.kind === "inactive") meta.append(el("span", "badge badge--warning", "Cuenta inactiva"));
  main.append(meta);
  head.append(pic(j, "pic--xl"), main);
  if (state.canUpdate) {
    const ed = el("a", "btn btn-outline");
    ed.href = `#/jugador/${j.id}/editar`; ed.id = "detail-edit";
    ed.innerHTML = `${ICON.edit}<span>Editar</span>`;
    head.append(ed);
  }

  const tabs = el("div", "exp-tabs"); tabs.append(el("span", "", "Información general"));

  const item = (icon, value, label) => {
    const li = el("li"); li.insertAdjacentHTML("afterbegin", icon);
    const t = el("div"); if (label) t.append(el("span", "k", label));
    t.append(el("span", "v", value || "—")); li.append(t); return li;
  };
  const sec = (title, items, extra, wide) => {
    const s = el("section", `exp-sec${wide ? " exp-sec--wide" : ""}`);
    s.append(el("h2", "exp-sec__title", title));
    if (extra) s.append(extra);
    const ul = el("ul", "exp-list"); items.forEach((x) => ul.append(x)); s.append(ul);
    return s;
  };

  const personal = sec("Datos personales", [
    item(I.doc, `${j.tipoDocumento} ${j.numeroDocumento}`, TIPO_DOC_LABEL[j.tipoDocumento]),
    item(I.cal, `${fechaLarga(j.fechaNacimiento)} (${edadLabel(j.fechaNacimiento)})`, "Fecha de nacimiento"),
    item(I.user, j.genero, "Género"),
    item(I.pin, j.ciudadNacimiento, "Ciudad de nacimiento"),
    ...(j.observaciones ? [item(I.note, j.observaciones, "Observaciones")] : []),
  ]);
  const deportiva = sec("Información deportiva", [
    item(I.run, j.posicion, "Posición"),
    item(I.shirt, j.numeroCamiseta === null ? "—" : String(j.numeroCamiseta), "Número de camiseta"),
    item(I.flag, j.estado, "Estado deportivo"),
    item(I.cal, j.fechaIngreso ? fechaLarga(j.fechaIngreso) : "—", "Fecha de ingreso"),
    ...catDetailItems(j, item),
    ...(j.observacionesDeportivas ? [item(I.note, j.observacionesDeportivas, "Observaciones")] : []),
  ]);
  if (state.canUpdate) {
    const act = el("div", "exp-sec__action");
    const b = el("button", "btn btn-outline", j.categoriaId ? "Cambiar categoría" : "Asignar categoría");
    b.type = "button"; b.id = "detail-cat";
    b.addEventListener("click", () => openCatDrawer(j.id));
    act.append(b); deportiva.append(act);
  }
  const contacto = sec("Información de contacto", [
    item(I.phone, j.telefono, "Teléfono"),
    item(I.mail, j.correoContacto, "Correo de contacto"),
    item(I.home, [j.direccion, j.ciudad].filter(Boolean).join(", "), "Dirección"),
  ]);
  const emergencia = sec("Contacto de emergencia", [
    item(I.user, j.emergencia.nombre, "Nombre"),
    item(I.heart, j.emergencia.parentesco, "Parentesco"),
    item(I.phone, j.emergencia.telefono, "Teléfono"),
  ]);
  let accItems, warn = null;
  if (acc.kind === "loading") accItems = [item(I.key, "Cargando…", "Cuenta")];
  else if (acc.kind === "missing") {
    accItems = [item(I.key, "Cuenta no encontrada", "Cuenta")];
    warn = el("p", "f-alert exp-warn", "La cuenta vinculada a este expediente no existe. El expediente se conserva.");
  } else {
    accItems = [item(I.user, acc.user.nombre, "Nombre de la cuenta"), item(I.mail, acc.user.email, "Correo de acceso"),
      item(I.key, acc.kind === "ok" ? "Activa" : "Cuenta inactiva", "Estado de la cuenta")];
    if (acc.kind === "inactive") warn = el("p", "f-note exp-warn", "Cuenta inactiva: no puede ingresar a CanchaControl. El expediente y su información se conservan.");
    if (!acc.consistent) warn = el("p", "f-alert exp-warn", "El vínculo con la cuenta no es coherente (la cuenta no apunta a este expediente). Revísalo antes de continuar.");
  }
  const cuenta = sec("Cuenta de acceso", accItems, warn, true);

  const grid = el("div", "exp-grid");
  grid.append(personal, deportiva, contacto, emergencia, cuenta);
  const foot = el("footer", "exp-foot");
  const fmt = (ms) => ms ? new Date(ms).toLocaleString("es-CO", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
  foot.append(el("span", "", `Creado: ${fmt(j.createdAtMs)}`), el("span", "", `Última actualización: ${fmt(j.updatedAtMs)}`));
  box.replaceChildren(head, tabs, grid, foot);
}

/* Información de categoría en el expediente: SIEMPRE leída de categorias/{id}
   y del usuario entrenador (users/{entrenadorId}); nada copiado en el expediente. */
function catDetailItems(j, item) {
  const info = catInfo(j);
  if (info.kind === "none") return [item(I.layers, "Este jugador todavía no tiene una categoría asignada.", "Categoría actual")];
  if (info.kind === "loading") return [item(I.layers, "Cargando…", "Categoría actual")];
  if (info.kind === "missing") return [item(I.layers, "Categoría no encontrada", "Categoría actual")];
  const c = info.cat;
  const coach = c.entrenadorId ? state.users.get(c.entrenadorId) : null;
  const coachTxt = !c.entrenadorId ? "Sin entrenador" : !state.usersLoaded ? "Cargando…" : coach ? `${coach.nombre}${coach.estado !== "Activo" ? " (inactivo)" : ""}` : "Usuario no encontrado";
  return [
    item(I.layers, `${c.nombre} · ${rangoLabel(c)} · ${periodoLabel(c.periodoLectivo)}`, "Categoría actual"),
    item(I.doc, c.codigoGrupo, "Código de categoría"),
    item(I.user, coachTxt, "Entrenador principal"),
    item(I.flag, info.kind === "ok" ? "Activa" : "Inactiva", "Estado de la categoría"),
  ];
}

/* ==========================================================
   HU-008 — ASIGNAR / CAMBIAR CATEGORÍA (panel lateral)
   ========================================================== */
const catForm = { jugadorId: null, expected: null, saving: false, q: "", returnFocus: null };

function activeCats() {
  return [...state.cats.values()].filter((c) => c.estado === "Activa")
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" }));
}
function hashIdx(s, n) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % n; }
const TILE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="7.5" r="3.2"/><circle cx="16.5" cy="8.5" r="2.5"/><path d="M2.5 19.5c0-3.4 2.9-5.6 6.5-5.6s6.5 2.2 6.5 5.6v.5h-13v-.5Z"/><path d="M15.4 13.9c3-.2 6.1 1.4 6.1 4.6v1.5h-4.2v-.5c0-2.2-.7-4.1-1.9-5.6Z"/></svg>';

function openCatDrawer(jugadorId) {
  if (!state.canUpdate) { toast("error", MSG.noAuth); return; }
  const j = state.jugadores.find((x) => x.id === jugadorId);
  if (!j) { toast("error", MSG.missing); return; }
  Object.assign(catForm, { jugadorId, expected: j.categoriaId ?? null, saving: false, q: "", returnFocus: document.activeElement });
  $("cat-title").textContent = j.categoriaId ? "Cambiar categoría" : "Asignar categoría";
  $("cat-search").value = "";
  $("cat-alert").hidden = true; $("f-cat-err").textContent = "";
  renderCatPlayer(j);
  refreshCatList();
  const d = $("cat-drawer");
  d.classList.add("is-open"); d.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open"); $("app").inert = true;
  setTimeout(() => ($("cat-list").querySelector("input") ?? d.querySelector("[data-close].btn"))?.focus(), 60);
}
function renderCatPlayer(j) {
  const box = $("cat-player");
  const row = (k, v, extra) => { const p = el("p", "cat-player__row"); p.append(el("span", "k", `${k}:`), el("strong", "", v)); if (extra) p.append(extra); return p; };
  const info = catInfo(j);
  let actual;
  if (info.kind === "none") actual = el("p", "cat-player__row", "Este jugador todavía no tiene una categoría asignada.");
  else {
    const flag = info.kind === "inactive" ? el("span", "badge badge--warning", "Inactiva") : null;
    actual = row("Categoría actual", catNombre(j.categoriaId), flag);
  }
  box.replaceChildren(el("p", "cat-player__name", nombreCompleto(j)), row("Documento", `${j.tipoDocumento} ${j.numeroDocumento}`), actual);
}
function closeCatDrawer() {
  if (catForm.saving) return;
  const d = $("cat-drawer");
  if (!d.classList.contains("is-open")) return;
  d.classList.remove("is-open"); d.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open"); $("app").inert = false;
  catForm.jugadorId = null;
  catForm.returnFocus?.focus?.();
}
function refreshCatList() {
  if (!catForm.jugadorId) return;   // panel cerrado
  const list = $("cat-list"), save = $("cat-save");
  const prev = list.querySelector("input:checked")?.value ?? null;
  const j = state.jugadores.find((x) => x.id === catForm.jugadorId);
  if (j) {
    // Cambio hecho por otra persona mientras el panel está abierto: se AVISA (no se pisa en silencio)
    if (!catForm.saving && (j.categoriaId ?? null) !== catForm.expected) {
      catForm.expected = j.categoriaId ?? null;
      $("cat-title").textContent = j.categoriaId ? "Cambiar categoría" : "Asignar categoría";
      const a = $("cat-alert"); a.textContent = `Atención: otro administrador acaba de cambiar la categoría de este jugador a ${catNombre(j.categoriaId)}. Revisa antes de confirmar.`; a.hidden = false;
    }
    renderCatPlayer(j);
  }
  if (!state.catsLoaded) { list.innerHTML = '<div class="select-list__state" role="status"><span class="spinner" aria-hidden="true"></span>Cargando categorías…</div>'; save.disabled = true; $("cat-search-wrap").hidden = true; return; }
  if (state.catsError) { list.innerHTML = '<div class="select-list__state" role="alert">No fue posible cargar las categorías. Intenta nuevamente.</div>'; save.disabled = true; $("cat-search-wrap").hidden = true; return; }
  const cats = activeCats();   // SOLO categorías activas como opción
  if (!cats.length) { list.innerHTML = '<div class="select-list__state" role="status">No hay categorías activas disponibles para realizar la asignación.</div>'; save.disabled = true; $("cat-search-wrap").hidden = true; return; }
  save.disabled = catForm.saving;
  $("cat-search-wrap").hidden = cats.length < 6;
  const q = norm($("cat-search").value);
  const shown = cats.filter((c) => !q || norm(c.nombre).includes(q) || norm(c.codigoGrupo).includes(q));
  if (!shown.length) { list.innerHTML = '<div class="select-list__state" role="status">Ninguna categoría coincide con la búsqueda.</div>'; return; }
  list.replaceChildren(...shown.map((c) => {
    const l = el("label", "select-opt cat-opt");
    const r = document.createElement("input"); r.type = "radio"; r.name = "categoria"; r.value = c.id;   // id real
    r.checked = prev ? prev === c.id : catForm.expected === c.id;
    r.addEventListener("change", () => { $("f-cat-err").textContent = ""; });
    const tile = el("span", `row-tile tile-${hashIdx(c.nombreNormalizado || c.nombre, 8)}`); tile.innerHTML = TILE; tile.setAttribute("aria-hidden", "true");
    const who = el("span");
    const n = el("p", "select-opt__name", c.nombre);
    if (catForm.expected === c.id) n.append(el("span", "select-opt__tag", "Actual"));
    const coach = c.entrenadorId ? state.users.get(c.entrenadorId)?.nombre ?? "Entrenador asignado" : "Sin entrenador";
    who.append(n, el("p", "cat-opt__meta", `${c.codigoGrupo} · ${rangoLabel(c)} · ${periodoLabel(c.periodoLectivo)}`), el("p", "cat-opt__meta", `Entrenador: ${coach}`));
    l.append(r, tile, who);
    return l;
  }));
}
function setCatSaving(on) {
  catForm.saving = on;
  const b = $("cat-save");
  b.disabled = on;
  b.innerHTML = on ? '<span class="spinner" aria-hidden="true"></span><span class="btn-label">Guardando…</span>' : '<span class="btn-label">Confirmar asignación</span>';
  $("cat-drawer").querySelectorAll("[data-close]").forEach((x) => { x.disabled = on; });
}
async function onCatSubmit(e) {
  e.preventDefault();
  if (catForm.saving || !catForm.jugadorId) return;
  $("cat-alert").hidden = true;
  const nueva = $("cat-list").querySelector("input:checked")?.value;
  if (!nueva) { $("f-cat-err").textContent = MSG.catRequired; return; }
  const j = state.jugadores.find((x) => x.id === catForm.jugadorId);
  const actual = catForm.expected;
  if (nueva === actual) { toast("info", MSG.catSame); return; }   // sin escritura redundante
  if (actual) {
    const ok = await catConfirm(`¿Confirmas el cambio de categoría de este jugador de ${catNombre(actual)} a ${catNombre(nueva)}?`);
    if (!ok) return;   // Cancelar: nada cambia
  }
  setCatSaving(true);
  try {
    await asignarCategoria(catForm.jugadorId, nueva, { expectedCategoriaId: actual, actorUid: state.me.uid });
    setCatSaving(false);
    closeCatDrawer();
    toast("success", actual ? "Categoría del jugador actualizada correctamente." : "Jugador asignado correctamente a la categoría.");
  } catch (err) {
    console.error("[CanchaControl] Asignar categoría:", err?.code || err);
    setCatSaving(false);
    const msg = err?.code === "permission-denied" ? MSG.noAuth : friendlyJugadorError(err);
    const a = $("cat-alert"); a.textContent = msg; a.hidden = false;
    toast("error", msg);
    if (err?.code === "cat-changed" && j) { const cur = state.jugadores.find((x) => x.id === j.id); if (cur) { catForm.expected = cur.categoriaId ?? null; renderCatPlayer(cur); } }
  }
}
let catConfResolve = null;
function catConfirm(text) {
  $("catconf-text").textContent = text;
  openModal("catconf-modal", "[data-cancel].btn");
  return new Promise((r) => { catConfResolve = r; });
}
function closeCatConf(ok) { closeModal("catconf-modal", { restore: true }); catConfResolve?.(ok); catConfResolve = null; }

/* ==========================================================
   FORMULARIO POR PASOS (crear / editar)
   ========================================================== */
const form = { mode: "create", id: null, step: 1, maxStep: 1, saving: false, userId: null, expectedMs: 0,
  prefill: null, dirtyBase: null, pending: false, foto: undefined, fotoOriginal: null };
const STEP_LABEL = { 1: "Datos personales", 2: "Contacto y emergencia", 3: "Información deportiva", 4: "Confirmación" };

function fillStaticSelects() {
  $("f-tipodoc").replaceChildren(new Option("Selecciona…", ""), ...TIPOS_DOC.map(([v, l]) => new Option(l, v)));
  $("f-genero").replaceChildren(new Option("Selecciona…", ""), ...GENEROS.map((g) => new Option(g, g)));
  $("f-em-parentesco").replaceChildren(new Option("Selecciona…", ""), ...PARENTESCOS.map((p) => new Option(p, p)));
  $("f-posicion").replaceChildren(...POSICIONES.map((p) => new Option(p, p)));
  $("f-fecha").max = todayISO(); $("f-fecha").min = `${LIMITS.ANIO_MIN}-01-01`;
  $("f-ingreso").max = todayISO(); $("f-ingreso").min = `${LIMITS.ANIO_MIN}-01-01`;
}

const FIELDS = ["account", "nombres", "apellidos", "tipodoc", "numdoc", "fecha", "genero", "foto", "telefono", "correo", "em-nombre", "em-parentesco", "em-telefono", "camiseta", "ingreso"];
const FIELD_LABEL = {
  account: "Cuenta de acceso", nombres: "Nombres del jugador", apellidos: "Apellidos del jugador", tipodoc: "Tipo de documento",
  numdoc: "Número de documento", fecha: "Fecha de nacimiento", genero: "Género", foto: "Foto", telefono: "Teléfono de contacto",
  correo: "Correo de contacto", "em-nombre": "Nombre del contacto de emergencia", "em-parentesco": "Parentesco del contacto de emergencia",
  "em-telefono": "Teléfono del contacto de emergencia", camiseta: "Número de camiseta", ingreso: "Fecha de ingreso",
};

function setErr(f, msg) {
  const e = $(`f-${f}-err`); if (e) e.textContent = msg;
  const inp = $(`f-${f}`);
  if (inp && f !== "foto") { inp.closest(".f-field")?.classList.add("has-error"); inp.setAttribute("aria-invalid", "true"); }
}
function clearErr(f) {
  const e = $(`f-${f}-err`); if (e) e.textContent = "";
  const inp = $(`f-${f}`);
  if (inp && f !== "foto") { inp.closest(".f-field")?.classList.remove("has-error"); inp.setAttribute("aria-invalid", "false"); }
}

function resetForm() {
  $("jug-form").reset();
  FIELDS.forEach(clearErr);
  $("form-alert").hidden = true;
  $("prefill-note").hidden = true;
  $("acc-search").value = "";
  $("acc-list").replaceChildren();
  $("f-posicion").value = POSICIONES[0];
  $("f-estado").value = ESTADO_JUG.ACTIVO;
  $("f-fecha-help").textContent = "";
  setPhotoPreview(null);
}

function startCreate() {
  Object.assign(form, { mode: "create", id: null, step: 1, maxStep: 1, saving: false, userId: null, expectedMs: 0, prefill: null, pending: false, foto: null, fotoOriginal: null });
  resetForm();
  $("form-title").textContent = "Nuevo jugador"; $("form-crumb").textContent = "Nuevo jugador";
  $("form-subtitle").textContent = "Completa la información del jugador.";
  document.title = "Nuevo jugador · Jugadores · CanchaControl";
  $("account-locked").hidden = true;
  refreshAccountList();
  goStep(1);
  form.dirtyBase = snapshot();
  setTimeout(() => ($("acc-list").querySelector("input") ?? $("f-nombres")).focus?.(), 50);
}

function startEdit(id) {
  if (!state.loaded) { form.pending = true; form.mode = "edit"; $("form-title").textContent = "Editar expediente"; return; }
  form.pending = false;
  const j = state.jugadores.find((x) => x.id === id);
  if (!j) { toast("error", MSG.missing); form.dirtyBase = null; go("#"); return; }
  Object.assign(form, { mode: "edit", id, step: 1, maxStep: 4, saving: false, userId: j.userId, expectedMs: j.updatedAtMs, prefill: null, foto: undefined, fotoOriginal: null });
  resetForm();
  const name = nombreCompleto(j);
  $("form-title").textContent = "Editar expediente"; $("form-crumb").textContent = `Editar · ${name}`;
  $("form-subtitle").textContent = name;
  document.title = `Editar · ${name} · CanchaControl`;
  $("account-pick").hidden = true; $("account-empty").hidden = true; $("personal-fields").hidden = false;
  renderLockedAccount(j);
  $("f-nombres").value = j.nombres; $("f-apellidos").value = j.apellidos;
  $("f-tipodoc").value = j.tipoDocumento; $("f-numdoc").value = j.numeroDocumento;
  $("f-fecha").value = j.fechaNacimiento; updateEdadHelp();
  $("f-genero").value = GENEROS.includes(j.genero) ? j.genero : "";
  $("f-ciudadnac").value = j.ciudadNacimiento; $("f-obs").value = j.observaciones;
  $("f-telefono").value = j.telefono; $("f-correo").value = j.correoContacto; $("f-direccion").value = j.direccion; $("f-ciudad").value = j.ciudad;
  $("f-em-nombre").value = j.emergencia.nombre; $("f-em-parentesco").value = PARENTESCOS.includes(j.emergencia.parentesco) ? j.emergencia.parentesco : ""; $("f-em-telefono").value = j.emergencia.telefono;
  $("f-posicion").value = POSICIONES.includes(j.posicion) ? j.posicion : POSICIONES[0];
  $("f-camiseta").value = j.numeroCamiseta ?? "";
  $("f-estado").value = j.estado === ESTADO_JUG.INACTIVO ? ESTADO_JUG.INACTIVO : ESTADO_JUG.ACTIVO;
  $("f-ingreso").value = j.fechaIngreso; $("f-obsdep").value = j.observacionesDeportivas;
  getFoto(j.id).then((src) => { if (form.mode === "edit" && form.id === id && form.foto === undefined) { form.fotoOriginal = src; setPhotoPreview(src); } });
  goStep(1);
  form.dirtyBase = snapshot();
  setTimeout(() => $("f-nombres").focus(), 50);
}

function renderLockedAccount(j) {
  const box = $("account-locked");
  const u = state.users.get(j.userId);
  const av = el("span", "avatar", initials(u?.nombre || "?")); av.setAttribute("aria-hidden", "true");
  const who = el("div");
  who.append(el("p", "acc-locked__name", u ? u.nombre : "Cuenta no encontrada"), el("p", "acc-locked__mail", u ? u.email : ""),
    el("p", "acc-locked__note", "La cuenta vinculada no se puede cambiar desde Editar."));
  box.replaceChildren(av, who);
  box.hidden = false;
}

function refreshAccountList() {
  if (state.route.name !== "new" || form.mode !== "create") return;
  const list = $("acc-list");
  if (!state.usersLoaded || !state.loaded) {
    list.innerHTML = '<div class="select-list__state" role="status"><span class="spinner" aria-hidden="true"></span>Cargando cuentas…</div>';
    $("acc-search-wrap").hidden = true; setAccountMode("pick"); updateNav(); return;
  }
  if (state.usersError) {
    list.innerHTML = '<div class="select-list__state" role="alert">No fue posible cargar las cuentas. Intenta nuevamente.</div>';
    $("acc-search-wrap").hidden = true; setAccountMode("pick"); updateNav(); return;
  }
  const accounts = availableAccounts();
  if (!accounts.some((u) => u.uid === form.userId)) form.userId = null;
  if (!accounts.length) { setAccountMode("empty"); updateNav(); return; }
  setAccountMode("pick");
  $("acc-search-wrap").hidden = accounts.length < 6;
  const q = norm($("acc-search").value);
  const shown = accounts.filter((u) => !q || norm(u.nombre).includes(q) || norm(u.email).includes(q));
  if (!shown.length) { list.innerHTML = '<div class="select-list__state" role="status">Ninguna cuenta coincide con la búsqueda.</div>'; updateNav(); return; }
  list.replaceChildren(...shown.map((u) => {
    const l = el("label", "select-opt");
    const r = document.createElement("input"); r.type = "radio"; r.name = "account"; r.value = u.uid; // internamente: UID
    r.checked = u.uid === form.userId;
    r.addEventListener("change", () => onAccountChange(u));
    const av = el("span", "avatar", initials(u.nombre)); av.setAttribute("aria-hidden", "true");
    const who = el("span");
    who.append(el("p", "select-opt__name", u.nombre), el("p", "select-opt__sub", u.email));
    l.append(r, av, who);
    return l;
  }));
  updateNav();
}
function setAccountMode(mode) {
  if (form.mode !== "create") return;
  $("account-pick").hidden = mode !== "pick";
  $("account-empty").hidden = mode !== "empty";
  $("personal-fields").hidden = mode === "empty";
}

function splitNombre(full) {
  const p = cleanText(full).split(" ").filter(Boolean);
  if (p.length <= 1) return { n: p[0] ?? "", a: "" };
  if (p.length === 2) return { n: p[0], a: p[1] };
  if (p.length === 3) return { n: p[0], a: `${p[1]} ${p[2]}` };
  return { n: p.slice(0, 2).join(" "), a: p.slice(2).join(" ") };
}
function onAccountChange(u) {
  form.userId = u.uid;
  clearErr("account");
  const n = $("f-nombres"), a = $("f-apellidos");
  const untouched = (!n.value && !a.value) || (form.prefill && n.value === form.prefill.n && a.value === form.prefill.a);
  if (untouched) {
    form.prefill = splitNombre(u.nombre);
    n.value = form.prefill.n; a.value = form.prefill.a;
    $("prefill-note").hidden = false;
  }
}
function updateEdadHelp() {
  const v = $("f-fecha").value, n = edad(v);
  $("f-fecha-help").textContent = n !== null && n >= 0 && v <= todayISO() ? `Edad: ${n} ${n === 1 ? "año" : "años"}` : "";
}

/* ---------- Foto ---------- */
function setPhotoPreview(src) {
  const box = $("photo-preview");
  box.querySelector("img")?.remove();
  box.classList.toggle("has-photo", !!src);
  if (src) { const img = new Image(); img.alt = ""; img.src = src; box.append(img); }
  $("photo-btn-label").textContent = src ? "Cambiar foto" : "Subir foto";
  $("photo-remove").hidden = !src;
}
async function onPhotoPick(e) {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  clearErr("foto");
  try {
    const data = await prepararFoto(file);
    form.foto = data; setPhotoPreview(data);
  } catch (err) {
    setErr("foto", friendlyJugadorError(err));
  }
}
function onPhotoRemove() {
  form.foto = form.mode === "edit" ? (form.fotoOriginal ? null : undefined) : null;
  setPhotoPreview(null); clearErr("foto");
}
const currentPhoto = () => (form.foto === undefined ? form.fotoOriginal : form.foto);

/* ---------- Pasos ---------- */
const CHECK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5 12.5 10 17.5 19 7.5"/></svg>';
function goStep(n) {
  form.step = n;
  form.maxStep = Math.max(form.maxStep, n);
  document.querySelectorAll("#jug-form .step").forEach((s) => { s.hidden = Number(s.dataset.step) !== n; });
  document.querySelectorAll("#steps .wizard__item").forEach((li) => {
    const b = li.querySelector(".wizard__btn"), k = Number(b.dataset.goto);
    li.classList.toggle("is-current", k === n);
    li.classList.toggle("is-done", k < n);
    b.querySelector(".wizard__dot").innerHTML = k < n ? CHECK : String(k);
    if (k === n) b.setAttribute("aria-current", "step"); else b.removeAttribute("aria-current");
    b.setAttribute("aria-label", `Paso ${k}: ${STEP_LABEL[k]}${k < n ? " (completado)" : ""}`);
    b.disabled = form.saving || k > form.maxStep;
  });
  if (n === 4) renderConfirm();
  $("form-alert").hidden = true;
  updateNav();
}

function updateNav() {
  const back = $("back-btn"), next = $("next-btn");
  back.innerHTML = form.step === 1 ? "Cancelar" : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="11 6 5 12 11 18"/></svg><span>Volver</span>';
  const arrow = '<svg class="btn-arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="13 6 19 12 13 18"/></svg>';
  if (!form.saving) next.innerHTML = form.step < 4 ? `<span class="btn-label">Siguiente</span>${arrow}` : `<span class="btn-label">${form.mode === "edit" ? "Guardar cambios" : "Guardar jugador"}</span>`;
  const noAccounts = form.mode === "create" && !$("account-empty").hidden;
  next.disabled = form.saving || (noAccounts && form.step === 1);
  back.disabled = form.saving;
}

const PHONE_RE = /^[+\d\s()-]+$/;
const validPhone = (v) => PHONE_RE.test(v) && (v.match(/\d/g) || []).length >= 7 && (v.match(/\d/g) || []).length <= 15;
const asInt = (v) => (/^\d+$/.test(String(v).trim()) ? parseInt(v, 10) : NaN);

/** Problemas del paso: [{ field, msg, missing }] (y los marca en pantalla). */
function checkStep(n) {
  const out = [];
  const bad = (f, msg, missing = false) => { setErr(f, msg); out.push({ field: f, msg, missing }); };
  if (n === 1) {
    ["account", "nombres", "apellidos", "tipodoc", "numdoc", "fecha", "genero"].forEach(clearErr);
    if (form.mode === "create" && !form.userId) bad("account", "Selecciona la cuenta de acceso del jugador.", true);
    const nom = cleanText($("f-nombres").value), ape = cleanText($("f-apellidos").value);
    if (!nom) bad("nombres", "Ingresa los nombres.", true); else if (nom.length < 2) bad("nombres", "El nombre es demasiado corto.");
    if (!ape) bad("apellidos", "Ingresa los apellidos.", true); else if (ape.length < 2) bad("apellidos", "El apellido es demasiado corto.");
    const tipo = $("f-tipodoc").value;
    if (!TIPO_DOC_LABEL[tipo]) bad("tipodoc", "Selecciona el tipo de documento.", true);
    const raw = $("f-numdoc").value, dn = normalizeDocumento(raw);
    if (!cleanText(raw)) bad("numdoc", "Ingresa el número de documento.", true);
    else if (dn.length < LIMITS.DOC_MIN || dn.length > LIMITS.DOC_MAX) bad("numdoc", `Debe tener entre ${LIMITS.DOC_MIN} y ${LIMITS.DOC_MAX} caracteres.`);
    else if (["RC", "TI", "CC"].includes(tipo) && !/^\d+$/.test(dn)) bad("numdoc", "Este tipo de documento solo admite números.");
    else if (state.jugadores.some((j) => j.documentoNormalizado === dn && j.id !== form.id)) bad("numdoc", MSG.dupDoc);
    const f = $("f-fecha").value;
    if (!f) bad("fecha", "Ingresa la fecha de nacimiento.", true);
    else if (!parseFecha(f)) bad("fecha", "Ingresa una fecha válida.");
    else if (f > todayISO()) bad("fecha", "La fecha de nacimiento no puede ser futura.");
    else if (Number(f.slice(0, 4)) < LIMITS.ANIO_MIN) bad("fecha", `La fecha debe ser posterior a ${LIMITS.ANIO_MIN}.`);
    if (!GENEROS.includes($("f-genero").value)) bad("genero", "Selecciona el género.", true);
  }
  if (n === 2) {
    ["telefono", "correo", "em-nombre", "em-parentesco", "em-telefono"].forEach(clearErr);
    const t = cleanText($("f-telefono").value), c = cleanText($("f-correo").value);
    if (t && !validPhone(t)) bad("telefono", "Ingresa un teléfono válido (7 a 15 dígitos).");
    if (c && !isValidEmail(c)) bad("correo", "Ingresa un correo válido.");
    const en = cleanText($("f-em-nombre").value), et = cleanText($("f-em-telefono").value);
    if (!en) bad("em-nombre", "Ingresa el nombre del contacto.", true); else if (en.length < 2) bad("em-nombre", "El nombre es demasiado corto.");
    if (!PARENTESCOS.includes($("f-em-parentesco").value)) bad("em-parentesco", "Selecciona el parentesco.", true);
    if (!et) bad("em-telefono", "Ingresa el teléfono de emergencia.", true); else if (!validPhone(et)) bad("em-telefono", "Ingresa un teléfono válido (7 a 15 dígitos).");
  }
  if (n === 3) {
    ["camiseta", "ingreso"].forEach(clearErr);
    const c = $("f-camiseta").value;
    if (c !== "" && !(asInt(c) >= 0 && asInt(c) <= 99)) bad("camiseta", "Usa un número entero entre 0 y 99.");
    const fi = $("f-ingreso").value;
    if (fi && !parseFecha(fi)) bad("ingreso", "Ingresa una fecha válida.");
    else if (fi && fi > todayISO()) bad("ingreso", "La fecha de ingreso no puede ser futura.");
    else if (fi && $("f-fecha").value && fi < $("f-fecha").value) bad("ingreso", "No puede ser anterior a la fecha de nacimiento.");
  }
  return out;
}

/* Ventana "Faltan campos obligatorios" / "Revisa la información" */
let validFocus = null;
function showProblems(problems) {
  const allMissing = problems.every((p) => p.missing);
  $("valid-title").textContent = allMissing ? "Faltan campos obligatorios" : "Revisa la información";
  $("valid-text").textContent = allMissing ? "Por favor completa la siguiente información:" : "Corrige lo siguiente para continuar:";
  $("valid-list").replaceChildren(...problems.map((p) => el("li", "", p.missing ? FIELD_LABEL[p.field] : `${FIELD_LABEL[p.field]}: ${p.msg}`)));
  validFocus = problems[0]?.field;
  openModal("valid-modal", "#valid-ok");
}

function collect() {
  const c = $("f-camiseta").value;
  return {
    nombres: $("f-nombres").value, apellidos: $("f-apellidos").value,
    tipoDocumento: $("f-tipodoc").value, numeroDocumento: $("f-numdoc").value,
    fechaNacimiento: $("f-fecha").value, genero: $("f-genero").value,
    ciudadNacimiento: $("f-ciudadnac").value, observaciones: $("f-obs").value,
    telefono: $("f-telefono").value, correoContacto: $("f-correo").value, direccion: $("f-direccion").value, ciudad: $("f-ciudad").value,
    emergencia: { nombre: $("f-em-nombre").value, parentesco: $("f-em-parentesco").value, telefono: $("f-em-telefono").value },
    posicion: $("f-posicion").value,
    numeroCamiseta: c === "" ? null : asInt(c),
    estado: $("f-estado").value,
    fechaIngreso: $("f-ingreso").value,
    observacionesDeportivas: $("f-obsdep").value,
  };
}
const snapshot = () => JSON.stringify({ d: collect(), u: form.userId, f: form.foto ?? null });
const isDirty = () => form.dirtyBase !== null && snapshot() !== form.dirtyBase;

/* Paso 4: resumen */
function renderConfirm() {
  if (form.step !== 4 || $("view-form").hidden) return;
  const d = collect();
  const u = state.users.get(form.userId);
  const section = (title, step, rows, lead) => {
    const s = el("section", "confirm-sec");
    const h = el("div", "confirm-sec__head");
    h.append(el("h3", "confirm-sec__title", title));
    const b = el("button", "confirm-sec__edit", "Editar"); b.type = "button";
    b.setAttribute("aria-label", `Editar ${title.toLowerCase()}`);
    b.addEventListener("click", () => goStep(step));
    h.append(b); s.append(h);
    if (lead) s.append(lead);
    const dl = el("dl");
    rows.forEach(([k, v]) => { dl.append(el("dt", "", k), el("dd", "", v || "—")); });
    s.append(dl);
    return s;
  };
  const photo = el("div", "confirm-sec--photo");
  const p = el("span", "pic pic--md", initials(`${d.nombres} ${d.apellidos}`));
  const src = currentPhoto(); if (src) { const img = new Image(); img.alt = ""; img.src = src; p.append(img); }
  const pw = el("div"); pw.append(el("strong", "", cleanText(`${d.nombres} ${d.apellidos}`)), el("span", "cell-sub", u ? `Cuenta: ${u.email}` : ""));
  photo.append(p, pw);
  $("confirm-grid").replaceChildren(
    section("Datos personales", 1, [
      ["Documento", `${TIPO_DOC_LABEL[d.tipoDocumento] ?? ""} ${cleanText(d.numeroDocumento)}`],
      ["Nacimiento", d.fechaNacimiento ? `${fechaLarga(d.fechaNacimiento)} (${edadLabel(d.fechaNacimiento)})` : ""],
      ["Género", d.genero], ["Ciudad de nacimiento", cleanText(d.ciudadNacimiento)], ["Observaciones", d.observaciones.trim()],
    ], photo),
    section("Contacto y emergencia", 2, [
      ["Teléfono", cleanText(d.telefono)], ["Correo", cleanText(d.correoContacto).toLowerCase()],
      ["Dirección", [cleanText(d.direccion), cleanText(d.ciudad)].filter(Boolean).join(", ")],
      ["Emergencia", [cleanText(d.emergencia.nombre), d.emergencia.parentesco].filter(Boolean).join(" · ")],
      ["Tel. emergencia", cleanText(d.emergencia.telefono)],
    ]),
    section("Información deportiva", 3, [
      ["Posición", d.posicion], ["Camiseta", d.numeroCamiseta === null ? "" : String(d.numeroCamiseta)],
      ["Estado", d.estado], ["Fecha de ingreso", d.fechaIngreso ? fechaLarga(d.fechaIngreso) : ""],
      ["Observaciones", d.observacionesDeportivas.trim()],
    ]),
  );
}

function setSaving(on) {
  form.saving = on;
  if (on) $("next-btn").innerHTML = '<span class="spinner" aria-hidden="true"></span><span class="btn-label">Guardando…</span>';
  goStep(form.step);
}

async function onNext() {
  if (form.saving) return;
  if (form.step < 4) {
    const probs = checkStep(form.step);
    if (probs.length) return showProblems(probs);
    goStep(form.step + 1);
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  // Paso 4: revalidar todo antes de guardar
  for (let s = 1; s <= 3; s++) {
    const probs = checkStep(s);
    if (probs.length) { goStep(s); checkStep(s); return showProblems(probs); }
  }
  await save();
}

let lastCreated = null;
async function save() {
  const input = collect();
  if (form.mode === "edit" && !isDirty()) { toast("info", "No hay cambios para guardar."); form.dirtyBase = null; return go(`#/jugador/${form.id}`); }
  setSaving(true);
  try {
    if (form.mode === "create") {
      const id = await createJugador(form.userId, input, state.me.uid, form.foto || null);
      setSaving(false);
      form.dirtyBase = null;
      lastCreated = id;
      $("done-text").textContent = `El expediente de ${cleanText(`${input.nombres} ${input.apellidos}`)} ha sido creado correctamente.`;
      openModal("done-modal", "#done-view");
    } else {
      await updateJugador(form.id, input, { expectedUpdatedAtMs: form.expectedMs, actorUid: state.me.uid, foto: form.foto });
      setSaving(false);
      form.dirtyBase = null;
      toast("success", "Expediente actualizado correctamente.");
      go(`#/jugador/${form.id}`);
    }
  } catch (err) {
    console.error("[CanchaControl] Guardar expediente:", err?.code || err);
    setSaving(false);
    const msg = friendlyJugadorError(err);
    if (err?.code === "dup-doc") { goStep(1); setErr("numdoc", msg); }
    else if (String(err?.code || "").startsWith("account-")) { goStep(1); setErr("account", msg); form.userId = null; refreshAccountList(); }
    const a = $("form-alert"); a.textContent = msg; a.hidden = false;
    toast("error", msg);
  }
}

function onBack() {
  if (form.saving) return;
  if (form.step > 1) { goStep(form.step - 1); return; }
  go(form.mode === "edit" ? `#/jugador/${form.id}` : "#");
}

/* ==========================================================
   Modales
   ========================================================== */
let modalReturn = null;
function openModal(id, focusSel) {
  modalReturn = document.activeElement;
  const m = $(id);
  m.classList.add("is-open"); m.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  setTimeout(() => m.querySelector(focusSel)?.focus(), 60);
}
function closeModal(id, { restore = true } = {}) {
  const m = $(id);
  if (!m.classList.contains("is-open")) return;
  m.classList.remove("is-open"); m.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  if (restore) modalReturn?.focus?.();
}
let discardResolve = null;
function askDiscard() {
  openModal("discard-modal", "[data-cancel].btn");
  return new Promise((r) => { discardResolve = r; });
}
function closeDiscard(ok) { closeModal("discard-modal", { restore: !ok }); discardResolve?.(ok); discardResolve = null; }
function closeValid() {
  closeModal("valid-modal", { restore: false });
  if (validFocus) (validFocus === "account" ? $("acc-list").querySelector("input") : $(`f-${validFocus}`))?.focus?.();
}

/* ==========================================================
   Eventos
   ========================================================== */
function wireUi() {
  $("search").addEventListener("input", debounce(() => { state.q = $("search").value; state.page = 1; renderList(); }, 300));
  // HU-010: tarjetas como filtros (reemplazan el desplegable de estado y la opción "Sin categoría")
  jugCards = initFilterCards($("jug-kpis"), (v) => { state.estado = v; state.page = 1; renderList(); });

  $("next-btn").addEventListener("click", onNext);
  $("back-btn").addEventListener("click", onBack);
  $("jug-form").addEventListener("submit", (e) => { e.preventDefault(); onNext(); });
  document.querySelectorAll("#steps .wizard__btn").forEach((b) => b.addEventListener("click", () => {
    const k = Number(b.dataset.goto);
    if (k === form.step || form.saving) return;
    if (k > form.step) {
      for (let s = form.step; s < k; s++) {
        const probs = checkStep(s);
        if (probs.length) { if (s !== form.step) { goStep(s); checkStep(s); } return showProblems(probs); }
      }
    }
    goStep(k);
  }));
  $("acc-search").addEventListener("input", debounce(refreshAccountList, 250));
  $("f-fecha").addEventListener("input", () => { clearErr("fecha"); updateEdadHelp(); });
  ["nombres", "apellidos", "tipodoc", "numdoc", "genero", "telefono", "correo", "em-nombre", "em-parentesco", "em-telefono", "camiseta", "ingreso"]
    .forEach((f) => $(`f-${f}`).addEventListener("input", () => clearErr(f)));
  $("f-foto").addEventListener("change", onPhotoPick);
  $("photo-remove").addEventListener("click", onPhotoRemove);

  $("valid-ok").addEventListener("click", closeValid);
  $("valid-modal").querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeValid));
  $("done-view").addEventListener("click", () => { closeModal("done-modal", { restore: false }); go(`#/jugador/${lastCreated}`); });
  $("done-again").addEventListener("click", () => { closeModal("done-modal", { restore: false }); startCreate(); });
  $("discard-ok").addEventListener("click", () => closeDiscard(true));
  // HU-008
  $("filter-cat").addEventListener("change", (e) => { state.cat = e.target.value; state.page = 1; renderList(); });
  $("cat-form").addEventListener("submit", onCatSubmit);
  $("cat-drawer").querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeCatDrawer));
  $("cat-search").addEventListener("input", debounce(refreshCatList, 250));
  $("catconf-ok").addEventListener("click", () => closeCatConf(true));
  $("catconf-modal").querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", () => closeCatConf(false)));
  $("discard-modal").querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", () => closeDiscard(false)));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if ($("valid-modal").classList.contains("is-open")) { e.preventDefault(); closeValid(); }
      else if ($("discard-modal").classList.contains("is-open")) { e.preventDefault(); closeDiscard(false); }
      else if ($("catconf-modal").classList.contains("is-open")) { e.preventDefault(); closeCatConf(false); }
      else if ($("cat-drawer").classList.contains("is-open")) { e.preventDefault(); closeCatDrawer(); }
      return;
    }
    if (e.key !== "Tab") return;
    const open = document.querySelector(".modal.is-open .modal__dialog");
    if (!open) return;
    const f = [...open.querySelectorAll("button, a[href]")].filter((x) => !x.disabled && x.offsetParent !== null);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  });
  window.addEventListener("beforeunload", (e) => {
    if (["new", "edit"].includes(state.route.name) && isDirty() && !form.saving) { e.preventDefault(); e.returnValue = ""; }
  });
}
