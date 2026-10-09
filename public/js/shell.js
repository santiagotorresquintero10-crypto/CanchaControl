/* ==========================================================
   CanchaControl — Layout central (sidebar + header)
   ----------------------------------------------------------
   UNA sola implementación para todas las páginas privadas.
   Se monta DENTRO de onReady de protectPage, es decir, solo
   después de validar sesión, perfil, estado y rol: nunca se
   pinta un menú o un nombre antes de autorizar.

   Uso:  mountShell(profile, "categorias")
   HTML: <div id="app" class="app-shell" data-private hidden>
           <div data-shell-sidebar></div>
           <div class="app-main"><div data-shell-header></div>
             <main class="page">…contenido del módulo…</main></div></div>
   ========================================================== */
import { navFor } from "./permissions.js";
import { logout } from "./authGuard.js";
import { toast } from "./ui.js";

const ICONS = {
  home: '<path d="m3 10.5 9-7 9 7"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20v-1a5.5 5.5 0 0 1 11 0v1"/><circle cx="17" cy="9" r="2.6"/><path d="M15.5 14.2A4.5 4.5 0 0 1 21.5 18.5v1"/>',
  player: '<circle cx="10" cy="6.5" r="3"/><path d="M4 20v-1.5A5.5 5.5 0 0 1 9.5 13h1A5.5 5.5 0 0 1 16 18.5V20"/><circle cx="19" cy="18" r="2.5"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="M8 14h2M14 14h2M8 17.5h2"/>',
  trophy: '<path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4.5a2.5 2.5 0 0 0 2.5 4"/><path d="M17 6h2.5a2.5 2.5 0 0 1-2.5 4"/><line x1="12" y1="14" x2="12" y2="17.5"/><path d="M8.5 20.5h7l-.8-3h-5.4z"/>',
  medal: '<circle cx="12" cy="15" r="5.5"/><path d="M8.5 10.5 6 3h4l2 5"/><path d="M15.5 10.5 18 3h-4l-2 5"/><path d="m12 12.6.9 1.7 1.9.3-1.4 1.3.3 1.9-1.7-.9-1.7.9.3-1.9-1.4-1.3 1.9-.3z"/>',
  chart: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
  layers: '<path d="m12 3 9 4.5-9 4.5-9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>',
};
const svg = (paths, size = 21) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export function initials(nombre) {
  const p = String(nombre || "").trim().split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] ?? "?") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
}

const COLLAPSE_KEY = "cc:sidebar-collapsed"; // preferencia visual, no sensible

