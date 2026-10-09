/* ==========================================================
   CanchaControl — Núcleo de autenticación y autorización
   ----------------------------------------------------------
   Regla de oro: estar autenticado en Firebase ≠ estar autorizado
   en CanchaControl. El acceso exige:
     Auth ✓ → users/{uid} existe ✓ → estado "Activo" ✓ → rol válido ✓
   Esta validación es la capa de EXPERIENCIA. La capa de SEGURIDAD
   está en firestore.rules (cada colección debe exigir usuario activo).
   ========================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth,
  connectAuthEmulator,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  sendPasswordResetEmail,
  sendEmailVerification,
  signOut,
  linkWithCredential,
  onAuthStateChanged,
  GoogleAuthProvider,
  OAuthProvider,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore,
  connectFirestoreEmulator,
  doc,
  getDoc,
  updateDoc,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

import {
  firebaseConfig,
  isFirebaseConfigured,
  USE_EMULATORS,
  EMULATOR_HOSTS,
  MICROSOFT_TENANT,
} from "./firebase-config.js";
import { ROLES, ESTADO, isValidRole } from "./permissions.js";

/* ---------------- Inicialización ---------------- */
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

auth.languageCode = "es"; // ventanas OAuth y correos de Firebase en español

if (USE_EMULATORS) {
  connectAuthEmulator(auth, EMULATOR_HOSTS.auth, { disableWarnings: true });
  connectFirestoreEmulator(db, EMULATOR_HOSTS.firestore.host, EMULATOR_HOSTS.firestore.port);
}

/** La app puede operar: hay configuración real o se usan emuladores. */
export const isReady = isFirebaseConfigured || USE_EMULATORS;

/* ---------------- Roles y estados válidos ----------------
   Fuente única: permissions.js. Se re-exportan por compatibilidad. */
export const ESTADO_ACTIVO = ESTADO.ACTIVO;
export const ESTADO_INACTIVO = ESTADO.INACTIVO;
export { ROLES };

/* ---------------- Proveedores ---------------- */
export function createGoogleProvider() {
  const p = new GoogleAuthProvider();
  p.setCustomParameters({ prompt: "select_account" });
  return p;
}

export function createMicrosoftProvider() {
  const p = new OAuthProvider("microsoft.com");
  p.setCustomParameters({ prompt: "select_account", tenant: MICROSOFT_TENANT });
  return p;
}

export const PROVIDER_LABELS = {
  "password": "correo y contraseña",
  "google.com": "Google",
  "microsoft.com": "Microsoft",
};

/* ---------------- Errores de acceso (autorización) ---------------- */
export class AccessError extends Error {
  /**
   * @param {"no-profile"|"inactive"|"invalid-role"|"invalid-profile"|"unverified"|"network"|"profile-error"} code
   */
  constructor(code, message) {
    super(message);
    this.name = "AccessError";
    this.code = code;
  }
}

export const MESSAGES = {
  noProfile:  "No fue posible validar tu perfil de CanchaControl. Contacta con el administrador.",
  unavailable:"No fue posible conectar con CanchaControl. Revisa tu conexión e intenta nuevamente.",
  inactive:   "Tu cuenta se encuentra inactiva. Contacta con el administrador.",
  invalidRole:"Tu perfil no tiene un rol válido en CanchaControl. Contacta con el administrador.",
  network:    "Parece que no tienes conexión a internet.",
  generic:    "No fue posible iniciar sesión. Intenta nuevamente.",
};

/* ---------------- Persistencia ("Recordarme") ---------------- */
/**
 * local   → la sesión sobrevive al cerrar el navegador.
 * session → la sesión termina al cerrar la pestaña/ventana.
 * Firebase guarda solo su token de sesión; nunca la contraseña.
 */
export function applyPersistence(remember) {
  return setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence);
}

/* ---------------- Validación de acceso ---------------- */
/**
 * Verifica que un usuario autenticado esté autorizado en CanchaControl.
 * Si NO lo está, cierra la sesión y lanza AccessError.
 * El rol SIEMPRE se lee de Firestore; nunca de HTML, URL ni storage.
 * @returns {Promise<{uid:string,nombre:string,email:string,rol:string,estado:string}>}
 */
