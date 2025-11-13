/**
 * Cross-platform clipboard utility for handling images
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { platform } from 'os';

const execAsync = promisify(exec);

export interface ClipboardImage {
  data: string; // base64 encoded image data
  mimeType: string; // e.g., 'image/png', 'image/jpeg'
}

/**
 * Check if clipboard contains image data (cross-platform)
 */
export async function hasClipboardImage(): Promise<boolean> {
  try {
    const platformName = platform();

    switch (platformName) {
      case 'darwin': // macOS
        return await hasClipboardImageMacOS();
      case 'win32': // Windows
        return await hasClipboardImageWindows();
      case 'linux': // Linux
        return await hasClipboardImageLinux();
      default:
        console.warn(`Clipboard image detection not implemented for platform: ${platformName}`);
        return false;
    }
  } catch (error) {
    console.error('Error checking clipboard for images:', error);
    return false;
  }
}

/**
 * Get clipboard image data (cross-platform)
 */
export async function getClipboardImage(): Promise<ClipboardImage | null> {
  try {
    const platformName = platform();

    switch (platformName) {
      case 'darwin': // macOS
        return await getClipboardImageMacOS();
      case 'win32': // Windows
        return await getClipboardImageWindows();
      case 'linux': // Linux
        return await getClipboardImageLinux();
      default:
        console.warn(`Clipboard image extraction not implemented for platform: ${platformName}`);
        return null;
    }
  } catch (error) {
    console.error('Error getting clipboard image:', error);
    return null;
  }
}

// macOS implementation
async function hasClipboardImageMacOS(): Promise<boolean> {
  try {
    const { stdout } = await execAsync('osascript -e "tell application \\"System Events\\" to set theTypes to clipboard info"');
    const types = stdout.trim();

    // Check for image types in clipboard
    return types.includes('«class PNGf»') ||
           types.includes('«class JPEG»') ||
           types.includes('«class TIFF»') ||
           types.includes('public.png') ||
           types.includes('public.jpeg');
  } catch {
    return false;
  }
}

async function getClipboardImageMacOS(): Promise<ClipboardImage | null> {
  try {
    // Try PNG first using AppleScript (more reliable for screenshots)
    let result = await execAsync('osascript -e "set theData to the clipboard as «class PNGf»" -e "return theData" 2>/dev/null | xxd -p -c 256 | tr -d \'\\n\' | xxd -r -p | base64', { maxBuffer: 10 * 1024 * 1024 });
    if (result.stdout.trim().length > 100) {
      return {
        data: result.stdout.trim(),
        mimeType: 'image/png'
      };
    }

    // Try JPEG if PNG failed
    result = await execAsync('osascript -e "set theData to the clipboard as «class JPEG»" -e "return theData" 2>/dev/null | xxd -p -c 256 | tr -d \'\\n\' | xxd -r -p | base64', { maxBuffer: 10 * 1024 * 1024 });
    if (result.stdout.trim().length > 100) {
      return {
        data: result.stdout.trim(),
        mimeType: 'image/jpeg'
      };
    }

    // Fallback to pbpaste with TIFF (screenshots are often stored as TIFF internally)
    result = await execAsync('pbpaste -Prefer public.tiff 2>/dev/null | base64', { maxBuffer: 10 * 1024 * 1024 });
    if (result.stdout.trim().length > 100) {
      return {
        data: result.stdout.trim(),
        mimeType: 'image/tiff'  // Note: this might need conversion for some LLMs
      };
    }

    return null;
  } catch {
    return null;
  }
}

// Windows implementation
async function hasClipboardImageWindows(): Promise<boolean> {
  try {
    const { stdout } = await execAsync('powershell -command "Get-Clipboard -Format Image -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count"');
    return parseInt(stdout.trim()) > 0;
  } catch {
    return false;
  }
}

async function getClipboardImageWindows(): Promise<ClipboardImage | null> {
  try {
    // Save clipboard image to temp file, then read as base64
    const tempFile = `${process.env.TEMP || '/tmp'}/clipboard_image_${Date.now()}.png`;
    await execAsync(`powershell -command "Get-Clipboard -Format Image | ForEach-Object { $_.Save('${tempFile}', [System.Drawing.Imaging.ImageFormat]::Png) }"`);

    const { stdout } = await execAsync(`powershell -command "[Convert]::ToBase64String([IO.File]::ReadAllBytes('${tempFile}'))"`);

    // Clean up temp file
    try {
      await execAsync(`del "${tempFile}"`);
    } catch {
      // Ignore cleanup errors
    }

    if (stdout.trim().length > 100) {
      return {
        data: stdout.trim(),
        mimeType: 'image/png'
      };
    }

    return null;
  } catch {
    return null;
  }
}

// Linux implementation
async function hasClipboardImageLinux(): Promise<boolean> {
  try {
    // Check if xclip is available and clipboard has image
    const { stdout } = await execAsync('xclip -selection clipboard -t TARGETS -o 2>/dev/null');
    return stdout.includes('image/png') || stdout.includes('image/jpeg');
  } catch {
    // Try with xsel as fallback
    try {
      await execAsync('xsel --clipboard --output 2>/dev/null | file - | grep -q image');
      return true;
    } catch {
      return false;
    }
  }
}

async function getClipboardImageLinux(): Promise<ClipboardImage | null> {
  try {
    // Try PNG first
    let result = await execAsync('xclip -selection clipboard -t image/png -o 2>/dev/null | base64 -w 0', { maxBuffer: 10 * 1024 * 1024 });
    if (result.stdout.trim().length > 100) {
      return {
        data: result.stdout.trim(),
        mimeType: 'image/png'
      };
    }

    // Try JPEG
    result = await execAsync('xclip -selection clipboard -t image/jpeg -o 2>/dev/null | base64 -w 0', { maxBuffer: 10 * 1024 * 1024 });
    if (result.stdout.trim().length > 100) {
      return {
        data: result.stdout.trim(),
        mimeType: 'image/jpeg'
      };
    }

    return null;
  } catch {
    return null;
  }
}