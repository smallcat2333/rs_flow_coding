// 使用说明视频的 3D 场景：three.js 负责节点、粒子、光束与泛光，DOM 层负责字幕和界面卡片。
// render(t) 只依赖时间 t，任意一帧都能单独重算；所有时间点来自 timeline.mjs，与配乐共用。
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { DURATION, SCENES, T, CAPTIONS } from './timeline.mjs';

/* ---------- 基础工具 ---------- */
const $ = (id) => document.getElementById(id);
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const seg = (t, a, b) => clamp((t - a) / (b - a));
const lerp = (a, b, p) => a + (b - a) * p;
const E = {
  out: (p) => 1 - Math.pow(1 - p, 3),
  in: (p) => p * p * p,
  io: (p) => (p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  expo: (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)),
  // 阻尼弹簧：一次轻微回弹
  spring: (p) => (p <= 0 ? 0 : p >= 1 ? 1 : 1 - Math.exp(-6 * p) * Math.cos(10 * p)),
};
/** 进场 a→a+d、退场 b-d→b 的可见度 0..1。 */
const vis = (t, a, b, d = .4) => Math.min(E.out(seg(t, a, a + d)), 1 - E.in(seg(t, b - d, b)));
/** 事件后的衰减脉冲：未到时间为 0。 */
const kick = (t, at, k = 3) => (t >= at ? Math.exp(-(t - at) * k) : 0);
const V = (x, y, z) => new THREE.Vector3(x, y, z);
function rng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
const FONT = '"Microsoft YaHei UI","Microsoft YaHei",sans-serif';
const NUM = 'Bahnschrift,"Segoe UI",sans-serif';
const MONO = '"Cascadia Code",Consolas,monospace';

/* ---------- 状态配色：填充色取 draw.io 默认值，发光色为同色相的饱和版本 ---------- */
const S = {
  none: { name: '已实现', fill: '#FFFFFF', glow: '#8fb0d8', i: .8, who: 'Agent' },
  review: { name: '起草待审', fill: '#FFF2CC', glow: '#ffbf2e', i: 1.25, who: 'Agent' },
  idea: { name: '你的想法', fill: '#DAE8FC', glow: '#3f8fff', i: 1.3, who: '你' },
  confirmed: { name: '已确认', fill: '#D5E8D4', glow: '#2fd36b', i: 1.2, who: '你' },
  issue: { name: '有问题', fill: '#F8CECC', glow: '#ff4545', i: 1.3, who: '你' },
  plan_delete: { name: '计划删除', fill: '#F5F5F5', glow: '#aab4c0', i: 1.4, who: 'Agent', dash: true },
  confirm_delete: { name: '确认删除', fill: '#D5E8D4', glow: '#2fd36b', i: 1.2, who: '你', dash: true },
  unknown: { name: '未识别颜色', fill: '#c9ced6', glow: '#8b949e', i: 1 },
};
for (const s of Object.values(S)) { s.fc = new THREE.Color(s.fill); s.gc = new THREE.Color(s.glow); }
const ORDER = ['none', 'review', 'idea', 'confirmed', 'issue', 'plan_delete', 'confirm_delete'];

/* ---------- 渲染器与后期：HDR 渲染 → 泛光 → 暗角与轻微色散 → ACES 色调映射 ---------- */
const W = 1920, H = 1080;
const renderer = new THREE.WebGLRenderer({ canvas: $('gl'), antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#04060b');
scene.fog = new THREE.FogExp2('#04060b', .016);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), .04).texture;
scene.environmentIntensity = .35;
const camera = new THREE.PerspectiveCamera(40, W / H, .1, 400);
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: 4 }));
composer.setPixelRatio(1);
const VS_UV = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }';
composer.addPass(new RenderPass(scene, camera));
// 泛光前清掉个别 NaN / 过亮像素，否则会被泛光放大成整块方斑
composer.addPass(new ShaderPass({
  uniforms: { tDiffuse: { value: null } },
  vertexShader: VS_UV,
  fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      if (any(isnan(c.rgb)) || any(isinf(c.rgb))) c.rgb = vec3(0.);
      gl_FragColor = vec4(clamp(c.rgb, 0., 16.), 1.);
    }`,
}));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(W, H), .75, .5, 1.0));
composer.addPass(new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uAber: { value: .0025 } },
  vertexShader: VS_UV,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uAber; varying vec2 vUv;
    void main(){
      vec2 c = vUv - .5; float d = dot(c, c); vec2 o = c * uAber * (1. + d * 4.);
      vec3 col = vec3(texture2D(tDiffuse, vUv + o).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - o).b);
      col *= mix(1., .55, smoothstep(.12, .55, d));
      gl_FragColor = vec4(col, 1.);
    }`,
}));
composer.addPass(new OutputPass());

scene.add(new THREE.HemisphereLight('#a8c4ff', '#0b0e16', 1.0));
const keyLight = new THREE.DirectionalLight('#ffffff', 1.8);
keyLight.position.set(6, 10, 12);
const rimLight = new THREE.DirectionalLight('#5b8cff', 1.2);
rimLight.position.set(-10, 4, -8);
scene.add(keyLight, rimLight);

/* ---------- 着色器 ---------- */
// 圆角矩形外发光 + 边缘高光；uDash=1 时沿周长做虚线，对应删除类状态。
const FS_HALO = `uniform vec3 uColor; uniform float uI; uniform vec2 uHalf; uniform float uR; uniform float uPad; uniform float uDash; uniform float uTime;
  varying vec2 vUv;
  float sdRound(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r; }
  void main(){
    vec2 p = (vUv - .5) * 2. * (uHalf + uPad);
    float d = sdRound(p, uHalf, uR);
    float rim = 1. - smoothstep(0., .05, abs(d));
    float outer = d > 0. ? exp(-d * 5.) * .4 : 0.;
    float dash = uDash > .5 ? step(.5, fract(atan(p.y, p.x + 1e-5) * 9.5493 + uTime * .4)) : 1.;
    gl_FragColor = vec4(uColor * (rim * dash + outer * mix(1., .6, uDash)) * uI, 1.);
  }`;
const BURST_VS = `attribute vec3 aDir; attribute float aSeed;
  uniform float uAge; uniform float uLife; uniform float uSpeed; uniform float uR0; uniform float uSize; uniform vec3 uScale;
  varying float vA;
  void main(){
    float k = clamp(uAge / uLife, 0., 1.);
    vec3 p = aDir * uScale * (uR0 + uSpeed * (1. - exp(-3. * uAge)) * (.5 + aSeed));
    p.y -= .35 * uAge * uAge;
    vec4 mv = modelViewMatrix * vec4(p, 1.);
    gl_PointSize = min(uSize * (1. - k * .7) * (.5 + aSeed) * (400. / -mv.z), 24.);
    vA = (1. - k) * (1. - k);
    gl_Position = projectionMatrix * mv;
  }`;
const FS_DOT = `uniform vec3 uColor; varying float vA;
  void main(){ float d = length(gl_PointCoord - .5); float a = 1. - smoothstep(0., .5, d); gl_FragColor = vec4(uColor * a * a * vA, 1.); }`;
const DUST_VS = `attribute float aSeed; uniform float uTime; varying float vA;
  void main(){
    vec3 p = position;
    p.y = -3.5 + mod(p.y + 3.5 + uTime * (.08 + aSeed * .14), 22.);
    p.x += sin(uTime * .2 + aSeed * 30.) * .5; p.z += cos(uTime * .17 + aSeed * 20.) * .5;
    vec4 mv = modelViewMatrix * vec4(p, 1.);
    float z = -mv.z;
    gl_PointSize = min((1.2 + aSeed * 2.2) * (220. / z), 12.);
    vA = (.4 + .6 * (.5 + .5 * sin(uTime * (1. + aSeed * 2.) + aSeed * 60.))) * (1. - smoothstep(10., 60., z)) * smoothstep(1.5, 5., z);
    gl_Position = projectionMatrix * mv;
  }`;
// 汇聚粒子：从随机位置螺旋飞向目标点（开场标题、结尾书本）。
const CONV_VS = `attribute vec3 aStart; attribute float aDelay; attribute float aSeed;
  uniform float uTime; uniform float uP0; uniform float uDur; uniform float uFade; uniform float uSize;
  varying float vA;
  void main(){
    float p = clamp((uTime - uP0 - aDelay) / uDur, 0., 1.);
    p = 1. - pow(1. - p, 3.);
    vec3 off = (aStart - position) * (1. - p);
    float sw = (1. - p) * 2.6;
    off.xz = mat2(cos(sw), -sin(sw), sin(sw), cos(sw)) * off.xz;
    vec3 pos = position + off + vec3(sin(uTime * 2. + aSeed * 40.), cos(uTime * 1.7 + aSeed * 30.), sin(uTime * 1.3 + aSeed * 20.)) * .025 * p;
    vec4 mv = modelViewMatrix * vec4(pos, 1.);
    gl_PointSize = min(uSize * (300. / -mv.z) * (.5 + aSeed), 20.);
    vA = uFade * (.3 + .7 * p) * (.6 + .4 * sin(uTime * 3. + aSeed * 50.));
    gl_Position = projectionMatrix * mv;
  }`;
const FLOOR_VS = 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }';
const FLOOR_FS = `uniform vec3 uCam; uniform vec4 uPools[6]; uniform vec3 uPoolC[6]; uniform vec4 uRipple; uniform float uTime;
  varying vec3 vW;
  float grid(vec2 p, float s){ vec2 q = p / s; vec2 g = abs(fract(q - .5) - .5) / max(fwidth(q), vec2(1e-4)); return 1. - min(min(g.x, g.y), 1.); }
  void main(){
    vec2 p = vW.xz;
    float fade = exp(-length(vW.xz - uCam.xz) * .045);
    vec3 col = vec3(.16, .32, .6) * (grid(p, 1.6) * .3 + grid(p, 8.) * .55) * fade;
    for (int i = 0; i < 6; i++) {
      float d = length(p - uPools[i].xy);
      col += uPoolC[i] * exp(-d * d / (uPools[i].z * uPools[i].z)) * uPools[i].w;
    }
    if (uRipple.w > 0.) {
      float age = uTime - uRipple.z;
      float d = abs(length(p - uRipple.xy) - age * 14.);
      col += vec3(.35, .65, 1.) * exp(-d * 2.5) * max(0., 1. - age / 2.) * 1.6 * (grid(p, 1.6) * .7 + .3);
    }
    gl_FragColor = vec4(col, 1.);
  }`;
