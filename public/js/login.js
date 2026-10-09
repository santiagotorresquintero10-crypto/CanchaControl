/* ==========================================================
   CanchaControl — Lógica de la pantalla de login
   ========================================================== */
import {
  auth,
  isReady,
  applyPersistence,
  verifyAccess,
  recordLogin,
  loginWithEmail,
  loginWithProvider,
  credentialFromError,
  linkCredential,
  requestPasswordReset,
  friendlyAuthError,
  isValidEmail,
  AccessError,
  MESSAGES,
  PROVIDER_LABELS,
} from "./auth.js";
import { LOGIN_URL } from "./firebase-config.js";
import { homeFor } from "./permissions.js";
import { toast, takeFlash, hideBootLoader } from "./ui.js";

/* ---------------- Referencias DOM ---------------- */
const $ = (id) => document.getElementById(id);
const formWrap   = $("form-wrap");
const form       = $("login-form");
const emailEl    = $("email");
const passEl     = $("password");
const rememberEl = $("remember");
const loginBtn   = $("login-btn");
const googleBtn  = $("google-btn");
const msBtn      = $("microsoft-btn");
const toggleBtn  = $("toggle-password");
const forgotLink = $("forgot-link");
const alertBox   = $("form-alert");
const alertText  = $("form-alert-text");

const modal       = $("reset-modal");
const resetForm   = $("reset-form");
const resetEmail  = $("reset-email");
const resetBtn    = $("reset-btn");
const viewForm    = $("reset-view-form");
const viewDone    = $("reset-view-done");

/* ---------------- Estado ---------------- */
let busy = false;              // evita solicitudes duplicadas (doble clic)
let pendingLink = null;        // { credential, providerId, email } — SOLO en memoria
const original = new Map();    // contenido original de botones con loader

/* ==========================================================
   Arranque: ¿ya hay sesión válida?
   ========================================================== */
init();

async function init() {
  wireUi();

  const flash = takeFlash();

  if (!isReady) {
    hideBootLoader();
    showAlert("error", "Firebase aún no está configurado. Completa js/firebase-config.js con los datos de tu proyecto.");
    setFormDisabled(true);
    return;
  }

  try {
    await auth.authStateReady();
    const user = auth.currentUser;
    if (user) {
      const profile = await verifyAccess(user); // cierra sesión si no está autorizado
      redirectToApp(profile, { silent: true });
      return;
    }
  } catch (err) {
    const msg = friendlyAuthError(err) ?? MESSAGES.generic;
    showAlert(err?.code === "inactive" ? "warning" : err?.code === "unverified" ? "info" : "error", msg);
  }

  // Solo SIN sesión activa: aplicar persistencia antes de cualquier clic
  // (los popups OAuth deben abrirse de inmediato para no ser bloqueados).
  // Hacerlo con una sesión abierta la migraría y cerraría otras pestañas.
  await applyPersistence(rememberEl.checked).catch(() => {});

  hideBootLoader();
  if (flash?.message) {
    if (flash.type === "info") toast("info", flash.message);
    else showAlert(flash.type === "warning" ? "warning" : "error", flash.message);
  }
  emailEl.focus({ preventScroll: true });
}

/* ==========================================================
   Eventos
   ========================================================== */
