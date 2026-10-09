/* ==========================================================
   CanchaControl — Categorías (HU-004 · HU-005 · HU-006)
   Una sola pantalla, dos vistas según el ALCANCE del rol (permissions.js):
     Administrador → SCOPE.ALL      → todas las categorías + acciones HU-004/005
     Entrenador    → SCOPE.ASSIGNED → SOLO las suyas, consultadas en Firestore con
                     where("entrenadorId","==", auth.currentUser.uid). Solo lectura.
   Seguridad real: authGuard + firestore.rules. Aquí solo hay UI.
   ========================================================== */
import { protectPage } from "./authGuard.js";
import { can, ACTION, readScope, SCOPE } from "./permissions.js";
import { auth } from "./auth.js";
import { contarJugadores, subscribeNomina, nombreCompleto } from "./jugadores-data.js";
import { mountShell } from "./shell.js";
import { toast, initFilterCards } from "./ui.js";
import { subscribeUsers } from "./users.js";
import { initials } from "./shell.js";
import {
  TIPO, TIPO_LABEL, ESTADO_CAT, LIMITS, MSG,
  normalizeNombre, normalizeCodigo, cleanNombre,
  periodOptions, periodoLabel, currentPeriodo, PERIODO_RE,
  subscribeCategorias, subscribeMisCategorias, createCategoria, rangoLabel, friendlyCategoriaError,
  assignEntrenador, friendlyAssignError,
} from "./categorias-data.js";

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 10;

const state = {
  me: null,
  canCreate: false,
  cats: [],
  loaded: false,
  users: new Map(),     // uid → usuario (solo Administrador puede leerlos; reglas)
  usersLoaded: false,
  usersError: false,
  q: "", periodo: "", estado: "", coach: "",
  page: 1,
  saving: false,
  mode: "create", // create | detail
  view: null,     // "admin" (todas) | "coach" (solo las suyas)
  detailId: null,
};

const COPY = {
  admin: { title: "Categorías deportivas", subtitle: "Organiza y administra las categorías de CanchaControl.", search: "Buscar categoría, código o período..." },
  coach: { title: "Mis categorías", subtitle: "Consulta los grupos deportivos que tienes asignados.", search: "Buscar en mis categorías..." },
};

/* Columnas por vista. Entrenador: sin columna de entrenador (es él) ni acciones administrativas. */
const COLUMNS = {
  admin: [["name", "Nombre"], ["code", "Código"], ["tipo", "Tipo"], ["rango", "Edad / Año nacimiento"], ["periodo", "Período lectivo"], ["coach", "Entrenador"], ["players", "Jugadores"], ["estado", "Estado"], ["actions", "Acciones"]],
  coach: [["name", "Nombre"], ["code", "Código"], ["tipo", "Tipo"], ["rango", "Edad / Año nacimiento"], ["periodo", "Período lectivo"], ["estado", "Estado"], ["actions", "Detalle"]],
};

protectPage({
  page: "categorias",
  onReady(profile) {
    state.me = profile;
    // Identidad = Firebase Authentication (nunca URL, localStorage ni inputs)
    const uid = auth.currentUser?.uid;
    const scope = readScope(profile.rol, "categorias");
    state.view = scope === SCOPE.ALL ? "admin" : scope === SCOPE.ASSIGNED ? "coach" : null;

    mountShell(profile, "categorias");
    if (!uid || uid !== profile.uid || !state.view) {
      // Defensa extra: authGuard ya lo impide. Sin vista válida no se consulta nada.
      setupView("coach");
      return showLoadError({ code: "permission-denied" });
    }
    state.canCreate = can(profile, "categorias", ACTION.CREATE);
    state.canAssign = can(profile, "categorias", ACTION.UPDATE);
    setupView(state.view);   // títulos, KPI, columnas y filtros ANTES de pedir datos
    wireUi();

    const onCats = (list) => { state.cats = list; state.loaded = true; refreshPeriodFilter(); render(); };
    const onCatsError = (err) => { console.error("[CanchaControl] Categorías:", err?.code || err); state.loaded = true; showLoadError(err); };

    if (state.view === "admin") {
      // Entrenadores = usuarios reales (users). Solo el Administrador puede leerlos (reglas).
      subscribeUsers(
        (list) => {
          state.users = new Map(list.map((u) => [u.uid, u]));
          state.usersLoaded = true; state.usersError = false;
          refreshCoachFilter(); render(); refreshAssignList();
        },
        (err) => {
          console.error("[CanchaControl] Usuarios para asignación:", err?.code || err);
          state.usersLoaded = true; state.usersError = true; render(); refreshAssignList();
        }
      );
      subscribeCategorias(onCats, onCatsError);
    } else {
      // Entrenador: Firestore devuelve SOLO sus categorías (consulta filtrada por su UID).
      // En vivo: si el Administrador le quita o le asigna una, la lista cambia sola.
      subscribeMisCategorias(uid, onCats, onCatsError);
    }
  },
});

