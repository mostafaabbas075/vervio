import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const typescript = require("../../node_modules/typescript");

function loadPcmAudioModule() {
  const source = readFileSync(
    new globalThis.URL("../lib/pcm-audio.ts", import.meta.url),
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
  TARGET_PCM_SAMPLE_RATE,
  convertFloat32ToPcm16,
  float32ToPcm16,
  measureFloat32AudioQuality,
  measurePcm16AudioQuality,
  resampleFloat32,
} = loadPcmAudioModule();

test("exports TARGET_PCM_SAMPLE_RATE as 16000", () => {
  assert.equal(TARGET_PCM_SAMPLE_RATE, 16000);
});

test("converts standard Float32 values to signed 16-bit little-endian PCM at 16kHz", () => {
  const samples = new Float32Array([0.0, 1.0, -1.0, 0.5, -0.5]);
  const pcm = convertFloat32ToPcm16(samples, 16000);

  assert.ok(pcm instanceof Uint8Array);
  assert.equal(pcm.byteLength, 10);

  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  assert.equal(view.getInt16(0, true), 0);
  assert.equal(view.getInt16(2, true), 32767);
  assert.equal(view.getInt16(4, true), -32768);
  assert.equal(view.getInt16(6, true), 16384);
  assert.equal(view.getInt16(8, true), -16384);

  // Check little-endian byte ordering explicitly
  // 32767 = 0x7FFF -> low byte 0xFF, high byte 0x7F
  assert.equal(pcm[2], 0xff);
  assert.equal(pcm[3], 0x7f);
  // -32768 = 0x8000 -> low byte 0x00, high byte 0x80
  assert.equal(pcm[4], 0x00);
  assert.equal(pcm[5], 0x80);
});

test("clamps out-of-range floats and handles non-finite values safely", () => {
  const samples = new Float32Array([1.5, -2.5, Number.NaN, Number.POSITIVE_INFINITY]);
  const pcm = convertFloat32ToPcm16(samples, 16000);

  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  assert.equal(view.getInt16(0, true), 32767);
  assert.equal(view.getInt16(2, true), -32768);
  assert.equal(view.getInt16(4, true), 0);
  assert.equal(view.getInt16(6, true), 0);
});

test("resamples audio from 48000 Hz down to 16000 Hz", () => {
  const inputLength = 4800; // 100ms at 48kHz
  const samples = new Float32Array(inputLength);
  for (let i = 0; i < inputLength; i++) {
    samples[i] = 0.5;
  }

  const pcm = convertFloat32ToPcm16(samples, 48000);

  // At 16kHz, 100ms is 1600 samples -> 3200 bytes
  assert.equal(pcm.byteLength, 3200);

  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = 0; i < 1600; i++) {
    assert.equal(view.getInt16(i * 2, true), 16384);
  }
});

test("preserves measurable 96 kHz speech-like PCM signal quality at 16 kHz", () => {
  const sourceRate = 96_000;
  const durationSeconds = 0.05;
  const samples = new Float32Array(sourceRate * durationSeconds);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = 0.4 * Math.sin((2 * Math.PI * 440 * index) / sourceRate);
  }

  const sourceQuality = measureFloat32AudioQuality(samples);
  const pcm = convertFloat32ToPcm16(samples, sourceRate);
  const pcmQuality = measurePcm16AudioQuality(pcm);

  assert.equal(pcm.byteLength, 1_600); // 50 ms × 16 kHz × PCM16
  assert.equal(pcmQuality.sampleCount, 800);
  assert.ok(sourceQuality.rms > 0.25 && sourceQuality.rms < 0.3);
  assert.ok(pcmQuality.rms > 0.25 && pcmQuality.rms < 0.3);
  assert.ok(Math.abs(sourceQuality.peak - pcmQuality.peak) < 0.02);
  assert.equal(pcmQuality.clippingSampleCount, 0);
});

test("resamples audio from 44100 Hz down to 16000 Hz with linear interpolation", () => {
  const inputLength = 4410; // 100ms at 44.1kHz
  const samples = new Float32Array(inputLength);
  for (let i = 0; i < inputLength; i++) {
    samples[i] = (i / (inputLength - 1)) * 2 - 1; // ramp from -1.0 to 1.0
  }

  const pcm = convertFloat32ToPcm16(samples, 44100);
  const expectedSamples = Math.round(4410 * (16000 / 44100)); // 1600
  assert.equal(pcm.byteLength, expectedSamples * 2);

  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  // First sample should be close to -32768, last sample close to 32767
  assert.ok(view.getInt16(0, true) <= -32000);
  assert.ok(view.getInt16((expectedSamples - 1) * 2, true) >= 32000);
});

test("resamples audio from 8000 Hz up to 16000 Hz", () => {
  const inputLength = 800; // 100ms at 8kHz
  const samples = new Float32Array(inputLength);
  for (let i = 0; i < inputLength; i++) {
    samples[i] = 0.25;
  }

  const pcm = convertFloat32ToPcm16(samples, 8000);
  assert.equal(pcm.byteLength, 1600 * 2);

  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  assert.equal(view.getInt16(0, true), Math.round(0.25 * 32767));
});

test("converts pure silence to all-zero PCM bytes", () => {
  const silence16k = new Float32Array(512);
  const pcm16k = convertFloat32ToPcm16(silence16k, 16000);
  assert.equal(pcm16k.byteLength, 1024);
  assert.ok(pcm16k.every((byte) => byte === 0));

  const silence48k = new Float32Array(1536);
  const pcm48k = convertFloat32ToPcm16(silence48k, 48000);
  assert.equal(pcm48k.byteLength, 1024);
  assert.ok(pcm48k.every((byte) => byte === 0));
});

test("resampleFloat32 returns same reference when sample rates match", () => {
  const samples = new Float32Array([0.1, 0.2, 0.3]);
  const result = resampleFloat32(samples, 16000, 16000);
  assert.equal(result, samples);
});

test("rejects invalid inputs with appropriate errors", () => {
  // Invalid samples type
  assert.throws(
    () => convertFloat32ToPcm16(null, 16000),
    TypeError,
  );
  assert.throws(
    () => convertFloat32ToPcm16([0.1, 0.2], 16000),
    TypeError,
  );
  assert.throws(
    () => float32ToPcm16(new Uint8Array(10)),
    TypeError,
  );

  // Empty samples
  assert.throws(
    () => convertFloat32ToPcm16(new Float32Array(0), 16000),
    RangeError,
  );
  assert.throws(
    () => float32ToPcm16(new Float32Array(0)),
    RangeError,
  );

  // Invalid input sample rates
  assert.throws(
    () => convertFloat32ToPcm16(new Float32Array([0.1]), 0),
    RangeError,
  );
  assert.throws(
    () => convertFloat32ToPcm16(new Float32Array([0.1]), -16000),
    RangeError,
  );
  assert.throws(
    () => convertFloat32ToPcm16(new Float32Array([0.1]), Number.NaN),
    RangeError,
  );

  // Invalid target sample rates
  assert.throws(
    () => convertFloat32ToPcm16(new Float32Array([0.1]), 48000, 0),
    RangeError,
  );
  assert.throws(
    () => convertFloat32ToPcm16(new Float32Array([0.1]), 48000, -1),
    RangeError,
  );
  assert.throws(
    () => resampleFloat32(new Float32Array([0.1]), 48000, Number.POSITIVE_INFINITY),
    RangeError,
  );
});

