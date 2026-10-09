/* ==========================================================
   CanchaControl — Matriz central de autorización
   ----------------------------------------------------------
   Toda decisión de "¿puede?" del FRONTEND sale de aquí.
   El frontend solo mejora la experiencia; la decisión
   definitiva la toma firestore.rules (mismo modelo).

   Dos conceptos distintos, nunca mezclarlos:

   1) PERMISO DE PÁGINA / MÓDULO  → ¿puede ENTRAR a la sección?
      Ej.: Entrenador puede entrar a Asistencia.

   2) ALCANCE SOBRE REGISTROS     → ¿QUÉ registros de esa sección?
      Ej.: Entrenador A solo ve la asistencia de SUS categorías.

   Regla de oro: lo que no está definido aquí está PROHIBIDO.
   ========================================================== */

import { POST_LOGIN_URL } from "./firebase-config.js";

/* ---------------- Roles oficiales ---------------- */
export const ROLE = Object.freeze({
  ADMIN: "Administrador",
  ENTRENADOR: "Entrenador",
  JUGADOR: "Jugador",
});

/** Lista de roles válidos. Cualquier otro valor es inválido. */
export const ROLES = Object.freeze([ROLE.ADMIN, ROLE.ENTRENADOR, ROLE.JUGADOR]);

export const ESTADO = Object.freeze({ ACTIVO: "Activo", INACTIVO: "Inactivo" });

export function isValidRole(rol) {
  return typeof rol === "string" && ROLES.includes(rol);
}

/* ==========================================================
   1) PERMISO DE PÁGINA
   Cada página privada declara aquí quién puede entrar.
   Las páginas usan: protectPage({ page: "dashboard" })
   ========================================================== */
export const PAGES = Object.freeze({
  dashboard: { path: "dashboard.html", roles: ROLES },
  usuarios:  { path: "usuarios.html",  roles: [ROLE.ADMIN] },   // HU-002
  jugadores: { path: "jugadores.html", roles: [ROLE.ADMIN, ROLE.ENTRENADOR] }, // HU-007 Admin (expedientes) · HU-009 Entrenador ("Mis jugadores": solo fichas de SUS categorías)
  categorias:{ path: "categorias.html", roles: [ROLE.ADMIN, ROLE.ENTRENADOR] }, // HU-004/005 Admin · HU-006 Entrenador (solo SUS categorías, READ_SCOPE)
  entrenamientos: { path: "entrenamientos.html", roles: ROLES }, // HU-010: Admin consulta todo · Entrenador programa en SUS categorías · Jugador consulta las de SU categoría
  asistencia: { path: "asistencia.html", roles: [ROLE.ADMIN, ROLE.ENTRENADOR] }, // HU-011: Entrenador registra/corrige en SUS sesiones · Admin solo consulta (se abre desde Entrenamientos)
  historial: { path: "historial.html", roles: [ROLE.JUGADOR, ROLE.ENTRENADOR] }, // HU-012: Jugador = SU historial · Entrenador = jugadores de SUS categorías (desde Mis jugadores). Solo lectura.
  partidos: { path: "partidos.html", roles: [ROLE.ADMIN, ROLE.ENTRENADOR] }, // HU-013: Entrenador gestiona SUS categorías · Admin consulta.
  rendimiento: { path: "rendimiento.html", roles: [ROLE.JUGADOR] }, // HU-014: "Mi rendimiento" — el Jugador consulta SUS partidos y estadísticas. Solo lectura.
  // Se agregan con cada HU.
});

/* ----------------------------------------------------------
   MENÚ LATERAL: solo módulos YA desarrollados. El orden es el del
   diseño aprobado. Que una opción aparezca NO es seguridad: cada
   página se protege con authGuard y firestore.rules.
   ---------------------------------------------------------- */
