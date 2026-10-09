/* ==========================================================
   CanchaControl — Servicio de datos: Gestión de usuarios (HU-002)
   ----------------------------------------------------------
   Solo lo usa usuarios.html (exclusivo Administrador).
   La autorización REAL está en firestore.rules: aunque alguien
   llame estas funciones desde DevTools, sin rol Administrador
   activo Firestore rechaza la lectura/escritura.
   ========================================================== */

import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  initializeAuth,
  inMemoryPersistence,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  collection,
  doc,
  onSnapshot,
  setDoc,
  updateDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

import { db } from "./auth.js";
import { firebaseConfig, USE_EMULATORS, EMULATOR_HOSTS, LOGIN_URL } from "./firebase-config.js";
import { ROLE, ROLES, ESTADO } from "./permissions.js";

export const MSG = Object.freeze({
  duplicate: "Ya existe una cuenta registrada con este correo electrónico.",
  noPermission: "No tienes permisos para realizar esta acción.",
  lastAdmin: "Debe existir al menos un Administrador activo en CanchaControl.",
  self: "No puedes cambiar tu propio rol ni tu estado desde esta pantalla.",
  signupDisabled:
    "Firebase tiene desactivada la creación de cuentas (Opción A). Actívala en Authentication → Configuración → Acciones de usuario, o crea la cuenta desde la consola de Firebase.",
  network: "Parece que no tienes conexión a internet.",
  weakPassword: "La contraseña es demasiado débil. Usa al menos 8 caracteres.",
  generic: "No fue posible completar la acción. Intenta nuevamente.",
  linkedPlayer: "Esta cuenta está vinculada a un expediente de jugador. Debes resolver la vinculación antes de cambiar su rol.",
});

