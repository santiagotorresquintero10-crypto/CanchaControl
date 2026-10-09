/* ==========================================================
   CanchaControl — Servicio de datos: Expedientes de jugadores (HU-007)
   ----------------------------------------------------------
   CUENTA (users/{uid})  ↔  EXPEDIENTE (jugadores/{jugadorId})
     jugadores/{jugadorId}.userId = UID real de Firebase Authentication
     users/{uid}.jugadorId        = id del expediente (vínculo inverso)
   Unicidad real (no solo en pantalla):
     - 1 cuenta ↔ 1 expediente: users/{uid}.jugadorId solo puede pasar de
       vacío a un id, y solo en la MISMA operación que crea ese expediente.
     - documento único: jugadorClaves/doc:<documentoNormalizado>
   Foto (opcional): jugadorFotos/{jugadorId}.data = imagen JPEG en base64,
     reducida en el navegador (256×256). Va en un documento APARTE para que
     el listado no descargue imágenes de todos los jugadores. $0 (sin Storage).
   Crear y editar se hacen en TRANSACCIONES (todo o nada) que vuelven a
   leer en el servidor; firestore.rules exige lo mismo.
   ========================================================== */
import {
  collection, doc, onSnapshot, runTransaction, writeBatch, getDoc, getDocs, getCountFromServer, query, where, limit, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { db } from "./auth.js";

export const TIPOS_DOC = Object.freeze([
  ["RC", "Registro civil"],
  ["TI", "Tarjeta de identidad"],
  ["CC", "Cédula de ciudadanía"],
  ["CE", "Cédula de extranjería"],
  ["PA", "Pasaporte"],
  ["PPT", "Permiso por protección temporal"],
]);
export const TIPO_DOC_LABEL = Object.freeze(Object.fromEntries(TIPOS_DOC));
export const PARENTESCOS = Object.freeze(["Madre", "Padre", "Acudiente", "Abuelo(a)", "Hermano(a)", "Tío(a)", "Otro"]);
export const POSICIONES = Object.freeze(["Por definir", "Portero", "Defensa", "Mediocampista", "Delantero"]);
export const GENEROS = Object.freeze(["Masculino", "Femenino", "Otro"]);
export const ESTADO_JUG = Object.freeze({ ACTIVO: "Activo", INACTIVO: "Inactivo" });

export const LIMITS = Object.freeze({ NOMBRE_MAX: 60, DOC_MIN: 3, DOC_MAX: 20, DIR_MAX: 150, MAIL_MAX: 120, CIUDAD_MAX: 60, OBS_MAX: 500, ANIO_MIN: 1940,
  FOTO_IN_MAX: 5 * 1024 * 1024, FOTO_SIDE: 256, FOTO_OUT_MAX: 280000 });

export const MSG = Object.freeze({
  accountMissing: "La cuenta seleccionada ya no existe.",
  accountNotPlayer: "La cuenta seleccionada no tiene rol Jugador.",
  accountInactive: "La cuenta seleccionada está inactiva. Actívala en Gestión de usuarios o elige otra.",
  accountLinked: "Esta cuenta ya está vinculada a un expediente de jugador.",
  dupDoc: "Ya existe un jugador registrado con este documento.",
  missing: "El expediente ya no existe. Actualiza la página.",
  photoType: "Usa una imagen JPG, PNG o WebP.",
  photoBig: "La imagen supera 5 MB. Elige una más liviana.",
  photoRead: "No fue posible leer la imagen. Prueba con otra.",
  // HU-008
  catRequired: "Selecciona una categoría para continuar.",
  catMissing: "La categoría seleccionada ya no existe.",
  catInactive: "No es posible asignar jugadores a una categoría inactiva.",
  catSame: "El jugador ya pertenece a esa categoría.",
  catChanged: "Otro administrador cambió la categoría de este jugador mientras el formulario estaba abierto. Revisa la categoría actual e intenta nuevamente.",
  noAuth: "No tienes autorización para realizar esta acción.",
  conflict: "Otra persona modificó este expediente mientras lo editabas. Cierra y vuelve a abrirlo para ver los datos actuales.",
  noPermission: "No tienes permisos para realizar esta acción.",
  network: "Parece que no tienes conexión a internet.",
  generic: "No fue posible guardar el expediente. Intenta nuevamente.",
});

/* ---------------- Normalización ----------------
   "123456", " 123456", "123 456", "123.456" y "123-456" → "123456"
   (letras se conservan en mayúscula: pasaportes). */
export function normalizeDocumento(v) {
  return String(v ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
export const cleanText = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

/* ---------------- Fecha de nacimiento → edad (nunca se guarda la edad) ---------------- */
export const FECHA_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export function parseFecha(s) {
  const m = FECHA_RE.exec(s || "");
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null;
}
export function edad(fecha, now = new Date()) {
  const d = parseFecha(fecha);
  if (!d) return null;
  let a = now.getFullYear() - d.getFullYear();
  if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) a--;
  return a;
}
export function todayISO(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/* ---------------- Lectura (solo Administrador en HU-007; reglas) ---------------- */
function ms(v) {
  if (!v) return 0;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v.toDate === "function") return v.toDate().getTime();
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? 0 : t;
}
function toJugador(id, d) {
  const em = d.emergencia ?? {};
  return Object.freeze({
    id,
    userId: d.userId ?? null,
    nombres: d.nombres ?? "", apellidos: d.apellidos ?? "",
    tipoDocumento: d.tipoDocumento ?? "", numeroDocumento: d.numeroDocumento ?? "", documentoNormalizado: d.documentoNormalizado ?? "",
    fechaNacimiento: d.fechaNacimiento ?? "",
    genero: d.genero ?? "", ciudadNacimiento: d.ciudadNacimiento ?? "", observaciones: d.observaciones ?? "",
    telefono: d.telefono ?? "", correoContacto: d.correoContacto ?? "", direccion: d.direccion ?? "", ciudad: d.ciudad ?? "",
    emergencia: Object.freeze({ nombre: em.nombre ?? "", parentesco: em.parentesco ?? "", telefono: em.telefono ?? "" }),
    posicion: d.posicion ?? "", numeroCamiseta: d.numeroCamiseta ?? null,
    fechaIngreso: d.fechaIngreso ?? "", observacionesDeportivas: d.observacionesDeportivas ?? "",
    estado: d.estado ?? "",
    categoriaId: d.categoriaId ?? null,
    updatedAtMs: ms(d.updatedAt),
    createdAtMs: ms(d.createdAt),
  });
}
export const nombreCompleto = (j) => `${j.nombres} ${j.apellidos}`.trim();

/** Administrador: todos los expedientes (alcance ALL). Entrenador/Jugador: las reglas lo rechazan. */
export function subscribeJugadores(onData, onError) {
  return onSnapshot(
    collection(db, "jugadores"),
    (snap) => {
      const list = [];
      snap.forEach((x) => list.push(toJugador(x.id, x.data())));
      list.sort((a, b) => nombreCompleto(a).localeCompare(nombreCompleto(b), "es", { sensitivity: "base" }));
      onData(list);
    },
    (err) => onError?.(err)
  );
}

/* ---------------- Escritura ---------------- */
const claveRef = (docNorm) => doc(db, "jugadorClaves", `doc:${docNorm}`);

function expedienteFields(input) {
  return {
    nombres: cleanText(input.nombres),
    apellidos: cleanText(input.apellidos),
    tipoDocumento: input.tipoDocumento,
    numeroDocumento: cleanText(input.numeroDocumento),
    documentoNormalizado: normalizeDocumento(input.numeroDocumento),
    fechaNacimiento: input.fechaNacimiento,
    genero: input.genero,
    ciudadNacimiento: cleanText(input.ciudadNacimiento),
    observaciones: String(input.observaciones ?? "").trim(),
    telefono: cleanText(input.telefono),
    correoContacto: cleanText(input.correoContacto).toLowerCase(),
    direccion: cleanText(input.direccion),
    ciudad: cleanText(input.ciudad),
    emergencia: {
      nombre: cleanText(input.emergencia.nombre),
      parentesco: input.emergencia.parentesco,
      telefono: cleanText(input.emergencia.telefono),
    },
    posicion: input.posicion,
    numeroCamiseta: input.numeroCamiseta ?? null,
    fechaIngreso: input.fechaIngreso || "",
    observacionesDeportivas: String(input.observacionesDeportivas ?? "").trim(),
    estado: input.estado,
  };
}

/* ==========================================================
   HU-009 — FICHA DEPORTIVA (proyección para el Entrenador)
   categorias/{categoriaId}/nomina/{jugadorId}
   Las reglas de Firestore autorizan DOCUMENTOS, no campos: si el entrenador
   pudiera leer jugadores/{id}, recibiría también dirección, documento,
   emergencia, observaciones… Por eso el entrenador NUNCA lee el expediente:
   lee esta ficha, que solo contiene la LISTA BLANCA de campos deportivos.
   - Vive DENTRO de la categoría actual: la regla de lectura es
     "categorias/{categoriaId}.entrenadorId == mi UID" (ruta, no dato del cliente).
   - Se escribe en la MISMA transacción que el expediente (crear no aplica:
     sin categoría no hay ficha; editar, asignar y trasladar sí). Las reglas
     exigen que coincida campo a campo con el expediente: no puede desincronizarse.
   - Trasladar = borrar la ficha de la categoría anterior + crearla en la nueva.
   ========================================================== */
// Lista blanca acordada con la dirección (HU-009): identificación + datos deportivos.
// NUNCA: contacto, dirección, emergencia, observaciones, cuenta (userId/correo).
export const FICHA_CAMPOS = Object.freeze(["nombres", "apellidos", "tipoDocumento", "numeroDocumento", "fechaNacimiento", "genero",
  "posicion", "numeroCamiseta", "estado"]);
export function fichaDe(d) {
  return {
    nombres: d.nombres ?? "", apellidos: d.apellidos ?? "",
    tipoDocumento: d.tipoDocumento ?? "", numeroDocumento: d.numeroDocumento ?? "",
    fechaNacimiento: d.fechaNacimiento ?? "", genero: d.genero ?? "",
    posicion: d.posicion ?? "", numeroCamiseta: d.numeroCamiseta ?? null, estado: d.estado ?? "",
    updatedAt: serverTimestamp(),
  };
}
export const fichaRef = (categoriaId, jugadorId) => doc(db, "categorias", categoriaId, "nomina", jugadorId);

/** Entrenador: nómina (fichas) de UNA categoría propia. Las reglas validan que sea suya. */
export function subscribeFichas(categoriaId, onData, onError) {
  return onSnapshot(
    collection(db, "categorias", categoriaId, "nomina"),
    (snap) => {
      const list = [];
      snap.forEach((x) => { const d = x.data(); list.push(Object.freeze({
        id: x.id, nombres: d.nombres ?? "", apellidos: d.apellidos ?? "", fechaNacimiento: d.fechaNacimiento ?? "",
        tipoDocumento: d.tipoDocumento ?? "", numeroDocumento: d.numeroDocumento ?? "", genero: d.genero ?? "",
        posicion: d.posicion ?? "", numeroCamiseta: d.numeroCamiseta ?? null, estado: d.estado ?? "" })); });
      list.sort((a, b) => nombreCompleto(a).localeCompare(nombreCompleto(b), "es", { sensitivity: "base" }));
      onData(list);
    },
    (err) => onError?.(err)
  );
}

/**
 * Crea el expediente y lo vincula a la cuenta en UNA transacción:
 *   jugadores/{nuevo}  +  users/{uid}.jugadorId  +  jugadorClaves/doc:<n>
 * Si cualquier verificación falla, no se escribe NADA.
 */
export async function createJugador(userId, input, actorUid, foto = null) {
  const data = expedienteFields(input);
  // Verificación adicional: ¿ya existe un expediente con este userId? (las transacciones web no admiten consultas)
  const prev = await getDocs(query(collection(db, "jugadores"), where("userId", "==", userId), limit(1)));
  if (!prev.empty) throw codeError("account-linked");

  const userRef = doc(db, "users", userId);
  const jugRef = doc(collection(db, "jugadores")); // id automático
  const kRef = claveRef(data.documentoNormalizado);

  await runTransaction(db, async (tx) => {
    const u = await tx.get(userRef);
    const k = await tx.get(kRef);
    if (!u.exists()) throw codeError("account-missing");
    const ud = u.data();
    if (ud.rol !== "Jugador") throw codeError("account-not-player");
    if (ud.estado !== "Activo") throw codeError("account-inactive");
    if (ud.jugadorId) throw codeError("account-linked");
    if (k.exists()) throw codeError("dup-doc");

    tx.set(jugRef, {
      userId,
      ...data,
      categoriaId: null,            // HU-008: vínculo jugador → categoría
      createdAt: serverTimestamp(), createdBy: actorUid,
      updatedAt: serverTimestamp(), updatedBy: actorUid,
    });
    tx.update(userRef, { jugadorId: jugRef.id, updatedAt: serverTimestamp() });
    tx.set(kRef, { tipo: "documento", jugadorId: jugRef.id });
    if (foto) tx.set(fotoRef(jugRef.id), { data: foto, updatedAt: serverTimestamp(), updatedBy: actorUid });
  });
  fotoCache.set(jugRef.id, foto ?? null);
  return jugRef.id;
}

/**
 * Edita el MISMO documento. userId, categoriaId, createdAt y createdBy no se tocan.
 * Si cambia el documento: se valida que no sea de otro jugador, se libera la clave
 * anterior y se reserva la nueva, todo en la misma transacción.
 * expectedUpdatedAtMs: si otro Administrador guardó entretanto → conflicto.
 */
/** foto: undefined = no cambia · null = quitar · "data:image/jpeg;base64,…" = reemplazar */
export async function updateJugador(jugadorId, input, { expectedUpdatedAtMs, actorUid, foto }) {
  const data = expedienteFields(input);
  const jugRef = doc(db, "jugadores", jugadorId);
  await runTransaction(db, async (tx) => {
    const j = await tx.get(jugRef);
    if (!j.exists()) throw codeError("missing");
    const cur = j.data();
    if (expectedUpdatedAtMs && ms(cur.updatedAt) !== expectedUpdatedAtMs) throw codeError("conflict");
    const changedDoc = cur.documentoNormalizado !== data.documentoNormalizado;
    if (changedDoc) {
      const k = await tx.get(claveRef(data.documentoNormalizado));
      if (k.exists() && k.data().jugadorId !== jugadorId) throw codeError("dup-doc");
    }
    tx.update(jugRef, { ...data, updatedAt: serverTimestamp(), updatedBy: actorUid });
    // HU-009: la ficha deportiva de su categoría actual se actualiza en la misma operación
    if (cur.categoriaId) tx.set(fichaRef(cur.categoriaId, jugadorId), fichaDe({ ...cur, ...data }));
    if (changedDoc) {
      tx.delete(claveRef(cur.documentoNormalizado));
      tx.set(claveRef(data.documentoNormalizado), { tipo: "documento", jugadorId });
    }
    if (foto === null) tx.delete(fotoRef(jugadorId));
    else if (foto) tx.set(fotoRef(jugadorId), { data: foto, updatedAt: serverTimestamp(), updatedBy: actorUid });
  });
  if (foto !== undefined) fotoCache.set(jugadorId, foto);
}

/* ---------------- Foto (base64, sin Storage) ---------------- */
const fotoRef = (id) => doc(db, "jugadorFotos", id);
const fotoCache = new Map();   // jugadorId → dataURL | null (solo en memoria de esta pestaña)

/** Foto de un jugador (o null). Se pide solo para lo que está en pantalla. */
export async function getFoto(jugadorId) {
  if (fotoCache.has(jugadorId)) return fotoCache.get(jugadorId);
  try {
    const snap = await getDoc(fotoRef(jugadorId));
    const v = snap.exists() && typeof snap.data().data === "string" ? snap.data().data : null;
    fotoCache.set(jugadorId, v);
    return v;
  } catch {
    return null; // sin foto → iniciales
  }
}

/**
 * Convierte el archivo elegido en una foto cuadrada 256×256 JPEG (base64).
 * Recorta al centro, fondo blanco (PNG transparentes) y comprime hasta
 * quedar por debajo del límite que también exige firestore.rules.
 */
export async function prepararFoto(file) {
  if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw codeError("photo-type");
  if (file.size > LIMITS.FOTO_IN_MAX) throw codeError("photo-big");
  let img;
  try {
    img = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const i = new Image();
      i.onload = () => { URL.revokeObjectURL(url); resolve(i); };
      i.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode")); };
      i.src = url;
    });
  } catch { throw codeError("photo-read"); }
  const S = LIMITS.FOTO_SIDE;
  const c = document.createElement("canvas");
  c.width = S; c.height = S;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, S, S);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  if (!side) throw codeError("photo-read");
  ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, S, S);
  for (const q of [0.82, 0.7, 0.55, 0.4]) {
    const out = c.toDataURL("image/jpeg", q);
    if (out.length <= LIMITS.FOTO_OUT_MAX) return out;
  }
  throw codeError("photo-big");
}

