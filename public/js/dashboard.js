/* ==========================================================
   CanchaControl — Dashboard por rol (HU-010 · Bloque A)
   ----------------------------------------------------------
   Administrador → "Panel de control"     (visión global, alcance ALL)
   Entrenador    → "Mi panel deportivo"   (solo SUS categorías: where entrenadorId == uid)
   Jugador       → "Mi espacio deportivo" (cadena uid → expediente → SU categoría)
   Las tarjetas son INFORMATIVAS (no filtran). Solo datos reales de Firestore:
   si no hay datos se muestra un estado vacío, nunca cifras inventadas.
   Cada lectura la autorizan firestore.rules; aquí solo se pinta (textContent).
   ========================================================== */
import { protectPage } from "./authGuard.js";
import { ROLE, canAccessPage, rolesForPage } from "./permissions.js";
import { auth, db } from "./auth.js";
import { mountShell } from "./shell.js";
import { subscribeUsers } from "./users.js";
import { subscribeCategorias, subscribeMisCategorias, rangoLabel, periodoLabel } from "./categorias-data.js";
import { subscribeJugadores, nombreCompleto } from "./jugadores-data.js";
import { proximasSesiones, sesionesRango, hoyISO } from "./entrenamientos-data.js";
import { contextoJugador } from "./mi-jugador.js";
import { renderCalendar, rangoMes } from "./calendar.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

/* ---------------- utilidades ---------------- */
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const hashIdx = (s, n) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % n; };
const toneOf = (c, id) => hashIdx(c?.nombreNormalizado || c?.nombre || id, 8);
const MES_CORTO = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const fmtN = (n) => new Intl.NumberFormat("es-CO").format(n);
const pct = (v, t) => (t ? Math.round((v / t) * 100) : 0);
const fechaDe = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
const fechaCorta = (iso) => new Intl.DateTimeFormat("es-CO", { weekday: "short", day: "numeric", month: "short" }).format(fechaDe(iso)).replace(/\./g, "");
const hace = (d) => {
  const s = Math.round((d.getTime() - Date.now()) / 1000), rtf = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
  const a = Math.abs(s);
  if (a < 60) return "hace un momento";
  if (a < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (a < 86400) return rtf.format(Math.round(s / 3600), "hour");
  if (a < 86400 * 30) return rtf.format(Math.round(s / 86400), "day");
  return new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "short", year: "numeric" }).format(d);
};

const SVG = (p, w = 2) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICON = {
  users: SVG('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20v-1a5.5 5.5 0 0 1 11 0v1"/><circle cx="17" cy="9" r="2.6"/><path d="M15.5 14.2A4.5 4.5 0 0 1 21.5 18.5v1"/>', 1.9),
  player: SVG('<circle cx="10" cy="6.5" r="3"/><path d="M4 20v-1.5A5.5 5.5 0 0 1 9.5 13h1A5.5 5.5 0 0 1 16 18.5V20"/><circle cx="19" cy="18" r="2.5"/>', 1.9),
  layers: SVG('<path d="m12 3 9 4.5-9 4.5-9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>', 1.9),
  whistle: SVG('<circle cx="9" cy="14" r="5"/><path d="M12.5 10.5 20 6v4l-5 2.5"/><path d="M4 7l2 2"/>', 1.9),
  calendar: SVG('<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><line x1="3.5" y1="10" x2="20.5" y2="10"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/>', 1.9),
  clock: SVG('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>'),
  pin: SVG('<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21z"/><circle cx="12" cy="10" r="2.3"/>'),
  user: SVG('<circle cx="12" cy="8" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/>'),
  check: SVG('<circle cx="12" cy="12" r="9"/><polyline points="8 12.5 11 15.5 16.5 9.5"/>'),
  pause: SVG('<circle cx="12" cy="12" r="9"/><line x1="10" y1="9" x2="10" y2="15"/><line x1="14" y1="9" x2="14" y2="15"/>'),
  alert: SVG('<path d="M12 3 2.5 20h19z"/><line x1="12" y1="10" x2="12" y2="14"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>'),
  arrow: SVG('<polyline points="9 6 15 12 9 18"/>', 2.2),
  activity: SVG('<polyline points="3 12 7 12 10 5 14 19 17 12 21 12"/>'),
  plus: SVG('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>', 2.2),
  wifi: SVG('<path d="M2 8.5a15 15 0 0 1 20 0"/><path d="M5.5 12a10 10 0 0 1 13 0"/><path d="M9 15.5a5 5 0 0 1 6 0"/><line x1="3" y1="3" x2="21" y2="21"/>'),
};

