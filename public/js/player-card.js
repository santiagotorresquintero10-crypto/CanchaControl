/* ==========================================================
   CanchaControl — Tarjeta deportiva 3D del jugador (HU-011)
   createPlayer3DCard(player, estado, opciones)
   ----------------------------------------------------------
   Diseño ORIGINAL inspirado en las cartas especiales de los videojuegos de
   fútbol: sin logotipos, escudos ni activos oficiales y sin estadísticas inventadas.

   Capas (cada una en su propio plano con translateZ dentro de preserve-3d):
     1 fondo deportivo · 2 textura holográfica · 3 marco · 4 foto/avatar
     5 dorsal y posición · 6 nombre · 7 estado de asistencia · (+ brillo)
   Los botones de asistencia van FUERA del plano inclinado: siempre quietos y
   fáciles de pulsar.

   Inclinación: solo se escucha el puntero mientras está SOBRE la tarjeta
   (pointerenter → pointermove → pointerleave). Cada movimiento guarda la
   posición y un único requestAnimationFrame escribe 5 variables CSS; el CSS
   hace el resto (transform, brillo, luz). Máx. ±9°. Con pantalla táctil o
   prefers-reduced-motion no hay inclinación: queda la profundidad estática.
   ========================================================== */
import { ESTADOS, ESTADO_INFO } from "./asistencia-data.js";