function setupView(view) {
  const c = COPY[view];
  $("page-title").textContent = c.title;
  $("page-subtitle").textContent = c.subtitle;
  document.title = `${c.title} · CanchaControl`;
  $("search").placeholder = c.search;
  $("new-cat-btn").hidden = !(view === "admin" && state.canCreate);
  $("kpi-mis-label").textContent = view === "coach" ? "Mis categorías" : "Total categorías";
  $("kpi-card-sin").hidden = view !== "admin";
  $("filter-coach").hidden = view !== "admin";
  $("filter-coach-label").hidden = view !== "admin";
  $("cat-table").classList.toggle("cat-table--coach", view === "coach");
  $("cat-head-row").replaceChildren(...COLUMNS[view].map(([key, label]) => {
    const th = document.createElement("th");
    th.scope = "col"; th.textContent = label;
    if (key === "actions") th.className = "col-actions";
    if (key === "players") th.className = "col-num";
    return th;
  }));
}

function showLoadError(err) {
  $("cat-body").replaceChildren();
  $("pagination").hidden = true;
  ["kpi-mis", "kpi-activas", "kpi-inactivas", "kpi-periodo", "kpi-sin"].forEach((id) => { $(id).textContent = "—"; });
  const code = err?.code;
  if (code === "permission-denied") {
    $("cat-toolbar").hidden = true;
    showEmpty("No tienes permisos para consultar estas categorías.", "Si crees que es un error, comunícate con el Administrador.", null);
  } else {
    showEmpty("No fue posible cargar las categorías.",
      navigator.onLine ? "El servicio no respondió. Intenta nuevamente en unos segundos." : "Parece que no tienes conexión a internet. Revisa tu conexión e intenta nuevamente.",
      "Reintentar", () => location.reload());
  }
}

/* ==========================================================
   Render
   ========================================================== */