function codeError(code) { const e = new Error(code); e.code = code; return e; }

/* ==========================================================
   HU-008 — Jugador → Categoría
   jugadores/{id}.categoriaId es la ÚNICA fuente de verdad (una categoría
   actual por jugador). La nómina NO se guarda en la categoría: se consulta.
   El entrenador NO se copia al expediente: se deriva de
   categorias/{categoriaId}.entrenadorId en el momento de consultar.
   ========================================================== */

/**
 * Asigna o cambia la categoría del MISMO expediente, en una transacción que
 * vuelve a leer en el servidor:
 *   - el jugador existe y su categoría actual es la que el Administrador veía
 *     (si otro la cambió entretanto → "cat-changed", no se sobrescribe),
 *   - no es la misma categoría (sin escritura redundante),
 *   - la categoría existe y está Activa.
 * Solo cambia categoriaId, updatedAt y updatedBy.
 */
export async function asignarCategoria(jugadorId, categoriaId, { expectedCategoriaId, actorUid }) {
  if (!categoriaId) throw codeError("cat-required");
  const jugRef = doc(db, "jugadores", jugadorId);
  const catRef = doc(db, "categorias", categoriaId);
  await runTransaction(db, async (tx) => {
    const j = await tx.get(jugRef);
    const c = await tx.get(catRef);
    if (!j.exists()) throw codeError("missing");
    const actual = j.data().categoriaId ?? null;
    if (actual !== (expectedCategoriaId ?? null)) throw codeError("cat-changed");
    if (actual === categoriaId) throw codeError("cat-same");
    if (!c.exists()) throw codeError("cat-missing");
    if (c.data().estado !== "Activa") throw codeError("cat-inactive");
    tx.update(jugRef, { categoriaId, updatedAt: serverTimestamp(), updatedBy: actorUid });
    // HU-009: la ficha sale de la nómina anterior y entra a la nueva (el entrenador anterior pierde el acceso)
    if (actual) tx.delete(fichaRef(actual, jugadorId));
    tx.set(fichaRef(categoriaId, jugadorId), fichaDe(j.data()));
  });
}

