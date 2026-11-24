import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const typescript = require("../../node_modules/typescript");

function loadModule() {
  const source = readFileSync(
    new globalThis.URL("../lib/pcm-audio-player.ts", import.meta.url),
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

class FakeAudioBuffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.channels = [];
  }

  copyToChannel(samples, channel) {
    this.channels[channel] = samples;
  }
}

class FakeAudioBufferSource {
  constructor() {
    this.buffer = null;
    this.onended = null;
    this.startTimes = [];
    this.stopCalls = 0;
    this.connectedTo = [];
  }

  connect(destination) {
    this.connectedTo.push(destination);
  }

  disconnect() {
    this.connectedTo = [];
  }

  start(time) {
    this.startTimes.push(time);
  }

  stop() {
    this.stopCalls += 1;
  }

  finish() {
    this.onended?.();
  }
}

class FakeMediaStream {
  constructor(tracks = []) {
    this.tracks = tracks;
  }

  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }
}

class FakeMediaStreamSource {
  constructor(stream) {
    this.stream = stream;
    this.connectedTo = [];
    this.disconnectCalls = 0;
  }

  connect(destination) {
    this.connectedTo.push(destination);
  }

  disconnect() {
    this.disconnectCalls += 1;
    this.connectedTo = [];
  }
}

class FakeAudioContext {
  currentTime = 10;
  state = "running";
  destination = { kind: "destination" };
  buffers = [];
  sources = [];
  mediaSources = [];
  mediaDestinations = [];
  resumeCalls = 0;
  closeCalls = 0;

  createBuffer(channels, length, sampleRate) {
    const buffer = new FakeAudioBuffer(channels, length, sampleRate);
    this.buffers.push(buffer);
    return buffer;
  }

  createBufferSource() {
    const source = new FakeAudioBufferSource();
    this.sources.push(source);
    return source;
  }

  createMediaStreamDestination() {
    const destination = { stream: new FakeMediaStream([{ kind: "audio", readyState: "live" }]) };
    this.mediaDestinations.push(destination);
    return destination;
  }

  createMediaStreamSource(stream) {
    const source = new FakeMediaStreamSource(stream);
    this.mediaSources.push(source);
    return source;
  }

  async resume() {
    this.resumeCalls += 1;
    this.state = "running";
  }

  async close() {
    this.closeCalls += 1;
    this.state = "closed";
  }
}

globalThis.MediaStream = FakeMediaStream;

const {
  GEMINI_PCM_OUTPUT_SAMPLE_RATE,
  PcmAudioPlayer,
  decodePcm16Mono,
} = loadModule();

function pcm16(...samples) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return bytes;
}

test("decodes Gemini PCM16 output as 24 kHz mono samples", () => {
  assert.equal(GEMINI_PCM_OUTPUT_SAMPLE_RATE, 24_000);
  const decoded = decodePcm16Mono(pcm16(0, 32767, -32768, 16384));
  assert.deepEqual([...decoded].map((value) => Math.round(value * 32768)), [0, 32767, -32768, 16384]);
  assert.throws(() => decodePcm16Mono(new Uint8Array([1])), RangeError);
});

test("queues Gemini audio frames in order and reports playback completion", () => {
  const context = new FakeAudioContext();
  const states = [];
  const playedPcmByteLengths = [];
  const player = new PcmAudioPlayer({
    audioContext: context,
    callbacks: {
      onPlaybackStateChange: (playing) => states.push(playing),
      onChunkPlayed: (byteLength) => playedPcmByteLengths.push(byteLength),
    },
  });

  const oneTenthSecond = new Uint8Array(2_400 * 2);
  player.enqueue(oneTenthSecond);
  player.enqueue(oneTenthSecond);

  assert.equal(context.buffers.length, 2);
  assert.equal(context.buffers[0].sampleRate, 24_000);
  assert.equal(context.buffers[0].numberOfChannels, 1);
  assert.equal(context.sources[0].startTimes[0], 10.02);
  assert.equal(context.sources[1].startTimes[0], 10.12);
  assert.deepEqual(states, [true]);

  context.sources[0].finish();
  assert.deepEqual(states, [true]);
  assert.deepEqual(playedPcmByteLengths, [4_800]);
  context.sources[1].finish();
  assert.deepEqual(states, [true, false]);
  assert.deepEqual(playedPcmByteLengths, [4_800, 4_800]);
});

