# CanchaControl — Etapa 1: Login

Proyecto Firebase: **`canchacontrol-665f4`** · Administrador: **santiagotorresquintero10@gmail.com**

Flujo implementado:

```
Login (correo / Google / Microsoft)
  → Firebase Auth → UID
  → Firestore users/{uid} existe
  → estado == "Activo"
  → rol ∈ {Administrador, Entrenador, Jugador}
  → correo verificado (si entró con contraseña)        ← Opción B
  → dashboard.html (provisional)
Nadie puede crearse una cuenta por su cuenta            ← Opción A
```
Si cualquier paso falla: se cierra la sesión y se muestra un mensaje en español.

---

# PUESTA EN MARCHA (en este orden)

El código ya tiene la configuración de tu proyecto. Lo que sigue son pasos en consolas web que solo tú puedes hacer con tu cuenta.

## Paso 1 — Authentication: métodos de acceso
https://console.firebase.google.com/project/canchacontrol-665f4/authentication/providers

1. **Comenzar** (si aparece).
2. **Correo electrónico/contraseña** → habilitar **solo el primer interruptor** → Guardar.
3. **Agregar proveedor nuevo → Google** → Habilitar → correo de asistencia: `santiagotorresquintero10@gmail.com` → Guardar.
4. Microsoft: ver **Paso 8** (puede esperar).

## Paso 2 — Authentication: configuración
https://console.firebase.google.com/project/canchacontrol-665f4/authentication/settings

1. **Acciones de usuario** → **deja MARCADA "Habilitar creación (registro)"** → Guardar.
   Es necesario para que "Nuevo usuario" (HU-002) cree cuentas desde la app. Decisión tomada en HU-002:
   el acceso lo controla el perfil `users/{uid}` + las reglas, no la existencia de la cuenta.
2. **Vinculación de cuentas de usuario** → debe estar en **"Vincular cuentas que usan el mismo correo electrónico"** (es el valor por defecto).
3. **Protección contra la enumeración de correos** → déjala **activada**.
4. **Dominios autorizados** → ya deben estar `localhost`, `canchacontrol-665f4.firebaseapp.com` y `canchacontrol-665f4.web.app`.

**Qué significa en el día a día:** alguien podría crear una *identidad* en Firebase Authentication (con la API pública o entrando con Google), pero sin documento en `users` no entra a CanchaControl ni lee nada: verá *"No fue posible validar tu perfil de CanchaControl. Contacta con el administrador."* Si aparecen cuentas desconocidas en Authentication → Usuarios sin perfil en Firestore, puedes eliminarlas desde la consola.

## Paso 3 — Plantillas de correo
https://console.firebase.google.com/project/canchacontrol-665f4/authentication/emails

- Arriba, **idioma de la plantilla → Español**.
- En *Verificación de correo* y *Restablecimiento de contraseña* edita el **Nombre del remitente**: `CanchaControl`.

## Paso 4 — Crear Firestore
https://console.firebase.google.com/project/canchacontrol-665f4/firestore

**Crear base de datos** → Edición **Standard** → ID `(default)` → ubicación **`southamerica-east1` (São Paulo)** → **Iniciar en modo de producción** → Crear.
⚠ La ubicación no se puede cambiar después.

## Paso 5 — Publicar las reglas de seguridad
Firestore → pestaña **Reglas** → borra lo que haya → pega todo el contenido de `firestore.rules` → **Publicar**.

## Paso 6 — Crear tu cuenta de administrador
1. **Authentication → Usuarios → Agregar usuario**
   - Correo: `santiagotorresquintero10@gmail.com`
   - Contraseña: una fuerte (mínimo 8 caracteres; es la que usarás para entrar).
   - Copia el **UID** que aparece en la lista (columna "UID de usuario").
2. **Firestore → Datos → + Iniciar colección**
   - ID de la colección: `users`
   - ID del documento: **pega el UID** (no uses "ID automático").
   - Campos (respeta mayúsculas):

| campo | tipo | valor |
|---|---|---|
| uid | string | *(el UID)* |
| nombre | string | Santiago Torres |
| email | string | santiagotorresquintero10@gmail.com |
| rol | string | `Administrador` |
| estado | string | `Activo` |
| providers | array | *(vacío)* |
| createdAt | timestamp | hoy |
| updatedAt | timestamp | hoy |

