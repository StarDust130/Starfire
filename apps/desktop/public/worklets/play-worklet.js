class StarfirePlayProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    /*
     * ~60 s capacity. The server streams audio much faster than
     * realtime, so the queue holds the whole response. When full,
     * INCOMING samples are dropped — never the ones playing.
     */
    this.capacity = sampleRate * 60;

    this.queue = new Float32Array(this.capacity);

    this.read = 0;

    this.write = 0;

    this.count = 0;

    /*
     * Jitter prime: hold ~60ms of audio before starting playback so
     * slow chunk delivery never gaps the sound at response start or
     * after a clear().
     */
    this.prime = Math.round(sampleRate * 0.06);

    this.primed = false;

    this.wasPlaying = false;

    this.port.onmessage = (event) => {
      const data = event.data;

      if (data?.type === "clear") {
        this.read = 0;

        this.write = 0;

        this.count = 0;

        this.primed = false;

        this.wasPlaying = false;

        return;
      }

      const incoming =
        data?.pcm ?? (data instanceof Float32Array ? data : null);

      if (incoming) {
        for (let i = 0; i < incoming.length; i += 1) {
          if (this.count >= this.capacity) {
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

    let played = false;

    if (!this.primed && this.count >= this.prime) {
      this.primed = true;
    }

    if (this.primed) {
      for (let i = 0; i < output.length; i += 1) {
        if (this.count > 0) {
          output[i] = this.queue[this.read];

          this.read = (this.read + 1) % this.capacity;

          this.count -= 1;

          played = true;
        } else {
          output[i] = 0;
        }
      }
    } else {
      output.fill(0);
    }

    if (played) {
      this.wasPlaying = true;
    } else if (this.wasPlaying) {
      this.wasPlaying = false;

      this.primed = false;

      this.port.postMessage({ type: "drained" });
    }

    return true;
  }
}

registerProcessor("starfire-play", StarfirePlayProcessor);
