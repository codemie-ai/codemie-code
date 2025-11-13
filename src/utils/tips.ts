import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { getDirname } from '../utils/dirname.js';

export interface Tip {
  message: string;
  command?: string;
}

/**
 * Load tips from JSON file
 */
function loadTipsFromFile(): Tip[] {
  try {
    const tipsPath = path.join(getDirname(import.meta.url), '../data/tips.json');
    const tipsData = fs.readFileSync(tipsPath, 'utf-8');
    return JSON.parse(tipsData);
  } catch {
    // Fallback tips if file can't be loaded
    return [
      { message: 'Run codemie list to see available agents', command: 'codemie list' },
      { message: 'Use codemie doctor to check your setup', command: 'codemie doctor' }
    ];
  }
}

export const TIPS: Tip[] = loadTipsFromFile();

export class TipDisplay {
  private shownTips: Set<number> = new Set();
  private tips: Tip[];

  constructor(tips: Tip[] = TIPS) {
    this.tips = tips;
  }

  /**
   * Get a random tip that hasn't been shown yet
   */
  getRandomTip(): Tip | null {
    const availableTips = this.tips.filter((_, index) => !this.shownTips.has(index));

    if (availableTips.length === 0) {
      // Reset if all tips have been shown
      this.shownTips.clear();
      return null;
    }

    const randomIndex = Math.floor(Math.random() * availableTips.length);
    const tip = availableTips[randomIndex];

    // Mark this tip as shown
    const originalIndex = this.tips.indexOf(tip);
    this.shownTips.add(originalIndex);

    return tip;
  }

  /**
   * Display a formatted tip
   */
  displayTip(tip: Tip): void {
    console.log(chalk.dim('─'.repeat(60)));
    console.log(chalk.cyan('💡 Tip:'), chalk.white(tip.message));
    if (tip.command) {
      console.log(chalk.gray('   →'), chalk.blueBright(tip.command));
    }
    console.log(chalk.dim('─'.repeat(60)));
  }

  /**
   * Display a random tip
   */
  showRandomTip(): void {
    const tip = this.getRandomTip();
    if (tip) {
      this.displayTip(tip);
    }
  }

  /**
   * Display multiple tips at startup
   */
  showStartupTips(count: number = 2): void {
    console.log();
    for (let i = 0; i < count && i < this.tips.length; i++) {
      const tip = this.getRandomTip();
      if (tip) {
        this.displayTip(tip);
        if (i < count - 1) {
          console.log(); // Add spacing between tips
        }
      }
    }
    console.log();
  }

  /**
   * Reset shown tips
   */
  reset(): void {
    this.shownTips.clear();
  }
}

/**
 * Global tip display instance
 */
export const tipDisplay = new TipDisplay();