3. **Primer ingreso** (elige uno):
   - **Con contraseña:** el login te dirá que verifiques el correo y te enviará el enlace. Ábrelo y vuelve a entrar. (Revisa spam.)
   - **Con Google:** entra con "Google" usando ese mismo Gmail. Firebase lo reconoce como tu cuenta (mismo UID, mismo perfil) y queda verificado.
     Nota: al ser un Gmail sin verificar, Firebase **quita la contraseña** de esa cuenta y quedas entrando con Google. Si quieres conservar ambas, entra primero con contraseña y verifica el correo.

## Paso 7 — Correr el login en tu PC (Windows)
1. Instala **Node.js LTS**: https://nodejs.org
2. Descomprime el proyecto, abre la carpeta `canchacontrol`, clic derecho → **Abrir en Terminal**, y ejecuta:
```powershell
npm install
npx firebase login
npm run serve
```
3. Abre **http://localhost:5000**. Esto usa tu Firebase REAL; solo el servidor web es local.

Para publicarlo en internet: ver **Paso 9 (Vercel)**.

> No abras `login.html` con doble clic: los módulos JavaScript no funcionan desde `file://`.

## Paso 8 — Microsoft (requiere registro en Azure)
1. En Firebase: **Authentication → Método de acceso → Agregar proveedor → Microsoft**. Deja esa ventana abierta. La URL de redirección es:
   `https://canchacontrol-665f4.firebaseapp.com/__/auth/handler`
2. En https://entra.microsoft.com → **Identidad → Aplicaciones → Registros de aplicaciones → Nuevo registro**:
   - Nombre: `CanchaControl`
   - Tipos de cuenta: **Cuentas de cualquier directorio organizativo y cuentas personales de Microsoft** (coincide con `MICROSOFT_TENANT = "common"` en `firebase-config.js`).
   - URI de redirección: plataforma **Web** → la URL del punto 1.
3. Copia el **Id. de aplicación (cliente)**.
4. **Certificados y secretos → Nuevo secreto de cliente** → descripción `firebase`, caducidad **24 meses** → copia el **Valor** (no el "Id. de secreto"; solo se muestra una vez).
   ⚠ Pon un recordatorio en tu calendario: cuando caduque, Microsoft dejará de funcionar hasta que generes otro y lo pegues en Firebase.
5. **Permisos de API**: deja `Microsoft Graph → User.Read` (viene por defecto).
6. Vuelve a Firebase, pega **ID de aplicación** y **Secreto de la aplicación** → Guardar.

Si no tienes cuenta de Microsoft/Azure, se crea gratis con cualquier correo en entra.microsoft.com.

## Paso 9 — Publicar en Vercel
Vercel solo sirve la carpeta `public` (configurado en `vercel.json`). Firebase sigue siendo el backend: Authentication y Firestore no cambian.

**Primera vez:**
1. Crea una cuenta gratis en https://vercel.com (puedes entrar con GitHub, Google o correo).
2. En la terminal, dentro de la carpeta del proyecto:
```powershell
npm install
npx vercel login
npx vercel --prod
```
3. Responde las preguntas:
   - *Set up and deploy?* → `Y`
   - *Which scope?* → tu cuenta (Enter)
   - *Link to existing project?* → `N`
   - *What's your project's name?* → `canchacontrol`
   - *In which directory is your code located?* → `./` (Enter)
   - *Want to modify these settings?* → `N` (ya están en `vercel.json`)
4. Al final muestra la URL de producción, por ejemplo `https://canchacontrol-five.vercel.app`. Si el nombre está ocupado, Vercel agrega un sufijo; usa la URL que te muestre.

**Obligatorio después del primer deploy, o Google dará "sitio no autorizado":**
- Firebase → **Authentication → Configuración → Dominios autorizados → Agregar dominio** → `canchacontrol-five.vercel.app` (sin `https://` ni `/` final; usa tu dominio exacto).
- Si restringiste la apiKey (sección Seguridad), agrega también `https://canchacontrol-five.vercel.app/*`.