const RAY_VS = 'varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ vUv = uv; vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }';
const RAY_FS = `uniform vec3 uColor; uniform float uI; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
  void main(){ float k = clamp(abs(dot(normalize(vN), normalize(vV))), 0., 1.); float core = k * k * k; float len = smoothstep(0., .7, vUv.y) * (1. - smoothstep(.9, 1., vUv.y)); gl_FragColor = vec4(uColor * core * len * uI, 1.); }`;
const SHIELD_VS = 'varying vec3 vN; varying vec3 vV; varying vec3 vP; void main(){ vP = position; vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }';
const SHIELD_FS = `uniform vec3 uColor; uniform float uReveal; uniform float uI; uniform float uTime;
  varying vec3 vN; varying vec3 vV; varying vec3 vP;
  void main(){
    float edge = uReveal * 2.2 - 1.1;
    if (vP.y > edge) discard;
    float f = pow(max(1. - abs(dot(vN, vV)), 0.), 2.5);
    float lat = abs(fract(vP.y * 7. + uTime * .15) - .5);
    float lon = abs(fract(atan(vP.z, vP.x + 1e-5) * 3.8197) - .5);
    float grid = (1. - smoothstep(0., .05, min(lat, lon))) * .6;
    float front = (1. - smoothstep(0., .12, edge - vP.y)) * 2.;
    gl_FragColor = vec4(uColor * (f * 1.2 + grid * (.2 + f) + front) * uI, 1.);
  }`;
const TITLE_FS = `uniform sampler2D map; uniform float uO; uniform float uSweep; varying vec2 vUv;
  void main(){ vec4 c = texture2D(map, vUv); float x = (vUv.x - uSweep + (vUv.y - .5) * .25) * 9.; float s = exp(-x * x) * 2.5; gl_FragColor = vec4(c.rgb * (1.15 + s), c.a * uO); }`;

/* ---------- 构件 ---------- */
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.userData.canvas = c;
  return tex;
}
function rr(g, x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }
function texPlane(w, h, tex, gain = 1) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.material.color.setScalar(gain);
  return m;
}
function makeHalo(w, h, pad = 1.2, r = .16) {
  return new THREE.Mesh(new THREE.PlaneGeometry(w + pad * 2, h + pad * 2), new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color('#3f8fff') }, uI: { value: 1 }, uHalf: { value: new THREE.Vector2(w / 2, h / 2) }, uR: { value: r }, uPad: { value: pad }, uDash: { value: 0 }, uTime: { value: 0 } },
    vertexShader: VS_UV, fragmentShader: FS_HALO, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
}
const boxCache = {};
const roundBox = (w, h, d) => boxCache[`${w},${h},${d}`] || (boxCache[`${w},${h},${d}`] = new RoundedBoxGeometry(w, h, d, 4, .16));
/** 节点卡片：圆角玻璃方块 + 外发光边框 + 文字贴图。 */
function makeCard(w, h, title, sub, d = .5) {
  const g = new THREE.Group();
  const mat = new THREE.MeshPhysicalMaterial({ color: '#808080', roughness: .45, clearcoat: 1, clearcoatRoughness: .18, emissive: '#ffffff', emissiveIntensity: .3, envMapIntensity: .6, transparent: true });
  const box = new THREE.Mesh(roundBox(w, h, d), mat);
  const halo = makeHalo(w, h);
  halo.position.z = d / 2 + .02;
  g.add(box, halo);
  let lab = null;
  if (title) {
    lab = texPlane(w, h, canvasTex(Math.round(w * 220), Math.round(h * 220), (c, cw, ch) => {
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillStyle = '#1f2328'; c.font = `700 ${sub ? 76 : 84}px ${FONT}`;
      c.fillText(title, cw / 2, sub ? ch * .4 : ch / 2);
      if (sub) { c.fillStyle = '#57606a'; c.font = `44px ${MONO}`; c.fillText(sub, cw / 2, ch * .73); }
    }));
    lab.position.z = d / 2 + .012;
    g.add(lab);
  }
  return { g, mat, halo, lab, w, h, d };
}
function paintCard(card, prev, cur, p, spike, t) {
  // 卡面亮度压在泛光阈值以下，保证文字清晰；发光交给外框与粒子
  card.mat.emissive.lerpColors(S[prev].fc, S[cur].fc, p);
  card.mat.color.copy(card.mat.emissive).multiplyScalar(.5);
  const u = card.halo.material.uniforms;
  u.uColor.value.lerpColors(S[prev].gc, S[cur].gc, p);
  u.uI.value = lerp(S[prev].i, S[cur].i, p) + spike;
  const dashed = !!S[p > .5 ? cur : prev].dash;
  u.uDash.value = dashed ? 1 : 0;
  u.uTime.value = t;
  card.mat.opacity = dashed ? .8 : 1;
}
function stateAt(list, t) {
  let prev = list[0][1], cur = prev, at = -99;
  for (const [ts, s] of list) if (t >= ts) { prev = cur; cur = s; at = ts; }
  return { prev, cur, p: E.out(seg(t, at, at + .35)), at };
}
const coneGeo = new THREE.ConeGeometry(.13, .3, 16);
const pulseGeo = new THREE.SphereGeometry(.085, 16, 12);
/** 连线：发光细管 + 箭头 + 沿线流动的光点；drawRange 控制画出进度。 */
function makeEdge(curve, color = '#4f86d9') {
  const segs = 32, radial = 8;
  const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.5), transparent: true });
  const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, .04, radial, false), mat);
  const head = new THREE.Mesh(coneGeo, mat);
  const dir = curve.getTangent(1);
  head.position.copy(curve.getPoint(1)).addScaledVector(dir, -.15);
  head.quaternion.setFromUnitVectors(V(0, 1, 0), dir);
  const pulseMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#bfe0ff').multiplyScalar(4), transparent: true });
  const pulses = [0, 1].map(() => new THREE.Mesh(pulseGeo, pulseMat));
  const g = new THREE.Group();
  g.add(tube, head, ...pulses);
  return { g, tube, head, mat, pulseMat, pulses, curve, segs, radial };
}
const line = (a, b) => new THREE.LineCurve3(a, b);
function drawEdge(e, p, t, pulse, phase = 0, opacity = 1) {
  e.g.visible = p > 0 && opacity > 0;
  e.tube.geometry.setDrawRange(0, Math.floor(e.segs * p) * e.radial * 6);
  e.head.visible = p > .97;
  e.mat.opacity = opacity;
  e.pulses.forEach((m, k) => {
    m.visible = pulse > 0 && p >= 1;
    const u = (t * .45 + k * .5 + phase) % 1;
    m.position.copy(e.curve.getPoint(u));
    m.scale.setScalar(.6 + .4 * Math.sin(u * Math.PI));
  });
  e.pulseMat.opacity = pulse * opacity;
}

/* ---------- 一次性特效：粒子爆发、冲击环、光球飞行 ---------- */
const bursts = [];
function addBurst(t, pos, color, { n = 160, speed = 2.4, life = 1.6, size = .22, scale = V(1, 1, 1), r0 = 0 } = {}) {
  const r = rng(Math.round(t * 1000) + n);
  const dir = new Float32Array(n * 3), sd = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    const m = r0 > 0 ? 1 : .3 + r() * .7;
    dir.set([s * Math.cos(a) * m, u * m, s * Math.sin(a) * m], i * 3);
    sd[i] = r();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(sd, 1));
  const pts = new THREE.Points(geo, new THREE.ShaderMaterial({
    uniforms: { uAge: { value: 0 }, uLife: { value: life }, uSpeed: { value: speed }, uScale: { value: scale }, uR0: { value: r0 }, uSize: { value: size }, uColor: { value: new THREE.Color(color).multiplyScalar(3) } },
    vertexShader: BURST_VS, fragmentShader: FS_DOT, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  pts.position.copy(pos);
  pts.frustumCulled = false;
  pts.visible = false;
  scene.add(pts);
  bursts.push({ t, pts, life });
}
const rings = [];
const ringGeo = new THREE.RingGeometry(.97, 1, 128);
function addRing(t, pos, color, { from = 1.4, to = 5, life = 1.1, gain = 3 } = {}) {
  const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(gain), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  m.position.copy(pos);
  m.visible = false;
  scene.add(m);
  rings.push({ t, m, from, to, life });
}
/** Agent 光球：沿贝塞尔曲线飞到目标，后面拖一串渐隐的尾迹。 */
const orb = new THREE.Mesh(new THREE.SphereGeometry(.2, 24, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffd27a').multiplyScalar(6) }));
const orbLight = new THREE.PointLight('#ffc451', 0, 5, 0);
orb.add(orbLight);
const trail = Array.from({ length: 16 }, (_, i) => new THREE.Mesh(orb.geometry, new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffb347').multiplyScalar(4 * (1 - i / 16)), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
scene.add(orb, ...trail);
const flights = [];
function addFlight(t, to) {
  const end = to.clone().add(V(0, 0, .4));
  flights.push({ t, curve: new THREE.QuadraticBezierCurve3(end.clone().add(V(11, 6, 8)), end.clone().add(V(4, 6.5, 4)), end) });
}
const ripples = [];

/* ---------- 环境：地面网格、漂浮尘埃、体积光束 ---------- */
const pools = [];
const floor = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), new THREE.ShaderMaterial({
  uniforms: { uCam: { value: new THREE.Vector3() }, uPools: { value: Array.from({ length: 6 }, () => new THREE.Vector4()) }, uPoolC: { value: Array.from({ length: 6 }, () => new THREE.Color()) }, uRipple: { value: new THREE.Vector4() }, uTime: { value: 0 } },
  vertexShader: FLOOR_VS, fragmentShader: FLOOR_FS, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
}));
floor.rotation.x = -Math.PI / 2;
floor.position.set(0, -3.5, -20);
scene.add(floor);
const dust = (() => {
  const n = 4200, r = rng(11), pos = new Float32Array(n * 3), sd = new Float32Array(n);
  for (let i = 0; i < n; i++) { pos.set([r() * 110 - 55, r() * 22 - 3.5, r() * 110 - 80], i * 3); sd[i] = r(); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(sd, 1));
  const p = new THREE.Points(geo, new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color('#5d8fd6').multiplyScalar(1.3) } }, vertexShader: DUST_VS, fragmentShader: FS_DOT.replace('varying float vA;', 'varying float vA;'), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  p.frustumCulled = false;
  scene.add(p);
  return p;
})();
const rays = [-7, .5, 8].map((x, i) => {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(.35, 4.2 + i * .6, 26, 40, 1, true), new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(['#4a7dff', '#7aa8ff', '#5f6dff'][i]) }, uI: { value: .14 } },
    vertexShader: RAY_VS, fragmentShader: RAY_FS, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  }));
  m.userData.x = x;
  scene.add(m);
  return m;
});

