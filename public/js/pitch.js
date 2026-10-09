/* ==========================================================
   CanchaControl — Cancha táctica interactiva (HU-013)
   ----------------------------------------------------------
   Alineación LIBRE: no hay formaciones impuestas. Cada titular tiene
   coordenadas relativas (x, y ∈ [0, 1]; portería propia abajo, y = 1).
   Interacción:
     · Arrastrar (mouse, lápiz o dedo): mover, intercambiar (soltar sobre otro
       jugador) o enviar al banco (soltar sobre el banco).
     · Toque/clic sin arrastrar: abre el detalle del jugador (onSelect).
     · Teclado: flechas mueven al jugador enfocado; Supr lo envía al banco.
     · "Ubicar en la cancha" (desde el detalle): el siguiente toque en la cancha lo ubica.
   Los íconos (goles, asistencias, tarjetas) y la valoración viajan DENTRO de la
   ficha del jugador: lo acompañan al moverlo.
   ========================================================== */
import { jerseyAvatar } from "./player-card.js";

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const clamp = (v, a = 0.04, b = 0.96) => Math.min(b, Math.max(a, v));
const POS = ["Portero", "Defensa", "Mediocampista", "Delantero"];
export const ratingClass = (v) => (typeof v !== "number" ? "is-none" : v < 5 ? "is-red" : v < 7 ? "is-orange" : v < 8.5 ? "is-green" : "is-gold");
export const ratingText = (v) => (typeof v === "number" ? v.toFixed(1) : "–");
export const posInicial = (p, y) => (POS.includes(p.posicion) ? p.posicion : y > 0.86 ? "Portero" : y > 0.62 ? "Defensa" : y > 0.36 ? "Mediocampista" : "Delantero");
export const nombreCorto = (p) => { const a = (p.apellidos || "").trim().split(/\s+/)[0] || ""; return a || (p.nombres || "").trim().split(/\s+/)[0] || ""; };

export const ICON = {
  ball: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#fff" stroke="#111827" stroke-width="1.6"/><path d="M12 7.2l3.6 2.6-1.4 4.2H9.8L8.4 9.8z" fill="#111827"/><path d="M12 2.5v4.7M15.6 9.8l4.6-1.5M14.2 14l2.8 3.9M9.8 14 7 17.9M8.4 9.8 3.8 8.3" stroke="#111827" stroke-width="1.3" fill="none"/></svg>',
  boot: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5h5.2l.8 4.3c2.6.3 5.3 1 7.7 2.1 1.7.8 2.8 1.9 3 3.4.1.8-.5 1.5-1.3 1.5H4.6c-.9 0-1.6-.7-1.6-1.6V7.5c0-.6.4-1 1-1z" fill="#fff" stroke="#111827" stroke-width="1.5" stroke-linejoin="round"/><path d="M9.6 10.8l1.6-1.6M12 11.3l1.5-1.5" stroke="#111827" stroke-width="1.3" stroke-linecap="round"/><path d="M5.5 17.8v1.8M9 17.8v1.8M12.5 17.8v1.8M16 17.8v1.8" stroke="#111827" stroke-width="1.6" stroke-linecap="round"/></svg>',
};