**Siguientes publicaciones:**
```powershell
npm run deploy          # = vercel --prod
```
⚠ Usa siempre `--prod` (o `npm run deploy`). Un `npx vercel` sin `--prod` crea una URL de prueba distinta cada vez, que no estará autorizada en Firebase y el botón de Google fallará allí.

**Reglas de Firestore:** Vercel no las publica. Cuando cambien:
```powershell
npm run deploy:rules
```
(o pégalas a mano en Firestore → Reglas).

**Plan gratuito de Vercel (Hobby):** es solo para uso **no comercial**. Si CanchaControl se cobra a clubes, necesitas el plan Pro o publicar en Firebase Hosting (gratis también para uso comercial: `npx firebase deploy --only hosting`).

---

# Sistema visual oficial (desde HU-004)
Toda página privada usa el MISMO layout y componentes:
- `css/app.css` — sidebar, header, page header, KPI cards, toolbar, tabla, badges, botones de acción, drawer, inputs, radio cards, alertas, skeleton, estado vacío, paginación.
- `js/shell.js` — `mountShell(perfil, "pagina")` pinta sidebar + header con datos reales, **después** de que `protectPage` autoriza.
- El menú sale de `NAV` en `permissions.js`: cada rol ve solo los módulos que ya existen y a los que tiene acceso.

Plantilla de una página nueva: copia `categorias.html` (estructura `#app` → `data-shell-sidebar` → `.app-main` → `data-shell-header` → `main.page`) y en su JS:
```js
protectPage({ page: "<clave>", onReady(p) { mountShell(p, "<clave>"); /* módulo */ } });
```

# Categorías (HU-004)
`categorias.html` (solo Administrador por ahora). Crear categoría por **rango de edad** o **año(s) de nacimiento** y **período lectivo** (formato `AAAA-AAAA`, calendario B; opciones generadas desde el año actual). Nombre y código únicos (sin importar mayúsculas, tildes ni espacios), garantizado en la base con `categoriaClaves`. Toda categoría nueva nace **Activa** y con `entrenadorId = null` (HU-005 lo asignará).

**Después de actualizar: publica `firestore.rules`** (incluye las reglas de `categorias` y `categoriaClaves`; sin ellas la pantalla no carga).

# Entrenador principal de una categoría (HU-005)
En **Categorías**, botón de acción 👤+ (**Asignar / Cambiar entrenador**). Solo aparecen usuarios con rol **Entrenador** y estado **Activo**. Se guarda el **UID** en `categorias/{id}.entrenadorId` (0 o 1 entrenador por categoría; un entrenador puede tener varias). Reemplazar pide confirmación. Si el entrenador asignado se inactiva o cambia de rol, la asignación **no se borra**: queda marcada en rojo para que el Administrador la reasigne.

Seguridad (en `firestore.rules`, no solo en pantalla): solo el Administrador cambia `entrenadorId`, y solo hacia un Entrenador activo; un Entrenador solo puede **leer** las categorías donde `entrenadorId == su UID` (consulta filtrada obligatoria). Entrenador y Jugador no pueden escribir.

**Después de actualizar: publica `firestore.rules`** (sin ellas "Guardar asignación" responde "No tienes permisos").

# Mi rendimiento — Jugador (HU-014)
- Menú del Jugador "Mi rendimiento" (`rendimiento.html`), solo lectura: tarjeta 3D (HU-011/012), personaje motivacional "Chispa" (SVG original, sin audio), estadísticas, valoración promedio, gráficos, historial, detalle, alineaciones e hitos.
- Datos: los rendimientos de HU-013 con UNA consulta `collectionGroup('rendimientos')` filtrada por su `jugadorId` (las reglas la validan contra `users/{uid}.jugadorId`). El detalle de un partido se lee solo al abrirlo.
- Partidos jugados = rendimientos con minutos > 0. Promedio = suma de valoraciones válidas ÷ partidos calificados (los no calificados no cuentan como 0).
- Decisión de la escuela: en los partidos donde fue convocado, el Jugador ve la convocatoria, la alineación y las estadísticas de TODOS sus compañeros (no sus fotos ni expedientes).
- Celebraciones: solo hitos reales (primer partido, primer gol, primera asistencia, mejor valoración, más goles en un partido). Cada hito se celebra una vez por dispositivo (se guardan solo sus identificadores en localStorage).
- **Antes de usarla:** `firebase deploy --only firestore:rules,firestore:indexes` (índice `rendimientos · jugadorId · grupo de colecciones`). Sin el índice la consulta falla con `failed-precondition` (la consola muestra el enlace para crearlo).

