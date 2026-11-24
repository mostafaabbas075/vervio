import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const typescript = require("../../node_modules/typescript");

class FakeTrack {
  constructor(kind, readyState = "live") {
    this.kind = kind;
    this.readyState = readyState;
    this.stopCalls = 0;
  }

  stop() {
    this.stopCalls += 1;
    this.readyState = "ended";
  }
}

class FakeMediaStream {
  constructor(tracks = []) {
    this.tracks = tracks;
  }

  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === "video");
  }

  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }

  getTracks() {
    return this.tracks;
  }
}

class FakeMediaRecorder {
  static supportedTypes = new Set(["video/webm"]);

  static isTypeSupported(mimeType) {
    return FakeMediaRecorder.supportedTypes.has(mimeType);
  }

  constructor(stream, options = {}) {
    this.stream = stream;
    this.mimeType = options.mimeType ?? "video/webm";
    this.state = "inactive";
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
    this.timeslice = null;
  }

  start(timeslice) {
    this.state = "recording";
    this.timeslice = timeslice;
  }

  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new globalThis.Blob(["container-bytes"], { type: this.mimeType }) });
    this.onstop?.();
  }
}

globalThis.MediaStream = FakeMediaStream;
globalThis.MediaRecorder = FakeMediaRecorder;

function loadModule() {
  const source = readFileSync(
    new globalThis.URL("../lib/interview-recorder.ts", import.meta.url),
    "utf8",
  );
  const output = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  new Function("exports", "require", "module", output)(module.exports, require, module);
  return module.exports;
}

const {
  InterviewRecorder,
  createInterviewRecordingStream,
  selectRecordingMimeType,
} = loadModule();

test("selects a supported recording fallback without assuming a browser codec", () => {
  FakeMediaRecorder.supportedTypes = new Set(["video/webm"]);

  assert.equal(selectRecordingMimeType(), "video/webm");
});

test("creates a recording stream from camera video and the mixed interview audio only", () => {
  const camera = new FakeTrack("video");
  const microphone = new FakeTrack("audio");
  const mixedInterviewAudio = new FakeTrack("audio");
  const candidateStream = new FakeMediaStream([camera, microphone]);
  const mixedAudioStream = new FakeMediaStream([mixedInterviewAudio]);

  const recordingStream = createInterviewRecordingStream(candidateStream, mixedAudioStream);

  assert.deepEqual(recordingStream.getTracks(), [camera, mixedInterviewAudio]);
  assert.equal(recordingStream.getTracks().includes(microphone), false);
  assert.throws(
    () => createInterviewRecordingStream(new FakeMediaStream([]), mixedAudioStream),
    /live camera and mixed interview audio/i,
  );
});

test("finalizes a recorder without stopping candidate camera or microphone tracks", async () => {
  const camera = new FakeTrack("video");
  const mixedAudio = new FakeTrack("audio");
  const stream = new FakeMediaStream([camera, mixedAudio]);
  const recorder = new InterviewRecorder();

  recorder.start(stream);
  const recording = await recorder.stop();

  assert.equal(recording?.contentType, "video/webm");
  assert.equal(recording?.blob.size, "container-bytes".length);
  assert.equal(camera.stopCalls, 0);
  assert.equal(mixedAudio.stopCalls, 0);
});
