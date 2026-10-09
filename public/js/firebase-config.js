/* ==========================================================
   CanchaControl — Configuración de Firebase
   ----------------------------------------------------------
   Proyecto: canchacontrol-665f4
   (Firebase Console → ⚙ Configuración del proyecto → General → Tus apps)

   Este objeto NO es secreto (Firebase lo expone en el navegador
   por diseño). La seguridad real está en firestore.rules y en los
   dominios autorizados de Authentication.
   ========================================================== */

export const firebaseConfig = {
  apiKey:            "AIzaSyCUeDckLMA18cAs-Hy6nq83KK6RvAxHbWs",
  authDomain:        "canchacontrol-665f4.firebaseapp.com",
  projectId:         "canchacontrol-665f4",
  storageBucket:     "canchacontrol-665f4.firebasestorage.app",
  messagingSenderId: "218013575282",
  appId:             "1:218013575282:web:fc2f2047c6caa9d846faeb",
  measurementId:     "G-THH34W1JM2", // Analytics no se carga en el login (no hace falta)
};

/* ----------------------------------------------------------
   Microsoft (opcional):
   - "common"         → cuentas personales + de cualquier organización
   - "organizations"  → solo cuentas de trabajo/escuela (Entra ID)
   - "<TENANT_ID>"    → solo tu organización
   Debe coincidir con lo que elijas al registrar la app en Azure.
   ---------------------------------------------------------- */
export const MICROSOFT_TENANT = "common";

/* ----------------------------------------------------------
   Emuladores locales (solo para desarrollo/pruebas).
   Pon true y ejecuta:  firebase emulators:start
   NUNCA lo dejes en true en producción.
   ---------------------------------------------------------- */
export const USE_EMULATORS = false;
export const EMULATOR_HOSTS = {
  auth: "http://127.0.0.1:9099",
  firestore: { host: "127.0.0.1", port: 8080 },
};

/* Ruta a la que se envía al usuario tras validar el acceso. */
export const POST_LOGIN_URL = "dashboard.html";
export const LOGIN_URL = "login.html";

/** true cuando ya se reemplazaron los valores de ejemplo. */
export const isFirebaseConfigured = !Object.values(firebaseConfig)
  .some((v) => typeof v !== "string" || v.includes("PEGAR_AQUI"));
