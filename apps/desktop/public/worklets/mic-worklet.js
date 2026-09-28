class StarfireMicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    /*
     * ~16 ms chunks at the native device rate: low enough for snappy
     * turn detection, small enough to keep IPC overhead trivial.
     */
    this.target = Math.max(128, Math.round(sampleRate * 0.016));

    this.buffer = new Float32Array(this.target * 4);

    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0];

    if (input && input.length > 0 && input[0]) {
      const channel = input[0];

      for (let i = 0; i < channel.length; i += 1) {
        if (this.filled >= this.buffer.length) {
          this.flush();
        }

        this.buffer[this.filled] = channel[i];

        this.filled += 1;
      }

      if (this.filled >= this.target) {
        this.flush();
      }
    }

    return true;
  }

  flush() {
    if (this.filled === 0) {
      return;
    }

    const chunk = this.buffer.slice(0, this.filled);

    let sum = 0;

    for (let i = 0; i < chunk.length; i += 1) {
      sum += chunk[i] * chunk[i];
    }

    const rms = Math.sqrt(sum / chunk.length);

    this.port.postMessage({ pcm: chunk.buffer, rms }, [chunk.buffer]);

    this.filled = 0;
  }
}

registerProcessor("starfire-mic", StarfireMicProcessor);
