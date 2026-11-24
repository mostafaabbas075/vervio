export type RealtimeConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "ending"
  | "ended"
  | "failed";

export type RealtimeInterviewErrorCode =
  | "audio_playback_failed"
  | "connection_failed"
  | "connection_interrupted"
  | "connection_timed_out"
  | "duplicate_start"
  | "invalid_answer"
  | "microphone_unavailable"
  | "not_authorized"
  | "secure_session_unavailable"
  | "service_not_configured"
  | "service_error";

export class RealtimeInterviewError extends Error {
  constructor(public readonly code: RealtimeInterviewErrorCode) {
    super(code);
    this.name = "RealtimeInterviewError";
  }
}

type RealtimeOfferResponse = {
  answer_sdp: string;
  max_duration_seconds: number;
};

type RealtimeEvent = {
  type?: string;
};

export type RealtimeInterviewCallbacks = {
  onStateChange: (state: RealtimeConnectionState) => void;
  onAssistantSpeakingChange: (isSpeaking: boolean) => void;
  onCandidateSpeakingChange: (isSpeaking: boolean) => void;
  onError: (code: RealtimeInterviewErrorCode) => void;
};

export type RealtimeInterviewOptions = {
  microphoneTrack: MediaStreamTrack;
  requestOffer: (offerSdp: string) => Promise<RealtimeOfferResponse>;
  callbacks: RealtimeInterviewCallbacks;
};

const CONNECTION_TIMEOUT_MS = 20_000;
const GRACEFUL_CLOSE_TIMEOUT_MS = 1_500;

function parseRealtimeEvent(data: unknown): RealtimeEvent | null {
  if (typeof data !== "string") {
    return null;
  }
  try {
    return JSON.parse(data) as RealtimeEvent;
  } catch {
    return null;
  }
}

function waitForConnection(peerConnection: RTCPeerConnection): Promise<void> {
  if (peerConnection.connectionState === "connected") {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new RealtimeInterviewError("connection_timed_out"));
    }, CONNECTION_TIMEOUT_MS);
    const handleStateChange = () => {
      if (peerConnection.connectionState === "connected") {
        cleanup();
        resolve();
      }
      if (["failed", "closed"].includes(peerConnection.connectionState)) {
        cleanup();
        reject(new RealtimeInterviewError("connection_failed"));
      }
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      peerConnection.removeEventListener("connectionstatechange", handleStateChange);
    };
    peerConnection.addEventListener("connectionstatechange", handleStateChange);
  });
}

function waitForDataChannel(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === "open") {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new RealtimeInterviewError("connection_timed_out"));
    }, CONNECTION_TIMEOUT_MS);
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new RealtimeInterviewError("connection_failed"));
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      channel.removeEventListener("open", handleOpen);
      channel.removeEventListener("error", handleError);
    };
    channel.addEventListener("open", handleOpen);
    channel.addEventListener("error", handleError);
  });
}

/**
 * Owns the browser side of one OpenAI Realtime WebRTC call. The interview room
 * continues to own the selected local media stream, so it can keep the camera
 * preview and microphone meter active without requesting a second microphone.
 */
export class RealtimeInterviewConnection {
  private readonly callbacks: RealtimeInterviewCallbacks;
  private readonly microphoneTrack: MediaStreamTrack;
  private readonly requestOffer: (offerSdp: string) => Promise<RealtimeOfferResponse>;
  private dataChannel: RTCDataChannel | null = null;
  private peerConnection: RTCPeerConnection | null = null;
  private remoteAudioElement: HTMLAudioElement | null = null;
  private remoteAudioStream: MediaStream | null = null;
  private currentState: RealtimeConnectionState = "idle";
  private closeConfirmation: (() => void) | null = null;
  private startPromise: Promise<number> | null = null;
  private isIntentionalClose = false;

  constructor({ microphoneTrack, requestOffer, callbacks }: RealtimeInterviewOptions) {
    this.microphoneTrack = microphoneTrack;
    this.requestOffer = requestOffer;
    this.callbacks = callbacks;
  }

  get remoteStream(): MediaStream | null {
    return this.remoteAudioStream;
  }

  get state(): RealtimeConnectionState {
    return this.currentState;
  }

