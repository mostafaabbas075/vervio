#!/usr/bin/env node

/**
 * Local-only WAV diagnostic for Vervio's Gemini microphone PCM path.
 *
 * This tool never opens a network connection or reads application settings.
 * It only processes the consented WAV file explicitly passed by the developer,
 * writes the requested converted WAV, and prints aggregate signal statistics.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import console from "node:console";
import process from "node:process";

const require = createRequire(import.meta.url);
const typescript = require("typescript");

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PCM_AUDIO_SOURCE_PATH = resolve(SCRIPT_DIRECTORY, "../lib/pcm-audio.ts");
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const CAPTURE_CHUNK_DURATION_MS = 50;

function loadProductionPcmModule() {
  const source = readFileSync(PCM_AUDIO_SOURCE_PATH, "utf8");
  const output = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    },
  }).outputText;
  const compiledModule = { exports: {} };
  new Function("exports", "require", "module", output)(
    compiledModule.exports,
    require,
    compiledModule,
  );
  return compiledModule.exports;
}

const {
  TARGET_PCM_SAMPLE_RATE,
  convertFloat32ToPcm16,
  measureFloat32AudioQuality,
  measurePcm16AudioQuality,
} = loadProductionPcmModule();

function requireRange(buffer, offset, byteLength, description) {
  if (offset < 0 || byteLength < 0 || offset + byteLength > buffer.length) {
    throw new Error(`Invalid WAV: ${description} exceeds the file length.`);
  }
}

export function parsePcm16Wav(wavBytes) {
  const buffer = Buffer.from(wavBytes);
  requireRange(buffer, 0, 12, "RIFF header");
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Only RIFF/WAVE files are supported.");
  }

  let format = null;
  let data = null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    requireRange(buffer, chunkStart, chunkSize, `${chunkId} chunk`);
    if (chunkId === "fmt " && format === null) {
      requireRange(buffer, chunkStart, 16, "fmt chunk");
      format = {
        audioFormat: buffer.readUInt16LE(chunkStart),
        channels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        byteRate: buffer.readUInt32LE(chunkStart + 8),
        blockAlign: buffer.readUInt16LE(chunkStart + 12),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14),
      };
    }
    if (chunkId === "data" && data === null) {
      data = Buffer.from(buffer.subarray(chunkStart, chunkStart + chunkSize));
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (!format || !data) {
    throw new Error("WAV must include both fmt and data chunks.");
  }
  if (format.audioFormat !== 1 || format.bitsPerSample !== 16) {
    throw new Error("Only PCM integer 16-bit WAV input is supported.");
  }
  if (format.channels < 1 || format.channels > 2) {
    throw new Error("Only mono or stereo WAV input is supported.");
  }
  const expectedBlockAlign = format.channels * 2;
  if (format.blockAlign !== expectedBlockAlign || data.length % expectedBlockAlign !== 0) {
    throw new Error("WAV PCM16 frame alignment is invalid.");
  }
  if (!Number.isFinite(format.sampleRate) || format.sampleRate <= 0) {
    throw new Error("WAV sample rate is invalid.");
  }

  // The browser worklet consumes channel 0, so stereo diagnostic input uses
  // that same channel rather than applying a different downmix policy.
  const frameCount = data.length / expectedBlockAlign;
  const channelZeroSamples = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    channelZeroSamples[frame] = data.readInt16LE(frame * expectedBlockAlign) / 32_768;
  }

  return {
    sampleRate: format.sampleRate,
    channels: format.channels,
    sourceFrameCount: frameCount,
    channelZeroSamples,
  };
}

export function convertCaptureChunks(samples, sampleRate) {
  const sourceFramesPerChunk = Math.max(
    1,
    Math.round(sampleRate * (CAPTURE_CHUNK_DURATION_MS / 1000)),
  );
  const chunks = [];
  let totalBytes = 0;
  for (let offset = 0; offset < samples.length; offset += sourceFramesPerChunk) {
    // This is deliberately the same conversion call made by GeminiAudioClient
    // for each AudioWorklet capture callback.
    const pcmChunk = convertFloat32ToPcm16(
      samples.subarray(offset, offset + sourceFramesPerChunk),
      sampleRate,
      TARGET_PCM_SAMPLE_RATE,
    );
    chunks.push(pcmChunk);
    totalBytes += pcmChunk.byteLength;
  }

  const pcmBytes = new Uint8Array(totalBytes);
  let destinationOffset = 0;
  for (const chunk of chunks) {
    pcmBytes.set(chunk, destinationOffset);
    destinationOffset += chunk.byteLength;
  }
  return {
    pcmBytes,
    captureChunkCount: chunks.length,
    sourceFramesPerChunk,
  };
}

export function createPcm16MonoWav(pcmBytes, sampleRate = TARGET_PCM_SAMPLE_RATE) {
  if (!(pcmBytes instanceof Uint8Array) || pcmBytes.byteLength % 2 !== 0) {
    throw new Error("PCM output must contain complete 16-bit samples.");
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcmBytes.byteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM integer
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcmBytes.byteLength, 40);
  return Buffer.concat([header, Buffer.from(pcmBytes)]);
}

export function convertWavBufferForGemini(wavBytes) {
  const input = parsePcm16Wav(wavBytes);
  const converted = convertCaptureChunks(input.channelZeroSamples, input.sampleRate);
  const outputWav = createPcm16MonoWav(converted.pcmBytes, TARGET_PCM_SAMPLE_RATE);
  const output = parsePcm16Wav(outputWav);
  const sourceDurationSeconds = input.sourceFrameCount / input.sampleRate;
  const outputDurationSeconds = output.sourceFrameCount / TARGET_PCM_SAMPLE_RATE;
  const sourceQuality = measureFloat32AudioQuality(input.channelZeroSamples);
  const pcmQuality = measurePcm16AudioQuality(converted.pcmBytes);

  return {
    outputWav,
    metrics: {
      input: {
        sampleRate: input.sampleRate,
        channels: input.channels,
        frameCount: input.sourceFrameCount,
        durationMs: Math.round(sourceDurationSeconds * 1000),
        rms: roundMetric(sourceQuality.rms),
        peak: roundMetric(sourceQuality.peak),
        zeroSampleRatio: ratio(sourceQuality.zeroSampleCount, sourceQuality.sampleCount),
        clippingRatio: ratio(sourceQuality.clippingSampleCount, sourceQuality.sampleCount),
      },
      output: {
        sampleRate: TARGET_PCM_SAMPLE_RATE,
        channels: 1,
        bitDepth: 16,
        endianness: "little",
        frameCount: output.sourceFrameCount,
        durationMs: Math.round(outputDurationSeconds * 1000),
        rms: roundMetric(pcmQuality.rms),
        peak: roundMetric(pcmQuality.peak),
        zeroSampleRatio: ratio(pcmQuality.zeroSampleCount, pcmQuality.sampleCount),
        clippingRatio: ratio(pcmQuality.clippingSampleCount, pcmQuality.sampleCount),
        completePcm16Frames: converted.pcmBytes.byteLength % 2 === 0,
      },
      conversion: {
        captureChunkDurationMs: CAPTURE_CHUNK_DURATION_MS,
        sourceFramesPerChunk: converted.sourceFramesPerChunk,
        captureChunkCount: converted.captureChunkCount,
        durationDifferenceMs: roundMetric(
          Math.abs(outputDurationSeconds - sourceDurationSeconds) * 1000,
        ),
      },
    },
  };
}

function ratio(numerator, denominator) {
  return denominator > 0 ? roundMetric(numerator / denominator) : 0;
}

function roundMetric(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function parseArguments(argv) {
  let inputPath = null;
  let outputPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--input" || argument === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a file path.`);
      }
      if (argument === "--input") inputPath = resolve(value);
      if (argument === "--output") outputPath = resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return { help: true };
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!inputPath || !outputPath) {
    throw new Error("Both --input and --output are required.");
  }
  if (inputPath === outputPath) {
    throw new Error("--output must be different from --input.");
  }
  if (extname(inputPath).toLowerCase() !== ".wav" || extname(outputPath).toLowerCase() !== ".wav") {
    throw new Error("Input and output paths must use the .wav extension.");
  }
  return { help: false, inputPath, outputPath };
}

function printUsage() {
  console.log(
    "Usage: npm run diagnose:pcm -- --input C:\\consented\\speech.wav --output C:\\consented\\speech.vervio-16khz.wav",
  );
}

export function runLocalDiagnostic({ inputPath, outputPath }) {
  const inputInfo = statSync(inputPath);
  if (!inputInfo.isFile()) {
    throw new Error("--input must point to a WAV file.");
  }
  if (inputInfo.size > MAX_INPUT_BYTES) {
    throw new Error("Input WAV exceeds the 64 MiB local diagnostic limit.");
  }
  const outputDirectory = statSync(dirname(outputPath));
  if (!outputDirectory.isDirectory()) {
    throw new Error("The --output directory does not exist.");
  }

  const { outputWav, metrics } = convertWavBufferForGemini(readFileSync(inputPath));
  writeFileSync(outputPath, outputWav, { flag: "wx" });
  return {
    inputPath,
    outputPath,
    metrics,
  };
}

function main() {
  try {
    const argumentsResult = parseArguments(process.argv.slice(2));
    if (argumentsResult.help) {
      printUsage();
      return;
    }
    const result = runLocalDiagnostic(argumentsResult);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(
      `PCM local diagnostic failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
