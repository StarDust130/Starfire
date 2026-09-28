export type MicChunk = {
  samples: Float32Array;

  rms: number;
};

export type MicHandlers = {
  onChunk: (chunk: MicChunk) => void;

  onDiagnostic?: (message: string) => void;
};

/*
 * Capture configurations tried in order when hunting a working mic:
 *  - processing: echo cancellation / noise suppression / AGC on/off.
 *    NOTE: `audio: true` does NOT disable processing (Chromium still
 *    enables EC) — it must be explicitly false to be truly raw.
 *  - useDeviceId: capture the exact device the wake engine
 *    successfully uses (explicit deviceId), or the system default.
 */
export type MicVariant = {
  processing: boolean;

  useDeviceId: boolean;
};

export type MicPipeline = {
  start(): Promise<number>;

  stop(): Promise<void>;
};

export type MicPipelineFactory = (
  handlers: MicHandlers,
  variant: MicVariant,
  deviceId?: string,
) => MicPipeline;

export function resolveWorkletUrl(name: string): string {
  return new URL(`worklets/${name}`, document.baseURI).toString();
}

function buildAudioConstraints(
  variant: MicVariant,
  deviceId: string | undefined,
): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = {
    channelCount: 1,
  };

  if (deviceId && variant.useDeviceId) {
    constraints.deviceId = { exact: deviceId };
  }

  if (variant.processing) {
    constraints.echoCancellation = true;
    constraints.noiseSuppression = true;
    constraints.autoGainControl = true;
  } else {
    constraints.echoCancellation = false;
    constraints.noiseSuppression = false;
    constraints.autoGainControl = false;
  }

  return constraints;
}

/*
 * Low-latency capture pipeline:
 *
 *   MediaStream -> AudioContext -> AudioWorklet -> zero-gain sink
 *
 * The zero-gain connection to destination is REQUIRED: Chrome's
 * audio graph is pull-based, and a capture worklet with no path to
 * the destination is never processed. The gain of 0 keeps it silent.
 *
 * The AudioContext runs at the device's native rate; the controller
 * resamples to 16 kHz in software (LinearResampler).
 */
export function createMicPipeline(
  handlers: MicHandlers,
  variant: MicVariant,
  deviceId?: string,
): MicPipeline {
  let context: AudioContext | null = null;

  let stream: MediaStream | null = null;

  let node: AudioWorkletNode | null = null;

  let sink: GainNode | null = null;

  async function acquireStream(): Promise<MediaStream> {
    const constraints = buildAudioConstraints(variant, deviceId);

    try {
      return await navigator.mediaDevices.getUserMedia({ audio: constraints });
    } catch (error) {
      /*
       * The chosen device may have vanished; fall back to the system
       * default rather than failing the whole session.
       */
      if (
        deviceId &&
        variant.useDeviceId &&
        error instanceof Error &&
        (error.name === "OverconstrainedError" ||
          error.name === "NotFoundError")
      ) {
        handlers.onDiagnostic?.(
          `chosen mic unavailable (${error.name}) — falling back to default device`,
        );

        return navigator.mediaDevices.getUserMedia({
          audio: buildAudioConstraints(variant, undefined),
        });
      }

      throw error;
    }
  }

  async function start(): Promise<number> {
    stream = await acquireStream();

    try {
      context = new AudioContext();
    } catch {
      context = new AudioContext();
    }

    if (context.state === "suspended") {
      await context.resume();
    }

    await context.audioWorklet.addModule(resolveWorkletUrl("mic-worklet.js"));

    const source = context.createMediaStreamSource(stream);

    const worklet = new AudioWorkletNode(context, "starfire-mic", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    worklet.port.onmessage = (event: MessageEvent) => {
      const data = event.data as { pcm: ArrayBuffer; rms: number };

      handlers.onChunk({
        samples: new Float32Array(data.pcm),
        rms: data.rms,
      });
    };

    sink = context.createGain();

    sink.gain.value = 0;

    source.connect(worklet);

    worklet.connect(sink);

    sink.connect(context.destination);

    node = worklet;

    /*
     * Pipeline diagnostics go straight to the terminal via the
     * controller's log channel, so capture problems are visible
     * immediately instead of manifesting as "she never replies".
     */
    const track = stream.getAudioTracks()[0];

    if (track) {
      const settings = track.getSettings();

      handlers.onDiagnostic?.(
        `mic open (processing=${variant.processing ? "on" : "off"}, ` +
          `source=${deviceId && variant.useDeviceId ? "chosen device" : "system default"}): ` +
          `label="${track.label || "?"}", id=${String(settings.deviceId ?? "?")}, ` +
          `captureRate=${context.sampleRate}, deviceRate=${String(settings.sampleRate ?? "?")}, ` +
          `ec=${String(settings.echoCancellation ?? "?")}, ns=${String(settings.noiseSuppression ?? "?")}, ` +
          `state=${track.readyState}`,
      );

      track.addEventListener("ended", () => {
        handlers.onDiagnostic?.("mic track ended unexpectedly");
      });

      track.addEventListener("mute", () => {
        handlers.onDiagnostic?.("mic track muted by the system");
      });
    }

    return context.sampleRate;
  }

  async function stop(): Promise<void> {
    node?.port.close();

    node?.disconnect();

    node = null;

    sink?.disconnect();

    sink = null;

    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }

      stream = null;
    }

    if (context && context.state !== "closed") {
      await context.close();
    }

    context = null;
  }

  return { start, stop };
}