/* ---------------- tooltip compartido (hover y foco) ---------------- */
function tip(target, text) {
  const t = $("dz-tip");
  const show = () => {
    t.textContent = text; t.hidden = false;
    const r = target.getBoundingClientRect(), tw = t.offsetWidth, th = t.offsetHeight;
    let x = r.left + r.width / 2 - tw / 2; x = Math.max(8, Math.min(x, window.innerWidth - tw - 8));
    let y = r.top - th - 8; if (y < 8) y = r.bottom + 8;
    t.style.left = `${x}px`; t.style.top = `${y}px`;
  };
  const hide = () => { t.hidden = true; };
  target.addEventListener("mouseenter", show); target.addEventListener("mouseleave", hide);
  target.addEventListener("focus", show); target.addEventListener("blur", hide);
  target.setAttribute("aria-label", text);
}

/* ---------------- InfoKpiCard (informativa, no interactiva) ---------------- */
function kpi({ id, tone, icon, label, text = false }) {
  const a = el("article", `kpi kpi--${tone} kpi--info dash-kpi`);
  const ic = el("span", "kpi__icon"); ic.setAttribute("aria-hidden", "true"); ic.innerHTML = ICON[icon];
  const body = el("span", "kpi__body");
  const v = el("span", `kpi__value${text ? " kpi__value--text" : ""}`); v.id = id;
  v.append(el("span", "skel skel--num"));
  const l = el("span", "kpi__label", label);
  const s = el("span", "kpi__sub"); s.id = `${id}-sub`;
  body.append(v, l, s); a.append(ic, body);
  return a;
}
function setKpi(id, value, sub = "") {
  const v = $(id); if (!v) return;
  v.textContent = value; v.title = typeof value === "string" ? value : "";
  $(`${id}-sub`).textContent = sub;
}

/* ---------------- Panel / estados ---------------- */
function panel(id, title, { span = 6, action } = {}) {
  const s = el("section", `panel-card dash-panel dash-span-${span}`); s.id = id; s.setAttribute("aria-labelledby", `${id}-t`);
  const h = el("header", "dash-panel__head");
  const t = el("h2", "dash-panel__title", title); t.id = `${id}-t`;
  h.append(t);
  if (action) { const a = el("a", "dash-panel__link", action.label); a.href = action.href; a.insertAdjacentHTML("beforeend", ICON.arrow); h.append(a); }
  const b = el("div", "dash-panel__body"); b.id = `${id}-b`; b.setAttribute("aria-live", "polite");
  s.append(h, b);
  skeleton(b);
  return s;
}
function skeleton(body, n = 3) {
  const w = el("div", "dash-skel"); w.setAttribute("aria-busy", "true");
  w.append(el("span", "sr-only", "Cargando…"));
  for (let i = 0; i < n; i++) w.append(el("span", "skel dash-skel__row"));
  body.replaceChildren(w);
}
function empty(body, { icon = "calendar", title, text }) {
  const w = el("div", "dash-empty");
  const i = el("span", "dash-empty__icon"); i.setAttribute("aria-hidden", "true"); i.innerHTML = ICON[icon];
  w.append(i, el("p", "dash-empty__title", title));
  if (text) w.append(el("p", "dash-empty__text", text));
  body.replaceChildren(w);
}
function failed(body) {
  empty(body, { icon: "wifi", title: "No fue posible cargar esta información.", text: "Revisa tu conexión e intenta nuevamente en unos minutos." });
  body.firstChild.classList.add("is-error");
}

/* ---------------- Componentes de contenido ---------------- */
function sesionesList(body, list, { cats, coachName, limit = 5, showCat = true }) {
  if (!list.length) return false;
  const hoy = hoyISO();
  const ul = el("ul", "dash-ses");
  for (const s of list.slice(0, limit)) {
    const c = cats.get(s.categoriaId);
    const li = el("li", "dash-ses__item");
    const [, m, d] = s.fecha.split("-");
    const date = el("span", `ses-date tile-${toneOf(c, s.categoriaId)}`);
    date.append(el("span", "ses-date__d", String(Number(d))), el("span", "ses-date__m", MES_CORTO[Number(m) - 1]));
    const main = el("div", "ses-main");
    main.append(el("p", "ses-main__t", showCat ? (c?.nombre ?? "Categoría") : fechaCorta(s.fecha)));
    const sub = el("p", "ses-main__s");
    const bit = (icon, txt) => { const sp = el("span"); sp.innerHTML = ICON[icon].replace("<svg ", '<svg width="14" height="14" aria-hidden="true" '); sp.append(document.createTextNode(txt)); return sp; };
    sub.append(bit("clock", `${s.horaInicio} – ${s.horaFin}`), bit("pin", s.lugar));
    if (coachName) { const n = coachName(s, c); if (n) sub.append(bit("whistle", n)); }
    main.append(sub);
    li.append(date, main);
    if (s.fecha === hoy) li.append(el("span", "badge badge--success", "Hoy"));
    ul.append(li);
  }
  body.replaceChildren(ul);
  if (list.length > limit) body.append(el("p", "dash-more", `y ${list.length - limit} sesión${list.length - limit === 1 ? "" : "es"} más programada${list.length - limit === 1 ? "" : "s"}.`));
  return true;
}