export async function verifyAccess(user) {
  if (!user) throw new AccessError("no-profile", MESSAGES.noProfile);

  let snap;
  try {
    // getDoc desde el servidor (o caché si no hay red: entonces falla con 'unavailable').
    snap = await getDoc(doc(db, "users", user.uid));
  } catch (err) {
    console.error("[CanchaControl] Error leyendo perfil:", err?.code || err);
    // Sin conexión: la sesión puede ser válida; NO se muestra nada privado,
    // pero tampoco se cierra la sesión por un corte de red.
    if (err?.code === "unavailable" || !navigator.onLine) {
      throw new AccessError("network", MESSAGES.network);
    }
    // permission-denied u otros: no revelar detalles técnicos
    await safeSignOut();
    throw new AccessError("profile-error", MESSAGES.noProfile);
  }

  if (!snap.exists()) {
    await safeSignOut();
    throw new AccessError("no-profile", MESSAGES.noProfile);
  }

  const data = snap.data() || {};

  if (data.estado !== ESTADO_ACTIVO) {
    await safeSignOut();
    if (data.estado === ESTADO_INACTIVO) throw new AccessError("inactive", MESSAGES.inactive);
    throw new AccessError("invalid-profile", MESSAGES.noProfile);
  }

  if (!isValidRole(data.rol)) {
    await safeSignOut();
    throw new AccessError("invalid-role", MESSAGES.invalidRole);
  }

  // Correo verificado obligatorio para quien entra con contraseña.
  if (await needsEmailVerification(user)) {
    const message = await sendVerificationThrottled(user);
    await safeSignOut();
    throw new AccessError("unverified", message);
  }

  return Object.freeze({
    uid: user.uid,
    nombre: typeof data.nombre === "string" && data.nombre.trim() ? data.nombre.trim() : (user.displayName || user.email || "Usuario"),
    email: data.email || user.email || "",
    rol: data.rol,
    estado: data.estado,
  });
}

/**
 * Evalúa un perfil ya leído (sin red). Lo usa la vigilancia en vivo
 * del authGuard para expulsar si el admin cambia estado o rol.
 * @returns {null | AccessError}
 */
export function checkProfileData(data) {
  if (!data) return new AccessError("no-profile", MESSAGES.noProfile);
  if (data.estado !== ESTADO_ACTIVO) {
    return data.estado === ESTADO_INACTIVO
      ? new AccessError("inactive", MESSAGES.inactive)
      : new AccessError("invalid-profile", MESSAGES.noProfile);
  }
  if (!isValidRole(data.rol)) return new AccessError("invalid-role", MESSAGES.invalidRole);
  return null;
}

/**
 * Escucha en vivo users/{uid}. Llama onChange(data|null) en cada cambio.
 * Devuelve la función para dejar de escuchar.
 */
export function watchProfile(uid, onChange, onError) {
  return onSnapshot(
    doc(db, "users", uid),
    (snap) => onChange(snap.exists() ? snap.data() : null),
    (err) => onError?.(err)
  );
}

/** Notifica cambios de sesión (login, logout, sesión expirada o revocada). */
export function onSessionChange(cb) {
  return onAuthStateChanged(auth, cb);
}

/* ---------------- Verificación de correo ---------------- */
/**
 * Se exige solo al entrar con contraseña. Google ya entrega correos verificados;
 * Microsoft no siempre lo informa, pero la identidad la garantiza Microsoft.
 * (firestore.rules aplica exactamente el mismo criterio.)
 */
export async function needsEmailVerification(user) {
  if (user.emailVerified) return false;
  let provider = null;
  try { provider = (await user.getIdTokenResult()).signInProvider; } catch { /* sin red */ }
  if (provider !== "password") return false;
  // Puede haberlo verificado en otra pestaña: refrescar antes de decidir.
  try {
    await user.reload();
    if (user.emailVerified) { await user.getIdToken(true); return false; }
  } catch { /* sin red: se trata como no verificado */ }
  return true;
}

const VERIF_KEY = (uid) => `cc:verif:${uid}`;
const VERIF_COOLDOWN_MS = 5 * 60 * 1000;

/** Envía el enlace de verificación como máximo cada 5 minutos por usuario. */
async function sendVerificationThrottled(user) {
  const email = user.email || "tu correo";
  const already = `Debes verificar tu correo antes de entrar. Ya te enviamos un enlace a ${email}: revisa tu bandeja de entrada y spam, ábrelo y vuelve a iniciar sesión.`;
  let last = 0;
  try { last = Number(localStorage.getItem(VERIF_KEY(user.uid))) || 0; } catch { /* sin storage */ }
  if (Date.now() - last < VERIF_COOLDOWN_MS) return already;

  try {
    const url = new URL("login.html", window.location.href).href;
    try {
      await sendEmailVerification(user, { url });
    } catch (err) {
      if (["auth/unauthorized-continue-uri", "auth/invalid-continue-uri"].includes(err?.code)) await sendEmailVerification(user);
      else throw err;
    }
    try { localStorage.setItem(VERIF_KEY(user.uid), String(Date.now())); } catch { /* sin storage */ }
    return `Debes verificar tu correo antes de entrar. Te enviamos un enlace a ${email}. Ábrelo y vuelve a iniciar sesión.`;
  } catch (err) {
    console.warn("[CanchaControl] Verificación:", err?.code || err);
    if (err?.code === "auth/too-many-requests") return already;
    return `Debes verificar tu correo antes de entrar y no pudimos enviarte el enlace. Intenta de nuevo en unos minutos o contacta con el administrador.`;
  }
}