# Partidos, rendimiento y alineación (HU-013)
- Menú "Partidos y rendimiento" (`partidos.html`): Administrador (solo lectura) y Entrenador (gestiona SUS categorías). El Jugador consulta lo suyo en "Mi rendimiento" (HU-014).
- Pestañas: **Partidos** (crear/editar, filtros Total/Programados/Disputados/Cancelados, convocatoria), **Rendimiento** (estadísticas por jugador e indicadores con filtros) y **Alineación** (cancha táctica libre, x/y normalizados 0–1).
- Formato por partido (F5/F7/F9/F11) → máximo de titulares 5/7/9/11; la alineación se guarda como borrador o "Completa".
- Valoración opcional 1–10 con un decimal (acepta coma); el promedio excluye a los no valorados. Corrección hasta 30 días después del partido.
- Un partido con estadísticas no sale de "Disputado"; nunca se borran partidos ni rendimientos.
- Datos: `categorias/{cat}/partidos/{pid}` + `participantes/{jugadorId}`, `rendimientos/{jugadorId}`, `alineaciones/principal`. Cada rendimiento guarda una copia del partido y del jugador → el histórico sobrevive a cambios de categoría o entrenador.
- **Publica `firestore.rules`** antes de usar el módulo.

# Historial y porcentaje de asistencia (HU-012)
- Jugador: menú "Mi asistencia" (`historial.html`). Entrenador: desde Mis jugadores → "Historial" / "Ver historial de asistencia" (`historial.html?jugador=…&cat=…`). Solo lectura.
- Porcentaje (regla aprobada): (Asistió + Atraso) ÷ (Asistió + Atraso + Falta). Excusas fuera del cálculo; sin registros evaluables → "Sin datos suficientes".
- Jugador: una consulta `collectionGroup('asistencias')` filtrada por su `jugadorId` (las reglas la validan contra `users/{uid}.jugadorId`). Requiere el índice de `firestore.indexes.json` → `firebase deploy --only firestore:indexes`.
- Entrenador: solo sesiones de SUS categorías (lee por ruta, regla de HU-011).
- Desde HU-012 cada registro de asistencia guarda una copia inmutable de su sesión (`sesion`: fecha, horario, lugar, categoría de ese día) → el historial sobrevive a cambios de categoría.

# Asistencia por sesión (HU-011)
- Se abre desde Entrenamientos → detalle de la sesión → "Registrar asistencia" / "Ver / Editar asistencia" (`asistencia.html?cat=…&ses=…`).
- Registros en `categorias/{cat}/entrenamientos/{ses}/asistencias/{jugadorId}` (uno por jugador; ID = jugadorId → sin duplicados).
- Estados: Asistió, Falta, Excusa, Atraso. "Pendiente" nunca se guarda; no se puede guardar con pendientes.
- Ventana: desde el día de la sesión hasta 7 días después (hora Colombia). Fuera de ella: solo lectura. Lo exigen las reglas.
- Solo el Entrenador actual de la categoría registra/corrige; el Administrador solo consulta; el Jugador no accede.
- Historial: el primer guardado congela los participantes (nómina activa de ese día) con una copia mínima (nombre, dorsal, posición). Si el jugador cambia de categoría, su registro se conserva y se puede corregir dentro de la ventana.
- Concurrencia: cada registro lleva `version`; el guardado es transaccional y las reglas exigen version+1 (nadie sobrescribe a ciegas).
- Tarjetas 3D: `js/player-card.js` (`createPlayer3DCard`) + `css/asistencia.css`. Diseño original (sin activos de terceros).

