/* ==========================================================
   CanchaControl — Pantalla Gestión de usuarios (HU-002)
   Seguridad: authGuard (solo Administrador) + firestore.rules.
   Aquí solo hay interfaz: nada de lo que se oculta o deshabilita
   aquí es la protección real.
   ========================================================== */
import { protectPage } from "./authGuard.js";
import { mountShell } from "./shell.js";
import { isValidEmail } from "./auth.js";
import { ROLES, ESTADO, ROLE } from "./permissions.js";
import { toast, initFilterCards } from "./ui.js";
import {
  subscribeUsers,
  createUser,
  updateUser,
  setEstado,
  guardChange,
  friendlyUserError,
} from "./users.js";

const $ = (id) => document.getElementById(id);

const state = {
  me: null,
  users: [],
  loaded: false,
  q: "",
  rol: "",
  estado: "",
  menuUser: null,
  editing: null,   // null = crear; objeto = editar
  saving: false,
};

/* ==========================================================
   Arranque protegido
   ========================================================== */
protectPage({
  page: "usuarios",
  onReady(profile) {
    state.me = profile;
    mountShell(profile, "usuarios");   // sidebar + header oficiales (nombre/rol reales)
    wireUi();
    subscribeUsers(
      (list) => { state.users = list; state.loaded = true; render(); },
      (err) => {
        console.error("[CanchaControl] Usuarios:", err?.code || err);
        state.loaded = true;
        state.users = [];
        showEmpty("No fue posible cargar los usuarios.", friendlyUserError(err), "Reintentar", () => location.reload());
        $("users-body").replaceChildren();
      }
    );
  },
});

/* ==========================================================
   Render
   ========================================================== */
const DATE_FMT = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
});

