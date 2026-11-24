export const MAX_RECORDING_BYTES = 100 * 1024 * 1024;

const MIME_TYPE_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4;codecs=avc1,mp4a",
  "video/mp4",
] as const;

export type FinalizedInterviewRecording = {
  blob: Blob;
  contentType: "video/webm" | "video/mp4";
};

function normalizedContentType(value: string): "video/webm" | "video/mp4" | null {
  const normalized = value.split(";", 1)[0]?.toLowerCase();
  return normalized === "video/webm" || normalized === "video/mp4" ? normalized : null;
}

export function selectRecordingMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("MediaRecorder is not supported in this browser");
  }
  return MIME_TYPE_CANDIDATES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
}

export function createInterviewRecordingStream(
  candidateStream: MediaStream,
  mixedAudioStream: MediaStream,
): MediaStream {
  const videoTrack = candidateStream
    .getVideoTracks()
    .find((track) => track.readyState === "live");
  const audioTrack = mixedAudioStream
    .getAudioTracks()
    .find((track) => track.readyState === "live");
  if (!videoTrack || !audioTrack) {
    throw new Error("A live camera and mixed interview audio are required for recording");
  }
  return new MediaStream([videoTrack, audioTrack]);
}

/** Owns a MediaRecorder but never stops device tracks owned by the Interview Room. */
export class InterviewRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private selectedMimeType: string | undefined;
  private finalizing: Promise<FinalizedInterviewRecording> | null = null;

  get isRecording(): boolean {
    return this.recorder?.state === "recording";
  }

  start(stream: MediaStream): void {
    if (this.recorder && this.recorder.state !== "inactive") {
      throw new Error("Interview recording is already active");
    }
    if (typeof MediaRecorder === "undefined") {
      throw new Error("MediaRecorder is not supported in this browser");
    }

    this.chunks = [];
    this.selectedMimeType = selectRecordingMimeType();
    this.recorder = this.selectedMimeType
      ? new MediaRecorder(stream, { mimeType: this.selectedMimeType })
      : new MediaRecorder(stream);
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.chunks.push(event.data);
      }
    };
    this.recorder.start(1_000);
  }

  async stop(): Promise<FinalizedInterviewRecording | null> {
    const recorder = this.recorder;
    if (!recorder) {
      return null;
    }
    if (this.finalizing) {
      return this.finalizing;
    }
    if (recorder.state === "inactive") {
      return this.finalize();
    }

    this.finalizing = new Promise<FinalizedInterviewRecording>((resolve, reject) => {
      recorder.onstop = () => {
        try {
          resolve(this.finalize());
        } catch (error) {
          reject(error);
        }
      };
      recorder.onerror = () => reject(new Error("The browser could not finalize the recording"));
      recorder.stop();
    });
    return this.finalizing;
  }

  dispose(): void {
    if (this.recorder?.state === "recording") {
      try {
        this.recorder.stop();
      } catch {
        // Best-effort browser cleanup.
      }
    }
    this.recorder = null;
    this.chunks = [];
    this.finalizing = null;
  }

  private finalize(): FinalizedInterviewRecording {
    const contentType =
      normalizedContentType(this.recorder?.mimeType ?? "") ??
      normalizedContentType(this.selectedMimeType ?? "");
    const byteSize = this.chunks.reduce(
      (total, chunk) => total + (chunk instanceof Blob ? chunk.size : 0),
      0,
    );
    if (!contentType || byteSize === 0) {
      throw new Error("The browser did not produce a valid interview recording");
    }
    if (byteSize > MAX_RECORDING_BYTES) {
      throw new Error("The recording exceeds the upload size limit");
    }
    const blob = new Blob(this.chunks, { type: contentType });
    return { blob, contentType };
  }
}
