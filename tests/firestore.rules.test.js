// Pruebas de firestore.rules — ejecutar con:  npm install  &&  npm run test:rules
// Requiere Java 11+ instalado (el emulador de Firestore corre en Java).
// También corren solas en GitHub Actions (.github/workflows/rules-tests.yml) en cada push.
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, serverTimestamp, deleteDoc, collection, collectionGroup, getDocs, Timestamp, writeBatch, query, where } from "firebase/firestore";

let env;
const base = (uid, rol, estado) => ({ uid, nombre: uid, email: `${uid}@x.com`, rol, estado, providers: [] });

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-canchacontrol",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
});
after(async () => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "users/admin"), base("admin", "Administrador", "Activo"));
    await setDoc(doc(db, "users/coach"), base("coach", "Entrenador", "Activo"));
    await setDoc(doc(db, "users/off"),   base("off", "Jugador", "Inactivo"));
  });
});

const as = (uid, token = { email_verified: true, firebase: { sign_in_provider: "password" } }) =>
  env.authenticatedContext(uid, token).firestore();
const asUnverified = (uid, provider = "password") =>
  as(uid, { email_verified: false, firebase: { sign_in_provider: provider } });

test("sin sesión no puede leer perfiles", async () => {
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "users/coach")));
});
test("usuario lee su propio perfil (incluso inactivo)", async () => {
  await assertSucceeds(getDoc(doc(as("coach"), "users/coach")));
  await assertSucceeds(getDoc(doc(as("off"), "users/off")));
});
test("usuario NO lee perfiles ajenos", async () => {
  await assertFails(getDoc(doc(as("coach"), "users/admin")));
});
test("identidad autenticada sin perfil no lee nada ajeno", async () => {
  await assertFails(getDoc(doc(as("intruso"), "users/coach")));
});
test("admin activo lee cualquier perfil", async () => {
  await assertSucceeds(getDoc(doc(as("admin"), "users/coach")));
});
test("usuario activo solo puede actualizar lastLoginAt/providers", async () => {
  await assertSucceeds(updateDoc(doc(as("coach"), "users/coach"), { lastLoginAt: serverTimestamp(), providers: ["password"] }));
  await assertFails(updateDoc(doc(as("coach"), "users/coach"), { rol: "Administrador" }));
  await assertFails(updateDoc(doc(as("coach"), "users/coach"), { estado: "Activo", lastLoginAt: serverTimestamp() }));
});
test("usuario inactivo no puede escribir su perfil", async () => {
  await assertFails(updateDoc(doc(as("off"), "users/off"), { lastLoginAt: serverTimestamp(), providers: [] }));
});
test("nadie se auto-crea un perfil", async () => {
  await assertFails(setDoc(doc(as("intruso"), "users/intruso"), base("intruso", "Administrador", "Activo")));
});
// ---------- HU-002 ----------
const nuevo = (uid, rol = "Jugador", extra = {}) => ({
  ...base(uid, rol, "Activo"), providers: ["password"],
  createdAt: serverTimestamp(), updatedAt: serverTimestamp(), lastLoginAt: null, ...extra,
});

test("HU-002: admin lista todos los usuarios; entrenador y jugador no", async () => {
  await assertSucceeds(getDocs(collection(as("admin"), "users")));
  await assertFails(getDocs(collection(as("coach"), "users")));
});
test("HU-002: admin crea perfiles válidos; rechaza rol inválido, email con mayúsculas, fechas falsas", async () => {
  await assertSucceeds(setDoc(doc(as("admin"), "users/nuevo"), nuevo("nuevo")));
  await assertFails(setDoc(doc(as("admin"), "users/malo"), nuevo("malo", "SuperUser")));
  await assertFails(setDoc(doc(as("admin"), "users/m2"), nuevo("m2", "Jugador", { email: "M2@X.COM" })));
  await assertFails(setDoc(doc(as("admin"), "users/m3"), nuevo("m3", "Jugador", { lastLoginAt: Timestamp.fromDate(new Date("2020-01-01")) })));
  await assertFails(setDoc(doc(as("admin"), "users/m4"), nuevo("m4", "Jugador", { uid: "otro" })));
});
test("HU-002: entrenador y jugador NO pueden crear usuarios", async () => {
  await assertFails(setDoc(doc(as("coach"), "users/x1"), nuevo("x1")));
});
test("HU-002 PRUEBA L: entrenador NO modifica a otro usuario (rol, estado, nombre)", async () => {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "users/jug"), base("jug", "Jugador", "Activo")));
  for (const change of [{ rol: "Administrador" }, { estado: "Inactivo" }, { nombre: "Hackeado" }]) {
    await assertFails(updateDoc(doc(as("coach"), "users/jug"), { ...change, updatedAt: serverTimestamp() }));
  }
});
test("HU-002 PRUEBA M: nadie modifica su propio rol ni se reactiva", async () => {
  await assertFails(updateDoc(doc(as("coach"), "users/coach"), { rol: "Administrador", updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as("off"), "users/off"), { estado: "Activo", updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as("admin"), "users/admin"), { rol: "Jugador", updatedAt: serverTimestamp() }));
});
test("HU-002: admin edita nombre/rol/estado de otro; email y lastLoginAt inmutables", async () => {
  await assertSucceeds(updateDoc(doc(as("admin"), "users/coach"), { nombre: "Nuevo Nombre", rol: "Jugador", updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as("admin"), "users/coach"), { email: "otro@x.com", updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as("admin"), "users/coach"), { lastLoginAt: serverTimestamp(), updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as("admin"), "users/coach"), { nombre: "Sin fecha" })); // updatedAt obligatorio
});
test("HU-002 PRUEBA N: admin no puede inactivarse (nunca queda el sistema sin admin activo)", async () => {
  await assertFails(updateDoc(doc(as("admin"), "users/admin"), { estado: "Inactivo", updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(as("admin"), "users/coach"), { estado: "Inactivo", updatedAt: serverTimestamp() }));
});
test("HU-002: no existe eliminación de usuarios", async () => {
  await assertFails(deleteDoc(doc(as("admin"), "users/coach")));
});
test("admin inactivo pierde privilegios", async () => {
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), "users/admin"), { estado: "Inactivo" }));
  await assertFails(getDoc(doc(as("admin"), "users/coach")));
});
test("contraseña con correo SIN verificar: no actúa como usuario activo", async () => {
  await assertSucceeds(getDoc(doc(asUnverified("coach"), "users/coach")));   // puede leer su perfil (para ver el motivo)
  await assertFails(updateDoc(doc(asUnverified("coach"), "users/coach"), { lastLoginAt: serverTimestamp(), providers: [] }));
  await assertFails(getDoc(doc(asUnverified("admin"), "users/coach")));      // admin sin verificar pierde privilegios
});
test("Microsoft sin email_verified sí es válido", async () => {
  await assertSucceeds(updateDoc(doc(asUnverified("coach", "microsoft.com"), "users/coach"), { lastLoginAt: serverTimestamp(), providers: ["microsoft.com"] }));
});
test("HU-003: jugador no lee el perfil de otro usuario aunque conozca su UID", async () => {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "users/jug"), base("jug", "Jugador", "Activo")));
  await assertFails(getDoc(doc(as("jug"), "users/coach")));
  await assertFails(getDoc(doc(as("coach"), "users/jug")));   // entrenador tampoco (aún no hay relación definida)
});
test("HU-003: módulos futuros denegados para todos los roles hasta su HU", async () => {
  for (const uid of ["admin", "coach"]) {
    await assertFails(getDoc(doc(as(uid), "categorias/x")));
    await assertFails(setDoc(doc(as(uid), "jugadores/x"), { entrenadorId: uid }));
  }
});
// ---------- HU-004: categorías ----------
const cat = (uid, extra = {}) => ({
  nombre: "Benjamín", nombreNormalizado: "benjamin", codigoGrupo: "BJ-01", codigoNormalizado: "BJ-01",
  periodoLectivo: "2025-2026", tipoConfiguracion: "rangoEdad", edadMinima: 7, edadMaxima: 8,
  anioNacimientoInicio: null, anioNacimientoFin: null, descripcion: "", estado: "Activa", entrenadorId: null,
  createdAt: serverTimestamp(), createdBy: uid, updatedAt: serverTimestamp(), updatedBy: uid, ...extra,
});
async function crearCategoria(db, uid, id, extra = {}, claves = {}) {
  const d = cat(uid, extra);
  const b = writeBatch(db);
  b.set(doc(db, "categorias", id), d);
  b.set(doc(db, "categoriaClaves", claves.nombre ?? `nombre:${d.nombreNormalizado}`), { tipo: "nombre", categoriaId: id });
  b.set(doc(db, "categoriaClaves", claves.codigo ?? `codigo:${d.codigoNormalizado}`), { tipo: "codigo", categoriaId: id });
  return b.commit();
}

test("HU-004 D/E: admin crea categoría válida (estado Activa, entrenador null)", async () => {
  await assertSucceeds(crearCategoria(as("admin"), "admin", "c1"));
  await assertSucceeds(getDoc(doc(as("admin"), "categorias/c1")));
});
test("HU-004 O/P: Entrenador y Jugador NO pueden crear categorías", async () => {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "users/jug"), base("jug", "Jugador", "Activo")));
  await assertFails(crearCategoria(as("coach"), "coach", "c2"));
  await assertFails(crearCategoria(as("jug"), "jug", "c3"));
});
test("HU-004 F/G: nombre o código duplicado → el lote completo se rechaza", async () => {
  await assertSucceeds(crearCategoria(as("admin"), "admin", "c1"));
  await assertFails(crearCategoria(as("admin"), "admin", "c4", { codigoGrupo: "OTRO", codigoNormalizado: "OTRO" }));           // mismo nombre
  await assertFails(crearCategoria(as("admin"), "admin", "c5", { nombre: "Otra", nombreNormalizado: "otra" }));              // mismo código
  const snap = await getDoc(doc(as("admin"), "categorias/c4"));
  if (snap.exists()) throw new Error("La categoría duplicada no debió crearse");
});
test("HU-004: sin sus claves únicas no se puede crear la categoría", async () => {
  await assertFails(setDoc(doc(as("admin"), "categorias/c6"), cat("admin")));
});
test("HU-004 CA-03: no se puede crear Inactiva ni con entrenador ni a nombre de otro", async () => {
  await assertFails(crearCategoria(as("admin"), "admin", "c7", { estado: "Inactiva" }));
  await assertFails(crearCategoria(as("admin"), "admin", "c8", { nombre: "X1", nombreNormalizado: "x1", codigoGrupo: "X1", codigoNormalizado: "X1", entrenadorId: "coach" }));
  await assertFails(crearCategoria(as("admin"), "admin", "c9", { nombre: "X2", nombreNormalizado: "x2", codigoGrupo: "X2", codigoNormalizado: "X2", createdBy: "otro" }));
});
test("HU-004 H/I: rangos incoherentes o campos mezclados → rechazados", async () => {
  const mk = (n, extra) => crearCategoria(as("admin"), "admin", `r${n}`, { nombre: `R${n}`, nombreNormalizado: `r${n}`, codigoGrupo: `R${n}`, codigoNormalizado: `R${n}`, ...extra });
  await assertFails(mk(1, { edadMinima: 9, edadMaxima: 8 }));
  await assertFails(mk(2, { tipoConfiguracion: "anioNacimiento", anioNacimientoInicio: 2016, anioNacimientoFin: 2015 }));
  await assertFails(mk(3, { tipoConfiguracion: "anioNacimiento", anioNacimientoInicio: 2015, anioNacimientoFin: 2016 })); // conserva edades → mezcla
  await assertSucceeds(mk(4, { tipoConfiguracion: "anioNacimiento", edadMinima: null, edadMaxima: null, anioNacimientoInicio: 2015, anioNacimientoFin: 2016 }));
});
test("HU-004: Entrenador no lee una categoría que no es suya y nadie edita/elimina campos de HU-004", async () => {
  await assertSucceeds(crearCategoria(as("admin"), "admin", "c1"));
  await assertFails(getDoc(doc(as("coach"), "categorias/c1")));
  await assertFails(updateDoc(doc(as("admin"), "categorias/c1"), { estado: "Inactiva" }));
  await assertFails(deleteDoc(doc(as("admin"), "categorias/c1")));
  await assertFails(setDoc(doc(as("admin"), "categoriaClaves/nombre:benjamin"), { tipo: "nombre", categoriaId: "zz" }));
});

