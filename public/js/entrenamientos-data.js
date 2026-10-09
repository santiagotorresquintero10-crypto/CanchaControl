/* ==========================================================
   CanchaControl — Servicio de datos: Entrenamientos (HU-010)
   ----------------------------------------------------------
   categorias/{categoriaId}/entrenamientos/{entrenamientoId}
   La sesión vive DENTRO de su categoría: las reglas autorizan por la RUTA
   (entrenador actual de la categoría, jugadores de la categoría, Administrador),
   igual que la nómina de HU-009. Una sola sesión por categoría: nunca se
   duplica por jugador. El id (fecha_HHMM) es único dentro de la categoría; HU-011 lo usará para la asistencia.
   ========================================================== */
import {
  collection, doc, getDocs, setDoc, query, where, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { db } from "./auth.js";

export const ESTADO_SES = Object.freeze({ PROGRAMADA: "Programada" });
export const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
export const LIMITS = Object.freeze({ LUGAR_MAX: 80, OBS_MAX: 300 });

export const MSG = Object.freeze({
  overlap: "Ya hay una sesión de esta categoría que se cruza con ese horario.",
  catInactive: "No es posible programar sesiones en una categoría inactiva.",
  notMine: "Solo puedes programar sesiones en tus categorías asignadas.",
  noPermission: "No tienes autorización para realizar esta acción.",
  network: "Parece que no tienes conexión a internet.",
  generic: "No fue posible guardar la sesión. Intenta nuevamente.",
});

const p2 = (n) => String(n).padStart(2, "0");
export const isoDate = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
export const hoyISO = () => isoDate(new Date());
export const ahoraHHMM = () => { const d = new Date(); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
export const sesCol = (categoriaId) => collection(db, "categorias", categoriaId, "entrenamientos");

function toDate(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d;
}
function toSesion(id, categoriaId, d) {
  return Object.freeze({
    id, categoriaId: d.categoriaId ?? categoriaId, entrenadorId: d.entrenadorId ?? null,
    fecha: d.fecha ?? "", horaInicio: d.horaInicio ?? "", horaFin: d.horaFin ?? "",
    lugar: d.lugar ?? "", observaciones: d.observaciones ?? "", estado: d.estado ?? "",
    createdAt: toDate(d.createdAt),
  });
}
const ordenar = (a, b) => (a.fecha + a.horaInicio).localeCompare(b.fecha + b.horaInicio);

/** Sesiones de varias categorías (solo las que el usuario puede leer) entre dos fechas. */
export async function sesionesRango(categoriaIds, desde, hasta) {
  const res = await Promise.all(categoriaIds.map(async (c) => {
    const snap = await getDocs(query(sesCol(c), where("fecha", ">=", desde), where("fecha", "<=", hasta)));
    const list = []; snap.forEach((x) => list.push(toSesion(x.id, c, x.data())));
    return list;
  }));
  return res.flat().sort(ordenar);
}

/** Próximas sesiones (desde hoy) de varias categorías. */
export async function proximasSesiones(categoriaIds) {
  const hoy = hoyISO(), ahora = ahoraHHMM();
  const res = await Promise.all(categoriaIds.map(async (c) => {
    const snap = await getDocs(query(sesCol(c), where("fecha", ">=", hoy)));
    const list = []; snap.forEach((x) => list.push(toSesion(x.id, c, x.data())));
    return list;
  }));
  return res.flat().filter((s) => s.fecha > hoy || s.horaFin > ahora).sort(ordenar);
}

export const sesionId = (fecha, horaInicio) => `${fecha}_${horaInicio.replace(":", "")}`;
const seCruzan = (a1, a2, b1, b2) => a1 < b2 && b1 < a2;

/**
 * Programa una sesión (Entrenador). Estado siempre "Programada".
 * entrenadorId = el UID autenticado (las reglas exigen que sea el entrenador
 * ACTUAL de la categoría y que la categoría esté activa).
 * Antes de guardar consulta en el servidor las sesiones de ese día de la
 * categoría para no cruzar horarios.
 */
export async function crearSesion(categoriaId, input, actorUid) {
  const data = {
    categoriaId,
    entrenadorId: actorUid,
    fecha: input.fecha,
    horaInicio: input.horaInicio,
    horaFin: input.horaFin,
    lugar: String(input.lugar ?? "").replace(/\s+/g, " ").trim(),
    observaciones: String(input.observaciones ?? "").trim(),
    estado: ESTADO_SES.PROGRAMADA,
    createdAt: serverTimestamp(), createdBy: actorUid,
    updatedAt: serverTimestamp(), updatedBy: actorUid,
  };
  const mismoDia = await getDocs(query(sesCol(categoriaId), where("fecha", "==", data.fecha)));
  let cruce = false;
  mismoDia.forEach((x) => { const s = x.data(); if (seCruzan(data.horaInicio, data.horaFin, s.horaInicio, s.horaFin)) cruce = true; });
  if (cruce) { const e = new Error("overlap"); e.code = "overlap"; throw e; }
  // ID determinista: un doble envío idéntico apunta al MISMO documento y las
  // reglas rechazan el segundo (no hay sesiones duplicadas aunque falle la UI).
  const ref = doc(sesCol(categoriaId), sesionId(data.fecha, data.horaInicio));
  await setDoc(ref, data);
  return ref.id;
}

export function friendlySesionError(err) {
  switch (err?.code) {
    case "overlap": return MSG.overlap;
    case "permission-denied": return MSG.noPermission;
    case "unavailable": return MSG.network;
    default: return navigator.onLine ? MSG.generic : MSG.network;
  }
}