export const NAV = Object.freeze([
  { page: "dashboard",  label: "Inicio",     icon: "home" },
  { page: "usuarios",   label: "Usuarios",   icon: "users" },
  { page: "jugadores",  label: "Jugadores",  icon: "player", labels: { [ROLE.ENTRENADOR]: "Mis jugadores" } },
  { page: "categorias", label: "Categorías", icon: "layers", labels: { [ROLE.ENTRENADOR]: "Mis categorías" } },
  { page: "entrenamientos", label: "Entrenamientos", icon: "calendar" },
  { page: "partidos", label: "Partidos y rendimiento", icon: "trophy" },
  // HU-012: en el menú solo para el Jugador; el Entrenador entra desde "Mis jugadores".
  { page: "historial", label: "Mi asistencia", icon: "chart", roles: [ROLE.JUGADOR] },
  // HU-014
  { page: "rendimiento", label: "Mi rendimiento", icon: "medal", roles: [ROLE.JUGADOR] },
]);

/** Opciones del menú visibles para un perfil (según PAGES). */
export function navFor(profile) {
  return NAV.filter((item) => canAccessPage(profile, rolesForPage(item.page))
    && (!item.roles || item.roles.includes(profile.rol)));
}

/** Roles autorizados para una página registrada (deny by default). */
export function rolesForPage(pageKey) {
  return PAGES[pageKey]?.roles ?? [];
}

export function canAccessPage(profile, allowedRoles) {
  return !!profile && isValidRole(profile.rol) && Array.isArray(allowedRoles) && allowedRoles.includes(profile.rol);
}

/** Pantalla de inicio según el rol (hoy todos van al dashboard provisional). */
export function homeFor(rol) {
  const HOME = {
    [ROLE.ADMIN]: POST_LOGIN_URL,
    [ROLE.ENTRENADOR]: POST_LOGIN_URL,
    [ROLE.JUGADOR]: POST_LOGIN_URL,
  };
  return HOME[rol] ?? POST_LOGIN_URL;
}

/* ==========================================================
   2) ALCANCE SOBRE REGISTROS (aislamiento de datos)
   ----------------------------------------------------------
   ALL       → visión global (solo Administrador)
   ASSIGNED  → solo lo relacionado con SUS categorías asignadas
               (identidad = auth.currentUser.uid / request.auth.uid,
               NUNCA un entrenadorId que venga de la URL o del HTML)
   OWN       → solo lo propio (uid del jugador)
   EXPLICIT  → solo con autorización expresa por registro
   NONE      → sin acceso (también es el valor por defecto)

   IMPORTANTE: el alcance se aplica en la CONSULTA a Firestore
   (where entrenadorId == uid, where jugadorId == uid, etc.),
   jamás descargando todo y ocultando con JavaScript.
   ========================================================== */
export const SCOPE = Object.freeze({
  ALL: "all",
  ASSIGNED: "assigned",
  OWN: "own",
  EXPLICIT: "explicit",
  NONE: "none",
});

const { ALL, ASSIGNED, OWN, EXPLICIT, NONE } = SCOPE;

/**
 * Matriz base de LECTURA. Las acciones de escritura (crear/editar/
 * eliminar) se definen en cada HU; mientras tanto se niegan.
 * Los recursos aún no existen: esto es la política acordada, no código de datos.
 */
