export const TARGET_PCM_SAMPLE_RATE = 16000;

export type AudioSignalQuality = {
  sampleCount: number;
  rms: number;
  peak: number;
  zeroSampleCount: number;
  clippingSampleCount: number;
};

const PCM16_SCALE = 32_768;
const NEAR_ZERO_SAMPLE_THRESHOLD = 1 / PCM16_SCALE;
const CLIPPING_SAMPLE_THRESHOLD = 0.99;

/**
 * Return aggregate signal quality for diagnostics without retaining samples.
 * Values are normalized to the PCM16 range and are safe to report as counters.
 */
export function measureFloat32AudioQuality(samples: Float32Array): AudioSignalQuality {
  if (!(samples instanceof Float32Array)) {
    throw new TypeError("Audio samples must be a Float32Array");
  }

  let sumOfSquares = 0;
  let peak = 0;
  let zeroSampleCount = 0;
  let clippingSampleCount = 0;
  for (const rawSample of samples) {
    const sample = Number.isFinite(rawSample)
      ? Math.max(-1, Math.min(1, rawSample))
      : 0;
    const magnitude = Math.abs(sample);
    sumOfSquares += sample * sample;
    peak = Math.max(peak, magnitude);
    if (magnitude < NEAR_ZERO_SAMPLE_THRESHOLD) {
      zeroSampleCount += 1;
    }
    if (magnitude >= CLIPPING_SAMPLE_THRESHOLD) {
      clippingSampleCount += 1;
    }
  }

  return {
    sampleCount: samples.length,
    rms: samples.length > 0 ? Math.sqrt(sumOfSquares / samples.length) : 0,
    peak,
    zeroSampleCount,
    clippingSampleCount,
  };
}

/**
 * Inspect PCM16 little-endian signal quality without exposing its audio data.
 */
export function measurePcm16AudioQuality(pcmBytes: Uint8Array): AudioSignalQuality {
  if (!(pcmBytes instanceof Uint8Array)) {
    throw new TypeError("PCM audio must be a Uint8Array");
  }
  if (pcmBytes.byteLength % 2 !== 0) {
    throw new RangeError("PCM audio must contain complete 16-bit samples");
  }

  let sumOfSquares = 0;
  let peak = 0;
  let zeroSampleCount = 0;
  let clippingSampleCount = 0;
  const data = new DataView(
    pcmBytes.buffer,
    pcmBytes.byteOffset,
    pcmBytes.byteLength,
  );
  const sampleCount = pcmBytes.byteLength / 2;
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = data.getInt16(index * 2, true) / PCM16_SCALE;
    const magnitude = Math.abs(sample);
    sumOfSquares += sample * sample;
    peak = Math.max(peak, magnitude);
    if (magnitude < NEAR_ZERO_SAMPLE_THRESHOLD) {
      zeroSampleCount += 1;
    }
    if (magnitude >= CLIPPING_SAMPLE_THRESHOLD) {
      clippingSampleCount += 1;
    }
  }

  return {
    sampleCount,
    rms: sampleCount > 0 ? Math.sqrt(sumOfSquares / sampleCount) : 0,
    peak,
    zeroSampleCount,
    clippingSampleCount,
  };
}

/**
 * Resamples a mono Float32 audio buffer from inputSampleRate to targetSampleRate
 * using linear interpolation.
 */
export function resampleFloat32(
  samples: Float32Array,
  inputSampleRate: number,
  targetSampleRate: number,
): Float32Array {
  if (!(samples instanceof Float32Array)) {
    throw new TypeError("Audio samples must be a Float32Array");
  }
  if (samples.length === 0) {
    throw new RangeError("Audio samples must not be empty");
  }
  if (!Number.isFinite(inputSampleRate) || inputSampleRate <= 0) {
    throw new RangeError("Input sample rate must be a positive finite number");
  }
  if (!Number.isFinite(targetSampleRate) || targetSampleRate <= 0) {
    throw new RangeError("Target sample rate must be a positive finite number");
  }

  if (inputSampleRate === targetSampleRate) {
    return samples;
  }

  const ratio = inputSampleRate / targetSampleRate;
  const outputLength = Math.max(
    1,
    Math.round(samples.length * (targetSampleRate / inputSampleRate)),
  );
  const output = new Float32Array(outputLength);
  const maxInputIndex = samples.length - 1;

  for (let i = 0; i < outputLength; i++) {
    const position = i * ratio;
    const baseIndex = Math.floor(position);
    const nextIndex = Math.min(baseIndex + 1, maxInputIndex);
    const fraction = position - baseIndex;

    const s0 = samples[baseIndex];
    const s1 = samples[nextIndex];
    output[i] = s0 + fraction * (s1 - s0);
  }

  return output;
}

/**
 * Converts mono Float32 audio samples in the range [-1.0, 1.0]
 * to signed 16-bit little-endian PCM bytes (Uint8Array).
 */
export function float32ToPcm16(samples: Float32Array): Uint8Array {
  if (!(samples instanceof Float32Array)) {
    throw new TypeError("Audio samples must be a Float32Array");
  }
  if (samples.length === 0) {
    throw new RangeError("Audio samples must not be empty");
  }

  const output = new Uint8Array(samples.length * 2);
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);

  for (let i = 0; i < samples.length; i++) {
    const raw = samples[i];
    // Sanitize non-finite numbers (NaN, Infinity) to silence (0)
    const clamped = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
    const int16 =
      clamped < 0
        ? Math.max(-32768, Math.round(clamped * 32768))
        : Math.min(32767, Math.round(clamped * 32767));

    view.setInt16(i * 2, int16, true);
  }

  return output;
}

/**
 * Converts mono Float32 audio samples to signed 16-bit little-endian PCM at 16000 Hz,
 * resampling when the source sample rate differs from the target rate.
 */
export function convertFloat32ToPcm16(
  samples: Float32Array,
  sampleRate: number,
  targetSampleRate: number = TARGET_PCM_SAMPLE_RATE,
): Uint8Array {
  if (!(samples instanceof Float32Array)) {
    throw new TypeError("Audio samples must be a Float32Array");
  }
  if (samples.length === 0) {
    throw new RangeError("Audio samples must not be empty");
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError("Sample rate must be a positive finite number");
  }
  if (!Number.isFinite(targetSampleRate) || targetSampleRate <= 0) {
    throw new RangeError("Target sample rate must be a positive finite number");
  }

  const resampled =
    sampleRate === targetSampleRate
      ? samples
      : resampleFloat32(samples, sampleRate, targetSampleRate);

  return float32ToPcm16(resampled);
}

