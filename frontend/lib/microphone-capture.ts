export const MIN_CHUNK_DURATION_MS = 40;
export const MAX_CHUNK_DURATION_MS = 100;
export const DEFAULT_CHUNK_DURATION_MS = 50;
export const AUDIO_WORKLET_PROCESSOR_NAME = "vervio-recorder-worklet";

export const AUDIO_WORKLET_CODE = `
class VervioRecorderWorkletProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = options?.processorOptions || {};
    this.chunkSize = processorOptions.chunkSize || 2048;
    this.buffer = new Float32Array(this.chunkSize);
    this.offset = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channel = input[0];
      if (channel && channel.length > 0) {
        let channelOffset = 0;
        while (channelOffset < channel.length) {
          const remaining = this.chunkSize - this.offset;
          const toCopy = Math.min(channel.length - channelOffset, remaining);
          this.buffer.set(channel.subarray(channelOffset, channelOffset + toCopy), this.offset);
          this.offset += toCopy;
          channelOffset += toCopy;

          if (this.offset >= this.chunkSize) {
            this.port.postMessage(this.buffer.slice());
            this.offset = 0;
          }
        }
      }
    }
    return true;
  }
}

registerProcessor("${AUDIO_WORKLET_PROCESSOR_NAME}", VervioRecorderWorkletProcessor);
`;

export type AudioCaptureCallback = (samples: Float32Array, sampleRate: number) => void;

export type MicrophoneAudioCaptureOptions = {
  stream: MediaStream;
  onAudio: AudioCaptureCallback;
  chunkDurationMs?: number;
  audioContext?: AudioContext;
  workletUrl?: string;
};

export class MicrophoneAudioCapture {
  private readonly stream: MediaStream;
  private readonly onAudio: AudioCaptureCallback;
  private readonly chunkDurationMs: number;
  private readonly workletUrl?: string;
  private audioContext: AudioContext | null = null;
  private readonly ownsAudioContext: boolean;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private mutedGain: GainNode | null = null;
  private isRunning = false;
  private currentSampleRate = 0;
  private chunkSamples = 0;
  private buffer: Float32Array = new Float32Array(0);
  private bufferOffset = 0;

  constructor(options: MicrophoneAudioCaptureOptions) {
    if (!options || typeof options !== "object") {
      throw new TypeError("MicrophoneAudioCapture options must be an object");
    }
    if (!options.stream || typeof options.stream.getAudioTracks !== "function") {
      throw new TypeError("A valid MediaStream is required");
    }
    const audioTracks = options.stream.getAudioTracks();
    if (audioTracks.length === 0) {
      throw new Error("MediaStream has no audio tracks");
    }
    if (typeof options.onAudio !== "function") {
      throw new TypeError("onAudio callback must be a function");
    }

    const chunkDurationMs = options.chunkDurationMs ?? DEFAULT_CHUNK_DURATION_MS;
    if (
      !Number.isFinite(chunkDurationMs) ||
      chunkDurationMs < MIN_CHUNK_DURATION_MS ||
      chunkDurationMs > MAX_CHUNK_DURATION_MS
    ) {
      throw new RangeError(
        `chunkDurationMs must be between ${MIN_CHUNK_DURATION_MS} and ${MAX_CHUNK_DURATION_MS} ms`,
      );
    }

    this.stream = options.stream;
    this.onAudio = options.onAudio;
    this.chunkDurationMs = chunkDurationMs;
    this.workletUrl = options.workletUrl;

    if (options.audioContext) {
      this.audioContext = options.audioContext;
      this.ownsAudioContext = false;
    } else {
      this.ownsAudioContext = true;
    }
  }

  get isCapturing(): boolean {
    return this.isRunning;
  }

  get sampleRate(): number {
    return this.currentSampleRate;
  }

  /**
   * Exposes lifecycle state for aggregate diagnostics only. It intentionally
   * contains no device identifier, audio samples, or browser permission data.
   */
  get contextState(): "suspended" | "running" | "closed" | "interrupted" | "unavailable" {
    return this.audioContext?.state ?? "unavailable";
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error("MicrophoneAudioCapture is already running");
    }

    const audioTracks = this.stream.getAudioTracks();
    const liveTrack = audioTracks.find((track) => track.readyState === "live");
    if (!liveTrack) {
      throw new Error("MediaStream audio track is not live");
    }