const POS_ABBR = { Portero: "POR", Defensa: "DEF", Mediocampista: "MED", Delantero: "DEL" };
export const posAbbr = (p) => POS_ABBR[p] ?? "—";
export const iniciales = (n, a) => `${(n || "").trim()[0] ?? ""}${(a || "").trim()[0] ?? ""}`.toUpperCase() || "?";
const MAX_DEG = 9;

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const ICON = {
  "Asistió": '<polyline points="5 12.5 10 17.5 19 7.5"/>',
  "Falta": '<line x1="7" y1="7" x2="17" y2="17"/><line x1="17" y1="7" x2="7" y2="17"/>',
  "Excusa": '<path d="M6 4h9l3 3v13H6z"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="13" y2="15"/>',
  "Atraso": '<circle cx="12" cy="12" r="8"/><polyline points="12 8 12 12 15 14"/>',
  pend: '<circle cx="12" cy="12" r="8" stroke-dasharray="3 3"/>',
};
export const stateIcon = (estado, size = 16) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[estado] ?? ICON.pend}</svg>`;
export const stateKey = (estado) => ESTADO_INFO[estado]?.key ?? "pend";
export const stateLabel = (estado) => ESTADO_INFO[estado]?.label ?? "Sin marcar";

/** Avatar deportivo sin foto: camiseta con iniciales (SVG original). */
export function jerseyAvatar(player) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 100 100"); svg.setAttribute("aria-hidden", "true"); svg.classList.add("pc-jersey");
  const shirt = document.createElementNS(ns, "path");
  shirt.setAttribute("d", "M33 12 L42 8 Q50 16 58 8 L67 12 L90 27 L80 45 L71 39 L71 92 L29 92 L29 39 L20 45 L10 27 Z");
  shirt.setAttribute("class", "pc-jersey__shirt");
  const collar = document.createElementNS(ns, "path");
  collar.setAttribute("d", "M42 8 Q50 16 58 8"); collar.setAttribute("class", "pc-jersey__collar");
  const stripe = document.createElementNS(ns, "path");
  stripe.setAttribute("d", "M29 52 L71 40 L71 50 L29 62 Z"); stripe.setAttribute("class", "pc-jersey__stripe");
  const t = document.createElementNS(ns, "text");
  t.setAttribute("x", "50"); t.setAttribute("y", "76"); t.setAttribute("class", "pc-jersey__txt");
  t.textContent = iniciales(player.nombres, player.apellidos);
  svg.append(shirt, stripe, collar, t);
  return svg;
}

function avatarNode(player) {
  const box = el("div", "pc__avatar");
  if (player.foto) {
    const img = el("img"); img.src = player.foto; img.alt = ""; img.decoding = "async"; img.draggable = false;
    box.append(img); box.classList.add("has-photo");
  } else box.append(jerseyAvatar(player));
  return box;
}

/** Sustituye el avatar por la foto cuando llega (carga diferida). */
export function setCardPhoto(card, player) {
  const old = card.querySelector(".pc__avatar"); if (!old) return;
  old.replaceWith(avatarNode(player));
}

/**
 * @param {{id:string,nombres:string,apellidos:string,numeroCamiseta:number|null,posicion:string,foto?:string|null,categoria?:string,historico?:boolean}} player
 * @param {string|null} estado
 * @param {{onSelect?:(id:string, estado:string)=>void, readOnly?:boolean, presentational?:boolean}} o
 *   presentational (HU-012): la MISMA tarjeta, sin botones de asistencia (solo identidad deportiva).
 */
export function createPlayer3DCard(player, estado, o = {}) {
  const nombre = `${player.nombres} ${player.apellidos}`.trim();
  const card = el("article", "pc"); card.dataset.id = player.id;
  card.setAttribute("aria-label", nombre);

  const scene = el("div", "pc__scene");
  const tilt = el("div", "pc__tilt");
  const face = (cls) => { const d = el("div", `pc__layer ${cls}`); return d; };

  const bg = face("pc__bg");                       // CAPA 1
  const holo = face("pc__holo");                   // CAPA 2
  const frame = face("pc__frame");                 // CAPA 3
  frame.innerHTML = '<svg viewBox="0 0 100 140" preserveAspectRatio="none" aria-hidden="true">'
    + '<polygon class="pc__rim" points="10,8 38,8 50,1 62,8 90,8 96,14 96,116 50,139 4,116 4,14"/>'
    + '<polygon class="pc__rim2" points="13,12 39,12 50,5.6 61,12 87,12 92,17 92,113.6 50,134 8,113.6 8,17"/></svg>';
  const av = avatarNode(player);                   // CAPA 4
  const top = el("div", "pc__layer pc__top");      // CAPA 5
  top.append(el("span", "pc__dorsal", player.numeroCamiseta ?? "–"), el("span", "pc__pos", posAbbr(player.posicion)));
  const name = el("div", "pc__layer pc__name");    // CAPA 6
  name.append(el("p", "pc__n", nombre), el("p", "pc__cat", player.historico ? `${player.categoria ?? ""} · histórico` : (player.categoria ?? "")));
  const st = el("div", "pc__layer pc__state");     // CAPA 7
  const glare = face("pc__glare");
  tilt.append(bg, holo, frame, av, top, name, st, glare);
  scene.append(tilt);

  if (o.presentational) {
    card.classList.add("pc--profile");
    card.append(scene);
    setCardEstado(card, estado);
    enableTilt(card, tilt);
    return card;
  }
  const actions = el("div", "pc__actions"); actions.setAttribute("role", "group"); actions.setAttribute("aria-label", `Asistencia de ${nombre}`);
  for (const e of ESTADOS) {
    const b = el("button", `pc__btn pc__btn--${ESTADO_INFO[e].key}`); b.type = "button"; b.dataset.estado = e;
    b.innerHTML = stateIcon(e, 18); b.append(el("span", "", ESTADO_INFO[e].label));
    b.setAttribute("aria-pressed", "false");
    b.disabled = !!o.readOnly;
    b.addEventListener("click", () => o.onSelect?.(player.id, e));
    actions.append(b);
  }
  card.append(scene, actions);
  setCardEstado(card, estado);
  enableTilt(card, tilt);
  return card;
}

export function setCardEstado(card, estado) {
  const key = stateKey(estado);
  card.dataset.state = key;
  const st = card.querySelector(".pc__state");
  st.innerHTML = `<span class="pc__badge">${stateIcon(estado, 15)}<span></span></span>`;
  st.querySelector("span span").textContent = stateLabel(estado);
  card.querySelectorAll(".pc__btn").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.estado === estado)));
  card.classList.remove("is-missing");
}

/** HU-012: tono y texto de la etiqueta (capa 7) para la tarjeta de perfil. */
export function setCardBadge(card, tone, text, icon = null) {
  card.dataset.state = tone;
  const st = card.querySelector(".pc__state");
  st.innerHTML = `<span class="pc__badge">${icon ? stateIcon(icon, 15) : ""}<span></span></span>`;
  st.querySelector("span span").textContent = text;
}

/* ---------------- Inclinación 3D (solo bajo interacción) ---------------- */
const canTilt = () => !matchMedia("(prefers-reduced-motion: reduce)").matches && matchMedia("(hover: hover) and (pointer: fine)").matches;

function enableTilt(card, tilt) {
  const scene = card.querySelector(".pc__scene");
  let raf = 0, px = 0.5, py = 0.5, rect = null;
  const paint = () => {
    raf = 0;
    const s = tilt.style;
    s.setProperty("--ry", `${((px - 0.5) * 2 * MAX_DEG).toFixed(2)}deg`);
    s.setProperty("--rx", `${(-(py - 0.5) * 2 * MAX_DEG).toFixed(2)}deg`);
    s.setProperty("--mx", `${(px * 100).toFixed(1)}%`);
    s.setProperty("--my", `${(py * 100).toFixed(1)}%`);
    s.setProperty("--lum", (0.5 - py) * 0.16 + (px - 0.5) * 0.06);
  };
  const move = (e) => {
    if (!rect) rect = scene.getBoundingClientRect();
    px = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    py = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    if (!raf) raf = requestAnimationFrame(paint);
  };
  scene.addEventListener("pointerenter", (e) => {
    if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
    if (!canTilt()) return;
    rect = scene.getBoundingClientRect();
    card.classList.add("is-tilting");
    scene.addEventListener("pointermove", move);
  });
  scene.addEventListener("pointerleave", () => {
    scene.removeEventListener("pointermove", move);
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    rect = null;
    card.classList.remove("is-tilting");
    ["--rx", "--ry", "--mx", "--my", "--lum"].forEach((p) => tilt.style.removeProperty(p));   // retorno suave (transición CSS)
  });
}