  async start(): Promise<number> {
    if (this.startPromise || ["connecting", "connected", "ending"].includes(this.currentState)) {
      throw new RealtimeInterviewError("duplicate_start");
    }
    if (this.microphoneTrack.readyState !== "live") {
      throw new RealtimeInterviewError("microphone_unavailable");
    }

    this.startPromise = this.connect();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async connect(): Promise<number> {
    this.setState("connecting");
    this.isIntentionalClose = false;
    const peerConnection = new RTCPeerConnection();
    this.peerConnection = peerConnection;
    const dataChannel = peerConnection.createDataChannel("oai-events");
    this.dataChannel = dataChannel;
    this.remoteAudioElement = new Audio();
    this.remoteAudioElement.autoplay = true;
    this.remoteAudioStream = new MediaStream();

    peerConnection.addTrack(this.microphoneTrack, new MediaStream([this.microphoneTrack]));
    peerConnection.ontrack = (event) => {
      const stream = event.streams[0] ?? this.remoteAudioStream;
      if (!stream) {
        return;
      }
      if (event.streams.length === 0) {
        stream.addTrack(event.track);
      }
      this.remoteAudioStream = stream;
      if (this.remoteAudioElement) {
        this.remoteAudioElement.srcObject = stream;
        void this.remoteAudioElement.play().catch(() => {
          this.callbacks.onError("audio_playback_failed");
        });
      }
    };
    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;
      if (state === "failed" || state === "disconnected") {
        if (!this.isIntentionalClose) {
          this.fail("connection_interrupted");
        }
      }
    };
    dataChannel.onmessage = (event) => this.handleRealtimeEvent(parseRealtimeEvent(event.data));
    dataChannel.onerror = () => this.fail("connection_failed");

    try {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      if (!offer.sdp) {
        throw new RealtimeInterviewError("connection_failed");
      }
      const { answer_sdp: answerSdp, max_duration_seconds: maxDurationSeconds } = await this.requestOffer(
        offer.sdp,
      );
      if (!answerSdp) {
        throw new RealtimeInterviewError("invalid_answer");
      }
      await peerConnection.setRemoteDescription({ type: "answer", sdp: answerSdp });
      await Promise.all([waitForConnection(peerConnection), waitForDataChannel(dataChannel)]);
      this.setState("connected");
      dataChannel.send(
        JSON.stringify({
          type: "response.create",
          response: {
            output_modalities: ["audio"],
            instructions:
              "Beginne jetzt mit einer kurzen, natürlichen Begrüßung auf Deutsch und stelle die erste offene Interviewfrage.",
          },
        }),
      );
      return maxDurationSeconds;
    } catch (error) {
      const code = error instanceof RealtimeInterviewError ? error.code : "connection_failed";
      this.fail(code);
      throw error;
    }
  }

  async end(): Promise<void> {
    if (["idle", "ended"].includes(this.currentState)) {
      this.cleanup();
      this.setState("ended");
      return;
    }
    if (this.currentState === "ending") {
      return;
    }

    this.isIntentionalClose = true;
    this.setState("ending");
    const dataChannel = this.dataChannel;
    if (dataChannel?.readyState === "open") {
      const closeReceived = new Promise<void>((resolve) => {
        this.closeConfirmation = resolve;
      });
      dataChannel.send(JSON.stringify({ type: "session.close" }));
      await Promise.race([
        closeReceived,
        new Promise<void>((resolve) => window.setTimeout(resolve, GRACEFUL_CLOSE_TIMEOUT_MS)),
      ]);
    }
    this.cleanup();
    this.setState("ended");
  }

  private handleRealtimeEvent(event: RealtimeEvent | null): void {
    switch (event?.type) {
      case "response.created":
      case "response.output_audio.delta":
        this.callbacks.onAssistantSpeakingChange(true);
        break;
      case "response.done":
      case "response.output_audio.done":
        this.callbacks.onAssistantSpeakingChange(false);
        break;
      case "input_audio_buffer.speech_started":
        this.callbacks.onCandidateSpeakingChange(true);
        this.callbacks.onAssistantSpeakingChange(false);
        break;
      case "input_audio_buffer.speech_stopped":
        this.callbacks.onCandidateSpeakingChange(false);
        break;
      case "session.closed":
        this.closeConfirmation?.();
        this.closeConfirmation = null;
        break;
      case "error":
        this.fail("service_error");
        break;
      default:
        break;
    }
  }

  private fail(code: RealtimeInterviewErrorCode): void {
    if (this.isIntentionalClose || this.currentState === "ended") {
      return;
    }
    this.cleanup();
    this.callbacks.onError(code);
    this.setState("failed");
  }

  private cleanup(): void {
    this.closeConfirmation?.();
    this.closeConfirmation = null;
    this.callbacks.onAssistantSpeakingChange(false);
    this.callbacks.onCandidateSpeakingChange(false);
    this.dataChannel?.close();
    this.dataChannel = null;
    this.peerConnection?.close();
    this.peerConnection = null;
    this.remoteAudioElement?.pause();
    if (this.remoteAudioElement) {
      this.remoteAudioElement.srcObject = null;
    }
    this.remoteAudioElement = null;
    this.remoteAudioStream?.getTracks().forEach((track) => track.stop());
    this.remoteAudioStream = null;
  }

  private setState(state: RealtimeConnectionState): void {
    if (this.currentState === state) {
      return;
    }
    this.currentState = state;
    this.callbacks.onStateChange(state);
  }
}
