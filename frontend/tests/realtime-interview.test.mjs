import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const typescript = require("../../node_modules/typescript");

class FakeDataChannel {
  readyState = "open";
  closed = false;
  messages = [];
  listeners = new Map();
  onerror = null;
  onmessage = null;

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type) {
    this.listeners.delete(type);
  }

  send(message) {
    this.messages.push(message);
    if (JSON.parse(message).type === "session.close") {
      this.onmessage?.({ data: JSON.stringify({ type: "session.closed" }) });
    }
  }

  close() {
    this.closed = true;
    this.readyState = "closed";
  }
}

let latestPeerConnection = null;

class FakePeerConnection {
  connectionState = "new";
  dataChannel = new FakeDataChannel();
  closed = false;
  listeners = new Map();
  onconnectionstatechange = null;
  ontrack = null;

  constructor() {
    latestPeerConnection = this;
  }

  createDataChannel() {
    return this.dataChannel;
  }

  addTrack() {}

  async createOffer() {
    return { sdp: "v=0\r\na=fake-offer" };
  }

  async setLocalDescription() {}

  async setRemoteDescription() {
    this.connectionState = "connected";
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type) {
    this.listeners.delete(type);
  }

  close() {
    this.closed = true;
    this.connectionState = "closed";
  }
}

class FakeMediaStream {
  constructor(tracks = []) {
    this.tracks = tracks;
  }

  addTrack(track) {
    this.tracks.push(track);
  }

  getTracks() {
    return this.tracks;
  }
}

class FakeAudio {
  autoplay = false;
  srcObject = null;

  async play() {}

  pause() {}
}

globalThis.window = {
  clearTimeout: globalThis.clearTimeout,
  setTimeout: globalThis.setTimeout,
};
globalThis.RTCPeerConnection = FakePeerConnection;
globalThis.MediaStream = FakeMediaStream;
globalThis.Audio = FakeAudio;

function loadRealtimeModule() {
  const source = readFileSync(
    new globalThis.URL("../lib/realtime-interview.ts", import.meta.url),
    "utf8",
  );
  const output = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("exports", "require", "module", output)(module.exports, require, module);
  return module.exports;
}

const { RealtimeInterviewConnection, RealtimeInterviewError } = loadRealtimeModule();

function createCallbacks() {
  const stateChanges = [];
  const errors = [];
  return {
    stateChanges,
    errors,
    callbacks: {
      onStateChange: (state) => stateChanges.push(state),
      onAssistantSpeakingChange: () => {},
      onCandidateSpeakingChange: () => {},
      onError: (error) => errors.push(error),
    },
  };
}

test("prevents duplicate starts and closes WebRTC resources on end", async () => {
  const callbackState = createCallbacks();
  const microphoneTrack = { readyState: "live" };
  const connection = new RealtimeInterviewConnection({
    microphoneTrack,
    requestOffer: async () => ({ answer_sdp: "v=0\r\na=fake-answer", max_duration_seconds: 60 }),
    callbacks: callbackState.callbacks,
  });

  assert.equal(await connection.start(), 60);
  assert.equal(connection.state, "connected");
  await assert.rejects(connection.start(), (error) => {
    assert.ok(error instanceof RealtimeInterviewError);
    assert.equal(error.code, "duplicate_start");
    return true;
  });

  await connection.end();

  assert.equal(connection.state, "ended");
  assert.deepEqual(callbackState.stateChanges, ["connecting", "connected", "ending", "ended"]);
  assert.equal(latestPeerConnection.closed, true);
  assert.equal(latestPeerConnection.dataChannel.closed, true);
});

test("reports a failed connection without retrying or retaining a peer connection", async () => {
  const callbackState = createCallbacks();
  const connection = new RealtimeInterviewConnection({
    microphoneTrack: { readyState: "live" },
    requestOffer: async () => {
      throw new Error("provider unavailable");
    },
    callbacks: callbackState.callbacks,
  });

  await assert.rejects(connection.start());

  assert.equal(connection.state, "failed");
  assert.deepEqual(callbackState.stateChanges, ["connecting", "failed"]);
  assert.deepEqual(callbackState.errors, ["connection_failed"]);
  assert.equal(latestPeerConnection.closed, true);
});