/** Barras horizontales de un solo tono (magnitud). Etiqueta directa al final. */
function barsChart(body, rows, unit) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const total = rows.reduce((a, r) => a + r.value, 0);
  const ul = el("ul", "dz-bars"); ul.setAttribute("aria-label", `Distribución de ${unit}`);
  for (const r of rows) {
    const li = el("li", `dz-bars__row${r.muted ? " is-muted" : ""}`);
    li.append(el("span", "dz-bars__label", r.label));
    const track = el("span", "dz-bars__track");
    const fill = el("span", "dz-bars__fill"); fill.style.setProperty("--w", `${Math.max(r.value ? 2 : 0, (r.value / max) * 100)}%`);
    fill.tabIndex = 0;
    tip(fill, `${r.label}: ${fmtN(r.value)} ${unit} (${pct(r.value, total)} %)`);
    track.append(fill);
    li.append(track, el("span", "dz-bars__value", fmtN(r.value)));
    ul.append(li);
  }
  body.replaceChildren(ul);
}

/** Barra apilada 100 % + leyenda con valores (identidad nunca solo por color). */
function stackChart(body, segs, foot) {
  const total = segs.reduce((a, s) => a + s.value, 0);
  const wrap = el("div", "dz-stack");
  const bar = el("div", "dz-stack__bar"); bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", segs.map((s) => `${s.label}: ${s.value}`).join(", "));
  for (const s of segs) {
    if (!s.value) continue;
    const seg = el("span", "dz-stack__seg"); seg.style.flexGrow = String(s.value); seg.style.background = s.color; seg.tabIndex = 0;
    tip(seg, `${s.label}: ${fmtN(s.value)} (${pct(s.value, total)} %)`);
    bar.append(seg);
  }
  const lg = el("ul", "dz-legend");
  for (const s of segs) {
    const li = el("li", "dz-legend__item");
    const sw = el("span", "dz-legend__sw"); sw.style.background = s.color; sw.setAttribute("aria-hidden", "true");
    li.append(sw, el("span", "dz-legend__label", s.label), el("strong", "dz-legend__val", fmtN(s.value)), el("span", "dz-legend__pct", `${pct(s.value, total)} %`));
    lg.append(li);
  }
  wrap.append(el("p", "dz-stack__total", `${fmtN(total)} en total`), bar, lg);
  if (foot) wrap.append(el("p", "dz-foot", foot));
  body.replaceChildren(wrap);
}

function statusRows(body, rows) {
  const ul = el("ul", "dz-status");
  for (const r of rows) {
    const li = el("li", `dz-status__row is-${r.kind}`);
    const i = el("span", "dz-status__icon"); i.setAttribute("aria-hidden", "true"); i.innerHTML = ICON[r.icon];
    const t = el("div", "dz-status__txt"); t.append(el("span", "dz-status__label", r.label));
    if (r.help) t.append(el("span", "dz-status__help", r.help));
    li.append(i, t, el("strong", "dz-status__val", fmtN(r.value)));
    ul.append(li);
  }
  body.replaceChildren(ul);
}

function quickLinks(body, items) {
  const ul = el("ul", "dash-quick");
  for (const it of items) {
    const li = el("li");
    const a = el("a", "dash-quick__item"); a.href = it.href; if (it.id) a.id = it.id;
    const i = el("span", `dash-quick__icon tile-${it.tone}`); i.setAttribute("aria-hidden", "true"); i.innerHTML = ICON[it.icon];
    const t = el("span", "dash-quick__txt"); t.append(el("span", "dash-quick__label", it.label), el("span", "dash-quick__desc", it.desc));
    const go = el("span", "dash-quick__go"); go.setAttribute("aria-hidden", "true"); go.innerHTML = ICON.arrow;
    a.append(i, t, go); li.append(a); ul.append(li);
  }
  body.replaceChildren(ul);
}

function detailList(body, rows) {
  const dl = el("dl", "dash-dl");
  for (const [k, v] of rows) { const d = el("div"); d.append(el("dt", "", k), el("dd", "", v || "—")); dl.append(d); }
  body.replaceChildren(dl);
}

