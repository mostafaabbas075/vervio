export const GEMINI_PCM_OUTPUT_SAMPLE_RATE = 24_000;
export const GEMINI_PCM_OUTPUT_CHANNELS = 1;

const PLAYBACK_LEAD_TIME_SECONDS = 0.02;
const MAX_SCHEDULED_AHEAD_SECONDS = 0.5;
const DEFAULT_JITTER_BUFFER_SECONDS = 0.12;
const MAX_INITIAL_BUFFER_WAIT_MS = 160;

export type PcmAudioPlayback = {
  prepare: () => Promise<void>;
  enqueue: (pcmBytes: Uint8Array) => void;
  interrupt: () => void;
  dispose: () => Promise<void>;
  createRecordingAudioStream?: (candidateStream: MediaStream) => MediaStream;
  stopRecordingMix?: () => void;
};

export type PcmAudioPlayerCallbacks = {
  onPlaybackStateChange?: (isPlaying: boolean) => void;
  onChunkPlayed?: (pcmByteLength: number) => void;
};

export type PcmAudioPlayerOptions = {
  audioContext?: AudioContext;
  callbacks?: PcmAudioPlayerCallbacks;
  maxScheduledAheadSeconds?: number;
  jitterBufferSeconds?: number;
};

/**
 * Decode Gemini Live's signed, little-endian PCM16 output to Web Audio samples.
 * Gemini Live audio responses are mono PCM at 24 kHz, unlike Vervio's 16 kHz
 * microphone input stream.
 */
export function decodePcm16Mono(pcmBytes: Uint8Array): Float32Array {
  if (!(pcmBytes instanceof Uint8Array)) {
    throw new TypeError("PCM audio must be a Uint8Array");
  }
  if (pcmBytes.byteLength === 0 || pcmBytes.byteLength % 2 !== 0) {
    throw new RangeError("PCM audio must contain complete 16-bit samples");
  }

  const samples = new Float32Array(pcmBytes.byteLength / 2);
  const data = new DataView(
    pcmBytes.buffer,
    pcmBytes.byteOffset,
    pcmBytes.byteLength,
  );
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = data.getInt16(index * 2, true) / 32_768;
  }
  return samples;
}

/**
 * Schedules short Gemini PCM frames on one Web Audio timeline. It keeps normal
 * frames in order. It limits only the amount of audio scheduled into Web Audio;
 * valid but bursty provider audio remains pending until it can be scheduled.
 * Gemini VAD interruptions still clear all pending and scheduled audio at once.
 */
export class PcmAudioPlayer implements PcmAudioPlayback {
  private audioContext: AudioContext | null;
  private readonly ownsAudioContext: boolean;
  private readonly callbacks?: PcmAudioPlayerCallbacks;
  private readonly maxScheduledAheadSeconds: number;
  private readonly jitterBufferSeconds: number;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private recordingDestination: MediaStreamAudioDestinationNode | null = null;
  private recordingCandidateSource: MediaStreamAudioSourceNode | null = null;
  private pendingFrames: Float32Array[] = [];
  private pendingDurationSeconds = 0;
  private nextStartTime = 0;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private timelineActive = false;
  private playing = false;
  private disposed = false;

