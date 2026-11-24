import {
  DEFAULT_CHUNK_DURATION_MS,
  MAX_CHUNK_DURATION_MS,
  MicrophoneAudioCapture,
  type MicrophoneAudioCaptureOptions,
  MIN_CHUNK_DURATION_MS,
} from "./microphone-capture";
import {
  convertFloat32ToPcm16,
  TARGET_PCM_SAMPLE_RATE,
} from "./pcm-audio";
import { PcmAudioPlayer, type PcmAudioPlayback } from "./pcm-audio-player";

export const DEFAULT_MAX_BUFFERED_AMOUNT_BYTES = 64 * 1024;
export const DEFAULT_CONNECTION_TIMEOUT_MS = 15_000;
export type GeminiAudioClientState =
  | "idle"
  | "connecting"
  | "connected"
  | "ending"
  | "ended"
  | "failed";

export type GeminiAudioClientCallbacks = {
  onStateChange?: (state: GeminiAudioClientState) => void;
  onError?: (error: Error) => void;
  onProviderConnected?: () => void;
  onAudioChunkSent?: (byteLength: number) => void;
  onAudioChunkReceived?: (byteLength: number) => void;
  onAssistantSpeakingChange?: (isSpeaking: boolean) => void;
  onRecordingAudioStreamReady?: (stream: MediaStream) => Promise<void> | void;
};

export type GeminiAudioClientOptions = {
  stream: MediaStream;
  wsUrl: string;
  callbacks?: GeminiAudioClientCallbacks;
  chunkDurationMs?: number;
  maxBufferedAmountBytes?: number;
  connectionTimeoutMs?: number;
  audioContext?: AudioContext;
  webSocketFactory?: (url: string) => WebSocket;
  captureFactory?: (options: MicrophoneAudioCaptureOptions) => MicrophoneAudioCapture;
  audioPlayer?: PcmAudioPlayback;
};

type ServerMessage = {
  type?: string;
  status?: string;
  message?: string;
};

function parseServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(data) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as ServerMessage;
    }
    return null;
  } catch {
    return null;
  }
}

export class GeminiAudioClient {
  private readonly stream: MediaStream;
  private readonly wsUrl: string;
  private readonly callbacks?: GeminiAudioClientCallbacks;
  private readonly chunkDurationMs: number;
  private readonly maxBufferedAmountBytes: number;
  private readonly connectionTimeoutMs: number;
  private readonly audioContext?: AudioContext;
  private readonly webSocketFactory?: (url: string) => WebSocket;
  private readonly captureFactory?: (
    options: MicrophoneAudioCaptureOptions,
  ) => MicrophoneAudioCapture;
  private readonly audioPlayer: PcmAudioPlayback;

  private socket: WebSocket | null = null;
  private capture: MicrophoneAudioCapture | null = null;
  private clientState: GeminiAudioClientState = "idle";
  private playbackDisposed = false;

  constructor(options: GeminiAudioClientOptions) {
    if (!options || typeof options !== "object") {
      throw new TypeError("GeminiAudioClient options must be an object");
    }
    if (!options.stream || typeof options.stream.getAudioTracks !== "function") {
      throw new TypeError("A valid MediaStream is required");
    }
    if (!options.wsUrl || typeof options.wsUrl !== "string") {
      throw new TypeError("A valid wsUrl string is required");
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
    this.wsUrl = options.wsUrl;
    this.callbacks = options.callbacks;
    this.chunkDurationMs = chunkDurationMs;
    this.maxBufferedAmountBytes =
      options.maxBufferedAmountBytes ?? DEFAULT_MAX_BUFFERED_AMOUNT_BYTES;
    this.connectionTimeoutMs =
      options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    this.audioContext = options.audioContext;
    this.webSocketFactory = options.webSocketFactory;
    this.captureFactory = options.captureFactory;
    this.audioPlayer =
      options.audioPlayer ??
      new PcmAudioPlayer({
        callbacks: {
          onPlaybackStateChange: (isSpeaking) =>
            this.callbacks?.onAssistantSpeakingChange?.(isSpeaking),
        },
      });
  }

  get state(): GeminiAudioClientState {
    return this.clientState;
  }

  get isStreaming(): boolean {
    return this.clientState === "connected";
  }

  async start(): Promise<void> {
    if (this.clientState === "connecting" || this.clientState === "connected") {
      throw new Error("Gemini audio client is already running");
    }

    const audioTracks = this.stream.getAudioTracks();
    const liveTrack = audioTracks.find(
      (track) => track.readyState === "live" && track.enabled,
    );
    if (!liveTrack) {
      throw new Error("MediaStream audio track is unavailable or muted");
    }

    try {
      // Resume playback in the Start button's user gesture, before the asynchronous
      // provider handshake can cause browser autoplay protection to block audio.
      await this.audioPlayer.prepare();
    } catch (error) {
      const playbackError =
        error instanceof Error ? error : new Error("Audio playback is unavailable");
      this.handleFailure(playbackError);
      throw playbackError;
    }

    this.setState("connecting");

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        if (!settled) {
          settled = true;
          const timeoutError = new Error(
            "Connection timed out waiting for Gemini provider",
          );
          this.handleFailure(timeoutError);
          reject(timeoutError);
        }
      }, this.connectionTimeoutMs);