test("mixes candidate microphone and Gemini output into a capture-only recording stream", () => {
  const context = new FakeAudioContext();
  const player = new PcmAudioPlayer({ audioContext: context, jitterBufferSeconds: 0.1 });
  const candidateTrack = { kind: "audio", readyState: "live" };
  const candidateStream = new FakeMediaStream([candidateTrack]);

  const recordingStream = player.createRecordingAudioStream(candidateStream);
  player.enqueue(new Uint8Array(2_400 * 2));

  assert.equal(recordingStream, context.mediaDestinations[0].stream);
  assert.deepEqual(context.mediaSources[0].stream.getAudioTracks(), [candidateTrack]);
  assert.deepEqual(context.mediaSources[0].connectedTo, [context.mediaDestinations[0]]);
  assert.deepEqual(context.sources[0].connectedTo, [context.destination, context.mediaDestinations[0]]);

  player.stopRecordingMix();
  assert.equal(context.mediaSources[0].disconnectCalls, 1);
  assert.deepEqual(context.mediaSources[0].connectedTo, []);
});

test("preserves an eight-times-realtime PCM burst without silently clearing speech", () => {
  const context = new FakeAudioContext();
  const player = new PcmAudioPlayer({
    audioContext: context,
    maxScheduledAheadSeconds: 0.2,
    jitterBufferSeconds: 0.1,
  });
  const oneTenthSecond = new Uint8Array(2_400 * 2);

  // Eight seconds arrive as a one-second burst. Only a small horizon is
  // scheduled, and the remaining valid audio stays pending in order.
  for (let index = 0; index < 80; index += 1) {
    player.enqueue(oneTenthSecond);
  }

  assert.equal(context.sources.length, 2);
  assert.equal(context.sources.every((source) => source.stopCalls === 0), true);

  let finishedSources = 0;
  while (finishedSources < context.sources.length) {
    const source = context.sources[finishedSources];
    context.currentTime = source.startTimes[0] + 0.1;
    source.finish();
    finishedSources += 1;
  }
  assert.equal(context.sources.length, 80);
  assert.equal(context.sources.every((source) => source.stopCalls === 0), true);
});

test("stops all scheduled output without closing a caller-owned context", async () => {
  const context = new FakeAudioContext();
  const player = new PcmAudioPlayer({ audioContext: context, jitterBufferSeconds: 0.1 });
  player.enqueue(new Uint8Array(2_400 * 2));
  player.interrupt();
  assert.equal(context.sources[0].stopCalls, 1);
  await player.dispose();
  // A supplied context belongs to the caller, so it remains usable after cleanup.
  assert.equal(context.closeCalls, 0);
});

test("cancels a pending jitter-buffer timer on interruption", async () => {
  const context = new FakeAudioContext();
  const player = new PcmAudioPlayer({ audioContext: context });
  player.enqueue(new Uint8Array(960 * 2)); // 40 ms, below the 120 ms startup target
  player.interrupt();

  await delay(180);
  assert.equal(context.sources.length, 0);
  await player.dispose();
});

test("uses a 120 ms jitter buffer to schedule irregular Gemini frames without gaps", () => {
  const context = new FakeAudioContext();
  const player = new PcmAudioPlayer({ audioContext: context });
  const fortyMilliseconds = new Uint8Array(960 * 2);

  player.enqueue(fortyMilliseconds);
  player.enqueue(fortyMilliseconds);
  assert.equal(context.sources.length, 0);

  // The third irregularly delivered frame reaches the 120 ms startup target.
  player.enqueue(fortyMilliseconds);
  assert.deepEqual(
    context.sources.map((source) => Math.round(source.startTimes[0] * 100) / 100),
    [10.02, 10.06, 10.1],
  );
  assert.equal(context.buffers.every((buffer) => buffer.sampleRate === 24_000), true);
  player.interrupt();
});
