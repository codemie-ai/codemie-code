import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { getDirname } from '../utils/dirname.js';

export interface Tip {
  message: string;
  command?: string;
}

export class AsyncTipDisplay {
  private tips: Tip[] = [];
  private shownTips: Set<number> = new Set();
  private currentTipIndex: number = -1;
  private intervalId: NodeJS.Timeout | null = null;
  private isActive: boolean = false;
  private rotationInterval: number = 15000; // 15 seconds

  constructor() {
    this.loadTips();
  }

  /**
   * Load tips from JSON file
   */
  private loadTips(): void {
    try {
      const tipsPath = path.join(getDirname(import.meta.url), '../data/tips.json');
      const tipsData = fs.readFileSync(tipsPath, 'utf-8');
      this.tips = JSON.parse(tipsData);
    } catch {
      // Fallback tips if file can't be loaded
      this.tips = [
        { message: 'Run codemie list to see available agents', command: 'codemie list' },
        { message: 'Use codemie doctor to check your setup', command: 'codemie doctor' }
      ];
    }
  }

  /**
   * Get a random tip that hasn't been shown recently
   */
  private getRandomTip(): Tip | null {
    if (this.tips.length === 0) return null;

    const availableTips = this.tips
      .map((tip, index) => ({ tip, index }))
      .filter(({ index }) => !this.shownTips.has(index));

    // Reset if all tips have been shown
    if (availableTips.length === 0) {
      this.shownTips.clear();
      return this.getRandomTip();
    }

    const selected = availableTips[Math.floor(Math.random() * availableTips.length)];
    this.shownTips.add(selected.index);
    this.currentTipIndex = selected.index;

    return selected.tip;
  }

  /**
   * Format tip for display at bottom of terminal
   */
  private formatTip(tip: Tip): string {
    const separator = chalk.dim('─'.repeat(60));
    let output = '\n' + separator + '\n';
    output += chalk.cyan('💡 Tip: ') + chalk.white(tip.message) + '\n';
    if (tip.command) {
      output += chalk.gray('   → ') + chalk.blueBright(tip.command) + '\n';
    }
    output += separator;
    return output;
  }

  /**
   * Display a single tip immediately
   */
  showTip(tip?: Tip): void {
    const tipToShow = tip || this.getRandomTip();
    if (tipToShow) {
      console.log(this.formatTip(tipToShow));
    }
  }

  /**
   * Start rotating tips at the bottom of the terminal
   * Shows a new tip every N seconds
   */
  startRotating(intervalMs?: number): void {
    if (this.isActive) return;

    this.isActive = true;
    if (intervalMs) {
      this.rotationInterval = intervalMs;
    }

    // Show first tip immediately
    const firstTip = this.getRandomTip();
    if (firstTip) {
      this.showTip(firstTip);
    }

    // Rotate tips
    this.intervalId = setInterval(() => {
      if (!this.isActive) return;

      // Clear previous tip area (move up and clear lines)
      this.clearTipArea();

      // Show new tip
      const tip = this.getRandomTip();
      if (tip) {
        this.showTip(tip);
      }
    }, this.rotationInterval);
  }

  /**
   * Stop rotating tips
   */
  stopRotating(): void {
    this.isActive = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Clear the tip display area
   */
  private clearTipArea(): void {
    // Move cursor up 5 lines (tip area height) and clear them
    const linesToClear = 5;
    for (let i = 0; i < linesToClear; i++) {
      process.stdout.write('\x1b[1A'); // Move up
      process.stdout.write('\x1b[2K'); // Clear line
    }
  }

  /**
   * Display tips during a long-running operation
   * Returns a function to stop the tips when operation completes
   */
  showDuring(operation: Promise<unknown>): () => void {
    this.startRotating(10000); // Faster rotation during operations (10s)

    const stop = () => {
      this.stopRotating();
      // Don't clear the last tip - let it stay visible
    };

    // Auto-stop when operation completes
    operation.finally(() => {
      stop();
    });

    return stop;
  }

  /**
   * Show multiple tips in sequence (for startup)
   */
  showMultiple(count: number = 2): void {
    const tipsToShow: Tip[] = [];
    for (let i = 0; i < count && i < this.tips.length; i++) {
      const tip = this.getRandomTip();
      if (tip) {
        tipsToShow.push(tip);
      }
    }

    if (tipsToShow.length === 0) return;

    console.log();
    const separator = chalk.dim('─'.repeat(60));
    console.log(separator);

    tipsToShow.forEach((tip, index) => {
      console.log(chalk.cyan('💡 Tip:'), chalk.white(tip.message));
      if (tip.command) {
        console.log(chalk.gray('   →'), chalk.blueBright(tip.command));
      }
      if (index < tipsToShow.length - 1) {
        console.log(); // Spacing between tips
      }
    });

    console.log(separator);
    console.log();
  }

  /**
   * Show a tip at the bottom of the screen (non-rotating)
   */
  showAtBottom(): void {
    const tip = this.getRandomTip();
    if (tip) {
      // Get terminal height
      const terminalHeight = process.stdout.rows || 24;

      // Save cursor position
      process.stdout.write('\x1b7');

      // Move to bottom (2 lines from bottom for the tip)
      process.stdout.write(`\x1b[${terminalHeight - 3};0H`);

      // Show tip
      const separator = chalk.dim('─'.repeat(Math.min(60, process.stdout.columns || 80)));
      process.stdout.write(separator + '\n');
      process.stdout.write(chalk.cyan('💡 ') + chalk.white(tip.message));
      if (tip.command) {
        process.stdout.write(chalk.gray(' → ') + chalk.blueBright(tip.command));
      }
      process.stdout.write('\n' + separator);

      // Restore cursor position
      process.stdout.write('\x1b8');
    }
  }

  /**
   * Reset shown tips
   */
  reset(): void {
    this.shownTips.clear();
    this.currentTipIndex = -1;
  }
}

/**
 * Global async tip display instance
 */
export const asyncTipDisplay = new AsyncTipDisplay();