function wireUi() {
  form.addEventListener("submit", onEmailSubmit);
  googleBtn.addEventListener("click", () => onProviderClick("google.com", googleBtn));
  msBtn.addEventListener("click", () => onProviderClick("microsoft.com", msBtn));

  rememberEl.addEventListener("change", () => {
    if (isReady) applyPersistence(rememberEl.checked).catch(() => {});
  });

  // Mostrar / ocultar contraseña sin alterar el valor ni perder el cursor
  toggleBtn.addEventListener("click", () => {
    const show = passEl.type === "password";
    const { selectionStart, selectionEnd } = passEl;
    passEl.type = show ? "text" : "password";
    toggleBtn.setAttribute("aria-pressed", String(show));
    toggleBtn.setAttribute("aria-label", show ? "Ocultar contraseña" : "Mostrar contraseña");
    passEl.focus({ preventScroll: true });
    try { passEl.setSelectionRange(selectionStart, selectionEnd); } catch { /* algunos navegadores */ }
  });

  // Limpia el error de un campo cuando el usuario lo corrige
  emailEl.addEventListener("input", () => clearFieldError("email"));
  passEl.addEventListener("input", () => clearFieldError("password"));
  emailEl.addEventListener("blur", () => {
    const v = emailEl.value.trim();
    if (v && !isValidEmail(v)) setFieldError("email", "Ingresa un correo electrónico válido.");
  });

  forgotLink.addEventListener("click", openResetModal);
  resetForm.addEventListener("submit", onResetSubmit);
  resetEmail.addEventListener("input", () => clearFieldError("reset-email"));
  modal.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", closeResetModal));
  modal.addEventListener("keydown", onModalKeydown);

  window.addEventListener("offline", () => toast("warning", MESSAGES.network));

  $("access-link").addEventListener("click", () =>
    toast("info", "Las cuentas de CanchaControl las crea el administrador de tu club. Pídele que te dé acceso con tu correo.")
  );
  const year = $("year");
  if (year) year.textContent = String(new Date().getFullYear());
}

/* ---------------- Correo + contraseña ---------------- */
async function onEmailSubmit(e) {
  e.preventDefault();
  if (busy) return;
  hideAlert();

  const email = emailEl.value.trim();
  const password = passEl.value;
  let ok = true;

  if (!email) { setFieldError("email", "Ingresa tu correo electrónico."); ok = false; }
  else if (!isValidEmail(email)) { setFieldError("email", "Ingresa un correo electrónico válido."); ok = false; }
  if (!password) { setFieldError("password", "Ingresa tu contraseña."); ok = false; }

  if (!ok) {
    (form.querySelector(".has-error input"))?.focus();
    return;
  }
  if (!navigator.onLine) { showAlert("error", MESSAGES.network); return; }

  setBusy(true, loginBtn, "Iniciando sesión…");
  try {
    await applyPersistence(rememberEl.checked);
    const { user } = await loginWithEmail(email, password);
    await completeLogin(user);
  } catch (err) {
    handleLoginError(err);
    if (!(err instanceof AccessError)) {
      passEl.value = "";
      if (err?.code !== "auth/too-many-requests") setFieldError("password", " ");
    } else if (err.code === "unverified") {
      passEl.value = ""; // volverá a entrar tras verificar; sin marcarlo como error
    }
    setBusy(false);
    passEl.focus();
  }
}

/* ---------------- Google / Microsoft ---------------- */
function onProviderClick(providerId, btn) {
  if (busy) return;
  hideAlert();
  if (!navigator.onLine) { showAlert("error", MESSAGES.network); return; }

  // IMPORTANTE: signInWithPopup se invoca en el mismo tick del clic.
  const popupPromise = loginWithProvider(providerId);
  setBusy(true, btn, "Conectando…");

  popupPromise
    .then(({ user }) => completeLogin(user))
    .catch((err) => {
      if (err?.code === "auth/account-exists-with-different-credential") {
        prepareAccountLink(providerId, err);
      } else {
        handleLoginError(err);
      }
      setBusy(false);
    });
}

/**
 * El correo ya pertenece a una cuenta CanchaControl con otro método.
 * NO fusionamos por coincidencia de email: el usuario debe probar que
 * es dueño de la cuenta existente iniciando sesión con su método habitual.
 * Después vinculamos el nuevo proveedor al MISMO UID.
 */