function hero(title, subtitle) {
  $("dash-title").textContent = title;
  $("dash-subtitle").textContent = subtitle;
  const s = new Intl.DateTimeFormat("es-CO", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date());
  $("dash-date").textContent = s[0].toUpperCase() + s.slice(1);
  document.title = `${title} · CanchaControl`;
}

/* ==========================================================
   ADMINISTRADOR — Panel de control
   ========================================================== */
function startAdmin(profile) {
  hero("Panel de control", "Resumen general de la actividad de CanchaControl.");
  $("dash-kpis").append(
    kpi({ id: "k-users", tone: "blue", icon: "users", label: "Usuarios registrados" }),
    kpi({ id: "k-jug", tone: "violet", icon: "player", label: "Jugadores registrados" }),
    kpi({ id: "k-coach", tone: "green", icon: "whistle", label: "Entrenadores activos" }),
    kpi({ id: "k-cats", tone: "amber", icon: "layers", label: "Categorías activas" }),
    kpi({ id: "k-ses", tone: "gray", icon: "calendar", label: "Entrenamientos programados" }),
  );
  $("dash-grid").append(
    panel("p-next", "Próximos entrenamientos", { span: 7, action: { href: "entrenamientos.html", label: "Ver calendario" } }),
    panel("p-users", "Distribución de usuarios", { span: 5 }),
    panel("p-jpc", "Jugadores por categoría", { span: 7 }),
    panel("p-cstate", "Estado de categorías", { span: 5 }),
    panel("p-act", "Actividad reciente", { span: 7 }),
    panel("p-quick", "Accesos rápidos", { span: 5 }),
  );
  const items = [
    { href: "usuarios.html", id: "users-link", label: "Usuarios", desc: "Cuentas, roles y estados", icon: "users", tone: 1, page: "usuarios" },
    { href: "jugadores.html", label: "Jugadores", desc: "Expedientes y categorías", icon: "player", tone: 2, page: "jugadores" },
    { href: "categorias.html", label: "Categorías", desc: "Grupos y entrenadores", icon: "layers", tone: 0, page: "categorias" },
    { href: "entrenamientos.html", label: "Entrenamientos", desc: "Calendario de sesiones", icon: "calendar", tone: 3, page: "entrenamientos" },
  ].filter((i) => canAccessPage(profile, rolesForPage(i.page)));
  quickLinks($("p-quick-b"), items);

  const st = { users: null, cats: null, jugs: null, ses: null, err: {}, catKey: null, seq: 0 };
  const catMap = () => new Map((st.cats ?? []).map((c) => [c.id, c]));
  const userMap = () => new Map((st.users ?? []).map((u) => [u.uid, u]));

  const draw = () => {
    // KPIs
    if (st.users) {
      setKpi("k-users", fmtN(st.users.length), `${fmtN(st.users.filter((u) => u.estado === "Activo").length)} activos`);
      setKpi("k-coach", fmtN(st.users.filter((u) => u.rol === ROLE.ENTRENADOR && u.estado === "Activo").length), `de ${fmtN(st.users.filter((u) => u.rol === ROLE.ENTRENADOR).length)} entrenadores`);
    } else if (st.err.users) { setKpi("k-users", "—", "Sin conexión"); setKpi("k-coach", "—", "Sin conexión"); }
    if (st.jugs) setKpi("k-jug", fmtN(st.jugs.length), `${fmtN(st.jugs.filter((j) => j.estado === "Activo").length)} activos`);
    else if (st.err.jugs) setKpi("k-jug", "—", "Sin conexión");
    if (st.cats) setKpi("k-cats", fmtN(st.cats.filter((c) => c.estado === "Activa").length), `de ${fmtN(st.cats.length)} categorías`);
    else if (st.err.cats) setKpi("k-cats", "—", "Sin conexión");
    if (st.ses) setKpi("k-ses", fmtN(st.ses.length), "Desde hoy");
    else if (st.err.ses || st.err.cats) setKpi("k-ses", "—", "Sin conexión");

    // Próximos entrenamientos
    const bNext = $("p-next-b");
    if (st.err.ses || st.err.cats) failed(bNext);
    else if (st.ses && st.users) {
      const um = userMap();
      if (!sesionesList(bNext, st.ses, { cats: catMap(), coachName: (s) => um.get(s.entrenadorId)?.nombre ?? "" }))
        empty(bNext, { icon: "calendar", title: "No hay entrenamientos programados.", text: "Cuando los entrenadores programen sesiones aparecerán aquí." });
    }

    // Distribución de usuarios
    const bU = $("p-users-b");
    if (st.err.users) failed(bU);
    else if (st.users) {
      if (!st.users.length) empty(bU, { icon: "users", title: "Aún no hay usuarios registrados." });
      else {
        const c = (r) => st.users.filter((u) => u.rol === r).length;
        const inac = st.users.filter((u) => u.estado !== "Activo").length;
        stackChart(bU, [
          { label: "Administradores", value: c(ROLE.ADMIN), color: "var(--cc-series-1)" },
          { label: "Entrenadores", value: c(ROLE.ENTRENADOR), color: "var(--cc-series-2)" },
          { label: "Jugadores", value: c(ROLE.JUGADOR), color: "var(--cc-series-3)" },
        ], `${fmtN(st.users.length - inac)} activos · ${fmtN(inac)} inactivos`);
      }
    }

    // Jugadores por categoría
    const bJ = $("p-jpc-b");
    if (st.err.jugs || st.err.cats) failed(bJ);
    else if (st.jugs && st.cats) {
      if (!st.jugs.length) empty(bJ, { icon: "player", title: "Aún no hay jugadores registrados.", text: "Los expedientes se crean desde el módulo Jugadores." });
      else {
        const cm = catMap(), by = new Map();
        let sin = 0;
        for (const j of st.jugs) { if (j.categoriaId && cm.has(j.categoriaId)) by.set(j.categoriaId, (by.get(j.categoriaId) ?? 0) + 1); else sin++; }
        let rows = [...by].map(([id, v]) => ({ label: cm.get(id).nombre, value: v })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, "es"));
        if (rows.length > 7) { const rest = rows.slice(6); rows = rows.slice(0, 6); rows.push({ label: `Otras (${rest.length})`, value: rest.reduce((a, r) => a + r.value, 0) }); }
        if (sin) rows.push({ label: "Sin categoría", value: sin, muted: true });
        barsChart(bJ, rows, "jugadores");
      }
    }

    // Estado de categorías
    const bC = $("p-cstate-b");
    if (st.err.cats) failed(bC);
    else if (st.cats) {
      if (!st.cats.length) empty(bC, { icon: "layers", title: "Aún no hay categorías creadas." });
      else statusRows(bC, [
        { kind: "ok", icon: "check", label: "Activas", value: st.cats.filter((c) => c.estado === "Activa").length },
        { kind: "off", icon: "pause", label: "Inactivas", value: st.cats.filter((c) => c.estado !== "Activa").length },
        { kind: "warn", icon: "alert", label: "Sin entrenador", help: "Requieren asignación", value: st.cats.filter((c) => !c.entrenadorId).length },
      ]);
    }

    // Actividad reciente (solo eventos con fecha real de creación)
    const bA = $("p-act-b");
    if (st.users && st.cats && st.jugs) {
      const cm = catMap(), ev = [];
      for (const u of st.users) if (u.createdAt) ev.push({ at: u.createdAt, icon: "user", tone: 1, t: `Nuevo usuario: ${u.nombre}`, s: u.rol });
      for (const c of st.cats) if (c.createdAt) ev.push({ at: c.createdAt, icon: "layers", tone: 0, t: `Categoría creada: ${c.nombre}`, s: c.codigoGrupo });
      for (const j of st.jugs) if (j.createdAtMs) ev.push({ at: new Date(j.createdAtMs), icon: "player", tone: 2, t: `Expediente registrado: ${nombreCompleto(j)}`, s: j.categoriaId ? (cm.get(j.categoriaId)?.nombre ?? "") : "Sin categoría" });
      for (const s of st.ses ?? []) if (s.createdAt) ev.push({ at: s.createdAt, icon: "calendar", tone: 3, t: `Sesión programada: ${cm.get(s.categoriaId)?.nombre ?? "Categoría"}`, s: `${fechaCorta(s.fecha)} · ${s.horaInicio}` });
      ev.sort((a, b) => b.at - a.at);
      if (!ev.length) empty(bA, { icon: "activity", title: "Aún no hay actividad registrada." });
      else {
        const ul = el("ul", "dash-act");
        for (const e of ev.slice(0, 6)) {
          const li = el("li", "dash-act__item");
          const i = el("span", `dash-act__icon tile-${e.tone}`); i.setAttribute("aria-hidden", "true"); i.innerHTML = ICON[e.icon];
          const t = el("div", "dash-act__txt"); t.append(el("p", "dash-act__t", e.t), el("p", "dash-act__s", e.s));
          const tm = el("time", "dash-act__time", hace(e.at)); tm.dateTime = e.at.toISOString();
          li.append(i, t, tm); ul.append(li);
        }
        bA.replaceChildren(ul);
      }
    } else if (st.err.users || st.err.cats || st.err.jugs) failed(bA);
  };

  const loadSes = async () => {
    const ids = (st.cats ?? []).map((c) => c.id).sort();
    const key = ids.join("|");
    if (key === st.catKey) return;
    st.catKey = key;
    const seq = ++st.seq;
    try { const list = ids.length ? await proximasSesiones(ids) : []; if (seq === st.seq) { st.ses = list; st.err.ses = false; } }
    catch { if (seq === st.seq) st.err.ses = true; }
    draw();
  };

  subscribeUsers((l) => { st.users = l; st.err.users = false; draw(); }, () => { st.err.users = true; draw(); });
  subscribeJugadores((l) => { st.jugs = l; st.err.jugs = false; draw(); }, () => { st.err.jugs = true; draw(); });
  subscribeCategorias((l) => { st.cats = l; st.err.cats = false; draw(); loadSes(); }, () => { st.err.cats = true; draw(); });
}

