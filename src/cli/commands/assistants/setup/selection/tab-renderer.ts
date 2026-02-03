import chalk from 'chalk';
import type { SelectionState, TabState, TabId } from './tab-types.js';

export class TabRenderer {
  /**
   * Clear screen and render full UI
   */
  render(state: SelectionState): void {
    console.clear(); // Cross-platform screen clear

    this.renderTabHeader(state.tabs, state.activeTabId);
    this.renderSearchInput(state.searchQuery);
    this.renderActiveTabStatus(state);
  }

  /**
   * Render tab navigation header
   */
  private renderTabHeader(tabs: TabState[], activeId: TabId): void {
    const tabStrings = tabs.map(tab => {
      if (tab.id === activeId) {
        return chalk.cyan.bold(`[${tab.label}]`);
      }
      return chalk.dim(`[${tab.label}]`);
    });

    console.log('\n' + tabStrings.join('  '));
    console.log(chalk.dim('Use → Next Tab / ← Previous Tab to navigate\n'));
  }

  /**
   * Render search input display
   */
  private renderSearchInput(query: string): void {
    const display = query || chalk.dim('(empty - showing all)');
    console.log(chalk.white('Search: ') + display + '\n');
  }

  /**
   * Render status line with counts and loading/error states
   */
  private renderActiveTabStatus(state: SelectionState): void {
    const activeTab = state.tabs.find(t => t.id === state.activeTabId)!;

    if (activeTab.isFetching) {
      console.log(chalk.yellow('Loading...\n'));
      return;
    }

    if (activeTab.error) {
      console.log(chalk.red(`Error: ${activeTab.error}\n`));
      return;
    }

    const showing = Math.min(5, activeTab.filteredData.length);
    const total = activeTab.data?.length || 0;

    console.log(chalk.dim(`\nShowing ${showing} of ${total}`));
    if (activeTab.filteredData.length > 5) {
      console.log(chalk.dim('Use search to filter results\n'));
    }
  }

  /**
   * Render empty state message for tabs with no data
   */
  renderEmptyState(_tabId: TabId): void {
    console.log(chalk.yellow('\nNo assistants found in this tab.'));
    console.log(chalk.dim('• Try switching to another tab'));
    console.log(chalk.dim('• Or adjust your search filter\n'));
  }
}
