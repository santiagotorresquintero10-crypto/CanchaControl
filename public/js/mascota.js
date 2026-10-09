/* ==========================================================
   CanchaControl — "Chispa", personaje motivacional (HU-014)
   ----------------------------------------------------------
   Personaje ORIGINAL de CanchaControl (SVG + CSS, sin imágenes ni
   audio). No representa a ningún futbolista real.
   Reacciones: saludo, celebración, motivación (señala) y aplausos.
   · Sin audio (nunca se reproduce sonido).
   · prefers-reduced-motion: sin movimiento; solo cambia el mensaje.
   ========================================================== */

const SVG = `
<svg class="mc" viewBox="0 0 160 200" role="img" aria-labelledby="mc-t">
  <title id="mc-t">Chispa, el personaje motivacional de CanchaControl</title>
  <ellipse class="mc-shadow" cx="80" cy="186" rx="38" ry="6"/>
  <g class="mc-burst" aria-hidden="true">
    <path d="M80 6v12M42 22l8 9M118 22l-8 9M26 54h12M122 54h12M34 88l9-5M126 88l-9-5"/>
    <circle cx="30" cy="34" r="3"/><circle cx="132" cy="38" r="2.5"/><circle cx="20" cy="76" r="2"/><circle cx="140" cy="78" r="2.5"/>
  </g>
  <g class="mc-body">
    <g class="mc-arm mc-arm--l">
      <line x1="58" y1="92" x2="44" y2="124" class="mc-skin-s"/>
      <line x1="58" y1="92" x2="52" y2="106" class="mc-sleeve"/>
      <circle cx="44" cy="125" r="6.5" class="mc-skin"/>
    </g>
    <g class="mc-arm mc-arm--r">
      <line x1="102" y1="92" x2="116" y2="124" class="mc-skin-s"/>
      <line x1="102" y1="92" x2="108" y2="106" class="mc-sleeve"/>
      <circle cx="116" cy="125" r="6.5" class="mc-skin"/>
    </g>
    <rect x="63" y="146" width="12" height="18" rx="4" class="mc-skin"/>
    <rect x="85" y="146" width="12" height="18" rx="4" class="mc-skin"/>
    <rect x="62" y="158" width="14" height="16" rx="3" class="mc-sock"/>
    <rect x="84" y="158" width="14" height="16" rx="3" class="mc-sock"/>
    <path d="M60 172h17v6a3 3 0 0 1-3 3H58a4 4 0 0 1 2-9z" class="mc-boot"/>
    <path d="M83 172h17a4 4 0 0 1 2 9H86a3 3 0 0 1-3-3z" class="mc-boot"/>
    <rect x="58" y="126" width="44" height="22" rx="5" class="mc-shorts"/>
    <path d="M56 86c16-7 32-7 48 0l4 44H52z" class="mc-shirt"/>
    <path d="M56 86c16-7 32-7 48 0l1.2 9c-16-6-34-6-50.4 0z" class="mc-shirt-hi"/>
    <path d="M71 81l9 9 9-9" class="mc-collar"/>
    <path d="M83 98l-8 14h6l-3 12 10-16h-6l3-10z" class="mc-bolt"/>
    <rect x="74" y="74" width="12" height="10" rx="3" class="mc-skin"/>
    <g class="mc-head">
      <circle cx="80" cy="52" r="26" class="mc-skin"/>
      <path d="M54 50c0-17 12-27 26-27s26 10 26 27c-5-6-11-8-17-6-3-5-9-7-14-5-6-3-13 0-15 5-3-1-5 1-6 6z" class="mc-hair"/>
      <path d="M55 40c8-6 42-6 50 0" class="mc-band"/>
      <circle cx="70" cy="55" r="3.2" class="mc-eye"/>
      <circle cx="90" cy="55" r="3.2" class="mc-eye"/>
      <circle cx="71" cy="54" r="1" class="mc-glint"/><circle cx="91" cy="54" r="1" class="mc-glint"/>
      <circle cx="64" cy="63" r="4" class="mc-cheek"/><circle cx="96" cy="63" r="4" class="mc-cheek"/>
      <path d="M71 64q9 9 18 0" class="mc-mouth"/>
    </g>
  </g>
  <g class="mc-ball">
    <circle cx="128" cy="176" r="10" fill="#fff" stroke="#14261c" stroke-width="1.6"/>
    <path d="M128 171.5l4.3 3.1-1.6 5h-5.4l-1.6-5z" fill="#14261c"/>
  </g>
</svg>`;

const ANIMS = ["saludo", "celebracion", "motivacion", "aplausos"];
const DUR = { saludo: 1600, celebracion: 1500, motivacion: 1400, aplausos: 1500 };
const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * @param {HTMLElement} stage   contenedor del personaje
 * @param {HTMLElement} bubble  globo de texto (aria-live)
 */
export function createMascota(stage, bubble) {
  stage.innerHTML = SVG;
  const svg = stage.querySelector("svg");
  let timer = 0;
  function play(anim) {
    if (!ANIMS.includes(anim)) return;
    clearTimeout(timer);
    ANIMS.forEach((a) => svg.classList.remove(`is-${a}`));
    stage.dataset.anim = anim;
    if (reduce()) return;                       // sin movimiento: solo el mensaje
    void svg.getBoundingClientRect();           // reinicia la animación
    svg.classList.add(`is-${anim}`);
    timer = setTimeout(() => svg.classList.remove(`is-${anim}`), DUR[anim]);
  }
  function say(text, anim = "motivacion") {
    bubble.classList.remove("is-in");
    bubble.textContent = text;
    void bubble.offsetWidth;
    bubble.classList.add("is-in");
    play(anim);
  }
  return { play, say };
}