/* ==========================================================
   ENTRENADOR — Mi panel deportivo (solo SUS categorías)
   ========================================================== */
function startCoach(profile, uid) {
  hero("Mi panel deportivo", "Tus categorías, tus jugadores y tus próximas sesiones.");
  $("dash-kpis").append(
    kpi({ id: "k-mis", tone: "green", icon: "layers", label: "Mis categorías" }),
    kpi({ id: "k-jug", tone: "violet", icon: "player", label: "Jugadores de mis categorías" }),
    kpi({ id: "k-sem", tone: "blue", icon: "clock", label: "Entrenamientos próximos 7 días" }),
    kpi({ id: "k-ses", tone: "amber", icon: "calendar", label: "Sesiones programadas" }),
  );
  $("dash-grid").append(
    panel("p-next", "Próximas sesiones", { span: 7, action: { href: "entrenamientos.html", label: "Ver calendario" } }),
    panel("p-dist", "Jugadores por categoría", { span: 5 }),
    panel("p-cats", "Mis categorías", { span: 7, action: { href: "categorias.html", label: "Ver todas" } }),
    panel("p-quick", "Accesos rápidos", { span: 5 }),
  );
  quickLinks($("p-quick-b"), [
    { href: "jugadores.html", label: "Mis jugadores", desc: "Fichas deportivas de tus categorías", icon: "player", tone: 2 },
    { href: "entrenamientos.html", label: "Entrenamientos", desc: "Programa y consulta sesiones", icon: "calendar", tone: 3 },
    { href: "categorias.html", label: "Mis categorías", desc: "Grupos que diriges", icon: "layers", tone: 0 },
  ]);

  const st = { cats: null, counts: null, ses: null, err: {}, key: null, seq: 0 };
  const draw = () => {
    const cats = st.cats ?? [], cm = new Map(cats.map((c) => [c.id, c]));
    if (st.cats) setKpi("k-mis", fmtN(cats.length), `${fmtN(cats.filter((c) => c.estado === "Activa").length)} activas`);
    else if (st.err.cats) setKpi("k-mis", "—", "Sin conexión");
    if (st.counts) setKpi("k-jug", fmtN([...st.counts.values()].reduce((a, b) => a + b, 0)), "En nómina");
    else if (st.err.counts || st.err.cats) setKpi("k-jug", "—", "Sin conexión");
    if (st.ses) {
      const lim = new Date(); lim.setDate(lim.getDate() + 7);
      const limISO = `${lim.getFullYear()}-${String(lim.getMonth() + 1).padStart(2, "0")}-${String(lim.getDate()).padStart(2, "0")}`;
      setKpi("k-sem", fmtN(st.ses.filter((s) => s.fecha <= limISO).length), st.ses[0] ? `Próximo: ${fechaCorta(st.ses[0].fecha)} · ${st.ses[0].horaInicio}` : "Sin sesiones");
      setKpi("k-ses", fmtN(st.ses.length), "Desde hoy");
    } else if (st.err.ses || st.err.cats) { setKpi("k-sem", "—", "Sin conexión"); setKpi("k-ses", "—", "Sin conexión"); }

    const bN = $("p-next-b");
    if (st.err.cats || st.err.ses) failed(bN);
    else if (st.cats && !cats.length) empty(bN, { icon: "layers", title: "Aún no tienes categorías asignadas.", text: "La administración debe asignarte una categoría para programar sesiones." });
    else if (st.ses && !sesionesList(bN, st.ses, { cats: cm }))
      empty(bN, { icon: "calendar", title: "No tienes sesiones programadas.", text: "Programa la próxima desde Entrenamientos." });

    const bD = $("p-dist-b");
    if (st.err.cats || st.err.counts) failed(bD);
    else if (st.cats && !cats.length) empty(bD, { icon: "player", title: "Sin categorías asignadas." });
    else if (st.counts) {
      const rows = cats.map((c) => ({ label: c.nombre, value: st.counts.get(c.id) ?? 0 })).sort((a, b) => b.value - a.value);
      if (!rows.some((r) => r.value)) empty(bD, { icon: "player", title: "Tus categorías aún no tienen jugadores." });
      else barsChart(bD, rows, "jugadores");
    }

    const bC = $("p-cats-b");
    if (st.err.cats) failed(bC);
    else if (st.cats) {
      if (!cats.length) empty(bC, { icon: "layers", title: "Aún no tienes categorías asignadas." });
      else {
        const ul = el("ul", "dash-cats");
        for (const c of cats) {
          const li = el("li", "dash-cats__item");
          const tile = el("span", `dash-cats__tile tile-${toneOf(c, c.id)}`, (c.codigoGrupo || c.nombre).slice(0, 3)); tile.setAttribute("aria-hidden", "true");
          const t = el("div", "dash-cats__txt"); t.append(el("p", "dash-cats__n", c.nombre), el("p", "dash-cats__s", `${c.codigoGrupo} · ${rangoLabel(c)} · ${periodoLabel(c.periodoLectivo)}`));
          const n = el("span", "dash-cats__count", st.counts ? `${fmtN(st.counts.get(c.id) ?? 0)} jug.` : "…");
          const b = el("span", `badge ${c.estado === "Activa" ? "badge--success" : "badge--neutral"}`, c.estado);
          li.append(tile, t, n, b); ul.append(li);
        }
        bC.replaceChildren(ul);
      }
    }
  };

  const loadExtras = async () => {
    const ids = (st.cats ?? []).map((c) => c.id).sort(); const key = ids.join("|");
    if (key === st.key) return; st.key = key; const seq = ++st.seq;
    await Promise.all([
      (async () => {
        try {
          const pairs = await Promise.all(ids.map(async (id) => [id, (await getDocs(collection(db, "categorias", id, "nomina"))).size]));
          if (seq === st.seq) { st.counts = new Map(pairs); st.err.counts = false; }
        } catch { if (seq === st.seq) st.err.counts = true; }
      })(),
      (async () => {
        try { const l = ids.length ? await proximasSesiones(ids) : []; if (seq === st.seq) { st.ses = l; st.err.ses = false; } }
        catch { if (seq === st.seq) st.err.ses = true; }
      })(),
    ]);
    draw();
  };

  subscribeMisCategorias(uid, (l) => { st.cats = l; st.err.cats = false; draw(); loadExtras(); }, () => { st.err.cats = true; draw(); });
}