export function mountShell(profile, activePage) {
  const app = document.getElementById("app");
  app.classList.add("app-shell");
  try { if (localStorage.getItem(COLLAPSE_KEY) === "1") app.classList.add("is-collapsed"); } catch { /* sin storage */ }

  /* ---------- Sidebar ---------- */
  const sb = document.querySelector("[data-shell-sidebar]");
  sb.outerHTML = `
    <aside class="sidebar" id="sidebar" aria-label="Navegación principal">
      <a class="sidebar__brand" href="dashboard.html" aria-label="CanchaControl, inicio">
        <img src="assets/img/logo.svg" alt="" width="42" height="42" />
        <div><p class="sidebar__name">Cancha<span>Control</span></p><p class="sidebar__tag">Organiza. Entrena. Juega.</p></div>
      </a>
      <nav class="sidebar__nav" id="sidebar-nav"></nav>
      <div class="sidebar__art" aria-hidden="true">
        <p class="sidebar__slogan">Formando<br />más que<br />deportistas
          <svg viewBox="0 0 130 14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M3 10C40 3 85 2 127 6"/></svg>
        </p>
      </div>
    </aside>
    <div class="sb-overlay" id="sb-overlay"></div>`;

  const nav = document.getElementById("sidebar-nav");
  for (const item of navFor(profile)) {
    const a = document.createElement("a");
    a.className = "nav-item";
    a.href = `${item.page}.html`;
    a.innerHTML = svg(ICONS[item.icon] ?? ICONS.home);
    const label = document.createElement("span");
    const text = item.labels?.[profile.rol] ?? item.label;   // nombre según rol ("Mis jugadores" para Entrenador)
    label.textContent = text;
    a.append(label);
    a.title = text;
    if (item.page === activePage) a.setAttribute("aria-current", "page");
    nav.append(a);
  }

  /* ---------- Header ---------- */
  const hd = document.querySelector("[data-shell-header]");
  hd.outerHTML = `
    <header class="app-header">
      <button type="button" class="hd-btn" id="sb-toggle" aria-label="Mostrar u ocultar menú" aria-controls="sidebar" aria-expanded="true">
        ${svg('<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>', 20)}
      </button>
      <form class="hd-search" role="search" id="hd-search">
        ${svg('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>', 18)}
        <label class="sr-only" for="hd-search-input">Buscar en CanchaControl</label>
        <input id="hd-search-input" type="search" placeholder="Buscar en CanchaControl..." autocomplete="off" />
      </form>
      <div class="hd-user">
        <button type="button" class="hd-user__btn" id="user-menu-btn" aria-haspopup="menu" aria-expanded="false">
          <span class="avatar" id="me-avatar"></span>
          <span class="hd-user__who"><span class="hd-user__name" id="me-name"></span><span class="hd-user__role" id="me-role"></span></span>
          ${svg('<polyline points="6 9 12 15 18 9"/>', 18)}
        </button>
        <div class="row-menu hd-user__menu" id="user-menu" role="menu" hidden>
          <button type="button" role="menuitem" class="row-menu__item is-danger" id="shell-logout">
            ${svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>', 16)}
            Cerrar sesión
          </button>
        </div>
      </div>
    </header>`;

  // Datos reales del usuario autenticado (textContent: nunca HTML)
  document.getElementById("me-avatar").textContent = initials(profile.nombre);
  document.getElementById("me-name").textContent = profile.nombre;
  document.getElementById("me-role").textContent = profile.rol;

  wireShell(app);
}

function wireShell(app) {
  const mq = window.matchMedia("(max-width: 1024px)");
  const toggle = document.getElementById("sb-toggle");
  toggle.setAttribute("aria-expanded", String(!mq.matches && !app.classList.contains("is-collapsed")));

  toggle.addEventListener("click", () => {
    if (mq.matches) {
      const open = app.classList.toggle("is-mobile-open");
      toggle.setAttribute("aria-expanded", String(open));
      if (open) document.querySelector("#sidebar-nav .nav-item")?.focus();
    } else {
      const collapsed = app.classList.toggle("is-collapsed");
      toggle.setAttribute("aria-expanded", String(!collapsed));
      try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch { /* sin storage */ }
    }
  });
  document.getElementById("sb-overlay").addEventListener("click", () => closeMobile(app, toggle));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && app.classList.contains("is-mobile-open")) { closeMobile(app, toggle); toggle.focus(); }
  });

  // Búsqueda global: preparada visualmente; sin resultados inventados.
  document.getElementById("hd-search").addEventListener("submit", (e) => {
    e.preventDefault();
    toast("info", "La búsqueda global estará disponible en una próxima versión.");
  });

  // Menú de usuario
  const btn = document.getElementById("user-menu-btn");
  const menu = document.getElementById("user-menu");
  const close = () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    btn.setAttribute("aria-expanded", String(willOpen));
    if (willOpen) menu.querySelector(".row-menu__item").focus();
  });
  document.addEventListener("click", (e) => { if (!menu.contains(e.target)) close(); });
  menu.addEventListener("keydown", (e) => { if (e.key === "Escape") { close(); btn.focus(); } });
  document.getElementById("shell-logout").addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    await logout();
  });
}

function closeMobile(app, toggle) {
  app.classList.remove("is-mobile-open");
  toggle.setAttribute("aria-expanded", "false");
}