// ---------- HU-005: entrenador principal + aislamiento A/B ----------
async function prepararAB() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "users/coachA"), base("coachA", "Entrenador", "Activo"));
    await setDoc(doc(db, "users/coachB"), base("coachB", "Entrenador", "Activo"));
    await setDoc(doc(db, "users/coachOff"), base("coachOff", "Entrenador", "Inactivo"));
    await setDoc(doc(db, "users/jug"), base("jug", "Jugador", "Activo"));
    await setDoc(doc(db, "categorias/catA"), cat("admin", { createdAt: Timestamp.now(), updatedAt: Timestamp.now(), entrenadorId: "coachA" }));
    await setDoc(doc(db, "categorias/catB"), cat("admin", { createdAt: Timestamp.now(), updatedAt: Timestamp.now(), entrenadorId: "coachB", nombre: "Sub-17", nombreNormalizado: "sub-17", codigoGrupo: "S17", codigoNormalizado: "S17" }));
    await setDoc(doc(db, "categorias/catLibre"), cat("admin", { createdAt: Timestamp.now(), updatedAt: Timestamp.now(), nombre: "Libre", nombreNormalizado: "libre", codigoGrupo: "LB", codigoNormalizado: "LB" }));
  });
}
const asignar = (db, id, uid, by) => updateDoc(doc(db, "categorias", id), { entrenadorId: uid, updatedAt: serverTimestamp(), updatedBy: by });

test("HU-005 AISLAMIENTO: A→A ✓, A→B ✕, B→B ✓, B→A ✕, Admin→todas ✓", async () => {
  await prepararAB();
  await assertSucceeds(getDoc(doc(as("coachA"), "categorias/catA")));
  await assertFails(getDoc(doc(as("coachA"), "categorias/catB")));
  await assertSucceeds(getDoc(doc(as("coachB"), "categorias/catB")));
  await assertFails(getDoc(doc(as("coachB"), "categorias/catA")));
  await assertSucceeds(getDoc(doc(as("admin"), "categorias/catA")));
  await assertSucceeds(getDoc(doc(as("admin"), "categorias/catB")));
});
test("HU-005 AISLAMIENTO: el entrenador solo puede CONSULTAR filtrando por su UID (descargar todo es rechazado)", async () => {
  await prepararAB();
  const mine = await assertSucceeds(getDocs(query(collection(as("coachA"), "categorias"), where("entrenadorId", "==", "coachA"))));
  if (mine.size !== 1 || mine.docs[0].id !== "catA") throw new Error("A debía recibir solo catA");
  await assertFails(getDocs(collection(as("coachA"), "categorias")));                                         // todo
  await assertFails(getDocs(query(collection(as("coachA"), "categorias"), where("entrenadorId", "==", "coachB")))); // las de B
});
test("HU-005: entrenador inactivo pierde acceso a sus categorías; jugador no lee categorías", async () => {
  await prepararAB();
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), "categorias/catLibre"), { entrenadorId: "coachOff" }));
  await assertFails(getDoc(doc(as("coachOff"), "categorias/catLibre")));
  await assertFails(getDoc(doc(as("jug"), "categorias/catA")));
});
test("HU-005 L: Entrenador NO puede autoasignarse ni reasignar categorías", async () => {
  await prepararAB();
  await assertFails(asignar(as("coachA"), "catLibre", "coachA", "coachA"));
  await assertFails(asignar(as("coachA"), "catB", "coachA", "coachA"));
  await assertFails(asignar(as("coachA"), "catA", "coachB", "coachA"));
});
test("HU-005 M: Jugador NO puede modificar entrenadorId", async () => {
  await prepararAB();
  await assertFails(asignar(as("jug"), "catLibre", "coachA", "jug"));
});
test("HU-005 N/O: Administrador asigna y reemplaza (con updatedAt/updatedBy), solo a Entrenador activo", async () => {
  await prepararAB();
  await assertSucceeds(asignar(as("admin"), "catLibre", "coachA", "admin"));     // asignar
  await assertSucceeds(asignar(as("admin"), "catLibre", "coachB", "admin"));     // reemplazar
  await assertFails(asignar(as("admin"), "catLibre", "admin", "admin"));         // un Administrador no es opción
  await assertFails(asignar(as("admin"), "catLibre", "jug", "admin"));           // un Jugador tampoco
  await assertFails(asignar(as("admin"), "catLibre", "coachOff", "admin"));      // inactivo
  await assertFails(asignar(as("admin"), "catLibre", "noExiste", "admin"));      // inexistente
  await assertFails(asignar(as("admin"), "catLibre", "coachA", "otro"));         // updatedBy falso
  await assertFails(updateDoc(doc(as("admin"), "categorias/catLibre"), { entrenadorId: "coachA", updatedBy: "admin" })); // sin updatedAt
  await assertFails(updateDoc(doc(as("admin"), "categorias/catLibre"), { entrenadorId: "coachA", nombre: "X", updatedAt: serverTimestamp(), updatedBy: "admin" })); // otros campos
  await assertFails(updateDoc(doc(as("admin"), "categorias/catLibre"), { createdBy: "otro", updatedAt: serverTimestamp(), updatedBy: "admin" }));
});

// ---------- HU-006: consulta del listado (vista Administrador + vista Entrenador) ----------
async function prepararHU006() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "users/AAA"), base("AAA", "Entrenador", "Activo"));
    await setDoc(doc(db, "users/BBB"), base("BBB", "Entrenador", "Activo"));
    await setDoc(doc(db, "users/CCC"), base("CCC", "Entrenador", "Activo"));   // sin categorías
    const mk = (id, n, coach) => setDoc(doc(db, "categorias", id), cat("admin", {
      createdAt: Timestamp.now(), updatedAt: Timestamp.now(), nombre: n, nombreNormalizado: n.toLowerCase(),
      codigoGrupo: n.toUpperCase(), codigoNormalizado: n.toUpperCase(), entrenadorId: coach }));
    await mk("sub12", "Sub-12", "AAA");
    await mk("sub14", "Sub-14", "AAA");
    await mk("sub16", "Sub-16", "BBB");
    await mk("sub18", "Sub-18", null);
  });
}
const mias = (uid) => getDocs(query(collection(as(uid), "categorias"), where("entrenadorId", "==", uid)));
const ids = (snap) => snap.docs.map((d) => d.id).sort().join(",");

test("HU-006 A: Administrador consulta TODAS las categorías (incluida la sin asignar)", async () => {
  await prepararHU006();
  const all = await assertSucceeds(getDocs(collection(as("admin"), "categorias")));
  if (ids(all) !== "sub12,sub14,sub16,sub18") throw new Error("Admin debía ver las 4: " + ids(all));
});
test("HU-006 B/C: A recibe solo Sub-12 y Sub-14; B recibe solo Sub-16 (consulta del frontend)", async () => {
  await prepararHU006();
  const a = await assertSucceeds(mias("AAA"));
  if (ids(a) !== "sub12,sub14") throw new Error("A: " + ids(a));
  const b = await assertSucceeds(mias("BBB"));
  if (ids(b) !== "sub16") throw new Error("B: " + ids(b));
});
test("HU-006 D/E (prueba directa): A lee el documento de B → DENEGADO y viceversa, aunque conozca el ID", async () => {
  await prepararHU006();
  await assertFails(getDoc(doc(as("AAA"), "categorias/sub16")));
  await assertFails(getDoc(doc(as("BBB"), "categorias/sub12")));
  await assertFails(getDoc(doc(as("BBB"), "categorias/sub14")));
  await assertFails(getDocs(query(collection(as("AAA"), "categorias"), where("entrenadorId", "==", "BBB")))); // conociendo el UID de B
  await assertFails(getDocs(collection(as("AAA"), "categorias")));                                          // descargar todo
});
test("HU-006 F/H: entrenador sin categorías recibe lista vacía; nadie ve las 'Sin asignar' salvo Admin", async () => {
  await prepararHU006();
  const c = await assertSucceeds(mias("CCC"));
  if (c.size !== 0) throw new Error("CCC debía recibir 0");
  await assertFails(getDoc(doc(as("AAA"), "categorias/sub18")));
  await assertFails(getDocs(query(collection(as("AAA"), "categorias"), where("entrenadorId", "==", null))));
  await assertSucceeds(getDoc(doc(as("admin"), "categorias/sub18")));
});
test("HU-006 J: Entrenador NO puede crear categorías desde DevTools (ni a su nombre)", async () => {
  await prepararHU006();
  await assertFails(crearCategoria(as("AAA"), "AAA", "nueva", { nombre: "Hack", nombreNormalizado: "hack", codigoGrupo: "HK", codigoNormalizado: "HK" }));
  await assertFails(setDoc(doc(as("AAA"), "categorias/nueva2"), cat("AAA", { entrenadorId: "AAA" })));
});
test("HU-006 K: Entrenador NO modifica entrenadorId ni ningún otro campo, ni elimina (ni en sus propias categorías)", async () => {
  await prepararHU006();
  const up = (data) => updateDoc(doc(as("AAA"), "categorias/sub12"), { ...data, updatedAt: serverTimestamp(), updatedBy: "AAA" });
  await assertFails(up({ entrenadorId: null }));
  await assertFails(up({ entrenadorId: "BBB" }));
  await assertFails(up({ estado: "Inactiva" }));
  await assertFails(up({ codigoGrupo: "X" }));
  await assertFails(up({ periodoLectivo: "2030-2031" }));
  await assertFails(up({ edadMinima: 5 }));
  await assertFails(updateDoc(doc(as("AAA"), "categorias/sub18"), { entrenadorId: "AAA", updatedAt: serverTimestamp(), updatedBy: "AAA" })); // autoasignarse
  await assertFails(deleteDoc(doc(as("AAA"), "categorias/sub12")));
});
test("HU-006 §28: al reasignar Sub-14 de A a B, A pierde el acceso y B lo gana (sin permisos históricos)", async () => {
  await prepararHU006();
  await assertSucceeds(updateDoc(doc(as("admin"), "categorias/sub14"), { entrenadorId: "BBB", updatedAt: serverTimestamp(), updatedBy: "admin" }));
  await assertFails(getDoc(doc(as("AAA"), "categorias/sub14")));
  await assertSucceeds(getDoc(doc(as("BBB"), "categorias/sub14")));
  if (ids(await mias("AAA")) !== "sub12") throw new Error("A debía quedar solo con sub12");
  if (ids(await mias("BBB")) !== "sub14,sub16") throw new Error("B debía tener sub14 y sub16");
});
test("HU-006 §27/§34: entrenador inactivo, sin correo verificado o con rol cambiado no consulta", async () => {
  await prepararHU006();
  await assertFails(getDocs(query(collection(asUnverified("AAA"), "categorias"), where("entrenadorId", "==", "AAA"))));
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), "users/AAA"), { estado: "Inactivo" }));
  await assertFails(mias("AAA"));
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), "users/BBB"), { rol: "Jugador" }));
  await assertFails(mias("BBB"));
});