/* ==========================================================
   JUGADOR — Mi espacio deportivo (solo SU categoría)
   ========================================================== */
async function startPlayer(profile, uid) {
  hero("Mi espacio deportivo", "Tu categoría, tu entrenador y tus próximos entrenamientos.");
  $("dash-kpis").append(
    kpi({ id: "k-cat", tone: "green", icon: "layers", label: "Mi categoría", text: true }),
    kpi({ id: "k-coach", tone: "blue", icon: "whistle", label: "Entrenador principal", text: true }),
    kpi({ id: "k-next", tone: "violet", icon: "clock", label: "Próximo entrenamiento", text: true }),
    kpi({ id: "k-ses", tone: "amber", icon: "calendar", label: "Sesiones programadas" }),
  );
  $("dash-grid").append(
    panel("p-next", "Mis próximas actividades", { span: 7, action: { href: "entrenamientos.html", label: "Ver entrenamientos" } }),
    panel("p-info", "Información de mi categoría", { span: 5 }),
    panel("p-cal", "Calendario personal", { span: 7 }),
    panel("p-quick", "Accesos rápidos", { span: 5 }),
  );
  quickLinks($("p-quick-b"), [
    { href: "entrenamientos.html", label: "Entrenamientos", desc: "Sesiones de tu categoría", icon: "calendar", tone: 3 },
  ]);

  let ctx;
  try { ctx = await contextoJugador(uid); }
  catch {
    ["k-cat", "k-coach", "k-next", "k-ses"].forEach((k) => setKpi(k, "—", "Sin conexión"));
    ["p-next-b", "p-info-b", "p-cal-b"].forEach((b) => failed($(b)));
    return;
  }
  if (ctx.estado !== "ok") {
    const sinExp = ctx.estado === "sin-expediente";
    setKpi("k-cat", "Sin asignar", sinExp ? "Expediente pendiente" : "Pendiente de asignación");
    setKpi("k-coach", "—"); setKpi("k-next", "—"); setKpi("k-ses", "0");
    const msg = sinExp
      ? { icon: "user", title: "Tu expediente deportivo aún no está registrado.", text: "Comunícate con la administración de la escuela." }
      : { icon: "layers", title: "Aún no estás asignado a una categoría.", text: "Cuando la administración te asigne, verás aquí tus entrenamientos." };
    ["p-next-b", "p-info-b", "p-cal-b"].forEach((b) => empty($(b), msg));
    return;
  }
  const { categoria: c, entrenador } = ctx;
  const cm = new Map([[c.id, c]]);
  setKpi("k-cat", c.nombre, `${c.codigoGrupo} · ${periodoLabel(c.periodoLectivo)}`);
  setKpi("k-coach", entrenador?.nombre || "Sin asignar", entrenador ? `Responsable de ${c.nombre}` : "Pendiente de asignación");
  detailList($("p-info-b"), [
    ["Categoría", c.nombre], ["Código de grupo", c.codigoGrupo], ["Periodo lectivo", periodoLabel(c.periodoLectivo)],
    ["Rango", rangoLabel(c)], ["Entrenador principal", entrenador?.nombre || "Sin asignar"], ["Estado", c.estado],
  ]);

  try {
    const prox = await proximasSesiones([c.id]);
    const n = prox[0];
    setKpi("k-next", n ? fechaCorta(n.fecha) : "Sin programar", n ? `${n.horaInicio} – ${n.horaFin} · ${n.lugar}` : "Aún no hay sesiones");
    setKpi("k-ses", fmtN(prox.length), "Desde hoy");
    if (!sesionesList($("p-next-b"), prox, { cats: cm, showCat: false }))
      empty($("p-next-b"), { icon: "calendar", title: "No tienes entrenamientos programados.", text: "Tu entrenador aún no ha programado sesiones." });
  } catch {
    setKpi("k-next", "—", "Sin conexión"); setKpi("k-ses", "—", "Sin conexión"); failed($("p-next-b"));
  }

  // Calendario personal (solo lectura) con las sesiones del mes de SU categoría
  const now = new Date();
  const cal = { year: now.getFullYear(), month: now.getMonth(), selected: null, list: [], seq: 0 };
  const box = el("div", "cal dash-cal"); const dayList = el("div", "dash-cal__day"); dayList.setAttribute("aria-live", "polite");
  const paintDay = () => {
    if (!cal.selected) { dayList.replaceChildren(el("p", "dash-cal__hint", "Selecciona un día para ver sus sesiones.")); return; }
    const l = cal.list.filter((s) => s.fecha === cal.selected);
    if (!l.length) { dayList.replaceChildren(el("p", "dash-cal__hint", `Sin sesiones el ${fechaCorta(cal.selected)}.`)); return; }
    sesionesList(dayList, l, { cats: cm, showCat: false, limit: 10 });
  };
  const paint = () => {
    renderCalendar(box, {
      year: cal.year, month: cal.month, today: hoyISO(), selected: cal.selected,
      events: cal.list.map((s) => ({ fecha: s.fecha, label: s.horaInicio, tone: toneOf(c, c.id), id: s.id })),
      onSelect: (iso) => { cal.selected = iso; paint(); },
      onMonth: (d) => { if (d === 0) { cal.year = now.getFullYear(); cal.month = now.getMonth(); } else { const x = new Date(cal.year, cal.month + d, 1); cal.year = x.getFullYear(); cal.month = x.getMonth(); } cal.selected = null; load(); },
    });
    paintDay();
  };
  const load = async () => {
    const seq = ++cal.seq;
    try { const [a, b] = rangoMes(cal.year, cal.month); const l = await sesionesRango([c.id], a, b); if (seq !== cal.seq) return; cal.list = l; paint(); }
    catch { if (seq === cal.seq) failed($("p-cal-b")); }
  };
  $("p-cal-b").replaceChildren(box, dayList);
  await load();
}

/* ---------------- arranque ---------------- */
protectPage({
  page: "dashboard",
  onReady(profile) {
    mountShell(profile, "dashboard");
    $("user-name").textContent = profile.nombre;
    $("user-role").textContent = profile.rol;
    const uid = auth.currentUser?.uid;
    if (profile.rol === ROLE.ADMIN) startAdmin(profile);
    else if (profile.rol === ROLE.ENTRENADOR) startCoach(profile, uid);
    else startPlayer(profile, uid);
  },
});
