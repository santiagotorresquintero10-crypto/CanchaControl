/* ==========================================================
   CanchaControl — Servicio de datos: Categorías (HU-004)
   ----------------------------------------------------------
   Colección: categorias/{categoriaId}
   Unicidad real (no solo en pantalla): categoriaClaves/{clave}
     clave = "nombre:<nombreNormalizado>" y "codigo:<codigoNormalizado>"
   Categoría + sus 2 claves se escriben en UNA operación atómica
   (batch). Si una clave ya existe, firestore.rules rechaza el lote
   completo y no se guarda nada.
   ========================================================== */
import {
  collection,
  doc,
  onSnapshot,
  writeBatch,
  runTransaction,
  query,
  where,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { db } from "./auth.js";

export const TIPO = Object.freeze({ EDAD: "rangoEdad", ANIO: "anioNacimiento" });
export const TIPO_LABEL = Object.freeze({ [TIPO.EDAD]: "Rango de edad", [TIPO.ANIO]: "Año de nacimiento" });
export const ESTADO_CAT = Object.freeze({ ACTIVA: "Activa", INACTIVA: "Inactiva" });

export const LIMITS = Object.freeze({
  EDAD_MIN: 3, EDAD_MAX: 80,
  ANIO_MIN: 1940,
  NOMBRE_MAX: 60, CODIGO_MAX: 12, DESC_MAX: 200,
});

export const MSG = Object.freeze({
  dupNombre: "Ya existe una categoría con este nombre.",
  dupCodigo: "Ya existe una categoría con este código de grupo.",
  dupRace: "Ya existe una categoría con este nombre o código de grupo.",
  noPermission: "No tienes permisos para realizar esta acción.",
  catMissing: "La categoría ya no existe. Actualiza la página.",
  coachMissing: "El entrenador seleccionado ya no existe.",
  coachNotCoach: "El usuario seleccionado no tiene rol Entrenador.",
  coachInactive: "El entrenador seleccionado está inactivo. Elige un entrenador activo.",
  assignChanged: "La asignación de esta categoría cambió mientras la editabas. Revisa el entrenador actual y vuelve a intentarlo.",
  sameCoach: "Ese entrenador ya es el responsable principal de esta categoría.",
  network: "Parece que no tienes conexión a internet.",
  generic: "No fue posible guardar la categoría. Intenta nuevamente.",
});

/* ---------------- Normalización ----------------
   "Benjamín", "BENJAMÍN" y " benjamín " → "benjamin" */
export function normalizeNombre(v) {
  return String(v ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim().toLowerCase();
}
/* "bj-01", " BJ - 01 " → "BJ-01" */
export function normalizeCodigo(v) {
  return String(v ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, "").toUpperCase();
}
export function cleanNombre(v) { return String(v ?? "").replace(/\s+/g, " ").trim(); }

/* ---------------- Períodos lectivos ----------------
   Formato canónico guardado: "AAAA-AAAA" (calendario B, p. ej. "2025-2026").
   Se muestra como "2025 - 2026". Las opciones se generan a partir del año
   actual (no están escritas a mano) y se suman los períodos ya usados. */
export const PERIODO_RE = /^(\d{4})-(\d{4})$/;
export function periodoLabel(p) {
  const m = PERIODO_RE.exec(p || "");
  return m ? `${m[1]} - ${m[2]}` : (p || "—");
}
export function periodOptions(existing = [], now = new Date()) {
  const y = now.getFullYear();
  const set = new Set(existing.filter((p) => PERIODO_RE.test(p)));
  for (let s = y - 1; s <= y + 1; s++) set.add(`${s}-${s + 1}`);
  return [...set].sort();
}
/** Período "actual": el que contiene la fecha de hoy (año escolar ago→jul aprox.). */
export function currentPeriodo(now = new Date()) {
  const y = now.getFullYear();
  return now.getMonth() >= 7 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

/* ---------------- Lectura ---------------- */
function toDate(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
function toCategoria(id, d) {
  return Object.freeze({
    id,
    nombre: d.nombre ?? "",
    nombreNormalizado: d.nombreNormalizado ?? normalizeNombre(d.nombre),
    codigoGrupo: d.codigoGrupo ?? "",
    codigoNormalizado: d.codigoNormalizado ?? normalizeCodigo(d.codigoGrupo),
    periodoLectivo: d.periodoLectivo ?? "",
    tipoConfiguracion: d.tipoConfiguracion,
    edadMinima: d.edadMinima ?? null,
    edadMaxima: d.edadMaxima ?? null,
    anioNacimientoInicio: d.anioNacimientoInicio ?? null,
    anioNacimientoFin: d.anioNacimientoFin ?? null,
    descripcion: d.descripcion ?? "",
    estado: d.estado,
    entrenadorId: d.entrenadorId ?? null,
    createdAt: toDate(d.createdAt),
  });
}

/**
 * Administrador: todas las categorías (alcance ALL, permissions.js).
 * HU-006 (Entrenador) NO usará esta función: consultará
 *   query(collection(db,"categorias"), where("entrenadorId","==",uid))
 * y las reglas solo le permitirán leer las suyas.
 */
export function subscribeCategorias(onData, onError) {
  return onSnapshot(
    collection(db, "categorias"),
    (snap) => {
      const list = [];
      snap.forEach((d) => list.push(toCategoria(d.id, d.data())));
      list.sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" }));
      onData(list);
    },
    (err) => onError?.(err)
  );
}

/**
 * HU-006 (preparado, aún sin pantalla): categorías del entrenador autenticado.
 * La consulta YA viene filtrada desde Firestore por su UID; las reglas
 * rechazan cualquier consulta que no lo esté. Nunca se descarga todo.
 */
export function subscribeMisCategorias(uid, onData, onError) {
  return onSnapshot(
    query(collection(db, "categorias"), where("entrenadorId", "==", uid)),
    (snap) => {
      const list = [];
      snap.forEach((d) => list.push(toCategoria(d.id, d.data())));
      list.sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" }));
      onData(list);
    },
    (err) => onError?.(err)
  );
}

/* ---------------- Asignar / cambiar entrenador principal (HU-005) ----------------
   Una categoría tiene 0 o 1 entrenador: el campo único entrenadorId (UID real).
   Se hace en una TRANSACCIÓN que vuelve a leer en el servidor:
     - que la categoría exista,
     - que el usuario exista, sea Entrenador y esté Activo (no se confía en el select),
     - que la asignación actual sea la que el Administrador estaba viendo
       (si otro admin la cambió entretanto, no se sobrescribe a ciegas).
   Solo cambia entrenadorId, updatedAt y updatedBy; createdAt/createdBy intactos. */
export async function assignEntrenador(categoriaId, entrenadorUid, { expectedCurrent, actorUid }) {
  const catRef = doc(db, "categorias", categoriaId);
  const userRef = doc(db, "users", entrenadorUid);
  await runTransaction(db, async (tx) => {
    const cat = await tx.get(catRef);
    if (!cat.exists()) throw codeError("cat-missing");
    const current = cat.data().entrenadorId ?? null;
    if (current !== (expectedCurrent ?? null)) throw codeError("assign-changed");
    if (current === entrenadorUid) throw codeError("same-coach");

    const u = await tx.get(userRef);
    if (!u.exists()) throw codeError("coach-missing");
    const ud = u.data();
    if (ud.rol !== "Entrenador") throw codeError("coach-not-coach");
    if (ud.estado !== "Activo") throw codeError("coach-inactive");

    tx.update(catRef, { entrenadorId: entrenadorUid, updatedAt: serverTimestamp(), updatedBy: actorUid });
  });
}

function codeError(code) { const e = new Error(code); e.code = code; return e; }

export function friendlyAssignError(err) {
  switch (err?.code) {
    case "cat-missing": return MSG.catMissing;
    case "coach-missing": return MSG.coachMissing;
    case "coach-not-coach": return MSG.coachNotCoach;
    case "coach-inactive": return MSG.coachInactive;
    case "assign-changed": return MSG.assignChanged;
    case "same-coach": return MSG.sameCoach;
    case "permission-denied": return MSG.noPermission;
    case "unavailable": return MSG.network;
    default: return navigator.onLine ? "No fue posible guardar la asignación. Intenta nuevamente." : MSG.network;
  }
}

/* ---------------- Rango legible ---------------- */
export function rangoLabel(c) {
  if (c.tipoConfiguracion === TIPO.EDAD && c.edadMinima != null) {
    return c.edadMinima === c.edadMaxima ? `${c.edadMinima} años` : `${c.edadMinima} - ${c.edadMaxima} años`;
  }
  if (c.tipoConfiguracion === TIPO.ANIO && c.anioNacimientoInicio != null) {
    return c.anioNacimientoInicio === c.anioNacimientoFin
      ? String(c.anioNacimientoInicio)
      : `${c.anioNacimientoInicio} - ${c.anioNacimientoFin}`;
  }
  return "—";
}

/* ---------------- Crear (CA-01, CA-02, CA-03) ---------------- */
/**
 * @param {object} input  ya validado por la pantalla
 * @param {string} actorUid  uid del Administrador (las reglas verifican que coincida)
 */
export async function createCategoria(input, actorUid) {
  const nombre = cleanNombre(input.nombre);
  const nombreNormalizado = normalizeNombre(nombre);
  const codigoNormalizado = normalizeCodigo(input.codigoGrupo);
  const esEdad = input.tipoConfiguracion === TIPO.EDAD;

  const catRef = doc(collection(db, "categorias")); // id automático
  const data = {
    nombre,
    nombreNormalizado,
    codigoGrupo: codigoNormalizado,
    codigoNormalizado,
    periodoLectivo: input.periodoLectivo,
    tipoConfiguracion: input.tipoConfiguracion,
    // Solo se guardan los campos del tipo elegido; los del otro tipo quedan en null
    edadMinima: esEdad ? input.edadMinima : null,
    edadMaxima: esEdad ? input.edadMaxima : null,
    anioNacimientoInicio: esEdad ? null : input.anioNacimientoInicio,
    anioNacimientoFin: esEdad ? null : input.anioNacimientoFin,
    descripcion: String(input.descripcion ?? "").trim(),
    estado: ESTADO_CAT.ACTIVA,       // CA-03: siempre Activa al crear
    entrenadorId: null,              // HU-005 lo asignará
    createdAt: serverTimestamp(),
    createdBy: actorUid,
    updatedAt: serverTimestamp(),
    updatedBy: actorUid,
  };

  const batch = writeBatch(db);
  batch.set(catRef, data);
  batch.set(doc(db, "categoriaClaves", `nombre:${nombreNormalizado}`), { tipo: "nombre", categoriaId: catRef.id });
  batch.set(doc(db, "categoriaClaves", `codigo:${codigoNormalizado}`), { tipo: "codigo", categoriaId: catRef.id });
  await batch.commit();
  return catRef.id;
}

export function friendlyCategoriaError(err) {
  if (!navigator.onLine || err?.code === "unavailable") return MSG.network;
  if (err?.code === "permission-denied") return null; // lo decide la pantalla (duplicado concurrente o sin permiso)
  return MSG.generic;
}
