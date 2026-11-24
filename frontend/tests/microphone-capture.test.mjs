import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const typescript = require("../../node_modules/typescript");

class FakeMediaStreamTrack {
  constructor(kind = "audio", readyState = "live") {
    this.kind = kind;
    this.readyState = readyState;
    this.stopCallCount = 0;
  }

  stop() {
    this.stopCallCount += 1;
    this.readyState = "ended";
  }
}

class FakeMediaStream {
  constructor(tracks = []) {
    this.tracks = tracks;
  }

  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }

  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }

  getTracks() {
    return this.tracks;
  }
}

class FakeAudioParam {
  value = 1;
}

class FakeAudioNode {
  connections = [];
  disconnected = false;

  connect(target) {
    this.connections.push(target);
    return target;
  }

  disconnect() {
    this.connections = [];
    this.disconnected = true;
  }
}

class FakeGainNode extends FakeAudioNode {
  gain = new FakeAudioParam();
}

class FakeMessagePort {
  onmessage = null;
  messages = [];

  postMessage(message) {
    this.messages.push(message);
  }

  emit(data) {
    this.onmessage?.({ data });
  }
}

let latestWorkletNode = null;

class FakeAudioWorkletNode extends FakeAudioNode {
  constructor(context, processorName, options) {
    super();
    this.context = context;
    this.processorName = processorName;
    this.options = options;
    this.port = new FakeMessagePort();
    latestWorkletNode = this;
  }
}

class FakeAudioWorklet {
  modules = [];

  async addModule(url) {
    this.modules.push(url);
  }
}

let latestAudioContext = null;

class FakeAudioContext {
  state = "running";
  sampleRate = 48000;
  destination = new FakeAudioNode();
  audioWorklet = new FakeAudioWorklet();
  resumeCallCount = 0;
  closeCallCount = 0;

  constructor(options = {}) {
    if (options.sampleRate) {
      this.sampleRate = options.sampleRate;
    }
    if (options.state) {
      this.state = options.state;
    }
    latestAudioContext = this;
  }

  createMediaStreamSource(stream) {
    const node = new FakeAudioNode();
    node.stream = stream;
    return node;
  }

  createGain() {
    return new FakeGainNode();
  }

  async resume() {
    this.resumeCallCount += 1;
    this.state = "running";
  }

  async close() {
    this.closeCallCount += 1;
    this.state = "closed";
  }
}

globalThis.window = {
  AudioContext: FakeAudioContext,
  AudioWorkletNode: FakeAudioWorkletNode,
};
globalThis.AudioContext = FakeAudioContext;
globalThis.AudioWorkletNode = FakeAudioWorkletNode;

function loadMicrophoneCaptureModule() {
  const source = readFileSync(
    new globalThis.URL("../lib/microphone-capture.ts", import.meta.url),
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
  DEFAULT_CHUNK_DURATION_MS,
  MIN_CHUNK_DURATION_MS,
  MAX_CHUNK_DURATION_MS,
  AUDIO_WORKLET_PROCESSOR_NAME,
  MicrophoneAudioCapture,
} = loadMicrophoneCaptureModule();

function createValidStream() {
  const track = new FakeMediaStreamTrack("audio", "live");
  const stream = new FakeMediaStream([track]);
  return { stream, track };
}

test("validates configuration options", () => {
  const { stream } = createValidStream();

  assert.throws(() => new MicrophoneAudioCapture(null), TypeError);
  assert.throws(
    () => new MicrophoneAudioCapture({ stream: null, onAudio: () => {} }),
    TypeError,
  );
  assert.throws(
    () => new MicrophoneAudioCapture({ stream: new FakeMediaStream([]), onAudio: () => {} }),
    Error,
  );
  assert.throws(
    () => new MicrophoneAudioCapture({ stream, onAudio: null }),
    TypeError,
  );
  assert.throws(
    () => new MicrophoneAudioCapture({ stream, onAudio: () => {}, chunkDurationMs: 20 }),
    RangeError,
  );
  assert.throws(
    () => new MicrophoneAudioCapture({ stream, onAudio: () => {}, chunkDurationMs: 200 }),
    RangeError,
  );
  assert.throws(
    () => new MicrophoneAudioCapture({ stream, onAudio: () => {}, chunkDurationMs: Number.NaN }),
    RangeError,
  );

  const capture = new MicrophoneAudioCapture({ stream, onAudio: () => {} });
  assert.equal(capture.isCapturing, false);
  assert.equal(DEFAULT_CHUNK_DURATION_MS, 50);
  assert.equal(MIN_CHUNK_DURATION_MS, 40);
  assert.equal(MAX_CHUNK_DURATION_MS, 100);
  assert.equal(AUDIO_WORKLET_PROCESSOR_NAME, "vervio-recorder-worklet");
});

test("starts capturing, wires muted audio graph, and handles duplicate start", async () => {
  const { stream } = createValidStream();
  const capture = new MicrophoneAudioCapture({
    stream,
    onAudio: () => {},
  });

  await capture.start();
  assert.equal(capture.isCapturing, true);
  assert.equal(capture.sampleRate, 48000);
  assert.ok(latestAudioContext);
  assert.ok(latestWorkletNode);

  // Verify the worklet processor name and options
  assert.equal(latestWorkletNode.processorName, AUDIO_WORKLET_PROCESSOR_NAME);
  // Default 50ms at 48kHz = 2400 samples
  assert.equal(latestWorkletNode.options.processorOptions.chunkSize, 2400);

  // Verify audio graph: source -> worklet -> mutedGain -> destination
  const workletConnections = latestWorkletNode.connections;
  assert.equal(workletConnections.length, 1);
  const mutedGainNode = workletConnections[0];
  assert.ok(mutedGainNode instanceof FakeGainNode);
  assert.equal(mutedGainNode.gain.value, 0); // Muted to prevent audio playback through speakers!
  assert.equal(mutedGainNode.connections[0], latestAudioContext.destination);

  // Verify duplicate start is rejected
  await assert.rejects(capture.start(), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /already running/i);
    return true;
  });

  await capture.stop();
  assert.equal(capture.isCapturing, false);
});