/**
 * HU-009 — Puesta al día de fichas (solo Administrador, idempotente).
 * Para expedientes vinculados ANTES de existir las fichas (HU-008), o si alguna
 * faltara: compara la nómina de cada categoría con los expedientes y escribe
 * solo lo que falta o difiere; borra fichas que no corresponden.
 * @returns {Promise<number>} cantidad de fichas corregidas
 */
export async function sincronizarFichas(jugadores) {
  const porCat = new Map();
  for (const j of jugadores) if (j.categoriaId) { if (!porCat.has(j.categoriaId)) porCat.set(j.categoriaId, []); porCat.get(j.categoriaId).push(j); }
  let cambios = 0;
  for (const [catId, lista] of porCat) {
    const snap = await getDocs(collection(db, "categorias", catId, "nomina"));
    const actuales = new Map(); snap.forEach((x) => actuales.set(x.id, x.data()));
    const batch = writeBatch(db); let n = 0;
    for (const j of lista) {
      const f = actuales.get(j.id); const esperada = fichaDe(j);
      const igual = f && FICHA_CAMPOS.every((k) => (f[k] ?? null) === (esperada[k] ?? null));
      if (!igual) { batch.set(fichaRef(catId, j.id), esperada); n++; }
      actuales.delete(j.id);
    }
    for (const id of actuales.keys()) { batch.delete(fichaRef(catId, id)); n++; }   // fichas que ya no corresponden
    if (n) { await batch.commit(); cambios += n; }
  }
  return cambios;
}

