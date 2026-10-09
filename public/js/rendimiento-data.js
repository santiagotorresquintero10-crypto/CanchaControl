/* ==========================================================
   CanchaControl — Mi rendimiento (HU-014) · datos
   ----------------------------------------------------------
   ÚNICA fuente de verdad: los registros de HU-013
     categorias/{cat}/partidos/{pid}/rendimientos/{jugadorId}
   No se crea ninguna colección ni copia de estadísticas.

   · Lista personal: UNA consulta collectionGroup('rendimientos')
     where jugadorId == el suyo (las reglas lo validan contra users/{uid}.jugadorId).
     Cada rendimiento trae la copia del partido (fecha, rival, tipo y categoría de
     ese día) → el historial no depende de la categoría actual.
   · Detalle de un partido (solo al abrirlo): partido, convocatoria, estadísticas y
     alineación, por ruta. Las reglas solo lo permiten si el jugador fue convocado.
   ========================================================== */
import { collection, collectionGroup, doc, getDoc, getDocs, query, where } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { db } from "./auth.js";
import { isoDate } from "./entrenamientos-data.js";
import { SLOTS } from "./partidos-data.js";

export const MSG = Object.freeze({
  sinPartidos: "Tu historia deportiva está comenzando. Aquí aparecerán tus partidos cuando se registren.",
  sinStats: "Aún no hay estadísticas disponibles para este período.",
  sinValoracion: "Tu entrenador todavía no ha registrado una valoración.",
  sinCalificaciones: "Sin calificaciones disponibles",
  sinAlineacion: "No hay una alineación disponible para este encuentro.",
  error: "No fue posible cargar tu rendimiento. Intenta nuevamente.",
  sinExpediente: "No encontramos un expediente deportivo vinculado a tu cuenta.",
  sinPermiso: "No tienes autorización para consultar esta información.",
  rango: "La fecha inicial no puede ser posterior a la fecha final.",
});

/* ---------------- Períodos ---------------- */
export const PERIODOS = Object.freeze([
  { key: "mes", label: "Este mes" },
  { key: "tres", label: "Últimos 3 meses" },
  { key: "seis", label: "Últimos 6 meses" },
  { key: "anio", label: "Este año" },
  { key: "todo", label: "Todo el historial" },
  { key: "rango", label: "Personalizado" },
]);
export function rangoPeriodo(key, custom = {}, now = new Date()) {
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  switch (key) {
    case "mes": return { desde: isoDate(new Date(y, m, 1)), hasta: isoDate(new Date(y, m + 1, 0)) };
    case "tres": return { desde: isoDate(new Date(y, m - 3, d)), hasta: isoDate(now) };
    case "seis": return { desde: isoDate(new Date(y, m - 6, d)), hasta: isoDate(now) };
    case "anio": return { desde: `${y}-01-01`, hasta: `${y}-12-31` };
    case "rango": return { desde: custom.desde || null, hasta: custom.hasta || null };
    default: return { desde: null, hasta: null };
  }
}
export const enRango = (fecha, { desde, hasta }) => !!fecha && (!desde || fecha >= desde) && (!hasta || fecha <= hasta);

const num = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
const val = (v) => (typeof v === "number" && v >= 1 && v <= 10 ? Math.round(v * 10) / 10 : null);

/* ---------------- Consulta personal ---------------- */
/** Todos los rendimientos del jugador (de cualquier categoría), del más reciente al más antiguo. */
export async function misRendimientos(jugadorId) {
  const snap = await getDocs(query(collectionGroup(db, "rendimientos"), where("jugadorId", "==", jugadorId)));
  const out = [];
  snap.forEach((d) => {
    const x = d.data();
    // categoriaId/partidoId del documento = su ruta (las reglas de HU-013 lo exigen al crearlo)
    const partidoRef = d.ref?.parent?.parent;               // categorias/{cat}/partidos/{pid}
    const catId = partidoRef?.parent?.parent?.id ?? x.categoriaId ?? "";
    const pid = partidoRef?.id ?? x.partidoId ?? "";
    if (!pid || !catId || x.jugadorId !== jugadorId) return;
    out.push({
      key: `${catId}/${pid}`, catId, pid,
      fecha: x.partido?.fecha ?? "", rival: x.partido?.rival ?? "", tipo: x.partido?.tipo ?? "",
      categoriaNombre: x.partido?.categoriaNombre ?? "",
      goles: num(x.goles), asistencias: num(x.asistencias), minutos: num(x.minutosJugados),
      amarillas: num(x.tarjetasAmarillas), rojas: num(x.tarjetasRojas), valoracion: val(x.valoracionFinal),
    });
  });
  return out.sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : a.key < b.key ? 1 : -1));
}

