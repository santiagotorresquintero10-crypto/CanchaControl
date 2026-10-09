/* ==========================================================
   CanchaControl — Partidos, rendimiento y alineación (HU-013) · datos
   ----------------------------------------------------------
   Independiente de entrenamientos (HU-010/011/012). Estructura:
     categorias/{cat}/partidos/{pid}                         partido
     categorias/{cat}/partidos/{pid}/participantes/{jid}     convocatoria
     categorias/{cat}/partidos/{pid}/rendimientos/{jid}      estadísticas + valoración
     categorias/{cat}/partidos/{pid}/alineaciones/principal  alineación libre (slots s1…s11)
   El partido vive DENTRO de su categoría: las reglas autorizan por la ruta
   (entrenador ACTUAL de la categoría). Si cambia el entrenador, el anterior pierde
   el acceso y el nuevo lo recibe, sin mover datos.
   Concurrencia: cada documento editable lleva "version" (las reglas exigen +1).
   ========================================================== */
import {
  collection, doc, getDoc, getDocs, onSnapshot, runTransaction, writeBatch, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { db } from "./auth.js";

export const TIPOS = Object.freeze(["Amistoso", "Liga", "Torneo", "Otro"]);
export const ESTADOS = Object.freeze(["Programado", "Disputado", "Cancelado"]);
export const FORMATOS = Object.freeze({
  F5: { label: "Fútbol 5", titulares: 5 },
  F7: { label: "Fútbol 7", titulares: 7 },
  F9: { label: "Fútbol 9", titulares: 9 },
  F11: { label: "Fútbol 11", titulares: 11 },
});
export const POS_TACTICAS = Object.freeze(["Portero", "Defensa", "Mediocampista", "Delantero"]);
export const SLOTS = Object.freeze(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11"]);
export const DIAS_CORRECCION = 30;
export const LIM = Object.freeze({ RIVAL_MAX: 60, LUGAR_MAX: 80, OBS_MAX: 300, GOLES: 30, ASIST: 30, MIN: 150, AMA: 2, ROJ: 1 });

export const MSG = Object.freeze({
  sinPartidos: "Aún no tienes partidos registrados.",
  sinParticipantes: "Selecciona los jugadores convocados para este partido.",
  sinAlineacion: "Todavía no has organizado la alineación.",
  sinRendimiento: "Aún no se han registrado estadísticas para este partido.",
  sinValoracion: "Sin calificar",
  sinPermiso: "No tienes autorización para gestionar este partido.",
  errorGuardar: "No fue posible guardar los cambios. Intenta nuevamente.",
  errorCargar: "No fue posible cargar la información. Intenta nuevamente.",
  conflicto: "Otra persona modificó este registro mientras lo editabas. Se recargaron los datos; revisa y vuelve a guardar.",
  bloqueoEstado: "Este partido ya tiene estadísticas registradas: su estado debe seguir siendo «Disputado».",
  soloDisputado: "El rendimiento solo se registra en partidos disputados.",
  ventana: `El plazo para registrar o corregir el rendimiento (${DIAS_CORRECCION} días después del partido) terminó.`,
  disputadoFuturo: "Un partido con fecha futura no puede marcarse como disputado.",
});

const p2 = (n) => String(n).padStart(2, "0");
export const isoHoy = () => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
export function ventanaRendimiento(fecha, hoy = isoHoy()) {
  const [y, m, d] = fecha.split("-").map(Number);
  const h = new Date(y, m - 1, d + DIAS_CORRECCION);
  const hasta = `${h.getFullYear()}-${p2(h.getMonth() + 1)}-${p2(h.getDate())}`;
  return { abierta: fecha <= hoy && hoy <= hasta, hasta, futura: fecha > hoy };
}

export const partidosCol = (cat) => collection(db, "categorias", cat, "partidos");
export const partidoRef = (cat, pid) => doc(db, "categorias", cat, "partidos", pid);
const partRef = (cat, pid, jid) => doc(db, "categorias", cat, "partidos", pid, "participantes", jid);
const rendRef = (cat, pid, jid) => doc(db, "categorias", cat, "partidos", pid, "rendimientos", jid);
const alinRef = (cat, pid) => doc(db, "categorias", cat, "partidos", pid, "alineaciones", "principal");

function toPartido(id, cat, d) {
  return {
    id, categoriaId: d.categoriaId ?? cat, entrenadorId: d.entrenadorId ?? null, rival: d.rival ?? "", fecha: d.fecha ?? "", hora: d.hora ?? "",
    lugar: d.lugar ?? "", tipo: d.tipo ?? "", estado: d.estado ?? "", formatoPartido: d.formatoPartido ?? "F11",
    observaciones: d.observaciones ?? "", conRendimiento: d.conRendimiento === true, version: d.version ?? 1,
  };
}

/** Partidos de varias categorías en tiempo real (una escucha por categoría autorizada). */
export function subscribePartidos(catIds, onData, onError) {
  const parts = new Map(); const unsubs = [];
  const emit = () => onData([...parts.values()].flat().sort((a, b) => (b.fecha + b.hora).localeCompare(a.fecha + a.hora)));
  if (!catIds.length) { onData([]); return () => {}; }
  for (const c of catIds) {
    unsubs.push(onSnapshot(partidosCol(c), (snap) => {
      const l = []; snap.forEach((x) => l.push(toPartido(x.id, c, x.data())));
      parts.set(c, l); if (parts.size === catIds.length) emit();
    }, (err) => onError?.(err)));
  }
  return () => unsubs.forEach((u) => u());
}

const limpio = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
function datosPartido(input) {
  return {
    rival: limpio(input.rival), fecha: input.fecha, hora: input.hora, lugar: limpio(input.lugar), tipo: input.tipo,
    estado: input.estado, formatoPartido: input.formatoPartido, observaciones: String(input.observaciones ?? "").trim(),
  };
}

export async function crearPartido(cat, input, uid) {
  const ref = doc(partidosCol(cat));
  await runTransaction(db, async (tx) => {
    tx.set(ref, { categoriaId: cat, entrenadorId: uid, ...datosPartido(input), conRendimiento: false, version: 1,
      createdAt: serverTimestamp(), createdBy: uid, updatedAt: serverTimestamp(), updatedBy: uid });
  });
  return ref.id;
}

export async function actualizarPartido(cat, pid, input, uid, expectedVersion) {
  await runTransaction(db, async (tx) => {
    const s = await tx.get(partidoRef(cat, pid));
    if (!s.exists()) { const e = new Error("not-found"); e.code = "not-found"; throw e; }
    const cur = s.data();
    if ((cur.version ?? 1) !== expectedVersion) { const e = new Error("conflict"); e.code = "conflict"; throw e; }
    const d = datosPartido(input);
    if (cur.conRendimiento === true && d.estado !== "Disputado") { const e = new Error("bloqueo"); e.code = "bloqueo-estado"; throw e; }
    tx.update(partidoRef(cat, pid), { ...d, version: expectedVersion + 1, updatedAt: serverTimestamp(), updatedBy: uid });
  });
}

/* ---------------- Participantes ---------------- */
export async function cargarParticipantes(cat, pid) {
  const snap = await getDocs(collection(db, "categorias", cat, "partidos", pid, "participantes"));
  const m = new Map();
  snap.forEach((x) => { const d = x.data(); m.set(x.id, { id: x.id, rol: d.rolConvocatoria ?? "Suplente", participo: d.participo === true, version: d.version ?? 1, ...(d.participante ?? {}) }); });
  return m;
}
const CHUNK = 10;
/** agregar: [{id, nombres, apellidos, numeroCamiseta, posicion}] · quitar: [jugadorId] (sin rendimiento ni ubicación) */
export async function guardarConvocatoria(cat, pid, agregar, quitar, uid) {
  // Altas y bajas en lotes separados y pequeños: las reglas leen la ficha de cada alta
  // y verifican cada baja; un lote mixto grande superaría el límite de lecturas por operación.
  for (let i = 0; i < agregar.length; i += CHUNK) {
    const b = writeBatch(db);
    for (const p of agregar.slice(i, i + CHUNK)) {
      b.set(partRef(cat, pid, p.id), { jugadorId: p.id, categoriaId: cat, rolConvocatoria: "Suplente", participo: false,
        participante: { nombres: p.nombres, apellidos: p.apellidos, numeroCamiseta: p.numeroCamiseta ?? null, posicion: p.posicion ?? "" },
        version: 1, createdAt: serverTimestamp(), createdBy: uid, updatedAt: serverTimestamp(), updatedBy: uid });
    }
    await b.commit();
  }
  for (let i = 0; i < quitar.length; i += CHUNK) {
    const b = writeBatch(db);
    for (const jid of quitar.slice(i, i + CHUNK)) b.delete(partRef(cat, pid, jid));
    await b.commit();
  }
}

/* ---------------- Rendimientos ---------------- */
export async function cargarRendimientos(cat, pid) {
  const snap = await getDocs(collection(db, "categorias", cat, "partidos", pid, "rendimientos"));
  const m = new Map();
  snap.forEach((x) => { const d = x.data(); m.set(x.id, {
    id: x.id, goles: d.goles ?? 0, asistencias: d.asistencias ?? 0, minutosJugados: d.minutosJugados ?? 0,
    tarjetasAmarillas: d.tarjetasAmarillas ?? 0, tarjetasRojas: d.tarjetasRojas ?? 0,
    valoracionFinal: typeof d.valoracionFinal === "number" ? d.valoracionFinal : null, version: d.version ?? 1 }); });
  return m;
}

/** Valida en el cliente (las reglas repiten estas mismas restricciones). Devuelve errores por campo. */
export function validarRendimiento(r) {
  const e = {};
  const ent = (v, max, k) => { if (!Number.isInteger(v) || v < 0) e[k] = "Debe ser un número entero mayor o igual a 0."; else if (v > max) e[k] = `Máximo ${max}.`; };
  ent(r.goles, LIM.GOLES, "goles"); ent(r.asistencias, LIM.ASIST, "asistencias"); ent(r.minutosJugados, LIM.MIN, "minutosJugados");
  ent(r.tarjetasAmarillas, LIM.AMA, "tarjetasAmarillas"); ent(r.tarjetasRojas, LIM.ROJ, "tarjetasRojas");
  if (r.valoracionFinal !== null) {
    const v = r.valoracionFinal;
    if (typeof v !== "number" || Number.isNaN(v) || v < 1 || v > 10) e.valoracionFinal = "La valoración debe estar entre 1 y 10.";
    else if (Math.abs(v * 10 - Math.round(v * 10)) > 1e-9) e.valoracionFinal = "Usa máximo un decimal (ej. 7.5).";
  }
  return e;
}
export const parseValoracion = (txt) => {
  const s = String(txt ?? "").trim().replace(",", ".");
  if (!s) return null;
  if (!/^\d{1,2}(\.\d)?$/.test(s)) return NaN;
  return Math.round(Number(s) * 10) / 10;
};

/**
 * Guarda el rendimiento de UN jugador (crear o corregir) en una transacción:
 * rendimiento + participante.participo (minutos > 0) + marca del partido.
 */
export async function guardarRendimiento({ cat, pid, jid, datos, previo, uid, partidoSnap, participante }) {
  await runTransaction(db, async (tx) => {
    const ps = await tx.get(partidoRef(cat, pid));
    const rs = await tx.get(rendRef(cat, pid, jid));
    const pa = await tx.get(partRef(cat, pid, jid));
    if (!ps.exists() || !pa.exists()) { const e = new Error("not-found"); e.code = "not-found"; throw e; }
    const actual = rs.exists() ? (rs.data().version ?? 1) : null;
    if ((previo === null && actual !== null) || (previo !== null && actual !== previo.version)) { const e = new Error("conflict"); e.code = "conflict"; throw e; }
    const nums = { goles: datos.goles, asistencias: datos.asistencias, minutosJugados: datos.minutosJugados,
      tarjetasAmarillas: datos.tarjetasAmarillas, tarjetasRojas: datos.tarjetasRojas, valoracionFinal: datos.valoracionFinal };
    if (previo === null) {
      tx.set(rendRef(cat, pid, jid), { partidoId: pid, jugadorId: jid, categoriaId: cat, ...nums,
        participante: pa.data().participante,
        partido: { fecha: partidoSnap.fecha, rival: partidoSnap.rival, tipo: partidoSnap.tipo, categoriaNombre: partidoSnap.categoriaNombre },
        version: 1, createdAt: serverTimestamp(), createdBy: uid, updatedAt: serverTimestamp(), updatedBy: uid });
    } else {
      tx.update(rendRef(cat, pid, jid), { ...nums, version: previo.version + 1, updatedAt: serverTimestamp(), updatedBy: uid });
    }
    const participo = datos.minutosJugados > 0;
    if ((pa.data().participo === true) !== participo) {
      tx.update(partRef(cat, pid, jid), { participo, version: (pa.data().version ?? 1) + 1, updatedAt: serverTimestamp(), updatedBy: uid });
    }
    if (ps.data().conRendimiento !== true) tx.update(partidoRef(cat, pid), { conRendimiento: true });
  });
}

/* ---------------- Alineación ---------------- */
/** Devuelve { version, estado, ubicaciones: Map(jid → {x, y, posicionTactica}) } o null. */
export async function cargarAlineacion(cat, pid) {
  const s = await getDoc(alinRef(cat, pid));
  if (!s.exists()) return null;
  const d = s.data(); const m = new Map();
  for (const k of SLOTS) { const v = d.titulares?.[k]; if (v && v.jugadorId) m.set(v.jugadorId, { x: v.x, y: v.y, posicionTactica: v.posicionTactica }); }
  return { version: d.version ?? 1, estado: d.estado ?? "Borrador", ubicaciones: m };
}

/**
 * Guarda la alineación (borrador o completa) y, en la misma transacción,
 * actualiza el rol (Titular/Suplente) de los convocados cuyo rol cambió.
 */
export async function guardarAlineacion({ cat, pid, ubicaciones, formato, previo, uid, participantes }) {
  const max = FORMATOS[formato]?.titulares ?? 11;
  const entries = [...ubicaciones.entries()];
  if (entries.length > max) { const e = new Error("max"); e.code = "max-titulares"; throw e; }
  const titulares = {};
  SLOTS.forEach((k, i) => {
    const en = entries[i];
    titulares[k] = en ? { jugadorId: en[0], x: clamp01(en[1].x), y: clamp01(en[1].y), posicionTactica: en[1].posicionTactica } : null;
  });
  const jugadores = entries.map((en) => en[0]);                        // mismo orden que s1…sN (lo exige la regla)
  const estado = entries.length === max ? "Completa" : "Borrador";
  await runTransaction(db, async (tx) => {
    const s = await tx.get(alinRef(cat, pid));
    const actual = s.exists() ? (s.data().version ?? 1) : null;
    if ((previo === null && actual !== null) || (previo !== null && actual !== previo.version)) { const e = new Error("conflict"); e.code = "conflict"; throw e; }
    if (previo === null) {
      tx.set(alinRef(cat, pid), { partidoId: pid, categoriaId: cat, formatoPartido: formato, titulares, jugadores, estado, version: 1,
        createdAt: serverTimestamp(), createdBy: uid, updatedAt: serverTimestamp(), updatedBy: uid });
    } else {
      tx.update(alinRef(cat, pid), { formatoPartido: formato, titulares, jugadores, estado, version: previo.version + 1, updatedAt: serverTimestamp(), updatedBy: uid });
    }
    for (const p of participantes.values()) {
      const rol = ubicaciones.has(p.id) ? "Titular" : "Suplente";
      if (rol !== p.rol) tx.update(partRef(cat, pid, p.id), { rolConvocatoria: rol, version: p.version + 1, updatedAt: serverTimestamp(), updatedBy: uid });
    }
  });
  return estado;
}
const clamp01 = (v) => Math.round(Math.min(1, Math.max(0, Number(v) || 0)) * 1000) / 1000;

/** Formación según la ubicación real (filas por profundidad, sin el portero). Ej.: "4-2-3-1". */
export function formacion(ubicaciones) {
  const campo = [...ubicaciones.values()].filter((u) => u.posicionTactica !== "Portero").sort((a, b) => b.y - a.y);
  if (!campo.length) return "";
  const filas = []; let fila = [campo[0]];
  for (let i = 1; i < campo.length; i++) {
    if (Math.abs(campo[i].y - fila[fila.length - 1].y) > 0.075) { filas.push(fila); fila = [campo[i]]; } else fila.push(campo[i]);
  }
  filas.push(fila);
  return filas.map((f) => f.length).join("-");
}

export function friendlyPartidoError(err) {
  switch (err?.code) {
    case "conflict": case "aborted": return MSG.conflicto;
    case "bloqueo-estado": return MSG.bloqueoEstado;
    case "permission-denied": return MSG.sinPermiso;
    case "max-titulares": return "Superaste el número máximo de titulares para este formato.";
    default: return MSG.errorGuardar;
  }
}
