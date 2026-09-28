import { type VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

import { useEffect, useRef, useState } from "react";

import * as THREE from "three";

import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import type { InteractionSource } from "../App";

type StarfireSceneProps = {
  error: string | null;

  onActivate: (source: InteractionSource) => void;

  onDragStart: () => void;

  onDragEnd: () => void;
};

type IdleReaction =
  | "curious"
  | "happy"
  | "shy"
  | "glance"
  | "sway"
  | "left-fidget"
  | "right-fidget";

type ListeningVariant = "greet" | "bounce" | "peek";

type Side = "left" | "right";

type IdleReactionState = {
  type: IdleReaction;
  startedAt: number;
  duration: number;
  expression: string | null;
  strength: number;
};

type ListeningAction = {
  variant: ListeningVariant;
  side: Side;
  startedAt: number;
  expression: string | null;
};

type StarfireBoneName =
  | "head"
  | "spine"
  | "hips"
  | "leftShoulder"
  | "rightShoulder"
  | "leftUpperArm"
  | "rightUpperArm"
  | "leftLowerArm"
  | "rightLowerArm"
  | "leftHand"
  | "rightHand"
  | "leftUpperLeg"
  | "rightUpperLeg";

type BoneRig = {
  bone: THREE.Object3D;
  baseX: number;
  baseY: number;
  baseZ: number;
};

type Rig = {
  armSign: number;
  forwardX: number;
  head: BoneRig | null;
  spine: BoneRig | null;
  hips: BoneRig | null;
  leftShoulder: BoneRig | null;
  rightShoulder: BoneRig | null;
  leftUpperArm: BoneRig | null;
  rightUpperArm: BoneRig | null;
  leftLowerArm: BoneRig | null;
  rightLowerArm: BoneRig | null;
};

type HitPoint = {
  bone: THREE.Object3D;
  radius: number;
};

type DragState = {
  active: boolean;
  pointerId: number | null;
  moved: boolean;
  startX: number;
  startY: number;
};

type HeadAnchor = {
  x: number;
  y: number;
  r: number;
};

const LISTENING_VISIBLE_MS = 2600;
const LISTENING_ACTION_S = 2.75;
const LISTENING_ATTACK_S = 0.28;
const LISTENING_RELEASE_S = 0.55;

const CLICK_THRESHOLD_PX = 5;

const BLINK_MIN_DELAY = 2.4;
const BLINK_MAX_DELAY = 6.4;
const BLINK_DURATION = 0.16;

const IDLE_MIN_DELAY = 14;
const IDLE_MAX_DELAY = 28;

/*
 * Absolute pose targets, in degrees below horizontal, measured from
 * the outward direction:
 *
 *   upper arm   52deg down (relaxed splay)
 *   forearm    102deg down = 12deg past vertical, angled slightly
 *              inward -> a clearly visible, natural elbow bend
 *
 * The loader MEASURES the model's real rest angles and computes the
 * rotations needed to land exactly here. No per-model magic numbers.
 */
const TARGET_UPPER_DEG = 52;
const TARGET_FOREARM_DEG = 102;

const SHOULDER_DROP_DEG = 2.5;

const FOREARM_FORWARD_DEG = 6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function deg(value: number): number {
  return THREE.MathUtils.degToRad(value);
}

function easeOutCubic(value: number): number {
  return 1 - (1 - value) ** 3;
}

function findExpression(vrm: VRM, names: string[]): string | null {
  for (const name of names) {
    if (vrm.expressionManager?.getExpression(name)) {
      return name;
    }
  }

  return null;
}

function setExpression(vrm: VRM, name: string | null, value: number): void {
  if (!name) {
    return;
  }

  const manager = vrm.expressionManager;

  if (!manager) {
    return;
  }

  if (!manager.getExpression(name)) {
    return;
  }

  manager.setValue(name, clamp(value, 0, 1));
}

/*
 * Hide accidental environment objects inside the VRM.
 */
function removeObviousEnvironment(vrm: VRM): void {
  const environmentNames =
    /background|backdrop|stage|studio|environment|billboard|screen|starfield/i;

  vrm.scene.traverse((object) => {
    const name = object.name.toLowerCase();

    if (environmentNames.test(name)) {
      object.visible = false;
    }

    if (object instanceof THREE.Sprite) {
      object.visible = false;
    }
  });
}

function getNormalizedBone(
  vrm: VRM,
  name: StarfireBoneName,
): THREE.Object3D | null {
  return vrm.humanoid.getNormalizedBoneNode(name) ?? null;
}

function captureBone(vrm: VRM, name: StarfireBoneName): BoneRig | null {
  const bone = getNormalizedBone(vrm, name);

  if (!bone) {
    return null;
  }

  return {
    bone,
    baseX: bone.rotation.x,
    baseY: bone.rotation.y,
    baseZ: bone.rotation.z,
  };
}

/*
 * Angle of the a->b segment below the horizontal plane, in degrees.
 * Uses |dx| so it works for either arm.
 */
function angleBelowHorizontalDeg(
  from: THREE.Vector3,
  to: THREE.Vector3,
): number {
  const dx = Math.abs(to.x - from.x);
  const dy = from.y - to.y;

  return THREE.MathUtils.radToDeg(Math.atan2(dy, Math.max(dx, 1e-4)));
}

/*
 * ---------------------------------------------------
 * RELAXED POSE (self-calibrating)
 * ---------------------------------------------------
 *
 * 1. Probe: rotate the left upper arm +10deg and check whether the
 *    elbow moved DOWN in world space. That discovers the correct
 *    rotation direction for THIS model empirically.
 *
 * 2. Measure the model's real rest arm angles (many models ship with
 *    an A-pose rest, not a T-pose).
 *
 * 3. Compute rotations so the FINAL world angles land exactly on the
 *    absolute targets. Bone rotations compose along the chain:
 *
 *      world upper   = restUpper   + appliedUpper
 *      world forearm = restForearm + appliedUpper + appliedElbow
 *
 *    therefore:
 *
 *      appliedUpper = TARGET_UPPER - restUpper
 *      appliedElbow = (TARGET_FOREARM - TARGET_UPPER)
 *                     - (restForearm - restUpper)
 *
 *    The second term (restForearm - restUpper) is the model's own
 *    resting elbow bend, which we must not double-apply.
 */
function createRig(vrm: VRM): Rig {
  vrm.humanoid.resetNormalizedPose();

  const metaVersion = (vrm.meta as { metaVersion?: string }).metaVersion;

  const modelFacesNegativeZ = metaVersion === "0";

  let s = modelFacesNegativeZ ? 1 : -1;

  const probe = new THREE.Vector3();

  const leftUpper = getNormalizedBone(vrm, "leftUpperArm");
  const leftLower = getNormalizedBone(vrm, "leftLowerArm");

  if (leftUpper && leftLower) {
    const yBefore = leftLower.getWorldPosition(probe).y;

    leftUpper.rotation.z += deg(10);

    const yAfter = leftLower.getWorldPosition(probe).y;

    leftUpper.rotation.z -= deg(10);

    s = yAfter < yBefore ? 1 : -1;
  }

  /*
   * Local X sign that tips forearms toward the camera.
   */
  const forwardX = modelFacesNegativeZ ? 1 : -1;

  const calibrate = (side: Side): { upper: number; lower: number } => {
    const upper = getNormalizedBone(
      vrm,
      side === "left" ? "leftUpperArm" : "rightUpperArm",
    );

    const lower = getNormalizedBone(
      vrm,
      side === "left" ? "leftLowerArm" : "rightLowerArm",
    );

    if (!upper || !lower) {
      return {
        upper: TARGET_UPPER_DEG,
        lower: TARGET_FOREARM_DEG - TARGET_UPPER_DEG,
      };
    }

    const hand = getNormalizedBone(
      vrm,
      side === "left" ? "leftHand" : "rightHand",
    );

    const shoulderPos = upper.getWorldPosition(new THREE.Vector3());
    const elbowPos = lower.getWorldPosition(new THREE.Vector3());
    const handPos = (hand ?? lower).getWorldPosition(new THREE.Vector3());

    const restUpper = angleBelowHorizontalDeg(shoulderPos, elbowPos);
    const restForearm = angleBelowHorizontalDeg(elbowPos, handPos);

    const appliedUpper = clamp(TARGET_UPPER_DEG - restUpper, 0, 85);

    const appliedElbow = clamp(
      TARGET_FOREARM_DEG - TARGET_UPPER_DEG - (restForearm - restUpper),
      0,
      85,
    );

    return {
      upper: appliedUpper,
      lower: appliedElbow,
    };
  };

  const leftCal = calibrate("left");
  const rightCal = calibrate("right");

  const apply = (
    name: StarfireBoneName,
    x: number,
    y: number,
    z: number,
  ): void => {
    const bone = getNormalizedBone(vrm, name);

    if (!bone) {
      return;
    }

    bone.rotation.set(x, y, z);
  };

  apply("leftUpperArm", 0, 0, s * deg(leftCal.upper));
  apply("rightUpperArm", 0, 0, -s * deg(rightCal.upper));

  apply(
    "leftLowerArm",
    forwardX * deg(FOREARM_FORWARD_DEG),
    0,
    s * deg(leftCal.lower),
  );
  apply(
    "rightLowerArm",
    forwardX * deg(FOREARM_FORWARD_DEG),
    0,
    -s * deg(rightCal.lower),
  );

  apply("leftShoulder", 0, 0, s * deg(SHOULDER_DROP_DEG));
  apply("rightShoulder", 0, 0, -s * deg(SHOULDER_DROP_DEG));

  return {
    armSign: s,
    forwardX,

    head: captureBone(vrm, "head"),
    spine: captureBone(vrm, "spine"),
    hips: captureBone(vrm, "hips"),

    leftShoulder: captureBone(vrm, "leftShoulder"),
    rightShoulder: captureBone(vrm, "rightShoulder"),

    leftUpperArm: captureBone(vrm, "leftUpperArm"),
    rightUpperArm: captureBone(vrm, "rightUpperArm"),

    leftLowerArm: captureBone(vrm, "leftLowerArm"),
    rightLowerArm: captureBone(vrm, "rightLowerArm"),
  };
}

function idleDuration(type: IdleReaction): number {
  if (type === "glance") {
    return 1.3;
  }

  if (type === "sway") {
    return 1.7;
  }

  if (type === "shy") {
    return 1.15;
  }

  return 0.9;
}

function idleExpression(vrm: VRM, type: IdleReaction): string | null {
  if (type === "happy") {
    return findExpression(vrm, ["happy", "relaxed"]);
  }

  if (type === "curious") {
    return findExpression(vrm, ["relaxed", "surprised"]);
  }

  if (type === "shy") {
    return findExpression(vrm, ["relaxed", "sad"]);
  }

  return null;
}

function listeningExpression(
  vrm: VRM,
  variant: ListeningVariant,
): string | null {
  if (variant === "peek") {
    return findExpression(vrm, ["relaxed", "surprised"]);
  }

  return findExpression(vrm, ["happy", "relaxed"]);
}

function chooseIdleReaction(previous: IdleReaction | null): IdleReaction {
  const pool: IdleReaction[] = [
    "curious",
    "happy",
    "shy",
    "glance",
    "sway",
    "left-fidget",
    "right-fidget",
  ];

  const options = pool.filter((type) => type !== previous);

  return options[Math.floor(Math.random() * options.length)] ?? "curious";
}

function chooseListeningVariant(
  previous: ListeningVariant | null,
): ListeningVariant {
  const pool: ListeningVariant[] = ["greet", "bounce", "peek"];

  const options = pool.filter((variant) => variant !== previous);

  return options[Math.floor(Math.random() * options.length)] ?? "greet";
}

export default function StarfireScene({
  error,
  onActivate,
  onDragStart,
  onDragEnd,
}: StarfireSceneProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const dragRef = useRef<DragState>({
    active: false,
    pointerId: null,
    moved: false,
    startX: 0,
    startY: 0,
  });

  const bubbleRef = useRef<HTMLDivElement | null>(null);

  const headAnchorRef = useRef<HeadAnchor>({ x: 180, y: 90, r: 30 });

  const [showListening, setShowListening] = useState(false);

  /*
   * Show the bubble and restart the hide timer on every trigger.
   */
  useEffect(() => {
    let timer: number | undefined;

    const handleListen = (): void => {
      setShowListening(true);

      window.clearTimeout(timer);

      timer = window.setTimeout(() => {
        setShowListening(false);
      }, LISTENING_VISIBLE_MS);
    };

    window.addEventListener("starfire:listen", handleListen);

    return () => {
      window.removeEventListener("starfire:listen", handleListen);

      window.clearTimeout(timer);
    };
  }, []);

  /*
   * Place the bubble right beside her actual head bone.
   */
  useEffect(() => {
    if (!showListening) {
      return;
    }

    const element = bubbleRef.current;

    if (!element) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const anchor = headAnchorRef.current;

      const bubbleWidth = element.offsetWidth;
      const bubbleHeight = element.offsetHeight;

      const windowWidth = window.innerWidth;
      const windowHeight = window.innerHeight;

      const x = clamp(
        anchor.x + anchor.r + 2,
        6,
        Math.max(6, windowWidth - bubbleWidth - 6),
      );

      const y = clamp(
        anchor.y - bubbleHeight * 0.5,
        6,
        Math.max(6, windowHeight - bubbleHeight - 6),
      );

      element.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [showListening]);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    let disposed = false;

    const scene = new THREE.Scene();

    const width = Math.max(container.clientWidth, 1);
    const height = Math.max(container.clientHeight, 1);

    let stageWidth = width;
    let stageHeight = height;

    const camera = new THREE.PerspectiveCamera(24, width / height, 0.1, 20);

    camera.position.set(0, 0.95, 4.5);

    camera.lookAt(0, 0.95, 0);

    const halfFovTan = Math.tan(deg(camera.fov * 0.5));

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    renderer.setSize(width, height, false);

    renderer.setClearColor(0x000000, 0);

    renderer.outputColorSpace = THREE.SRGBColorSpace;

    renderer.toneMapping = THREE.ACESFilmicToneMapping;

    renderer.toneMappingExposure = 1.05;

    container.appendChild(renderer.domElement);

    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x392d4e, 1.9);

    scene.add(hemisphere);

    const key = new THREE.DirectionalLight(0xffffff, 2.6);

    key.position.set(2.5, 4, 4);

    scene.add(key);

    const fill = new THREE.DirectionalLight(0xc5a8ff, 1.1);

    fill.position.set(-3, 2, 2);

    scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffb2df, 1.3);

    rim.position.set(0, 3, -4);

    scene.add(rim);

    const lookTarget = new THREE.Object3D();

    lookTarget.position.set(0, 1.25, 4);

    scene.add(lookTarget);

    const loader = new GLTFLoader();

    loader.register((parser) => new VRMLoaderPlugin(parser));

    let currentVrm: VRM | null = null;

    let rig: Rig | null = null;

    let hitPoints: HitPoint[] = [];

    let idleReaction: IdleReactionState | null = null;

    let listening: ListeningAction | null = null;

    let lastIdleType: IdleReaction | null = null;

    let lastListeningVariant: ListeningVariant | null = null;

    let blinkLeftName: string | null = null;
    let blinkRightName: string | null = null;

    let baseModelY = 0;

    let elapsed = 0;

    let nextBlink =
      BLINK_MIN_DELAY + Math.random() * (BLINK_MAX_DELAY - BLINK_MIN_DELAY);

    let blinkStarted = -1;

    let nextIdleReaction =
      IDLE_MIN_DELAY + Math.random() * (IDLE_MAX_DELAY - IDLE_MIN_DELAY);

    let dragActive = false;

    let lastWindowX = window.screenX;

    let dragLean = 0;

    /*
     * Listening trigger: dedicated choreography, clearly different
     * from idle. Holds while the bubble is visible, then releases.
     */
    const handleListen = (): void => {
      if (!currentVrm || !rig) {
        return;
      }

      const variant = chooseListeningVariant(lastListeningVariant);

      lastListeningVariant = variant;

      const side: Side = Math.random() < 0.5 ? "left" : "right";

      if (idleReaction) {
        setExpression(currentVrm, idleReaction.expression, 0);

        idleReaction = null;
      }

      if (listening) {
        setExpression(currentVrm, listening.expression, 0);
      }

      listening = {
        variant,
        side,
        startedAt: elapsed,
        expression: listeningExpression(currentVrm, variant),
      };

      nextIdleReaction = elapsed + IDLE_MAX_DELAY + Math.random() * 10;

      console.log(`[Starfire] ✨ listening action=${variant} side=${side}`);
    };

    window.addEventListener("starfire:listen", handleListen);

    /*
     * ---------------------------------------------------
     * POSE-FOLLOWING 3D HIT TEST
     * ---------------------------------------------------
     *
     * Raycasting skinned geometry tests the bind pose, so instead
     * the real normalized bones are projected through the camera
     * and tested against per-bone pixel radii.
     */
    const anchorVector = new THREE.Vector3();

    const buildHitPoints = (vrm: VRM): HitPoint[] => {
      const points: HitPoint[] = [];

      const add = (name: StarfireBoneName, radius: number): void => {
        const bone = vrm.humanoid.getNormalizedBoneNode(name);

        if (bone) {
          points.push({ bone, radius });
        }
      };

      add("head", 0.16);
      add("spine", 0.13);
      add("hips", 0.15);

      add("leftUpperArm", 0.055);
      add("rightUpperArm", 0.055);
      add("leftLowerArm", 0.05);
      add("rightLowerArm", 0.05);
      add("leftHand", 0.05);
      add("rightHand", 0.05);

      add("leftUpperLeg", 0.06);
      add("rightUpperLeg", 0.06);

      return points;
    };

    const isOverStarfire = (event: PointerEvent): boolean => {
      if (!currentVrm || hitPoints.length === 0) {
        return false;
      }

      const rect = renderer.domElement.getBoundingClientRect();

      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;

      for (const point of hitPoints) {
        point.bone.getWorldPosition(anchorVector);

        const distance = anchorVector.distanceTo(camera.position);

        if (distance < 0.001) {
          continue;
        }

        anchorVector.project(camera);

        const screenX = (anchorVector.x * 0.5 + 0.5) * rect.width;
        const screenY = (-anchorVector.y * 0.5 + 0.5) * rect.height;

        const pixelRadius =
          (point.radius / (2 * distance * halfFovTan)) * rect.height + 6;

        const dx = pointerX - screenX;
        const dy = pointerY - screenY;

        if (dx * dx + dy * dy <= pixelRadius * pixelRadius) {
          return true;
        }
      }

      return false;
    };

    /*
     * ---------------------------------------------------
     * POINTER + DRAG
     * ---------------------------------------------------
     */
    const handlePointerMove = (event: PointerEvent): void => {
      const drag = dragRef.current;

      if (drag.active && drag.pointerId === event.pointerId) {
        if (
          Math.hypot(event.screenX - drag.startX, event.screenY - drag.startY) >
          CLICK_THRESHOLD_PX
        ) {
          drag.moved = true;
        }

        renderer.domElement.style.cursor = "grabbing";

        return;
      }

      renderer.domElement.style.cursor = isOverStarfire(event)
        ? "grab"
        : "default";
    };

    const handlePointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) {
        return;
      }

      /*
       * Outside Starfire = absolutely nothing happens.
       */
      if (!isOverStarfire(event)) {
        renderer.domElement.style.cursor = "default";

        return;
      }

      dragRef.current = {
        active: true,
        pointerId: event.pointerId,
        moved: false,
        startX: event.screenX,
        startY: event.screenY,
      };

      dragActive = true;

      event.preventDefault();

      renderer.domElement.style.cursor = "grabbing";

      renderer.domElement.setPointerCapture(event.pointerId);

      onDragStart();
    };

    const finishDrag = (event: PointerEvent, allowClick: boolean): void => {
      const drag = dragRef.current;

      if (!drag.active || drag.pointerId !== event.pointerId) {
        return;
      }

      const wasClick = allowClick && !drag.moved;

      dragRef.current = {
        active: false,
        pointerId: null,
        moved: false,
        startX: 0,
        startY: 0,
      };

      dragActive = false;

      onDragEnd();

      renderer.domElement.style.cursor = "default";

      if (renderer.domElement.hasPointerCapture(event.pointerId)) {
        renderer.domElement.releasePointerCapture(event.pointerId);
      }

      if (wasClick) {
        onActivate("click");
      }
    };

    const handlePointerUp = (event: PointerEvent): void => {
      finishDrag(event, true);
    };

    const handlePointerCancel = (event: PointerEvent): void => {
      finishDrag(event, false);
    };

    renderer.domElement.addEventListener("pointermove", handlePointerMove);

    renderer.domElement.addEventListener("pointerdown", handlePointerDown);

    renderer.domElement.addEventListener("pointerup", handlePointerUp);

    renderer.domElement.addEventListener("pointercancel", handlePointerCancel);

    /*
     * ---------------------------------------------------
     * LOAD MODEL
     * ---------------------------------------------------
     */
    const loadModel = async (): Promise<void> => {
      try {
        console.log("[Starfire] 🌸 loading VRM...");

        const gltf = await loader.loadAsync("/models/starfire-3.vrm");

        if (disposed) {
          return;
        }

        const vrm = gltf.userData.vrm as VRM | undefined;

        if (!vrm) {
          throw new Error("starfire-3.vrm contains no VRM data.");
        }

        VRMUtils.rotateVRM0(vrm);

        VRMUtils.removeUnnecessaryVertices(gltf.scene);

        VRMUtils.combineSkeletons(gltf.scene);

        VRMUtils.combineMorphs(vrm);

        vrm.scene.traverse((object) => {
          object.frustumCulled = false;
        });

        removeObviousEnvironment(vrm);

        const targetHeight = 1.3;

        const bounds = new THREE.Box3().setFromObject(vrm.scene);

        const size = bounds.getSize(new THREE.Vector3());

        const scale = targetHeight / Math.max(size.y, 0.001);

        vrm.scene.scale.setScalar(scale);

        const fittedBounds = new THREE.Box3().setFromObject(vrm.scene);

        const center = fittedBounds.getCenter(new THREE.Vector3());

        vrm.scene.position.x = -center.x;
        vrm.scene.position.y = -fittedBounds.min.y;
        vrm.scene.position.z = 0;

        /*
         * Framing offset — breathing/bounce ADD to this every frame.
         */
        baseModelY = vrm.scene.position.y;

        rig = createRig(vrm);

        hitPoints = buildHitPoints(vrm);

        if (vrm.lookAt) {
          vrm.lookAt.target = lookTarget;
        }

        blinkLeftName = findExpression(vrm, ["blinkLeft", "blink"]);
        blinkRightName = findExpression(vrm, ["blinkRight", "blink"]);

        currentVrm = vrm;

        scene.add(vrm.scene);

        console.log("[Starfire] ✅ VRM loaded.");

        console.log(
          `[Starfire] 🦴 calibrated relaxed pose (armSign=${rig.armSign}).`,
        );
      } catch (cause) {
        console.error("[Starfire] ❌ VRM load failed:", cause);
      }
    };

    void loadModel();

    const clock = new THREE.Clock();

    const resize = (): void => {
      const nextWidth = Math.max(container.clientWidth, 1);
      const nextHeight = Math.max(container.clientHeight, 1);

      stageWidth = nextWidth;
      stageHeight = nextHeight;

      camera.aspect = nextWidth / nextHeight;

      camera.updateProjectionMatrix();

      renderer.setSize(nextWidth, nextHeight, false);
    };

    const resizeObserver = new ResizeObserver(resize);

    resizeObserver.observe(container);

    resize();

    let frame = 0;

    const animate = (): void => {
      if (disposed) {
        return;
      }

      frame = requestAnimationFrame(animate);

      const delta = Math.min(clock.getDelta(), 0.05);

      elapsed += delta;

      if (currentVrm && rig) {
        const model = currentVrm.scene;

        const s = rig.armSign;
        const fx = rig.forwardX;

        const breathe = Math.sin(elapsed * 1.4) * 0.0035;

        let bounceY = 0;

        let headXOff = Math.sin(elapsed * 0.45) * deg(1.1);
        let headYOff = Math.sin(elapsed * 0.31 + 1.7) * deg(1.5);
        let headZOff = 0;

        let spineXOff = 0;
        let spineZOff = Math.sin(elapsed * 0.23) * deg(0.4);

        let hipsZOff = 0;

        let leftShoulderZOff = 0;
        let rightShoulderZOff = 0;

        let leftUpperZOff = 0;
        let rightUpperZOff = 0;
        let leftLowerZOff = 0;
        let rightLowerZOff = 0;
        let leftLowerXOff = 0;
        let rightLowerXOff = 0;

        const closeLeft = s;
        const closeRight = -s;

        /*
         * Rare idle micro-reaction (never during listening).
         */
        if (!listening && !idleReaction && elapsed >= nextIdleReaction) {
          const type = chooseIdleReaction(lastIdleType);

          lastIdleType = type;

          idleReaction = {
            type,
            startedAt: elapsed,
            duration: idleDuration(type),
            expression: idleExpression(currentVrm, type),
            strength: 0.5,
          };

          nextIdleReaction =
            elapsed +
            IDLE_MIN_DELAY +
            Math.random() * (IDLE_MAX_DELAY - IDLE_MIN_DELAY);
        }

        if (idleReaction) {
          const progress = clamp(
            (elapsed - idleReaction.startedAt) / idleReaction.duration,
            0,
            1,
          );

          const bell = Math.sin(progress * Math.PI);

          const amount = bell * idleReaction.strength;

          const wiggle = Math.sin(progress * Math.PI * 3) * amount;

          if (idleReaction.type === "curious") {
            headYOff += deg(6) * amount;
            headZOff -= deg(5) * amount;
          }

          if (idleReaction.type === "happy") {
            bounceY += 0.011 * amount;
            headXOff -= deg(2) * amount;
            leftShoulderZOff += -s * deg(6) * amount;
            rightShoulderZOff += s * deg(6) * amount;
          }

          if (idleReaction.type === "shy") {
            headXOff += deg(3.5) * amount;
            headYOff += deg(5) * amount;
            headZOff += deg(3) * amount;
            spineZOff -= deg(1.5) * amount;
            leftUpperZOff += closeLeft * deg(2) * amount;
            rightUpperZOff += closeRight * deg(2) * amount;
            leftLowerXOff += fx * deg(4) * amount;
            rightLowerXOff += fx * deg(4) * amount;
          }

          if (idleReaction.type === "glance") {
            headYOff +=
              Math.sin(progress * Math.PI * 2) * deg(7) * idleReaction.strength;
          }

          if (idleReaction.type === "sway") {
            spineZOff +=
              Math.sin(progress * Math.PI * 2) *
              deg(1.6) *
              idleReaction.strength;
            hipsZOff -=
              Math.sin(progress * Math.PI * 2) *
              deg(1.2) *
              idleReaction.strength;
          }

          if (idleReaction.type === "left-fidget") {
            leftUpperZOff -= s * deg(3) * amount;
            leftLowerZOff += s * deg(14) * wiggle;
            leftLowerXOff += fx * deg(5) * amount;
          }

          if (idleReaction.type === "right-fidget") {
            rightUpperZOff += s * deg(3) * amount;
            rightLowerZOff -= s * deg(14) * wiggle;
            rightLowerXOff += fx * deg(5) * amount;
          }

          if (idleReaction.expression) {
            setExpression(currentVrm, idleReaction.expression, amount * 0.9);
          }

          if (progress >= 1) {
            setExpression(currentVrm, idleReaction.expression, 0);

            idleReaction = null;
          }
        }

        /*
         * Listening choreography — attack, hold with subtle life,
         * release. Clearly distinct from idle.
         */
        if (listening) {
          const t = elapsed - listening.startedAt;

          if (t >= LISTENING_ACTION_S) {
            setExpression(currentVrm, listening.expression, 0);

            listening = null;

            nextIdleReaction = elapsed + IDLE_MIN_DELAY + Math.random() * 10;
          } else {
            const attack = easeOutCubic(clamp(t / LISTENING_ATTACK_S, 0, 1));

            const release = easeOutCubic(
              clamp((LISTENING_ACTION_S - t) / LISTENING_RELEASE_S, 0, 1),
            );

            const env = attack * release;

            const sideSign = listening.side === "left" ? 1 : -1;

            const closeSide =
              listening.side === "left" ? closeLeft : closeRight;

            if (listening.variant === "greet") {
              /*
               * Raises one hand in front of her with a little
               * wiggle — unmistakably "I'm listening!".
               */
              const wobble = Math.sin(t * Math.PI * 2 * 1.7);

              headZOff += s * sideSign * deg(6) * env;
              headYOff += sideSign * deg(3) * env;

              spineZOff += closeSide * deg(1.2) * env;

              if (listening.side === "left") {
                leftShoulderZOff += s * deg(4) * env;
                leftUpperZOff += s * deg(2) * env;
                leftLowerZOff += s * deg(78 + wobble * 6) * env;
                leftLowerXOff += fx * deg(6) * env;
              } else {
                rightShoulderZOff -= s * deg(4) * env;
                rightUpperZOff -= s * deg(2) * env;
                rightLowerZOff -= s * deg(78 + wobble * 6) * env;
                rightLowerXOff += fx * deg(6) * env;
              }
            }

            if (listening.variant === "bounce") {
              /*
               * Two happy little hops with a nod.
               */
              const hop = Math.abs(Math.sin(t * Math.PI * 2 * 1.15));

              bounceY += hop * 0.012 * env;

              headXOff -= deg(2) * hop * env;

              leftShoulderZOff += -s * deg(5) * env;
              rightShoulderZOff += s * deg(5) * env;
              leftLowerXOff += fx * deg(4) * env;
              rightLowerXOff += fx * deg(4) * env;
            }

            if (listening.variant === "peek") {
              /*
               * Leans toward you, hands drawn slightly in —
               * "leaning in to hear you better".
               */
              spineXOff += fx * deg(2.5) * env;
              spineZOff += closeSide * deg(1.5) * env;
              headXOff += fx * deg(1.5) * env;
              headYOff += Math.sin(t * Math.PI * 1.6) * deg(2.5) * env;
              headZOff += s * sideSign * deg(4) * env;

              leftUpperZOff += closeLeft * deg(3) * env;
              rightUpperZOff += closeRight * deg(3) * env;
              leftLowerXOff += fx * deg(6) * env;
              rightLowerXOff += fx * deg(6) * env;
            }

            if (listening.expression) {
              setExpression(currentVrm, listening.expression, env * 0.75);
            }
          }
        }

        /*
         * Drag feel: lean into the window's motion, measured from the
         * real window position (renderer pointer events are unreliable
         * while the OS moves the window).
         */
        const windowX = window.screenX;

        const windowVel = (windowX - lastWindowX) / Math.max(delta, 0.001);

        lastWindowX = windowX;

        /*
         * The window itself moving is definitive proof of a drag —
         * pointermove events can be starved during native moves.
         */
        if (dragActive && Math.abs(windowVel) > 50) {
          dragRef.current.moved = true;
        }

        const targetLean = clamp(s * windowVel * 0.004, -4, 4);

        dragLean += (targetLean - dragLean) * Math.min(1, delta * 8);

        if (dragActive) {
          bounceY += Math.sin(elapsed * 9) * 0.002;
        }

        spineZOff += deg(dragLean * 0.6);
        headZOff += deg(dragLean);

        /*
         * Rebuild every animated bone from its stored base.
         */
        if (rig.head) {
          rig.head.bone.rotation.set(
            rig.head.baseX + headXOff,
            rig.head.baseY + headYOff,
            rig.head.baseZ + headZOff,
          );
        }

        if (rig.spine) {
          rig.spine.bone.rotation.set(
            rig.spine.baseX + spineXOff,
            rig.spine.baseY,
            rig.spine.baseZ + spineZOff,
          );
        }

        if (rig.hips) {
          rig.hips.bone.rotation.set(
            rig.hips.baseX,
            rig.hips.baseY,
            rig.hips.baseZ + hipsZOff,
          );
        }

        if (rig.leftShoulder) {
          rig.leftShoulder.bone.rotation.set(
            rig.leftShoulder.baseX,
            rig.leftShoulder.baseY,
            rig.leftShoulder.baseZ + leftShoulderZOff,
          );
        }

        if (rig.rightShoulder) {
          rig.rightShoulder.bone.rotation.set(
            rig.rightShoulder.baseX,
            rig.rightShoulder.baseY,
            rig.rightShoulder.baseZ + rightShoulderZOff,
          );
        }

        if (rig.leftUpperArm) {
          rig.leftUpperArm.bone.rotation.set(
            rig.leftUpperArm.baseX,
            rig.leftUpperArm.baseY,
            rig.leftUpperArm.baseZ + leftUpperZOff,
          );
        }

        if (rig.rightUpperArm) {
          rig.rightUpperArm.bone.rotation.set(
            rig.rightUpperArm.baseX,
            rig.rightUpperArm.baseY,
            rig.rightUpperArm.baseZ + rightUpperZOff,
          );
        }

        if (rig.leftLowerArm) {
          rig.leftLowerArm.bone.rotation.set(
            rig.leftLowerArm.baseX + leftLowerXOff,
            rig.leftLowerArm.baseY,
            rig.leftLowerArm.baseZ + leftLowerZOff,
          );
        }

        if (rig.rightLowerArm) {
          rig.rightLowerArm.bone.rotation.set(
            rig.rightLowerArm.baseX + rightLowerXOff,
            rig.rightLowerArm.baseY,
            rig.rightLowerArm.baseZ + rightLowerZOff,
          );
        }

        /*
         * Breathing + bounce on top of the framing offset.
         */
        model.position.y = baseModelY + breathe + bounceY;

        /*
         * Head anchor for the listening bubble.
         */
        if (rig.head) {
          rig.head.bone.getWorldPosition(anchorVector);

          const distance = anchorVector.distanceTo(camera.position);

          anchorVector.project(camera);

          const anchor = headAnchorRef.current;

          anchor.x = (anchorVector.x * 0.5 + 0.5) * stageWidth;
          anchor.y = (-anchorVector.y * 0.5 + 0.5) * stageHeight;

          anchor.r =
            distance < 0.001
              ? anchor.r
              : (0.16 / (2 * distance * halfFovTan)) * stageHeight + 6;
        }

        /*
         * Natural blinking.
         */
        if (blinkStarted < 0 && elapsed >= nextBlink) {
          blinkStarted = elapsed;
        }

        if (blinkStarted >= 0) {
          const blinkTime = elapsed - blinkStarted;

          const progress = clamp(blinkTime / BLINK_DURATION, 0, 1);

          const value = progress < 0.5 ? progress * 2 : (1 - progress) * 2;

          setExpression(currentVrm, blinkLeftName, value);
          setExpression(currentVrm, blinkRightName, value);

          if (blinkTime >= BLINK_DURATION) {
            setExpression(currentVrm, blinkLeftName, 0);
            setExpression(currentVrm, blinkRightName, 0);

            blinkStarted = -1;

            nextBlink =
              elapsed +
              BLINK_MIN_DELAY +
              Math.random() * (BLINK_MAX_DELAY - BLINK_MIN_DELAY);
          }
        }

        currentVrm.update(delta);
      }

      renderer.render(scene, camera);
    };

    animate();

    return () => {
      disposed = true;

      cancelAnimationFrame(frame);

      resizeObserver.disconnect();

      window.removeEventListener("starfire:listen", handleListen);

      renderer.domElement.removeEventListener("pointermove", handlePointerMove);

      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);

      renderer.domElement.removeEventListener("pointerup", handlePointerUp);

      renderer.domElement.removeEventListener(
        "pointercancel",
        handlePointerCancel,
      );

      if (currentVrm) {
        VRMUtils.deepDispose(currentVrm.scene);
      }

      renderer.dispose();

      renderer.domElement.remove();

      scene.clear();
    };
  }, [onActivate, onDragStart, onDragEnd]);

  return (
    <>
      <div className="starfire-stage">
        <div ref={containerRef} className="starfire-canvas" />
      </div>

      {showListening && !error && (
        <div className="starfire-listening" ref={bubbleRef}>
          <div className="starfire-listening-float">
            <div className="starfire-listening-card">
              <div className="starfire-listening-title">
                <span className="starfire-listening-dot" />
                Listening…
              </div>
              <div className="starfire-listening-sub">I'm right here ♡</div>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="starfire-error" title={error}>
          Microphone unavailable
        </div>
      )}
    </>
  );
}