/** 汇聚粒子组：targets 为相对 center 的目标点。 */
function makeConverge(targets, center, { seed = 3, spread = 16, size = .09, color = '#8ec5ff', delay = 1.4 } = {}) {
  const r = rng(seed), n = targets.length;
  const pos = new Float32Array(n * 3), start = new Float32Array(n * 3), dl = new Float32Array(n), sd = new Float32Array(n);
  targets.forEach(([x, y, z], i) => {
    pos.set([x, y, z], i * 3);
    const u = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - u * u), d = spread * (.4 + r() * .6);
    start.set([s * Math.cos(a) * d, u * d * .6, s * Math.sin(a) * d], i * 3);
    dl[i] = r() * delay; sd[i] = r();
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aStart', new THREE.BufferAttribute(start, 3));
  geo.setAttribute('aDelay', new THREE.BufferAttribute(dl, 1));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(sd, 1));
  const p = new THREE.Points(geo, new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uP0: { value: 0 }, uDur: { value: 2.8 }, uFade: { value: 1 }, uSize: { value: size }, uColor: { value: new THREE.Color(color).multiplyScalar(2.2) } },
    vertexShader: CONV_VS, fragmentShader: FS_DOT, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  p.position.copy(center);
  p.frustumCulled = false;
  scene.add(p);
  return p;
}

