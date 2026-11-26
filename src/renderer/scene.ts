import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { PET_HEIGHT, PET_WIDTH } from "../shared/types";

export interface Pose {
  /** -1..1, where the pet is looking */
  gazeX: number;
  gazeY: number;
  /** 0 = wide open, 1 = shut */
  blink: number;
  /** -1..1 breathing cycle */
  breath: number;
  /** vertical offset in world units */
  bob: number;
  /** whole-body tilt in radians */
  lean: number;
  /** spring lag, radians — drives the floating hands */
  antennaZ: number;
  antennaX: number;
  asleep: boolean;
  alarmed: boolean;
  /** eyes drift in a circle while working */
  thinking: boolean;
  /** 0..1 emissive strength on the eyes */
  glow: number;
}

const PLATE = 0xf4f5f7;
const PLATE_DIM = 0xc7ccd4;
const STEEL = 0x2a2e34;
const SCREEN = 0x0b1015;
const LED = 0xf2f7ff;
const CLOTH = 0x202429;
const RED = 0xef4136;
const GRIP = 0x141619;
const SAYA = 0x101215;

/** Dead-pixel mask for the eye panels: an LED grid reads as hardware, a pill does not. */
function ledGrid(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 48;
  const g = c.getContext("2d")!;
  g.fillStyle = "#0d2029";
  g.fillRect(0, 0, 32, 48);
  g.fillStyle = "#ffffff";
  for (let y = 0; y < 12; y++) {
    for (let x = 0; x < 8; x++) {
      /* sparse, non-repeating dropouts — a modulo that correlates x with y draws
         diagonal stripes, which looked like slashes instead of pixels. */
      if ((x * 13 + y * 29) % 11 === 0) continue;
      g.fillRect(x * 4 + 1, y * 4 + 1, 3, 3);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * The kanji is drawn by the OS font stack rather than shipped as an asset. If no CJK
 * face is installed it degrades to a tofu box — re-check the screenshot after a restyle.
 */
function glyphTexture(char: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, 128, 128);
  g.fillStyle = "#f2f7ff";
  g.font =
    '900 92px "Noto Sans CJK JP", "Yu Gothic UI", "Malgun Gothic", "MS Gothic", serif';
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(char, 64, 72);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function glyphPlane(char: string, size: number): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({
      map: glyphTexture(char),
      transparent: true,
      depthWrite: false,
    }),
  );
}

/**
 * Equirect panel print for the body shell. At 176px a plain white ball reads as
 * plastic; seams, a vent bank and bolt heads read as a manufactured casing, and
 * they cost no geometry to light or shadow.
 *
 * Two things decide where the detail goes. Sphere UVs put the character's front at
 * x=64 of this canvas, not the middle. And the helm, the collar and the waterline
 * cover the shell, so only two bands are ever seen: canvas y 52-79 across the chest
 * and y 87-117 below the red ring. Anything drawn outside those is decoration for
 * a surface the camera never gets to.
 */
function panelCanvas(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f4f5f7";
  g.fillRect(0, 0, 256, 128);

  /* Neighbouring panels differ in value: a uniform white sheet reads as one moulding,
     and the casing read comes from the shell visibly being separate pieces. */
  const cells: Array<[number, number, number, number, string]> = [
    [32, 37, 64, 83, "#e9ecf0"],
    [96, 0, 160, 37, "#e2e6ec"],
    [160, 37, 224, 83, "#eceef2"],
    [96, 83, 160, 104, "#e5e9ee"],
    [224, 0, 256, 37, "#eaeef2"],
    [0, 104, 32, 128, "#e3e7ed"],
    [32, 104, 96, 128, "#eceef2"],
  ];
  for (const [x0, y0, x1, y1, fill] of cells) {
    g.fillStyle = fill;
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
  }

  /* A groove is a dark line with a pale lip beside it; one flat line is a sticker. */
  const seam = (at: number, vertical: boolean) => {
    for (const [color, offset] of [
      ["#c9cfd7", 1.8],
      ["#8f97a2", 0],
    ] as const) {
      g.strokeStyle = color;
      g.lineWidth = 2.6;
      g.beginPath();
      if (vertical) {
        g.moveTo(at + offset, 0);
        g.lineTo(at + offset, 128);
      } else {
        g.moveTo(0, at + offset);
        g.lineTo(256, at + offset);
      }
      g.stroke();
    }
  };
  for (const y of [37, 83, 104]) seam(y, false);
  for (const x of [32, 96, 160, 224]) seam(x, true);

  for (const [x, y] of [
    [50, 57],
    [80, 57],
    [22, 95],
    [112, 95],
    [150, 62],
    [206, 96],
    [242, 58],
  ] as const) {
    g.fillStyle = "#c9cfd7";
    g.beginPath();
    g.arc(x, y + 1, 3.2, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#3a4048";
    g.beginPath();
    g.arc(x, y, 2.9, 0, Math.PI * 2);
    g.fill();
  }

  g.fillStyle = "#ef4136";
  g.fillRect(46, 91, 36, 5);
  return c;
}

/**
 * The same canvas drives colour and roughness, so the printed seams also catch the
 * key light as polished grooves in the casing.
 */
function panelMaps(): { map: THREE.CanvasTexture; rough: THREE.CanvasTexture } {
  const c = panelCanvas();
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  const rough = new THREE.CanvasTexture(c);
  rough.colorSpace = THREE.NoColorSpace;
  return { map, rough };
}

export function createScene(canvas: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  /* Painted metal reads darker than foam, so exposure stays low and the armour's form
     comes from the warm key / cold rim split instead of from overall brightness. */
  renderer.toneMappingExposure = 0.92;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    32,
    PET_WIDTH / PET_HEIGHT,
    0.1,
    20,
  );
  /* Fins, tails and the sword hilt reach ~0.9 units either side of centre, so the
     camera needs the wider frame or the silhouette is cropped at the window edge. */
  camera.position.set(0, 0.28, 4.65);
  camera.lookAt(0, -0.17, 0);

  /* RoomEnvironment is a procedural studio scene: soft reflections with no asset
     download, and enough contrast for chamfered plates to catch a moving highlight. */
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const key = new THREE.DirectionalLight(0xfff4e6, 1.5);
  key.position.set(1.4, 2.6, 2.4);
  key.castShadow = true;
  key.shadow.mapSize.set(512, 512);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 10;
  key.shadow.camera.left = -1.5;
  key.shadow.camera.right = 1.5;
  key.shadow.camera.top = 1.5;
  key.shadow.camera.bottom = -1.8;
  key.shadow.radius = 3;
  scene.add(key);

  /* A blue rim used to flatter the navy cloth; on an all-white shell it just tints
     the paint, so the cool side is neutral now and the red has to come from the
     material instead. */
  const rim = new THREE.PointLight(0xcfd8e6, 3.0, 9);
  rim.position.set(-1.7, 0.9, -1.3);
  scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xe8ecf2, 0x30343a, 0.55));

  const plateMat = new THREE.MeshPhysicalMaterial({
    color: PLATE,
    metalness: 0.38,
    roughness: 0.42,
    clearcoat: 0.32,
    clearcoatRoughness: 0.55,
    envMapIntensity: 0.9,
  });
  const dimMat = new THREE.MeshPhysicalMaterial({
    color: PLATE_DIM,
    metalness: 0.55,
    roughness: 0.52,
    envMapIntensity: 0.8,
  });
  /* Only the body shell carries the panel print. The helm and the hands stay plain
     white, or the face and the silhouette turn to noise at this size. */
  const panel = panelMaps();
  const orbMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: panel.map,
    roughnessMap: panel.rough,
    metalness: 0.32,
    roughness: 0.5,
    clearcoat: 0.28,
    clearcoatRoughness: 0.5,
    envMapIntensity: 0.85,
  });
  const steelMat = new THREE.MeshPhysicalMaterial({
    color: STEEL,
    metalness: 0.82,
    roughness: 0.34,
    envMapIntensity: 1,
  });
  /* Reflections are kept off this face on purpose: an env-lit dark panel turns
     mid-grey and the eyes lose all of their contrast against it. */
  const screenMat = new THREE.MeshPhysicalMaterial({
    color: SCREEN,
    metalness: 0.1,
    roughness: 0.62,
    clearcoat: 0.4,
    envMapIntensity: 0.12,
  });
  /* Sheen is what made the old collar look like painted foam; cloth needs just
     enough of it to stop black reading as flat plastic. */
  const clothMat = new THREE.MeshPhysicalMaterial({
    color: CLOTH,
    metalness: 0,
    roughness: 0.88,
    sheen: 0.3,
    sheenColor: new THREE.Color(0x8d97a6),
    sheenRoughness: 0.8,
    envMapIntensity: 0.18,
  });
  const finMat = new THREE.MeshPhysicalMaterial({
    color: RED,
    metalness: 0.15,
    roughness: 0.4,
    clearcoat: 0.6,
    clearcoatRoughness: 0.3,
    envMapIntensity: 0.8,
  });
  const sayaMat = new THREE.MeshPhysicalMaterial({
    color: SAYA,
    metalness: 0.2,
    roughness: 0.32,
    clearcoat: 0.7,
    envMapIntensity: 0.9,
  });
  const gripMat = new THREE.MeshStandardMaterial({
    color: GRIP,
    metalness: 0.2,
    roughness: 0.75,
  });
  /* The only two places red touches metal: the hilt wrapping and the crest ring.
     Any wider and it stops being an accent at this size. */
  const bandMat = new THREE.MeshStandardMaterial({
    color: RED,
    metalness: 0.25,
    roughness: 0.55,
  });
  const eyeMat = new THREE.MeshStandardMaterial({
    color: SCREEN,
    emissive: LED,
    emissiveIntensity: 1.4,
    emissiveMap: ledGrid(),
    roughness: 0.6,
    metalness: 0,
  });
  const podMat = new THREE.MeshStandardMaterial({
    color: 0x1a1215,
    emissive: RED,
    emissiveIntensity: 0.7,
    roughness: 0.45,
    metalness: 0.2,
  });

  const root = new THREE.Group();
  scene.add(root);

  const body = new THREE.Group();
  root.add(body);

  /* ---- helmet: one armoured shell is the whole head --------------------- */
  const helm = new THREE.Group();
  body.add(helm);

  /* A radius this small (the old pillow used 0.3) keeps flat faces between the chamfers,
     which is what makes the silhouette read as bolted plates instead of inflated foam. */
  const shell = new THREE.Mesh(
    new RoundedBoxGeometry(1.0, 0.92, 0.94, 4, 0.2),
    plateMat,
  );
  shell.castShadow = true;
  helm.add(shell);

  const brow = new THREE.Mesh(
    new RoundedBoxGeometry(1.02, 0.2, 0.22, 3, 0.08),
    dimMat,
  );
  brow.position.set(0, 0.3, 0.36);
  helm.add(brow);

  const crest = new THREE.Mesh(
    new RoundedBoxGeometry(0.36, 0.28, 0.1, 2, 0.048),
    steelMat,
  );
  crest.position.set(0, 0.31, 0.44);
  helm.add(crest);
  const crestRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.075, 0.017, 8, 24),
    finMat,
  );
  crestRing.position.set(0, 0.31, 0.5);
  helm.add(crestRing);

  /* cheek guards flare out and back, so they are the widest part of the helmet */
  for (const side of [-1, 1]) {
    const guard = new THREE.Mesh(
      new RoundedBoxGeometry(0.16, 0.44, 0.5, 2, 0.07),
      dimMat,
    );
    guard.position.set(side * 0.5, -0.1, -0.04);
    guard.rotation.set(0, side * 0.22, side * 0.12);
    guard.castShadow = true;
    helm.add(guard);
  }

  /* ---- visor: chamfered steel bezel around a dark screen ---------------- */
  const bezel = new THREE.Mesh(
    new RoundedBoxGeometry(0.88, 0.66, 0.12, 3, 0.055),
    steelMat,
  );
  bezel.position.set(0, 0.01, 0.42);
  helm.add(bezel);

  const screen = new THREE.Mesh(
    new RoundedBoxGeometry(0.76, 0.54, 0.06, 2, 0.028),
    screenMat,
  );
  screen.position.set(0, 0.01, 0.46);
  helm.add(screen);

  const eyes = new THREE.Group();
  eyes.position.set(0, 0.03, 0.5);
  helm.add(eyes);
  for (const side of [-1, 1]) {
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.19, 0.26), eyeMat);
    panel.position.x = side * 0.19;
    eyes.add(panel);
  }

  /* a lit grille instead of a mouth — the face needs one more signal to read as a screen */
  const mouth = new THREE.Group();
  mouth.position.set(0, -0.18, 0.5);
  helm.add(mouth);
  for (let i = 0; i < 5; i++) {
    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(0.014, 0.075, 0.005),
      podMat,
    );
    bar.position.x = (i - 2) * 0.03;
    mouth.add(bar);
  }

  /* ---- ear pods with lit rings ----------------------------------------- */
  for (const side of [-1, 1]) {
    const pod = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.16, 0.12, 24),
      steelMat,
    );
    pod.rotation.z = Math.PI / 2;
    pod.position.set(side * 0.53, 0, 0.02);
    helm.add(pod);
    const podRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.125, 0.022, 8, 28),
      podMat,
    );
    podRing.rotation.y = Math.PI / 2;
    podRing.position.set(side * 0.59, 0, 0.02);
    helm.add(podRing);
  }

  /* ---- ear fins: helmet "fukigaeshi", pivoting at the pod ------------- */
  const leftFin = new THREE.Group();
  const rightFin = new THREE.Group();
  /* Rooted inside the pod and wide enough to overlap the shell, or the splay lifts
     them off the head and they read as confetti floating beside it. */
  leftFin.position.set(-0.42, -0.02, 0.06);
  rightFin.position.set(0.42, -0.02, 0.06);
  /* The left plate is the darker alloy: at 176px a white fin on a white helmet
     simply vanishes against the desktop. */
  for (const [pivot, side, mat] of [
    [leftFin, -1, dimMat],
    [rightFin, 1, finMat],
  ] as const) {
    const fin = new THREE.Mesh(
      new RoundedBoxGeometry(0.4, 0.52, 0.09, 3, 0.042),
      mat,
    );
    fin.position.set(side * 0.02, 0.2, 0);
    fin.rotation.z = -side * 0.1;
    fin.castShadow = true;
    pivot.add(fin);
    if (side > 0) {
      /* 0.005 in front of the plate z-fights and the glyph disappears */
      const mark = glyphPlane("侍", 0.27);
      mark.position.set(side * 0.02, 0.21, 0.075);
      pivot.add(mark);
    }
    helm.add(pivot);
  }

  /* ---- body: one globe, swaddled --------------------------------------- */
  /* No torso and no legs — the helm sits straight onto a sphere. Everything that
     belongs to the body lives in this one group so a sleeping droop moves the orb
     and its scarf together instead of peeling the collar off the shell. */
  const globe = new THREE.Group();
  globe.position.y = -0.9;
  body.add(globe);

  /* Wide enough that the body is not narrower than the helm, or the whole thing
     reads as a head balanced on a ball. */
  const orb = new THREE.Mesh(new THREE.SphereGeometry(0.5, 44, 30), orbMat);
  orb.scale.y = 0.96;
  orb.castShadow = true;
  globe.add(orb);

  /* A plain white ball reads as a balloon. The red waterline and the two dark
     seams are what make it look like a shell that was manufactured. */
  const waterline = new THREE.Mesh(
    new THREE.TorusGeometry(0.502, 0.03, 10, 56),
    finMat,
  );
  waterline.rotation.x = Math.PI / 2;
  waterline.position.y = -0.14;
  globe.add(waterline);

  for (const y of [0.2, -0.3]) {
    /* the ring has to sit on the sphere, so its radius comes from the same maths */
    const r = Math.sqrt(0.5 * 0.5 - (y / 0.96) * (y / 0.96));
    const seam = new THREE.Mesh(
      new THREE.TorusGeometry(r, 0.012, 6, 40),
      steelMat,
    );
    seam.rotation.x = Math.PI / 2;
    seam.position.y = y;
    globe.add(seam);
  }

  /* A shell that closes on nothing looks like a balloon. The dark base is where
     the sphere ends and the machinery starts, and it is the one part that gives
     the body a silhouette of its own. */
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.17, 0.22, 0.1, 28),
    steelMat,
  );
  base.position.y = -0.45;
  base.castShadow = true;
  globe.add(base);

  /* A chest unit bolted over the shell. Two conformal sphere patches, not a flat
     box: a plate that does not follow the curvature gaps and rocks against the
     sphere as it turns. The lower, wider patch is the trim the print sits on. */
  const plateTrim = new THREE.Mesh(
    new THREE.SphereGeometry(
      0.508,
      24,
      16,
      Math.PI / 2 - 0.26,
      0.52,
      1.32,
      0.5,
    ),
    steelMat,
  );
  plateTrim.scale.y = 0.96;
  globe.add(plateTrim);

  const chestPlate = new THREE.Mesh(
    new THREE.SphereGeometry(
      0.518,
      24,
      16,
      Math.PI / 2 - 0.21,
      0.42,
      1.365,
      0.41,
    ),
    dimMat,
  );
  chestPlate.scale.y = 0.96;
  globe.add(chestPlate);

  /* lit by podMat so it pulses with the ear rings and the grille — one light source
     for the whole body, not a fourth colour to track */
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.05, 18, 14), podMat);
  core.position.set(0, 0, 0.545);
  globe.add(core);

  /* The wrap goes where the orb is widest. Higher than this it disappears behind
     the helm and reads as a shadow gap instead of cloth. */
  /* Flattened along the tube axis: a round-section torus is a rubber ring, and a
     wide thin one is a cloth wrap. This is the only trick that makes the scarf
     read as fabric without a real model. */
  const collar = new THREE.Mesh(
    new THREE.TorusGeometry(0.47, 0.13, 16, 44),
    clothMat,
  );
  collar.rotation.x = -Math.PI / 2;
  collar.scale.set(1, 1, 0.55);
  collar.position.y = 0.16;
  collar.castShadow = true;
  globe.add(collar);

  /* ---- floating hands --------------------------------------------------- */
  /* No arms and no fingers: two pills that hover at the sides, driven by the same
     spring lag as the fins, so they read as detached rather than glued on. The
     scarf tails this replaces looked like a hand with three fingers. */
  const hands: THREE.Mesh[] = [];
  for (let i = 0; i < 2; i++) {
    const hand = new THREE.Mesh(
      new RoundedBoxGeometry(0.19, 0.24, 0.17, 4, 0.08),
      plateMat,
    );
    hand.castShadow = true;
    const knuckle = new THREE.Mesh(
      new RoundedBoxGeometry(0.12, 0.028, 0.02, 1, 0.012),
      steelMat,
    );
    knuckle.position.set(0, 0.03, 0.086);
    hand.add(knuckle);
    body.add(hand);
    hands.push(hand);
  }

  /* ---- katana, slung behind the globe ---------------------------------- */
  /* Angled so the saya vanishes behind the shell and only the hilt shows above it,
     the way the reference carries the sword. */
  const sword = new THREE.Group();
  sword.position.set(0.52, -0.54, -0.32);
  sword.rotation.z = -0.76;
  body.add(sword);

  const saya = new THREE.Mesh(
    new RoundedBoxGeometry(0.11, 0.78, 0.09, 2, 0.042),
    sayaMat,
  );
  saya.position.y = -0.42;
  saya.castShadow = true;
  sword.add(saya);

  const tsuba = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.16, 0.035, 24),
    steelMat,
  );
  tsuba.position.y = 0;
  sword.add(tsuba);

  const tsuka = new THREE.Mesh(
    new RoundedBoxGeometry(0.075, 0.42, 0.075, 2, 0.032),
    gripMat,
  );
  tsuka.position.y = 0.24;
  sword.add(tsuka);
  for (let i = 0; i < 4; i++) {
    const wrap = new THREE.Mesh(
      new THREE.TorusGeometry(0.05, 0.014, 6, 18),
      bandMat,
    );
    wrap.rotation.x = Math.PI / 2;
    wrap.position.y = 0.1 + i * 0.09;
    sword.add(wrap);
  }
  const kashira = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 14, 12),
    steelMat,
  );
  kashira.position.y = 0.47;
  sword.add(kashira);

  /* ---- contact shadow: only the shadow is drawn, the plane stays clear --- */
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(0.8, 40),
    new THREE.ShadowMaterial({ opacity: 0.26 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.24;
  ground.receiveShadow = true;
  root.add(ground);

  /* ---- alarm ring -------------------------------------------------------- */
  const ringMat = new THREE.MeshBasicMaterial({
    color: RED,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.85, 0.018, 8, 48),
    ringMat,
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = -1.22;
  root.add(ring);

  /* ---- sleep motes ------------------------------------------------------- */
  const motes: Array<{
    mesh: THREE.Mesh;
    mat: THREE.MeshBasicMaterial;
    drift: number;
  }> = [];
  for (let i = 0; i < 3; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xd8e6ff,
      transparent: true,
      opacity: 0,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), mat);
    mesh.visible = false;
    scene.add(mesh);
    motes.push({ mesh, mat, drift: 0.25 + i * 0.12 });
  }

  /* ---- frame ------------------------------------------------------------- */
  function resize() {
    const w = canvas.clientWidth || PET_WIDTH;
    const h = canvas.clientHeight || PET_HEIGHT;
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener("resize", resize);

  function render(pose: Pose) {
    const t = performance.now() / 1000;

    root.rotation.z = pose.lean;
    body.position.y = pose.bob;

    const inflate = 1 + pose.breath * 0.018;
    body.scale.set(1 / Math.sqrt(inflate), inflate, 1 / Math.sqrt(inflate));

    /* the helmet is the head, so gaze turns it while the globe keeps its own pitch */
    const droop = pose.asleep ? 0.42 : 0;
    helm.rotation.y = pose.gazeX * 0.34 * (pose.asleep ? 0.1 : 1);
    helm.rotation.x = lerp(helm.rotation.x, pose.gazeY * 0.17 + droop, 0.15);
    helm.rotation.z = lerp(
      helm.rotation.z,
      pose.asleep ? 0.16 : pose.gazeX * -0.05,
      0.1,
    );
    globe.rotation.x = lerp(globe.rotation.x, pose.asleep ? 0.08 : 0, 0.1);

    /* no pupils: the LED panels themselves slide around behind the screen */
    eyes.position.x = pose.thinking
      ? Math.cos(t * 3.1) * 0.05
      : pose.gazeX * 0.06;
    eyes.position.y =
      0.03 + (pose.thinking ? Math.sin(t * 3.1) * 0.035 : -pose.gazeY * 0.04);
    eyes.scale.y = 1 - pose.blink * 0.94;

    const busy = pose.thinking || pose.alarmed;
    const pulse = busy ? 1.9 + Math.sin(t * 9) * 0.45 : 1.4;
    eyeMat.emissiveIntensity = pose.asleep
      ? 0.22
      : pulse * (0.35 + pose.glow * 0.8);
    podMat.emissiveIntensity = pose.asleep ? 0.12 : 0.55 + pose.glow * 0.5;
    /* the grille blinks with the eyes so the face dims as one unit */
    mouth.scale.y = 1 - pose.blink * 0.94;

    /* one spring, three followers: fins, hands and the sword all trail the head */
    const swing = pose.asleep ? 0 : Math.sin(t * 1.4) * 0.07;
    leftFin.rotation.z = 0.26 + swing + pose.antennaZ * 0.55;
    rightFin.rotation.z = -0.26 - swing + pose.antennaZ * 0.55;
    leftFin.rotation.x = pose.asleep
      ? 0
      : Math.sin(t * 1.4 + 1) * 0.06 + pose.antennaX * 0.55;
    rightFin.rotation.x = pose.asleep
      ? 0
      : -Math.sin(t * 1.4 + 1) * 0.06 + pose.antennaX * 0.55;
    for (let i = 0; i < hands.length; i++) {
      const side = i === 0 ? -1 : 1;
      const hand = hands[i]!;
      /* they hover, so asleep they sink rather than stop mid-air rigidly */
      const rest = pose.asleep ? 0.24 : 0;
      hand.position.set(
        side * 0.7 + pose.antennaZ * 0.05,
        -0.62 -
          rest +
          pose.antennaX * 0.14 +
          Math.sin(t * 1.6 + i * 2.1) * (pose.asleep ? 0.006 : 0.022),
        0.2,
      );
      hand.rotation.z = side * 0.12 + pose.antennaZ * 0.3;
      hand.rotation.x = pose.antennaX * 0.3;
    }
    sword.rotation.x = pose.asleep
      ? 0
      : Math.sin(t * 1.4 + 0.6) * 0.04 + pose.antennaX * 0.3;

    ring.visible = pose.alarmed;
    if (pose.alarmed) {
      const k = (t % 1.2) / 1.2;
      ring.scale.setScalar(0.6 + k * 0.9);
      ringMat.opacity = 0.65 * (1 - k);
    }

    for (let i = 0; i < motes.length; i++) {
      const m = motes[i]!;
      if (!pose.asleep) {
        m.mesh.visible = false;
        continue;
      }
      /* each mote runs its own offset cycle, so no per-mote state is needed */
      const age = ((t + i * 0.85) % 2.6) / 2.6;
      m.mesh.visible = true;
      m.mesh.position.set(
        0.5 + Math.sin(age * 5 + i) * m.drift * 0.5,
        0.8 + age * 0.6,
        0.24,
      );
      m.mesh.scale.setScalar(0.5 + age * 1.4);
      m.mat.opacity = 0.8 * (1 - age);
    }

    renderer.render(scene, camera);
  }

  return { render };
}

function lerp(a: number, b: number, k: number) {
  return a + (b - a) * k;
}