const norm = (s) => String(s ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();

function matches(c) {
  if (state.periodo && c.periodoLectivo !== state.periodo) return false;
  // Tarjeta activa (HU-010): Activa / Inactiva / Período actual / Sin entrenador
  if ((state.estado === "Activa" || state.estado === "Inactiva") && c.estado !== state.estado) return false;
  if (state.estado === "__actual" && c.periodoLectivo !== currentPeriodo()) return false;
  if (state.estado === "__sin" && c.entrenadorId) return false;
  if (state.coach === "__none" && c.entrenadorId) return false;
  if (state.coach && state.coach !== "__none" && c.entrenadorId !== state.coach) return false;
  if (state.q) {
    const q = norm(state.q);
    const hay = [c.nombre, c.codigoGrupo, c.periodoLectivo, periodoLabel(c.periodoLectivo)].map(norm);
    if (!hay.some((h) => h.includes(q))) return false;
  }
  return true;
}

function render() {
  const all = state.cats;
  const actual = currentPeriodo();
  $("kpi-activas").textContent = String(all.filter((c) => c.estado === ESTADO_CAT.ACTIVA).length);
  $("kpi-inactivas").textContent = String(all.filter((c) => c.estado === ESTADO_CAT.INACTIVA).length);
  $("kpi-periodo").textContent = String(all.filter((c) => c.periodoLectivo === actual).length);
  $("kpi-periodo-label").textContent = periodoLabel(actual);
  $("kpi-sin").textContent = String(all.filter((c) => !c.entrenadorId).length);
  $("kpi-mis").textContent = String(all.length);   // Entrenador: all YA son solo las suyas
  syncDetail();

  const rows = all.filter(matches);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (state.page > pages) state.page = pages;
  const start = (state.page - 1) * PAGE_SIZE;
  const visible = rows.slice(start, start + PAGE_SIZE);

  $("cat-body").replaceChildren(...visible.map(rowFor));
  $("cat-table").hidden = rows.length === 0;

  $("cat-toolbar").hidden = state.view === "coach" && all.length === 0;
  if (all.length === 0) {
    if (state.view === "coach") showEmpty("Aún no tienes categorías asignadas.", "Cuando un administrador te asigne un grupo, aparecerá aquí.", null);
    else if (state.canCreate) showEmpty("Aún no hay categorías registradas.", "Crea la primera categoría para organizar a tus jugadores.", "+ Crear primera categoría", openCreate);
    else showEmpty("Aún no hay categorías registradas.", "Cuando el Administrador las cree, aparecerán aquí.", null);
    $("pagination").hidden = true;
    return;
  }
  if (rows.length === 0) {
    showEmpty("No encontramos categorías con estos criterios.", "Prueba con otro nombre o código, o cambia los filtros.", "Limpiar filtros", clearFilters, "btn-outline");
    $("pagination").hidden = true;
    return;
  }
  $("empty-state").hidden = true;
  renderPagination(rows.length, start, visible.length, pages);
}

function showEmpty(title, text, actionLabel, onAction, variant = "btn-primary") {
  $("empty-title").textContent = title;
  $("empty-text").textContent = text;
  const btn = $("empty-action");
  btn.hidden = !actionLabel;
  if (actionLabel) {
    btn.textContent = actionLabel;
    btn.className = `btn ${variant} empty__btn`;
    btn.onclick = onAction;
  }
  $("empty-state").hidden = false;
  $("cat-table").hidden = true;
}

function renderPagination(total, start, shown, pages) {
  $("pagination").hidden = false;
  $("page-info").textContent = `Mostrando ${start + 1} a ${start + shown} de ${total} ${total === 1 ? "categoría" : "categorías"}`;
  const nav = $("page-nav");
  const mk = (label, page, { disabled = false, current = false, aria } = {}) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "page-btn"; b.innerHTML = label;
    if (aria) b.setAttribute("aria-label", aria);
    if (current) b.setAttribute("aria-current", "page");
    b.disabled = disabled;
    b.addEventListener("click", () => { state.page = page; render(); });
    return b;
  };
  const arrow = (d) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><polyline points="${d}"/></svg>`;
  const items = [mk(arrow("15 18 9 12 15 6"), state.page - 1, { disabled: state.page === 1, aria: "Página anterior" })];
  for (let p = 1; p <= pages; p++) items.push(mk(String(p), p, { current: p === state.page, aria: `Página ${p}` }));
  items.push(mk(arrow("9 18 15 12 9 6"), state.page + 1, { disabled: state.page === pages, aria: "Página siguiente" }));
  nav.replaceChildren(...items);
}

function hashIdx(s, n) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % n; }
const TILE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="7.5" r="3.2"/><circle cx="16.5" cy="8.5" r="2.5"/><path d="M2.5 19.5c0-3.4 2.9-5.6 6.5-5.6s6.5 2.2 6.5 5.6v.5h-13v-.5Z"/><path d="M15.4 13.9c3-.2 6.1 1.4 6.1 4.6v1.5h-4.2v-.5c0-2.2-.7-4.1-1.9-5.6Z"/></svg>';

function td(cls, text) {
  const t = document.createElement("td");
  if (cls) t.className = cls;
  if (text !== undefined) t.textContent = text;
  return t;
}

function rowFor(c) {
  const tr = document.createElement("tr");
  tr.dataset.id = c.id;

  const t1 = td("c-name");
  const ent = document.createElement("div"); ent.className = "row-entity";
  const tile = document.createElement("span"); tile.className = `row-tile tile-${hashIdx(c.nombreNormalizado || c.nombre, 8)}`; tile.innerHTML = TILE_ICON;
  const name = document.createElement("span"); name.className = "cell-strong"; name.textContent = c.nombre;
  ent.append(tile, name); t1.append(ent);

  const activa = c.estado === ESTADO_CAT.ACTIVA;
  const tEstado = td("c-estado");
  const b = document.createElement("span"); b.className = `badge ${activa ? "badge--success" : "badge--danger"}`; b.textContent = activa ? "Activa" : "Inactiva";
  tEstado.append(b);

  // Acciones: solo funciones terminadas. Entrenador: únicamente "Ver detalle" (lectura).
  const tAct = td("col-actions");
  const view = document.createElement("button");
  view.type = "button"; view.className = "icon-action";
  view.setAttribute("aria-label", `Ver detalle de ${c.nombre}`); view.title = "Ver detalle";
  view.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
  view.addEventListener("click", () => openDetail(c));
  tAct.append(view);
  if (state.view === "admin" && state.canAssign) {
    const asg = document.createElement("button");
    asg.type = "button"; asg.className = "icon-action icon-action--assign";
    const label = c.entrenadorId ? "Cambiar entrenador" : "Asignar entrenador";
    asg.setAttribute("aria-label", `${label} de ${c.nombre}`); asg.title = label;
    asg.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="8" r="3.5"/><path d="M3.5 20v-1a6 6 0 0 1 9.5-4.9"/><line x1="18" y1="14" x2="18" y2="20"/><line x1="15" y1="17" x2="21" y2="17"/></svg>';
    asg.addEventListener("click", () => openAssign(c));
    tAct.append(asg);
  }
  tAct.style.gap = ".4rem";

  const cells = {
    name: t1,
    code: td("c-code", c.codigoGrupo),
    tipo: td("c-tipo", TIPO_LABEL[c.tipoConfiguracion] ?? "—"),
    rango: td("c-rango", rangoLabel(c)),
    periodo: td("c-periodo cell-muted", periodoLabel(c.periodoLectivo)),
    coach: state.view === "admin" ? coachCell(c) : null,
    players: state.view === "admin" ? playersCell(c) : null,
    estado: tEstado,
    actions: tAct,
  };
  if (cells.coach) cells.coach.classList.add("c-coach");
  const meta = td("cat-meta", `${c.codigoGrupo} · ${TIPO_LABEL[c.tipoConfiguracion] ?? "—"} · ${periodoLabel(c.periodoLectivo)}`);
  tr.append(...COLUMNS[state.view].map(([key]) => cells[key]), meta);
  return tr;
}

/* ---------- Jugadores por categoría (HU-008) ----------
   Conteo REAL: agregación count() en el servidor sobre jugadores con
   categoriaId == id (no descarga expedientes ni usa contadores guardados).
   Solo para el Administrador y solo para las filas visibles; se guarda en
   memoria mientras la página está abierta. */
const counts = new Map();   // categoriaId → número | "loading" | "error"
function playersCount(c) {
  if (state.view !== "admin") return null;
  if (!counts.has(c.id)) {
    counts.set(c.id, "loading");
    contarJugadores(c.id)
      .then((n) => { counts.set(c.id, n); paintCount(c.id); })
      .catch((err) => { console.error("[CanchaControl] Conteo:", err?.code || err); counts.set(c.id, "error"); paintCount(c.id); });
  }
  return counts.get(c.id);
}
function countText(v) { return typeof v === "number" ? String(v) : v === "loading" ? "…" : "—"; }
function playersCell(c) {
  const v = playersCount(c);
  const cell = td("c-players col-num", countText(v));
  if (v === "error") { cell.title = "No fue posible contar los jugadores"; cell.classList.add("cell-muted"); }
  return cell;
}
function paintCount(id) {
  const cell = document.querySelector(`#cat-body tr[data-id="${CSS.escape(id)}"] td.c-players`);
  if (cell) cell.textContent = countText(counts.get(id));
}

