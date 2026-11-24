import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  convertWavBufferForGemini,
  createPcm16MonoWav,
  parseArguments,
  parsePcm16Wav,
} from "../scripts/pcm-audio-local-diagnostic.mjs";

function makePcm16Samples(samples) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return bytes;
}

test("local diagnostic emits valid mono 16 kHz PCM16 WAV from 96 kHz capture-sized chunks", () => {
  const sampleRate = 96_000;
  const sourceSamples = new Int16Array(sampleRate / 10);
  for (let index = 0; index < sourceSamples.length; index += 1) {
    sourceSamples[index] = Math.round(12_000 * Math.sin((2 * Math.PI * 440 * index) / sampleRate));
  }
  const inputWav = createPcm16MonoWav(makePcm16Samples(sourceSamples), sampleRate);

  const { outputWav, metrics } = convertWavBufferForGemini(inputWav);
  const output = parsePcm16Wav(outputWav);

  assert.equal(metrics.conversion.captureChunkCount, 2);
  assert.equal(metrics.conversion.sourceFramesPerChunk, 4_800);
  assert.equal(metrics.input.durationMs, 100);
  assert.equal(metrics.output.durationMs, 100);
  assert.equal(metrics.output.sampleRate, 16_000);
  assert.equal(metrics.output.channels, 1);
  assert.equal(metrics.output.bitDepth, 16);
  assert.equal(metrics.output.endianness, "little");
  assert.equal(metrics.output.completePcm16Frames, true);
  assert.equal(output.sampleRate, 16_000);
  assert.equal(output.channels, 1);
  assert.equal(output.sourceFrameCount, 1_600);
  assert.ok(metrics.output.rms > 0.2);
  assert.ok(metrics.output.peak > 0.3);
  assert.equal(metrics.output.clippingRatio, 0);
});

test("local diagnostic uses channel zero to match the microphone worklet", () => {
  const monoSource = makePcm16Samples([16_384, 16_384]);
  const stereoWav = Buffer.alloc(44 + 8);
  stereoWav.write("RIFF", 0, "ascii");
  stereoWav.writeUInt32LE(36 + 8, 4);
  stereoWav.write("WAVEfmt ", 8, "ascii");
  stereoWav.writeUInt32LE(16, 16);
  stereoWav.writeUInt16LE(1, 20);
  stereoWav.writeUInt16LE(2, 22);
  stereoWav.writeUInt32LE(16_000, 24);
  stereoWav.writeUInt32LE(64_000, 28);
  stereoWav.writeUInt16LE(4, 32);
  stereoWav.writeUInt16LE(16, 34);
  stereoWav.write("data", 36, "ascii");
  stereoWav.writeUInt32LE(8, 40);
  stereoWav[44] = monoSource[0];
  stereoWav[45] = monoSource[1];
  stereoWav.writeInt16LE(-16_384, 46);
  stereoWav[48] = monoSource[2];
  stereoWav[49] = monoSource[3];
  stereoWav.writeInt16LE(-16_384, 50);

  const { outputWav } = convertWavBufferForGemini(stereoWav);
  const output = parsePcm16Wav(outputWav);
  assert.equal(output.channels, 1);
  assert.equal(Math.round(output.channelZeroSamples[0] * 32_768), 16_384);
});

test("local diagnostic requires explicit distinct WAV paths", () => {
  assert.throws(() => parseArguments([]), /required/);
  assert.throws(
    () => parseArguments(["--input", "same.wav", "--output", "same.wav"]),
    /different/,
  );
  assert.throws(
    () => parseArguments(["--input", "speech.mp3", "--output", "output.wav"]),
    /\.wav/,
  );
});