function prepareAccountLink(providerId, err) {
  const credential = credentialFromError(providerId, err);
  const email = err?.customData?.email || "";
  if (!credential || !email) {
    showAlert("error", MESSAGES.generic);
    return;
  }
  pendingLink = { credential, providerId, email: email.toLowerCase() };
  emailEl.value = email;
  clearFieldError("email");
  const label = PROVIDER_LABELS[providerId];
  showAlert(
    "info",
    `Ya existe una cuenta de CanchaControl con ${email}. Inicia sesión con tu método habitual (correo y contraseña u otro proveedor) y vincularemos ${label} a esa misma cuenta.`
  );
  toast("info", `Inicia sesión con tu método habitual para vincular ${label}.`);
  passEl.focus();
}

/* ---------------- Paso común: autorización ---------------- */
async function completeLogin(user) {
  // 1) Autorización: perfil, estado y rol desde Firestore
  const profile = await verifyAccess(user);

  // 2) Vinculación pendiente (solo si es la MISMA cuenta que se intentó)
  if (pendingLink) {
    const { credential, providerId, email } = pendingLink;
    pendingLink = null;
    if ((user.email || "").toLowerCase() === email) {
      try {
        await linkCredential(user, credential);
        toast("success", `${PROVIDER_LABELS[providerId]} quedó vinculado a tu cuenta.`);
      } catch (err) {
        if (err?.code !== "auth/provider-already-linked") {
          console.warn("[CanchaControl] Vinculación fallida:", err?.code || err);
          toast("warning", friendlyAuthError(err) ?? "No fue posible vincular la cuenta externa.");
        }
      }
    } else {
      toast("warning", "La cuenta externa no se vinculó porque el correo no coincide.");
    }
  }

  // 3) Registrar acceso (no bloqueante)
  await recordLogin(user);

  redirectToApp(profile);
}

function redirectToApp(profile, { silent = false } = {}) {
  if (!silent) toast("success", "Sesión iniciada correctamente.");
  // Pequeña pausa para que se perciba la confirmación; el formulario sigue bloqueado.
  // Destino según el rol leído de Firestore (nunca del navegador).
  setTimeout(() => window.location.replace(homeFor(profile.rol)), silent ? 0 : 650);
}

function handleLoginError(err) {
  console.error("[CanchaControl] Login:", err?.code || err);
  const msg = friendlyAuthError(err);
  if (!msg) return; // el usuario cerró el popup: no es un error

  if (err instanceof AccessError && err.code === "unverified") {
    showAlert("info", msg);
    toast("warning", "Verifica tu correo para continuar.");
    return;
  }

  if (err instanceof AccessError && err.code === "inactive") {
    showAlert("warning", msg);
    toast("warning", "Tu cuenta está inactiva.");
    return;
  }
  showAlert("error", msg);
  toast("error", "No fue posible iniciar sesión.");
}

/* ==========================================================
   Recuperar contraseña (modal)
   ========================================================== */
let lastFocus = null;
let resetBusy = false;

function openResetModal() {
  if (busy) return;
  lastFocus = document.activeElement;
  viewForm.hidden = false;
  viewDone.hidden = true;
  clearFieldError("reset-email");
  const current = emailEl.value.trim();
  resetEmail.value = isValidEmail(current) ? current : "";

  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  setBackgroundInert(true);
  setTimeout(() => resetEmail.focus(), 60);
}

function closeResetModal() {
  if (resetBusy) return;
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  setBackgroundInert(false);
  lastFocus?.focus?.();
}

function setBackgroundInert(on) {
  document.querySelector("main.auth")?.toggleAttribute("inert", on);
}