/* ---------- Entrenador en la tabla ----------
   Nunca muestra UID, null ni undefined. Si el asignado quedó inactivo,
   cambió de rol o ya no existe, se SEÑALA (no se borra ni se reasigna). */
function coachInfo(uid) {
  if (!uid) return { kind: "none" };
  if (!state.usersLoaded) return { kind: "loading" };
  const u = state.users.get(uid);
  if (!u) return { kind: "missing" };
  if (u.rol !== "Entrenador") return { kind: "notcoach", user: u };
  if (u.estado !== "Activo") return { kind: "inactive", user: u };
  return { kind: "ok", user: u };
}

function coachCell(c) {
  const cell = td();
  const info = coachInfo(c.entrenadorId);
  if (info.kind === "none") { cell.append(Object.assign(document.createElement("span"), { className: "cell-unassigned", textContent: "Sin asignar" })); return cell; }
  if (info.kind === "loading") { cell.append(Object.assign(document.createElement("span"), { className: "skel", style: "width:90px" })); return cell; }
  const box = document.createElement("span"); box.className = "cell-person";
  const name = document.createElement("span"); name.className = "cell-person__name";
  const flag = document.createElement("span"); flag.className = "cell-person__flag";
  if (info.kind === "missing") { name.textContent = "Usuario no encontrado"; flag.textContent = "Reasignar"; }
  else {
    name.textContent = info.user.nombre || info.user.email;
    if (info.kind === "inactive") flag.textContent = "Entrenador inactivo";
    if (info.kind === "notcoach") flag.textContent = `Ya no es Entrenador (${info.user.rol})`;
  }
  box.append(name);
  if (flag.textContent) box.append(flag);
  cell.append(box);
  return cell;
}

function coachLabel(uid) {
  const info = coachInfo(uid);
  if (info.kind === "none") return "Sin asignar";
  if (info.kind === "missing") return "Usuario no encontrado";
  if (info.kind === "loading") return "Cargando…";
  const base = `${info.user.nombre} (${info.user.email})`;
  if (info.kind === "inactive") return `${base} · Entrenador inactivo`;
  if (info.kind === "notcoach") return `${base} · ya no es Entrenador`;
  return base;
}

function refreshCoachFilter() {
  const sel = $("filter-coach");
  const cur = sel.value;
  const coaches = [...state.users.values()].filter((u) => u.rol === "Entrenador")
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" }));
  sel.replaceChildren(
    new Option("Todos los entrenadores", ""),
    new Option("Sin asignar", "__none"),
    ...coaches.map((u) => new Option(u.estado === "Activo" ? u.nombre : `${u.nombre} (inactivo)`, u.uid))
  );
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : "";
  state.coach = sel.value;
}

/* ==========================================================
   Filtros y búsqueda
   ========================================================== */
function refreshPeriodFilter() {
  const sel = $("filter-periodo");
  const current = sel.value;
  const periods = [...new Set(state.cats.map((c) => c.periodoLectivo).filter(Boolean))].sort().reverse();
  sel.replaceChildren(new Option("Todos los períodos", ""), ...periods.map((p) => new Option(periodoLabel(p), p)));
  sel.value = periods.includes(current) ? current : "";
  state.periodo = sel.value;
}

