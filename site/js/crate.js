// The crate in 3D, in centimetres. It is seen from the front, then from above while the
// front records are flipped forward. render(p) poses everything for p in [0, 1].
import {
  ACESFilmicToneMapping,
  BackSide,
  BoxGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PCFShadowMap,
  PMREMGenerator,
  PerspectiveCamera,
  PlaneGeometry,
  MirroredRepeatWrapping,
  SRGBColorSpace,
  Scene,
  SpotLight,
  TextureLoader,
  Vector3,
  WebGLRenderer,
} from '../vendor/three.min.js';

const SLEEVE = 31.4;
const THICK = 0.34;
const INNER = { w: 33, d: 40, wall: 1.6, floor: 1.4 };
const WALL = { back: 25, side: 25, front: 14 };
// Empty space in front of the stack, where flipped records come to rest.
const FREE = 13;
const PITCH = 0.86;
const COUNT = 30;
const PAPER = [0xe8e2d4, 0x1b1b1e, 0xc7533a, 0x2f4f8f, 0x9fae4a, 0x8a8478, 0xb59a74, 0x3b3b40];
// The camera's path around the crate, as angle from straight down and distance.
const SHOTS = [
  { p: 0, polar: 83, dist: 100, target: [0, 15, 0] },
  { p: 0.22, polar: 80, dist: 94, target: [0, 15, 0] },
  { p: 0.55, polar: 40, dist: 104, target: [0, 11, -1] },
  { p: 1, polar: 36, dist: 102, target: [0, 10, 0] },
];

// The covers that get flipped past, each in its own slice of the scroll after the camera rises.
const FLIPS = 6;
const flipAt = (k) => [0.58 + k * 0.065, 0.66 + k * 0.065];

const ease = (t) => t * t * (3 - 2 * t);
const clamp = (v) => Math.min(1, Math.max(0, v));

// A small lit room for reflections: a softbox up left, a lime strip at the back right.
function environment(renderer) {
  const room = new Scene();
  const box = new BoxGeometry();
  const shell = new Mesh(box, new MeshBasicMaterial({ color: 0x0b0b0c, side: BackSide }));
  const light = (color, power, pos, size) => {
    const m = new Mesh(box, new MeshBasicMaterial({ color }));

    m.material.color.multiplyScalar(power);
    m.position.set(...pos);
    m.scale.set(...size);
    room.add(m);
  };

  shell.scale.setScalar(60);
  room.add(shell);
  light(0xffffff, 6, [-14, 26, 10], [16, 0.5, 16]);
  light(0xd6ff3a, 3, [24, 8, -20], [0.5, 10, 18]);
  light(0xffd9c2, 1.2, [20, 4, 24], [10, 6, 0.5]);

  const pmrem = new PMREMGenerator(renderer);
  const env = pmrem.fromScene(room, 0.03).texture;

  pmrem.dispose();

  return env;
}

// Every surface dithers, so the slow falloffs of a dark scene don't band.
const material = (opts) => new MeshStandardMaterial({ dithering: true, ...opts });

// The floor is lit and takes the crate's shadow, and fades out at its edge so the scene has
// no box around it.
function stage() {
  const size = 512;
  const c = document.createElement('canvas');

  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);

  grad.addColorStop(0, '#fff');
  grad.addColorStop(0.5, '#999');
  grad.addColorStop(1, '#000');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  // A little noise breaks up the 8-bit steps a slow fade would otherwise show.
  const px = g.getImageData(0, 0, size, size);

  for (let i = 0; i < px.data.length; i += 4)
    px.data[i] = px.data[i + 1] = px.data[i + 2] = px.data[i + 1] + (Math.random() - 0.5) * 6;

  g.putImageData(px, 0, 0);

  const m = new Mesh(
    new PlaneGeometry(150, 150),
    material({
      color: 0x2a2724,
      roughness: 0.95,
      alphaMap: new CanvasTexture(c),
      transparent: true,
      depthWrite: false,
    }),
  );

  m.rotation.x = -Math.PI / 2;
  m.receiveShadow = true;

  return m;
}

function averageColor(image) {
  const c = document.createElement('canvas');

  c.width = c.height = 1;
  const g = c.getContext('2d');

  g.drawImage(image, 0, 0, 1, 1);
  const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;

  return new Color(r / 255, gr / 255, b / 255).convertSRGBToLinear();
}