function onModalKeydown(e) {
  if (e.key === "Escape") { e.preventDefault(); closeResetModal(); return; }
  if (e.key !== "Tab") return;
  // Mantener el foco dentro del modal
  const focusables = [...modal.querySelectorAll("button, input, [tabindex]:not([tabindex='-1'])")]
    .filter((el) => !el.disabled && el.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

async function onResetSubmit(e) {
  e.preventDefault();
  if (resetBusy) return;
  const email = resetEmail.value.trim();
  if (!email) { setFieldError("reset-email", "Ingresa tu correo electrónico."); resetEmail.focus(); return; }
  if (!isValidEmail(email)) { setFieldError("reset-email", "Ingresa un correo electrónico válido."); resetEmail.focus(); return; }
  if (!navigator.onLine) { setFieldError("reset-email", MESSAGES.network); return; }

  resetBusy = true;
  setButtonLoading(resetBtn, true, "Enviando…");
  resetEmail.disabled = true;
  try {
    const continueUrl = new URL(LOGIN_URL, window.location.href).href;
    await requestPasswordReset(email, continueUrl);
    showResetDone();
  } catch (err) {
    console.error("[CanchaControl] Reset:", err?.code || err);
    if (err?.code === "auth/user-not-found") {
      showResetDone(); // no revelar si el correo existe
    } else if (err?.code === "auth/invalid-email") {
      setFieldError("reset-email", "Ingresa un correo electrónico válido.");
    } else if (err?.code === "auth/too-many-requests") {
      setFieldError("reset-email", "Demasiadas solicitudes. Espera unos minutos e intenta nuevamente.");
    } else if (err?.code === "auth/network-request-failed") {
      setFieldError("reset-email", MESSAGES.network);
    } else {
      setFieldError("reset-email", "No fue posible enviar las instrucciones. Intenta nuevamente.");
    }
  } finally {
    resetBusy = false;
    setButtonLoading(resetBtn, false);
    resetEmail.disabled = false;
  }
}

function showResetDone() {
  viewForm.hidden = true;
  viewDone.hidden = false;
  $("reset-done-title").focus();
}

/* ==========================================================
   Helpers de UI
   ========================================================== */
function setFieldError(id, message) {
  const input = $(id);
  const field = input.closest(".field");
  field.classList.add("has-error");
  input.setAttribute("aria-invalid", "true");
  $(`${id}-error`).textContent = message.trim();
}

function clearFieldError(id) {
  const input = $(id);
  input.closest(".field").classList.remove("has-error");
  input.setAttribute("aria-invalid", "false");
  $(`${id}-error`).textContent = "";
}

function showAlert(type, message) {
  alertBox.className = `form-alert form-alert--${type}`;
  alertBox.setAttribute("role", type === "info" ? "status" : "alert");
  alertText.textContent = message;
  alertBox.hidden = false;
}

function hideAlert() {
  alertBox.hidden = true;
  alertText.textContent = "";
}

function setButtonLoading(btn, loading, text) {
  if (loading) {
    if (!original.has(btn)) original.set(btn, btn.innerHTML);
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${text}</span>`;
  } else if (original.has(btn)) {
    btn.innerHTML = original.get(btn);
    original.delete(btn);
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
  }
}

/** Bloquea todo el formulario mientras Firebase / Firestore validan. */
function setBusy(on, activeBtn, text) {
  busy = on;
  formWrap.setAttribute("aria-busy", String(on));
  [emailEl, passEl, rememberEl, toggleBtn, forgotLink, loginBtn, googleBtn, msBtn].forEach((el) => {
    if (on) el.disabled = true;
  });
  if (on) {
    setButtonLoading(activeBtn, true, text);
  } else {
    original.forEach((_, btn) => setButtonLoading(btn, false));
    [emailEl, passEl, rememberEl, toggleBtn, forgotLink, loginBtn, googleBtn, msBtn].forEach((el) => { el.disabled = false; });
  }
}

function setFormDisabled(on) {
  [emailEl, passEl, rememberEl, toggleBtn, forgotLink, loginBtn, googleBtn, msBtn].forEach((el) => { el.disabled = on; });
}

// Si el usuario vuelve con "atrás" desde el dashboard (bfcache), revalidar.
window.addEventListener("pageshow", (e) => { if (e.persisted) window.location.reload(); });