/** Nómina de una categoría: consulta por categoriaId (nunca una lista guardada aparte). */
export function subscribeNomina(categoriaId, onData, onError) {
  return onSnapshot(
    query(collection(db, "jugadores"), where("categoriaId", "==", categoriaId)),
    (snap) => {
      const list = [];
      snap.forEach((x) => list.push(toJugador(x.id, x.data())));
      list.sort((a, b) => nombreCompleto(a).localeCompare(nombreCompleto(b), "es", { sensitivity: "base" }));
      onData(list);
    },
    (err) => onError?.(err)
  );
}

/** Cantidad real de jugadores vinculados (agregación en el servidor: no descarga expedientes). */
export async function contarJugadores(categoriaId) {
  const snap = await getCountFromServer(query(collection(db, "jugadores"), where("categoriaId", "==", categoriaId)));
  return snap.data().count;
}

export function friendlyJugadorError(err) {
  switch (err?.code) {
    case "account-missing": return MSG.accountMissing;
    case "account-not-player": return MSG.accountNotPlayer;
    case "account-inactive": return MSG.accountInactive;
    case "account-linked": return MSG.accountLinked;
    case "dup-doc": return MSG.dupDoc;
    case "missing": return MSG.missing;
    case "conflict": return MSG.conflict;
    case "cat-required": return MSG.catRequired;
    case "cat-missing": return MSG.catMissing;
    case "cat-inactive": return MSG.catInactive;
    case "cat-same": return MSG.catSame;
    case "cat-changed": return MSG.catChanged;
    case "photo-type": return MSG.photoType;
    case "photo-big": return MSG.photoBig;
    case "photo-read": return MSG.photoRead;
    case "permission-denied": return MSG.noPermission;
    case "unavailable": return MSG.network;
    default: return navigator.onLine ? MSG.generic : MSG.network;
  }
}