// ---------- HU-007: expedientes de jugadores (users ↔ jugadores) ----------
async function prepararJug() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "users/jugA"), base("jugA", "Jugador", "Activo"));
    await setDoc(doc(db, "users/jugB"), base("jugB", "Jugador", "Activo"));
    await setDoc(doc(db, "users/jugOff"), base("jugOff", "Jugador", "Inactivo"));
    await setDoc(doc(db, "users/coachA"), base("coachA", "Entrenador", "Activo"));
  });
}
const expediente = (userId, actor, extra = {}) => ({
  userId, nombres: "Juan", apellidos: "Pérez", tipoDocumento: "TI", numeroDocumento: "1.023.456", documentoNormalizado: "1023456",
  fechaNacimiento: "2013-05-20", genero: "Masculino", ciudadNacimiento: "Medellín", observaciones: "",
  ciudad: "Medellín", fechaIngreso: "2025-08-01", observacionesDeportivas: "", telefono: "3001234567", correoContacto: "acudiente@x.com", direccion: "Calle 1",
  emergencia: { nombre: "María Pérez", parentesco: "Madre", telefono: "3009876543" },
  posicion: "Delantero", numeroCamiseta: 9, estado: "Activo", categoriaId: null,
  createdAt: serverTimestamp(), createdBy: actor, updatedAt: serverTimestamp(), updatedBy: actor, ...extra,
});
/** La misma operación atómica que hace la app: expediente + users.jugadorId + clave de documento. */
function crearExp(db, actor, id, userId, extra = {}, { vincular = true, clave = true } = {}) {
  const d = expediente(userId, actor, extra);
  const b = writeBatch(db);
  b.set(doc(db, "jugadores", id), d);
  if (vincular) b.update(doc(db, "users", userId), { jugadorId: id, updatedAt: serverTimestamp() });
  if (clave) b.set(doc(db, "jugadorClaves", `doc:${d.documentoNormalizado}`), { tipo: "documento", jugadorId: id });
  return b.commit();
}
const raw = async (path) => { let out; await env.withSecurityRulesDisabled(async (ctx) => { out = (await getDoc(doc(ctx.firestore(), path))).data(); }); return out; };

test("HU-007 P3/P4/§56: Admin crea expediente y la relación queda coherente en AMBOS sentidos", async () => {
  await prepararJug();
  await assertSucceeds(crearExp(as("admin"), "admin", "XYZ", "jugA"));
  const j = await raw("jugadores/XYZ"), u = await raw("users/jugA");
  if (j.userId !== "jugA" || u.jugadorId !== "XYZ" || j.categoriaId !== null || u.rol !== "Jugador") throw new Error("Relación incoherente");
  await assertSucceeds(getDoc(doc(as("admin"), "jugadores/XYZ")));            // P16
});
test("HU-007 P6: 1 cuenta ↔ 1 expediente — no se puede crear un segundo expediente para la misma cuenta", async () => {
  await prepararJug();
  await assertSucceeds(crearExp(as("admin"), "admin", "XYZ", "jugA"));
  await assertFails(crearExp(as("admin"), "admin", "OTRO", "jugA", { numeroDocumento: "999", documentoNormalizado: "999" }));
  await assertFails(crearExp(as("admin"), "admin", "OTRO2", "jugA", { numeroDocumento: "998", documentoNormalizado: "998" }, { vincular: false }));
});
test("HU-007 §9: no puede quedar un expediente sin vincular ni sin su clave de documento", async () => {
  await prepararJug();
  await assertFails(crearExp(as("admin"), "admin", "X1", "jugA", {}, { vincular: false }));
  await assertFails(crearExp(as("admin"), "admin", "X2", "jugA", {}, { clave: false }));
  await assertFails(updateDoc(doc(as("admin"), "users/jugA"), { jugadorId: "noExiste", updatedAt: serverTimestamp() })); // vínculo hacia la nada
});
test("HU-007 P7: documento duplicado → bloqueado (aunque sea otra cuenta)", async () => {
  await prepararJug();
  await assertSucceeds(crearExp(as("admin"), "admin", "XYZ", "jugA"));
  await assertFails(crearExp(as("admin"), "admin", "ABC", "jugB"));   // mismo documentoNormalizado 1023456
});
test("HU-007 §16/§19: solo cuentas Jugador ACTIVAS existentes; categoriaId null; trazabilidad real", async () => {
  await prepararJug();
  await assertFails(crearExp(as("admin"), "admin", "E1", "coachA"));
  await assertFails(crearExp(as("admin"), "admin", "E2", "admin"));
  await assertFails(crearExp(as("admin"), "admin", "E3", "jugOff"));
  await assertFails(crearExp(as("admin"), "admin", "E4", "fantasma"));
  await assertFails(crearExp(as("admin"), "admin", "E5", "jugA", { categoriaId: "sub12" }));
  await assertFails(crearExp(as("admin"), "admin", "E6", "jugA", { createdBy: "otro" }));
  await assertFails(crearExp(as("admin"), "admin", "E7", "jugA", { fechaNacimiento: "20-05-2013" }));
  await assertFails(crearExp(as("admin"), "admin", "E8", "jugA", { emergencia: { nombre: "", parentesco: "Madre", telefono: "300" } }));
});
test("HU-007 P8/P9: Editar modifica el MISMO documento; userId, categoriaId y createdAt/By no cambian", async () => {
  await prepararJug();
  await assertSucceeds(crearExp(as("admin"), "admin", "XYZ", "jugA"));
  const ref = doc(as("admin"), "jugadores/XYZ");
  const up = (data) => updateDoc(ref, { ...data, updatedAt: serverTimestamp(), updatedBy: "admin" });
  await assertSucceeds(up({ telefono: "3110000000", posicion: "Defensa" }));
  await assertFails(up({ userId: "jugB" }));
  await assertFails(up({ categoriaId: "sub12" }));
  await assertFails(up({ createdBy: "otro" }));
  await assertFails(updateDoc(ref, { telefono: "1", updatedAt: serverTimestamp(), updatedBy: "otro" }));
  await assertFails(deleteDoc(ref));
});
test("HU-007 P10 / §38: cambiar documento — al de otro jugador ✕; a uno libre ✓ (liberando el anterior)", async () => {
  await prepararJug();
  await assertSucceeds(crearExp(as("admin"), "admin", "XYZ", "jugA"));
  await assertSucceeds(crearExp(as("admin"), "admin", "ABC", "jugB", { numeroDocumento: "555", documentoNormalizado: "555" }));
  const db = as("admin");
  const cambiar = (nuevo, { liberar = true, reservar = true } = {}) => {
    const b = writeBatch(db);
    b.update(doc(db, "jugadores/XYZ"), { numeroDocumento: nuevo, documentoNormalizado: nuevo, updatedAt: serverTimestamp(), updatedBy: "admin" });
    if (liberar) b.delete(doc(db, "jugadorClaves/doc:1023456"));
    if (reservar) b.set(doc(db, "jugadorClaves", `doc:${nuevo}`), { tipo: "documento", jugadorId: "XYZ" });
    return b.commit();
  };
  await assertFails(cambiar("555"));                       // documento de ABC
  await assertFails(cambiar("777", { liberar: false }));   // sin liberar el anterior
  await assertFails(cambiar("777", { reservar: false }));  // sin reservar el nuevo
  await assertSucceeds(cambiar("777"));
  await assertFails(deleteDoc(doc(db, "jugadorClaves/doc:555")));   // no se libera una clave en uso
});
test("HU-007 §8/§50: users.jugadorId no se cambia ni se borra; nadie se apropia de expedientes", async () => {
  await prepararJug();
  await assertSucceeds(crearExp(as("admin"), "admin", "XYZ", "jugA"));
  await assertFails(updateDoc(doc(as("admin"), "users/jugA"), { jugadorId: null, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as("admin"), "users/jugA"), { jugadorId: "OTRO", updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as("admin"), "users/jugB"), { jugadorId: "XYZ", updatedAt: serverTimestamp() })); // XYZ es de jugA
  await assertFails(updateDoc(doc(as("jugB"), "users/jugB"), { jugadorId: "XYZ" }));                               // el propio jugador
  await assertFails(updateDoc(doc(as("jugA"), "jugadores/XYZ"), { userId: "jugB", updatedAt: serverTimestamp(), updatedBy: "jugA" }));
  await assertFails(updateDoc(doc(as("coachA"), "jugadores/XYZ"), { categoriaId: "sub12", updatedAt: serverTimestamp(), updatedBy: "coachA" }));
  await assertFails(crearExp(as("coachA"), "coachA", "C1", "jugB", { numeroDocumento: "321", documentoNormalizado: "321" }));
});
test("HU-007 P13 / P11: cuenta vinculada no cambia de rol; inactivarla sí, y el expediente se conserva", async () => {
  await prepararJug();
  await assertSucceeds(crearExp(as("admin"), "admin", "XYZ", "jugA"));
  await assertFails(updateDoc(doc(as("admin"), "users/jugA"), { rol: "Entrenador", updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as("admin"), "users/jugA"), { rol: "Administrador", updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(as("admin"), "users/jugA"), { estado: "Inactivo", updatedAt: serverTimestamp() }));
  await assertSucceeds(getDoc(doc(as("admin"), "jugadores/XYZ")));
  if (!(await raw("jugadores/XYZ"))) throw new Error("El expediente debía conservarse");
  await assertSucceeds(updateDoc(doc(as("admin"), "users/jugB"), { rol: "Entrenador", updatedAt: serverTimestamp() })); // sin expediente: sí puede
});
test("HU-007 P14/P15 (+HU-010): Entrenador no consulta expedientes; el Jugador solo el PROPIO por ID", async () => {
  await prepararJug();
  await assertSucceeds(crearExp(as("admin"), "admin", "XYZ", "jugA"));
  await assertSucceeds(crearExp(as("admin"), "admin", "ABC", "jugB", { numeroDocumento: "555", documentoNormalizado: "555" }));
  await assertFails(getDocs(collection(as("coachA"), "jugadores")));
  await assertFails(getDoc(doc(as("coachA"), "jugadores/XYZ")));
  await assertFails(getDoc(doc(as("jugB"), "jugadores/XYZ")));
  await assertFails(getDocs(query(collection(as("jugB"), "jugadores"), where("userId", "==", "jugA"))));
  await assertFails(getDoc(doc(as("jugA"), "jugadorClaves/doc:1023456")));
  await assertSucceeds(getDoc(doc(as("jugA"), "jugadores/XYZ")));                 // HU-010: su propio expediente
  await assertFails(getDocs(collection(as("jugA"), "jugadores")));                // nunca el listado
  await assertSucceeds(getDocs(collection(as("admin"), "jugadores")));
});

test("HU-007 foto (base64): solo Admin, solo imagen válida y de tamaño acotado, solo para expedientes existentes", async () => {
  await prepararJug();
  await assertSucceeds(crearExp(as("admin"), "admin", "XYZ", "jugA"));
  const foto = (db, id, data, by = "admin") => setDoc(doc(db, "jugadorFotos", id), { data, updatedAt: serverTimestamp(), updatedBy: by });
  const ok = "data:image/jpeg;base64," + "A".repeat(4000);
  await assertSucceeds(foto(as("admin"), "XYZ", ok));
  await assertSucceeds(getDoc(doc(as("admin"), "jugadorFotos/XYZ")));
  await assertFails(foto(as("admin"), "NOEXISTE", ok));                                   // sin expediente
  await assertFails(foto(as("admin"), "XYZ", "data:text/html;base64,PHNjcmlwdD4="));      // no es imagen
  await assertFails(foto(as("admin"), "XYZ", "data:image/jpeg;base64," + "A".repeat(300001))); // demasiado grande
  await assertFails(foto(as("admin"), "XYZ", ok, "otro"));                                 // autor falso
  await assertFails(foto(as("jugA"), "XYZ", ok, "jugA"));                                  // el propio jugador
  await assertFails(getDoc(doc(as("coachA"), "jugadorFotos/XYZ")));
  await assertFails(getDoc(doc(as("jugB"), "jugadorFotos/XYZ")));
  await assertSucceeds(deleteDoc(doc(as("admin"), "jugadorFotos/XYZ")));
});
test("HU-007: género obligatorio y fecha de ingreso con formato válido", async () => {
  await prepararJug();
  await assertFails(crearExp(as("admin"), "admin", "G1", "jugA", { genero: "X" }));
  await assertFails(crearExp(as("admin"), "admin", "G2", "jugA", { fechaIngreso: "01/08/2025" }));
  await assertSucceeds(crearExp(as("admin"), "admin", "G3", "jugA", { fechaIngreso: "" }));
});

// ---------- HU-008: jugador → categoría ----------
async function prepararHU008() {
  await prepararJug();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const mk = (id, n, estado, coach) => setDoc(doc(db, "categorias", id), cat("admin", {
      createdAt: Timestamp.now(), updatedAt: Timestamp.now(), nombre: n, nombreNormalizado: n.toLowerCase(),
      codigoGrupo: n.toUpperCase(), codigoNormalizado: n.toUpperCase(), estado, entrenadorId: coach }));
    await mk("catA", "Sub-15", "Activa", "coachA");
    await mk("catB", "Sub-17", "Activa", null);
    await mk("catOff", "Sub-20", "Inactiva", null);
  });
  await assertSucceeds(crearExp(as("admin"), "admin", "XYZ", "jugA"));
}
// Igual que la app (HU-008 + HU-009): expediente + traslado de la ficha deportiva en una sola operación.
async function mover(db, cat, by = "admin", extra = {}, { ficha = true, liberar = true } = {}) {
  const actual = (await raw("jugadores/XYZ")).categoriaId;
  const j = { ...(await raw("jugadores/XYZ")), ...extra };
  const b = writeBatch(db);
  b.update(doc(db, "jugadores/XYZ"), { categoriaId: cat, updatedAt: serverTimestamp(), updatedBy: by, ...extra });
  if (ficha && typeof cat === "string") b.set(doc(db, "categorias", cat, "nomina", "XYZ"), fichaDe(j));
  if (liberar && actual && actual !== cat) b.delete(doc(db, "categorias", actual, "nomina", "XYZ"));
  return b.commit();
}
const fichaDe = (j) => ({ nombres: j.nombres, apellidos: j.apellidos, tipoDocumento: j.tipoDocumento, numeroDocumento: j.numeroDocumento,
  fechaNacimiento: j.fechaNacimiento, genero: j.genero ?? "", posicion: j.posicion ?? "", numeroCamiseta: j.numeroCamiseta ?? null,
  estado: j.estado, updatedAt: serverTimestamp() });

