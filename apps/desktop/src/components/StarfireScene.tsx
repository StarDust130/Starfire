import { type VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

type Reaction = "happy" | "curious" | "wave";

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

function getBone(vrm: VRM, name: "head" | "rightUpperArm" | "rightLowerArm") {
  return vrm.humanoid.getNormalizedBoneNode(name) ?? null;
}

/**
 * Only removes obvious environment
 * objects. It deliberately does NOT
 * remove normal meshes, because some
 * VRM characters use regular Mesh nodes
 * for parts of the character.
 */
function removeObviousEnvironment(vrm: VRM) {
  const environmentNames =
    /background|backdrop|stage|studio|environment|billboard|screen|starfield/i;

  vrm.scene.traverse((object) => {
    const name = object.name.toLowerCase();

    if (environmentNames.test(name)) {
      object.visible = false;

      console.log("🫥 Hidden environment:", object.name || "(unnamed)");
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

  // Relax both arms.
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

function smoothStep(value: number) {
  const t = Math.max(0, Math.min(1, value));

  return t * t * (3 - 2 * t);
}

export default function StarfireScene() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    // ─────────────────────────────
    // Scene
    // ─────────────────────────────

    const scene = new THREE.Scene();

    // ─────────────────────────────
    // Camera
    // ─────────────────────────────

    const camera = new THREE.PerspectiveCamera(
      24,
      container.clientWidth / container.clientHeight,
      0.1,
      20,
    );

    camera.position.set(0, 0.95, 4.5);

    camera.lookAt(0, 0.95, 0);

    // ─────────────────────────────
    // Renderer
    // ─────────────────────────────

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    renderer.setSize(container.clientWidth, container.clientHeight, false);

    renderer.setClearColor(0x000000, 0);

    renderer.outputColorSpace = THREE.SRGBColorSpace;

    renderer.toneMapping = THREE.ACESFilmicToneMapping;

    renderer.toneMappingExposure = 1.05;

    container.appendChild(renderer.domElement);

    // ─────────────────────────────
    // Lighting
    // ─────────────────────────────

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

    // ─────────────────────────────
    // Look target
    // ─────────────────────────────

    const lookTarget = new THREE.Object3D();

    lookTarget.position.set(0, 1.25, 4);

    scene.add(lookTarget);

    // ─────────────────────────────
    // Runtime state
    // ─────────────────────────────

    let currentVrm: VRM | null = null;

    let reactionRig: ReactionRig | null = null;

    let reaction: Reaction | null = null;

    let reactionStarted = 0;

    let reactionDuration = 1;

    let nextReaction = 6 + Math.random() * 7;

    const loader = new GLTFLoader();

    loader.register((parser) => new VRMLoaderPlugin(parser));

    loader.load(
      "/models/starfire-2.vrm",

      (gltf) => {
        const vrm = gltf.userData.vrm as VRM | undefined;

        if (!vrm) {
          console.error("❌ No VRM found.");

          return;
        }

        VRMUtils.rotateVRM0(vrm);

        VRMUtils.removeUnnecessaryVertices(gltf.scene);

        VRMUtils.combineSkeletons(gltf.scene);

        VRMUtils.combineMorphs(vrm);

        vrm.scene.traverse((object) => {
          object.frustumCulled = false;
        });

        // Add model FIRST.
        scene.add(vrm.scene);

        // Remove only obvious
        // environment content.
        removeObviousEnvironment(vrm);

        // ─────────────────────────
        // Normalize model size
        // ─────────────────────────

        const bounds = new THREE.Box3().setFromObject(vrm.scene);

        const size = bounds.getSize(new THREE.Vector3());

        // Small desktop companion.
        const targetHeight = 1.35;

        const scale = targetHeight / Math.max(size.y, 0.001);

        vrm.scene.scale.setScalar(scale);

        const fittedBounds = new THREE.Box3().setFromObject(vrm.scene);

        const center = fittedBounds.getCenter(new THREE.Vector3());

        vrm.scene.position.x = -center.x;

        vrm.scene.position.y = -fittedBounds.min.y;

        vrm.scene.position.z = 0;

        // Relaxed pose.
        reactionRig = applyIdlePose(vrm);

        if (vrm.lookAt) {
          vrm.lookAt.target = lookTarget;
        }

        currentVrm = vrm;

        console.log("🌟 Starfire VRM loaded.");
      },

      undefined,

      (error) => {
        console.error("❌ VRM load failed:", error);
      },
    );

    // ─────────────────────────────
    // Animation
    // ─────────────────────────────

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

    const startReaction = () => {
      const options: Reaction[] = ["happy", "curious", "wave"];

      reaction = options[Math.floor(Math.random() * options.length)];

      reactionStarted = elapsed;

      reactionDuration = reaction === "wave" ? 1.7 : 1.15;

      console.log(`✨ Reaction: ${reaction}`);
    };

    // ─────────────────────────────
    // Resize
    // ─────────────────────────────

    const resize = () => {
      const width = container.clientWidth;

      const height = container.clientHeight;

      if (width <= 0 || height <= 0) {
        return;
      }

      camera.aspect = width / height;

      camera.updateProjectionMatrix();

      renderer.setSize(width, height, false);
    };

    const observer = new ResizeObserver(resize);

    observer.observe(container);

    resize();

    let frame = 0;

    const animate = () => {
      frame = requestAnimationFrame(animate);

      const delta = Math.min(clock.getDelta(), 0.05);

      elapsed += delta;
      lookTime += delta;

      if (currentVrm && reactionRig) {
        const model = currentVrm.scene;

        // Save original transform.
        if (baseTransform === null) {
          baseTransform = {
            y: model.position.y,
            rotationY: model.rotation.y,
            rotationZ: model.rotation.z,
          };
        }

        // Tiny idle breathing.
        model.position.y = baseTransform.y + Math.sin(elapsed * 1.35) * 0.008;

        model.rotation.z =
          baseTransform.rotationZ + Math.sin(elapsed * 0.65) * 0.006;

        model.rotation.y =
          baseTransform.rotationY + Math.sin(elapsed * 0.45) * 0.014;

        // Natural eye/head movement.
        lookTarget.position.x = Math.sin(lookTime * 0.42) * 0.28;

        lookTarget.position.y = 1.24 + Math.sin(lookTime * 0.3) * 0.05;

        // Random reaction.
        if (reaction === null && elapsed >= nextReaction) {
          startReaction();
        }

        if (reaction !== null) {
          const progress = Math.max(
            0,
            Math.min(1, (elapsed - reactionStarted) / reactionDuration),
          );

          const eased = smoothStep(progress);

          const wave = Math.sin(progress * Math.PI);

          // 💗 Happy
          if (reaction === "happy") {
            if (reactionRig.head) {
              reactionRig.head.rotation.z =
                reactionRig.baseHeadZ + wave * THREE.MathUtils.degToRad(9);

              reactionRig.head.rotation.x =
                reactionRig.baseHeadX - wave * THREE.MathUtils.degToRad(4);
            }

            model.position.y = baseTransform.y + wave * 0.03;
          }

          // 👀 Curious
          if (reaction === "curious") {
            if (reactionRig.head) {
              reactionRig.head.rotation.z =
                reactionRig.baseHeadZ + wave * THREE.MathUtils.degToRad(12);

              reactionRig.head.rotation.y =
                reactionRig.baseHeadY + wave * THREE.MathUtils.degToRad(7);
            }
          }

          // 👋 Wave
          if (reaction === "wave") {
            if (reactionRig.rightUpperArm) {
              reactionRig.rightUpperArm.rotation.z =
                reactionRig.baseRightUpperArmZ -
                eased * THREE.MathUtils.degToRad(42);
            }

            if (reactionRig.rightLowerArm) {
              reactionRig.rightLowerArm.rotation.z =
                reactionRig.baseRightLowerArmZ +
                Math.sin(progress * Math.PI * 6) *
                  wave *
                  THREE.MathUtils.degToRad(18);
            }
          }

          if (progress >= 1) {
            reaction = null;

            nextReaction = elapsed + 6 + Math.random() * 8;

            if (reactionRig.head) {
              reactionRig.head.rotation.x = reactionRig.baseHeadX;

              reactionRig.head.rotation.y = reactionRig.baseHeadY;

              reactionRig.head.rotation.z = reactionRig.baseHeadZ;
            }

            if (reactionRig.rightUpperArm) {
              reactionRig.rightUpperArm.rotation.z =
                reactionRig.baseRightUpperArmZ;
            }

            if (reactionRig.rightLowerArm) {
              reactionRig.rightLowerArm.rotation.z =
                reactionRig.baseRightLowerArmZ;
            }
          }
        }

        // 😉 Random blink.
        if (blinkStart < 0 && elapsed >= nextBlink) {
          blinkStart = elapsed;
        }

        if (blinkStart >= 0) {
          const blinkTime = elapsed - blinkStart;

          const blinkDuration = 0.16;

          const progress = Math.min(blinkTime / blinkDuration, 1);

          const value = progress < 0.5 ? progress * 2 : (1 - progress) * 2;

          currentVrm.expressionManager?.setValue("blinkLeft", value);

          currentVrm.expressionManager?.setValue("blinkRight", value);

          if (blinkTime >= blinkDuration) {
            currentVrm.expressionManager?.setValue("blinkLeft", 0);

            currentVrm.expressionManager?.setValue("blinkRight", 0);

            blinkStart = -1;

            nextBlink = elapsed + 2.5 + Math.random() * 4;
          }
        }

        currentVrm.update(delta);
      }

      renderer.render(scene, camera);
    };

    animate();

    return () => {
      cancelAnimationFrame(frame);

      observer.disconnect();

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
