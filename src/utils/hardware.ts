/**
 * System Hardware Detection
 *
 * Detects memory capabilities of the current machine so that provider
 * setup can recommend only the local LLM models that actually fit.
 *
 * Heuristics (rule of thumb: model weights + context/runtime overhead
 * must fit into memory usable by the inference engine):
 * - macOS (Apple Silicon): unified memory - GPU may wire up to ~75% of RAM
 * - Linux/Windows with NVIDIA GPU: dedicated VRAM is the binding constraint
 * - CPU-only fallback: conservative 50% of RAM (CPU inference is slow anyway)
 */

import os from 'os';
import { exec } from './exec.js';
import { logger } from './logger.js';

export interface SystemCapabilities {
  totalMemoryGb: number;      // Total physical RAM
  usableMemoryGb: number;     // Memory usable for model weights + runtime
  gpuMemoryGb?: number;       // Dedicated GPU VRAM, when detected (NVIDIA)
  platform: NodeJS.Platform;
}

// macOS unified memory: GPU can wire up to ~75% of RAM
const MACOS_MEMORY_FRACTION = 0.75;
// CPU-only / unknown GPU: conservative share of RAM for local inference
const FALLBACK_MEMORY_FRACTION = 0.5;

let cachedCapabilities: SystemCapabilities | undefined;

/**
 * Probe NVIDIA GPUs for dedicated VRAM via nvidia-smi.
 * Returns the largest single-GPU memory in GB, or undefined when no
 * NVIDIA GPU / driver is present.
 */
async function detectGpuMemoryGb(): Promise<number | undefined> {
  try {
    const result = await exec(
      'nvidia-smi',
      ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
      { timeout: 3000 }
    );

    if (result.code !== 0) {
      return undefined;
    }

    const valuesGb = result.stdout
      .trim()
      .split('\n')
      .map(line => parseFloat(line.trim()) / 1024) // MiB -> GiB
      .filter(value => !Number.isNaN(value));

    return valuesGb.length > 0 ? Math.max(...valuesGb) : undefined;
  } catch (error) {
    logger.debug('GPU detection skipped (nvidia-smi unavailable):', error);
    return undefined;
  }
}

/**
 * Detect system capabilities, including an async GPU probe.
 * Result is cached for the process lifetime; call this early in async
 * setup flows so later sync consumers (choice rendering) can use
 * getSystemCapabilities().
 */
export async function detectSystemCapabilities(): Promise<SystemCapabilities> {
  const totalMemoryGb = os.totalmem() / (1024 ** 3);
  const platform = os.platform();

  // macOS uses unified memory; probing for a discrete NVIDIA GPU is pointless
  const gpuMemoryGb = platform === 'darwin' ? undefined : await detectGpuMemoryGb();

  const usableMemoryGb = platform === 'darwin'
    ? totalMemoryGb * MACOS_MEMORY_FRACTION
    : (gpuMemoryGb ?? totalMemoryGb * FALLBACK_MEMORY_FRACTION);

  cachedCapabilities = { totalMemoryGb, usableMemoryGb, gpuMemoryGb, platform };
  return cachedCapabilities;
}

/**
 * Get system capabilities synchronously.
 * Returns the cached result of detectSystemCapabilities() when available,
 * otherwise computes RAM-only heuristics without GPU probing.
 */
export function getSystemCapabilities(): SystemCapabilities {
  if (!cachedCapabilities) {
    const totalMemoryGb = os.totalmem() / (1024 ** 3);
    const platform = os.platform();

    cachedCapabilities = {
      totalMemoryGb,
      usableMemoryGb: platform === 'darwin'
        ? totalMemoryGb * MACOS_MEMORY_FRACTION
        : totalMemoryGb * FALLBACK_MEMORY_FRACTION,
      platform
    };
  }

  return cachedCapabilities;
}

/**
 * Check whether a model with the given memory requirement fits the system
 */
export function modelFitsSystem(
  minMemoryGb: number,
  capabilities: SystemCapabilities = getSystemCapabilities()
): boolean {
  return minMemoryGb <= capabilities.usableMemoryGb;
}
