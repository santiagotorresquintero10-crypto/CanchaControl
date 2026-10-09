/* ==========================================================
   CanchaControl — Guardián de páginas privadas (HU-003)
   ----------------------------------------------------------
   Uso en cualquier página privada:

     import { protectPage } from "./authGuard.js";
     protectPage({ page: "dashboard", onReady: (profile) => { ...pintar... } });
     // o con roles explícitos:
     protectPage({ allowedRoles: ["Administrador"], onReady });

   Flujo (en este orden; si algo falla NO se muestra nada privado):
     sesión Firebase → users/{uid} existe → estado Activo → rol válido
     → correo verificado (si entró con contraseña) → rol autorizado
     → onReady(profile) pinta los datos → se revela el contenido.

   Requisitos del HTML de la página privada:
     - #boot-loader visible desde el inicio ("Validando sesión…")
     - el contenido privado dentro de un elemento con [data-private] y
       el atributo hidden, SIN datos escritos en el HTML.
   ========================================================== */

import {
  auth,
  isReady,
  verifyAccess,
  checkProfileData,
  watchProfile,
  onSessionChange,
  safeSignOut,
  friendlyAuthError,
  MESSAGES,
} from "./auth.js";
import { LOGIN_URL } from "./firebase-config.js";
import { rolesForPage, canAccessPage, homeFor } from "./permissions.js";
import { setFlash, hideBootLoader, renderStatusScreen } from "./ui.js";

let leaving = false;          // evita redirecciones duplicadas
let stopProfileWatch = null;  // listener en vivo de users/{uid}

/** Sale a login reemplazando la entrada del historial (el "Atrás" no vuelve aquí). */
function goLogin(flash) {
  if (leaving) return;
  leaving = true;
  if (flash?.message) setFlash(flash.type, flash.message);
  hidePrivate();
  window.location.replace(LOGIN_URL);
}

function privateNodes() {
  return document.querySelectorAll("[data-private]");
}
function hidePrivate() {
  privateNodes().forEach((el) => { el.hidden = true; });
}
function showPrivate() {
  privateNodes().forEach((el) => { el.hidden = false; });
}

function flashFor(err) {
  const type = ["inactive", "unverified"].includes(err?.code) ? "warning" : "error";
  return { type, message: friendlyAuthError(err) ?? MESSAGES.generic };
}

/**
 * Protege la página actual.
 * @param {{page?:string, allowedRoles?:string[], onReady?:(profile)=>void, watch?:boolean}} opts
 * @returns {Promise<object|null>} perfil autorizado, o null si no se mostró la página.
 */
export async function protectPage({ page, allowedRoles, onReady, watch = true } = {}) {
  hidePrivate();
  const roles = allowedRoles ?? (page ? rolesForPage(page) : []);

  // "Atrás"/"Adelante" con caché del navegador (bfcache): revalidar siempre.
  window.addEventListener("pageshow", (e) => { if (e.persisted) window.location.reload(); });

  if (!isReady) { goLogin(); return null; }

  // 1) ¿Existe sesión?
  try {
    await auth.authStateReady();
  } catch {
    showUnavailable();
    return null;
  }
  const user = auth.currentUser;
  if (!user) { goLogin(); return null; }

  // 2-5) Perfil, estado, rol, correo verificado (desde Firestore, nunca del navegador)
  let profile;
  try {
    profile = await verifyAccess(user); // cierra sesión si NO está autorizado
  } catch (err) {
    if (err?.code === "network") { showUnavailable(); return null; }
    goLogin(flashFor(err));
    return null;
  }

  // 6) ¿Su rol puede entrar a ESTA página?
  if (!canAccessPage(profile, roles)) {
    showRestricted(profile);
    return null;
  }

  // 7) Pintar con datos reales y recién entonces revelar
  try {
    onReady?.(profile);
  } catch (err) {
    console.error("[CanchaControl] Error al pintar la página:", err);
    showUnavailable();
    return null;
  }
  showPrivate();
  hideBootLoader();

  // 8) Vigilancia continua mientras la página está abierta
  onSessionChange((u) => {
    if (!u) goLogin(); // cierre en otra pestaña, sesión expirada o revocada
  });
  if (watch) startProfileWatch(user.uid, roles);

  return profile;
}

/** Si el admin desactiva, borra o cambia el rol con la página abierta: salir al instante. */
function startProfileWatch(uid, roles) {
  stopProfileWatch?.();
  stopProfileWatch = watchProfile(
    uid,
    async (data) => {
      const err = checkProfileData(data);
      if (err) {
        stopProfileWatch?.();
        const f = flashFor(err);
        setFlash(f.type, f.message); // antes de signOut: el observador de sesión también redirige
        hidePrivate();
        await safeSignOut();
        goLogin();
        return;
      }
      if (!roles.includes(data.rol)) {
        hidePrivate();
        showRestricted({ rol: data.rol });
      }
    },
    (err) => console.warn("[CanchaControl] Vigilancia de perfil:", err?.code || err)
  );
}

function showRestricted(profile) {
  hidePrivate();
  renderStatusScreen({
    variant: "restricted",
    icon: "lock",
    title: "Acceso restringido",
    text: "No tienes permisos para acceder a esta sección.",
    actionLabel: "Volver al inicio",
    onAction: () => window.location.replace(homeFor(profile?.rol)),
  });
}

function showUnavailable() {
  hidePrivate();
  renderStatusScreen({
    variant: "error",
    icon: "offline",
    title: "Sin conexión",
    text: MESSAGES.unavailable,
    actionLabel: "Reintentar",
    onAction: () => window.location.reload(),
  });
}

/**
 * Cierre de sesión REAL: finaliza la sesión en Firebase (signOut),
 * deja de escuchar el perfil y reemplaza la página por el login.
 */
export async function logout() {
  stopProfileWatch?.();
  hidePrivate();
  setFlash("info", "Cerraste sesión correctamente."); // antes de signOut (ver arriba)
  await safeSignOut();
  goLogin();
}
