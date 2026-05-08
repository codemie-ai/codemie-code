import chalk from 'chalk';

export interface StorageScopeOptions {
  title?: string;
  localNote?: string;
}

export async function promptStorageScope({
  title = 'Where would you like to save configuration?',
  localNote = 'Project-scoped configuration will override global ones for this repository.',
}: StorageScopeOptions = {}): Promise<'global' | 'local'> {
  const ANSI = {
    CLEAR_SCREEN: '\x1B[2J\x1B[H',
    HIDE_CURSOR: '\x1B[?25l',
    SHOW_CURSOR: '\x1B[?25h',
  } as const;

  const KEY = {
    UP: '\x1B[A',
    DOWN: '\x1B[B',
    ENTER: '\r',
    ESC: '\x1B',
    CTRL_C: '\x03',
  } as const;

  const choices = ['global', 'local'] as const;
  let selectedIndex = 0;

  function renderUI(): string {
    const lines: string[] = [
      '',
      `  ${title}`,
      '',
    ];

    choices.forEach((choice, i) => {
      const marker = i === selectedIndex ? chalk.cyan('●') : chalk.dim('○');
      const label = choice === 'global'
        ? `${chalk.cyan('Global')} ${chalk.dim('Global (~/.codemie/) - Available across all projects')}`
        : `${chalk.yellow('Local')} ${chalk.dim('Local (.codemie/) - Only for this project')}`;
      lines.push(`  ${marker} ${label}`);
    });

    lines.push('');
    lines.push(chalk.dim('  ↑↓ Navigate   Enter Confirm'));

    if (selectedIndex === 1) {
      lines.push('');
      lines.push(chalk.dim(`  ${localNote}`));
    }

    lines.push('');
    return lines.join('\n');
  }

  return new Promise((resolve) => {
    let keepAliveTimer: NodeJS.Timeout | null = null;

    function cleanup() {
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeAllListeners('data');
      process.stdout.write(ANSI.SHOW_CURSOR + ANSI.CLEAR_SCREEN);
    }

    function stop(choice: 'global' | 'local') {
      cleanup();
      resolve(choice);
    }

    function render() {
      process.stdout.write(ANSI.CLEAR_SCREEN + ANSI.HIDE_CURSOR + renderUI());
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (key: string) => {
      switch (key) {
        case KEY.UP:
          selectedIndex = Math.max(0, selectedIndex - 1);
          render();
          break;
        case KEY.DOWN:
          selectedIndex = Math.min(choices.length - 1, selectedIndex + 1);
          render();
          break;
        case KEY.ENTER:
          stop(choices[selectedIndex]);
          break;
        case KEY.ESC:
        case KEY.CTRL_C:
          stop('global');
          break;
      }
    });

    keepAliveTimer = setInterval(() => {}, 60000);
    render();
  });
}