test("HU-008 P1/P3/P11/P12: Admin asigna y cambia; el MISMO expediente, sin tocar userId ni datos personales", async () => {
  await prepararHU008();
  await assertSucceeds(mover(as("admin"), "catA"));
  await assertSucceeds(mover(as("admin"), "catB"));          // cambio A → B (catB sin entrenador: permitido)
  const j = await raw("jugadores/XYZ");
  if (j.categoriaId !== "catB" || j.userId !== "jugA" || j.nombres !== "Juan" || j.emergencia.nombre !== "María Pérez") throw new Error("Datos alterados");
  if ((await raw("users/jugA")).jugadorId !== "XYZ") throw new Error("Vínculo cuenta↔expediente alterado");
});
test("HU-008 P7/P8: categoría inactiva, inexistente, la misma, null u otros campos → denegado", async () => {
  await prepararHU008();
  await assertFails(mover(as("admin"), "catOff"));
  await assertFails(mover(as("admin"), "noExiste"));
  await assertSucceeds(mover(as("admin"), "catA"));
  await assertFails(mover(as("admin"), "catA"));                                 // misma categoría
  await assertFails(mover(as("admin"), null));                                   // desvincular: no en esta HU
  await assertFails(mover(as("admin"), "catB", "admin", { nombres: "Otro" }));   // otros campos
  await assertFails(mover(as("admin"), "catB", "admin", { userId: "jugB" }));
  await assertFails(mover(as("admin"), "catB", "otro"));                         // auditoría falsa
});
test("HU-008 P9/P10: Entrenador y Jugador NO cambian categoriaId (ni el propio)", async () => {
  await prepararHU008();
  await assertFails(mover(as("coachA"), "catA", "coachA"));   // entrenador se apropia del jugador
  await assertFails(mover(as("jugA"), "catA", "jugA"));       // el jugador se cambia a sí mismo
  await assertFails(mover(as("jugB"), "catB", "jugB"));
});
test("HU-008 P2/P4: la nómina es una consulta por categoriaId (Admin); Entrenador aún no la lee (HU-009)", async () => {
  await prepararHU008();
  await assertSucceeds(mover(as("admin"), "catA"));
  const a = await assertSucceeds(getDocs(query(collection(as("admin"), "jugadores"), where("categoriaId", "==", "catA"))));
  if (a.size !== 1) throw new Error("Debía estar en la nómina de A");
  await assertSucceeds(mover(as("admin"), "catB"));
  const a2 = await getDocs(query(collection(as("admin"), "jugadores"), where("categoriaId", "==", "catA")));
  const b2 = await getDocs(query(collection(as("admin"), "jugadores"), where("categoriaId", "==", "catB")));
  if (a2.size !== 0 || b2.size !== 1) throw new Error("Debía salir de A y entrar en B");
  await assertFails(getDocs(query(collection(as("coachA"), "jugadores"), where("categoriaId", "==", "catA"))));
});

// ---------- HU-009: ficha deportiva (proyección) para el Entrenador ----------
const nomina = (uid, cat) => getDocs(collection(as(uid), "categorias", cat, "nomina"));
test("HU-009 P1/P3/P7: Entrenador A lee la nómina y la ficha de SU categoría; nunca el expediente", async () => {
  await prepararHU008();
  await assertSucceeds(mover(as("admin"), "catA"));
  const n = await assertSucceeds(nomina("coachA", "catA"));
  if (n.size !== 1 || n.docs[0].id !== "XYZ") throw new Error("A debía ver a XYZ");
  await assertSucceeds(getDoc(doc(as("coachA"), "categorias/catA/nomina/XYZ")));
  await assertFails(getDoc(doc(as("coachA"), "jugadores/XYZ")));                       // expediente completo: NO
  await assertFails(getDocs(collection(as("coachA"), "jugadores")));
  await assertFails(getDocs(query(collection(as("coachA"), "jugadores"), where("categoriaId", "==", "catA"))));
});
test("HU-009 foto: el entrenador de la categoría ACTUAL la lee; el de otra categoría no; tras el traslado, cambia", async () => {
  await prepararHU008();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "users/coachB"), base("coachB", "Entrenador", "Activo"));
    await updateDoc(doc(ctx.firestore(), "categorias/catB"), { entrenadorId: "coachB" });
    await setDoc(doc(ctx.firestore(), "jugadorFotos/XYZ"), { data: "data:image/jpeg;base64,AAAA", updatedAt: Timestamp.now(), updatedBy: "admin" });
  });
  await assertFails(getDoc(doc(as("coachA"), "jugadorFotos/XYZ")));     // sin categoría: nadie
  await assertSucceeds(mover(as("admin"), "catA"));
  await assertSucceeds(getDoc(doc(as("coachA"), "jugadorFotos/XYZ")));
  await assertFails(getDoc(doc(as("coachB"), "jugadorFotos/XYZ")));
  await assertSucceeds(mover(as("admin"), "catB"));
  await assertFails(getDoc(doc(as("coachA"), "jugadorFotos/XYZ")));
  await assertSucceeds(getDoc(doc(as("coachB"), "jugadorFotos/XYZ")));
  await assertFails(getDocs(collection(as("coachB"), "jugadorFotos")));  // nunca listar todas
});
test("HU-009 P13: la ficha NO contiene datos personales restringidos (lo que Firestore entrega)", async () => {
  await prepararHU008();
  await assertSucceeds(mover(as("admin"), "catA"));
  const f = (await getDoc(doc(as("coachA"), "categorias/catA/nomina/XYZ"))).data();
  const prohibidos = ["userId", "documentoNormalizado", "telefono", "correoContacto",
    "direccion", "ciudad", "emergencia", "observaciones", "observacionesDeportivas", "ciudadNacimiento", "fechaIngreso", "createdBy"];
  const fugas = prohibidos.filter((k) => k in f);
  if (fugas.length) throw new Error("Campos restringidos en la ficha: " + fugas.join(", "));
});
test("HU-009 P2/P9: acceso cruzado — B no lee la nómina ni la ficha de A (aunque conozca los IDs)", async () => {
  await prepararHU008();
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), "categorias/catB"), { entrenadorId: "coachB" }));
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "users/coachB"), base("coachB", "Entrenador", "Activo")));
  await assertSucceeds(mover(as("admin"), "catA"));
  await assertFails(nomina("coachB", "catA"));
  await assertFails(getDoc(doc(as("coachB"), "categorias/catA/nomina/XYZ")));
  await assertFails(nomina("jugA", "catA"));                     // el propio jugador tampoco (HU posterior)
  await assertFails(nomina("jugB", "catA"));
});
test("HU-009 P10: traslado A → B — la ficha sale de A y entra en B; A pierde el acceso, B lo gana", async () => {
  await prepararHU008();
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), "categorias/catB"), { entrenadorId: "coachB" }));
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "users/coachB"), base("coachB", "Entrenador", "Activo")));
  await assertSucceeds(mover(as("admin"), "catA"));
  await assertFails(mover(as("admin"), "catB", "admin", {}, { liberar: false }));   // sin sacarla de A: denegado
  await assertFails(mover(as("admin"), "catB", "admin", {}, { ficha: false }));     // sin ficha en B: denegado
  await assertSucceeds(mover(as("admin"), "catB"));
  await assertFails(getDoc(doc(as("coachA"), "categorias/catA/nomina/XYZ")));       // ya no existe / no es suya
  if ((await nomina("coachA", "catA")).size !== 0) throw new Error("Debía desaparecer de A");
  if ((await assertSucceeds(nomina("coachB", "catB"))).size !== 1) throw new Error("Debía aparecer en B");
  if ((await raw("jugadores/XYZ")).userId !== "jugA") throw new Error("userId alterado");
});
test("HU-009 P11: cambio del entrenador de la categoría revoca al anterior sin tocar expedientes", async () => {
  await prepararHU008();
  await assertSucceeds(mover(as("admin"), "catA"));
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "users/coachB"), base("coachB", "Entrenador", "Activo")));
  await assertSucceeds(updateDoc(doc(as("admin"), "categorias/catA"), { entrenadorId: "coachB", updatedAt: serverTimestamp(), updatedBy: "admin" }));
  await assertFails(nomina("coachA", "catA"));
  await assertSucceeds(nomina("coachB", "catA"));
  if ((await raw("jugadores/XYZ")).categoriaId !== "catA") throw new Error("El jugador no debía cambiar");
});
test("HU-009 §14: la ficha no se puede alterar ni desincronizar (ni el entrenador ni el admin a mano)", async () => {
  await prepararHU008();
  await assertSucceeds(mover(as("admin"), "catA"));
  const ref = (db) => doc(db, "categorias/catA/nomina/XYZ");
  await assertFails(updateDoc(ref(as("coachA")), { posicion: "Portero", updatedAt: serverTimestamp() }));      // entrenador
  await assertFails(updateDoc(ref(as("admin")), { nombres: "Otro", updatedAt: serverTimestamp() }));          // distinta al expediente
  await assertFails(updateDoc(ref(as("admin")), { telefono: "300", updatedAt: serverTimestamp() }));          // campo no permitido
  await assertFails(setDoc(doc(as("admin"), "categorias/catB/nomina/XYZ"), fichaDe(await raw("jugadores/XYZ")))); // ficha en otra categoría
  await assertFails(deleteDoc(ref(as("coachA"))));
  await assertFails(deleteDoc(ref(as("admin"))));                                                               // sigue en catA
  // Editar el expediente sin actualizar la ficha → denegado; actualizándola → permitido
  const e = { telefono: "3110000000", posicion: "Portero", updatedAt: serverTimestamp(), updatedBy: "admin" };
  await assertFails(updateDoc(doc(as("admin"), "jugadores/XYZ"), e));
  const b = writeBatch(as("admin"));
  b.update(doc(as("admin"), "jugadores/XYZ"), e);
  b.set(doc(as("admin"), "categorias/catA/nomina/XYZ"), fichaDe({ ...(await raw("jugadores/XYZ")), posicion: "Portero" }));
  await assertSucceeds(b.commit());
});
test("HU-009: entrenador inactivo o sin sesión no lee fichas", async () => {
  await prepararHU008();
  await assertSucceeds(mover(as("admin"), "catA"));
  await assertFails(getDocs(collection(env.unauthenticatedContext().firestore(), "categorias", "catA", "nomina")));
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), "users/coachA"), { estado: "Inactivo" }));
  await assertFails(nomina("coachA", "catA"));
});