  constructor(options: PcmAudioPlayerOptions = {}) {
    this.audioContext = options.audioContext ?? null;
    this.ownsAudioContext = !options.audioContext;
    this.callbacks = options.callbacks;
    this.maxScheduledAheadSeconds =
      options.maxScheduledAheadSeconds ?? MAX_SCHEDULED_AHEAD_SECONDS;
    this.jitterBufferSeconds =
      options.jitterBufferSeconds ?? DEFAULT_JITTER_BUFFER_SECONDS;

    if (
      !Number.isFinite(this.maxScheduledAheadSeconds) ||
      this.maxScheduledAheadSeconds <= 0
    ) {
      throw new RangeError("maxScheduledAheadSeconds must be a positive number");
    }
    if (
      !Number.isFinite(this.jitterBufferSeconds) ||
      this.jitterBufferSeconds < 0.1 ||
      this.jitterBufferSeconds > this.maxScheduledAheadSeconds
    ) {
      throw new RangeError("jitterBufferSeconds must be between 100 ms and the schedule horizon");
    }
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  async prepare(): Promise<void> {
    this.assertUsable();
    const audioContext = this.getAudioContext();
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
  }

  /**
   * Create a capture-only mix: candidate audio is never connected to speakers,
   * while each scheduled Gemini source is connected once to both outputs.
   */
  createRecordingAudioStream(candidateStream: MediaStream): MediaStream {
    this.assertUsable();
    const candidateTrack = candidateStream
      .getAudioTracks()
      .find((track) => track.readyState === "live");
    if (!candidateTrack) {
      throw new Error("A live candidate microphone is required for recording");
    }
    if (this.recordingDestination) {
      return this.recordingDestination.stream;
    }

    const audioContext = this.getAudioContext();
    const candidateOnlyStream = new MediaStream([candidateTrack]);
    const destination = audioContext.createMediaStreamDestination();
    const candidateSource = audioContext.createMediaStreamSource(candidateOnlyStream);
    candidateSource.connect(destination);
    this.recordingDestination = destination;
    this.recordingCandidateSource = candidateSource;
    return destination.stream;
  }

  stopRecordingMix(): void {
    if (this.recordingCandidateSource) {
      try {
        this.recordingCandidateSource.disconnect();
      } catch {
        // The browser may have already disconnected the source during teardown.
      }
      this.recordingCandidateSource = null;
    }
    this.recordingDestination = null;
  }

  enqueue(pcmBytes: Uint8Array): void {
    this.assertUsable();
    const audioContext = this.getAudioContext();
    if (audioContext.state === "closed") {
      throw new Error("Audio playback context is closed");
    }

    const samples = decodePcm16Mono(pcmBytes);
    const duration = samples.length / GEMINI_PCM_OUTPUT_SAMPLE_RATE;

    this.pendingFrames.push(samples);
    this.pendingDurationSeconds += duration;
    this.schedulePendingFrames(audioContext, false);
  }

  interrupt(): void {
    this.clearStartTimer();
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Source may already have ended.
      }
      try {
        source.disconnect();
      } catch {
        // Source may already be disconnected.
      }
    }
    this.sources.clear();
    this.pendingFrames = [];
    this.pendingDurationSeconds = 0;
    this.nextStartTime = this.audioContext?.currentTime ?? 0;
    this.timelineActive = false;
    this.setPlaying(false);
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.interrupt();
    this.stopRecordingMix();
    this.disposed = true;
    if (this.audioContext && this.ownsAudioContext && this.audioContext.state !== "closed") {
      try {
        await this.audioContext.close();
      } finally {
        this.audioContext = null;
      }
    }
  }

  private getAudioContext(): AudioContext {
    if (this.audioContext && this.audioContext.state !== "closed") {
      return this.audioContext;
    }

    const AudioContextClass =
      (typeof window !== "undefined" &&
        (window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext)) ||
      (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!AudioContextClass) {
      throw new Error("AudioContext is not supported in this environment");
    }
    this.audioContext = new AudioContextClass();
    return this.audioContext;
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new Error("Audio player has been disposed");
    }
  }

  private setPlaying(isPlaying: boolean): void {
    if (this.playing === isPlaying) {
      return;
    }
    this.playing = isPlaying;
    this.callbacks?.onPlaybackStateChange?.(isPlaying);
  }

  private schedulePendingFrames(audioContext: AudioContext, forceStart: boolean): void {
    if (this.pendingFrames.length === 0) {
      return;
    }

    if (!this.timelineActive) {
      if (!forceStart && this.pendingDurationSeconds < this.jitterBufferSeconds) {
        this.scheduleForcedStart(audioContext);
        return;
      }
      this.clearStartTimer();
      this.timelineActive = true;
      this.nextStartTime = audioContext.currentTime + PLAYBACK_LEAD_TIME_SECONDS;
    }

    while (
      this.pendingFrames.length > 0 &&
      this.scheduledAheadSeconds(audioContext) < this.maxScheduledAheadSeconds
    ) {
      const samples = this.pendingFrames.shift();
      if (!samples) {
        continue;
      }
      this.pendingDurationSeconds -= samples.length / GEMINI_PCM_OUTPUT_SAMPLE_RATE;
      this.scheduleSamples(audioContext, samples);
    }
    this.pendingDurationSeconds = Math.max(0, this.pendingDurationSeconds);
  }

  private scheduleForcedStart(audioContext: AudioContext): void {
    if (this.startTimer !== null) {
      return;
    }
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (!this.disposed && audioContext.state !== "closed") {
        this.schedulePendingFrames(audioContext, true);
      }
    }, MAX_INITIAL_BUFFER_WAIT_MS);
  }

  private scheduleSamples(audioContext: AudioContext, samples: Float32Array): void {
    const buffer = audioContext.createBuffer(
      GEMINI_PCM_OUTPUT_CHANNELS,
      samples.length,
      GEMINI_PCM_OUTPUT_SAMPLE_RATE,
    );
    // Copy into a fresh browser-owned buffer; this also avoids retaining the
    // WebSocket frame backing store while the source is scheduled.
    buffer.copyToChannel(new Float32Array(samples), 0);

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    if (this.recordingDestination) {
      source.connect(this.recordingDestination);
    }
    source.onended = () => {
      this.sources.delete(source);
      // Interruptions detach `onended` before stopping sources. Reaching this
      // callback therefore means this PCM frame played through normally.
      this.callbacks?.onChunkPlayed?.(samples.length * 2);
      try {
        source.disconnect();
      } catch {
        // The node might already be disconnected during an interruption.
      }
      if (this.pendingFrames.length > 0) {
        this.schedulePendingFrames(audioContext, true);
      }
      if (this.sources.size === 0 && this.pendingFrames.length === 0) {
        this.timelineActive = false;
        this.nextStartTime = audioContext.currentTime;
        this.setPlaying(false);
      }
    };

    const startAt = Math.max(
      this.nextStartTime,
      audioContext.currentTime + PLAYBACK_LEAD_TIME_SECONDS,
    );
    this.nextStartTime = startAt + samples.length / GEMINI_PCM_OUTPUT_SAMPLE_RATE;
    this.sources.add(source);
    this.setPlaying(true);
    source.start(startAt);
  }

  private scheduledAheadSeconds(audioContext: AudioContext): number {
    return Math.max(0, this.nextStartTime - audioContext.currentTime);
  }

  private clearStartTimer(): void {
    if (this.startTimer !== null) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
  }

}