      const cleanupTimer = () => {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      };

      const onConnectSuccess = () => {
        if (!settled) {
          settled = true;
          cleanupTimer();
          resolve();
        }
      };

      const onConnectError = (error: Error) => {
        if (!settled) {
          settled = true;
          cleanupTimer();
          this.handleFailure(error);
          reject(error);
        }
      };

      try {
        this.openWebSocket(onConnectSuccess, onConnectError);
      } catch (err) {
        onConnectError(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private openWebSocket(
    onConnectSuccess: () => void,
    onConnectError: (error: Error) => void,
  ): void {
    const SocketConstructor =
      this.webSocketFactory ??
      ((url: string) => {
        const WsClass =
          (typeof window !== "undefined" && window.WebSocket) ||
          (globalThis as unknown as { WebSocket?: typeof WebSocket }).WebSocket;
        if (!WsClass) {
          throw new Error("WebSocket is not supported in this environment");
        }
        return new WsClass(url);
      });

    const socket = SocketConstructor(this.wsUrl);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    let receivedReady = false;
    let receivedProviderConnected = false;

    socket.onmessage = (event: MessageEvent) => {
      void (async () => {
        const pcmBytes = await this.parseAudioFrame(event.data);
        if (pcmBytes) {
          if (this.clientState === "connected") {
            this.playProviderAudio(pcmBytes);
          }
          return;
        }

        const data = parseServerMessage(event.data);
        if (!data || !data.type) {
          return;
        }

        if (data.type === "error") {
          const errorMsg = data.message || "Unknown error from Gemini service";
          const err = new Error(errorMsg);
          if (!receivedProviderConnected) {
            onConnectError(err);
          } else {
            this.handleFailure(err);
          }
          return;
        }

        if (data.type === "interrupted") {
          // Gemini's VAD has positively identified candidate speech and canceled
          // its response. Clearing only at this authoritative signal avoids
          // chopping audio because of microphone echo or background noise.
          this.audioPlayer.interrupt();
          return;
        }

        if (data.type === "ready") {
          receivedReady = true;
          try {
            socket.send(JSON.stringify({ type: "start" }));
          } catch (err) {
            onConnectError(err instanceof Error ? err : new Error(String(err)));
          }
          return;
        }

        if (data.type === "provider_connected") {
          if (!receivedReady) {
            onConnectError(
              new Error("Received provider_connected before ready message"),
            );
            return;
          }
          receivedProviderConnected = true;

          try {
            await this.startAudioCapture();
            if (this.callbacks?.onRecordingAudioStreamReady) {
              const recordingStream = this.audioPlayer.createRecordingAudioStream?.(this.stream);
              if (!recordingStream) {
                throw new Error("Recording audio mixing is unavailable");
              }
              // Start MediaRecorder before buffered greeting PCM is released.
              await this.callbacks.onRecordingAudioStreamReady(recordingStream);
            }
            this.setState("connected");
            // The backend waits for this acknowledgement before submitting the
            // opening prompt. Capture, recording, and the websocket therefore
            // have a single explicit ready point before any AI audio is sent.
            socket.send(JSON.stringify({ type: "client_ready" }));
            this.callbacks?.onProviderConnected?.();
            onConnectSuccess();
          } catch (err) {
            onConnectError(err instanceof Error ? err : new Error(String(err)));
          }
        }
      })();
    };

    socket.onerror = () => {
      const err = new Error("WebSocket error occurred");
      if (!receivedProviderConnected) {
        onConnectError(err);
      } else {
        this.handleFailure(err);
      }
    };

    socket.onclose = (event: CloseEvent) => {
      if (this.clientState === "ending" || this.clientState === "ended") {
        return;
      }
      const reason = event.reason ? `: ${event.reason}` : "";
      const err = new Error(
        `WebSocket closed unexpectedly (code ${event.code}${reason})`,
      );
      if (!receivedProviderConnected) {
        onConnectError(err);
      } else {
        this.handleFailure(err);
      }
    };
  }

  private async parseAudioFrame(message: unknown): Promise<Uint8Array | null> {
    if (message instanceof ArrayBuffer) {
      return message.byteLength > 0 ? new Uint8Array(message) : null;
    }
    if (ArrayBuffer.isView(message)) {
      const view = message as ArrayBufferView;
      return view.byteLength > 0
        ? new Uint8Array(
            view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
          )
        : null;
    }
    if (typeof Blob !== "undefined" && message instanceof Blob) {
      const buffer = await message.arrayBuffer();
      return buffer.byteLength > 0 ? new Uint8Array(buffer) : null;
    }
    return null;
  }

  private async startAudioCapture(): Promise<void> {
    const createCapture =
      this.captureFactory ??
      ((options: MicrophoneAudioCaptureOptions) =>
        new MicrophoneAudioCapture(options));

    this.capture = createCapture({
      stream: this.stream,
      chunkDurationMs: this.chunkDurationMs,
      audioContext: this.audioContext,
      onAudio: (samples: Float32Array, sampleRate: number) => {
        this.sendAudioChunk(samples, sampleRate);
      },
    });

    await this.capture.start();
  }

  private sendAudioChunk(samples: Float32Array, sampleRate: number): void {
    if (
      this.clientState !== "connected" ||
      !this.socket ||
      this.socket.readyState !== 1 /* WebSocket.OPEN */
    ) {
      return;
    }

    // `MediaStreamTrack.enabled` is the authoritative browser mute state. Do
    // not stream the browser's synthetic silence while the interviewer has
    // intentionally muted the input; a later unmute resumes this same capture
    // graph without reconnecting Gemini.
    const microphoneTrack = this.stream.getAudioTracks().find(
      (track) => track.readyState === "live",
    );
    if (!microphoneTrack || !microphoneTrack.enabled) {
      return;
    }

    // Network backpressure guard: drop chunk if queued buffer exceeds threshold
    if (this.socket.bufferedAmount > this.maxBufferedAmountBytes) {
      return;
    }

    const pcm = convertFloat32ToPcm16(samples, sampleRate, TARGET_PCM_SAMPLE_RATE);
    try {
      this.socket.send(pcm);
      this.callbacks?.onAudioChunkSent?.(pcm.byteLength);
    } catch (err) {
      this.callbacks?.onError?.(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  private playProviderAudio(pcmBytes: Uint8Array): void {
    try {
      this.audioPlayer.enqueue(pcmBytes);
      this.callbacks?.onAudioChunkReceived?.(pcmBytes.byteLength);
    } catch (error) {
      this.handleFailure(
        error instanceof Error ? error : new Error("Failed to play AI audio"),
      );
    }
  }

  async stop(): Promise<void> {
    if (this.clientState === "idle" || this.clientState === "ended") {
      return;
    }

    this.setState("ending");

    if (this.capture) {
      try {
        await this.capture.stop();
      } catch {
        // Ignore capture teardown errors
      }
      this.capture = null;
    }
    await this.disposeAudioPlayer();

    if (this.socket) {
      try {
        this.socket.onmessage = null;
        this.socket.onerror = null;
        this.socket.onclose = null;
        if (
          this.socket.readyState === 0 /* CONNECTING */ ||
          this.socket.readyState === 1 /* OPEN */
        ) {
          this.socket.close(1000, "Client stopped");
        }
      } catch {
        // Ignore socket teardown errors
      }
      this.socket = null;
    }

    this.setState("ended");
    // NOTE: Deliberately do not stop this.stream tracks (owned by Interview Room).
  }

  private handleFailure(error: Error): void {
    if (
      this.clientState === "ending" ||
      this.clientState === "ended" ||
      this.clientState === "failed"
    ) {
      return;
    }

    this.setState("failed");
    this.callbacks?.onError?.(error);

    if (this.capture) {
      try {
        void this.capture.stop();
      } catch {
        // Ignore
      }
      this.capture = null;
    }
    this.audioPlayer.interrupt();
    void this.disposeAudioPlayer();

    if (this.socket) {
      try {
        this.socket.onmessage = null;
        this.socket.onerror = null;
        this.socket.onclose = null;
        this.socket.close();
      } catch {
        // Ignore
      }
      this.socket = null;
    }
  }

  private setState(state: GeminiAudioClientState): void {
    this.clientState = state;
    this.callbacks?.onStateChange?.(state);
  }

  private async disposeAudioPlayer(): Promise<void> {
    if (this.playbackDisposed) {
      return;
    }
    this.playbackDisposed = true;
    try {
      await this.audioPlayer.dispose();
    } catch {
      // Audio teardown must not prevent the transport from closing.
    }
  }

}