const norm = (s) => String(s ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();

function matches(u) {
  if (state.rol && u.rol !== state.rol) return false;
  if (state.estado && u.estado !== state.estado) return false;
  if (state.q) {
    const q = norm(state.q);
    if (!norm(u.nombre).includes(q) && !norm(u.email).includes(q)) return false;
  }
  return true;
}

function render() {
  const all = state.users;
  $("kpi-total").textContent = String(all.length);
  $("kpi-admin").textContent = String(all.filter((u) => u.rol === ROLE.ADMIN).length);
  $("kpi-coach").textContent = String(all.filter((u) => u.rol === ROLE.ENTRENADOR).length);
  $("kpi-player").textContent = String(all.filter((u) => u.rol === ROLE.JUGADOR).length);

  const rows = all.filter(matches);
  const filtering = !!(state.q || state.rol || state.estado);
  $("results-count").textContent = all.length
    ? (filtering ? `Mostrando ${rows.length} de ${all.length} usuarios` : `${all.length} ${all.length === 1 ? "usuario" : "usuarios"}`)
    : "";

  const body = $("users-body");
  body.replaceChildren(...rows.map(rowFor));
  $("users-table").hidden = rows.length === 0;

  if (all.length === 0) {
    showEmpty("No hay usuarios registrados.", "Crea la primera cuenta para dar acceso a CanchaControl.", "Nuevo usuario", () => openDrawer(null));
  } else if (rows.length === 0) {
    showEmpty("No encontramos usuarios con estos criterios.", "Prueba con otro nombre, correo o cambia los filtros.", "Limpiar filtros", clearFilters);
  } else {
    $("empty-state").hidden = true;
  }
}

function showEmpty(title, text, actionLabel, onAction) {
  $("empty-title").textContent = title;
  $("empty-text").textContent = text;
  const btn = $("empty-action");
  btn.textContent = actionLabel;
  btn.onclick = onAction;
  $("empty-state").hidden = false;
  $("users-table").hidden = true;
}

function initials(nombre) {
  const parts = String(nombre).trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function rowFor(u) {
  const tr = el("tr");
  tr.dataset.uid = u.uid;
  if (u.estado !== ESTADO.ACTIVO) tr.classList.add("is-inactive");
  const validRole = ROLES.includes(u.rol);

  // Nombre
  const td1 = el("td");
  const person = el("div", "u-person");
  person.append(el("span", `u-avatar u-avatar--${validRole ? u.rol : "x"}`, initials(u.nombre || u.email)));
  const name = el("span", "u-name", u.nombre || "Sin nombre");
  if (u.uid === state.me.uid) name.append(el("span", "u-me", "Tú"));
  person.append(name);
  td1.append(person);

  // Correo
  const td2 = el("td", "u-email", u.email || "—");

  // Rol
  const td3 = el("td");
  td3.append(el("span", `pill pill--${validRole ? u.rol : "x"}`, validRole ? u.rol : "Rol inválido"));

  // Estado
  const td4 = el("td");
  const est = u.estado === ESTADO.ACTIVO ? ESTADO.ACTIVO : ESTADO.INACTIVO;
  td4.append(el("span", `status status--${est}`, est));

  // Último acceso
  const td5 = el("td", "u-last", u.lastLoginAt ? DATE_FMT.format(u.lastLoginAt) : "Nunca");

  // Acciones
  const td6 = el("td");
  const btn = el("button", "dots-btn");
  btn.type = "button";
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-label", `Acciones para ${u.nombre || u.email}`);
  btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>';
  btn.addEventListener("click", (e) => { e.stopPropagation(); openMenu(u, btn); });
  td6.append(btn);

  tr.append(td1, td2, td3, td4, td5, td6);
  return tr;
}

/* ==========================================================
   Búsqueda y filtros
   ========================================================== */
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

let roleCards = null;
function clearFilters() {
  state.q = state.rol = state.estado = "";
  $("search").value = "";
  roleCards?.set("");
  $("filter-estado").value = "";
  render();
  $("search").focus();
}

/* ==========================================================
   Menú ⋮
   ========================================================== */
const menu = () => $("row-menu");
let menuButton = null;

function openMenu(u, button) {
  if (menuButton === button && !menu().hidden) { closeMenu(); return; }
  closeMenu();
  state.menuUser = u;
  menuButton = button;
  button.setAttribute("aria-expanded", "true");

  const toggle = menu().querySelector('[data-action="toggle"]');
  const isActive = u.estado === ESTADO.ACTIVO;
  $("row-menu-toggle-label").textContent = isActive ? "Inactivar" : "Activar";
  toggle.classList.toggle("is-danger", isActive);
  toggle.classList.toggle("is-success", !isActive);

  const m = menu();
  m.hidden = false;
  const r = button.getBoundingClientRect();
  const w = m.offsetWidth, h = m.offsetHeight;
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = r.top - h - 6;
  m.style.top = `${Math.max(8, top)}px`;
  m.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
  m.querySelector(".row-menu__item").focus();
}

function closeMenu({ restoreFocus = false } = {}) {
  if (menu().hidden) return;
  menu().hidden = true;
  menuButton?.setAttribute("aria-expanded", "false");
  if (restoreFocus) menuButton?.focus();
  menuButton = null;
}

/* ==========================================================
   Drawer crear / editar
   ========================================================== */
let drawerReturnFocus = null;
const F = {
  nombre: () => $("f-nombre"), email: () => $("f-email"), pass: () => $("f-pass"),
  pass2: () => $("f-pass2"), rol: () => $("f-rol"), estado: () => $("f-estado"),
};

function openDrawer(user) {
  closeMenu();
  state.editing = user;
  drawerReturnFocus = document.activeElement;
  const editing = !!user;
  const self = editing && user.uid === state.me.uid;

  $("drawer-title").textContent = editing ? "Editar usuario" : "Nuevo usuario";
  $("drawer-subtitle").textContent = editing
    ? "Actualiza su nombre, rol o estado."
    : "Crea la cuenta y asigna su rol y estado.";
  $("save-btn").querySelector(".btn-label").textContent = editing ? "Guardar cambios" : "Crear usuario";

  $("user-form").reset();
  clearErrors();
  $("form-alert").hidden = true;

  F.nombre().value = editing ? user.nombre : "";
  F.email().value = editing ? user.email : "";
  F.email().readOnly = editing;
  $("f-email-help").hidden = !editing;
  $("password-group").hidden = editing;
  F.rol().value = editing ? (ROLES.includes(user.rol) ? user.rol : "") : "";
  F.estado().value = editing ? (user.estado === ESTADO.INACTIVO ? ESTADO.INACTIVO : ESTADO.ACTIVO) : ESTADO.ACTIVO;
  const linked = editing && !!user.jugadorId;   // HU-007: cuenta con expediente de jugador
  F.rol().disabled = self || linked;
  F.estado().disabled = self;
  $("self-note").hidden = !self;
  $("linked-note").hidden = !linked || self;

  const d = $("user-drawer");
  d.classList.add("is-open");
  d.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  $("app").inert = true;
  setTimeout(() => F.nombre().focus(), 60);
}

function closeDrawer() {
  if (state.saving) return;
  const d = $("user-drawer");
  d.classList.remove("is-open");
  d.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  $("app").inert = false;
  state.editing = null;
  drawerReturnFocus?.focus?.();
}

function setErr(field, msg) {
  const input = $(`f-${field}`);
  input.closest(".f-field").classList.add("has-error");
  input.setAttribute("aria-invalid", "true");
  $(`f-${field}-err`).textContent = msg;
}
function clearErr(field) {
  const input = $(`f-${field}`);
  input.closest(".f-field").classList.remove("has-error");
  input.setAttribute("aria-invalid", "false");
  $(`f-${field}-err`).textContent = "";
}
function clearErrors() { ["nombre", "email", "pass", "pass2", "rol", "estado"].forEach(clearErr); }

function validate(creating) {
  clearErrors();
  let ok = true;
  const nombre = F.nombre().value.trim();
  if (!nombre) { setErr("nombre", "Ingresa el nombre completo."); ok = false; }
  else if (nombre.length < 2) { setErr("nombre", "El nombre es demasiado corto."); ok = false; }

  if (creating) {
    const email = F.email().value.trim();
    if (!email) { setErr("email", "Ingresa el correo electrónico."); ok = false; }
    else if (!isValidEmail(email)) { setErr("email", "Ingresa un correo electrónico válido."); ok = false; }

    const p1 = F.pass().value, p2 = F.pass2().value;
    if (!p1) { setErr("pass", "Ingresa una contraseña."); ok = false; }
    else if (p1.length < 8) { setErr("pass", "La contraseña debe tener al menos 8 caracteres."); ok = false; }
    if (!p2) { setErr("pass2", "Confirma la contraseña."); ok = false; }
    else if (p1 && p1 !== p2) { setErr("pass2", "Las contraseñas no coinciden."); ok = false; }
  }

  if (!ROLES.includes(F.rol().value)) { setErr("rol", "Selecciona un rol."); ok = false; }
  if (![ESTADO.ACTIVO, ESTADO.INACTIVO].includes(F.estado().value)) { setErr("estado", "Selecciona un estado."); ok = false; }

  if (!ok) $("user-form").querySelector(".has-error .field-input")?.focus();
  return ok;
}

function setSaving(on, label) {
  state.saving = on;
  const btn = $("save-btn");
  btn.disabled = on;
  if (on) {
    btn.dataset.label = btn.querySelector(".btn-label").textContent;
    btn.innerHTML = `<span class="spinner" aria-hidden="true"></span><span class="btn-label">${label}</span>`;
  } else if (btn.dataset.label) {
    btn.innerHTML = `<span class="btn-label">${btn.dataset.label}</span>`;
    if ($("user-drawer").classList.contains("is-open")) btn.focus({ preventScroll: true }); // no perder el foco
  }
  $("user-drawer").querySelectorAll("[data-close]").forEach((b) => { b.disabled = on; });
}

function showFormAlert(msg) {
  const a = $("form-alert");
  a.textContent = msg;
  a.hidden = false;
}

async function onSubmit(e) {
  e.preventDefault();
  if (state.saving) return;   // sin doble clic
  $("form-alert").hidden = true;
  const editing = state.editing;
  if (!validate(!editing)) return;

  const nombre = F.nombre().value.trim();
  const rol = F.rol().value;
  const estado = F.estado().value;

  if (!editing) {
    setSaving(true, "Creando…");
    try {
      await createUser({ nombre, email: F.email().value, password: F.pass().value, rol, estado });
      setSaving(false);
      closeDrawer();
      toast("success", "Usuario creado correctamente. Le enviamos un correo para verificar su cuenta.");
    } catch (err) {
      console.error("[CanchaControl] Crear usuario:", err?.code || err);
      setSaving(false);
      const msg = friendlyUserError(err);
      if (err?.code === "auth/email-already-in-use") { setErr("email", msg); F.email().focus(); }
      showFormAlert(msg);
      toast("error", err?.code === "auth/email-already-in-use" ? "Ya existe una cuenta con este correo." : msg);
    } finally {
      F.pass().value = ""; F.pass2().value = ""; // nunca retener contraseñas
    }
    return;
  }

  // Editar: solo lo que cambió
  const changes = {};
  if (nombre !== editing.nombre) changes.nombre = nombre;
  if (!F.rol().disabled && rol !== editing.rol) changes.rol = rol;
  if (!F.estado().disabled && estado !== editing.estado) changes.estado = estado;
  if (!Object.keys(changes).length) { closeDrawer(); toast("info", "No hay cambios para guardar."); return; }

  const blocked = guardChange(state.me.uid, editing, changes, state.users);
  if (blocked) { showFormAlert(blocked); toast("warning", blocked); return; }

  if (changes.estado === ESTADO.INACTIVO) {
    const ok = await confirmDialog({
      title: `¿Inactivar a ${editing.nombre}?`,
      text: "Este usuario perderá acceso a CanchaControl.",
      okLabel: "Inactivar",
      danger: true,
    });
    if (!ok) return;
  }

  setSaving(true, "Guardando…");
  try {
    await updateUser(editing.uid, changes);
    setSaving(false);
    closeDrawer();
    toast("success", "Usuario actualizado correctamente.");
  } catch (err) {
    console.error("[CanchaControl] Editar usuario:", err?.code || err);
    setSaving(false);
    const msg = friendlyUserError(err);
    showFormAlert(msg);
    toast("error", msg);
  }
}

/* ==========================================================
   Activar / Inactivar
   ========================================================== */
async function toggleEstado(u) {
  closeMenu();
  const target = state.users.find((x) => x.uid === u.uid) ?? u;
  const toInactive = target.estado === ESTADO.ACTIVO;
  const next = toInactive ? ESTADO.INACTIVO : ESTADO.ACTIVO;

  const blocked = guardChange(state.me.uid, target, { estado: next }, state.users);
  if (blocked) { toast("warning", blocked); return; }

  const ok = await confirmDialog(toInactive
    ? { title: `¿Inactivar a ${target.nombre}?`, text: "Este usuario perderá acceso a CanchaControl.", okLabel: "Inactivar", danger: true }
    : { title: `¿Activar a ${target.nombre}?`, text: "Este usuario podrá volver a ingresar a CanchaControl.", okLabel: "Activar", danger: false });
  if (!ok) return;

  try {
    await setEstado(target.uid, next);
    toast("success", toInactive ? "Usuario inactivado correctamente." : "Usuario activado correctamente.");
  } catch (err) {
    console.error("[CanchaControl] Estado:", err?.code || err);
    toast("error", friendlyUserError(err));
  }
}

/* ==========================================================
   Diálogo de confirmación (promesa)
   ========================================================== */
let confirmResolve = null;
let confirmReturnFocus = null;

function confirmDialog({ title, text, okLabel, danger }) {
  confirmReturnFocus = document.activeElement;
  $("confirm-title").textContent = title;
  $("confirm-text").textContent = text;
  const ok = $("confirm-ok");
  ok.textContent = okLabel;
  ok.classList.toggle("is-success", !danger);
  $("confirm-icon").classList.toggle("is-danger", !!danger);
  const m = $("confirm-modal");
  m.classList.add("is-open");
  m.setAttribute("aria-hidden", "false");
  setTimeout(() => m.querySelector("[data-cancel].btn").focus(), 60); // foco en la opción segura
  return new Promise((resolve) => { confirmResolve = resolve; });
}

function closeConfirm(result) {
  const m = $("confirm-modal");
  m.classList.remove("is-open");
  m.setAttribute("aria-hidden", "true");
  confirmResolve?.(result);
  confirmResolve = null;
  confirmReturnFocus?.focus?.();
}

/* ==========================================================
   Accesibilidad: foco atrapado en drawer y diálogo
   ========================================================== */
function trapFocus(container, e) {
  const f = [...container.querySelectorAll("button, input, select, a[href], [tabindex]:not([tabindex='-1'])")]
    .filter((x) => !x.disabled && !x.hidden && x.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/* ==========================================================
   Eventos
   ========================================================== */
function wireUi() {
  const onSearch = debounce(() => { state.q = $("search").value; render(); }, 350);
  $("search").addEventListener("input", onSearch);
  // HU-010: las tarjetas de rol filtran la tabla (reemplazan el desplegable "Todos los roles")
  roleCards = initFilterCards($("user-kpis"), (v) => { state.rol = v; render(); });
  $("filter-estado").addEventListener("change", (e) => { state.estado = e.target.value; render(); });

  $("new-user-btn").addEventListener("click", () => openDrawer(null));

  // Menú
  menu().addEventListener("click", (e) => {
    const item = e.target.closest("[data-action]");
    if (!item || !state.menuUser) return;
    const u = state.menuUser;
    if (item.dataset.action === "edit") openDrawer(state.users.find((x) => x.uid === u.uid) ?? u);
    else toggleEstado(u);
  });
  menu().addEventListener("keydown", (e) => {
    const items = [...menu().querySelectorAll(".row-menu__item")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === "Escape") { e.preventDefault(); closeMenu({ restoreFocus: true }); }
    else if (e.key === "Tab") closeMenu();
  });
  document.addEventListener("click", (e) => { if (!menu().contains(e.target)) closeMenu(); });
  window.addEventListener("resize", () => closeMenu());
  window.addEventListener("scroll", () => closeMenu(), true);

  // Drawer
  $("user-form").addEventListener("submit", onSubmit);
  $("user-drawer").querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeDrawer));
  // Escape a nivel de documento: funciona aunque el foco se haya perdido
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if ($("confirm-modal").classList.contains("is-open")) { e.preventDefault(); closeConfirm(false); }
    else if ($("user-drawer").classList.contains("is-open")) { e.preventDefault(); closeDrawer(); }
  });
  $("user-drawer").addEventListener("keydown", (e) => {
    if (e.key === "Tab") trapFocus($("user-drawer").querySelector(".drawer__panel"), e);
  });
  ["nombre", "email", "pass", "pass2", "rol", "estado"].forEach((f) =>
    $(`f-${f}`).addEventListener("input", () => clearErr(f))
  );

  // Confirmación
  $("confirm-ok").addEventListener("click", () => closeConfirm(true));
  $("confirm-modal").querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", () => closeConfirm(false)));
  $("confirm-modal").addEventListener("keydown", (e) => {
    if (e.key === "Tab") trapFocus($("confirm-modal").querySelector(".modal__dialog"), e);
  });
}
