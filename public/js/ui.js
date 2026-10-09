/* ==========================================================
   CanchaControl — Utilidades de interfaz compartidas
   Toasts, mensajes "flash" entre páginas y pantalla de carga.
   ========================================================== */

const ICONS = { success: "✓", error: "✕", warning: "!", info: "i" };
const DEFAULT_DURATION = { success: 3500, info: 4500, warning: 6000, error: 6000 };

function getRegion() {
  let region = document.getElementById("toast-region");
  if (!region) {
    region = document.createElement("div");
    region.id = "toast-region";
    region.className = "toast-region";
    document.body.appendChild(region);
  }
  return region;
}

/**
 * Muestra una notificación no bloqueante.
 * @param {"success"|"error"|"warning"|"info"} type
 * @param {string} message  Texto ya traducido para el usuario (nunca códigos técnicos).
 */
export function toast(type, message, { duration } = {}) {
  const region = getRegion();
  const el = document.createElement("div");
  el.className = `toast toast--${type}`;
  // errores y advertencias interrumpen al lector de pantalla; el resto no.
  el.setAttribute("role", type === "error" || type === "warning" ? "alert" : "status");

  const icon = document.createElement("span");
  icon.className = "toast__icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = ICONS[type] ?? "i";

  const msg = document.createElement("p");
  msg.className = "toast__msg";
  msg.textContent = message; // textContent: nunca interpretar HTML

  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast__close";
  close.setAttribute("aria-label", "Cerrar notificación");
  close.textContent = "×";

  el.append(icon, msg, close);
  region.appendChild(el);

  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    if (!el.isConnected || el.classList.contains("is-leaving")) return;
    el.classList.add("is-leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400); // por si no hay animación
  };
  close.addEventListener("click", dismiss);
  timer = setTimeout(dismiss, duration ?? DEFAULT_DURATION[type] ?? 4500);

  // Máximo 3 toasts visibles
  const all = region.querySelectorAll(".toast:not(.is-leaving)");
  if (all.length > 3) all[0].querySelector(".toast__close")?.click();

  return dismiss;
}

/* ---------- Mensajes entre páginas (no sensibles) ---------- */
const FLASH_KEY = "cc:flash";

export function setFlash(type, message) {
  try { sessionStorage.setItem(FLASH_KEY, JSON.stringify({ type, message })); } catch { /* sin storage */ }
}

export function takeFlash() {
  try {
    const raw = sessionStorage.getItem(FLASH_KEY);
    sessionStorage.removeItem(FLASH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/* ---------- Pantalla de carga inicial ---------- */
export function hideBootLoader() {
  const el = document.getElementById("boot-loader");
  if (!el) return;
  el.classList.add("is-done");
  el.setAttribute("aria-hidden", "true");
  setTimeout(() => el.remove(), 400);
}

/* ---------- Pantallas de estado (acceso restringido, sin conexión) ---------- */
const STATUS_ICONS = {
  lock: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10.5" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>',
  offline: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 8.8a15 15 0 0 1 4.2-2.6"/><path d="M10.7 5.1A15 15 0 0 1 22 8.8"/><path d="M5 12.5a10 10 0 0 1 3.4-2"/><path d="M14.6 10.3A10 10 0 0 1 19 12.5"/><path d="M8.5 16.4a5 5 0 0 1 7 0"/><line x1="12" y1="20" x2="12.01" y2="20"/><line x1="2" y1="2" x2="22" y2="22"/></svg>',
};

/**
 * Reemplaza la vista por una pantalla de estado. Nunca muestra datos privados
 * ni detalles técnicos. Los textos se insertan con textContent.
 * @param {{variant:"restricted"|"error", icon:"lock"|"offline", title:string, text:string,
 *          actionLabel:string, onAction:Function}} opts
 */
export function renderStatusScreen({ variant = "restricted", icon = "lock", title, text, actionLabel, onAction }) {
  document.getElementById("status-screen")?.remove();
  const wrap = document.createElement("main");
  wrap.id = "status-screen";
  wrap.className = `status-screen status-screen--${variant}`;
  wrap.setAttribute("role", variant === "error" ? "alert" : "main");

  const card = document.createElement("section");
  card.className = "status-card";
  card.setAttribute("aria-labelledby", "status-title");

  const logo = document.createElement("img");
  logo.src = "assets/img/logo.svg"; logo.alt = "CanchaControl"; logo.width = 48; logo.height = 48;
  logo.className = "status-card__logo";

  const ic = document.createElement("div");
  ic.className = "status-card__icon";
  ic.innerHTML = STATUS_ICONS[icon] ?? STATUS_ICONS.lock; // SVG fijo, no proviene del usuario

  const h = document.createElement("h1");
  h.id = "status-title"; h.className = "status-card__title"; h.textContent = title;

  const p = document.createElement("p");
  p.className = "status-card__text"; p.textContent = text;

  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "btn btn-primary"; btn.textContent = actionLabel;
  btn.addEventListener("click", onAction);

  card.append(logo, ic, h, p, btn);
  wrap.append(card);
  document.body.append(wrap);
  hideBootLoader();
  btn.focus({ preventScroll: true });
}


/* ==========================================================
   FilterKpiCard (HU-010) — tarjetas KPI como filtros de un listado.
   container: elemento con botones .kpi--filter[data-filter]
   El valor "" (data-filter="") es "Todos". Pulsar la tarjeta activa
   vuelve a "Todos". Solo filtra en pantalla: no consulta ni escribe.
   ========================================================== */
export function initFilterCards(container, onChange, initial = "") {
  const cards = [...container.querySelectorAll(".kpi--filter")];
  let value = initial;
  const paint = () => cards.forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.filter === value)));
  cards.forEach((c) => c.addEventListener("click", () => {
    value = c.dataset.filter === value && value !== "" ? "" : c.dataset.filter;
    paint(); onChange(value);
  }));
  paint();
  return { set(v) { value = v; paint(); }, get: () => value };
}