/** Ficha circular del jugador (cancha y banco). */
export function playerToken(p, r, { bench = false } = {}) {
  const b = el("button", `pt-tok${bench ? " pt-tok--bench" : ""}`); b.type = "button"; b.dataset.id = p.id;
  const ph = el("span", "pt-tok__ph");
  if (p.foto) { const i = el("img"); i.src = p.foto; i.alt = ""; i.draggable = false; ph.append(i); } else ph.append(jerseyAvatar(p));
  const num = el("span", "pt-tok__num", p.numeroCamiseta ?? "–");
  ph.append(num);
  const ic = el("span", "pt-tok__ic");
  if (r?.goles) { const s = el("span", "pt-ic pt-ic--goal"); s.innerHTML = ICON.ball; if (r.goles > 1) s.append(el("b", "", `×${r.goles}`)); s.title = `${r.goles} gol${r.goles > 1 ? "es" : ""}`; ic.append(s); }
  if (r?.asistencias) { const s = el("span", "pt-ic pt-ic--assist"); s.innerHTML = ICON.boot; if (r.asistencias > 1) s.append(el("b", "", `×${r.asistencias}`)); s.title = `${r.asistencias} asistencia${r.asistencias > 1 ? "s" : ""}`; ic.append(s); }
  const cards = el("span", "pt-tok__cards");
  if (r?.tarjetasAmarillas) { const c = el("span", "pt-card pt-card--y"); if (r.tarjetasAmarillas > 1) c.textContent = String(r.tarjetasAmarillas); c.title = `${r.tarjetasAmarillas} amarilla${r.tarjetasAmarillas > 1 ? "s" : ""}`; cards.append(c); }
  if (r?.tarjetasRojas) { const c = el("span", "pt-card pt-card--r"); if (r.tarjetasRojas > 1) c.textContent = String(r.tarjetasRojas); c.title = "Roja"; cards.append(c); }
  const rt = el("span", `pt-tok__rt ${ratingClass(r?.valoracionFinal)}`, ratingText(r?.valoracionFinal));
  rt.title = typeof r?.valoracionFinal === "number" ? `Valoración ${r.valoracionFinal.toFixed(1)}` : "Sin calificar";
  const nm = el("span", "pt-tok__nm", `${p.numeroCamiseta ?? ""}${p.numeroCamiseta !== null && p.numeroCamiseta !== undefined ? ". " : ""}${nombreCorto(p)}`);
  b.append(ph, ic, cards, rt, nm);
  const partes = [`${p.nombres} ${p.apellidos}`, p.numeroCamiseta != null ? `dorsal ${p.numeroCamiseta}` : "",
    typeof r?.valoracionFinal === "number" ? `valoración ${r.valoracionFinal.toFixed(1)}` : "sin calificar",
    r?.goles ? `${r.goles} goles` : "", r?.asistencias ? `${r.asistencias} asistencias` : "",
    r?.tarjetasAmarillas ? `${r.tarjetasAmarillas} amarillas` : "", r?.tarjetasRojas ? "roja" : ""].filter(Boolean);
  b.setAttribute("aria-label", partes.join(", "));
  return b;
}

const FIELD_SVG = `<svg class="pt-lines" viewBox="0 0 68 105" preserveAspectRatio="none" aria-hidden="true">
  <g fill="none" stroke="rgba(255,255,255,.75)" stroke-width=".45">
    <rect x="2" y="2" width="64" height="101" rx=".6"/>
    <line x1="2" y1="52.5" x2="66" y2="52.5"/>
    <circle cx="34" cy="52.5" r="9.15"/>
    <rect x="13.85" y="2" width="40.3" height="16.5"/><rect x="24.85" y="2" width="18.3" height="5.5"/>
    <rect x="13.85" y="86.5" width="40.3" height="16.5"/><rect x="24.85" y="97.5" width="18.3" height="5.5"/>
    <path d="M26.7 18.5a9.15 9.15 0 0 0 14.6 0"/><path d="M26.7 86.5a9.15 9.15 0 0 1 14.6 0"/>
  </g>
  <g fill="rgba(255,255,255,.8)"><circle cx="34" cy="52.5" r=".6"/><circle cx="34" cy="13" r=".5"/><circle cx="34" cy="92" r=".5"/></g>
</svg>`;

/**
 * @param {HTMLElement} root
 * @param {{editable:boolean, max:number, players:Map, stats:Map, ubicaciones:Map, highlightId?:string, onChange:Function, onSelect:Function, onLimit:Function}} o
 */
