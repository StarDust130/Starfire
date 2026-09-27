import { type VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

type Reaction = "happy" | "curious" | "wave";

type VoiceState = "idle" | "listening" | "thinking" | "speaking";

type ReactionRig = {
  head: THREE.Object3D | null;

  rightUpperArm: THREE.Object3D | null;

  rightLowerArm: THREE.Object3D | null;

  baseHeadX: number;
  baseHeadY: number;
  baseHeadZ: number;

  baseRightUpperArmZ: number;
  baseRightLowerArmZ: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function smoothStep(value: number): number {
  const t = clamp(value, 0, 1);

  return t * t * (3 - 2 * t);
}

function getBone(
  vrm: VRM,
  name: "head" | "rightUpperArm" | "rightLowerArm",
): THREE.Object3D | null {
  return vrm.humanoid.getNormalizedBoneNode(name) ?? null;
}

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

function applyIdlePose(vrm: VRM): ReactionRig {
  const head = getBone(vrm, "head");

  const rightUpperArm = getBone(vrm, "rightUpperArm");

  const rightLowerArm = getBone(vrm, "rightLowerArm");

  const leftUpperArm = vrm.humanoid.getNormalizedBoneNode("leftUpperArm");

  const leftLowerArm = vrm.humanoid.getNormalizedBoneNode("leftLowerArm");

  if (leftUpperArm) {
    leftUpperArm.rotation.z = THREE.MathUtils.degToRad(68);
  }

  if (rightUpperArm) {
    rightUpperArm.rotation.z = THREE.MathUtils.degToRad(-68);
  }

  if (leftLowerArm) {
    leftLowerArm.rotation.x = THREE.MathUtils.degToRad(-4);

    leftLowerArm.rotation.z = THREE.MathUtils.degToRad(10);
  }

  if (rightLowerArm) {
    rightLowerArm.rotation.x = THREE.MathUtils.degToRad(-4);

    rightLowerArm.rotation.z = THREE.MathUtils.degToRad(-10);
  }

  return {
    head,
    rightUpperArm,
    rightLowerArm,
    baseHeadX: head?.rotation.x ?? 0,
    baseHeadY: head?.rotation.y ?? 0,
    baseHeadZ: head?.rotation.z ?? 0,
    baseRightUpperArmZ: rightUpperArm?.rotation.z ?? 0,
    baseRightLowerArmZ: rightLowerArm?.rotation.z ?? 0,
  };
}

function setExpression(vrm: VRM, name: string, weight: number): void {
  const manager = vrm.expressionManager;

  if (!manager) {
    return;
  }

  if (manager.getExpression(name) === null) {
    return;
  }

  manager.setValue(name, clamp(weight, 0, 1));
}

export default function StarfireScene() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    let disposed = false;

    const scene = new THREE.Scene();

    const width = Math.max(container.clientWidth, 1);

    const height = Math.max(container.clientHeight, 1);

    const camera = new THREE.PerspectiveCamera(24, width / height, 0.1, 20);

    camera.position.set(0, 0.95, 4.5);

    camera.lookAt(0, 0.95, 0);

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

    let currentVrm: VRM | null = null;

    let reactionRig: ReactionRig | null = null;

    let reaction: Reaction | null = null;

    let reactionStarted = 0;
    let reactionDuration = 1;

    let nextReaction = 6 + Math.random() * 7;

    let voiceState: VoiceState = "idle";

    let voiceLevel = 0;

    let mouthExpression: string | null = null;

    const onVoiceState = (event: Event) => {
      const customEvent = event as CustomEvent<VoiceState>;

      voiceState = customEvent.detail;
    };

    const onVoiceLevel = (event: Event) => {
      const customEvent = event as CustomEvent<number>;

      voiceLevel = clamp(customEvent.detail, 0, 1);
    };

    window.addEventListener("starfire:voice-state", onVoiceState);

    window.addEventListener("starfire:voice-level", onVoiceLevel);

    const loader = new GLTFLoader();

    loader.register((parser) => new VRMLoaderPlugin(parser));

    const loadModel = async (): Promise<void> => {
      try {
        console.log("🌟 Loading Starfire VRM...");

        const gltf = await loader.loadAsync("/models/starfire-2.vrm");

        if (disposed) {
          return;
        }

        const vrm = gltf.userData.vrm as VRM | undefined;

        if (!vrm) {
          throw new Error("The file loaded but contains no VRM.");
        }

        VRMUtils.rotateVRM0(vrm);

        VRMUtils.removeUnnecessaryVertices(gltf.scene);

        VRMUtils.combineSkeletons(gltf.scene);

        VRMUtils.combineMorphs(vrm);

        vrm.scene.traverse((object) => {
          object.frustumCulled = false;
        });

        removeObviousEnvironment(vrm);

        scene.add(vrm.scene);

        const bounds = new THREE.Box3().setFromObject(vrm.scene);

        const size = bounds.getSize(new THREE.Vector3());

        const targetHeight = 1.35;

        const scale = targetHeight / Math.max(size.y, 0.001);

        vrm.scene.scale.setScalar(scale);

        const fittedBounds = new THREE.Box3().setFromObject(vrm.scene);

        const center = fittedBounds.getCenter(new THREE.Vector3());

        vrm.scene.position.x = -center.x;

        vrm.scene.position.y = -fittedBounds.min.y;

        vrm.scene.position.z = 0;

        reactionRig = applyIdlePose(vrm);

        if (vrm.lookAt) {
          vrm.lookAt.target = lookTarget;
        }

        if (vrm.expressionManager) {
          const candidates = ["aa", "oh", "ou"];

          mouthExpression =
            candidates.find(
              (name) => vrm.expressionManager?.getExpression(name) !== null,
            ) ?? null;
        }

        currentVrm = vrm;

        console.log("🌟 Starfire VRM loaded.");

        console.log("🌸 Mouth expression:", mouthExpression ?? "none");
      } catch (error) {
        console.error("❌ VRM load failed:", error);
      }
    };

    void loadModel();

    const clock = new THREE.Clock();

    let elapsed = 0;
    let lookTime = 0;
    let blinkStart = -1;

    let nextBlink = 2.5 + Math.random() * 3;

    let baseTransform: {
      y: number;
      rotationY: number;
      rotationZ: number;
    } | null = null;

    const startReaction = (): void => {
      const options: Reaction[] = ["happy", "curious", "wave"];

      reaction = options[Math.floor(Math.random() * options.length)];

      reactionStarted = elapsed;

      reactionDuration = reaction === "wave" ? 1.7 : 1.15;
    };

    const resize = (): void => {
      const nextWidth = Math.max(container.clientWidth, 1);

      const nextHeight = Math.max(container.clientHeight, 1);

      camera.aspect = nextWidth / nextHeight;

      camera.updateProjectionMatrix();

      renderer.setSize(nextWidth, nextHeight, false);
    };

    const observer = new ResizeObserver(resize);

    observer.observe(container);

    resize();

    let frame = 0;

    const animate = (): void => {
      if (disposed) {
        return;
      }

      frame = requestAnimationFrame(animate);

      const delta = Math.min(clock.getDelta(), 0.05);

      elapsed += delta;
      lookTime += delta;

      if (currentVrm && reactionRig) {
        const model = currentVrm.scene;

        if (baseTransform === null) {
          baseTransform = {
            y: model.position.y,
            rotationY: model.rotation.y,
            rotationZ: model.rotation.z,
          };
        }

        model.position.y = baseTransform.y + Math.sin(elapsed * 1.35) * 0.008;

        model.rotation.y =
          baseTransform.rotationY + Math.sin(elapsed * 0.45) * 0.014;

        let headX = reactionRig.baseHeadX;

        let headY = reactionRig.baseHeadY;

        let headZ = reactionRig.baseHeadZ;

        let armZ = reactionRig.baseRightUpperArmZ;

        let lowerArmZ = reactionRig.baseRightLowerArmZ;

        lookTarget.position.x = Math.sin(lookTime * 0.42) * 0.28;

        lookTarget.position.y = 1.24 + Math.sin(lookTime * 0.3) * 0.05;

        if (
          reaction === null &&
          voiceState === "idle" &&
          elapsed >= nextReaction
        ) {
          startReaction();
        }

        if (reaction !== null) {
          const progress = clamp(
            (elapsed - reactionStarted) / reactionDuration,
            0,
            1,
          );

          const eased = smoothStep(progress);

          const wave = Math.sin(progress * Math.PI);

          if (reaction === "happy") {
            headZ += wave * THREE.MathUtils.degToRad(9);

            headX -= wave * THREE.MathUtils.degToRad(4);

            model.position.y = baseTransform.y + wave * 0.03;
          }

          if (reaction === "curious") {
            headZ += wave * THREE.MathUtils.degToRad(12);

            headY += wave * THREE.MathUtils.degToRad(7);
          }

          if (reaction === "wave") {
            armZ -= eased * THREE.MathUtils.degToRad(42);

            lowerArmZ +=
              Math.sin(progress * Math.PI * 6) *
              wave *
              THREE.MathUtils.degToRad(18);
          }

          if (progress >= 1) {
            reaction = null;

            nextReaction = elapsed + 6 + Math.random() * 8;
          }
        }

        if (voiceState === "listening") {
          headZ += THREE.MathUtils.degToRad(4);
        }

        if (voiceState === "thinking") {
          headZ -= THREE.MathUtils.degToRad(3);
        }

        if (voiceState === "speaking") {
          headZ += Math.sin(elapsed * 7) * 0.012;
        }

        if (reactionRig.head) {
          reactionRig.head.rotation.x = headX;

          reactionRig.head.rotation.y = headY;

          reactionRig.head.rotation.z = headZ;
        }

        if (reactionRig.rightUpperArm) {
          reactionRig.rightUpperArm.rotation.z = armZ;
        }

        if (reactionRig.rightLowerArm) {
          reactionRig.rightLowerArm.rotation.z = lowerArmZ;
        }

        if (blinkStart < 0 && elapsed >= nextBlink) {
          blinkStart = elapsed;
        }

        if (blinkStart >= 0) {
          const blinkTime = elapsed - blinkStart;

          const blinkDuration = 0.16;

          const progress = Math.min(blinkTime / blinkDuration, 1);

          const value = progress < 0.5 ? progress * 2 : (1 - progress) * 2;

          setExpression(currentVrm, "blinkLeft", value);

          setExpression(currentVrm, "blinkRight", value);

          if (blinkTime >= blinkDuration) {
            setExpression(currentVrm, "blinkLeft", 0);

            setExpression(currentVrm, "blinkRight", 0);

            blinkStart = -1;

            nextBlink = elapsed + 2.5 + Math.random() * 4;
          }
        }

        if (mouthExpression && currentVrm.expressionManager) {
          const manager = currentVrm.expressionManager;

          const current = manager.getValue(mouthExpression) ?? 0;

          const target =
            voiceState === "speaking"
              ? clamp(0.12 + voiceLevel * 0.88, 0, 1)
              : 0;

          manager.setValue(
            mouthExpression,
            THREE.MathUtils.lerp(current, target, Math.min(1, delta * 18)),
          );
        }

        currentVrm.update(delta);
      }

      renderer.render(scene, camera);
    };

    animate();

    return () => {
      disposed = true;

      cancelAnimationFrame(frame);

      observer.disconnect();

      window.removeEventListener("starfire:voice-state", onVoiceState);

      window.removeEventListener("starfire:voice-level", onVoiceLevel);

      if (currentVrm) {
        VRMUtils.deepDispose(currentVrm.scene);
      }

      renderer.dispose();

      renderer.domElement.remove();

      scene.clear();
    };
  }, []);

  return (
    <div className="starfire-stage">
      <div ref={containerRef} className="starfire-canvas" />
    </div>
  );
}
