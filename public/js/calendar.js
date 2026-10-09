/* ==========================================================
   CanchaControl — TrainingCalendar (HU-010)
   Calendario mensual en HTML/CSS/JS vanilla (lunes a domingo).
   Cada día es un botón; los eventos se pintan con el color de su categoría.
   ========================================================== */
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const DIAS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const p2 = (n) => String(n).padStart(2, "0");
export const mesLabel = (y, m) => `${MESES[m][0].toUpperCase()}${MESES[m].slice(1)} ${y}`;
export const rangoMes = (y, m) => [`${y}-${p2(m + 1)}-01`, `${y}-${p2(m + 1)}-${p2(new Date(y, m + 1, 0).getDate())}`];

/**
 * @param {HTMLElement} el
 * @param {{year:number, month:number, today:string, selected:string|null,
 *          events:Array<{fecha:string,label:string,tone:number,id:string}>,
 *          onSelect:(iso:string|null)=>void, onMonth:(delta:number)=>void}} o
 */
export function renderCalendar(el, o) {
  const first = new Date(o.year, o.month, 1);
  const offset = (first.getDay() + 6) % 7;                   // lunes = 0
  const days = new Date(o.year, o.month + 1, 0).getDate();
  const byDay = new Map();
  for (const e of o.events) { if (!byDay.has(e.fecha)) byDay.set(e.fecha, []); byDay.get(e.fecha).push(e); }

  const head = document.createElement("div"); head.className = "cal__head";
  const title = document.createElement("h2"); title.className = "cal__title"; title.id = "cal-title"; title.textContent = mesLabel(o.year, o.month);
  const nav = document.createElement("div"); nav.className = "cal__nav";
  const btn = (label, aria, fn) => { const b = document.createElement("button"); b.type = "button"; b.className = "cal__navbtn"; b.innerHTML = label; b.setAttribute("aria-label", aria); b.addEventListener("click", fn); return b; };
  const arrow = (d) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><polyline points="${d}"/></svg>`;
  const hoyBtn = btn("Hoy", "Ir al mes actual", () => o.onMonth(0));
  hoyBtn.classList.add("cal__today");
  nav.append(btn(arrow("15 18 9 12 15 6"), "Mes anterior", () => o.onMonth(-1)), hoyBtn, btn(arrow("9 18 15 12 9 6"), "Mes siguiente", () => o.onMonth(1)));
  head.append(title, nav);

  const grid = document.createElement("div"); grid.className = "cal__grid"; grid.setAttribute("role", "grid"); grid.setAttribute("aria-labelledby", "cal-title");
  DIAS.forEach((d) => { const h = document.createElement("div"); h.className = "cal__dow"; h.textContent = d; h.setAttribute("role", "columnheader"); grid.append(h); });
  for (let i = 0; i < offset; i++) { const e = document.createElement("div"); e.className = "cal__cell is-out"; e.setAttribute("aria-hidden", "true"); grid.append(e); }
  for (let d = 1; d <= days; d++) {
    const iso = `${o.year}-${p2(o.month + 1)}-${p2(d)}`;
    const evs = byDay.get(iso) ?? [];
    const cell = document.createElement("button");
    cell.type = "button"; cell.className = "cal__cell"; cell.dataset.date = iso; cell.setAttribute("role", "gridcell");
    if (iso === o.today) cell.classList.add("is-today");
    if (iso < o.today) cell.classList.add("is-past");
    if (iso === o.selected) { cell.classList.add("is-selected"); cell.setAttribute("aria-pressed", "true"); } else cell.setAttribute("aria-pressed", "false");
    cell.setAttribute("aria-label", `${d} de ${MESES[o.month]}${evs.length ? `, ${evs.length} ${evs.length === 1 ? "sesión" : "sesiones"}` : ""}`);
    const n = document.createElement("span"); n.className = "cal__n"; n.textContent = String(d);
    cell.append(n);
    const chips = document.createElement("span"); chips.className = "cal__chips"; chips.setAttribute("aria-hidden", "true");
    evs.slice(0, 2).forEach((e) => { const c = document.createElement("span"); c.className = `cal__chip tile-${e.tone}`; c.textContent = e.label; chips.append(c); });
    if (evs.length > 2) { const m = document.createElement("span"); m.className = "cal__more"; m.textContent = `+${evs.length - 2}`; chips.append(m); }
    const dots = document.createElement("span"); dots.className = "cal__dots"; dots.setAttribute("aria-hidden", "true");
    evs.slice(0, 3).forEach((e) => { const c = document.createElement("span"); c.className = `cal__dot tile-${e.tone}`; dots.append(c); });
    cell.append(chips, dots);
    cell.addEventListener("click", () => o.onSelect(iso === o.selected ? null : iso));
    grid.append(cell);
  }
  el.replaceChildren(head, grid);
}