/* ---------- 开场：粒子汇成标题 ---------- */
const TITLE_C = V(0, 2.6, -60);
const titleG = new THREE.Group();
const titleTex = canvasTex(1600, 300, (g, w, h) => {
  g.fillStyle = '#e8f1ff'; g.font = `600 220px ${NUM}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('Flow Coding', w / 2, h / 2 + 6);
});
const titleMat = new THREE.ShaderMaterial({ uniforms: { map: { value: titleTex }, uO: { value: 0 }, uSweep: { value: -1 } }, vertexShader: VS_UV, fragmentShader: TITLE_FS, transparent: true, depthWrite: false });
const titlePlane = new THREE.Mesh(new THREE.PlaneGeometry(10, 1.875), titleMat);
titlePlane.position.copy(TITLE_C);
titleG.add(titlePlane);
scene.add(titleG);
const titlePts = (() => {
  const c = titleTex.userData.canvas, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const cand = [];
  for (let y = 0; y < c.height; y += 3) for (let x = 0; x < c.width; x += 3) if (d[(y * c.width + x) * 4 + 3] > 140) cand.push([(x - 800) / 160, -(y - 150) / 160, 0]);
  const r = rng(5);
  const pick = cand.filter(() => r() < 3200 / cand.length);
  return makeConverge(pick, TITLE_C, { seed: 7, spread: 18, size: .16 });
})();
addBurst(T.titleHit, TITLE_C, '#7cc4ff', { n: 420, speed: 7, life: 2.2, size: .2 });
addRing(T.titleHit, TITLE_C.clone().add(V(0, 0, .1)), '#7cc4ff', { from: 2, to: 16, life: 1.6, gain: 2.5 });
ripples.push([T.titleHit, 0, -60]);

/* ---------- 为什么：三座孤岛连到一张图 ---------- */
const PROB = V(-30, 1.5, -30);
const probG = new THREE.Group();
scene.add(probG);
function islandTex(kind) {
  return canvasTex(792, 528, (g, w, h) => {
    g.fillStyle = 'rgba(12,17,27,.94)'; rr(g, 4, 4, w - 8, h - 8, 36); g.fill();
    g.strokeStyle = 'rgba(160,200,255,.28)'; g.lineWidth = 3; g.stroke();
    g.textBaseline = 'top'; g.fillStyle = '#dfe7f1'; g.font = `700 46px ${FONT}`;
    g.fillText({ doc: '需求.md', code: '代码仓库', term: 'Agent 终端' }[kind], 48, 44);
    if (kind === 'doc') {
      g.fillStyle = '#2b3442';
      [[48, 150, 520], [48, 200, 640], [48, 250, 460], [48, 330, 600], [48, 380, 380]].forEach(([x, y, l]) => { rr(g, x, y, l, 22, 11); g.fill(); });
      g.fillStyle = '#5b6b80'; g.font = `600 34px ${FONT}`; g.fillText('## 验收标准', 48, 420);
    } else if (kind === 'code') {
      const cols = ['#ff7b72', '#79c0ff', '#d2a8ff', '#7ee787', '#ffa657'];
      [[48, 150, [90, 220, 160]], [80, 200, [140, 300]], [80, 250, [110, 180, 120]], [112, 300, [260, 140]], [80, 350, [200]], [48, 400, [70]]].forEach(([x, y, parts], k) => {
        let px = x;
        parts.forEach((l, j) => { g.fillStyle = cols[(k + j) % 5]; rr(g, px, y, l, 22, 11); g.fill(); px += l + 18; });
      });
    } else {
      g.font = `38px ${MONO}`; g.fillStyle = '#6cb6ff'; g.fillText('❯', 48, 160);
      g.fillStyle = '#c9d1d9'; g.fillText('这次要改哪里？', 96, 160);
      g.fillStyle = '#7d8590'; g.fillText('  需求在哪份文档…', 48, 230);
      g.fillText('  哪段代码对应…', 48, 300);
      g.fillStyle = '#6cb6ff'; g.fillText('❯ ▍', 48, 380);
    }
  });
}
const islands = [['doc', -4.6, 2.7, '#3f8fff'], ['code', 0, 3.3, '#b07cff'], ['term', 4.6, 2.7, '#ffbf2e']].map(([kind, x, y, color], i) => {
  const g = new THREE.Group();
  const plane = texPlane(3.6, 2.4, islandTex(kind), .92);
  const halo = makeHalo(3.6, 2.4);
  halo.material.uniforms.uColor.value.set(color);
  halo.position.z = .02;
  g.add(plane, halo);
  g.position.set(PROB.x + x, PROB.y + y, PROB.z);
  g.rotation.y = -x * .05;
  probG.add(g);
  addBurst(T.islands[i], g.position, color, { n: 90, speed: 1.6, life: 1.2, size: .16 });
  return { g, halo, y: PROB.y + y, x: PROB.x + x, color };
});
const core = makeCard(3.4, 1.4, '流程图', 'docs/flow/*.drawio');
core.g.position.set(PROB.x, PROB.y - 2.1, PROB.z + 1);
probG.add(core.g);
const probLinks = islands.map((isl, i) => {
  const a = V(isl.x, isl.y - 1.2, PROB.z), b = core.g.position.clone().add(V((i - 1) * 1.1, .72, 0));
  const e = makeEdge(new THREE.QuadraticBezierCurve3(a, V(lerp(a.x, b.x, .5), lerp(a.y, b.y, .2), PROB.z + .5), b), isl.color);
  probG.add(e.g);
  return e;
});
addBurst(T.core, core.g.position, '#3f8fff', { n: 260, speed: 4, life: 1.8 });
addRing(T.core, core.g.position.clone().add(V(0, 0, .3)), '#6cb6ff', { from: 1.6, to: 7, life: 1.3 });
ripples.push([T.core, PROB.x, PROB.z + 1]);

/* ---------- 主流程图：五个节点，颜色随协作循环变化 ---------- */
const graphG = new THREE.Group();
scene.add(graphG);
const NODES = {
  A: { p: V(-9.6, 1.5, 0), title: '点击刷新', sub: 'v_main.on_refresh', show: 39.6 },
  B: { p: V(-4.8, 1.5, 0), title: '校验输入', sub: 'v_main.check_input', show: 39.9 },
  C: { p: V(0, 1.5, 0), title: '查询缓存', sub: 'm_main.query', show: 40.2 },
  D: { p: V(4.8, 1.5, 0), title: '返回结果', sub: 'v_main.render', show: 40.5 },
  E: { p: V(0, -1.8, 0), title: '落盘日志', sub: 'm_main.log', show: 40.8 },
};
const LOOP = T.loop.map((e, i) => ({ ...e, at: e.who === 'you' ? e.t + .45 : e.t, a: e.t - .3, b: i < T.loop.length - 1 ? T.loop[i + 1].t - .35 : T.shatter + 1.4, i }));
for (const [id, n] of Object.entries(NODES)) {
  n.id = id;
  n.card = makeCard(3.4, 1.4, n.title, n.sub);
  n.card.g.position.copy(n.p);
  graphG.add(n.card.g);
  n.states = [[-1, 'none'], ...LOOP.filter((e) => e.node === id).map((e) => [e.at, e.state])];
  if (id === 'C') n.states.push([T.agentEdit, 'review']);
  n.states.sort((a, b) => a[0] - b[0]);
  n.flash = T.nodeFlash['ABCDE'.indexOf(id)];
  addBurst(n.flash, n.p, '#8fc2ff', { n: 70, speed: 1.4, life: 1, size: .14 });
}
for (const e of LOOP) {
  const n = NODES[e.node];
  addBurst(e.at, n.p, S[e.state].glow, { n: 200, speed: 2.8, life: 1.7 });
  addRing(e.at, n.p.clone().add(V(0, 0, .3)), S[e.state].glow, { from: 1.6, to: 3.4, life: .9, gain: 2 });
  if (e.who === 'agent') addFlight(e.t, n.p);
}
addFlight(T.agentEdit, NODES.C.p);
addBurst(T.agentEdit, NODES.C.p, S.review.glow, { n: 200, speed: 2.8, life: 1.7 });
addRing(T.agentEdit, NODES.C.p.clone().add(V(0, 0, .3)), S.review.glow, { from: 1.6, to: 3.4, life: .9, gain: 2 });
const EDGES = [
  { e: makeEdge(line(V(-7.9, 1.5, 0), V(-6.5, 1.5, 0))), at: 40.4 },
  { e: makeEdge(line(V(-3.1, 1.5, 0), V(-1.7, 1.5, 0))), at: 40.8 },
  { e: makeEdge(line(V(1.7, 1.5, 0), V(3.1, 1.5, 0))), at: 41.2 },
  { e: makeEdge(line(V(0, .8, 0), V(0, -1.1, 0))), at: 41.6, del: true },
];
EDGES.forEach(({ e }) => graphG.add(e.g));
// 有问题时的便签，连到「返回结果」
const note = new THREE.Group();
const noteTex = canvasTex(616, 264, (g, w, h) => {
  g.fillStyle = '#fff2cc'; g.beginPath(); g.moveTo(8, 8); g.lineTo(w - 70, 8); g.lineTo(w - 8, 70); g.lineTo(w - 8, h - 8); g.lineTo(8, h - 8); g.closePath(); g.fill();
  g.fillStyle = '#e8d49a'; g.beginPath(); g.moveTo(w - 70, 8); g.lineTo(w - 70, 70); g.lineTo(w - 8, 70); g.closePath(); g.fill();
  g.fillStyle = '#3d3418'; g.font = `600 46px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('这里 SQL 少了时间过滤', w / 2 - 14, h / 2 + 6);
});
const notePlane = texPlane(2.8, 1.2, noteTex, .95);
const noteLink = makeEdge(line(V(4.8, 3.0, .2), V(4.8, 2.25, .2)), '#d6b656');
note.add(notePlane, noteLink.g);
notePlane.position.set(4.8, 3.65, .25);
graphG.add(note);
// 书签与图链接角标（与 App 中一致：右上角并排）
const bookmark = texPlane(.36, .45, canvasTex(160, 200, (g) => {
  g.fillStyle = '#1f7bff'; g.strokeStyle = '#fff'; g.lineWidth = 8;
  g.beginPath(); g.moveTo(8, 8); g.lineTo(152, 8); g.lineTo(152, 192); g.lineTo(80, 145); g.lineTo(8, 192); g.closePath(); g.fill(); g.stroke();
  g.fillStyle = '#fff'; g.font = `700 92px ${NUM}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('1', 80, 82);
}), 1.5);
const BM_POS = NODES.C.p.clone().add(V(1.33, .43, .27));
bookmark.position.copy(BM_POS);
graphG.add(bookmark);
const linkBadge = texPlane(.4, .4, canvasTex(180, 180, (g) => {
  g.fillStyle = '#ffffff'; g.strokeStyle = '#57606a'; g.lineWidth = 8; rr(g, 6, 6, 168, 168, 32); g.fill(); g.stroke();
  g.strokeStyle = '#24292f'; g.lineWidth = 15; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(52, 128); g.lineTo(124, 56); g.moveTo(66, 56); g.lineTo(124, 56); g.lineTo(124, 114); g.stroke();
}), 1.2);
const LB_POS = NODES.C.p.clone().add(V(.82, .43, .27));
linkBadge.position.copy(LB_POS);
graphG.add(linkBadge);
addBurst(T.bookmark, BM_POS, '#3f8fff', { n: 90, speed: 1.2, life: 1, size: .14 });
addBurst(T.linkBadge, LB_POS, '#bcd4ff', { n: 90, speed: 1.2, life: 1, size: .14 });
addRing(T.featBeam + .5, NODES.C.p.clone().add(V(0, 0, .3)), '#6cb6ff', { from: 1.8, to: 4.5 });
// 删除节点碎裂
const FRAG_N = 72;
const frag = new THREE.InstancedMesh(new THREE.BoxGeometry(.26, .26, .22), new THREE.MeshPhysicalMaterial({ color: S.confirm_delete.fill, emissive: S.confirm_delete.glow, emissiveIntensity: .5, roughness: .4, transparent: true }), FRAG_N);
frag.frustumCulled = false;
graphG.add(frag);
const fragData = (() => {
  const r = rng(21);
  return Array.from({ length: FRAG_N }, (_, i) => ({
    o: V((i % 12) / 11 * 3.1 - 1.55, Math.floor(i / 12) / 5 * 1.1 - .55, (r() - .5) * .3),
    v: V((r() - .5) * 2.4, r() * 1.6 - .2, r() * 2.2 + .4),
    axis: V(r() - .5, r() - .5, r() - .5).normalize(), spin: (r() - .5) * 14,
  }));
})();
addBurst(T.shatter, NODES.E.p, S.confirm_delete.glow, { n: 360, speed: 4.5, life: 2 });
addRing(T.shatter, NODES.E.p.clone().add(V(0, 0, .3)), S.confirm_delete.glow, { from: 1.8, to: 4.6, life: 1.2, gain: 2 });
ripples.push([T.shatter, 0, 0]);
// Agent 加锁护罩
const shield = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), new THREE.ShaderMaterial({
  uniforms: { uColor: { value: new THREE.Color('#ffb02e') }, uReveal: { value: 0 }, uI: { value: 0 }, uTime: { value: 0 } },
  vertexShader: SHIELD_VS, fragmentShader: SHIELD_FS, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
}));
const SHIELD_R = V(11.5, 5.6, 4.2);
shield.scale.copy(SHIELD_R);
shield.position.set(-2.4, 0, 0);
graphG.add(shield);
addBurst(T.unlocked, shield.position, '#ffb02e', { n: 900, speed: .6, life: 2, size: .18, scale: SHIELD_R, r0: 1 });
ripples.push([T.unlocked, -2.4, 0]);

/* ---------- 子流程（图间链接） ---------- */
const subG = new THREE.Group();
scene.add(subG);
const SUB = [['读取缓存键', 'none'], ['命中？', 'review'], ['回源查询', 'none'], ['写回缓存', 'confirmed']].map(([title, st], i) => {
  const c = makeCard(3.2, 1.4, title, null);
  c.g.position.set(-6.3 + i * 4.2, 1.5, -30);
  paintCard(c, st, st, 1, 0, 0);
  subG.add(c.g);
  return c;
});
const subEdges = [0, 1, 2].map((i) => {
  const e = makeEdge(line(V(-6.3 + i * 4.2 + 1.6, 1.5, -30), V(-6.3 + (i + 1) * 4.2 - 1.6, 1.5, -30)), '#3fc1d9');
  subG.add(e.g);
  return e;
});

/* ---------- 节点颜色：七色弧形排开 ---------- */
const PAL = V(34, 1.5, -6);
const palG = new THREE.Group();
scene.add(palG);
const tiles = ORDER.map((k, i) => {
  const a = (i - 3) * .22, R = 12;
  const g = new THREE.Group();
  g.position.set(PAL.x + R * Math.sin(a), PAL.y, PAL.z + 12 - R * Math.cos(a));
  g.rotation.y = -a;
  const card = makeCard(2, 2, null, null, .3);
  const lab = texPlane(2.9, 1.3, canvasTex(640, 287, (c, w) => {
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#e6edf3'; c.font = `700 80px ${FONT}`; c.fillText(S[k].name, w / 2, 70);
    const you = S[k].who === '你';
    const label = you ? '你来标记' : 'Agent 标记';
    c.font = `600 46px ${FONT}`;
    const tw = c.measureText(label).width + 52;
    c.fillStyle = you ? 'rgba(68,147,248,.34)' : 'rgba(242,200,80,.3)'; rr(c, w / 2 - tw / 2, 160, tw, 76, 38); c.fill();
    c.fillStyle = you ? '#b5d6ff' : '#f9e08f'; c.fillText(label, w / 2, 199);
  }), .9);
  lab.position.set(0, -1.85, 0);
  g.add(card.g, lab);
  palG.add(g);
  const at = T.palette0 + i * T.paletteStep;
  addBurst(at, g.position, S[k].glow, { n: 140, speed: 2, life: 1.4 });
  return { g, card, lab, k, at, y: PAL.y };
});

/* ---------- 状态统计：柱子从地面升起 ---------- */
const ST = V(30, -3.5, -30);
const statsG = new THREE.Group();
scene.add(statsG);
const barGeo = new THREE.BoxGeometry(1.3, 1, 1.3).translate(0, .5, 0);
const capGeo = new THREE.PlaneGeometry(1.3, 1.3).rotateX(-Math.PI / 2);
const BARS = [['review', 4], ['idea', 2], ['confirmed', 5], ['issue', 1], ['plan_delete', 0], ['confirm_delete', 0], ['unknown', 3]].map(([k, v], i) => {
  const x = ST.x + (i - 3) * 2.2;
  const mesh = new THREE.Mesh(barGeo, new THREE.MeshPhysicalMaterial({ color: S[k].fill, emissive: S[k].fill, emissiveIntensity: .25, roughness: .35, clearcoat: .6, transparent: true, opacity: .92 }));
  mesh.position.set(x, ST.y, ST.z);
  const cap = new THREE.Mesh(capGeo, new THREE.MeshBasicMaterial({ color: S[k].gc.clone().multiplyScalar(2.5), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  cap.position.set(x, ST.y, ST.z);
  const top = texPlane(1.4, .7, canvasTex(280, 140, (c, w, h) => { c.fillStyle = '#e6edf3'; c.font = `600 100px ${NUM}`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(String(v), w / 2, h / 2 + 4); }), .9);
  const name = texPlane(2.1, .55, canvasTex(420, 110, (c, w, h) => { c.fillStyle = '#b8c4d4'; c.font = `600 54px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(S[k].name, w / 2, h / 2); }), .9);
  name.position.set(x, ST.y + .4, ST.z + 1.3);
  statsG.add(mesh, cap, top, name);
  return { k, v, x, h: Math.max(v, .06) / 5 * 5.5, mesh, cap, top, name };
});
const bigStat = texPlane(3.6, 2, canvasTex(720, 400, (c, w) => {
  c.textAlign = 'center'; c.fillStyle = '#9da7b3'; c.font = `600 64px ${FONT}`; c.fillText('已实现', w / 2, 110);
  c.fillStyle = '#e6f1ff'; c.font = `600 200px ${NUM}`; c.fillText('335', w / 2, 330);
}), 1.1);
bigStat.position.set(ST.x - 10.4, ST.y + 4.6, ST.z);
statsG.add(bigStat);
const REVIEW_TOP = () => V(BARS[0].x, ST.y + BARS[0].h + .2, ST.z);
addRing(T.filter, V(BARS[0].x, ST.y + BARS[0].h + .05, ST.z + .7), S.review.glow, { from: 1, to: 3.2, life: 1 });
addBurst(T.filter, V(BARS[0].x, ST.y + BARS[0].h, ST.z), S.review.glow, { n: 160, speed: 2, life: 1.4 });