# Entrenamientos y dashboard por rol (HU-010)
- Sesiones en `categorias/{categoriaId}/entrenamientos/{fecha_HHMM}` (una por categoría, nunca por jugador). El ID determinista evita duplicados aunque se haga doble clic o se envíe desde dos pestañas; HU-011 (asistencia) lo usará como referencia.
- **Solo el Entrenador** programa, y solo en categorías **activas** cuyo entrenador actual es él; fecha no pasada (hora Colombia), fin > inicio, lugar obligatorio, estado siempre `Programada`. Editar/cancelar: no existe aún.
- Lectura: Administrador todas; Entrenador las de sus categorías; Jugador las de **su** categoría (cadena `users.jugadorId → jugadores.categoriaId`).
- Desde HU-010 el Jugador puede leer **su propio** expediente, **su** categoría y el perfil del entrenador de su categoría (incluye el correo del entrenador).
- Las tarjetas del Inicio son informativas; en Usuarios, Jugadores, Categorías y Entrenamientos las tarjetas son filtros (clic = filtrar, segundo clic = Total).
- El cruce de horarios entre sesiones se valida en el navegador antes de guardar (las reglas no pueden consultar otras sesiones).

# Mis jugadores — Entrenador (HU-009)
`jugadores.html` con rol Entrenador muestra **Mis jugadores**: selector con SUS categorías (`where entrenadorId == su UID`), nómina, buscador por nombre y **Ver ficha** (solo lectura).
- **El Entrenador nunca lee el expediente** (`jugadores/{id}`): las reglas de Firestore autorizan documentos, no campos. Lee una **ficha deportiva** en `categorias/{categoriaId}/nomina/{jugadorId}` con solo la lista blanca aprobada: nombres, apellidos, tipo y número de documento, fecha de nacimiento, género, posición, camiseta y estado (+ la foto, solo por ID y solo si el jugador está hoy en su categoría). Nunca contacto, dirección, emergencia ni observaciones.
- Diseño: selector de temporada y de categoría, contador, tabla con foto y botón **Ver ficha** → página de ficha (`#/ficha/{categoria}/{jugador}`) con pestañas Información general / Información deportiva. El menú del Entrenador dice **Mis jugadores** y **Mis categorías**.
- La ficha se escribe en la **misma operación** que el expediente (editar, asignar, trasladar) y las reglas exigen que sea idéntica: no puede desincronizarse. Al abrir Jugadores, el Administrador completa automáticamente las fichas de jugadores vinculados antes de HU-009.
- Acceso: la regla lee `categorias/{id}.entrenadorId` en el momento: traslados y cambios de entrenador revocan el acceso al instante.
- Índices: no se necesitan.

# Jugador → Categoría (HU-008)
En **Jugadores**, acción **Asignar / Cambiar categoría** (panel lateral). Solo categorías **Activas** como opción; cambiar pide confirmación.
- Fuente única: `jugadores/{id}.categoriaId` (una categoría actual por jugador). La nómina NO se guarda en la categoría: se consulta `where("categoriaId","==",id)`.
- El entrenador NO se copia al expediente: se lee de `categorias/{id}.entrenadorId` cuando se necesita.
- Categorías → columna **Jugadores** con conteo real (agregación `count()` de Firestore) y **Nómina** en el detalle (solo Administrador).
- Reglas: solo el Administrador cambia `categoriaId`, solo hacia una categoría existente y Activa, sin tocar ningún otro dato.
- Índices: no se necesitan índices compuestos (consultas de igualdad sobre un solo campo).

# Expedientes de jugadores (HU-007)
Flujo: **Usuarios** → crear cuenta con rol *Jugador* → **Jugadores** → **+ Nuevo jugador** → elegir esa cuenta → completar 4 pasos (Cuenta y datos · Contacto · Emergencia · Deportiva).
- Jugadores **no crea cuentas** ni pide contraseñas.
- Relación por UID en ambos sentidos: `jugadores/{id}.userId = UID` y `users/{UID}.jugadorId = id`, escritas en la misma transacción.
- 1 cuenta ↔ 1 expediente y documento único (`jugadorClaves`), garantizados por `firestore.rules`.
- Una cuenta con expediente no puede cambiar de rol en Usuarios (primero hay que resolver la vinculación). Inactivarla no borra el expediente.
- Solo el Administrador ve y edita expedientes. `categoriaId` queda en `null` para HU-008.
- Diseño: listado → página **Nuevo jugador** (4 pasos con confirmación) → página **Expediente** (`jugadores.html#/jugador/ID`). La URL no da acceso: las reglas solo dejan leer al Administrador.
- **Foto sin costo:** se reduce en el navegador a 256×256 JPEG y se guarda en base64 en `jugadorFotos/{id}` (documento aparte, máx. ~280 KB). No usa Firebase Storage (que exige plan Blaze).