let catCards = null;
function clearFilters() {
  state.q = state.periodo = state.estado = state.coach = "";
  $("search").value = ""; $("filter-periodo").value = ""; catCards?.set(""); $("filter-coach").value = "";
  state.page = 1; render(); $("search").focus();
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/* ==========================================================
   Drawer
   ========================================================== */
let returnFocus = null;

function openDrawer(mode) {
  state.mode = mode;
  returnFocus = document.activeElement;
  const isCreate = mode === "create";
  $("cat-form").hidden = !isCreate;
  $("form-foot").hidden = !isCreate;
  $("cat-detail").hidden = isCreate;
  $("detail-foot").hidden = isCreate;
  const d = $("cat-drawer");
  d.classList.add("is-open");
  d.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  $("app").inert = true;
  setTimeout(() => (isCreate ? $("f-nombre") : d.querySelector("#detail-foot .btn")).focus(), 60);
}

function closeDrawer() {
  if (state.saving) return;
  state.detailId = null;
  stopNomina?.(); stopNomina = null;
  const d = $("cat-drawer");
  d.classList.remove("is-open");
  d.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  $("app").inert = false;
  returnFocus?.focus?.();
}

function openCreate() {
  if (!state.canCreate) { toast("error", MSG.noPermission); return; }
  $("drawer-title").textContent = "Nueva categoría";
  $("drawer-subtitle").textContent = "Completa la información para crear una nueva categoría.";
  $("cat-form").reset();
  clearErrors();
  $("form-alert").hidden = true;
  fillPeriodSelect();
  setTipo(TIPO.EDAD);
  $("f-desc-count").textContent = `0/${LIMITS.DESC_MAX}`;
  openDrawer("create");
}

function fillPeriodSelect() {
  const sel = $("f-periodo");
  const opts = periodOptions(state.cats.map((c) => c.periodoLectivo));
  sel.replaceChildren(...opts.map((p) => new Option(periodoLabel(p), p)));
  sel.value = opts.includes(currentPeriodo()) ? currentPeriodo() : opts[opts.length - 1];
}

function openDetail(c) {
  state.detailId = c.id;
  $("drawer-title").textContent = c.nombre;
  $("drawer-subtitle").textContent = "Detalle de la categoría.";
  const rows = [
    ["Código de grupo", c.codigoGrupo],
    ["Período lectivo", periodoLabel(c.periodoLectivo)],
    ["Tipo de configuración", TIPO_LABEL[c.tipoConfiguracion] ?? "—"],
    [c.tipoConfiguracion === TIPO.EDAD ? "Rango de edad" : "Año(s) de nacimiento", rangoLabel(c)],
    ["Estado", c.estado],
    ["Entrenador principal", state.view === "coach" ? `${state.me.nombre} (tú)` : coachLabel(c.entrenadorId)],
    ["Descripción", c.descripcion || "—"],
  ];
  const dl = $("detail-list");
  dl.replaceChildren(...rows.flatMap(([k, v]) => {
    const wrap = document.createElement("div");
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    wrap.append(dt, dd);
    return [wrap];
  }));
  renderNomina(c);
  openDrawer("detail");
}

/* HU-008 — Nómina de la categoría (solo Administrador): consulta
   where("categoriaId","==", id). El Entrenador la tendrá en HU-009. */
let stopNomina = null;
function renderNomina(c) {
  stopNomina?.(); stopNomina = null;
  const box = $("detail-nomina");
  if (state.view !== "admin") { box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;
  const title = document.createElement("h3"); title.className = "nomina__title"; title.textContent = "Nómina";
  const list = document.createElement("ul"); list.className = "nomina__list";
  const status = Object.assign(document.createElement("p"), { className: "nomina__empty", textContent: "Cargando jugadores…" });
  box.replaceChildren(title, status);
  stopNomina = subscribeNomina(c.id, (players) => {
    counts.set(c.id, players.length); paintCount(c.id);
    title.textContent = `Nómina (${players.length})`;
    if (!players.length) { status.textContent = "Aún no hay jugadores vinculados a esta categoría."; box.replaceChildren(title, status); return; }
    list.replaceChildren(...players.map((p) => {
      const li = document.createElement("li");
      const a = document.createElement("a"); a.href = `jugadores.html#/jugador/${encodeURIComponent(p.id)}`; a.textContent = nombreCompleto(p);
      const doc = document.createElement("span"); doc.className = "nomina__doc"; doc.textContent = `${p.tipoDocumento} ${p.numeroDocumento}`;
      li.append(a, doc); return li;
    }));
    box.replaceChildren(title, list);
  }, (err) => {
    console.error("[CanchaControl] Nómina:", err?.code || err);
    status.textContent = "No fue posible cargar la nómina."; box.replaceChildren(title, status);
  });
}

/* Si la categoría abierta en detalle deja de estar autorizada (p. ej. el
   Administrador se la reasignó a otro entrenador), se cierra el detalle. */
function syncDetail() {
  if (!state.detailId || !$("cat-drawer").classList.contains("is-open")) return;
  if (!state.cats.some((x) => x.id === state.detailId)) {
    closeDrawer();
    toast("info", "Esta categoría ya no está disponible para ti.");
  }
}

/* ---------- Tipo de configuración ---------- */
function currentTipo() { return document.querySelector('input[name="tipo"]:checked')?.value ?? TIPO.EDAD; }

function setTipo(tipo) {
  document.querySelectorAll('input[name="tipo"]').forEach((r) => { r.checked = r.value === tipo; });
  const edad = tipo === TIPO.EDAD;
  $("group-edad").hidden = !edad;
  $("group-anio").hidden = edad;
  // Limpiar los campos del tipo que NO aplica: nunca se guardan valores incompatibles
  if (edad) { $("f-anio-ini").value = ""; $("f-anio-fin").value = ""; clearErr("anio-ini"); clearErr("anio-fin"); }
  else { $("f-edad-min").value = ""; $("f-edad-max").value = ""; clearErr("edad-min"); clearErr("edad-max"); }
  const y = new Date().getFullYear();
  $("f-anio-ini").min = $("f-anio-fin").min = String(LIMITS.ANIO_MIN);
  $("f-anio-ini").max = $("f-anio-fin").max = String(y);
}

/* ---------- Validación ---------- */
function setErr(f, msg) {
  const el = $(`f-${f}`);
  el.closest(".f-field").classList.add("has-error");
  el.setAttribute("aria-invalid", "true");
  $(`f-${f}-err`).textContent = msg;
}
function clearErr(f) {
  const el = $(`f-${f}`);
  el.closest(".f-field").classList.remove("has-error");
  el.setAttribute("aria-invalid", "false");
  $(`f-${f}-err`).textContent = "";
}
function clearErrors() { ["nombre", "codigo", "periodo", "edad-min", "edad-max", "anio-ini", "anio-fin"].forEach(clearErr); }

const asInt = (v) => (String(v).trim() !== "" && /^-?\d+$/.test(String(v).trim()) ? parseInt(v, 10) : NaN);

function validate() {
  clearErrors();
  let ok = true;
  const nombre = cleanNombre($("f-nombre").value);
  const codigoRaw = $("f-codigo").value;
  const codigo = normalizeCodigo(codigoRaw);

  if (!nombre) { setErr("nombre", "Ingresa el nombre de la categoría."); ok = false; }
  else if (nombre.length < 2) { setErr("nombre", "El nombre es demasiado corto."); ok = false; }
  else if (state.cats.some((c) => c.nombreNormalizado === normalizeNombre(nombre))) { setErr("nombre", MSG.dupNombre); ok = false; }

  if (!codigo) { setErr("codigo", "Ingresa el código de grupo."); ok = false; }
  else if (!/^[A-Z0-9][A-Z0-9_-]{0,11}$/.test(codigo)) { setErr("codigo", "Usa solo letras, números, guion o guion bajo (máx. 12)."); ok = false; }
  else if (state.cats.some((c) => c.codigoNormalizado === codigo)) { setErr("codigo", MSG.dupCodigo); ok = false; }

  const periodo = $("f-periodo").value;
  if (!PERIODO_RE.test(periodo)) { setErr("periodo", "Selecciona el período lectivo."); ok = false; }

  const tipo = currentTipo();
  const out = { nombre, codigoGrupo: codigo, periodoLectivo: periodo, tipoConfiguracion: tipo, descripcion: $("f-desc").value.trim() };

  if (tipo === TIPO.EDAD) {
    const min = asInt($("f-edad-min").value), max = asInt($("f-edad-max").value);
    const okRange = (n) => Number.isInteger(n) && n >= LIMITS.EDAD_MIN && n <= LIMITS.EDAD_MAX;
    if (Number.isNaN(min)) { setErr("edad-min", "Ingresa la edad mínima."); ok = false; }
    else if (!okRange(min)) { setErr("edad-min", `Debe ser un número entero entre ${LIMITS.EDAD_MIN} y ${LIMITS.EDAD_MAX}.`); ok = false; }
    if (Number.isNaN(max)) { setErr("edad-max", "Ingresa la edad máxima."); ok = false; }
    else if (!okRange(max)) { setErr("edad-max", `Debe ser un número entero entre ${LIMITS.EDAD_MIN} y ${LIMITS.EDAD_MAX}.`); ok = false; }
    if (okRange(min) && okRange(max) && max < min) { setErr("edad-max", "La edad máxima debe ser mayor o igual a la mínima."); ok = false; }
    out.edadMinima = min; out.edadMaxima = max;
  } else {
    const y = new Date().getFullYear();
    const ini = asInt($("f-anio-ini").value), fin = asInt($("f-anio-fin").value);
    const okYear = (n) => Number.isInteger(n) && n >= LIMITS.ANIO_MIN && n <= y;
    if (Number.isNaN(ini)) { setErr("anio-ini", "Ingresa el año inicial."); ok = false; }
    else if (!okYear(ini)) { setErr("anio-ini", `Debe ser un año entre ${LIMITS.ANIO_MIN} y ${y}.`); ok = false; }
    if (Number.isNaN(fin)) { setErr("anio-fin", "Ingresa el año final."); ok = false; }
    else if (!okYear(fin)) { setErr("anio-fin", `Debe ser un año entre ${LIMITS.ANIO_MIN} y ${y}.`); ok = false; }
    if (okYear(ini) && okYear(fin) && fin < ini) { setErr("anio-fin", "El año final debe ser mayor o igual al inicial."); ok = false; }
    out.anioNacimientoInicio = ini; out.anioNacimientoFin = fin;
  }

  if (!ok) $("cat-form").querySelector(".has-error .field-input")?.focus();
  return ok ? out : null;
}

/* ---------- Guardar ---------- */
function setSaving(on) {
  state.saving = on;
  const btn = $("save-btn");
  btn.disabled = on;
  btn.innerHTML = on
    ? '<span class="spinner" aria-hidden="true"></span><span class="btn-label">Guardando…</span>'
    : '<span class="btn-label">Guardar categoría</span>';
  $("cat-drawer").querySelectorAll("button[data-close]").forEach((b) => { b.disabled = on; });
  if (!on && $("cat-drawer").classList.contains("is-open")) btn.focus({ preventScroll: true });
}

async function onSubmit(e) {
  e.preventDefault();
  if (state.saving) return;            // sin doble clic
  if (!state.canCreate) { toast("error", MSG.noPermission); return; }
  $("form-alert").hidden = true;
  const data = validate();
  if (!data) return;

  setSaving(true);
  try {
    await createCategoria(data, state.me.uid);
    setSaving(false);
    closeDrawer();
    state.page = 1;
    toast("success", "Categoría creada correctamente.");
  } catch (err) {
    console.error("[CanchaControl] Crear categoría:", err?.code || err);
    setSaving(false);
    // permission-denied con datos válidos = alguien registró el mismo nombre/código al mismo tiempo
    // (las claves únicas lo bloquearon) o se perdió el permiso.
    const msg = friendlyCategoriaError(err) ?? (state.canCreate ? MSG.dupRace : MSG.noPermission);
    const a = $("form-alert"); a.textContent = msg; a.hidden = false;
    toast("error", msg);
  }
}

/* ==========================================================
   Eventos
   ========================================================== */
function wireUi() {
  $("new-cat-btn").addEventListener("click", openCreate);
  $("search").addEventListener("input", debounce(() => { state.q = $("search").value; state.page = 1; render(); }, 350));
  $("filter-periodo").addEventListener("change", (e) => { state.periodo = e.target.value; state.page = 1; render(); });
  // HU-010: las tarjetas filtran la tabla (reemplazan el desplegable de estado)
  catCards = initFilterCards($("cat-kpis"), (v) => { state.estado = v; state.page = 1; render(); });
  $("filter-coach").addEventListener("change", (e) => { state.coach = e.target.value; state.page = 1; render(); });
  if (state.canAssign) wireAssign();

  document.querySelectorAll('input[name="tipo"]').forEach((r) => r.addEventListener("change", () => setTipo(currentTipo())));
  $("cat-form").addEventListener("submit", onSubmit);
  ["nombre", "codigo", "periodo", "edad-min", "edad-max", "anio-ini", "anio-fin"].forEach((f) =>
    $(`f-${f}`).addEventListener("input", () => clearErr(f))
  );
  $("f-desc").addEventListener("input", () => { $("f-desc-count").textContent = `${$("f-desc").value.length}/${LIMITS.DESC_MAX}`; });

  $("cat-drawer").querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeDrawer));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if ($("confirm-modal").classList.contains("is-open")) { e.preventDefault(); closeConfirm(false); }
    else if ($("assign-drawer").classList.contains("is-open")) { e.preventDefault(); closeAssign(); }
    else if ($("cat-drawer").classList.contains("is-open")) { e.preventDefault(); closeDrawer(); }
  });
  $("cat-drawer").addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const panel = $("cat-drawer").querySelector(".drawer__panel");
    const f = [...panel.querySelectorAll("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")]
      .filter((x) => !x.disabled && x.offsetParent !== null);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  });
}