/* ---------- 历史快照：沿光轨排开 ---------- */
const HIST = V(-34, .8, -8);
const HIST_CAM = V(-38, 2.6, 1);
const histG = new THREE.Group();
scene.add(histG);
const SNAPS = [
  ['09:58', '用户保存', { C: 'none', D: 'none', E: 'none' }],
  ['10:24', '用户保存', { C: 'none', D: 'issue', E: 'none' }],
  ['10:47', 'Agent 解锁后同步', { C: 'review', D: 'review', E: 'plan_delete' }],
  ['11:02', 'Agent 解锁后同步', { C: 'review', D: 'review' }],
].map(([time, src, st], i) => {
  const g = new THREE.Group();
  g.position.copy(HIST).add(V(i * 3.7, i * .12, -i * 2.4));
  g.lookAt(HIST_CAM.x, g.position.y, HIST_CAM.z);
  const plane = texPlane(3, 2, canvasTex(660, 440, (c, w, h) => {
    c.fillStyle = 'rgba(10,14,22,.94)'; rr(c, 4, 4, w - 8, h - 8, 30); c.fill();
    c.strokeStyle = 'rgba(160,200,255,.25)'; c.lineWidth = 3; c.stroke();
    c.fillStyle = '#e6edf3'; c.font = `600 60px ${NUM}`; c.textBaseline = 'top'; c.fillText(time, 36, 30);
    c.fillStyle = '#8b96a5'; c.font = `30px ${FONT}`; c.fillText(src, 36, 104);
    for (const [id, n] of Object.entries(NODES)) {
      const s = id in st ? st[id] : (id === 'E' ? null : 'none');
      if (!s) continue;
      const x = 120 + (n.p.x + 9.6) / 14.4 * 420, y = 230 + (1.5 - n.p.y) / 3.3 * 130;
      c.fillStyle = S[s].fill; rr(c, x - 48, y - 22, 96, 44, 9); c.fill();
      if (S[s].dash) { c.setLineDash([8, 6]); c.strokeStyle = '#6e7681'; c.lineWidth = 3; c.stroke(); c.setLineDash([]); }
    }
    c.strokeStyle = '#4f6a90'; c.lineWidth = 3;
    c.beginPath(); c.moveTo(168, 230); c.lineTo(212, 230); c.moveTo(308, 230); c.lineTo(352, 230); c.moveTo(448, 230); c.lineTo(492, 230); c.stroke();
  }), .95);
  const halo = makeHalo(3, 2, 1.0, .14);
  halo.position.z = .02;
  g.add(plane, halo);
  histG.add(g);
  return { g, halo, base: g.position.clone(), at: T.snaps + i * .35 };
});
const rail = makeEdge(new THREE.CatmullRomCurve3(SNAPS.map((s) => s.base.clone().add(V(0, -1.35, 0)))), '#4f86d9');
histG.add(rail.g);
[[1, T.pick[0]], [3, T.pick[1]]].forEach(([i, at]) => addBurst(at, SNAPS[i].base, '#3f8fff', { n: 120, speed: 1.6, life: 1.2 }));

/* ---------- 结尾：粒子汇成书本 ---------- */
const BOOK_C = V(0, 3.92, -60);
const bookPts = (() => {
  const path = document.querySelector('#book path'), len = path.getTotalLength(), r = rng(9), pts = [];
  for (let i = 0; i < 1600; i++) {
    const q = path.getPointAtLength(len * i / 1600);
    pts.push([(q.x - 12) * .0786 + (r() - .5) * .03, -(q.y - 12.5) * .0786 + (r() - .5) * .03, (r() - .5) * .05]);
  }
  return makeConverge(pts, BOOK_C, { seed: 13, spread: 12, size: .06, delay: 1.0 });
})();
bookPts.material.uniforms.uP0.value = T.book - 2.6;
bookPts.material.uniforms.uDur.value = 2.2;
addBurst(T.book, BOOK_C, '#7cc4ff', { n: 300, speed: 4, life: 2 });
ripples.push([T.book, 0, -60]);

/* ---------- 镜头：[t, 位置 xyz, 目标 xyz, fov, 本段缓动] ---------- */
const CAM = [
  [0, 0, 2.8, -28, 0, 2.3, -60, 40],
  [4.8, 0, 2.3, -43, 0, 2.3, -60, 40, 'out'],
  [10.8, 0, 2.2, -46, 0, 2.3, -60, 40],
  [12.2, -30, 2.6, -15, -30, 1.4, -30, 40],
  [17.6, -27.5, 2.9, -15.5, -30, 1.3, -30, 40],
  [23.4, -32.5, 3.4, -16, -30, 1.1, -30, 40],
  [24.6, -12, 3.2, 6, -16, -3.5, -14, 46],
  [37.6, -18, 3.6, 6.5, -16, -3.5, -14, 46],
  [39.2, 2.4, 3.4, 17, -2.4, .2, 0, 40],
  [45.4, -3.8, 2.6, 17, -2.4, .2, 0, 40],
  [52.0, -4.8, 1.8, 16.6, -2.4, .1, 0, 40],
  [53.4, 34, 2.6, 12, 34, 1.0, -6, 44],
  [60.0, 33, 2.2, 11.6, 34, .9, -6, 44],
  [66.4, 35.2, 3.0, 11.8, 34, .8, -6, 44],
  [67.8, -2, 3.2, 21, 2, .4, 0, 40],
  [69.2, 3.5, 1.9, 13, 5.5, .3, 0, 40],
  [87.8, 3.0, 1.7, 12.2, 5.5, .3, 0, 40],
  [88.8, 6.3, 2.1, 13, 8.3, .6, 0, 40],
  [96.2, 5.9, 1.9, 12.6, 8.3, .6, 0, 40],
  [97.2, 1.5, -.4, 13, 3.5, -1.9, 0, 40],
  [104.6, 1.0, -.1, 13.8, 3.5, -1.6, 0, 40],
  [105.8, 33, 3.5, -9, 30, -.5, -30, 40],
  [112.6, 31.5, 3.2, -9.2, 30, -.6, -30, 40],
  [114.4, 37, 3.0, -9.5, 35, -.6, -30, 40],
  [121.6, 38, 3.4, -9.8, 35, -.8, -30, 40],
  [122.8, 1.5, 2.6, 13, 4.0, 1.2, 0, 40],
  [141.6, 1.2, 2.4, 12.4, 4.0, 1.2, 0, 40],
  [143.4, .4, 1.9, 10, .6, 1.5, 0, 40],
  [144.2, 0, 1.6, 9, 0, 1.5, 0, 40],
  [145.1, 0, 1.5, .4, 0, 1.5, -5, 40, 'in'],
  [145.101, 0, 1.6, -27.5, 0, 1.5, -40, 40],
  [146.0, 0, 1.9, -17, 0, 1.3, -30, 40, 'out'],
  [149.6, .8, 2.2, -16.4, 0, 1.3, -30, 40],
  [150.7, 0, 1.6, -4, 0, 1.4, -30, 40, 'in'],
  [150.701, 0, 1.5, .7, 0, 1.5, -1, 40],
  [151.8, 0, 1.9, 10, 0, 1.3, 0, 40, 'out'],
  [153.4, 3.3, 3.0, 26, 5, .6, 0, 40],
  [169.6, 2.6, 2.6, 25, 5, .6, 0, 40],
  [171.0, HIST_CAM.x, HIST_CAM.y, HIST_CAM.z, -25.5, .8, -12, 40],
  [181.6, HIST_CAM.x + .8, HIST_CAM.y - .3, HIST_CAM.z - .6, -25.5, .8, -12, 40],
  [183.2, 0, 2.6, -46, 0, 2.6, -60, 40],
  [194.4, 0, 2.6, -46, 0, 2.6, -60, 40],
];
function cameraAt(t) {
  let i = 0;
  while (i < CAM.length - 2 && t >= CAM[i + 1][0]) i++;
  const a = CAM[i], b = CAM[i + 1];
  const p = E[b[8] || 'io'](seg(t, a[0], b[0]));
  return [1, 2, 3, 4, 5, 6, 7].map((j) => lerp(a[j], b[j], p));
}
const _v = new THREE.Vector3();
/** 世界坐标 → 屏幕像素。 */
function project(p) { _v.copy(p).project(camera); return [(_v.x + 1) / 2 * W, (1 - _v.y) / 2 * H]; }

