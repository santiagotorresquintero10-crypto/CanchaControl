/* ==========================================================
   CanchaControl — Servicio de datos: Asistencia (HU-011)
   ----------------------------------------------------------
   categorias/{catId}/entrenamientos/{sesId}/asistencias/{jugadorId}
   Un documento por jugador y sesión (ID = jugadorId → imposible duplicar).

   PARTICIPANTES HISTÓRICOS: el primer guardado "congela" quiénes participaron
   (la nómina ACTIVA de ese momento). Cada registro guarda una copia mínima
   (nombres, apellidos, dorsal, posición) para que la asistencia siga legible
   aunque el jugador cambie de categoría. El expediente sigue siendo la fuente
   principal: si el jugador continúa en la categoría se muestran sus datos actuales.

   CONCURRENCIA: cada registro lleva "version". Al guardar, una transacción vuelve
   a leer cada documento y aborta si alguien lo cambió desde que se cargó; las
   reglas exigen version = anterior + 1 (nadie sobrescribe a ciegas).
   ========================================================== */
import {
  collection, doc, getDoc, getDocs, query, limit, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { db } from "./auth.js";

export const ESTADOS = Object.freeze(["Asistió", "Falta", "Excusa", "Atraso"]);
export const ESTADO_INFO = Object.freeze({
  "Asistió": { key: "ok", label: "Asistió", plural: "Asistieron" },
  "Falta": { key: "falta", label: "Falta", plural: "Faltaron" },
  "Excusa": { key: "excusa", label: "Excusa", plural: "Excusas" },
  "Atraso": { key: "atraso", label: "Atraso", plural: "Atrasos" },
});
export const DIAS_CORRECCION = 7;

export const MSG = Object.freeze({
  pendientes: "Hay jugadores pendientes de marcar. Completa todos los estados antes de guardar.",
  conflicto: "Otra persona modificó esta asistencia mientras la editabas. Se recargaron los datos guardados; revisa y vuelve a guardar.",
  noPermission: "No tienes autorización para registrar la asistencia de esta sesión.",
  cerrada: "El plazo para registrar o corregir esta asistencia terminó.",
  futura: "La asistencia se podrá registrar el día de la sesión.",
  network: "Parece que no tienes conexión a internet. Tus selecciones siguen aquí; intenta guardar de nuevo.",
  parcial: "Se guardó solo una parte de la asistencia. Intenta guardar de nuevo para completar el resto.",
  generic: "No fue posible guardar la asistencia. Intenta nuevamente.",
});

const p2 = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
export const sesRef = (catId, sesId) => doc(db, "categorias", catId, "entrenamientos", sesId);
export const asisCol = (catId, sesId) => collection(db, "categorias", catId, "entrenamientos", sesId, "asistencias");
const asisRef = (catId, sesId, jugadorId) => doc(db, "categorias", catId, "entrenamientos", sesId, "asistencias", jugadorId);

/** Ventana de registro: desde el día de la sesión hasta 7 días después (también en las reglas). */
export function ventana(fecha, hoy = iso(new Date())) {
  const [y, m, d] = fecha.split("-").map(Number);
  const hasta = iso(new Date(y, m - 1, d + DIAS_CORRECCION));
  if (hoy < fecha) return { abierta: false, motivo: "futura", hasta };
  if (hoy > hasta) return { abierta: false, motivo: "cerrada", hasta };
  return { abierta: true, motivo: null, hasta };
}

export async function cargarSesion(catId, sesId) {
  const s = await getDoc(sesRef(catId, sesId));
  if (!s.exists()) return null;
  const d = s.data();
  return { id: sesId, categoriaId: catId, fecha: d.fecha ?? "", horaInicio: d.horaInicio ?? "", horaFin: d.horaFin ?? "",
    lugar: d.lugar ?? "", estado: d.estado ?? "", entrenadorId: d.entrenadorId ?? null, observaciones: d.observaciones ?? "" };
}

/** Registros guardados de la sesión → Map(jugadorId → registro). */
export async function cargarAsistencias(catId, sesId) {
  const snap = await getDocs(asisCol(catId, sesId));
  const map = new Map();
  snap.forEach((x) => {
    const d = x.data(); const p = d.participante ?? {};
    map.set(x.id, { jugadorId: x.id, estado: d.estadoAsistencia, version: d.version ?? 1,
      participante: { nombres: p.nombres ?? "", apellidos: p.apellidos ?? "", numeroCamiseta: p.numeroCamiseta ?? null, posicion: p.posicion ?? "" } });
  });
  return map;
}

/** Nómina actual (fichas deportivas) de la categoría → Map(jugadorId → ficha). */
export async function cargarNomina(catId) {
  const snap = await getDocs(collection(db, "categorias", catId, "nomina"));
  const map = new Map();
  snap.forEach((x) => map.set(x.id, { id: x.id, ...x.data() }));
  return map;
}

/** ¿La sesión ya tiene asistencia? (una lectura de un documento). */
export async function tieneAsistencia(catId, sesId) {
  const s = await getDocs(query(asisCol(catId, sesId), limit(1)));
  return !s.empty;
}

const CHUNK = 10;   // las reglas leen la ficha de cada jugador nuevo: lotes pequeños para no superar el límite de lecturas por operación

/**
 * Guarda solo lo nuevo o modificado.
 * cambios: [{ jugadorId, estado, previo: {version}|null, participante }]
 * Devuelve { guardados }. Lanza { code: "conflict" | "partial" | … }.
 */
export async function guardarAsistencia({ catId, sesId, cambios, actorUid, sesionSnap }) {
  // HU-012: copia inmutable de la sesión en cada registro → el historial del jugador
  // se lee en UNA consulta y sobrevive a cambios de categoría (las reglas exigen que coincida).
  const snap = sesionSnap ? { fecha: sesionSnap.fecha, horaInicio: sesionSnap.horaInicio, horaFin: sesionSnap.horaFin,
    lugar: sesionSnap.lugar, categoriaNombre: sesionSnap.categoriaNombre } : null;
  let guardados = 0;
  for (let i = 0; i < cambios.length; i += CHUNK) {
    const lote = cambios.slice(i, i + CHUNK);
    try {
      await runTransaction(db, async (tx) => {
        const snaps = [];
        for (const c of lote) snaps.push(await tx.get(asisRef(catId, sesId, c.jugadorId)));   // todas las lecturas antes de escribir
        lote.forEach((c, k) => {
          const s = snaps[k];
          const actual = s.exists() ? (s.data().version ?? 1) : null;
          if ((c.previo === null && actual !== null) || (c.previo !== null && actual !== c.previo.version)) {
            const e = new Error("conflict"); e.code = "conflict"; throw e;
          }
        });
        lote.forEach((c) => {
          const ref = asisRef(catId, sesId, c.jugadorId);
          if (c.previo === null) {
            tx.set(ref, {
              sesionId: sesId, jugadorId: c.jugadorId, categoriaId: catId, estadoAsistencia: c.estado,
              participante: { nombres: c.participante.nombres, apellidos: c.participante.apellidos,
                numeroCamiseta: c.participante.numeroCamiseta ?? null, posicion: c.participante.posicion ?? "" },
              ...(snap ? { sesion: snap } : {}),
              version: 1, fechaCreacion: serverTimestamp(), fechaActualizacion: serverTimestamp(), createdBy: actorUid, updatedBy: actorUid,
            });
          } else {
            tx.update(ref, { estadoAsistencia: c.estado, version: c.previo.version + 1, fechaActualizacion: serverTimestamp(), updatedBy: actorUid });
          }
        });
      });
      guardados += lote.length;
    } catch (err) {
      if (guardados > 0 && err?.code !== "conflict") { const e = new Error("partial"); e.code = "partial"; e.guardados = guardados; e.cause = err; throw e; }
      throw err;
    }
  }
  return { guardados };
}

export function friendlyAsistenciaError(err) {
  switch (err?.code) {
    case "conflict": case "aborted": case "failed-precondition": return MSG.conflicto;
    case "partial": return MSG.parcial;
    case "permission-denied": return MSG.noPermission;
    case "unavailable": return MSG.network;
    default: return navigator.onLine ? MSG.generic : MSG.network;
  }
}