**Publica `firestore.rules`** después de actualizar.

# Consulta de categorías por rol (HU-006)
Una sola pantalla `categorias.html`, misma interfaz, dos alcances:
- **Administrador** → "Categorías deportivas": todas las categorías, columna Entrenador ("Sin asignar" si no tiene), columna Jugadores ("—" hasta que exista la gestión de jugadores), acciones HU-004/HU-005.
- **Entrenador** → "Mis categorías": Firestore le entrega **solo** las categorías con `entrenadorId == su UID` (`where` en la consulta; la identidad sale de `auth.currentUser.uid`). Solo lectura: sin crear, sin asignar. KPI, búsqueda y filtros calculados únicamente con sus datos. Si el Administrador le reasigna o le quita un grupo, su lista cambia en vivo.
- **Jugador** → sin acceso.

**Publica `firestore.rules`** después de actualizar.

## Pruebas automáticas de seguridad en GitHub (sin instalar Java)
El archivo `.github/workflows/rules-tests.yml` hace que GitHub ejecute las pruebas de `firestore.rules` (incluido el aislamiento Entrenador A / B) en cada subida. Mira el resultado en tu repositorio → pestaña **Actions** → "Pruebas de reglas": ✅ verde = aprobadas, ❌ rojo = algo falla (abre el detalle y cópialo aquí). Costo $0.
> Si subes los archivos arrastrándolos en la web de GitHub, sube también la carpeta `.github` (en Windows/Mac puede estar oculta: actívala en "Mostrar archivos ocultos").

# Gestión de usuarios (HU-002)
Inicio → **Gestión de usuarios** (solo Administrador) → `usuarios.html`.
- Listado con indicadores, búsqueda (nombre/correo, sin importar mayúsculas ni tildes) y filtros por rol y estado.
- **Nuevo usuario** crea la cuenta en Firebase Authentication **y** su perfil en `users/{uid}`, y le envía el correo de verificación.
- **⋮ → Editar**: nombre, rol, estado. El correo es de solo lectura (debe coincidir con Authentication).
- **⋮ → Inactivar / Activar** con confirmación. No hay eliminación.
- Nadie puede cambiar su propio rol ni estado; por eso CanchaControl nunca queda sin Administrador activo.

⚠ **Requisito para "Nuevo usuario":** "Habilitar creación (registro)" debe estar **marcada** (Paso 2). Si alguien la desmarca, la pantalla lo explica y no crea nada.

**Después de actualizar a HU-002 hay que publicar las reglas nuevas** (Firestore → Reglas → pegar `firestore.rules` → Publicar). Sin ellas el listado no carga.

# Cómo dar acceso a otra persona desde la consola (alternativa manual)

1. **Authentication → Usuarios → Agregar usuario** con su correo y una contraseña temporal. Copia el UID.
2. **Firestore → users → Agregar documento** con ID = ese UID y los mismos campos de la tabla (rol `Entrenador` o `Jugador`).
3. Pásale su correo y la contraseña temporal. En su primer ingreso le llegará el enlace de verificación. Que cambie la contraseña con "¿Olvidaste tu contraseña?".
4. Si prefiere Google o Microsoft:
   - **Google con Gmail:** solo debe pulsar "Google".
   - **Microsoft, u otro correo con Google:** el login le pedirá entrar una vez con su contraseña para vincular la cuenta externa.

**Desactivar a alguien:** cambia su `estado` a `Inactivo` en Firestore. Queda fuera en su siguiente acción, aunque tenga la sesión abierta.

---

# Referencia