/* ---------- 3D 每帧更新 ---------- */
function updateWorld(t, target) {
  pools.length = 0;
  dust.material.uniforms.uTime.value = t;
  rays.forEach((m, i) => {
    m.position.set(target.x + m.userData.x, 9.5, target.z - 4);
    m.rotation.z = Math.sin(t * .2 + i * 2) * .12 + (i - 1) * .08;
    m.material.uniforms.uI.value = .13 + .05 * Math.sin(t * .5 + i);
  });

  // 开场
  titleG.visible = titlePts.visible = t < 12.4;
  if (titleG.visible) {
    titlePts.material.uniforms.uTime.value = t;
    titlePts.material.uniforms.uP0.value = .4;
    titlePts.material.uniforms.uFade.value = 1 - seg(t, 5.0, 7.0) * .75 - seg(t, 10.6, 11.8) * .25;
    titleMat.uniforms.uO.value = E.out(seg(t, T.titleHit - .1, T.titleHit + .6)) * (1 - seg(t, 10.8, 11.8));
    titleMat.uniforms.uSweep.value = t < 8 ? lerp(-.3, 1.3, seg(t, 5.0, 6.8)) : lerp(-.3, 1.3, seg(t, 8.8, 10.4));
  }

  // 为什么
  probG.visible = t > 11 && t < 25;
  if (probG.visible) {
    islands.forEach((isl, i) => {
      isl.g.scale.setScalar(Math.max(E.spring(seg(t, T.islands[i], T.islands[i] + .8)), .001));
      isl.g.position.y = isl.y + Math.sin(t * .9 + i * 2) * .08;
      isl.halo.material.uniforms.uI.value = 1.1 + 3 * kick(t, T.connect[i]);
    });
    probLinks.forEach((e, i) => drawEdge(e, E.out(seg(t, T.connect[i], T.connect[i] + .6)), t, t > T.connect[i] + .6 ? 1 : 0, i * .3));
    core.g.scale.setScalar(Math.max(E.spring(seg(t, T.core - .2, T.core + .6)), .001));
    paintCard(core, 'idea', 'idea', 1, 3 * kick(t, T.core), t);
    pools.push([core.g.position.x, core.g.position.z, 3, .25, S.idea.gc]);
  }

  // 主流程图
  graphG.visible = t > 38.4 && t < 183.4;
  if (graphG.visible) {
    for (const n of Object.values(NODES)) {
      let sc = E.spring(seg(t, n.show, n.show + .8));
      if (n.id === 'E' && t >= T.shatter) sc = 0;
      n.card.g.visible = sc > .001;
      n.card.g.scale.setScalar(Math.max(sc, .001));
      const st = stateAt(n.states, t);
      const spike = 3 * kick(t, st.at) + 2.5 * kick(t, n.flash) + (n.id === 'C' ? 2 * kick(t, T.featBeam + .5) : 0);
      paintCard(n.card, st.prev, st.cur, st.p, spike, t);
      if (sc > .001) pools.push([n.p.x, n.p.z, 2.6, .03 + .035 * n.card.halo.material.uniforms.uI.value, n.card.halo.material.uniforms.uColor.value]);
    }
    EDGES.forEach(({ e, at, del }, i) => drawEdge(e, E.out(seg(t, at, at + .6)), t, t > 41.5 ? 1 : 0, i * .13, del ? 1 - seg(t, T.shatter, T.shatter + .4) : 1));
    const nv = E.spring(seg(t, 89.4, 90.1)) * (1 - E.in(seg(t, 94.0, 94.5)));
    note.visible = nv > .001;
    note.scale.setScalar(Math.max(nv, .001));
    drawEdge(noteLink, 1, t, 0);
    bookmark.visible = t >= T.bookmark;
    bookmark.position.y = BM_POS.y + (1 - E.spring(seg(t, T.bookmark, T.bookmark + .7))) * 1.2;
    bookmark.material.opacity = clamp(seg(t, T.bookmark, T.bookmark + .15));
    linkBadge.visible = t >= T.linkBadge;
    linkBadge.scale.setScalar(Math.max(E.spring(seg(t, T.linkBadge, T.linkBadge + .6)), .001));
    // 碎裂
    const age = t - T.shatter;
    frag.visible = age >= 0 && age < 2.6;
    if (frag.visible) {
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = V(1, 1, 1);
      fragData.forEach((f, i) => {
        const pos = NODES.E.p.clone().add(f.o).addScaledVector(f.v, (1 - Math.exp(-2 * age)) * 2.6);
        pos.y -= .9 * age * age;
        q.setFromAxisAngle(f.axis, f.spin * age);
        s.setScalar(Math.max(1 - age / 2.6, .001));
        frag.setMatrixAt(i, m.compose(pos, q, s));
      });
      frag.instanceMatrix.needsUpdate = true;
      frag.material.opacity = 1 - seg(age, 1.6, 2.6);
    }
    // 护罩
    shield.visible = t > T.shield - .1 && t < T.unlocked + .3;
    if (shield.visible) {
      const u = shield.material.uniforms;
      u.uReveal.value = E.io(seg(t, T.shield, T.shield + 1.1));
      u.uI.value = .55 * (1 - seg(t, T.unlocked, T.unlocked + .25));
      u.uTime.value = t;
      pools.push([-2.4, 0, 9, .14 * u.uReveal.value * u.uI.value / .55, u.uColor.value]);
    }
  }

  // 子流程
  subG.visible = t > 145 && t < 151;
  if (subG.visible) {
    SUB.forEach((c) => { c.halo.material.uniforms.uTime.value = t; });
    subEdges.forEach((e, i) => drawEdge(e, 1, t, 1, i * .2));
  }

  // 节点颜色
  palG.visible = t > 52 && t < 68.2;
  if (palG.visible) {
    tiles.forEach((tile, i) => {
      const s = E.spring(seg(t, tile.at, tile.at + .8));
      tile.g.scale.setScalar(Math.max(s, .001));
      tile.g.position.y = tile.y + Math.sin(t * .8 + i) * .06;
      paintCard(tile.card, tile.k, tile.k, 1, 3 * kick(t, tile.at), t);
      tile.lab.material.opacity = E.out(seg(t, tile.at + .2, tile.at + .7));
    });
  }

  // 统计
  statsG.visible = t > 104.8 && t < 123;
  if (statsG.visible) {
    BARS.forEach((b, i) => {
      const rise = E.out(seg(t, T.bars + i * .12, T.bars + 1.1 + i * .12));
      const sink = b.k === 'review' ? 0 : E.io(seg(t, T.filter, T.filter + .8));
      const h = b.h * rise * (1 - .94 * sink) + .02;
      b.mesh.scale.y = h;
      b.cap.position.y = ST.y + h + .005;
      b.cap.material.color.copy(S[b.k].gc).multiplyScalar((b.k === 'review' ? 2.5 + 3 * kick(t, T.filter, 1.5) : 2.5) * (1 - .7 * sink));
      b.top.position.set(b.x, ST.y + h + .6, ST.z);
      b.top.material.opacity = rise * (1 - sink);
      b.name.material.opacity = .4 + .6 * (1 - sink);
      if (i < 5) pools.push([b.x, ST.z, 1.8, .3 * rise * (1 - .8 * sink), S[b.k].gc]);
    });
    bigStat.material.opacity = vis(t, 106.6, T.filter + .6, .6);
  }

  // 历史
  histG.visible = t > 169.6 && t < 183.4;
  if (histG.visible) {
    SNAPS.forEach((s, i) => {
      const v = E.spring(seg(t, s.at, s.at + .8));
      const picked = (i === 1 && t >= T.pick[0]) || (i === 3 && t >= T.pick[1]);
      const pickAt = i === 1 ? T.pick[0] : T.pick[1];
      s.g.position.copy(s.base).add(V(0, (1 - v) * -2 + (picked ? .3 * E.out(seg(t, pickAt, pickAt + .4)) : 0), 0));
      s.g.scale.setScalar(Math.max(v, .001));
      const u = s.halo.material.uniforms;
      u.uColor.value.set(picked ? '#3f8fff' : '#4a5a70');
      u.uI.value = picked ? 2 + 3 * kick(t, pickAt) : .7;
    });
    drawEdge(rail, E.out(seg(t, T.snaps, T.snaps + 1.4)), t, t > T.snaps + 1.4 ? 1 : 0);
  }

  // 结尾
  bookPts.visible = t > 181.8;
  if (bookPts.visible) {
    bookPts.material.uniforms.uTime.value = t;
    bookPts.material.uniforms.uFade.value = (1 - seg(t, T.book + .8, T.book + 2.2) * .7) * clamp(seg(t, 181.8, 182.6));
  }

  // 一次性特效
  for (const b of bursts) {
    const age = t - b.t;
    b.pts.visible = age >= 0 && age <= b.life;
    if (b.pts.visible) b.pts.material.uniforms.uAge.value = age;
  }
  for (const r of rings) {
    const age = t - r.t;
    r.m.visible = age >= 0 && age <= r.life;
    if (!r.m.visible) continue;
    r.m.scale.setScalar(lerp(r.from, r.to, E.out(age / r.life)));
    r.m.material.opacity = 1 - age / r.life;
  }
  const f = flights.find((x) => t >= x.t - 1.05 && t <= x.t + .1);
  orb.visible = !!f;
  trail.forEach((m) => { m.visible = !!f; });
  orbLight.intensity = 0;
  if (f) {
    const u = E.io(seg(t, f.t - 1.0, f.t));
    orb.position.copy(f.curve.getPoint(u));
    orb.scale.setScalar(1 - seg(t, f.t, f.t + .1) * .9);
    orbLight.intensity = 1.2 * (1 - seg(t, f.t - .15, f.t + .1));
    trail.forEach((m, i) => {
      const k = Math.max(0, u - (i + 1) * .028);
      m.position.copy(f.curve.getPoint(k));
      m.scale.setScalar((1 - i / 16) * .75);
      m.material.opacity = u > (i + 1) * .028 ? 1 : 0;
    });
    pools.push([orb.position.x, orb.position.z, 3, .6, new THREE.Color('#ffb347')]);
  }

  // 地面：最近的冲击波 + 最多 6 个光池
  const fu = floor.material.uniforms;
  fu.uCam.value.copy(camera.position);
  fu.uTime.value = t;
  const rp = ripples.filter(([at]) => t >= at && t < at + 2).pop();
  fu.uRipple.value.set(rp ? rp[1] : 0, rp ? rp[2] : 0, rp ? rp[0] : 0, rp ? 1 : 0);
  for (let i = 0; i < 6; i++) {
    const p = pools[i];
    fu.uPools.value[i].set(p ? p[0] : 0, p ? p[1] : 0, p ? p[2] : 1, p ? p[3] : 0);
    if (p) fu.uPoolC.value[i].copy(p[4]);
  }
}