/**
 * Registra último acceso y proveedores vinculados.
 * No bloquea el login si falla (p. ej. reglas aún no desplegadas).
 */
export async function recordLogin(user) {
  try {
    await updateDoc(doc(db, "users", user.uid), {
      lastLoginAt: serverTimestamp(),
      providers: user.providerData.map((p) => p.providerId).sort(),
    });
  } catch (err) {
    console.warn("[CanchaControl] No se pudo registrar lastLoginAt:", err?.code || err);
  }
}

/* ---------------- Acciones ---------------- */
export function loginWithEmail(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

/** Debe llamarse SINCRÓNICAMENTE dentro del click (si no, el navegador bloquea el popup). */
export function loginWithProvider(providerId) {
  const provider = providerId === "google.com" ? createGoogleProvider() : createMicrosoftProvider();
  return signInWithPopup(auth, provider);
}

/** Extrae la credencial OAuth pendiente de un error account-exists-with-different-credential. */
export function credentialFromError(providerId, err) {
  return providerId === "google.com"
    ? GoogleAuthProvider.credentialFromError(err)
    : OAuthProvider.credentialFromError(err);
}

export function linkCredential(user, credential) {
  return linkWithCredential(user, credential);
}

export async function requestPasswordReset(email, continueUrl) {
  try {
    await sendPasswordResetEmail(auth, email, continueUrl ? { url: continueUrl } : undefined);
  } catch (err) {
    // Si el dominio de retorno no está autorizado, reintentar sin URL de retorno.
    if (continueUrl && ["auth/unauthorized-continue-uri", "auth/invalid-continue-uri", "auth/missing-continue-uri"].includes(err?.code)) {
      return sendPasswordResetEmail(auth, email);
    }
    throw err;
  }
}

export async function safeSignOut() {
  try { await signOut(auth); } catch (err) { console.warn("[CanchaControl] signOut:", err?.code || err); }
}

/* ---------------- Traducción de errores ---------------- */
/**
 * Convierte errores técnicos de Firebase en mensajes para el usuario.
 * Devuelve null cuando no hay que mostrar nada (p. ej. el usuario cerró el popup).
 */
export function friendlyAuthError(err) {
  if (err instanceof AccessError) return err.message;
  const code = err?.code || "";
  if (!navigator.onLine) return MESSAGES.network;

  switch (code) {
    case "auth/invalid-credential":
    case "auth/invalid-login-credentials":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Correo o contraseña incorrectos.";
    case "auth/invalid-email":
      return "Ingresa un correo electrónico válido.";
    case "auth/missing-password":
      return "Ingresa tu contraseña.";
    case "auth/user-disabled":
      return "Tu cuenta se encuentra deshabilitada. Contacta con el administrador.";
    case "auth/too-many-requests":
      return "Demasiados intentos fallidos. Espera unos minutos e intenta nuevamente.";
    case "auth/network-request-failed":
    case "unavailable":
      return MESSAGES.network;
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
    case "auth/user-cancelled":
      return null;
    case "auth/popup-blocked":
      return "Tu navegador bloqueó la ventana de inicio de sesión. Permite ventanas emergentes para este sitio e intenta nuevamente.";
    case "auth/admin-restricted-operation":
      return "Tu cuenta no está habilitada en CanchaControl. Contacta con el administrador.";
    case "auth/operation-not-allowed":
      return "Este método de acceso aún no está habilitado. Contacta con el administrador.";
    case "auth/unauthorized-domain":
      return "Este sitio no está autorizado para iniciar sesión. Contacta con el administrador.";
    case "auth/credential-already-in-use":
      return "Esa cuenta externa ya está vinculada a otro usuario de CanchaControl.";
    case "auth/invalid-api-key":
    case "auth/api-key-not-valid.-please-pass-a-valid-api-key.":
    case "auth/configuration-not-found":
      return "El acceso no está configurado correctamente. Contacta con el administrador.";
    default:
      return MESSAGES.generic;
  }
}

/* ---------------- Validaciones de formulario ---------------- */
// Suficiente para UX; la validación definitiva la hace Firebase.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function isValidEmail(value) {
  return EMAIL_RE.test(String(value).trim());
}