/* ==========================================================
   Asignar / cambiar entrenador principal (HU-005)
   ========================================================== */
const assign = { cat: null, q: "", saving: false, returnFocus: null };

function activeCoaches() {
  // Solo usuarios reales con rol Entrenador y estado Activo (ni admins, ni jugadores, ni inactivos)
  return [...state.users.values()]
    .filter((u) => u.rol === "Entrenador" && u.estado === "Activo")
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" }));
}

function openAssign(c) {
  if (!state.canAssign) { toast("error", MSG.noPermission); return; }
  assign.cat = state.cats.find((x) => x.id === c.id) ?? c;
  assign.q = "";
  assign.returnFocus = document.activeElement;
  const cat = assign.cat;
  $("assign-title").textContent = cat.entrenadorId ? "Cambiar entrenador" : "Asignar entrenador";
  $("assign-tile").className = `row-tile tile-${hashIdx(cat.nombreNormalizado || cat.nombre, 8)}`;
  $("assign-tile").innerHTML = TILE_ICON;
  $("assign-cat").textContent = cat.nombre;
  $("assign-meta").textContent = `${cat.codigoGrupo} · ${periodoLabel(cat.periodoLectivo)} · ${rangoLabel(cat)}`;
  renderCurrent();
  $("coach-search").value = "";
  $("assign-alert").hidden = true;
  $("f-coach-err").textContent = "";
  refreshAssignList();
  const d = $("assign-drawer");
  d.classList.add("is-open"); d.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open"); $("app").inert = true;
  setTimeout(() => ($("coach-list").querySelector("input") ?? d.querySelector("[data-close].btn"))?.focus(), 60);
}