test("properly cleans up resources on stop without stopping caller tracks", async () => {
  const { stream, track } = createValidStream();
  const capture = new MicrophoneAudioCapture({
    stream,
    onAudio: () => {},
  });

  await capture.start();
  assert.equal(latestAudioContext.state, "running");

  await capture.stop();
  assert.equal(capture.isCapturing, false);
  assert.equal(latestAudioContext.closeCallCount, 1);
  assert.equal(latestAudioContext.state, "closed");
  assert.equal(latestWorkletNode.port.onmessage, null);
  assert.equal(latestWorkletNode.disconnected, true);

  // CRITICAL: The caller's track MUST NOT be stopped!
  assert.equal(track.stopCallCount, 0);
  assert.equal(track.readyState, "live");

  // stop() should be idempotent
  await capture.stop();
  assert.equal(latestAudioContext.closeCallCount, 1);
});

test("batches captured audio samples and provides sample rate to callback", async () => {
  const { stream } = createValidStream();
  const receivedChunks = [];
  const receivedRates = [];

  const capture = new MicrophoneAudioCapture({
    stream,
    chunkDurationMs: 50, // 50ms at 48kHz = 2400 samples
    onAudio: (samples, rate) => {
      receivedChunks.push(samples);
      receivedRates.push(rate);
    },
  });

  await capture.start();

  // Simulate worklet emitting three 1000-sample chunks (total 3000 samples)
  const piece1 = new Float32Array(1000).fill(0.1);
  const piece2 = new Float32Array(1000).fill(0.2);
  const piece3 = new Float32Array(1000).fill(0.3);

  latestWorkletNode.port.emit(piece1);
  assert.equal(receivedChunks.length, 0); // 1000 < 2400

  latestWorkletNode.port.emit(piece2);
  assert.equal(receivedChunks.length, 0); // 2000 < 2400

  latestWorkletNode.port.emit(piece3);
  // Now 3000 samples have arrived: one chunk of 2400 should have fired!
  assert.equal(receivedChunks.length, 1);
  assert.equal(receivedChunks[0].length, 2400);
  assert.equal(receivedRates[0], 48000);
  assert.ok(receivedChunks[0] instanceof Float32Array);

  // The remaining 600 samples should flush when stop() is called
  await capture.stop();
  assert.equal(receivedChunks.length, 2);
  assert.equal(receivedChunks[1].length, 600);
});

test("resumes suspended AudioContext automatically", async () => {
  const { stream } = createValidStream();
  const suspendedContext = new FakeAudioContext({ state: "suspended" });

  const capture = new MicrophoneAudioCapture({
    stream,
    audioContext: suspendedContext,
    onAudio: () => {},
  });

  await capture.start();
  assert.equal(suspendedContext.resumeCallCount, 1);
  assert.equal(suspendedContext.state, "running");

  // When external AudioContext is passed, stop() should not close it
  await capture.stop();
  assert.equal(suspendedContext.closeCallCount, 0);
});

test("rejects starting if audio track is not live", async () => {
  const track = new FakeMediaStreamTrack("audio", "ended");
  const stream = new FakeMediaStream([track]);

  const capture = new MicrophoneAudioCapture({
    stream,
    onAudio: () => {},
  });

  await assert.rejects(capture.start(), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /not live/i);
    return true;
  });
});

