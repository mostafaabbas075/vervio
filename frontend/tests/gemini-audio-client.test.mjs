import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const typescript = require("../../node_modules/typescript");

class FakeMediaStreamTrack {
  constructor(kind = "audio", readyState = "live") {
    this.kind = kind;
    this.readyState = readyState;
    this.enabled = true;
    this.muted = false;
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

let latestFakeSocket = null;

class FakeWebSocket {
  readyState = 1; // OPEN
  binaryType = "blob";
  bufferedAmount = 0;
  sentMessages = [];
  onmessage = null;
  onerror = null;
  onclose = null;
  closedCode = null;
  closedReason = null;

  constructor(url) {
    this.url = url;
    latestFakeSocket = this;
  }

  send(data) {
    this.sentMessages.push(data);
  }

  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.closedCode = code;
    this.closedReason = reason;
    this.onclose?.({ code, reason });
  }

  simulateServerMessage(payload) {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.onmessage?.({ data });
  }

  simulateBinary(bytes) {
    this.onmessage?.({
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  }
}

let latestFakeCapture = null;

class FakeMicrophoneAudioCapture {
  isCapturing = false;
  contextState = "running";
  stopped = false;

  constructor(options) {
    this.options = options;
    latestFakeCapture = this;
  }

  async start() {
    this.isCapturing = true;
  }

  async stop() {
    this.isCapturing = false;
    this.stopped = true;
  }

  emitAudio(samples, sampleRate) {
    this.options.onAudio(samples, sampleRate);
  }
}

class FakeAudioPlayer {
  prepareCalls = 0;
  enqueued = [];
  interruptCalls = 0;
  disposeCalls = 0;

  async prepare() {
    this.prepareCalls += 1;
  }

  enqueue(bytes) {
    this.enqueued.push(bytes);
  }

  interrupt() {
    this.interruptCalls += 1;
  }

  async dispose() {
    this.disposeCalls += 1;
  }

  createRecordingAudioStream(stream) {
    this.recordingCandidateStream = stream;
    return new FakeMediaStream([new FakeMediaStreamTrack("audio", "live")]);
  }
}

globalThis.window = {
  WebSocket: FakeWebSocket,
};
globalThis.WebSocket = FakeWebSocket;

const moduleCache = new Map();

function transpileTsFile(relativePath) {
  if (moduleCache.has(relativePath)) {
    return moduleCache.get(relativePath);
  }

  const source = readFileSync(
    new globalThis.URL(relativePath, import.meta.url),
    "utf8",
  );
  const output = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(relativePath, module.exports);

  const customRequire = (specifier) => {
    if (specifier === "./pcm-audio") {
      return transpileTsFile("../lib/pcm-audio.ts");
    }
    if (specifier === "./microphone-capture") {
      return transpileTsFile("../lib/microphone-capture.ts");
    }
    if (specifier === "./pcm-audio-player") {
      return transpileTsFile("../lib/pcm-audio-player.ts");
    }
    return require(specifier);
  };

  new Function("exports", "require", "module", output)(module.exports, customRequire, module);
  return module.exports;
}

const {
  DEFAULT_MAX_BUFFERED_AMOUNT_BYTES,
  GeminiAudioClient,
} = transpileTsFile("../lib/gemini-audio-client.ts");

function createValidStream() {
  const track = new FakeMediaStreamTrack("audio", "live");
  const stream = new FakeMediaStream([track]);
  return { stream, track };
}

function flushMessages() {
  return delay(0);
}

test("validates configuration options", () => {
  const { stream } = createValidStream();

  assert.throws(() => new GeminiAudioClient(null), TypeError);
  assert.throws(
    () => new GeminiAudioClient({ stream: null, wsUrl: "ws://localhost/ws" }),
    TypeError,
  );
  assert.throws(
    () => new GeminiAudioClient({ stream, wsUrl: "" }),
    TypeError,
  );
  assert.throws(
    () => new GeminiAudioClient({ stream, wsUrl: "ws://localhost/ws", chunkDurationMs: 20 }),
    RangeError,
  );
  assert.throws(
    () => new GeminiAudioClient({ stream, wsUrl: "ws://localhost/ws", chunkDurationMs: 150 }),
    RangeError,
  );

  const client = new GeminiAudioClient({
    stream,
    wsUrl: "ws://localhost/ws",
  });
  assert.equal(client.state, "idle");
  assert.equal(client.isStreaming, false);
});

test("completes handshake ('ready' -> 'start' -> 'provider_connected') and streams PCM audio", async () => {
  const { stream } = createValidStream();
  const stateChanges = [];
  const sentBytes = [];
  let providerConnectedCalled = false;

  const client = new GeminiAudioClient({
    stream,
    wsUrl: "ws://localhost/api/interviews/123/gemini/ws",
    callbacks: {
      onStateChange: (state) => stateChanges.push(state),
      onProviderConnected: () => {
        providerConnectedCalled = true;
      },
      onAudioChunkSent: (bytes) => sentBytes.push(bytes),
    },
    webSocketFactory: (url) => new FakeWebSocket(url),
    captureFactory: (opts) => new FakeMicrophoneAudioCapture(opts),
    audioPlayer: new FakeAudioPlayer(),
  });

  const startPromise = client.start();
  await flushMessages();
  assert.equal(client.state, "connecting");
  assert.ok(latestFakeSocket);
  assert.equal(latestFakeSocket.binaryType, "arraybuffer");

  // Server sends "ready"
  latestFakeSocket.simulateServerMessage({ type: "ready", status: "ready" });
  await flushMessages();

  // Client should have sent {"type":"start"}
  assert.equal(latestFakeSocket.sentMessages.length, 1);
  assert.deepEqual(JSON.parse(latestFakeSocket.sentMessages[0]), { type: "start" });

  // Server sends "provider_connected"
  latestFakeSocket.simulateServerMessage({
    type: "provider_connected",
    status: "provider_connected",
  });

  await startPromise;

  assert.equal(client.state, "connected");
  assert.equal(client.isStreaming, true);
  assert.equal(providerConnectedCalled, true);
  assert.ok(latestFakeCapture);
  assert.equal(latestFakeCapture.isCapturing, true);

  // Simulate audio capture delivering 800 Float32 samples at 16000 Hz
  const floatSamples = new Float32Array(800).fill(0.5);
  latestFakeCapture.emitAudio(floatSamples, 16000);

  // The browser acknowledges ready only after capture and recording setup.
  assert.deepEqual(JSON.parse(latestFakeSocket.sentMessages[1]), { type: "client_ready" });

  // Verify binary PCM frame sent on WebSocket (800 samples * 2 bytes = 1600 bytes)
  assert.equal(latestFakeSocket.sentMessages.length, 3);
  const binaryMessage = latestFakeSocket.sentMessages[2];
  assert.ok(binaryMessage instanceof Uint8Array);
  assert.equal(binaryMessage.byteLength, 1600);
  assert.deepEqual(sentBytes, [1600]);

  // Clean up
  await client.stop();
  assert.equal(client.state, "ended");
  assert.equal(client.isStreaming, false);
  assert.equal(latestFakeCapture.stopped, true);
  assert.equal(latestFakeSocket.readyState, 3);
  assert.equal(latestFakeSocket.closedCode, 1000);
});

test("forwards ordered Gemini binary audio while microphone input continues and cleans up playback", async () => {
  const { stream } = createValidStream();
  const player = new FakeAudioPlayer();
  const receivedByteLengths = [];
  const client = new GeminiAudioClient({
    stream,
    wsUrl: "ws://localhost/ws",
    callbacks: {
      onAudioChunkReceived: (bytes) => receivedByteLengths.push(bytes),
    },
    webSocketFactory: (url) => new FakeWebSocket(url),
    captureFactory: (opts) => new FakeMicrophoneAudioCapture(opts),
    audioPlayer: player,
  });

  const startPromise = client.start();
  await flushMessages();
  latestFakeSocket.simulateServerMessage({ type: "ready" });
  await flushMessages();
  latestFakeSocket.simulateServerMessage({ type: "provider_connected" });
  await startPromise;

  // Candidate input and two AI output turns share the connection concurrently.
  latestFakeCapture.emitAudio(new Float32Array(800).fill(0.5), 16_000);
  latestFakeSocket.simulateBinary(new Uint8Array([0, 0, 255, 127]));
  latestFakeSocket.simulateBinary(new Uint8Array([0, 128, 0, 0]));
  await flushMessages();

  assert.equal(latestFakeSocket.sentMessages.length, 3);
  assert.deepEqual(receivedByteLengths, [4, 4]);
  assert.deepEqual(
    player.enqueued.map((chunk) => [...chunk]),
    [[0, 0, 255, 127], [0, 128, 0, 0]],
  );
  // Raw microphone energy does not interrupt playback; echo and background noise
  // must not chop the interviewer. The authoritative Gemini VAD event does.
  assert.equal(player.interruptCalls, 0);
  latestFakeSocket.simulateServerMessage({ type: "interrupted" });
  await flushMessages();
  assert.equal(player.interruptCalls, 1);

  await client.stop();
  assert.equal(player.disposeCalls, 1);
  const enqueuedBeforeLateFrame = player.enqueued.length;
  latestFakeSocket.simulateBinary(new Uint8Array([1, 2]));
  await flushMessages();
  assert.equal(player.enqueued.length, enqueuedBeforeLateFrame);
});

test("refuses a muted microphone at connection start", async () => {
  const { stream, track } = createValidStream();
  track.enabled = false;
  latestFakeSocket = null;
  const client = new GeminiAudioClient({
    stream,
    wsUrl: "ws://localhost/ws",
    webSocketFactory: (url) => new FakeWebSocket(url),
    captureFactory: (opts) => new FakeMicrophoneAudioCapture(opts),
    audioPlayer: new FakeAudioPlayer(),
  });

  await assert.rejects(client.start(), /unavailable or muted/);
  assert.equal(latestFakeSocket, null);
});

test("keeps three conversational exchanges streaming across mute, unmute, and interruptions", async () => {
  const { stream, track } = createValidStream();
  const player = new FakeAudioPlayer();
  const client = new GeminiAudioClient({
    stream,
    wsUrl: "ws://localhost/ws",
    webSocketFactory: (url) => new FakeWebSocket(url),
    captureFactory: (opts) => new FakeMicrophoneAudioCapture(opts),
    audioPlayer: player,
  });

  const startPromise = client.start();
  await flushMessages();
  latestFakeSocket.simulateServerMessage({ type: "ready" });
  await flushMessages();
  latestFakeSocket.simulateServerMessage({ type: "provider_connected" });
  await startPromise;

  // First model turn (the opening greeting) finishes. Capture remains active
  // and the candidate's subsequent audio is sent over the original socket.
  latestFakeSocket.simulateBinary(new Uint8Array([1, 0]));
  await flushMessages();
  latestFakeCapture.emitAudio(new Float32Array(800).fill(0.4), 16_000);
  latestFakeSocket.simulateServerMessage({ type: "interrupted" });
  await flushMessages();

  // The first post-greeting answer reaches the same playback queue.
  latestFakeSocket.simulateBinary(new Uint8Array([2, 0]));
  await flushMessages();

  // Muting emits no synthetic silence to Gemini. Unmuting reuses the capture
  // graph and supports a second candidate/AI exchange without reconnecting.
  track.enabled = false;
  latestFakeCapture.emitAudio(new Float32Array(800).fill(0.4), 16_000);
  track.enabled = true;
  latestFakeCapture.emitAudio(new Float32Array(800).fill(0.4), 16_000);
  latestFakeSocket.simulateServerMessage({ type: "interrupted" });
  await flushMessages();
  latestFakeSocket.simulateBinary(new Uint8Array([3, 0]));
  latestFakeCapture.emitAudio(new Float32Array(800).fill(0.4), 16_000);
  latestFakeSocket.simulateServerMessage({ type: "interrupted" });
  await flushMessages();
  latestFakeSocket.simulateBinary(new Uint8Array([4, 0]));
  await flushMessages();

  assert.equal(latestFakeCapture.isCapturing, true);
  assert.equal(latestFakeSocket.sentMessages.length, 5);
  assert.deepEqual(
    player.enqueued.map((chunk) => [...chunk]),
    [[1, 0], [2, 0], [3, 0], [4, 0]],
  );
  assert.equal(player.interruptCalls, 3);

  await client.stop();
});

test("acknowledges client readiness only after microphone setup completes", async () => {
  const { stream } = createValidStream();
  const player = new FakeAudioPlayer();
  let completeCaptureStart;
  const delayedCapture = {
    async start() {
      await new Promise((resolve) => {
        completeCaptureStart = resolve;
      });
    },
    async stop() {},
  };
  const client = new GeminiAudioClient({
    stream,
    wsUrl: "ws://localhost/ws",
    webSocketFactory: (url) => new FakeWebSocket(url),
    captureFactory: () => delayedCapture,
    audioPlayer: player,
  });

  const startPromise = client.start();
  await flushMessages();
  latestFakeSocket.simulateServerMessage({ type: "ready" });
  await flushMessages();
  latestFakeSocket.simulateServerMessage({ type: "provider_connected" });
  await flushMessages();
  assert.deepEqual(
    latestFakeSocket.sentMessages.map((message) => JSON.parse(message)),
    [{ type: "start" }],
  );

  completeCaptureStart();
  await startPromise;
  assert.deepEqual(JSON.parse(latestFakeSocket.sentMessages[1]), { type: "client_ready" });
  latestFakeSocket.simulateBinary(new Uint8Array([0, 0, 255, 127]));
  await flushMessages();
  assert.deepEqual(player.enqueued.map((chunk) => [...chunk]), [[0, 0, 255, 127]]);
  await client.stop();
});

test("starts the mixed recording before accepting the Gemini greeting", async () => {
  const { stream } = createValidStream();
  const player = new FakeAudioPlayer();
  const eventOrder = [];
  let completeCaptureStart;
  const delayedCapture = {
    async start() {
      await new Promise((resolve) => {
        completeCaptureStart = resolve;
      });
    },
    async stop() {},
  };
  const originalEnqueue = player.enqueue.bind(player);
  player.enqueue = (bytes) => {
    eventOrder.push("greeting");
    originalEnqueue(bytes);
  };
  const client = new GeminiAudioClient({
    stream,
    wsUrl: "ws://localhost/ws",
    callbacks: {
      onRecordingAudioStreamReady: (mixedStream) => {
        eventOrder.push("recording");
        assert.equal(player.recordingCandidateStream, stream);
        assert.equal(mixedStream.getAudioTracks().length, 1);
      },
    },
    webSocketFactory: (url) => new FakeWebSocket(url),
    captureFactory: () => delayedCapture,
    audioPlayer: player,
  });

  const startPromise = client.start();
  await flushMessages();
  latestFakeSocket.simulateServerMessage({ type: "ready" });
  await flushMessages();
  latestFakeSocket.simulateServerMessage({ type: "provider_connected" });
  await flushMessages();

  completeCaptureStart();
  await startPromise;
  assert.deepEqual(JSON.parse(latestFakeSocket.sentMessages[1]), { type: "client_ready" });
  latestFakeSocket.simulateBinary(new Uint8Array([0, 0, 255, 127]));
  await flushMessages();

  assert.deepEqual(eventOrder, ["recording", "greeting"]);
  await client.stop();
});

test("prevents duplicate start() calls while running", async () => {
  const { stream } = createValidStream();
  const client = new GeminiAudioClient({
    stream,
    wsUrl: "ws://localhost/ws",
    webSocketFactory: (url) => new FakeWebSocket(url),
    captureFactory: (opts) => new FakeMicrophoneAudioCapture(opts),
    audioPlayer: new FakeAudioPlayer(),
  });

  const startPromise = client.start();
  await flushMessages();
  latestFakeSocket.simulateServerMessage({ type: "ready" });
  await flushMessages();
  latestFakeSocket.simulateServerMessage({ type: "provider_connected" });
  await startPromise;

  await assert.rejects(client.start(), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /already running/i);
    return true;
  });

  await client.stop();
});

test("never stops caller tracks when stopping", async () => {
  const { stream, track } = createValidStream();
  const client = new GeminiAudioClient({
    stream,
    wsUrl: "ws://localhost/ws",
    webSocketFactory: (url) => new FakeWebSocket(url),
    captureFactory: (opts) => new FakeMicrophoneAudioCapture(opts),
    audioPlayer: new FakeAudioPlayer(),
  });

  const startPromise = client.start();
  await flushMessages();
  latestFakeSocket.simulateServerMessage({ type: "ready" });
  await flushMessages();
  latestFakeSocket.simulateServerMessage({ type: "provider_connected" });
  await startPromise;

  await client.stop();

  // Caller tracks MUST remain untouched!
  assert.equal(track.stopCallCount, 0);
  assert.equal(track.readyState, "live");
});

test("drops audio chunks when network backpressure threshold is exceeded", async () => {
  const { stream } = createValidStream();
  const client = new GeminiAudioClient({
    stream,
    wsUrl: "ws://localhost/ws",
    maxBufferedAmountBytes: DEFAULT_MAX_BUFFERED_AMOUNT_BYTES,
    webSocketFactory: (url) => new FakeWebSocket(url),
    captureFactory: (opts) => new FakeMicrophoneAudioCapture(opts),
    audioPlayer: new FakeAudioPlayer(),
  });

  const startPromise = client.start();
  await flushMessages();
  latestFakeSocket.simulateServerMessage({ type: "ready" });
  await flushMessages();
  latestFakeSocket.simulateServerMessage({ type: "provider_connected" });
  await startPromise;

  const initialSentCount = latestFakeSocket.sentMessages.length; // start + client_ready

  // Set bufferedAmount to exceed threshold
  latestFakeSocket.bufferedAmount = DEFAULT_MAX_BUFFERED_AMOUNT_BYTES + 1;
  latestFakeCapture.emitAudio(new Float32Array(800), 16000);

  // Message should have been dropped due to backpressure
  assert.equal(latestFakeSocket.sentMessages.length, initialSentCount);

  // Clear bufferedAmount and send again
  latestFakeSocket.bufferedAmount = 0;
  latestFakeCapture.emitAudio(new Float32Array(800), 16000);

  // Should have sent the chunk now
  assert.equal(latestFakeSocket.sentMessages.length, initialSentCount + 1);

  await client.stop();
});

test("handles server error during handshake by rejecting start() and cleaning up", async () => {
  const { stream } = createValidStream();
  const errors = [];
  const client = new GeminiAudioClient({
    stream,
    wsUrl: "ws://localhost/ws",
    callbacks: {
      onError: (err) => errors.push(err.message),
    },
    webSocketFactory: (url) => new FakeWebSocket(url),
    captureFactory: (opts) => new FakeMicrophoneAudioCapture(opts),
    audioPlayer: new FakeAudioPlayer(),
  });

  const startPromise = client.start();
  await flushMessages();
  latestFakeSocket.simulateServerMessage({ type: "ready" });
  await flushMessages();

  // Server sends an error message (e.g. GeminiLiveConfigurationError)
  latestFakeSocket.simulateServerMessage({
    type: "error",
    message: "GEMINI_API_KEY is not configured.",
  });

  await assert.rejects(startPromise, (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /GEMINI_API_KEY is not configured/i);
    return true;
  });

  assert.equal(client.state, "failed");
});

test("handles unexpected WebSocket closure during active streaming", async () => {
  const { stream } = createValidStream();
  const errors = [];
  const stateChanges = [];

  const client = new GeminiAudioClient({
    stream,
    wsUrl: "ws://localhost/ws",
    callbacks: {
      onStateChange: (state) => stateChanges.push(state),
      onError: (err) => errors.push(err.message),
    },
    webSocketFactory: (url) => new FakeWebSocket(url),
    captureFactory: (opts) => new FakeMicrophoneAudioCapture(opts),
    audioPlayer: new FakeAudioPlayer(),
  });

  const startPromise = client.start();
  await flushMessages();
  latestFakeSocket.simulateServerMessage({ type: "ready" });
  await flushMessages();
  latestFakeSocket.simulateServerMessage({ type: "provider_connected" });
  await startPromise;

  // Simulate socket closing abruptly
  latestFakeSocket.close(1006, "Connection dropped");

  assert.equal(client.state, "failed");
  assert.ok(errors.length > 0);
  assert.match(errors[0], /closed unexpectedly/i);
});
