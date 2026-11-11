// Procedural holographic brain: two hemispheres with gyri/sulci, a lateral
// fissure, cerebellum and stem. All geometry is baked into one "brain space"
// (x = left(-)/right(+), y = up, z = front(+)) so region positions from the
// backend config map 1:1 onto the shader.
import * as THREE from "three";
import { ImprovedNoise } from "three/examples/jsm/math/ImprovedNoise.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export const MAX_REGIONS = 16;
const LATERAL = 0.72;  // outer half-width of a hemisphere
const MEDIAL = 0.12;   // inner half-width (flat wall facing the other half)
const FISSURE = 0.025; // half the gap between the hemispheres
const HEMI_OFFSET = MEDIAL + FISSURE;
const noise = new ImprovedNoise();

function fbmRidged(x: number, y: number, z: number): number {
  // ridged noise -> thin grooves (sulci) between rounded folds (gyri)
  let v = 0, amp = 0.6, f = 1;
  for (let o = 0; o < 3; o++) {
    const n = noise.noise(x * f, y * f, z * f);
    v += amp * (1 - Math.abs(n) * 2.2);
    amp *= 0.45; f *= 2.1;
  }
  return v;
}

function hemisphere(side: -1 | 1): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 180, 130);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const depth = new Float32Array(pos.count);
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    let { x, y, z } = p;
    // ellipsoid
    // lateral half-width 0.72; the medial (inner) side is squashed into an
    // almost flat wall so the two hemispheres meet at a narrow fissure
    x *= side * x < 0 ? MEDIAL : LATERAL;
    y *= 0.74; z *= 1.08;
    // flatter underside, taller crown, slightly narrower front
    if (y < 0) y *= 0.78 + 0.22 * Math.max(0, -p.z);
    y += 0.08 * (1 - p.z * p.z);
    x *= 1 - 0.12 * Math.max(0, p.z);
    // temporal lobe bulge (lower, lateral, middle)
    const tl = Math.exp(-((p.y + 0.45) ** 2) / 0.08 - ((p.z - 0.05) ** 2) / 0.25) * Math.max(0, side * p.x);
    x += side * 0.08 * tl; y -= 0.1 * tl;
    // gyri
    const n = fbmRidged(p.x * 3.4 + side * 7.0, p.y * 3.4, p.z * 3.0);
    let d = 0.045 * n;
    // lateral (Sylvian) fissure
    const fy = -0.18 + 0.32 * p.z;
    const fiss = Math.exp(-((p.y - fy) ** 2) / 0.006) * (p.z > -0.55 && p.z < 0.75 ? 1 : 0) * Math.max(0, side * p.x - 0.25);
    d -= 0.07 * fiss;
    // central sulcus
    const cs = Math.exp(-((p.z + 0.05 - 0.25 * p.y) ** 2) / 0.003) * Math.max(0, p.y);
    d -= 0.04 * cs;
    const nrm = new THREE.Vector3(x / 0.5, y / 0.55, z / 1.17).normalize();
    // keep the folds from pushing through the midline
    const dx = side * x < 0 ? nrm.x * Math.min(d, 0) : nrm.x * d;
    x += dx; y += nrm.y * d; z += nrm.z * d;
    pos.setXYZ(i, x + side * HEMI_OFFSET, y + 0.12, z);
    depth[i] = d;
  }
  g.setAttribute("aDepth", new THREE.BufferAttribute(depth, 1));
  g.computeVertexNormals();
  return g;
}

function cerebellum(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 120, 80);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const depth = new Float32Array(pos.count);
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const d = 0.018 * Math.sin(p.y * 70 + p.z * 8) - 0.05 * Math.exp(-(p.x * p.x) / 0.01);
    const s = 1 + d;
    pos.setXYZ(i, p.x * 0.62 * s, p.y * 0.32 * s - 0.55, p.z * 0.42 * s - 0.72);
    depth[i] = d;
  }
  g.setAttribute("aDepth", new THREE.BufferAttribute(depth, 1));
  g.computeVertexNormals();
  return g;
}

function stem(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.17, 0.1, 0.9, 32, 8);
  g.rotateX(-0.35);
  g.translate(0, -0.85, -0.3);
  g.setAttribute("aDepth", new THREE.BufferAttribute(new Float32Array(g.attributes.position.count), 1));
  return g;
}