export function createPitch(root, o) {
  const st = { ...o, ubic: new Map(o.ubicaciones), placing: null };
  const wrap = el("div", `pt${o.editable ? "" : " is-readonly"}`);
  const field = el("div", "pt-field"); field.innerHTML = FIELD_SVG;
  field.setAttribute("aria-label", "Cancha de juego");
  const layer = el("div", "pt-layer"); field.append(layer);
  const hint = el("p", "pt-place-hint"); hint.hidden = true; field.append(hint);
  const benchBox = el("section", "pt-bench"); benchBox.setAttribute("aria-label", "Banco de suplentes");
  const benchHead = el("header", "pt-bench__head"); benchHead.append(el("h3", "pt-bench__t", "Banco de suplentes"), el("span", "pt-bench__n"));
  const bench = el("div", "pt-bench__list");
  benchBox.append(benchHead, bench);
  wrap.append(field, benchBox);
  root.replaceChildren(wrap);

  const emit = () => st.onChange?.(new Map(st.ubic));

  // HU-014: resalta al jugador autenticado ("Tú") sin cambiar su posición
  const mark = (t, jid) => {
    if (!st.highlightId || jid !== st.highlightId) return;
    t.classList.add("is-me"); t.append(el("span", "pt-tok__me", "Tú"));
    t.setAttribute("aria-label", `Tú: ${t.getAttribute("aria-label")}`);
  };
  function render() {
    layer.replaceChildren(); bench.replaceChildren();
    for (const [jid, u] of st.ubic) {
      const p = st.players.get(jid); if (!p) continue;
      const t = playerToken(p, st.stats.get(jid));
      t.style.left = `${u.x * 100}%`; t.style.top = `${u.y * 100}%`;
      if (u.posicionTactica === "Portero") t.classList.add("is-gk");
      mark(t, jid); bind(t, jid, false); layer.append(t);
    }
    const suplentes = [...st.players.values()].filter((p) => !st.ubic.has(p.id))
      .sort((a, b) => (a.numeroCamiseta ?? 999) - (b.numeroCamiseta ?? 999));
    for (const p of suplentes) {
      const cell = el("div", "pt-bench__cell");
      const t = playerToken(p, st.stats.get(p.id), { bench: true });
      mark(t, p.id); bind(t, p.id, true);
      cell.append(t, el("span", "pt-bench__pos", p.posicion && p.posicion !== "Por definir" ? p.posicion : "Sin posición"));
      bench.append(cell);
    }
    benchHead.querySelector(".pt-bench__n").textContent = `${suplentes.length}`;
    if (!suplentes.length) bench.append(el("p", "pt-bench__empty", st.editable ? "Sin suplentes: todos los convocados están en la cancha." : "Sin suplentes registrados."));
    field.classList.toggle("is-placing", !!st.placing);
  }

  /* ---------- Arrastre con Pointer Events (sin listeners globales permanentes) ---------- */
  function bind(t, jid, fromBench) {
    t.addEventListener("click", (e) => { if (t.dataset.dragged) { delete t.dataset.dragged; e.preventDefault(); return; } st.onSelect?.(jid); });
    if (!st.editable) return;
    t.addEventListener("keydown", (e) => {
      if (fromBench) return;
      const u = st.ubic.get(jid); if (!u) return;
      const d = e.shiftKey ? 0.05 : 0.02;
      const mv = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] }[e.key];
      if (mv) { e.preventDefault(); u.x = clamp(u.x + mv[0]); u.y = clamp(u.y + mv[1]); render(); emit(); layer.querySelector(`[data-id="${CSS.escape(jid)}"]`)?.focus(); }
      else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); toBench(jid); }
    });
    t.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const start = { x: e.clientX, y: e.clientY }; let ghost = null; let moved = false;
      try { t.setPointerCapture(e.pointerId); } catch { /* sin captura */ }
      const move = (ev) => {
        if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
        if (!moved) {
          moved = true;
          ghost = t.cloneNode(true); ghost.classList.add("pt-ghost"); ghost.removeAttribute("id"); document.body.append(ghost);
          t.classList.add("is-dragging"); field.classList.add("is-drop");
        }
        ghost.style.left = `${ev.clientX}px`; ghost.style.top = `${ev.clientY}px`;
        ev.preventDefault();
      };
      const up = (ev) => {
        t.removeEventListener("pointermove", move); t.removeEventListener("pointerup", up); t.removeEventListener("pointercancel", up);
        if (!moved) return;
        t.dataset.dragged = "1"; ghost?.remove(); t.classList.remove("is-dragging"); field.classList.remove("is-drop");
        drop(jid, ev.clientX, ev.clientY);
      };
      t.addEventListener("pointermove", move); t.addEventListener("pointerup", up); t.addEventListener("pointercancel", up);
    });
  }

  function drop(jid, cx, cy) {
    const fr = field.getBoundingClientRect(), br = benchBox.getBoundingClientRect();
    const onField = cx >= fr.left && cx <= fr.right && cy >= fr.top && cy <= fr.bottom;
    const onBench = cx >= br.left && cx <= br.right && cy >= br.top && cy <= br.bottom;
    if (onBench) { toBench(jid); return; }
    if (!onField) { render(); return; }
    const x = clamp((cx - fr.left) / fr.width), y = clamp((cy - fr.top) / fr.height);
    // ¿soltó sobre otro titular? → intercambio
    let target = null, best = 0.06;
    for (const [oid, u] of st.ubic) { if (oid === jid) continue; const d = Math.hypot((u.x - x) * fr.width / fr.height, u.y - y); if (d < best) { best = d; target = oid; } }
    const mine = st.ubic.get(jid);
    if (target) {
      const tu = st.ubic.get(target);
      if (mine) { st.ubic.set(target, { ...tu, x: mine.x, y: mine.y }); st.ubic.set(jid, { ...mine, x: tu.x, y: tu.y }); }
      else { st.ubic.delete(target); st.ubic.set(jid, { x: tu.x, y: tu.y, posicionTactica: tu.posicionTactica }); }   // entra del banco, el otro sale
    } else if (mine) {
      st.ubic.set(jid, { ...mine, x, y });
    } else {
      if (st.ubic.size >= st.max) { st.onLimit?.(st.max); render(); return; }
      st.ubic.set(jid, { x, y, posicionTactica: posInicial(st.players.get(jid), y) });
    }
    render(); emit();
  }

  function toBench(jid) { if (st.ubic.delete(jid)) { render(); emit(); } }

  /* ---------- Ubicación por toque (alternativa al arrastre) ---------- */
  field.addEventListener("click", (e) => {
    if (!st.placing || e.target.closest(".pt-tok")) return;
    const fr = field.getBoundingClientRect();
    const jid = st.placing; st.placing = null; hint.hidden = true;
    const x = clamp((e.clientX - fr.left) / fr.width), y = clamp((e.clientY - fr.top) / fr.height);
    if (!st.ubic.has(jid) && st.ubic.size >= st.max) { st.onLimit?.(st.max); render(); return; }
    const prev = st.ubic.get(jid);
    st.ubic.set(jid, { x, y, posicionTactica: prev?.posicionTactica ?? posInicial(st.players.get(jid), y) });
    render(); emit();
  });

  render();
  return {
    render,
    setStats(m) { st.stats = m; render(); },
    setPlayers(m) { st.players = m; for (const k of [...st.ubic.keys()]) if (!m.has(k)) st.ubic.delete(k); render(); },
    setUbicaciones(m) { st.ubic = new Map(m); render(); },
    setMax(n) { st.max = n; },
    getUbicaciones: () => new Map(st.ubic),
    toBench,
    setPosicion(jid, pos) { const u = st.ubic.get(jid); if (u && POS.includes(pos)) { u.posicionTactica = pos; render(); emit(); } },
    startPlacing(jid, name) {
      if (!st.ubic.has(jid) && st.ubic.size >= st.max) { st.onLimit?.(st.max); return; }
      st.placing = jid; hint.textContent = `Toca la cancha para ubicar a ${name}.`; hint.hidden = false; field.classList.add("is-placing");
      field.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
    },
    cancelPlacing() { st.placing = null; hint.hidden = true; field.classList.remove("is-placing"); },
  };
}
