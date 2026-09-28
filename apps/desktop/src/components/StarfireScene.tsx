import { type VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

import { useEffect, useRef, useState } from "react";

import * as THREE from "three";

import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import type { InteractionSource } from "../App";

import {
  type Activity,
  type ActivityKind,
  activityExpression,
  activityExpressionAmount,
  applyActivityLife,
  applyActivityPose,
  breathingFor,
  chooseActivity,
  startActivity,
} from "../three/activities";
import {
  carryWalk,
  createDragFeelState,
  updateDragFeel,
} from "../three/dragFeel";
import {
  applyEasterEgg,
  chooseEasterEgg,
  EASTER_EGG_STREAK,
  EASTER_EGG_WINDOW_S,
  type EasterEgg,
  type EasterEggKind,
  startEasterEgg,
} from "../three/easterEgg";

import {
  addBone,
  clamp,
  createPoseTarget,
  createRig,
  dampPoseTarget,
  deg,
  findExpression,
  type HeadAnchor,
  type Rig,
  removeObviousEnvironment,
  resetPoseTarget,
  STARFIRE_BONES,
  type StarfireBoneName,
  setExpression,
} from "../three/pose";

import {
  applyListeningAction,
  applyMicroReaction,
  chooseListeningVariant,
  chooseMicro,
  LISTENING_ACTION_S,
  type ListeningAction,
  type ListeningVariant,
  listeningExpression,
  MICRO_MAX_DELAY,
  MICRO_MIN_DELAY,
  type MicroKind,
  type MicroReaction,
  microDuration,
  microExpression,
} from "../three/reactions";

import StarfireZzz from "./StarfireZzz";

type StarfireSceneProps = {
  error: string | null;

  onActivate: (source: InteractionSource) => void;

  onDragStart: () => void;

  onDragEnd: () => void;
};

type DragState = {
  active: boolean;
  pointerId: number | null;
  moved: boolean;
  startX: number;
  startY: number;
};

type HitPoint = {
  bone: THREE.Object3D;
  radius: number;
};

const LISTENING_VISIBLE_MS = 2600;

const CLICK_THRESHOLD_PX = 5;

const BLINK_MIN_DELAY = 2.4;
const BLINK_MAX_DELAY = 6.4;
const BLINK_DURATION = 0.16;

const POSE_DAMP_RATE = 4.4;

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

  const [activityKind, setActivityKind] = useState<ActivityKind | null>(null);

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

    let baseModelX = 0;
    let baseModelY = 0;
    let baseRotationY = 0;

    let blinkLeftName: string | null = null;
    let blinkRightName: string | null = null;
    let surprisedName: string | null = null;

    let elapsed = 0;
    let breathePhase = 0;

    let nextBlink =
      BLINK_MIN_DELAY + Math.random() * (BLINK_MAX_DELAY - BLINK_MIN_DELAY);
    let blinkStarted = -1;
    let eyesForced = false;

    let nextMicroAt =
      MICRO_MIN_DELAY + Math.random() * (MICRO_MAX_DELAY - MICRO_MIN_DELAY);
    let lastMicroKind: MicroKind | null = null;
    let micro: MicroReaction | null = null;

    let nextActivityAt = 8 + Math.random() * 6;
    let lastActivityKind: ActivityKind | null = null;
    let activity: Activity | null = null;
    let activityExpressionName: string | null = null;

    let listening: ListeningAction | null = null;
    let lastListeningVariant: ListeningVariant | null = null;

    let easterEgg: EasterEgg | null = null;
    let lastEggKind: EasterEggKind | null = null;
    let eggExpression: string | null = null;
    let clickStreak: number[] = [];

    let startle = 0;

    let dragActive = false;

    const dragFeel = createDragFeelState();

    /*
     * Preallocated pose targets — zero allocation in the render loop.
     */
    const instantAcc = createPoseTarget();
    const damped = createPoseTarget();
    const activityTarget = createPoseTarget();
    const zeroTarget = createPoseTarget();

    const cancelActivity = (): void => {
      if (!activity) {
        return;
      }

      if (currentVrm) {
        setExpression(currentVrm, activityExpressionName, 0);
      }

      activity = null;
      activityExpressionName = null;

      setActivityKind(null);
    };

    const cancelEasterEgg = (): void => {
      if (!easterEgg) {
        return;
      }

      if (currentVrm) {
        setExpression(currentVrm, eggExpression, 0);
      }

      easterEgg = null;
      eggExpression = null;
    };

    /*
     * Easter egg: fires after 5 rapid clicks. Pre-empts every other
     * behaviour and replaces the listening gesture for that click.
     */
    const triggerEasterEgg = (): void => {
      if (!currentVrm || !rig || dragActive) {
        return;
      }

      if (micro) {
        setExpression(currentVrm, micro.expression, 0);

        micro = null;
      }

      cancelActivity();

      if (listening) {
        setExpression(currentVrm, listening.expression, 0);

        listening = null;
      }

      cancelEasterEgg();

      const kind = chooseEasterEgg(lastEggKind);

      lastEggKind = kind;

      easterEgg = startEasterEgg(kind, elapsed);
      eggExpression = findExpression(currentVrm, ["happy", "relaxed"]);

      nextActivityAt = elapsed + 12 + Math.random() * 10;
      nextMicroAt = elapsed + 5 + Math.random() * 6;

      console.log(`[Starfire] 🎉 easter egg=${kind}`);
    };

    /*
     * Listening trigger: cancels whatever she was doing, startles her
     * awake if she was sleeping, then plays a dedicated gesture.
     * While an easter egg is playing, only the bubble shows.
     */
    const handleListen = (): void => {
      if (!currentVrm || !rig) {
        return;
      }

      if (easterEgg) {
        return;
      }

      if (micro) {
        setExpression(currentVrm, micro.expression, 0);

        micro = null;
      }

      if (activity?.kind === "sleep") {
        startle = 1;
      }

      cancelActivity();

      if (listening) {
        setExpression(currentVrm, listening.expression, 0);
      }

      const variant = chooseListeningVariant(lastListeningVariant);

      lastListeningVariant = variant;

      const side = Math.random() < 0.5 ? "left" : "right";

      listening = {
        variant,
        side,
        startedAt: elapsed,
        expression: listeningExpression(currentVrm, variant),
      };

      nextMicroAt = elapsed + LISTENING_ACTION_S + 4 + Math.random() * 6;
      nextActivityAt = elapsed + 9 + Math.random() * 8;

      console.log(`[Starfire] ✨ listening action=${variant} side=${side}`);
    };

    window.addEventListener("starfire:listen", handleListen);

    /*
     * ---------------------------------------------------
     * POSE-FOLLOWING 3D HIT TEST
     * ---------------------------------------------------
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
      add("leftLowerLeg", 0.05);
      add("rightLowerLeg", 0.05);

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

      /*
       * Picking her up interrupts whatever she was doing.
       */
      cancelEasterEgg();

      cancelActivity();

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
        clickStreak = clickStreak.filter(
          (at) => elapsed - at <= EASTER_EGG_WINDOW_S,
        );

        clickStreak.push(elapsed);

        if (clickStreak.length >= EASTER_EGG_STREAK) {
          clickStreak = [];

          triggerEasterEgg();
        }

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
          throw new Error("starfire-2.vrm contains no VRM data.");
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

        baseModelX = vrm.scene.position.x;
        baseModelY = vrm.scene.position.y;

        /*
         * rotateVRM0 may flip VRM 0.x models 180deg — preserve it.
         */
        baseRotationY = vrm.scene.rotation.y;

        rig = createRig(vrm);

        hitPoints = buildHitPoints(vrm);

        if (vrm.lookAt) {
          vrm.lookAt.target = lookTarget;
        }

        blinkLeftName = findExpression(vrm, ["blinkLeft", "blink"]);
        blinkRightName = findExpression(vrm, ["blinkRight", "blink"]);
        surprisedName = findExpression(vrm, ["surprised"]);

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

      const dt = Math.min(clock.getDelta(), 0.05);

      elapsed += dt;

      if (currentVrm && rig) {
        const model = currentVrm.scene;

        const s = rig.armSign;
        const fx = rig.forwardX;

        let spinYawDeg = 0;

        /*
         * ---------------------------------------------------
         * 1. INSTANT LIFE LAYER (reset every frame)
         * ---------------------------------------------------
         */
        resetPoseTarget(instantAcc);

        let bounce = 0;

        const breathing = breathingFor(activity?.kind ?? null);

        breathePhase += dt * breathing.rate;

        const breathe = Math.sin(breathePhase) * 0.0035 * breathing.scale;

        /*
         * Base idle drift — barely perceptible life.
         */
        addBone(
          instantAcc,
          "head",
          Math.sin(elapsed * 0.45) * deg(1.1),
          Math.sin(elapsed * 0.31 + 1.7) * deg(1.5),
          0,
        );

        addBone(instantAcc, "spine", 0, 0, Math.sin(elapsed * 0.23) * deg(0.4));

        /*
         * Idle activity machine.
         */
        if (
          !listening &&
          !easterEgg &&
          !activity &&
          elapsed >= nextActivityAt
        ) {
          const kind = chooseActivity(lastActivityKind);

          lastActivityKind = kind;

          activity = startActivity(kind, elapsed);
          activityExpressionName = activityExpression(currentVrm, kind);

          setActivityKind(kind);

          console.log(`[Starfire] 🌙 activity=${kind}`);
        }

        if (activity && elapsed - activity.startedAt >= activity.hold) {
          cancelActivity();

          nextActivityAt = elapsed + 7 + Math.random() * 9;
          nextMicroAt = elapsed + 4 + Math.random() * 8;
        }

        if (activity) {
          const t = elapsed - activity.startedAt;

          resetPoseTarget(activityTarget);

          applyActivityPose(activityTarget, activity, t, rig);
          applyActivityLife(instantAcc, activity, t, rig);

          if (activityExpressionName) {
            const env = Math.min(
              1,
              t / 0.4,
              Math.max(0, (activity.hold - t) / 0.4),
            );

            setExpression(
              currentVrm,
              activityExpressionName,
              env * activityExpressionAmount(activity.kind),
            );
          }
        }

        /*
         * Rare idle micro-reaction (only while standing, never
         * during an activity, listening, or an easter egg).
         */
        if (
          !listening &&
          !easterEgg &&
          !activity &&
          !micro &&
          elapsed >= nextMicroAt
        ) {
          const kind = chooseMicro(lastMicroKind);

          lastMicroKind = kind;

          micro = {
            kind,
            startedAt: elapsed,
            duration: microDuration(kind),
            expression: microExpression(currentVrm, kind),
            strength: 0.5,
          };

          nextMicroAt =
            elapsed +
            MICRO_MIN_DELAY +
            Math.random() * (MICRO_MAX_DELAY - MICRO_MIN_DELAY);
        }

        if (micro) {
          if (elapsed - micro.startedAt >= micro.duration) {
            setExpression(currentVrm, micro.expression, 0);

            micro = null;
          } else {
            const amount = applyMicroReaction(
              instantAcc,
              micro,
              elapsed,
              s,
              fx,
            );

            if (micro.expression) {
              setExpression(currentVrm, micro.expression, amount * 0.9);
            }
          }
        }

        /*
         * ---------------------------------------------------
         * 2. LISTENING GESTURE (instant layer, high priority)
         * ---------------------------------------------------
         */
        if (listening) {
          const t = elapsed - listening.startedAt;

          if (t >= LISTENING_ACTION_S) {
            setExpression(currentVrm, listening.expression, 0);

            listening = null;

            nextMicroAt = elapsed + 3 + Math.random() * 6;
            nextActivityAt = elapsed + 8 + Math.random() * 10;
          } else {
            const env = applyListeningAction(
              instantAcc,
              listening,
              elapsed,
              s,
              fx,
            );

            if (listening.expression) {
              setExpression(currentVrm, listening.expression, env * 0.75);
            }
          }
        }

        /*
         * ---------------------------------------------------
         * 3. EASTER EGG (instant layer, highest priority)
         * ---------------------------------------------------
         */
        if (easterEgg) {
          const t = elapsed - easterEgg.startedAt;

          if (t >= easterEgg.duration) {
            setExpression(currentVrm, eggExpression, 0);

            easterEgg = null;
            eggExpression = null;
          } else {
            const result = applyEasterEgg(
              instantAcc,
              easterEgg,
              elapsed,
              s,
              fx,
            );

            spinYawDeg = result.spinYawDeg;

            if (eggExpression) {
              setExpression(currentVrm, eggExpression, result.env * 0.85);
            }
          }
        }

        /*
         * ---------------------------------------------------
         * 4. DRAG FEEL — carried inertia, turn, walk gait
         * ---------------------------------------------------
         */
        const feel = updateDragFeel(
          dragFeel,
          dt,
          dragActive,
          s,
          window.screenX,
          window.screenY,
        );

        addBone(instantAcc, "spine", 0, 0, deg(feel.leanDeg * 0.6));

        addBone(
          instantAcc,
          "head",
          deg(feel.pitchDeg),
          deg(feel.yawDeg),
          deg(feel.leanDeg),
        );

        if (dragActive) {
          const intensity = clamp(feel.speed / 600, 0, 1);

          const walk = carryWalk(elapsed, intensity, fx);

          addBone(instantAcc, "leftUpperLeg", walk.leftUpperX, 0, 0);
          addBone(instantAcc, "rightUpperLeg", walk.rightUpperX, 0, 0);
          addBone(instantAcc, "leftLowerLeg", walk.leftLowerX, 0, 0);
          addBone(instantAcc, "rightLowerLeg", walk.rightLowerX, 0, 0);
          addBone(instantAcc, "leftUpperArm", walk.leftArmX, 0, 0);
          addBone(instantAcc, "rightUpperArm", walk.rightArmX, 0, 0);
          addBone(instantAcc, "hips", 0, 0, walk.hipRollZ);
          addBone(instantAcc, "spine", walk.leanX, walk.spineYawY, 0);
          addBone(instantAcc, "head", walk.headCompX, 0, 0);

          bounce += walk.bob;
        }

        /*
         * Startle pop when woken from sleep.
         */
        if (startle > 0) {
          bounce += startle * 0.018;

          if (surprisedName) {
            setExpression(currentVrm, surprisedName, startle * 0.7);
          }

          startle = Math.max(0, startle - dt * 1.6);
        }

        /*
         * ---------------------------------------------------
         * 5. DAMPED POSE LAYER
         * ---------------------------------------------------
         *
         * While carried or performing an easter egg, the posture
         * returns to standing so the motion reads cleanly.
         */
        const poseTarget =
          !dragActive && !easterEgg && activity ? activityTarget : zeroTarget;

        const dampRate = Math.min(1, dt * POSE_DAMP_RATE);

        dampPoseTarget(damped, poseTarget, dampRate);

        /*
         * ---------------------------------------------------
         * 6. APPLY — base + damped + instant, rebuilt every frame
         * ---------------------------------------------------
         */
        for (const name of STARFIRE_BONES) {
          const boneRig = rig.bones[name];

          if (!boneRig) {
            continue;
          }

          const d = damped.bones[name];
          const i = instantAcc.bones[name];

          boneRig.bone.rotation.set(
            boneRig.baseX + d.x + i.x,
            boneRig.baseY + d.y + i.y,
            boneRig.baseZ + d.z + i.z,
          );
        }

        bounce += instantAcc.bounce;

        model.position.x = baseModelX + feel.offsetX;

        model.position.y =
          baseModelY + damped.positionY + breathe + bounce + feel.offsetY;

        /*
         * Carried tilt, direction turn, and easter-egg twirl all
         * compose additively around the model's base rotation.
         */
        model.rotation.set(
          feel.offsetY * 1.2,
          baseRotationY + deg(feel.dirYawDeg) + deg(spinYawDeg),
          feel.offsetX * 1.2,
        );

        lookTarget.position.set(damped.lookX, 1.25 + damped.lookY, 4);

        /*
         * Head anchor for the bubble + Zzz.
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
         * Blinking — eyes held closed while sleeping.
         */
        const sleeping = activity?.kind === "sleep";

        if (sleeping) {
          setExpression(currentVrm, blinkLeftName, 1);
          setExpression(currentVrm, blinkRightName, 1);

          blinkStarted = -1;
          eyesForced = true;
        } else {
          if (eyesForced) {
            setExpression(currentVrm, blinkLeftName, 0);
            setExpression(currentVrm, blinkRightName, 0);

            eyesForced = false;

            nextBlink = elapsed + 1 + Math.random() * 2;
          }

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
        }

        currentVrm.update(dt);
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

      {activityKind === "sleep" && <StarfireZzz anchorRef={headAnchorRef} />}

      {error && (
        <div className="starfire-error" title={error}>
          Microphone unavailable
        </div>
      )}
    </>
  );
}