function renderCurrent() {
  const box = $("assign-current");
  box.replaceChildren();
  const info = coachInfo(assign.cat?.entrenadorId);
  box.append("Entrenador actual: ");
  const strong = document.createElement("strong");
  strong.textContent = info.kind === "none" ? "Sin asignar" : info.kind === "missing" ? "Usuario no encontrado" : info.kind === "loading" ? "Cargando…" : info.user.nombre;
  box.append(strong);
  if (["inactive", "notcoach", "missing"].includes(info.kind)) {
    const b = document.createElement("span");
    b.className = "badge badge--warning";
    b.textContent = info.kind === "inactive" ? "Inactivo" : info.kind === "notcoach" ? "Ya no es Entrenador" : "Reasignar";
    box.append(b);
  }
}

function refreshAssignList() {
  if (!$("assign-drawer")?.classList.contains("is-open") && assign.cat === null) return;
  const list = $("coach-list");
  list.classList.add("select-list");
  const save = $("assign-save");
  const prev = list.querySelector("input:checked")?.value ?? null;

  if (!state.usersLoaded) {
    list.innerHTML = '<div class="select-list__state" role="status"><span class="spinner" aria-hidden="true"></span>Cargando entrenadores…</div>';
    $("coach-search-wrap").hidden = true; save.disabled = true; return;
  }
  if (state.usersError) {
    list.innerHTML = '<div class="select-list__state" role="alert">No fue posible cargar los entrenadores. Intenta nuevamente.</div>';
    $("coach-search-wrap").hidden = true; save.disabled = true; return;
  }
  const coaches = activeCoaches();
  if (!coaches.length) {
    list.innerHTML = '<div class="select-list__state" role="status">No hay entrenadores activos disponibles.</div>';
    $("coach-search-wrap").hidden = true; save.disabled = true; return;
  }
  $("coach-search-wrap").hidden = coaches.length < 6; // búsqueda cuando son muchos
  const q = norm(assign.q);
  const shown = coaches.filter((u) => !q || norm(u.nombre).includes(q) || norm(u.email).includes(q));
  if (assign.cat) renderCurrent();
  save.disabled = assign.saving;
  if (!shown.length) {
    list.innerHTML = '<div class="select-list__state" role="status">Ningún entrenador coincide con la búsqueda.</div>';
    return;
  }
  list.replaceChildren(...shown.map((u) => {
    const l = document.createElement("label"); l.className = "select-opt";
    const r = document.createElement("input"); r.type = "radio"; r.name = "coach"; r.value = u.uid;
    r.checked = prev ? prev === u.uid : assign.cat?.entrenadorId === u.uid;
    r.addEventListener("change", () => { $("f-coach-err").textContent = ""; });
    const av = document.createElement("span"); av.className = "avatar"; av.textContent = initials(u.nombre); av.setAttribute("aria-hidden", "true");
    const who = document.createElement("span");
    const n = document.createElement("p"); n.className = "select-opt__name"; n.textContent = u.nombre;
    if (assign.cat?.entrenadorId === u.uid) n.append(Object.assign(document.createElement("span"), { className: "select-opt__tag", textContent: "Actual" }));
    const e = document.createElement("p"); e.className = "select-opt__sub"; e.textContent = u.email;
    who.append(n, e);
    l.append(r, av, who);
    return l;
  }));
}