/** Datos del encuentro (lugar, hora, formato) — una lectura por partido, solo los visibles. */
export async function datosPartido(catId, pid) {
  const s = await getDoc(doc(db, "categorias", catId, "partidos", pid));
  if (!s.exists()) return null;
  const d = s.data();
  return { lugar: d.lugar ?? "", hora: d.hora ?? "", formato: d.formatoPartido ?? "", estado: d.estado ?? "", rival: d.rival ?? "", tipo: d.tipo ?? "", fecha: d.fecha ?? "" };
}

/** Alineación histórica + convocatoria + estadísticas de todos (decisión de la escuela). */
export async function detalleAlineacion(catId, pid) {
  const base = ["categorias", catId, "partidos", pid];
  const [al, parts, rends] = await Promise.all([
    getDoc(doc(db, ...base, "alineaciones", "principal")),
    getDocs(collection(db, ...base, "participantes")),
    getDocs(collection(db, ...base, "rendimientos")),
  ]);
  const players = new Map();
  parts.forEach((x) => {
    const d = x.data(), p = d.participante ?? {};
    players.set(x.id, { id: x.id, nombres: p.nombres ?? "", apellidos: p.apellidos ?? "", numeroCamiseta: p.numeroCamiseta ?? null, posicion: p.posicion ?? "", foto: null });
  });
  const stats = new Map();
  rends.forEach((x) => {
    const d = x.data();
    stats.set(x.id, { goles: num(d.goles), asistencias: num(d.asistencias), minutosJugados: num(d.minutosJugados),
      tarjetasAmarillas: num(d.tarjetasAmarillas), tarjetasRojas: num(d.tarjetasRojas), valoracionFinal: val(d.valoracionFinal) });
  });
  let ubicaciones = null;
  if (al.exists()) {
    ubicaciones = new Map();
    const t = al.data().titulares ?? {};
    for (const k of SLOTS) { const v = t[k]; if (v && v.jugadorId && players.has(v.jugadorId)) ubicaciones.set(v.jugadorId, { x: v.x, y: v.y, posicionTactica: v.posicionTactica }); }
    if (!ubicaciones.size) ubicaciones = null;
  }
  return { players, stats, ubicaciones, formato: al.exists() ? al.data().formatoPartido ?? "" : "" };
}

/* ---------------- Cálculos ---------------- */
/** Partido jugado = participación real confirmada (minutos > 0). Promedio solo con valoraciones válidas. */
export function resumen(regs) {
  const r = { jugados: 0, goles: 0, asistencias: 0, minutos: 0, amarillas: 0, rojas: 0, valorados: 0, promedio: null, registros: regs.length };
  let suma = 0;
  for (const x of regs) {
    if (x.minutos > 0) r.jugados++;
    r.goles += x.goles; r.asistencias += x.asistencias; r.minutos += x.minutos; r.amarillas += x.amarillas; r.rojas += x.rojas;
    if (x.valoracion !== null) { r.valorados++; suma += x.valoracion; }
  }
  if (r.valorados) r.promedio = Math.round((suma / r.valorados) * 10) / 10;
  return r;
}

/**
 * Hitos verificables de TODA la carrera (no dependen del período).
 * Cada hito apunta a un partido real; el id cambia si cambia el hito (p. ej. nueva mejor valoración).
 */
export function hitos(todos) {
  const asc = [...todos].sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
  const out = [];
  const first = (pred) => asc.find(pred);
  const p1 = first((x) => x.minutos > 0);
  if (p1) out.push({ id: `primer-partido:${p1.key}`, tipo: "partido", titulo: "Primer partido registrado", texto: "¡Comienza tu camino competitivo!", reg: p1 });
  const g1 = first((x) => x.goles > 0);
  if (g1) out.push({ id: `primer-gol:${g1.key}`, tipo: "gol", titulo: "Primer gol", texto: "¡Tu primer gol registrado! ¡Sigue adelante!", reg: g1 });
  const a1 = first((x) => x.asistencias > 0);
  if (a1) out.push({ id: `primera-asistencia:${a1.key}`, tipo: "asistencia", titulo: "Primera asistencia", texto: "¡Gran aporte al equipo!", reg: a1 });
  const valorados = asc.filter((x) => x.valoracion !== null);
  if (valorados.length) {
    const best = valorados.reduce((m, x) => (x.valoracion > m.valoracion ? x : m));
    out.push({ id: `mejor-valoracion:${best.key}:${best.valoracion}`, tipo: "valoracion", titulo: "Mejor valoración", valor: best.valoracion,
      texto: `¡Nueva mejor valoración registrada: ${best.valoracion.toFixed(1)}!`, reg: best });
  }
  const conGol = asc.filter((x) => x.goles > 0);
  if (conGol.length) {
    const max = conGol.reduce((m, x) => (x.goles > m.goles ? x : m));
    out.push({ id: `max-goles:${max.key}:${max.goles}`, tipo: "goles", titulo: "Más goles en un partido", valor: max.goles,
      texto: max.goles > 1 ? `¡${max.goles} goles en un mismo partido!` : "¡Tu primer partido con gol!", reg: max });
  }
  return out;
}
