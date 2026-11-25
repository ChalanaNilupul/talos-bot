import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { PET_HEIGHT, PET_WIDTH } from '../shared/types';

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

const SHELL = 0xf3f4f6;
const HAND = 0xe2e5ea;
const VISOR = 0x1b1e22;
const EYE = 0xffffff;

export function createScene(canvas: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  /* White blows out far more easily than metal, so exposure stays low and the
     shading gradient comes from the lights rather than from the material. */
  renderer.toneMappingExposure = 0.98;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, PET_WIDTH / PET_HEIGHT, 0.1, 20);
  /* The hands sit outside the shell, so the camera keeps ~0.2 world units of
     horizontal margin or they get cropped by the 220px window edge. */
  camera.position.set(0, 0.42, 3.75);
  camera.lookAt(0, 0.06, 0);

  /* RoomEnvironment is a procedural studio scene: soft reflections with no
     asset download. Kept at partial intensity so a dielectric white shell still
     reads as an inflated volume instead of a flat white cut-out. */
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const key = new THREE.DirectionalLight(0xffffff, 1.35);
  key.position.set(1.4, 2.6, 2.4);
  key.castShadow = true;
  key.shadow.mapSize.set(512, 512);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 9;
  key.shadow.camera.left = -1.4;
  key.shadow.camera.right = 1.4;
  key.shadow.camera.top = 1.6;
  key.shadow.camera.bottom = -1.4;
  key.shadow.radius = 3;
  scene.add(key);

  const rim = new THREE.PointLight(0xbdd6ff, 2.2, 8);
  rim.position.set(-1.6, 0.8, -1.2);
  scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xe8f0ff, 0x4a4f56, 0.5));

  const shellMat = new THREE.MeshPhysicalMaterial({
    color: SHELL,
    metalness: 0,
    roughness: 0.44,
    clearcoat: 0.3,
    clearcoatRoughness: 0.6,
    envMapIntensity: 0.6,
  });
  const handMat = new THREE.MeshPhysicalMaterial({
    color: HAND,
    metalness: 0,
    roughness: 0.5,
    clearcoat: 0.25,
    clearcoatRoughness: 0.6,
    envMapIntensity: 0.6,
  });
  const visorMat = new THREE.MeshPhysicalMaterial({
    color: VISOR,
    metalness: 0.1,
    roughness: 0.32,
    clearcoat: 0.35,
    clearcoatRoughness: 0.4,
    envMapIntensity: 0.7,
  });
  const eyeMat = new THREE.MeshStandardMaterial({
    color: EYE,
    emissive: EYE,
    emissiveIntensity: 1.5,
    roughness: 0.35,
    metalness: 0,
  });

  const root = new THREE.Group();
  scene.add(root);

  /* ---- shell: one pillow; head and body are the same object ------------ */
  const body = new THREE.Group();
  root.add(body);

  const shellPivot = new THREE.Group();
  body.add(shellPivot);

  /* depth === 2 * radius turns the box into a Minkowski pillow with no flat
     sides, which is what gives the reference its inflated silhouette. */
  const shell = new THREE.Mesh(new RoundedBoxGeometry(1.06, 0.94, 0.6, 5, 0.3), shellMat);
  shell.castShadow = true;
  shellPivot.add(shell);

  /* Mostly buried inside the shell, bulging forward through its front face. */
  const visor = new THREE.Mesh(new RoundedBoxGeometry(0.8, 0.68, 0.34, 5, 0.17), visorMat);
  visor.position.z = 0.24;
  shellPivot.add(visor);

  const eyes = new THREE.Group();
  eyes.position.set(0, 0.02, 0.4);
  shellPivot.add(eyes);
  for (const side of [-1, 1]) {
    const pill = new THREE.Mesh(new THREE.CapsuleGeometry(0.082, 0.12, 6, 18), eyeMat);
    pill.scale.z = 0.5;
    pill.position.x = side * 0.155;
    eyes.add(pill);
  }

  /* ---- hands: detached ovals, the only limbs ---------------------------- */
  const leftHand = new THREE.Group();
  const rightHand = new THREE.Group();
  leftHand.position.set(-0.52, -0.16, 0.02);
  rightHand.position.set(0.52, -0.16, 0.02);
  for (const [pivot, side] of [[leftHand, -1], [rightHand, 1]] as const) {
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.125, 22, 16), handMat);
    hand.scale.set(0.72, 1, 0.6);
    hand.position.x = side * 0.14;
    hand.castShadow = true;
    pivot.add(hand);
    body.add(pivot);
  }

  /* ---- contact shadow: only the shadow is drawn, the plane stays clear --- */
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(0.95, 40),
    new THREE.ShadowMaterial({ opacity: 0.28 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.78;
  ground.receiveShadow = true;
  root.add(ground);

  /* ---- alarm ring -------------------------------------------------------- */
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xa8c8e8, transparent: true, opacity: 0, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.018, 8, 48), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = -0.74;
  root.add(ring);

  /* ---- sleep motes ------------------------------------------------------- */
  const motes: Array<{ mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; drift: number }> = [];
  for (let i = 0; i < 3; i++) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xd8e6ff, transparent: true, opacity: 0 });
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
  window.addEventListener('resize', resize);

  function render(pose: Pose) {
    const t = performance.now() / 1000;

    root.rotation.z = pose.lean;
    body.position.y = pose.bob;

    const inflate = 1 + pose.breath * 0.02;
    body.scale.set(1 / Math.sqrt(inflate), inflate, 1 / Math.sqrt(inflate));

    /* the shell is the head, so gaze turns the whole body; asleep it droops */
    const droop = pose.asleep ? 0.4 : 0;
    shellPivot.rotation.y = pose.gazeX * 0.3 * (pose.asleep ? 0.1 : 1);
    shellPivot.rotation.x = lerp(shellPivot.rotation.x, -pose.gazeY * 0.16 + droop, 0.15);
    shellPivot.rotation.z = lerp(shellPivot.rotation.z, pose.asleep ? 0.14 : 0, 0.1);

    /* no pupils: the pills themselves slide around inside the visor */
    eyes.position.x = pose.thinking ? Math.cos(t * 3.1) * 0.05 : pose.gazeX * 0.055;
    eyes.position.y = 0.02 + (pose.thinking ? Math.sin(t * 3.1) * 0.035 : -pose.gazeY * 0.035);
    eyes.scale.y = 1 - pose.blink * 0.94;

    const busy = pose.thinking || pose.alarmed;
    const pulse = busy ? 1.9 + Math.sin(t * 9) * 0.45 : 1.5;
    eyeMat.emissiveIntensity = pose.asleep ? 0.3 : pulse * (0.35 + pose.glow * 0.8);

    /* the antenna is gone but its springs survive, now driving the hands */
    const swing = pose.asleep ? 0 : Math.sin(t * 1.4) * 0.14;
    leftHand.rotation.z = -0.1 + swing + pose.antennaZ * 0.7;
    rightHand.rotation.z = 0.1 - swing + pose.antennaZ * 0.7;
    leftHand.rotation.x = pose.asleep ? 0 : Math.sin(t * 1.4 + 1) * 0.1 + pose.antennaX * 0.7;
    rightHand.rotation.x = pose.asleep ? 0 : -Math.sin(t * 1.4 + 1) * 0.1 + pose.antennaX * 0.7;

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
      m.mesh.position.set(0.5 + Math.sin(age * 5 + i) * m.drift * 0.5, 0.55 + age * 0.6, 0.24);
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
