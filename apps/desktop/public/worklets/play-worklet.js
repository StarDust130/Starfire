class StarfirePlayProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    /*
     * ~60 s of headroom at the device rate. The server streams audio
     * much faster than realtime, so the queue holds the whole
     * response; it must NEVER overwrite samples that are currently
     * playing (that corrupts audio mid-word). When full, incoming
     * samples are dropped instead.
     */
    this.capacity = sampleRate * 60;

    this.queue = new Float32Array(this.capacity);

    this.read = 0;

    this.write = 0;

    this.count = 0;

    this.wasPlaying = false;

    this.port.onmessage = (event) => {
      const data = event.data;

      if (data?.type === "clear") {
        this.read = 0;

        this.write = 0;

        this.count = 0;

        return;
      }

      const incoming =
        data?.pcm ?? (data instanceof Float32Array ? data : null);

      if (incoming) {
        for (let i = 0; i < incoming.length; i += 1) {
          if (this.count >= this.capacity) {
            /*
             * Queue full: drop the INCOMING sample, never the one
             * currently playing.
             */
            continue;
          }

          this.queue[this.write] = incoming[i];

          this.write = (this.write + 1) % this.capacity;

          this.count += 1;
        }
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0][0];

    for (let i = 0; i < output.length; i += 1) {
      if (this.count > 0) {
        output[i] = this.queue[this.read];

        this.read = (this.read + 1) % this.capacity;

        this.count -= 1;
      } else {
        output[i] = 0;
      }
    }

    /*
     * Tell the main thread when playback actually finished draining,
     * so her animation/state can follow the audible tail precisely.
     */
    if (this.count > 0) {
      this.wasPlaying = true;
    } else if (this.wasPlaying) {
      this.wasPlaying = false;

      this.port.postMessage({ type: "drained" });
    }

    return true;
  }
}

registerProcessor("starfire-play", StarfirePlayProcessor);