function mulberry(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);

    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function crate3d(canvas, { covers, wood }) {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  const loader = new TextureLoader();
  const load = (url) =>
    loader.loadAsync(url).then((t) => {
      t.colorSpace = SRGBColorSpace;
      t.anisotropy = renderer.capabilities.getMaxAnisotropy();

      return t;
    });

  renderer.setPixelRatio(Math.min(devicePixelRatio, innerWidth < 700 ? 1.5 : 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.toneMapping = ACESFilmicToneMapping;

  const scene = new Scene();

  scene.environment = environment(renderer);
  scene.environmentIntensity = 0.8;

  const camera = new PerspectiveCamera(28, 1, 10, 500);

  // Light: a soft key from above left, a cool fill, and the site's lime as a rim from behind.
  const key = new DirectionalLight(0xfff4e6, 3.4);

  key.position.set(-45, 90, 55);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  // Shadow bounds hug the crate, so the 2048 px map stays fine enough not to step.
  Object.assign(key.shadow.camera, {
    left: -38,
    right: 38,
    top: 38,
    bottom: -38,
    near: 60,
    far: 190,
  });
  key.shadow.radius = 4;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.03;
  scene.add(key, new HemisphereLight(0xb8c0d0, 0x141416, 0.9));

  const rim = new SpotLight(0xd6ff3a, 9000, 220, 0.5, 0.8, 2);

  rim.position.set(55, 45, -70);
  rim.target.position.set(0, 18, 0);
  scene.add(rim, rim.target);

  scene.add(stage());

  // The crate: five boards of one pine texture, which spans 70 cm of wood at any size.
  const [woodMap, ...images] = await Promise.all([load(wood), ...covers.map(load)]);

  // Mirrored, so the texture's edges meet themselves and no tiling seam shows.
  woodMap.wrapS = woodMap.wrapT = MirroredRepeatWrapping;

  const board = (w, h, d, x, y, z) => {
    const map = woodMap.clone();

    map.repeat.set(Math.max(w, d) / 70, h / 70);
    const m = new Mesh(
      new BoxGeometry(w, h, d),
      material({ map, color: 0xd9a77a, roughness: 0.8 }),
    );

    m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
  };
  const W = INNER.w + 2 * INNER.wall;
  const D = INNER.d + 2 * INNER.wall;

  board(W, INNER.floor, D, 0, INNER.floor / 2, 0);
  board(W, WALL.front, INNER.wall, 0, WALL.front / 2, INNER.d / 2 + INNER.wall / 2);
  board(W, WALL.back, INNER.wall, 0, WALL.back / 2, -INNER.d / 2 - INNER.wall / 2);

  for (const s of [-1, 1])
    board(INNER.wall, WALL.side, D, s * (INNER.w / 2 + INNER.wall / 2), WALL.side / 2, 0);

  // The records: the front ones wear covers, the rest are plain sleeves seen edge on.
  const sleeveGeo = new BoxGeometry(SLEEVE, SLEEVE, THICK);
  const rand = mulberry(7);
  const sleeves = [];
  const z0 = INNER.d / 2 - FREE;

  for (let k = 0; k < COUNT; k++) {
    const cover = images[k];
    const paper = new Color(PAPER[k % PAPER.length]).convertSRGBToLinear();
    const edge = cover
      ? averageColor(cover.image).multiplyScalar(0.8)
      : paper.clone().multiplyScalar(0.85);
    const side = material({ color: edge, roughness: 0.75 });
    const face = cover
      ? material({ map: cover, roughness: 0.55 })
      : material({ color: paper, roughness: 0.7 });
    // The back of a sleeve is its own art, darker, as if printed in fewer inks.
    const back = cover
      ? material({ map: cover, color: 0x5a5a5a, roughness: 0.7 })
      : material({ color: paper.clone().multiplyScalar(0.7), roughness: 0.7 });
    const mesh = new Mesh(sleeveGeo, [side, side, side, side, face, back]);
    const pivot = new Group();

    mesh.position.set(0, SLEEVE / 2, -THICK / 2);
    mesh.castShadow = mesh.receiveShadow = true;
    pivot.add(mesh);
    pivot.position.set((rand() - 0.5) * 0.8, INNER.floor, z0 - k * PITCH - rand() * 0.18);
    pivot.rotation.set((rand() - 0.5) * 0.03, 0, (rand() - 0.5) * 0.012);
    // Upright, and how far it tips toward you when flipped, resting on the one before.
    pivot.userData = { rest: pivot.rotation.x, lean: 0.7 - k * 0.045 };
    scene.add(pivot);
    sleeves.push(pivot);
  }

  const at = new Vector3();
  let aspect = 1;
  let last = 0;

  function pose(p) {
    const i = Math.max(
      0,
      SHOTS.findLastIndex((s) => s.p <= p),
    );
    const a = SHOTS[i];
    const b = SHOTS[Math.min(i + 1, SHOTS.length - 1)];
    const t = b === a ? 0 : ease(clamp((p - a.p) / (b.p - a.p)));
    const polar = MathUtils.degToRad(a.polar + (b.polar - a.polar) * t);
    // Narrow boxes back the camera off so the whole crate stays in frame.
    const dist = (a.dist + (b.dist - a.dist) * t) * Math.max(1, 1.35 / aspect);

    at.set(...a.target.map((v, j) => v + (b.target[j] - v) * t));
    camera.position.set(at.x, at.y + dist * Math.cos(polar), at.z + dist * Math.sin(polar));
    camera.lookAt(at);

    sleeves.forEach((s, k) => {
      const [from, to] = flipAt(k);
      const f = k < FLIPS ? ease(clamp((p - from) / (to - from))) : 0;

      s.rotation.x = s.userData.rest + (s.userData.lean - s.userData.rest) * f;
    });
  }

  function render(p = last) {
    last = p;
    pose(p);
    renderer.render(scene, camera);
  }

  function resize() {
    const { clientWidth: w, clientHeight: h } = canvas;

    aspect = w / h;
    renderer.setSize(w, h, false);
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    render();
  }

  resize();

  return { render, resize };
}