// ---------- HU-010: programación de entrenamientos ----------
const p2 = (n) => String(n).padStart(2, "0");
const diaCol = (offsetDias) => { const d = new Date(Date.now() - 5 * 3600e3 + offsetDias * 86400e3);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`; };
const sesion = (cat, by, extra = {}) => ({ categoriaId: cat, entrenadorId: by, fecha: diaCol(1), horaInicio: "16:00", horaFin: "17:30",
  lugar: "Cancha 2", observaciones: "", estado: "Programada",
  createdAt: serverTimestamp(), createdBy: by, updatedAt: serverTimestamp(), updatedBy: by, ...extra });
const sesId = (d) => `${d.fecha}_${d.horaInicio.replace(":", "")}`;
const programar = (uid, cat, extra = {}, id) => { const d = sesion(cat, uid, extra); return setDoc(doc(as(uid), "categorias", cat, "entrenamientos", id ?? sesId(d)), d); };
async function prepararHU010() {
  await prepararHU008();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "users/coachB"), base("coachB", "Entrenador", "Activo"));
    await updateDoc(doc(db, "categorias/catB"), { entrenadorId: "coachB" });
  });
  await assertSucceeds(mover(as("admin"), "catA"));     // jugA (XYZ) pertenece a catA
}

test("HU-010 P1/P10: Entrenador programa en SU categoría activa; estado Programada; queda a su nombre", async () => {
  await prepararHU010();
  await assertSucceeds(programar("coachA", "catA"));
  const d = sesion("catA", "coachA"); const s = await raw(`categorias/catA/entrenamientos/${sesId(d)}`);
  if (s.estado !== "Programada" || s.entrenadorId !== "coachA" || s.categoriaId !== "catA") throw new Error("Sesión mal guardada");
});
test("HU-010 P2/P11: Entrenador NO programa en categorías ajenas, inactivas ni a nombre de otro", async () => {
  await prepararHU010();
  await assertFails(programar("coachA", "catB"));                                   // ajena (de coachB)
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), "categorias/catOff"), { entrenadorId: "coachA" }));
  await assertFails(programar("coachA", "catOff"));                                 // propia pero inactiva
  await assertFails(programar("coachA", "catA", { entrenadorId: "coachB" }));      // a nombre de otro
  await assertFails(programar("coachA", "catA", { categoriaId: "catB" }));         // categoría del cuerpo ≠ ruta
  await assertFails(programar("coachA", "catA", { createdBy: "admin" }));          // auditoría falsa
});
test("HU-010 P3/P4/P5/P6: fecha pasada, fin ≤ inicio, lugar vacío, estado distinto → denegado", async () => {
  await prepararHU010();
  await assertFails(programar("coachA", "catA", { fecha: diaCol(-1) }));
  await assertFails(programar("coachA", "catA", { horaFin: "16:00" }));
  await assertFails(programar("coachA", "catA", { horaFin: "15:00" }));
  await assertFails(programar("coachA", "catA", { lugar: "" }));
  await assertFails(programar("coachA", "catA", { lugar: "x".repeat(81) }));
  await assertFails(programar("coachA", "catA", { estado: "Realizada" }));
  await assertFails(programar("coachA", "catA", { horaInicio: "25:00" }));
  await assertFails(programar("coachA", "catA", { observaciones: "x".repeat(301) }));
  await assertFails(programar("coachA", "catA", { asistencia: [] }));              // campos fuera de la lista
  await assertFails(programar("coachA", "catA", {}, "id-inventado"));              // ID no determinista
});
test("HU-010 P13: doble envío idéntico → una sola sesión (el segundo es update → denegado)", async () => {
  await prepararHU010();
  await assertSucceeds(programar("coachA", "catA"));
  await assertFails(programar("coachA", "catA"));
  const all = await getDocs(collection(as("coachA"), "categorias", "catA", "entrenamientos"));
  if (all.size !== 1) throw new Error("Sesión duplicada");
});
test("HU-010 P7/P8/P9: lectura — Admin todas; Entrenador solo las suyas; Jugador solo las de SU categoría", async () => {
  await prepararHU010();
  await assertSucceeds(programar("coachA", "catA"));
  await assertSucceeds(programar("coachB", "catB"));
  const col = (uid, cat) => getDocs(collection(as(uid), "categorias", cat, "entrenamientos"));
  await assertSucceeds(col("admin", "catA")); await assertSucceeds(col("admin", "catB"));
  await assertSucceeds(col("coachA", "catA")); await assertFails(col("coachA", "catB"));
  await assertSucceeds(col("jugA", "catA"));   await assertFails(col("jugA", "catB"));
  await assertFails(col("jugB", "catA"));                                          // jugador sin expediente
  await assertFails(getDocs(collection(env.unauthenticatedContext().firestore(), "categorias", "catA", "entrenamientos")));
});
test("HU-010 P12: Jugador y Admin NO programan; nadie edita ni elimina sesiones (aún)", async () => {
  await prepararHU010();
  await assertFails(programar("jugA", "catA"));
  await assertFails(programar("admin", "catA"));
  await assertSucceeds(programar("coachA", "catA"));
  const d = sesion("catA", "coachA"); const ref = (uid) => doc(as(uid), "categorias", "catA", "entrenamientos", sesId(d));
  await assertFails(updateDoc(ref("coachA"), { lugar: "Otra", updatedAt: serverTimestamp() }));
  await assertFails(deleteDoc(ref("coachA")));
  await assertFails(deleteDoc(ref("admin")));
});
test("HU-010 contexto del Jugador: lee SU categoría y el perfil de SU entrenador; nada más", async () => {
  await prepararHU010();
  await assertSucceeds(getDoc(doc(as("jugA"), "categorias/catA")));
  await assertFails(getDoc(doc(as("jugA"), "categorias/catB")));
  await assertFails(getDocs(collection(as("jugA"), "categorias")));
  await assertSucceeds(getDoc(doc(as("jugA"), "users/coachA")));
  await assertFails(getDoc(doc(as("jugA"), "users/coachB")));
  await assertFails(getDoc(doc(as("jugA"), "users/admin")));
  await assertFails(getDoc(doc(as("jugA"), "categorias/catA/nomina/XYZ")));       // la nómina sigue siendo del entrenador
});
test("HU-010 P14: traslado o cambio de entrenador revocan el acceso al instante", async () => {
  await prepararHU010();
  await assertSucceeds(programar("coachA", "catA"));
  await assertSucceeds(mover(as("admin"), "catB"));                               // jugA pasa a catB
  await assertFails(getDocs(collection(as("jugA"), "categorias", "catA", "entrenamientos")));
  await assertSucceeds(getDocs(collection(as("jugA"), "categorias", "catB", "entrenamientos")));
  await assertSucceeds(updateDoc(doc(as("admin"), "categorias/catA"), { entrenadorId: "coachB", updatedAt: serverTimestamp(), updatedBy: "admin" }));
  await assertFails(getDocs(collection(as("coachA"), "categorias", "catA", "entrenamientos")));
  await assertFails(programar("coachA", "catA", { horaInicio: "18:00", horaFin: "19:00" }));
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), "users/coachB"), { estado: "Inactivo" }));
  await assertFails(getDocs(collection(as("coachB"), "categorias", "catA", "entrenamientos")));
});

// ---------- HU-011: asistencia ----------
async function sesRaw(cat, fecha, coach = "coachA") {
  const id = `${fecha}_1600`;
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "categorias", cat, "entrenamientos", id),
    { categoriaId: cat, entrenadorId: coach, fecha, horaInicio: "16:00", horaFin: "17:30", lugar: "Cancha 1", observaciones: "", estado: "Programada",
      createdAt: Timestamp.now(), createdBy: coach, updatedAt: Timestamp.now(), updatedBy: coach }));
  return id;
}
const CAT_NOMBRE = { catA: "Sub-15", catB: "Sub-17" };
const asis = (by, cat, ses, jug = "XYZ", estado = "Asistió", extra = {}) => ({
  sesionId: ses, jugadorId: jug, categoriaId: cat, estadoAsistencia: estado,
  sesion: { fecha: ses.split("_")[0], horaInicio: "16:00", horaFin: "17:30", lugar: "Cancha 1", categoriaNombre: CAT_NOMBRE[cat] ?? "" },
  participante: { nombres: "Juan", apellidos: "Pérez", numeroCamiseta: 9, posicion: "Delantero" },
  version: 1, fechaCreacion: serverTimestamp(), fechaActualizacion: serverTimestamp(), createdBy: by, updatedBy: by, ...extra });
const aRef = (uid, cat, ses, jug = "XYZ") => doc(as(uid), "categorias", cat, "entrenamientos", ses, "asistencias", jug);
const registrar = (uid, cat, ses, jug, estado, extra) => setDoc(aRef(uid, cat, ses, jug), asis(uid, cat, ses, jug, estado, extra));
const corregir = (uid, cat, ses, estado, version, extra = {}) =>
  updateDoc(aRef(uid, cat, ses), { estadoAsistencia: estado, version, fechaActualizacion: serverTimestamp(), updatedBy: uid, ...extra });

test("HU-011 P1/P17: Entrenador registra la asistencia de SU sesión de hoy (un doc por jugador, ID = jugadorId)", async () => {
  await prepararHU010();
  const ses = await sesRaw("catA", diaCol(0));
  await assertSucceeds(registrar("coachA", "catA", ses));
  const r = await raw(`categorias/catA/entrenamientos/${ses}/asistencias/XYZ`);
  if (r.estadoAsistencia !== "Asistió" || r.version !== 1 || r.createdBy !== "coachA" || r.categoriaId !== "catA") throw new Error("Registro incorrecto");
});
test("HU-011 P18: corrección = mismo documento, version+1; createdBy/fechaCreacion intactos; nunca se elimina", async () => {
  await prepararHU010();
  const ses = await sesRaw("catA", diaCol(-2));
  await assertSucceeds(registrar("coachA", "catA", ses));
  await assertFails(registrar("coachA", "catA", ses));                                // re-crear (duplicar) → es update → denegado
  await assertFails(corregir("coachA", "catA", ses, "Falta", 1));                     // sin subir versión (sobrescritura a ciegas)
  await assertSucceeds(corregir("coachA", "catA", ses, "Falta", 2));
  await assertFails(corregir("coachA", "catA", ses, "Excusa", 2));                    // versión vieja → conflicto
  await assertFails(corregir("coachA", "catA", ses, "Excusa", 3, { createdBy: "otro" }));
  await assertFails(corregir("coachA", "catA", ses, "Excusa", 3, { participante: { nombres: "X", apellidos: "Y", numeroCamiseta: 1, posicion: "" } }));
  await assertFails(corregir("coachA", "catA", ses, "Pendiente", 3));
  await assertFails(deleteDoc(aRef("coachA", "catA", ses)));
  await assertFails(deleteDoc(aRef("admin", "catA", ses)));
});
test("HU-011 ventana: futura ✕ · hoy ✓ · hace 7 días ✓ · hace 8 días ✕", async () => {
  await prepararHU010();
  await assertFails(registrar("coachA", "catA", await sesRaw("catA", diaCol(1))));
  await assertSucceeds(registrar("coachA", "catA", await sesRaw("catA", diaCol(-7))));
  const vieja = await sesRaw("catA", diaCol(-8));
  await assertFails(registrar("coachA", "catA", vieja));
});
test("HU-011 P16 datos: estado inválido, participante falso o ajeno a la nómina, IDs cruzados → denegado", async () => {
  await prepararHU010();
  const ses = await sesRaw("catA", diaCol(0));
  await assertFails(registrar("coachA", "catA", ses, "XYZ", "Pendiente"));
  await assertFails(registrar("coachA", "catA", ses, "XYZ", "Asistió", { participante: { nombres: "Otro", apellidos: "Pérez", numeroCamiseta: 9, posicion: "Delantero" } }));
  await assertFails(registrar("coachA", "catA", ses, "NOEXISTE"));                     // no está en la nómina
  await assertFails(registrar("coachA", "catA", ses, "XYZ", "Asistió", { jugadorId: "OTRO" }));
  await assertFails(registrar("coachA", "catA", ses, "XYZ", "Asistió", { sesionId: "otra" }));
  await assertFails(registrar("coachA", "catA", ses, "XYZ", "Asistió", { version: 5 }));
  await assertFails(registrar("coachA", "catA", ses, "XYZ", "Asistió", { createdBy: "admin" }));
  await assertFails(registrar("coachA", "catA", ses, "XYZ", "Asistió", { extra: true }));
  await assertFails(registrar("coachA", "catA", "no-existe"));                         // sesión inexistente
});
test("HU-011 P20/P21: acceso cruzado — otro entrenador, Jugador y Admin no registran; Admin solo consulta", async () => {
  await prepararHU010();
  const ses = await sesRaw("catA", diaCol(0));
  await assertFails(registrar("coachB", "catA", ses));
  await assertFails(registrar("jugA", "catA", ses));
  await assertFails(registrar("admin", "catA", ses));
  await assertSucceeds(registrar("coachA", "catA", ses));
  const col = (uid) => getDocs(collection(as(uid), "categorias", "catA", "entrenamientos", ses, "asistencias"));
  await assertSucceeds(col("coachA")); await assertSucceeds(col("admin"));
  await assertFails(col("coachB")); await assertFails(col("jugA"));
  await assertFails(getDoc(aRef("jugA", "catA", ses)));
  await assertFails(corregir("jugA", "catA", ses, "Falta", 2));
  await assertFails(corregir("coachB", "catA", ses, "Falta", 2));
  await assertFails(corregir("admin", "catA", ses, "Falta", 2));
});
test("HU-011 P19: historial — el jugador se traslada y su registro sigue (legible y corregible en la ventana)", async () => {
  await prepararHU010();
  const ses = await sesRaw("catA", diaCol(-1));
  await assertSucceeds(registrar("coachA", "catA", ses));
  await assertSucceeds(mover(as("admin"), "catB"));                                   // XYZ pasa a catB
  await assertSucceeds(getDoc(aRef("coachA", "catA", ses)));
  await assertSucceeds(corregir("coachA", "catA", ses, "Atraso", 2));
  const r = await raw(`categorias/catA/entrenamientos/${ses}/asistencias/XYZ`);
  if (r.participante.nombres !== "Juan" || r.categoriaId !== "catA") throw new Error("Historial perdido");
  await assertFails(getDoc(aRef("coachB", "catA", ses)));                             // el nuevo entrenador del jugador no ve sesiones ajenas
});
test("HU-011: cambio de entrenador de la categoría revoca al anterior; entrenador inactivo no registra", async () => {
  await prepararHU010();
  const ses = await sesRaw("catA", diaCol(0));
  await assertSucceeds(updateDoc(doc(as("admin"), "categorias/catA"), { entrenadorId: "coachB", updatedAt: serverTimestamp(), updatedBy: "admin" }));
  await assertFails(registrar("coachA", "catA", ses));
  await assertSucceeds(registrar("coachB", "catA", ses));
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), "users/coachB"), { estado: "Inactivo" }));
  await assertFails(corregir("coachB", "catA", ses, "Falta", 2));
});

// ---------- HU-012: historial (consulta) ----------
const historial = (uid, jug) => getDocs(query(collectionGroup(as(uid), "asistencias"), where("jugadorId", "==", jug)));
test("HU-011/012: la copia de la sesión es obligatoria e idéntica a la sesión real", async () => {
  await prepararHU010();
  const ses = await sesRaw("catA", diaCol(0));
  const base = asis("coachA", "catA", ses);
  await assertFails(setDoc(aRef("coachA", "catA", ses), { ...base, sesion: { ...base.sesion, lugar: "Otro" } }));
  await assertFails(setDoc(aRef("coachA", "catA", ses), { ...base, sesion: { ...base.sesion, fecha: diaCol(-30) } }));
  await assertFails(setDoc(aRef("coachA", "catA", ses), { ...base, sesion: { ...base.sesion, categoriaNombre: "Falsa" } }));
  await assertSucceeds(setDoc(aRef("coachA", "catA", ses), base));
  await assertFails(corregir("coachA", "catA", ses, "Falta", 2, { sesion: { ...base.sesion, lugar: "Otro" } }));   // inmutable
});
test("HU-012 P1/P13: el Jugador consulta SU historial (collectionGroup) y nunca el de otro", async () => {
  await prepararHU010();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "users/jugB"), { ...base("jugB", "Jugador", "Activo"), jugadorId: "OTRO" });
  });
  const ses = await sesRaw("catA", diaCol(0));
  await assertSucceeds(registrar("coachA", "catA", ses));
  const r = await assertSucceeds(historial("jugA", "XYZ"));
  if (r.size !== 1) throw new Error("Debía ver su registro");
  await assertFails(historial("jugA", "OTRO"));                                       // otro jugador
  await assertFails(historial("jugB", "XYZ"));                                        // otro jugador pide el de jugA
  await assertFails(getDocs(collectionGroup(as("jugA"), "asistencias")));            // sin filtro
  await assertSucceeds(getDoc(aRef("jugA", "catA", ses)));                            // su propio registro por ruta
  await assertFails(updateDoc(aRef("jugA", "catA", ses), { estadoAsistencia: "Falta", version: 2, fechaActualizacion: serverTimestamp(), updatedBy: "jugA" }));
});
test("HU-012 P12: Entrenador no usa collectionGroup; Admin sí (permisos administrativos)", async () => {
  await prepararHU010();
  const ses = await sesRaw("catA", diaCol(0));
  await assertSucceeds(registrar("coachA", "catA", ses));
  await assertFails(historial("coachA", "XYZ"));
  await assertFails(historial("coachB", "XYZ"));
  await assertSucceeds(historial("admin", "XYZ"));
  await assertFails(historial("off", "XYZ"));                                         // usuario inactivo
});
test("HU-012 P14: tras cambiar de categoría el Jugador conserva TODO su historial", async () => {
  await prepararHU010();
  const s1 = await sesRaw("catA", diaCol(-1));
  await assertSucceeds(registrar("coachA", "catA", s1));
  await assertSucceeds(mover(as("admin"), "catB"));
  const s2 = await sesRaw("catB", diaCol(0), "coachB");
  await assertSucceeds(registrar("coachB", "catB", s2, "XYZ", "Atraso"));
  const r = await assertSucceeds(historial("jugA", "XYZ"));
  if (r.size !== 2) throw new Error("Historial incompleto tras el traslado");
  const nombres = r.docs.map((d) => d.data().sesion.categoriaNombre).sort();
  if (nombres.join() !== "Sub-15,Sub-17") throw new Error("Categoría histórica incorrecta");
  await assertFails(getDocs(collection(as("coachB"), "categorias", "catA", "entrenamientos", s1, "asistencias")));   // B no ve sesiones de A
});
test("HU-012: el Jugador ve su propia foto; no la de otros", async () => {
  await prepararHU010();
  const foto = "data:image/jpeg;base64,AAAA";
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "jugadorFotos/XYZ"), { data: foto, updatedAt: Timestamp.now(), updatedBy: "admin" });
    await setDoc(doc(ctx.firestore(), "jugadorFotos/OTRO"), { data: foto, updatedAt: Timestamp.now(), updatedBy: "admin" });
  });
  await assertSucceeds(getDoc(doc(as("jugA"), "jugadorFotos/XYZ")));
  await assertFails(getDoc(doc(as("jugA"), "jugadorFotos/OTRO")));
  await assertFails(getDoc(doc(as("jugB"), "jugadorFotos/XYZ")));
});

// ---------- HU-013: partidos, rendimiento y alineación ----------
const PART = { nombres: "Juan", apellidos: "Pérez", numeroCamiseta: 9, posicion: "Delantero" };
const partido = (by, cat, extra = {}) => ({ categoriaId: cat, entrenadorId: by, rival: "Halcones FC", fecha: diaCol(0), hora: "10:00",
  lugar: "Cancha 1", tipo: "Liga", estado: "Programado", formatoPartido: "F7", observaciones: "", conRendimiento: false, version: 1,
  createdAt: serverTimestamp(), createdBy: by, updatedAt: serverTimestamp(), updatedBy: by, ...extra });
const pRef = (uid, cat, pid, ...sub) => doc(as(uid), "categorias", cat, "partidos", pid, ...sub);
const editar = (uid, cat, pid, cambios, version) => updateDoc(pRef(uid, cat, pid), { ...cambios, version, updatedAt: serverTimestamp(), updatedBy: uid });
async function partidoRaw(cat, pid, extra = {}) {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "categorias", cat, "partidos", pid),
    { ...partido("coachA", cat), createdAt: Timestamp.now(), updatedAt: Timestamp.now(), ...extra }));
}
const convocar = (uid, cat, pid, extra = {}, jid = "XYZ") => setDoc(pRef(uid, cat, pid, "participantes", jid), {
  jugadorId: jid, categoriaId: cat, rolConvocatoria: "Suplente", participo: false, participante: PART,
  version: 1, createdAt: serverTimestamp(), createdBy: uid, updatedAt: serverTimestamp(), updatedBy: uid, ...extra });
const nums = (extra = {}) => ({ goles: 1, asistencias: 0, minutosJugados: 60, tarjetasAmarillas: 0, tarjetasRojas: 0, valoracionFinal: 7.5, ...extra });
// Igual que guardarRendimiento(): rendimiento + participo + conRendimiento en una sola operación
function rendir(uid, cat, pid, n = nums(), { snap = {}, marcar = true, participo } = {}) {
  const db = as(uid); const b = writeBatch(db);
  b.set(doc(db, "categorias", cat, "partidos", pid, "rendimientos", "XYZ"), { partidoId: pid, jugadorId: "XYZ", categoriaId: cat, ...n,
    participante: PART, partido: { fecha: snap.fecha ?? diaCol(-1), rival: "Halcones FC", tipo: "Liga", categoriaNombre: CAT_NOMBRE[cat], ...snap },
    version: 1, createdAt: serverTimestamp(), createdBy: uid, updatedAt: serverTimestamp(), updatedBy: uid });
  const pa = participo ?? (n.minutosJugados > 0);
  if (pa) b.update(doc(db, "categorias", cat, "partidos", pid, "participantes", "XYZ"), { participo: pa, version: 2, updatedAt: serverTimestamp(), updatedBy: uid });
  if (marcar) b.update(doc(db, "categorias", cat, "partidos", pid), { conRendimiento: true });
  return b.commit();
}
const slot = (j, x = 0.5, y = 0.5, posicionTactica = "Delantero") => ({ jugadorId: j, x, y, posicionTactica });
const tit = (lista) => Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`s${i + 1}`, lista[i] ?? null]));
// Igual que guardarAlineacion(): s1…sN empaquetados + lista "jugadores" en el mismo orden
const idsDe = (t) => Object.keys(t).sort((a, b) => +a.slice(1) - +b.slice(1)).map((k) => t[k]?.jugadorId).filter(Boolean);
const alinear = (uid, cat, pid, titulares, estado = "Borrador", formato = "F7", version = 1, jugadores = idsDe(titulares)) =>
  setDoc(pRef(uid, cat, pid, "alineaciones", "principal"), { partidoId: pid, categoriaId: cat, formatoPartido: formato, titulares, jugadores, estado, version,
    createdAt: serverTimestamp(), createdBy: uid, updatedAt: serverTimestamp(), updatedBy: uid });
async function prepararHU013() {
  await prepararHU010();
  await partidoRaw("catA", "pD", { estado: "Disputado", fecha: diaCol(-1) });
  await assertSucceeds(convocar("coachA", "catA", "pD"));
}

test("HU-013 P1/P2: Entrenador crea partidos en SU categoría activa; nunca en ajena, inactiva o a nombre de otro", async () => {
  await prepararHU010();
  await assertSucceeds(setDoc(pRef("coachA", "catA", "p1"), partido("coachA", "catA")));
  await assertFails(setDoc(pRef("coachA", "catB", "p2"), partido("coachA", "catB")));                      // ajena
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), "categorias/catOff"), { entrenadorId: "coachA" }));
  await assertFails(setDoc(pRef("coachA", "catOff", "p3"), partido("coachA", "catOff")));                  // inactiva
  await assertFails(setDoc(pRef("coachA", "catA", "p4"), partido("coachA", "catA", { entrenadorId: "coachB" })));
  await assertFails(setDoc(pRef("coachA", "catA", "p5"), partido("coachA", "catA", { categoriaId: "catB" })));
  await assertFails(setDoc(pRef("coachA", "catA", "p6"), partido("coachA", "catA", { conRendimiento: true })));
  await assertFails(setDoc(pRef("jugA", "catA", "p7"), partido("jugA", "catA")));                          // jugador
  await assertFails(setDoc(pRef("admin", "catA", "p8"), partido("admin", "catA")));                        // admin: solo lectura
});
test("HU-013 P3: validaciones del partido (rival, fecha, hora, tipo, estado, formato, Disputado futuro, campos extra)", async () => {
  await prepararHU010();
  const mal = [{ rival: "" }, { rival: "x".repeat(61) }, { fecha: "2026-13-01" }, { hora: "24:00" }, { tipo: "Final" }, { estado: "Jugado" },
    { formatoPartido: "F8" }, { observaciones: "x".repeat(301) }, { estado: "Disputado", fecha: diaCol(3) }, { goles: 3 }, { version: 2 }, { createdBy: "admin" }];
  for (const [i, m] of mal.entries()) await assertFails(setDoc(pRef("coachA", "catA", `m${i}`), partido("coachA", "catA", m)));
  await assertSucceeds(setDoc(pRef("coachA", "catA", "ok"), partido("coachA", "catA", { estado: "Disputado", fecha: diaCol(-2), formatoPartido: "F11" })));
});
test("HU-013 P4: editar con version+1; sin cambiar categoría/entrenador/conRendimiento; nunca borrar", async () => {
  await prepararHU010();
  await partidoRaw("catA", "p1");
  await assertFails(editar("coachA", "catA", "p1", { rival: "Otro" }, 1));                // version igual
  await assertSucceeds(editar("coachA", "catA", "p1", { rival: "Otro", formatoPartido: "F9" }, 2));
  await assertFails(editar("coachA", "catA", "p1", { categoriaId: "catB" }, 3));
  await assertFails(editar("coachA", "catA", "p1", { entrenadorId: "coachB" }, 3));
  await assertFails(editar("coachA", "catA", "p1", { conRendimiento: true }, 3));
  await assertFails(editar("coachB", "catA", "p1", { rival: "Robo" }, 3));                // otro entrenador
  await assertFails(deleteDoc(pRef("coachA", "catA", "p1")));
  await assertFails(deleteDoc(pRef("admin", "catA", "p1")));
});
test("HU-013 P5: con estadísticas, el partido no sale de Disputado", async () => {
  await prepararHU013();
  await assertSucceeds(rendir("coachA", "catA", "pD"));
  await assertFails(editar("coachA", "catA", "pD", { estado: "Cancelado" }, 2));
  await assertFails(editar("coachA", "catA", "pD", { estado: "Programado" }, 2));
  await assertSucceeds(editar("coachA", "catA", "pD", { lugar: "Cancha 2" }, 2));
});
test("HU-013 P6: convocatoria = copia idéntica de la ficha activa; participo inicia en false", async () => {
  await prepararHU010();
  await partidoRaw("catA", "p1");
  await assertFails(convocar("coachA", "catA", "p1", { participante: { ...PART, nombres: "Falso" } }));
  await assertFails(convocar("coachA", "catA", "p1", { participo: true }));
  await assertFails(convocar("coachA", "catA", "p1", { rolConvocatoria: "Capitán" }));
  await assertFails(convocar("coachA", "catA", "p1", {}, "NO-ESTA"));                     // no está en la nómina
  await assertFails(convocar("coachA", "catA", "sinPartido"));                            // partido inexistente
  await assertFails(convocar("coachB", "catA", "p1"));                                    // otro entrenador
  await assertSucceeds(convocar("coachA", "catA", "p1"));
  await assertSucceeds(updateDoc(pRef("coachA", "catA", "p1", "participantes", "XYZ"), { rolConvocatoria: "Titular", version: 2, updatedAt: serverTimestamp(), updatedBy: "coachA" }));
  await assertFails(updateDoc(pRef("coachA", "catA", "p1", "participantes", "XYZ"), { participo: true, version: 3, updatedAt: serverTimestamp(), updatedBy: "coachA" })); // sin rendimiento
  await assertSucceeds(deleteDoc(pRef("coachA", "catA", "p1", "participantes", "XYZ")));   // sin rendimiento: se puede quitar
});
test("HU-013 P7/P8: rendimiento solo en partido Disputado, de un convocado, con snapshot y conRendimiento en la misma operación", async () => {
  await prepararHU010();
  await partidoRaw("catA", "pP");                                                             // Programado
  await assertSucceeds(convocar("coachA", "catA", "pP"));
  await assertFails(rendir("coachA", "catA", "pP"));
  await partidoRaw("catA", "pD", { estado: "Disputado", fecha: diaCol(-1) });
  await assertFails(rendir("coachA", "catA", "pD"));                                          // no convocado
  await assertSucceeds(convocar("coachA", "catA", "pD"));
  await assertFails(rendir("coachA", "catA", "pD", nums(), { marcar: false }));               // falta conRendimiento
  await assertFails(rendir("coachA", "catA", "pD", nums(), { participo: false }));           // participo ≠ minutos > 0
  await assertFails(rendir("coachA", "catA", "pD", nums(), { snap: { rival: "Inventado" } }));
  await assertFails(rendir("coachA", "catA", "pD", nums(), { snap: { categoriaNombre: "Falsa" } }));
  await assertSucceeds(rendir("coachA", "catA", "pD"));
  await assertFails(deleteDoc(pRef("coachA", "catA", "pD", "participantes", "XYZ")));         // con rendimiento: no se quita
  await assertFails(deleteDoc(pRef("coachA", "catA", "pD", "rendimientos", "XYZ")));
});
test("HU-013 P9: valoración opcional 1–10 con UN decimal; estadísticas enteras y en rango", async () => {
  await prepararHU013();
  const malos = [{ valoracionFinal: 0 }, { valoracionFinal: 10.5 }, { valoracionFinal: 7.25 }, { valoracionFinal: "8" }, { goles: -1 }, { goles: 1.5 },
    { minutosJugados: 151 }, { tarjetasAmarillas: 3 }, { tarjetasRojas: 2 }, { asistencias: 31 }];
  for (const m of malos) await assertFails(rendir("coachA", "catA", "pD", nums(m)));
  await assertSucceeds(rendir("coachA", "catA", "pD", nums({ valoracionFinal: null })));     // sin valorar: válido (nunca 0)
});
test("HU-013 P10: corrección con version+1; minutos 0 → participo false en la misma operación", async () => {
  await prepararHU013();
  await assertSucceeds(rendir("coachA", "catA", "pD", nums({ valoracionFinal: 6.8 })));
  const r = pRef("coachA", "catA", "pD", "rendimientos", "XYZ");
  await assertFails(updateDoc(r, { ...nums({ valoracionFinal: 8.5 }), version: 1, updatedAt: serverTimestamp(), updatedBy: "coachA" }));
  await assertFails(updateDoc(r, { partido: { fecha: diaCol(-1), rival: "X", tipo: "Liga", categoriaNombre: "Sub-15" }, version: 2, updatedAt: serverTimestamp(), updatedBy: "coachA" }));
  await assertSucceeds(updateDoc(r, { ...nums({ valoracionFinal: 8.5 }), version: 2, updatedAt: serverTimestamp(), updatedBy: "coachA" }));
  // minutos → 0 sin actualizar participo: denegado; con participo=false en el mismo lote: permitido
  await assertFails(updateDoc(r, { ...nums({ minutosJugados: 0 }), version: 3, updatedAt: serverTimestamp(), updatedBy: "coachA" }));
  const db = as("coachA"); const b = writeBatch(db);
  b.update(doc(db, "categorias/catA/partidos/pD/rendimientos/XYZ"), { ...nums({ minutosJugados: 0 }), version: 3, updatedAt: serverTimestamp(), updatedBy: "coachA" });
  b.update(doc(db, "categorias/catA/partidos/pD/participantes/XYZ"), { participo: false, version: 3, updatedAt: serverTimestamp(), updatedBy: "coachA" });
  await assertSucceeds(b.commit());
});
test("HU-013 P11: ventana de 30 días para registrar/corregir el rendimiento", async () => {
  await prepararHU010();
  await partidoRaw("catA", "pV", { estado: "Disputado", fecha: diaCol(-35) });
  await assertSucceeds(convocar("coachA", "catA", "pV"));
  await assertFails(rendir("coachA", "catA", "pV", nums(), { snap: { fecha: diaCol(-35) } }));
  await partidoRaw("catA", "pW", { estado: "Disputado", fecha: diaCol(-29) });
  await assertSucceeds(convocar("coachA", "catA", "pW"));
  await assertSucceeds(rendir("coachA", "catA", "pW", nums(), { snap: { fecha: diaCol(-29) } }));
});
test("HU-013 P12: alineación — coordenadas 0–1, sin duplicados, máximo por formato, Completa solo si está llena", async () => {
  await prepararHU013();
  const siete = ["a", "b", "c", "d", "e", "f", "g"].map((j, i) => slot(j, 0.1 * (i + 1), 0.5, i === 0 ? "Portero" : "Defensa"));
  await assertFails(alinear("coachA", "catA", "pD", tit([slot("a", 1.2, 0.5)])));                          // x fuera de rango
  await assertFails(alinear("coachA", "catA", "pD", tit([slot("a", 0.5, -0.1)])));
  await assertFails(alinear("coachA", "catA", "pD", tit([slot("a"), slot("a", 0.2)])));                    // duplicado
  await assertFails(alinear("coachA", "catA", "pD", tit([slot("a"), slot("b", 0.2)]), "Borrador", "F7", 1, ["a", "c"]));   // lista ≠ puestos
  await assertFails(alinear("coachA", "catA", "pD", { ...tit([]), s3: slot("a") }, "Borrador", "F7", 1, ["a"]));            // no empaquetado
  await assertFails(alinear("coachA", "catA", "pD", tit([slot("a", "0.5")])));                                               // x no numérico
  await assertFails(alinear("coachA", "catA", "pD", tit([slot("a", 0.5, 0.5, "Líbero")])));
  await assertFails(alinear("coachA", "catA", "pD", tit([...siete, slot("h")])));                          // 8 en F7
  await assertFails(alinear("coachA", "catA", "pD", tit(siete), "Borrador"));                              // llena pero "Borrador"
  await assertFails(alinear("coachA", "catA", "pD", tit(siete.slice(0, 3)), "Completa"));                  // incompleta pero "Completa"
  await assertFails(alinear("coachA", "catA", "pD", tit(siete), "Completa", "F11"));                       // formato ≠ partido
  await assertFails(setDoc(pRef("coachA", "catA", "pD", "alineaciones", "otra"), { partidoId: "pD" }));     // solo "principal"
  await assertSucceeds(alinear("coachA", "catA", "pD", tit(siete.slice(0, 3))));                            // borrador
  await assertFails(alinear("coachA", "catA", "pD", tit(siete), "Completa", "F7", 1));                      // update sin version+1
  const r = pRef("coachA", "catA", "pD", "alineaciones", "principal");
  await assertSucceeds(updateDoc(r, { titulares: tit(siete), jugadores: idsDe(tit(siete)), estado: "Completa", version: 2, updatedAt: serverTimestamp(), updatedBy: "coachA" }));
  // con 7 titulares ubicados, el partido no puede bajar a F5
  await assertFails(editar("coachA", "catA", "pD", { formatoPartido: "F5" }, 2));
  await assertFails(deleteDoc(r));
  await assertSucceeds(updateDoc(r, { titulares: tit(siete.slice(0, 2)), jugadores: ["a", "b"], estado: "Borrador", version: 3, updatedAt: serverTimestamp(), updatedBy: "coachA" }));
  await assertFails(updateDoc(r, { titulares: tit(siete.slice(0, 2)), jugadores: ["a", "b"], estado: "Borrador", version: 4, updatedAt: serverTimestamp(), updatedBy: "coachA", createdBy: "otro" }));
});
test("HU-013 P12b: alineación F11 completa (11 titulares) y F5 borrador con 2 — dentro de los límites de las reglas", async () => {
  await prepararHU010();
  await partidoRaw("catA", "p11", { formatoPartido: "F11" });
  await partidoRaw("catA", "p5", { formatoPartido: "F5" });
  const once = Array.from({ length: 11 }, (_, i) => slot(`j${i}`, (i % 4) / 3, i / 10, i === 0 ? "Portero" : "Mediocampista"));
  await assertSucceeds(alinear("coachA", "catA", "p11", tit(once), "Completa", "F11"));
  await assertSucceeds(alinear("coachA", "catA", "p5", tit(once.slice(0, 2)), "Borrador", "F5"));
  await assertFails(editar("coachA", "catA", "p11", { formatoPartido: "F9" }, 2));          // 11 ubicados no caben en F9
});
test("HU-013 P13: aislamiento — otro entrenador, jugador y anónimo no leen ni escriben; Admin solo lee", async () => {
  await prepararHU013();
  await assertSucceeds(rendir("coachA", "catA", "pD"));
  for (const sub of [[], ["participantes", "XYZ"], ["rendimientos", "XYZ"]]) {
    await assertSucceeds(getDoc(pRef("coachA", "catA", "pD", ...sub)));
    await assertSucceeds(getDoc(pRef("admin", "catA", "pD", ...sub)));
    await assertFails(getDoc(pRef("coachB", "catA", "pD", ...sub)));
    await assertFails(getDoc(pRef("jugA", "catA", "pD", ...sub)));                                       // Jugador: HU-014
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "categorias", "catA", "partidos", "pD", ...sub)));
  }
  await assertFails(getDocs(collection(as("coachB"), "categorias", "catA", "partidos")));
  await assertFails(getDocs(collectionGroup(as("coachA"), "rendimientos")));
  await assertFails(updateDoc(pRef("admin", "catA", "pD", "rendimientos", "XYZ"), { goles: 5, version: 2, updatedAt: serverTimestamp(), updatedBy: "admin" }));
  await assertFails(updateDoc(pRef("coachB", "catA", "pD", "rendimientos", "XYZ"), { goles: 5, version: 2, updatedAt: serverTimestamp(), updatedBy: "coachB" }));
});
test("HU-013 P14: cambio de entrenador o de categoría — el histórico se conserva y pasa al entrenador actual", async () => {
  await prepararHU013();
  await assertSucceeds(rendir("coachA", "catA", "pD"));
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), "categorias/catA"), { entrenadorId: "coachB" }));
  await assertFails(getDoc(pRef("coachA", "catA", "pD", "rendimientos", "XYZ")));      // ex-entrenador pierde acceso
  await assertSucceeds(getDoc(pRef("coachB", "catA", "pD", "rendimientos", "XYZ")));   // el nuevo lo ve
  await assertSucceeds(mover(as("admin"), "catB"));                                    // el jugador cambia de categoría
  const r = await raw("categorias/catA/partidos/pD/rendimientos/XYZ");
  if (!r || r.partido.categoriaNombre !== "Sub-15" || r.participante.nombres !== "Juan") throw new Error("Histórico alterado");
  await partidoRaw("catA", "p2", { entrenadorId: "coachB" });
  await assertFails(convocar("coachB", "catA", "p2"));                                  // ya no está en la nómina de A
});

// ---------- HU-014: Mi rendimiento (consulta del Jugador) ----------
const misRend = (uid, jug) => getDocs(query(collectionGroup(as(uid), "rendimientos"), where("jugadorId", "==", jug)));
async function prepararHU014() {
  await prepararHU013();
  await assertSucceeds(rendir("coachA", "catA", "pD"));
  await assertSucceeds(alinear("coachA", "catA", "pD", tit([slot("XYZ", 0.5, 0.3)])));
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "users/jugB"), { ...base("jugB", "Jugador", "Activo"), jugadorId: "OTRO" });
  });
  await partidoRaw("catA", "pN", { estado: "Disputado", fecha: diaCol(-2) });     // jugA NO convocado
}
test("HU-014 P1: el Jugador consulta SUS rendimientos con collectionGroup; nunca los de otro", async () => {
  await prepararHU014();
  const r = await assertSucceeds(misRend("jugA", "XYZ"));
  if (r.size !== 1 || r.docs[0].data().partido.rival !== "Halcones FC") throw new Error("Debía ver su rendimiento");
  await assertFails(misRend("jugA", "OTRO"));
  await assertFails(misRend("jugB", "XYZ"));
  await assertFails(getDocs(collectionGroup(as("jugA"), "rendimientos")));               // sin filtro
  await assertFails(misRend("coachA", "XYZ"));                                           // el entrenador lee por ruta (HU-013)
  await assertSucceeds(misRend("admin", "XYZ"));
  await assertFails(misRend("off", "XYZ"));
});
test("HU-014 P2: el Jugador lee partido, convocatoria, estadísticas y alineación SOLO de partidos donde fue convocado", async () => {
  await prepararHU014();
  await assertSucceeds(getDoc(pRef("jugA", "catA", "pD")));
  await assertSucceeds(getDocs(collection(as("jugA"), "categorias", "catA", "partidos", "pD", "participantes")));
  await assertSucceeds(getDocs(collection(as("jugA"), "categorias", "catA", "partidos", "pD", "rendimientos")));   // compañeros: decisión de la escuela
  await assertSucceeds(getDoc(pRef("jugA", "catA", "pD", "alineaciones", "principal")));
  await assertFails(getDoc(pRef("jugA", "catA", "pN")));                                 // no convocado
  await assertFails(getDocs(collection(as("jugA"), "categorias", "catA", "partidos", "pN", "rendimientos")));
  await assertFails(getDocs(collection(as("jugA"), "categorias", "catA", "partidos")));  // nunca lista los partidos de la escuela
  await assertFails(getDoc(pRef("jugB", "catA", "pD")));                                 // otro jugador no convocado
  await assertFails(getDoc(doc(as("jugA"), "jugadorFotos/OTRO")));                       // fotos ajenas: no
});
test("HU-014 P3: el Jugador NO modifica partidos, estadísticas, convocatoria ni alineación", async () => {
  await prepararHU014();
  await assertFails(updateDoc(pRef("jugA", "catA", "pD", "rendimientos", "XYZ"), { goles: 9, version: 2, updatedAt: serverTimestamp(), updatedBy: "jugA" }));
  await assertFails(updateDoc(pRef("jugA", "catA", "pD", "alineaciones", "principal"), { estado: "Borrador", version: 2, updatedAt: serverTimestamp(), updatedBy: "jugA" }));
  await assertFails(editar("jugA", "catA", "pD", { rival: "X" }, 2));
  await assertFails(updateDoc(pRef("jugA", "catA", "pD", "participantes", "XYZ"), { rolConvocatoria: "Titular", version: 3, updatedAt: serverTimestamp(), updatedBy: "jugA" }));
  await assertFails(deleteDoc(pRef("jugA", "catA", "pD", "participantes", "XYZ")));
  await assertFails(setDoc(pRef("jugA", "catA", "pX"), partido("jugA", "catA")));
});
test("HU-014 P4: tras cambiar de categoría conserva su historial; inactivo no consulta nada", async () => {
  await prepararHU014();
  await assertSucceeds(mover(as("admin"), "catB"));
  const r = await assertSucceeds(misRend("jugA", "XYZ"));
  if (r.size !== 1 || r.docs[0].data().partido.categoriaNombre !== "Sub-15") throw new Error("Historial perdido tras el traslado");
  await assertSucceeds(getDoc(pRef("jugA", "catA", "pD")));
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), "users/jugA"), { estado: "Inactivo" }));
  await assertFails(misRend("jugA", "XYZ"));
  await assertFails(getDoc(pRef("jugA", "catA", "pD")));
});

test("colecciones no declaradas: denegadas", async () => {
  await assertFails(getDoc(doc(as("admin"), "entrenamientos/x")));
  await assertFails(deleteDoc(doc(as("admin"), "users/admin")));
  await assertFails(deleteDoc(doc(as("admin"), "users/coach")));
});
