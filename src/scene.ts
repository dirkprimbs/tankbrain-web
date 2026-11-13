// The tank: renderer, glass, fluid bubbles, the brain, region nodes,
// labels and light pulses for messages.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { CSS2DRenderer, CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { buildBrain, MAX_REGIONS, type BrainHandle } from "./brain";
import type { AgentInfo } from "./types";

const BRAIN_SCALE = 1.15;
const TANK_R = 2.25, TANK_H = 4.8, TANK_Y = 0.15;

interface Region {
  agent: AgentInfo;
  index: number;
  pos: THREE.Vector3; // brain space
  node: THREE.Sprite;
  label: CSS2DObject;
  act: number;        // current activity 0..1
  target: number;
  flicker: number;
}

interface Pulse {
  curve: THREE.Curve<THREE.Vector3>;
  head: THREE.Sprite;
  trail: THREE.Line;
  t: number;
  speed: number;
  fade: number;
  onArrive?: () => void;
}

function glowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.18, "rgba(255,255,255,0.85)");
  grd.addColorStop(0.45, "rgba(255,255,255,0.25)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class TankScene {
  renderer: THREE.WebGLRenderer;
  labels: CSS2DRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  composer: EffectComposer;
  brain: BrainHandle;
  brainRoot = new THREE.Group();
  regions = new Map<string, Region>();
  pulses: Pulse[] = [];
  glow = glowTexture();
  clock = new THREE.Clock();
  energy = 1;
  bubbles!: THREE.Points;
  bubbleSpeed!: Float32Array;
  tankMat!: THREE.ShaderMaterial;
  inputNode!: THREE.Sprite;
  inputPos = new THREE.Vector3(0, -0.15, -0.05);
  onRegionClick: (agent: string, ev: MouseEvent) => void = () => {};
  onRegionHover: (agent: string | null, el: HTMLElement) => void = () => {};

  constructor(host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    host.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.setSize(window.innerWidth, window.innerHeight);
    this.labels.domElement.className = "labels-layer";
    host.appendChild(this.labels.domElement);

    this.camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 100);
    this.camera.position.set(7.4, 2.4, 9.2);
    this.controls = new OrbitControls(this.camera, this.labels.domElement);
    this.controls.target.set(0, 0.1, 0);
    this.controls.enableDamping = true;
    this.controls.autoRotate = false;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 14;

    this.scene.background = new THREE.Color(0x02040b);
    this.scene.fog = new THREE.FogExp2(0x02040b, 0.045);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.55, 0.4, 0.22));
    this.composer.addPass(new OutputPass());

    this.brain = buildBrain();
    this.brainRoot.add(this.brain.group);
    this.brainRoot.scale.setScalar(BRAIN_SCALE);
    this.brainRoot.position.y = 0.15;
    this.scene.add(this.brainRoot);

    this.buildTank();
    this.buildBubbles();
    this.buildFloor();

    this.inputNode = this.makeNode("#ffffff", 0.22);
    this.brainRoot.add(this.inputNode);

    window.addEventListener("resize", () => this.resize());
    this.loop();
  }

  // --- construction ----------------------------------------------------
  private buildTank() {
    this.tankMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uEnergy: { value: 1 } },
      vertexShader: /* glsl */ `
        varying vec3 vN; varying vec3 vV; varying vec3 vP;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vP = position;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform float uEnergy;
        varying vec3 vN; varying vec3 vV; varying vec3 vP;
        void main() {
          float f = pow(1.0 - abs(dot(vN, vV)), 3.0);
          float lines = smoothstep(0.985, 1.0, sin(vP.y * 9.0 + uTime * 0.6) * 0.5 + 0.5);
          vec3 c = mix(vec3(0.0, 0.5, 0.9), vec3(1.0, 0.3, 0.85), 0.5 + 0.5 * sin(vP.y * 0.8 + uTime * 0.2));
          float a = f * (0.12 + 0.1 * uEnergy) + lines * 0.03 + 0.004;
          gl_FragColor = vec4(c * (0.5 + f * 0.6), a);
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    });
    const glass = new THREE.Mesh(new THREE.CylinderGeometry(TANK_R, TANK_R, TANK_H, 96, 1, true), this.tankMat);
    glass.position.y = TANK_Y;
    this.scene.add(glass);

    const metal = new THREE.MeshStandardMaterial({ color: 0x0b1422, metalness: 0.9, roughness: 0.35, emissive: 0x020812 });
    const neonC = new THREE.MeshBasicMaterial({ color: 0x00e5ff });
    const neonM = new THREE.MeshBasicMaterial({ color: 0xff4fd8 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(TANK_R + 0.25, TANK_R + 0.45, 0.55, 96), metal);
    base.position.y = TANK_Y - TANK_H / 2 - 0.27;
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(TANK_R + 0.2, TANK_R + 0.2, 0.3, 96), metal);
    lid.position.y = TANK_Y + TANK_H / 2 + 0.15;
    this.scene.add(base, lid);
    for (const [y, m] of [[TANK_Y - TANK_H / 2 + 0.02, neonC], [TANK_Y + TANK_H / 2 - 0.02, neonC], [TANK_Y - TANK_H / 2 - 0.45, neonM]] as const) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(TANK_R + (m === neonM ? 0.38 : 0.04), 0.018, 8, 160), m);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = y;
      this.scene.add(ring);
    }
    // input pipe through the lid, output port at the base
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.2, 16), neonC);
    pipe.position.set(0, TANK_Y + TANK_H / 2 + 0.6, 0);
    this.scene.add(pipe);
    const port = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.025, 8, 40), new THREE.MeshBasicMaterial({ color: 0xe6ff5c }));
    port.position.set(-TANK_R - 0.3, TANK_Y - TANK_H / 2 - 0.27, 0.9);
    port.rotation.y = Math.PI / 2;
    this.scene.add(port);
    this.scene.add(new THREE.AmbientLight(0x406080, 0.6));
    const key = new THREE.PointLight(0x00e5ff, 30, 12);
    key.position.set(3, 4, 3);
    const rim = new THREE.PointLight(0xff4fd8, 25, 12);
    rim.position.set(-3, -1, -3);
    this.scene.add(key, rim);
  }

  private buildBubbles() {
    const n = 420;
    const pos = new Float32Array(n * 3);
    this.bubbleSpeed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = Math.sqrt(Math.random()) * (TANK_R - 0.15);
      const a = Math.random() * Math.PI * 2;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = TANK_Y - TANK_H / 2 + Math.random() * TANK_H;
      pos[i * 3 + 2] = Math.sin(a) * r;
      this.bubbleSpeed[i] = 0.15 + Math.random() * 0.45;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({ size: 0.05, map: this.glow, transparent: true, opacity: 0.55, color: 0x9fefff,
      depthWrite: false, blending: THREE.AdditiveBlending });
    this.bubbles = new THREE.Points(g, m);
    this.scene.add(this.bubbles);
  }

  private buildFloor() {
    const grid = new THREE.GridHelper(40, 80, 0xff4fd8, 0x0a3a5a);
    grid.position.y = TANK_Y - TANK_H / 2 - 0.55;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.25;
    this.scene.add(grid);
  }

  private makeNode(color: string, size = 0.16): THREE.Sprite {
    const m = new THREE.SpriteMaterial({ map: this.glow, color: new THREE.Color(color), transparent: true,
      depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const s = new THREE.Sprite(m);
    s.scale.setScalar(size);
    return s;
  }

  // --- agents ----------------------------------------------------------
  setAgents(agents: AgentInfo[], inputPos?: number[]) {
    for (const r of this.regions.values()) {
      this.brainRoot.remove(r.node);
      r.label.element.remove();
      this.brainRoot.remove(r.label);
    }
    this.regions.clear();
    if (inputPos) this.inputPos.fromArray(inputPos);
    this.inputNode.position.copy(this.inputPos);
    const u = this.brain.uniforms;
    agents.slice(0, MAX_REGIONS).forEach((a, i) => {
      const pos = this.anchor(new THREE.Vector3().fromArray(a.pos));
      const node = this.makeNode(a.color);
      node.position.copy(pos);
      this.brainRoot.add(node);
      const el = document.createElement("div");
      el.className = "region-label";
      el.style.setProperty("--c", a.color);
      el.innerHTML = `<span class="dot"></span><span class="nm"></span><span class="md"></span>`;
      el.querySelector(".nm")!.textContent = a.name;
      el.querySelector(".md")!.textContent = a.model;
      // keep the orbit control from capturing the pointer, or the click never reaches the label
      el.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      el.addEventListener("click", (ev) => this.onRegionClick(a.name, ev));
      el.addEventListener("mouseenter", () => this.onRegionHover(a.name, el));
      el.addEventListener("mouseleave", () => this.onRegionHover(null, el));
      const label = new CSS2DObject(el);
      label.position.copy(pos).add(new THREE.Vector3(0, 0.14, 0));
      this.brainRoot.add(label);
      (u.uPos.value as THREE.Vector3[])[i].copy(pos);
      (u.uColor.value as THREE.Color[])[i].set(a.color);
      this.regions.set(a.name, { agent: a, index: i, pos, node, label, act: 0, target: 0, flicker: 0 });
    });
    u.uCount.value = Math.min(agents.length, MAX_REGIONS);
  }

  /** Keep a region inside the tissue: if the configured point lies outside
   *  the brain surface, move it to just beneath the nearest surface point. */
  private anchor(p: THREE.Vector3): THREE.Vector3 {
    const geo = this.brain.mesh.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const nrm = geo.attributes.normal as THREE.BufferAttribute;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < pos.count; i++) {
      const dx = pos.getX(i) - p.x, dy = pos.getY(i) - p.y, dz = pos.getZ(i) - p.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    const v = new THREE.Vector3().fromBufferAttribute(pos, best);
    const n = new THREE.Vector3().fromBufferAttribute(nrm, best).normalize();
    const outside = p.clone().sub(v).dot(n) > -0.04;
    return outside ? v.sub(n.multiplyScalar(0.06)) : p;
  }

  setDimmed(hidden: Set<string>) {
    const dim = this.brain.uniforms.uDim.value as number[];
    for (const r of this.regions.values()) {
      const off = hidden.has(r.agent.name);
      dim[r.index] = off ? 1 : 0;
      r.label.element.classList.toggle("off", off);
      (r.node.material as THREE.SpriteMaterial).opacity = off ? 0.25 : 1;
    }
  }

  /** Voices not recruited for this matter rest: shown faded until something wakes them. */
  setResting(resting: Set<string>) {
    for (const r of this.regions.values()) {
      const rest = resting.has(r.agent.name);
      r.label.element.classList.toggle("resting", rest);
      (r.node.material as THREE.SpriteMaterial).opacity = rest ? 0.35 : r.label.element.classList.contains("off") ? 0.25 : 1;
    }
  }

  activate(agent: string, on: boolean, loading = false) {
    const r = this.regions.get(agent);
    if (!r) return;
    r.target = on ? 1 : 0;
    if (loading) r.flicker = 2.5;
    r.label.element.classList.toggle("active", on);
  }

  flash(agent: string, strength = 0.8) {
    const r = this.regions.get(agent);
    if (r) r.act = Math.max(r.act, strength);
  }

  setEnergy(level: number) {
    this.energy = level;
  }

  // --- pulses ----------------------------------------------------------
  private world(p: THREE.Vector3): THREE.Vector3 {
    return this.brainRoot.localToWorld(p.clone());
  }

  private spawn(from: THREE.Vector3, to: THREE.Vector3, color: string, opts: { speed?: number; lift?: number; width?: number; onArrive?: () => void } = {}) {
    const a = this.world(from), b = this.world(to);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const out = mid.clone().sub(this.brainRoot.position).setY(0).normalize();
    mid.add(out.multiplyScalar(opts.lift ?? 0.6)).add(new THREE.Vector3(0, 0.35, 0));
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    const head = this.makeNode(color, opts.width ?? 0.2);
    head.position.copy(a);
    const trailGeo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(40));
    trailGeo.setDrawRange(0, 0);
    const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false }));
    this.scene.add(head, trail);
    this.pulses.push({ curve, head, trail, t: 0, speed: opts.speed ?? 0.9, fade: 1, onArrive: opts.onArrive });
  }

  pulse(from: string, to: string[], kind: "post" | "dm") {
    const a = this.regions.get(from);
    if (!a) return;
    this.flash(from, 0.7);
    for (const name of to) {
      const b = this.regions.get(name);
      if (!b || b === a) continue;
      this.spawn(a.pos, b.pos, a.agent.color, {
        speed: kind === "dm" ? 0.6 : 0.95, lift: kind === "dm" ? 0.25 : 0.7, width: kind === "dm" ? 0.13 : 0.2,
        onArrive: () => this.flash(name, kind === "dm" ? 0.6 : 0.35),
      });
    }
  }

  pulseInput(to: string[]) {
    const top = this.brainRoot.worldToLocal(new THREE.Vector3(0, TANK_Y + TANK_H / 2 + 0.6, 0));
    this.spawn(top, this.inputPos, "#ffffff", {
      speed: 0.7, lift: 0, width: 0.3,
      onArrive: () => {
        for (const name of to) {
          const r = this.regions.get(name);
          if (r) this.spawn(this.inputPos, r.pos, "#ffffff", { speed: 1.1, lift: 0.3, onArrive: () => this.flash(name, 0.6) });
        }
      },
    });
  }

  pulseOutput(from: string) {
    const r = this.regions.get(from);
    if (!r) return;
    const port = this.brainRoot.worldToLocal(new THREE.Vector3(-TANK_R - 0.3, TANK_Y - TANK_H / 2 - 0.27, 0.9));
    for (let i = 0; i < 3; i++) setTimeout(() => this.spawn(r.pos, port, r.agent.color, { speed: 0.6, lift: 0.5, width: 0.32 }), i * 220);
  }

  // --- loop ------------------------------------------------------------
  private resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.labels.setSize(w, h);
  }

  private loop = () => {
    requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    const u = this.brain.uniforms;
    u.uTime.value = t;
    u.uEnergy.value += (this.energy - u.uEnergy.value) * 0.05;
    this.tankMat.uniforms.uTime.value = t;
    this.tankMat.uniforms.uEnergy.value = u.uEnergy.value;

    const acts = u.uAct.value as number[];
    for (const r of this.regions.values()) {
      r.act += (r.target - r.act) * (r.target > r.act ? 0.12 : 0.03);
      let a = r.act;
      if (r.target > 0) a *= 0.75 + 0.25 * Math.sin(t * 7 + r.index);
      if (r.flicker > 0) {
        r.flicker -= dt;
        a *= Math.random() > 0.5 ? 0.3 : 1;
      }
      acts[r.index] = a;
      r.node.scale.setScalar(0.14 + 0.22 * a);
    }
    this.inputNode.scale.setScalar(0.18 + 0.04 * Math.sin(t * 3));

    // bubbles rise faster with more energy
    const p = this.bubbles.geometry.attributes.position as THREE.BufferAttribute;
    const speed = 0.3 + 0.9 * u.uEnergy.value;
    for (let i = 0; i < p.count; i++) {
      let y = p.getY(i) + this.bubbleSpeed[i] * dt * speed;
      if (y > TANK_Y + TANK_H / 2 - 0.05) y = TANK_Y - TANK_H / 2 + 0.05;
      p.setY(i, y);
      p.setX(i, p.getX(i) + Math.sin(t * 2 + i) * 0.0008);
    }
    p.needsUpdate = true;

    for (const pl of [...this.pulses]) {
      if (pl.t < 1) {
        pl.t = Math.min(1, pl.t + dt * pl.speed);
        pl.head.position.copy(pl.curve.getPoint(pl.t));
        pl.trail.geometry.setDrawRange(0, Math.floor(pl.t * 41));
        if (pl.t >= 1) pl.onArrive?.();
      } else {
        pl.fade -= dt * 1.4;
        (pl.trail.material as THREE.LineBasicMaterial).opacity = Math.max(0, pl.fade) * 0.85;
        (pl.head.material as THREE.SpriteMaterial).opacity = Math.max(0, pl.fade);
        if (pl.fade <= 0) {
          this.scene.remove(pl.head, pl.trail);
          pl.trail.geometry.dispose();
          this.pulses.splice(this.pulses.indexOf(pl), 1);
        }
      }
    }

    this.controls.update();
    this.composer.render();
    this.labels.render(this.scene, this.camera);
  };
}