/* ---------- DOM 层 ---------- */
function split(el) {
  const text = el.textContent;
  el.textContent = '';
  for (const ch of text) {
    const w = document.createElement('span'); w.className = 'kc';
    const i = document.createElement('span'); i.textContent = ch === ' ' ? '\u00a0' : ch;
    w.appendChild(i); el.appendChild(w);
  }
  el._k = [...el.querySelectorAll('.kc > span')];
}
/** 逐字从下方滑入、向上滑出。 */
function kinetic(el, t, a, b, st = .03, dur = .55) {
  const n = el._k.length;
  const on = t >= a - .01 && t <= b + n * st * .5 + .02;
  el.style.visibility = on ? 'visible' : 'hidden';
  if (!on) return;
  el._k.forEach((k, i) => {
    const pin = E.expo(seg(t, a + i * st, a + i * st + dur));
    const pout = E.in(seg(t, b - .4 + i * st * .5, b + i * st * .5));
    k.style.transform = `translateY(${(1 - pin) * 110 - pout * 110}%)`;
  });
}
function showEl(el, v, tf = '') {
  if (v <= .001) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.style.opacity = v;
  el.style.transform = tf;
}
const CHECK = '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>';
function setBox(box, on) {
  if (box.classList.contains('done') === on) return;
  box.classList.toggle('done', on);
  box.innerHTML = on ? CHECK : '';
}
const center = (el, dx = 0, dy = 0) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2 + dx, r.top + r.height / 2 + dy]; };

const titled = SCENES.filter((s) => s.title);
const capEls = CAPTIONS.map(([a, b, text]) => {
  const el = document.createElement('div');
  el.className = 'kt';
  el.style.left = '0'; el.style.top = '0';
  el.textContent = text;
  $('caption').appendChild(el);
  split(el);
  return { el, a, b };
});
// 开始使用：项目树
const TREE = [
  ['g', 'group_sever'],
  ['app', 'rs_bot_sever', [['review', 9], ['confirmed', 3], ['issue', 2]]],
  ['sec', 'Chart', 4],
  ['file', 'chat', [['review', 8], ['idea', 2], ['issue', 1]]],
  ['file', '颜色协作样例', [['review', 1], ['idea', 1], ['confirmed', 1]]],
  ['sec', 'Feat', 2],
  ['file', '查询缓存', null, 'Feat_261101_1'],
  ['g', 'group_tools'],
  ['app', 'app_demo_a', [['review', 0], ['confirmed', 0], ['issue', 0]]],
];
const treeRows = TREE.map(([kind, name, badges, extra]) => {
  const r = document.createElement('div');
  r.className = `row ${kind === 'g' ? 'g' : kind === 'app' ? 'app' : ''}`;
  if (kind === 'file') r.style.paddingLeft = '34px';
  if (kind === 'sec') { r.style.paddingLeft = '14px'; r.style.fontWeight = '700'; }
  const nm = document.createElement('span'); nm.textContent = kind === 'sec' ? `▾ ${name}` : name;
  r.appendChild(nm);
  if (extra) { const x = document.createElement('span'); x.className = 'muted'; x.style.fontSize = '22px'; x.textContent = extra; r.appendChild(x); }
  const sp = document.createElement('span'); sp.className = 'sp'; r.appendChild(sp);
  if (kind === 'sec') { const c = document.createElement('span'); c.className = 'bdg'; c.style.background = 'transparent'; c.style.border = '1.5px solid #30363d'; c.style.color = '#9da7b3'; c.textContent = badges; r.appendChild(c); }
  (Array.isArray(badges) ? badges : []).forEach(([k, v]) => { const b = document.createElement('span'); b.className = 'bdg'; b.style.background = S[k].fill; b.textContent = v; r.appendChild(b); });
  $('tree').appendChild(r);
  return r;
});
const ROOTS = 'E:\\Project\\smallcat\\rs_bot_sever\nE:\\Project\\smallcat\\tools';
// 协作循环：说明块、底部状态按钮
LOOP.forEach((e) => {
  const blk = document.createElement('div');
  blk.style.cssText = 'position:absolute;left:0;top:0;width:720px';
  const actor = document.createElement('div');
  actor.className = `actor ${e.who}`;
  actor.textContent = e.who === 'you' ? '你来标记' : 'Agent 标记';
  const name = document.createElement('div');
  name.className = 'pname';
  name.textContent = S[e.state].name;
  name.style.color = S[e.state].fill;
  name.style.textShadow = `0 0 28px ${S[e.state].glow}, 0 0 4px ${S[e.state].glow}`;
  const desc = document.createElement('div');
  desc.className = 'pdesc';
  desc.textContent = e.desc;
  blk.append(actor, name, desc);
  $('phase').appendChild(blk);
  split(name);
  Object.assign(e, { blk, actor, name, desc });
});
const chipEls = ORDER.map((k) => {
  const c = document.createElement('div'); c.className = 'chip';
  const sw = document.createElement('span'); sw.className = 'sw';
  sw.style.background = S[k].fill; sw.style.borderStyle = S[k].dash ? 'dashed' : 'solid';
  c.append(sw, S[k].name);
  $('chips').appendChild(c);
  return c;
});
// 历史差异行
const DIFFS = [
  ['查询缓存', '状态变化', ['none', 'review']],
  ['返回结果', '状态变化', ['issue', 'review']],
  ['落盘日志', '删除节点', null],
];
const diffEls = DIFFS.map(([node, kind, pair], i) => {
  const d = document.createElement('div'); d.className = 'drow';
  const sw = (k) => `<span class="sw" style="background:${S[k].fill}"></span>${S[k].name}`;
  d.innerHTML = `<span>${node}</span><span class="k">${kind}</span>` + (pair
    ? `<span class="pill">${sw(pair[0])}<span style="color:#7d8590;margin:0 8px">→</span>${sw(pair[1])}</span>`
    : '<span style="color:#ff7b72">已从图中移除</span>');
  $('diff').appendChild(d);
  return { d, at: T.diffRows[i] };
});
const TERM = [
  { a: T.lockType[0], b: T.lockType[1], prompt: true, text: 'flowctl lock 接口流程.drawio --wait 30' },
  { a: T.locked, b: T.locked, text: 'locked  owner=agent', cls: 'ok' },
  { a: T.unlockType[0], b: T.unlockType[1], prompt: true, text: 'flowctl unlock 接口流程.drawio' },
  { a: T.unlocked, b: T.unlocked, text: 'unlocked  XML 校验通过', cls: 'ok' },
];
split($('outro1'));
const featBoxes = [...$('feat').querySelectorAll('.box')];
const bookPath = document.querySelector('#book path');
const bookLen = bookPath.getTotalLength();
bookPath.style.strokeDasharray = bookLen;

// 光标轨迹：点位可以是固定坐标、DOM 元素中心或 3D 点的投影
const fix = (x, y) => () => [x, y];
const dom = (sel, dx = 0, dy = 0) => () => center(document.querySelector(sel), dx, dy);
const wpt = (p, dx = 0, dy = 0) => () => { const [x, y] = project(typeof p === 'function' ? p() : p); return [x + dx, y + dy]; };
const chipSel = (k) => `#chips .chip:nth-child(${ORDER.indexOf(k) + 1})`;
const CUR = [
  { a: 27.6, b: 29.6, pts: [[27.6, fix(1250, 840)], [28.6, dom('#scan-btn')], [29.5, dom('#scan-btn', 40, 50)]], clicks: [T.scanClick] },
  ...LOOP.filter((e) => e.who === 'you').map((e) => ({ a: e.t - 1.3, b: e.t + .9, pts: [[e.t - 1.3, fix(1500, 780)], [e.t - .1, dom(chipSel(e.state))], [e.t + .8, dom(chipSel(e.state), 50, 60)]], clicks: [e.t] })),
  { a: 111.6, b: 113.6, pts: [[111.6, fix(1300, 780)], [112.7, wpt(REVIEW_TOP)], [113.5, wpt(REVIEW_TOP, 50, 60)]], clicks: [T.statClick] },
  { a: 123.8, b: 125.4, pts: [[123.8, fix(1500, 980)], [124.7, dom('#attach')], [125.3, dom('#attach', 30, 40)]], clicks: [T.attachClick] },
  { a: 126.6, b: 128.3, pts: [[126.6, fix(1300, 720)], [127.5, wpt(BM_POS)], [128.2, wpt(BM_POS, 40, 50)]], clicks: [T.bookmarkClick] },
  { a: 143.0, b: 144.4, pts: [[143.0, fix(1300, 720)], [143.9, wpt(LB_POS)], [144.35, wpt(LB_POS, 0, 10)]], clicks: [T.linkClick] },
  { a: 148.6, b: 150.0, pts: [[148.6, fix(700, 520)], [149.5, dom('#backbtn')], [149.95, dom('#backbtn', 20, 20)]], clicks: [T.backClick] },
  { a: 172.6, b: 174.8, pts: [[172.6, fix(1000, 820)], [173.5, wpt(() => SNAPS[1].g.position)], [174.1, wpt(() => SNAPS[3].g.position)], [174.7, wpt(() => SNAPS[3].g.position, 40, 40)]], clicks: T.pick },
];
const FLASH = [[T.titleHit, .35], [T.core, .15], [T.portal[0], 1], [T.portal[1], 1], [T.unlocked, .18]];