/* ---------------- Lectura en vivo ---------------- */
function toDate(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();      // Timestamp de Firestore
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toUser(id, data) {
  return Object.freeze({
    uid: id,
    nombre: typeof data.nombre === "string" ? data.nombre : "",
    email: typeof data.email === "string" ? data.email : "",
    rol: data.rol,
    estado: data.estado,
    lastLoginAt: toDate(data.lastLoginAt),
    createdAt: toDate(data.createdAt),
    jugadorId: typeof data.jugadorId === "string" && data.jugadorId ? data.jugadorId : null, // HU-007: vínculo con su expediente
  });
}

/**
 * Escucha la colección users en tiempo real (solo Administrador puede, por reglas).
 * El Administrador tiene alcance ALL sobre "usuarios" (permissions.js), por eso
 * aquí sí se descarga la colección completa: no hay datos que no le correspondan.
 */
export function subscribeUsers(onData, onError) {
  return onSnapshot(
    collection(db, "users"),
    (snap) => {
      const list = [];
      snap.forEach((d) => list.push(toUser(d.id, d.data())));
      list.sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" }));
      onData(list);
    },
    (err) => onError?.(err)
  );
}

/* ---------------- Reglas de negocio (también en firestore.rules) ---------------- */
export function countActiveAdmins(users) {
  return users.filter((u) => u.rol === ROLE.ADMIN && u.estado === ESTADO.ACTIVO).length;
}

/**
 * Valida un cambio de rol/estado antes de enviarlo.
 * @returns {string|null} mensaje de bloqueo, o null si se permite.
 */
export function guardChange(actorUid, target, changes, allUsers) {
  const rolChanges = changes.rol !== undefined && changes.rol !== target.rol;
  const estadoChanges = changes.estado !== undefined && changes.estado !== target.estado;
  if (!rolChanges && !estadoChanges) return null;

  if (target.uid === actorUid) return MSG.self;

  // HU-007: una cuenta con expediente de jugador no puede dejar de ser Jugador
  // (no se desvincula automáticamente). firestore.rules aplica lo mismo.
  if (rolChanges && target.jugadorId && changes.rol !== ROLE.JUGADOR) return MSG.linkedPlayer;

  const wasActiveAdmin = target.rol === ROLE.ADMIN && target.estado === ESTADO.ACTIVO;
  const staysActiveAdmin =
    (changes.rol ?? target.rol) === ROLE.ADMIN && (changes.estado ?? target.estado) === ESTADO.ACTIVO;
  if (wasActiveAdmin && !staysActiveAdmin && countActiveAdmins(allUsers) <= 1) return MSG.lastAdmin;

  return null;
}

/* ---------------- Crear usuario (CA-02) ----------------
   Firebase Authentication + users/{uid}, sin tocar la sesión del Administrador:
   se usa una instancia SECUNDARIA y temporal de Firebase, con persistencia
   en memoria (nada se guarda en el navegador), que se destruye al terminar.
   No se usan claves administrativas: es la misma API pública del login.
   Si el perfil no se puede guardar, se elimina la cuenta recién creada
   (rollback) para no dejar una cuenta de Auth huérfana.               */
export async function createUser({ nombre, email, password, rol, estado }) {
  if (!ROLES.includes(rol)) throw codeError("invalid-role");
  if (![ESTADO.ACTIVO, ESTADO.INACTIVO].includes(estado)) throw codeError("invalid-state");

  const secondaryApp = initializeApp(firebaseConfig, `cc-alta-${Date.now()}`);
  const secondaryAuth = initializeAuth(secondaryApp, { persistence: inMemoryPersistence });
  secondaryAuth.languageCode = "es";
  if (USE_EMULATORS) connectAuthEmulator(secondaryAuth, EMULATOR_HOSTS.auth, { disableWarnings: true });

  const cleanEmail = email.trim().toLowerCase();
  try {
    const { user } = await createUserWithEmailAndPassword(secondaryAuth, cleanEmail, password);

    try {
      // La escribe la sesión del ADMINISTRADOR (instancia principal): las reglas lo exigen.
      await setDoc(doc(db, "users", user.uid), {
        uid: user.uid,
        nombre: nombre.trim(),
        email: cleanEmail,
        rol,
        estado,
        providers: ["password"],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        lastLoginAt: null, // "Nunca" hasta su primer acceso real
      });
    } catch (err) {
      await user.delete().catch(() => {}); // rollback: no dejar cuenta sin perfil
      throw err;
    }

    // El usuario recibe su enlace de verificación desde ya (opción B).
    const url = new URL(LOGIN_URL, window.location.href).href;
    await sendEmailVerification(user, { url }).catch(() => sendEmailVerification(user).catch(() => {}));

    return user.uid;
  } finally {
    await signOut(secondaryAuth).catch(() => {});
    await deleteApp(secondaryApp).catch(() => {});
  }
}

/* ---------------- Editar (CA-04) ----------------
   Campos editables: nombre, rol, estado. El correo es de SOLO LECTURA:
   cambiarlo aquí dejaría Firestore distinto de Authentication. */
export async function updateUser(uid, { nombre, rol, estado }) {
  const data = { updatedAt: serverTimestamp() };
  if (nombre !== undefined) data.nombre = nombre.trim();
  if (rol !== undefined) data.rol = rol;
  if (estado !== undefined) data.estado = estado;
  await updateDoc(doc(db, "users", uid), data);
}

export function setEstado(uid, estado) {
  return updateUser(uid, { estado });
}

/* ---------------- Errores → mensajes ---------------- */
function codeError(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

export function friendlyUserError(err) {
  const code = err?.code || "";
  if (!navigator.onLine) return MSG.network;
  switch (code) {
    case "auth/email-already-in-use":
      return MSG.duplicate;
    case "auth/invalid-email":
      return "Ingresa un correo electrónico válido.";
    case "auth/weak-password":
    case "auth/password-does-not-meet-requirements":
      return MSG.weakPassword;
    case "auth/admin-restricted-operation":
    case "auth/operation-not-allowed":
      return MSG.signupDisabled;
    case "auth/too-many-requests":
      return "Demasiadas solicitudes. Espera unos minutos e intenta nuevamente.";
    case "auth/network-request-failed":
    case "unavailable":
      return MSG.network;
    case "permission-denied":
      return MSG.noPermission;
    default:
      return MSG.generic;
  }
}