    if (!this.audioContext || this.audioContext.state === "closed") {
      const AudioContextClass =
        (typeof window !== "undefined" &&
          (window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext })
              .webkitAudioContext)) ||
        (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext;

      if (!AudioContextClass) {
        throw new Error("AudioContext is not supported in this environment");
      }
      this.audioContext = new AudioContextClass();
    }

    this.currentSampleRate = this.audioContext.sampleRate || 48000;
    this.chunkSamples = Math.max(
      1,
      Math.round(this.currentSampleRate * (this.chunkDurationMs / 1000)),
    );
    this.buffer = new Float32Array(this.chunkSamples);
    this.bufferOffset = 0;

    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    let blobUrl: string | null = null;
    try {
      const workletUrl =
        this.workletUrl ||
        (() => {
          const blob = new Blob([AUDIO_WORKLET_CODE], {
            type: "application/javascript",
          });
          blobUrl = URL.createObjectURL(blob);
          return blobUrl;
        })();

      await this.audioContext.audioWorklet.addModule(workletUrl);
    } catch (error) {
      const isDuplicate =
        error instanceof Error &&
        (error.name === "NotSupportedError" ||
          error.message.includes("already been registered"));
      if (!isDuplicate) {
        throw error;
      }
    } finally {
      if (blobUrl && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(blobUrl);
      }
    }

    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);

    const WorkletNodeClass =
      (typeof window !== "undefined" && window.AudioWorkletNode) ||
      (globalThis as unknown as { AudioWorkletNode?: typeof AudioWorkletNode }).AudioWorkletNode;

    if (!WorkletNodeClass) {
      throw new Error("AudioWorkletNode is not supported in this environment");
    }

    this.workletNode = new WorkletNodeClass(
      this.audioContext,
      AUDIO_WORKLET_PROCESSOR_NAME,
      {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        processorOptions: {
          chunkSize: this.chunkSamples,
        },
      },
    );

    this.workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (!this.isRunning) return;
      const data = event.data;
      if (data && data instanceof Float32Array && data.length > 0) {
        this.handleIncomingSamples(data);
      }
    };

    // Muted gain node prevents microphone audio from playing through speakers
    this.mutedGain = this.audioContext.createGain();
    this.mutedGain.gain.value = 0;

    this.sourceNode.connect(this.workletNode);
    this.workletNode.connect(this.mutedGain);
    this.mutedGain.connect(this.audioContext.destination);

    this.isRunning = true;
  }

  private handleIncomingSamples(samples: Float32Array): void {
    if (!this.isRunning) return;

    if (this.bufferOffset === 0 && samples.length === this.chunkSamples) {
      this.onAudio(samples, this.currentSampleRate);
      return;
    }

    let offset = 0;
    while (offset < samples.length) {
      const remaining = this.chunkSamples - this.bufferOffset;
      const toCopy = Math.min(samples.length - offset, remaining);
      this.buffer.set(samples.subarray(offset, offset + toCopy), this.bufferOffset);
      this.bufferOffset += toCopy;
      offset += toCopy;

      if (this.bufferOffset >= this.chunkSamples) {
        const chunk = this.buffer.slice();
        this.bufferOffset = 0;
        this.onAudio(chunk, this.currentSampleRate);
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    this.isRunning = false;

    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      this.sourceNode = null;
    }

    if (this.workletNode) {
      try {
        this.workletNode.port.onmessage = null;
        this.workletNode.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      this.workletNode = null;
    }

    if (this.mutedGain) {
      try {
        this.mutedGain.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      this.mutedGain = null;
    }

    if (this.audioContext && this.ownsAudioContext) {
      try {
        if (this.audioContext.state !== "closed") {
          await this.audioContext.close();
        }
      } catch {
        // Ignore close errors
      }
      this.audioContext = null;
    }

    if (this.bufferOffset > 0) {
      const remaining = this.buffer.slice(0, this.bufferOffset);
      this.bufferOffset = 0;
      try {
        this.onAudio(remaining, this.currentSampleRate);
      } catch {
        // Ignore callback errors during teardown
      }
    }

    // NOTE: We deliberately do not stop this.stream or its MediaStreamTracks.
    // The tracks are owned by the caller (e.g. Interview Room).
  }
}