function closeAssign() {
  if (assign.saving) return;
  const d = $("assign-drawer");
  d.classList.remove("is-open"); d.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open"); $("app").inert = false;
  assign.cat = null;
  assign.returnFocus?.focus?.();
}

function setAssignSaving(on) {
  assign.saving = on;
  const b = $("assign-save");
  b.disabled = on;
  b.innerHTML = on ? '<span class="spinner" aria-hidden="true"></span><span class="btn-label">Guardando…</span>' : '<span class="btn-label">Guardar asignación</span>';
  $("assign-drawer").querySelectorAll("button[data-close]").forEach((x) => { x.disabled = on; });
}

async function onAssignSubmit(e) {
  e.preventDefault();
  if (assign.saving || !assign.cat) return;
  $("assign-alert").hidden = true;
  const uid = $("coach-list").querySelector("input:checked")?.value;
  if (!uid) { $("f-coach-err").textContent = "Selecciona un entrenador."; return; }
  const cat = state.cats.find((x) => x.id === assign.cat.id) ?? assign.cat;
  const current = cat.entrenadorId ?? null;
  if (uid === current) { toast("info", MSG.sameCoach); return; }

  const nuevo = state.users.get(uid);
  if (current) {
    // CA-02: confirmar ANTES de reemplazar
    const actualNombre = state.users.get(current)?.nombre ?? "otro entrenador";
    const ok = await confirmDialog(`${cat.nombre} actualmente está asignada a ${actualNombre}. ¿Deseas reemplazarlo por ${nuevo?.nombre ?? "el entrenador seleccionado"}?`);
    if (!ok) return; // Cancelar: no se toca Firestore
  }

  setAssignSaving(true);
  try {
    await assignEntrenador(cat.id, uid, { expectedCurrent: current, actorUid: state.me.uid });
    setAssignSaving(false);
    closeAssign();
    toast("success", current ? "Entrenador actualizado correctamente." : "Entrenador asignado correctamente.");
  } catch (err) {
    console.error("[CanchaControl] Asignar entrenador:", err?.code || err);
    setAssignSaving(false);
    const msg = friendlyAssignError(err);
    const a = $("assign-alert"); a.textContent = msg; a.hidden = false;
    toast("error", msg);
  }
}

/* ---------- Confirmación (promesa) ---------- */
let confirmResolve = null, confirmFocus = null;
function confirmDialog(text) {
  confirmFocus = document.activeElement;
  $("confirm-text").textContent = text;
  const m = $("confirm-modal");
  m.classList.add("is-open"); m.setAttribute("aria-hidden", "false");
  setTimeout(() => m.querySelector("[data-cancel].btn").focus(), 60); // foco en la opción segura
  return new Promise((r) => { confirmResolve = r; });
}
function closeConfirm(result) {
  const m = $("confirm-modal");
  m.classList.remove("is-open"); m.setAttribute("aria-hidden", "true");
  confirmResolve?.(result); confirmResolve = null;
  confirmFocus?.focus?.();
}

function wireAssign() {
  $("assign-form").addEventListener("submit", onAssignSubmit);
  $("assign-drawer").querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeAssign));
  $("coach-search").addEventListener("input", debounce(() => { assign.q = $("coach-search").value; refreshAssignList(); }, 250));
  $("confirm-ok").addEventListener("click", () => closeConfirm(true));
  $("confirm-modal").querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", () => closeConfirm(false)));
  for (const id of ["assign-drawer", "confirm-modal"]) {
    $(id).addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      const box = $(id).querySelector(".drawer__panel, .modal__dialog");
      const f = [...box.querySelectorAll("button, input, select, textarea")].filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    });
  }
}
