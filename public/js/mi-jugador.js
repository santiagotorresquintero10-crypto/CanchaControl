/* ==========================================================
   CanchaControl — Contexto del Jugador autenticado (HU-010)
   auth.uid → users/{uid}.jugadorId → jugadores/{jugadorId}.categoriaId
            → categorias/{categoriaId} → users/{entrenadorId} (solo su nombre)
   Cada lectura la autorizan las reglas por esa misma cadena: el Jugador
   solo puede leer SU expediente, SU categoría y a SU entrenador.
   ========================================================== */
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { db } from "./auth.js";

export async function contextoJugador(uid) {
  const u = await getDoc(doc(db, "users", uid));
  const jugadorId = u.exists() ? u.data().jugadorId : null;
  if (!jugadorId) return { estado: "sin-expediente" };
  const j = await getDoc(doc(db, "jugadores", jugadorId));
  if (!j.exists()) return { estado: "sin-expediente" };
  const jd = j.data();
  const jugador = { id: jugadorId, nombres: jd.nombres ?? "", apellidos: jd.apellidos ?? "", posicion: jd.posicion ?? "", numeroCamiseta: jd.numeroCamiseta ?? null, categoriaId: jd.categoriaId ?? null };
  if (!jugador.categoriaId) return { estado: "sin-categoria", jugador };
  const c = await getDoc(doc(db, "categorias", jugador.categoriaId));
  if (!c.exists()) return { estado: "sin-categoria", jugador };
  const cd = c.data();
  const categoria = { id: c.id, nombre: cd.nombre ?? "", codigoGrupo: cd.codigoGrupo ?? "", periodoLectivo: cd.periodoLectivo ?? "", estado: cd.estado ?? "",
    tipoConfiguracion: cd.tipoConfiguracion, edadMinima: cd.edadMinima ?? null, edadMaxima: cd.edadMaxima ?? null,
    anioNacimientoInicio: cd.anioNacimientoInicio ?? null, anioNacimientoFin: cd.anioNacimientoFin ?? null, entrenadorId: cd.entrenadorId ?? null };
  let entrenador = null;
  if (categoria.entrenadorId) {
    try { const e = await getDoc(doc(db, "users", categoria.entrenadorId)); if (e.exists()) entrenador = { nombre: e.data().nombre ?? "" }; }
    catch { entrenador = null; }
  }
  return { estado: "ok", jugador, categoria, entrenador };
}