export const READ_SCOPE = Object.freeze({
  usuarios:       { [ROLE.ADMIN]: ALL, [ROLE.ENTRENADOR]: OWN,      [ROLE.JUGADOR]: OWN },
  categorias:     { [ROLE.ADMIN]: ALL, [ROLE.ENTRENADOR]: ASSIGNED, [ROLE.JUGADOR]: NONE },
  jugadores:      { [ROLE.ADMIN]: ALL, [ROLE.ENTRENADOR]: ASSIGNED, [ROLE.JUGADOR]: OWN },
  entrenamientos: { [ROLE.ADMIN]: ALL, [ROLE.ENTRENADOR]: ASSIGNED, [ROLE.JUGADOR]: OWN },
  asistencia:     { [ROLE.ADMIN]: ALL, [ROLE.ENTRENADOR]: ASSIGNED, [ROLE.JUGADOR]: OWN },
  partidos:       { [ROLE.ADMIN]: ALL, [ROLE.ENTRENADOR]: ASSIGNED, [ROLE.JUGADOR]: OWN },    // HU-013 · HU-014: el Jugador solo los partidos donde fue convocado
  rendimiento:    { [ROLE.ADMIN]: ALL, [ROLE.ENTRENADOR]: ASSIGNED, [ROLE.JUGADOR]: OWN },
  mensualidades:  { [ROLE.ADMIN]: ALL, [ROLE.ENTRENADOR]: NONE,     [ROLE.JUGADOR]: OWN },
  lesiones:       { [ROLE.ADMIN]: ALL, [ROLE.ENTRENADOR]: EXPLICIT, [ROLE.JUGADOR]: NONE },
  implementos:    { [ROLE.ADMIN]: ALL, [ROLE.ENTRENADOR]: NONE,     [ROLE.JUGADOR]: NONE },
  prestamos:      { [ROLE.ADMIN]: ALL, [ROLE.ENTRENADOR]: NONE,     [ROLE.JUGADOR]: NONE },
});

/** Alcance de lectura de un rol sobre un recurso. Desconocido → NONE. */
export function readScope(rol, resource) {
  if (!isValidRole(rol)) return NONE;
  return READ_SCOPE[resource]?.[rol] ?? NONE;
}

export const ACTION = Object.freeze({ READ: "leer", CREATE: "crear", UPDATE: "editar", DELETE: "eliminar" });

/**
 * Permisos de escritura por recurso. Vacío a propósito: cada HU
 * agrega aquí sus acciones (y su regla equivalente en firestore.rules).
 */
export const WRITE_PERMISSIONS = Object.freeze({
  // HU-002: solo el Administrador crea y edita cuentas. No hay eliminación (se inactiva).
  usuarios: { [ACTION.CREATE]: [ROLE.ADMIN], [ACTION.UPDATE]: [ROLE.ADMIN] },
  // HU-004 crear · HU-005 asignar entrenador: solo Administrador. Entrenador: solo lectura (HU-006).
  categorias: { [ACTION.CREATE]: [ROLE.ADMIN], [ACTION.UPDATE]: [ROLE.ADMIN] },
  // HU-007: expedientes de jugadores. Solo Administrador crea y edita. No hay eliminación (historial).
  jugadores: { [ACTION.CREATE]: [ROLE.ADMIN], [ACTION.UPDATE]: [ROLE.ADMIN] },
  // HU-010: solo el Entrenador programa sesiones (en SUS categorías activas). Sin edición/cancelación aún.
  entrenamientos: { [ACTION.CREATE]: [ROLE.ENTRENADOR] },
  // HU-011: asistencia — solo el Entrenador (sus sesiones, día de la sesión + 7 días). Sin eliminación.
  asistencia: { [ACTION.CREATE]: [ROLE.ENTRENADOR], [ACTION.UPDATE]: [ROLE.ENTRENADOR] },
  // HU-013: partidos, convocatoria, rendimiento y alineación — solo el Entrenador de la categoría. Sin eliminación.
  partidos: { [ACTION.CREATE]: [ROLE.ENTRENADOR], [ACTION.UPDATE]: [ROLE.ENTRENADOR] },
});

/**
 * ¿Puede este perfil hacer esta acción en este recurso?
 * Responde el PERMISO DE MÓDULO. El "¿este registro le corresponde?"
 * lo responden la consulta filtrada y firestore.rules.
 */
export function can(profile, resource, action) {
  if (!profile || profile.estado !== ESTADO.ACTIVO || !isValidRole(profile.rol)) return false;
  if (action === ACTION.READ) return readScope(profile.rol, resource) !== NONE;
  return (WRITE_PERMISSIONS[resource]?.[action] ?? []).includes(profile.rol);
}