## Estructura
```
firebase.json · .firebaserc · firestore.rules · firestore.indexes.json · package.json · vercel.json · .vercelignore
tests/firestore.rules.test.js        ← pruebas de reglas (npm run test:rules, requiere Java; o GitHub Actions)
.github/workflows/rules-tests.yml    ← corre esas pruebas en GitHub en cada push
public/
  index.html (→ login)  login.html  dashboard.html  usuarios.html  jugadores.html  categorias.html  entrenamientos.html  asistencia.html  historial.html  partidos.html  rendimiento.html
  css/ variables.css global.css login.css app.css usuarios.css jugadores.css categorias.css entrenamientos.css dashboard.css asistencia.css historial.css partidos.css pitch.css rendimiento.css
  js/  firebase-config.js auth.js login.js dashboard.js ui.js
       authGuard.js     ← protege páginas privadas (HU-003)
       users.js         ← datos de usuarios: listar, crear, editar (HU-002)
       usuarios.js      ← pantalla Gestión de usuarios (HU-002)
       shell.js         ← sidebar + header oficiales (HU-004)
       jugadores-data.js / jugadores.js ← Expedientes de jugadores (HU-007/008)
       mis-jugadores.js ← vista Entrenador "Mis jugadores" (HU-009)
       categorias-data.js / categorias.js ← Categorías (HU-004) + entrenador principal (HU-005) + vista por rol (HU-006)
       dashboard.js     ← Inicio por rol: Panel de control / Mi panel deportivo / Mi espacio deportivo (HU-010)
       entrenamientos-data.js / entrenamientos.js ← Programación de entrenamientos (HU-010)
       asistencia-data.js / asistencia.js / player-card.js ← Asistencia + tarjetas 3D (HU-011)
       historial-data.js / historial.js ← Historial y % de asistencia (HU-012)
       partidos-data.js / partidos.js / pitch.js ← Partidos, rendimiento y alineación táctica (HU-013)
       rendimiento-data.js / rendimiento.js / mascota.js ← Mi rendimiento del Jugador (HU-014)
       calendar.js      ← calendario mensual (HU-010) · mi-jugador.js ← contexto del Jugador (HU-010)
       permissions.js   ← roles, páginas por rol y alcance de datos (HU-003)
  assets/img/ logo.svg cancha.jpg   (+ firebase-logo.svg opcional, ver LEEME.txt)
```

## Seguridad de páginas (HU-003)
Toda página privada nueva se protege así (nunca copiando lógica):
```js
import { protectPage } from "./authGuard.js";
protectPage({ page: "dashboard", onReady: (perfil) => { /* pintar */ } });
// o: protectPage({ allowedRoles: ["Administrador"], onReady })
```
- El HTML de la página debe tener `#boot-loader` y su contenido dentro de un elemento `data-private hidden`, **sin datos escritos**.
- Para agregar una página: regístrala en `PAGES` de `permissions.js` y crea su regla en `firestore.rules`.
- Antes de cada módulo nuevo, responder las 7 preguntas: ¿quién es?, ¿qué rol?, ¿activo?, ¿puede entrar?, ¿el registro le corresponde?, ¿qué acción?, ¿las reglas lo permiten?

## Verificación de correo (Opción B)
- Quien entra con **contraseña** necesita el correo verificado. Si no lo está, no entra: se le envía el enlace automáticamente, como máximo uno cada 5 minutos.
- Google entrega correos verificados. Con Microsoft no se exige, porque Microsoft no siempre lo informa y la identidad ya la garantiza su cuenta.
- `firestore.rules` aplica el mismo criterio: no se puede saltar desde el navegador.

## Seguridad adicional recomendada (5 min)
La `apiKey` es pública por diseño, pero conviene limitarla a tus dominios:
Google Cloud Console → *APIs y servicios → Credenciales* → la clave "Browser key (auto created by Firebase)" → **Restricciones de aplicaciones: Sitios web** → agrega:
`http://localhost:5000/*`, `https://canchacontrol-665f4.firebaseapp.com/*` y tu dominio de Vercel (`https://canchacontrol-five.vercel.app/*`).

## Pruebas de reglas
```powershell
npm run test:rules
```
Requiere **Java 11+**. Córrelas antes de cada `deploy` que cambie `firestore.rules`.
