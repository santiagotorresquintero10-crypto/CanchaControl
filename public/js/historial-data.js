/* ==========================================================
   CanchaControl — Historial de asistencia (HU-012) · datos
   ----------------------------------------------------------
   ÚNICA fuente de verdad: los registros de HU-011
     categorias/{cat}/entrenamientos/{ses}/asistencias/{jugadorId}
   No se crea ninguna colección nueva.

   Jugador   → UNA consulta collectionGroup('asistencias') where jugadorId == el suyo.
               Cada registro trae la copia de su sesión (fecha, horario, lugar,
               categoría de ese día): el historial no depende de la categoría actual.
   Entrenador → solo sesiones de SUS categorías: lista las sesiones del período
               por categoría y lee el registro del jugador en cada una (por ruta).

   Porcentaje (regla aprobada por la escuela):
     % = (Asistió + Atraso) ÷ (Asistió + Atraso + Falta)
     Las Excusas NO entran al cálculo. Sin registros evaluables → "Sin datos suficientes".
   ========================================================== */
import { collection, collectionGroup, doc, getDoc, getDocs, query, where } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { db } from "./auth.js";
import { sesionesRango, hoyISO, isoDate } from "./entrenamientos-data.js";

export const MSG = Object.freeze({
  vacioTitulo: "Sin registros de asistencia",
  vacio: "Aún no tienes registros de asistencia para el período seleccionado.",
  vacioCoach: "Este jugador aún no tiene registros de asistencia para el período seleccionado.",
  sinExpediente: "No encontramos un expediente deportivo vinculado a tu cuenta.",
  sinPermiso: "No tienes autorización para consultar este historial.",
  error: "No fue posible cargar el historial de asistencia. Intenta nuevamente.",
  rango: "La fecha inicial no puede ser posterior a la fecha final.",
  sinDatos: "Sin datos suficientes",
});

/* ---------------- Períodos ---------------- */
export const PERIODOS = Object.freeze([
  { key: "mes", label: "Este mes" },
  { key: "anterior", label: "Mes anterior" },
  { key: "tres", label: "Últimos 3 meses" },
  { key: "todo", label: "Todo el historial" },
  { key: "rango", label: "Personalizado" },
]);
/** Devuelve { desde, hasta } en ISO (null = sin límite). */
export function rangoPeriodo(key, custom = {}, now = new Date()) {
  const y = now.getFullYear(), m = now.getMonth();
  switch (key) {
    case "mes": return { desde: isoDate(new Date(y, m, 1)), hasta: isoDate(new Date(y, m + 1, 0)) };
    case "anterior": return { desde: isoDate(new Date(y, m - 1, 1)), hasta: isoDate(new Date(y, m, 0)) };
    case "tres": return { desde: isoDate(new Date(y, m, now.getDate() - 90)), hasta: isoDate(now) };
    case "rango": return { desde: custom.desde || null, hasta: custom.hasta || null };
    default: return { desde: null, hasta: null };
  }
}
export const enRango = (fecha, { desde, hasta }) => !!fecha && (!desde || fecha >= desde) && (!hasta || fecha <= hasta);

/* ---------------- Cálculo ---------------- */
export function resumen(regs) {
  const c = { total: regs.length, ok: 0, falta: 0, excusa: 0, atraso: 0 };
  for (const r of regs) {
    if (r.estado === "Asistió") c.ok++;
    else if (r.estado === "Falta") c.falta++;
    else if (r.estado === "Excusa") c.excusa++;
    else if (r.estado === "Atraso") c.atraso++;
  }
  c.evaluables = c.ok + c.atraso + c.falta;
  c.pct = c.evaluables ? Math.round(((c.ok + c.atraso) / c.evaluables) * 100) : null;   // null = Sin datos suficientes
  return c;
}

/* ---------------- Lectura ---------------- */
function toReg(id, sesId, catId, d, sesion) {
  const s = sesion ?? d.sesion ?? {};
  return {
    id: `${catId}/${sesId}`, sesId, categoriaId: catId, estado: d.estadoAsistencia,
    fecha: s.fecha ?? "", horaInicio: s.horaInicio ?? "", horaFin: s.horaFin ?? "", lugar: s.lugar ?? "",
    categoriaNombre: s.categoriaNombre ?? "", incompleto: !s.fecha,
  };
}
const ordenar = (a, b) => (b.fecha + b.horaInicio).localeCompare(a.fecha + a.horaInicio);