function updateDom(t) {
  // 章节名
  const sc = titled.find((s) => t >= s.a && t < s.b);
  if (sc) {
    const v = vis(t, sc.a + .5, sc.b - .1, .5);
    const ch = $('chapter');
    ch.children[0].textContent = String(titled.indexOf(sc) + 1).padStart(2, '0');
    ch.children[2].textContent = sc.title;
    showEl(ch, v, `translateX(${(1 - v) * -30}px)`);
  } else $('chapter').style.display = 'none';

  const sv = vis(t, 5.8, 11.0, .6);
  showEl($('subtitle'), sv, `translateY(${(1 - sv) * 24}px)`);
  for (const c of capEls) kinetic(c.el, t, c.a, c.b);

  // 开始使用
  const setv = vis(t, 24.4, 37.8, .6);
  showEl($('settings'), setv, `translateX(${(1 - setv) * -120}px) rotateY(${10 + (1 - setv) * 24}deg)`);
  if (setv > 0) {
    const n = Math.floor([...ROOTS].length * seg(t, T.typeA, T.typeB));
    const caret = t < T.typeB + .4 && Math.floor(t * 3) % 2 === 0 ? '▍' : '';
    $('roots').textContent = [...ROOTS].slice(0, n).join('') + caret;
    const press = 1 - .06 * Math.sin(Math.PI * seg(t, T.scanClick - .08, T.scanClick + .14));
    $('scan-btn').style.transform = `scale(${press})`;
    const sl = $('scanline');
    sl.style.display = t >= T.scan && t <= T.scan + .9 ? '' : 'none';
    sl.style.top = `${lerp(0, 600, seg(t, T.scan, T.scan + .9))}px`;
    $('found').style.opacity = E.out(seg(t, T.scan + .8, T.scan + 1.2));
  }
  const tv = vis(t, 29.2, 37.8, .6);
  showEl($('tree'), tv, `translateX(${(1 - tv) * 120}px) rotateY(${-10 - (1 - tv) * 24}deg)`);
  treeRows.forEach((r, i) => {
    const v = E.out(seg(t, T.treeRow0 + i * T.treeStep, T.treeRow0 + i * T.treeStep + .4));
    r.style.opacity = v;
    r.style.transform = `translateX(${(1 - v) * -24}px)`;
  });

  // 协作循环
  for (const e of LOOP) {
    const v = vis(t, e.a, e.b, .3);
    e.blk.style.display = v > 0 ? '' : 'none';
    if (v <= 0) continue;
    e.actor.style.opacity = v;
    e.actor.style.transform = `translateY(${(1 - v) * 16}px)`;
    kinetic(e.name, t, e.a + .05, e.b - .05, .04, .5);
    e.desc.style.opacity = E.out(seg(t, e.a + .25, e.a + .6)) * (1 - seg(t, e.b - .3, e.b));
  }
  const cv = vis(t, 67.6, 105.4, .6);
  showEl($('chips'), cv, `translateY(${(1 - cv) * 60}px)`);
  const cur = LOOP.filter((e) => t >= e.a).pop();
  const stepv = vis(t, 68.4, 105.2, .5);
  showEl($('loop-step'), stepv);
  if (cur) $('loop-step').textContent = `步骤 ${cur.i + 1} / ${LOOP.length}　${NODES[cur.node].title}`;
  else $('loop-step').textContent = `步骤 0 / ${LOOP.length}`;
  if (cv > 0) {
    const focus = t < 88.4 ? NODES.C : t < 96.8 ? NODES.D : NODES.E;
    const fs = stateAt(focus.states, t).cur;
    chipEls.forEach((c, i) => {
      c.classList.toggle('on', ORDER[i] === fs);
      const click = LOOP.find((e) => e.who === 'you' && e.state === ORDER[i] && Math.abs(t - e.t) < .2);
      c.style.transform = click ? `scale(${1 - .06 * Math.sin(Math.PI * seg(t, click.t - .08, click.t + .14))})` : '';
    });
  }

  // 统计
  const fv = vis(t, T.filter + .4, 121.6, .5);
  showEl($('filtered'), fv, `translateX(${(1 - fv) * 200}px) rotateY(${-10 + (1 - fv) * -30}deg)`);

  // Feat
  const nb = vis(t, 122.8, 128.0, .4);
  showEl($('nodebar'), nb, `translateY(${(1 - nb) * 40}px)`);
  $('nodetag').style.display = t >= T.attachClick + .1 ? '' : 'none';
  $('attach').textContent = t >= T.attachClick + .1 ? '从 Feat_261101_1 摘除' : '挂到 Feat_261101_1';
  $('attach').style.transform = `scale(${1 - .06 * Math.sin(Math.PI * seg(t, T.attachClick - .08, T.attachClick + .14))})`;
  const ftv = vis(t, T.featIn, 141.0, .6);
  $('feat').style.transformOrigin = '100% 50%';
  showEl($('feat'), ftv, `translateX(${(1 - ftv) * 260}px) rotateY(${-8 + (1 - ftv) * 50}deg)`);
  let done = 0;
  T.tasks.forEach((at, i) => {
    if (t >= at) done++;
    setBox(featBoxes[i], t >= at);
    featBoxes[i].style.transform = `scale(${1 + .3 * Math.sin(Math.PI * seg(t, at, at + .25))})`;
  });
  $('fprog').textContent = `T ${done}/3`;

  // 光束：状态按钮 → 节点、档案关联行 → 节点
  let beam = null;
  const you = LOOP.find((e) => e.who === 'you' && t >= e.t && t <= e.t + 1.0);
  if (you) beam = { from: center(document.querySelector(chipSel(you.state)), 0, -36), to: project(NODES[you.node].p), p: E.out(seg(t, you.t, you.t + .45)), v: 1 - seg(t, you.t + .6, you.t + 1.0) };
  if (t >= T.featBeam && t <= 139.6 && ftv > 0) {
    const r = $('linkrow').getBoundingClientRect();
    beam = { from: [r.left - 10, r.top + r.height / 2], to: project(NODES.C.p), p: E.out(seg(t, T.featBeam, T.featBeam + .6)), v: 1 - seg(t, 139.0, 139.6) };
  }
  const bp = $('beampath');
  if (beam && beam.v > 0) {
    const [x1, y1] = beam.from, [x2, y2] = beam.to;
    bp.setAttribute('d', `M${x1} ${y1}Q${(x1 + x2) / 2} ${Math.min(y1, y2) - 160} ${x2} ${y2}`);
    bp.setAttribute('pathLength', '1');
    bp.style.strokeDasharray = `${beam.p} 2`;
    bp.style.opacity = beam.v;
    bp.style.display = '';
  } else bp.style.display = 'none';

  // 图间链接
  const bk = vis(t, 145.8, 150.4, .3);
  showEl($('backbtn'), bk, `translateX(${(1 - bk) * -40}px)`);
  $('backbtn').style.transform += ` scale(${1 - .06 * Math.sin(Math.PI * seg(t, T.backClick - .08, T.backClick + .14))})`;
  const snv = vis(t, 146.0, 149.9, .4);
  showEl($('subname'), snv);

  // 加锁
  const tmv = vis(t, 154.0, 169.6, .5);
  showEl($('term'), tmv, `translateY(${(1 - tmv) * 40}px) rotateY(${-8}deg)`);
  if (tmv > 0) {
    const html = [];
    for (const l of TERM) {
      if (t < l.a) break;
      const chars = [...l.text];
      const n = l.b > l.a ? Math.floor(chars.length * seg(t, l.a, l.b)) : chars.length;
      const caret = l.prompt && t < l.b + .3 && Math.floor(t * 3) % 2 === 0 ? '▍' : '';
      html.push(l.prompt ? `<span class="pr">❯ </span>${chars.slice(0, n).join('')}${caret}` : `<span class="${l.cls}">${l.text}</span>`);
    }
    $('tbody').innerHTML = html.join('\n');
  }
  const rov = vis(t, T.shield + .6, T.unlocked, .3);
  showEl($('ro'), rov);
  const tov = vis(t, T.merged, 169.4, .3);
  showEl($('toast'), tov, `translateY(${(1 - tov) * -20}px)`);

  // 历史
  const dv = vis(t, T.diff, 181.6, .5);
  showEl($('diff'), dv, `translateX(${(1 - dv) * 200}px) rotateY(${-10 + (1 - dv) * -30}deg)`);
  diffEls.forEach(({ d, at }) => {
    const v = E.out(seg(t, at, at + .35));
    d.style.opacity = v;
    d.style.transform = `translateX(${(1 - v) * -30}px)`;
  });

  // 结尾
  const bv = clamp(seg(t, T.book + .4, T.book + .6));
  $('book').style.display = bv > 0 ? '' : 'none';
  $('book').style.opacity = bv;
  bookPath.style.strokeDashoffset = bookLen * (1 - E.io(seg(t, T.book + .4, T.book + 1.6)));
  kinetic($('outro1'), t, T.book + 1.2, 200, .045, .6);
  const ov = E.out(seg(t, T.book + 2.2, T.book + 2.8));
  showEl($('outro2'), ov);
  $('outro2').style.letterSpacing = `${8 + 12 * (1 - ov)}px`;

  // 闪白与淡入淡出
  let fl = 0;
  for (const [at, g] of FLASH) fl = Math.max(fl, g * (t < at ? E.in(seg(t, at - .25, at)) : 1 - E.out(seg(t, at, at + .5))));
  showEl($('flash'), fl);
  showEl($('fade'), Math.max(1 - seg(t, 0, 1.0), seg(t, DURATION - 1.4, DURATION - .1)));

  // 光标与点击波纹
  const c = $('cursor'), rp = $('ripple');
  c.style.display = 'none'; rp.style.display = 'none';
  for (const s of CUR) {
    if (t < s.a || t > s.b) continue;
    let i = 0;
    while (i < s.pts.length - 2 && t > s.pts[i + 1][0]) i++;
    const [ta, fa] = s.pts[i], [tb, fb] = s.pts[i + 1];
    const [xa, ya] = fa(), [xb, yb] = fb();
    const p = E.io(seg(t, ta, tb));
    const x = lerp(xa, xb, p), y = lerp(ya, yb, p);
    let press = 1;
    for (const k of s.clicks) {
      press = Math.min(press, 1 - .18 * Math.sin(Math.PI * seg(t, k - .08, k + .12)));
      const q = seg(t, k, k + .5);
      if (q > 0 && q < 1) {
        rp.style.display = '';
        rp.style.opacity = 1 - q;
        rp.style.transform = `translate(${x}px,${y}px) scale(${.3 + q})`;
      }
    }
    c.style.display = '';
    c.style.opacity = vis(t, s.a, s.b, .25);
    c.style.transform = `translate(${x - 8}px,${y - 4}px) scale(${press})`;
  }
}

function render(t) {
  const [px, py, pz, tx, ty, tz, fov] = cameraAt(t);
  const drift = 1 - seg(t, 182.4, 183.2);
  camera.position.set(px + Math.sin(t * .37) * .12 * drift, py + Math.sin(t * .29 + 1) * .08 * drift, pz);
  camera.fov = fov;
  camera.updateProjectionMatrix();
  camera.lookAt(tx, ty, tz);
  camera.updateMatrixWorld();
  updateWorld(t, V(tx, ty, tz));
  composer.render();
  updateDom(t);
}

window.render = render;
window.DURATION = DURATION;
await document.fonts.ready;
window.ready = true;

// 直接打开时实时播放；?capture 由导出脚本逐帧驱动；?t=秒 定格某一帧。
const q = new URLSearchParams(location.search);
if (q.has('t')) render(parseFloat(q.get('t')));
else if (!q.has('capture')) {
  const start = performance.now() - (parseFloat(q.get('from')) || 0) * 1000;
  const loop = () => { render(((performance.now() - start) / 1000) % DURATION); requestAnimationFrame(loop); };
  loop();
}