const vertex = /* glsl */ `
  attribute float aDepth;
  varying vec3 vLocal;
  varying vec3 vNormalV;
  varying vec3 vViewDir;
  varying float vDepth;
  void main() {
    vLocal = position;
    vDepth = aDepth;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormalV = normalize(normalMatrix * normal);
    vViewDir = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const fragment = /* glsl */ `
  #define MAX_REGIONS ${MAX_REGIONS}
  uniform float uTime;
  uniform float uEnergy;
  uniform int uCount;
  uniform vec3 uPos[MAX_REGIONS];
  uniform vec3 uColor[MAX_REGIONS];
  uniform float uAct[MAX_REGIONS];
  uniform float uDim[MAX_REGIONS];
  varying vec3 vLocal;
  varying vec3 vNormalV;
  varying vec3 vViewDir;
  varying float vDepth;
  void main() {
    float fres = pow(1.0 - abs(dot(normalize(vNormalV), normalize(vViewDir))), 2.0);
    float groove = smoothstep(0.0, -0.05, vDepth);
    vec3 base = mix(vec3(0.02, 0.06, 0.16), vec3(0.15, 0.75, 1.0), fres);
    base *= 0.35 + 0.2 * uEnergy;
    base = mix(base, vec3(0.0, 0.02, 0.06), groove * 0.7);
    float scan = 0.5 + 0.5 * sin(vLocal.y * 140.0 - uTime * 3.0);
    base += vec3(0.05, 0.25, 0.4) * pow(scan, 12.0) * 0.35;
    // a sweeping band of light
    float sweep = exp(-pow(vLocal.y - (mod(uTime * 0.35, 3.2) - 1.4), 2.0) / 0.004);
    base += vec3(0.2, 0.8, 1.0) * sweep * 0.25;
    vec3 glow = vec3(0.0);
    float alphaGlow = 0.0;
    for (int i = 0; i < MAX_REGIONS; i++) {
      if (i >= uCount) break;
      float d = distance(vLocal, uPos[i]);
      float idle = 0.16 * exp(-d * d / 0.05) * (1.0 - uDim[i] * 0.85);
      float act = uAct[i] * exp(-d * d / 0.12) * (1.0 - uDim[i] * 0.8);
      float ripple = 0.75 + 0.25 * sin(d * 30.0 - uTime * 8.0);
      glow += uColor[i] * (idle + act * 1.6 * ripple);
      alphaGlow += idle + act;
    }
    glow *= (1.0 - groove * 0.5);
    vec3 col = base + glow;
    float alpha = clamp(0.1 + fres * 0.45 + alphaGlow * 0.5, 0.0, 1.0);
    gl_FragColor = vec4(col, alpha);
  }
`;

export interface BrainHandle {
  group: THREE.Group;
  mesh: THREE.Mesh;
  uniforms: Record<string, THREE.IUniform>;
  points: THREE.Points;
}

export function buildBrain(): BrainHandle {
  const geo = mergeGeometries([hemisphere(-1), hemisphere(1), cerebellum(), stem()].map((g) => g.index ? g.toNonIndexed() : g), false)!;
  const uniforms: Record<string, THREE.IUniform> = {
    uTime: { value: 0 },
    uEnergy: { value: 1 },
    uCount: { value: 0 },
    uPos: { value: Array.from({ length: MAX_REGIONS }, () => new THREE.Vector3(99, 99, 99)) },
    uColor: { value: Array.from({ length: MAX_REGIONS }, () => new THREE.Color(0, 0, 0)) },
    uAct: { value: new Array(MAX_REGIONS).fill(0) },
    uDim: { value: new Array(MAX_REGIONS).fill(0) },
  };
  const mat = new THREE.ShaderMaterial({
    vertexShader: vertex, fragmentShader: fragment, uniforms,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  const group = new THREE.Group();
  group.add(mesh);

  // neuron dust: a sparse point cloud on the surface that twinkles
  const src = geo.attributes.position as THREE.BufferAttribute;
  const n = 2600;
  const pts = new Float32Array(n * 3);
  const seeds = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = Math.floor(Math.random() * src.count);
    pts[i * 3] = src.getX(k); pts[i * 3 + 1] = src.getY(k); pts[i * 3 + 2] = src.getZ(k);
    seeds[i] = Math.random() * 100;
  }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute("position", new THREE.BufferAttribute(pts, 3));
  pg.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  const pm = new THREE.ShaderMaterial({
    uniforms: { uTime: uniforms.uTime, uEnergy: uniforms.uEnergy },
    vertexShader: /* glsl */ `
      attribute float aSeed; uniform float uTime; varying float vA;
      void main() {
        vA = pow(0.5 + 0.5 * sin(uTime * 1.7 + aSeed), 6.0);
        vec4 mv = modelViewMatrix * vec4(position * 1.012, 1.0);
        gl_PointSize = (1.5 + 3.5 * vA) * (5.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vA; uniform float uEnergy;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        gl_FragColor = vec4(vec3(0.6, 0.95, 1.0), (0.15 + 0.85 * vA) * (1.0 - d * 2.0) * (0.4 + 0.6 * uEnergy));
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(pg, pm);
  group.add(points);
  return { group, mesh, uniforms, points };
}