/** Jugador: todo su historial en una sola consulta (se filtra por período en memoria). */
export async function historialJugador(jugadorId) {
  const snap = await getDocs(query(collectionGroup(db, "asistencias"), where("jugadorId", "==", jugadorId)));
  const list = [];
  for (const x of snap.docs) {
    const d = x.data();
    const sesId = d.sesionId ?? x.ref?.parent?.parent?.id ?? "";
    let r = toReg(x.id, sesId, d.categoriaId ?? "", d);
    if (r.incompleto && d.categoriaId && sesId) {
      // Registro anterior a HU-012 sin copia de la sesión: se intenta leer la sesión (si las reglas lo permiten).
      try {
        const s = await getDoc(doc(db, "categorias", d.categoriaId, "entrenamientos", sesId));
        if (s.exists()) {
          let nombre = "";
          try { const c = await getDoc(doc(db, "categorias", d.categoriaId)); nombre = c.exists() ? (c.data().nombre ?? "") : ""; } catch { /* sin nombre */ }
          r = toReg(x.id, sesId, d.categoriaId, d, { ...s.data(), categoriaNombre: nombre });
        }
      } catch { /* queda marcado como incompleto */ }
    }
    list.push(r);
  }
  return list.sort(ordenar);
}

/** Entrenador: solo sesiones (pasadas o de hoy) de SUS categorías dentro del período. */
export async function historialEntrenador(jugadorId, cats, { desde, hasta }) {
  const hoy = hoyISO();
  const fin = !hasta || hasta > hoy ? hoy : hasta;
  const ini = desde || "2000-01-01";
  if (ini > fin) return [];
  const sesiones = await sesionesRango(cats.map((c) => c.id), ini, fin);
  const nombre = new Map(cats.map((c) => [c.id, c.nombre]));
  const regs = await Promise.all(sesiones.map(async (s) => {
    const a = await getDoc(doc(db, "categorias", s.categoriaId, "entrenamientos", s.id, "asistencias", jugadorId));
    if (!a.exists()) return null;
    const d = a.data();
    return toReg(a.id, s.id, s.categoriaId, d, d.sesion ?? { fecha: s.fecha, horaInicio: s.horaInicio, horaFin: s.horaFin, lugar: s.lugar, categoriaNombre: nombre.get(s.categoriaId) ?? "" });
  }));
  return regs.filter(Boolean).sort(ordenar);
}

/** Categorías del entrenador autenticado (consulta filtrada por su UID). */
export async function categoriasDe(uid) {
  const snap = await getDocs(query(collection(db, "categorias"), where("entrenadorId", "==", uid)));
  return snap.docs.map((x) => ({ id: x.id, ...x.data() }));
}

/* ---------------- Agrupación temporal ---------------- */
const MES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const toD = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
function lunes(d) { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }

/** Cubetas consecutivas (sin huecos) entre el primer y el último día del período o de los datos. */
export function cubetas(regs, modo, { desde, hasta }) {
  if (!regs.length) return [];
  const fechas = regs.map((r) => r.fecha).filter(Boolean).sort();
  const hoy = toD(hoyISO());
  const a = desde ? toD(desde) : toD(fechas[0]);                       // inicio del período (o primer registro)
  let b = hasta ? toD(hasta) : hoy; if (b > hoy) b = hoy;               // fin del período, nunca en el futuro
  const ult = toD(fechas[fechas.length - 1]); if (ult > b) b = ult;
  const out = [];
  if (modo === "mes") {
    for (let d = new Date(a.getFullYear(), a.getMonth(), 1); d <= b; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
      const ini = isoDate(d), fin = isoDate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
      out.push({ key: ini, label: `${MES[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`, largo: `${MES[d.getMonth()]} ${d.getFullYear()}`, ini, fin });
    }
  } else {
    for (let d = lunes(a); d <= b; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7)) {
      const f = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 6);
      out.push({ key: isoDate(d), label: `${d.getDate()} ${MES[d.getMonth()]}`, largo: `Semana del ${d.getDate()} ${MES[d.getMonth()]} al ${f.getDate()} ${MES[f.getMonth()]}`, ini: isoDate(d), fin: isoDate(f) });
    }
  }
  for (const c of out) c.res = resumen(regs.filter((r) => r.fecha >= c.ini && r.fecha <= c.fin));
  return out;
}
