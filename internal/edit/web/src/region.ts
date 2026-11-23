// The contract between the shell (main.ts) and the six regions. Each region
// directory exports `mount: Region` from its index.ts. main.ts calls every
// mount once, after the first model has loaded, with an empty root element the
// region owns for the page's lifetime.
import type { Store } from './store';

/** What the shell offers regions besides the store. */
export interface Shell {
  /** Speaks text through the page's polite live region. The shell already announces receipts, refusals, holds, and error counts. */
  announce(text: string): void;
  /**
   * Moves the rule detail (the sheet and code roots, together) into `host`, or
   * back to the Rule column when `host` is undefined. The list region calls it
   * in the narrow layout to open the detail under the selected rule. Moving
   * a subtree blurs whatever has focus inside it, so call it only when the
   * selected rule or the layout changes, never on an ordinary rerender.
   */
  placeRuleDetail(host?: HTMLElement): void;
}

/**
 * Mounts a region into `root`. The region subscribes with `store.watch`,
 * renders into `root` only, sends input to store actions, and never touches
 * another region's DOM. It must obey the focus rule in README.md.
 */
export type Region = (root: HTMLElement, store: Store, shell: Shell) => void;
