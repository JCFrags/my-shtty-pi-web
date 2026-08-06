import type { Run } from "./run";

export type Direction = "right" | "left" | "down" | "up";

export interface Pane {
  id: string;
  tab: string;
}

export interface PaneContext {
  tty: string | null;
}

export interface SplitRequest {
  from: Pane;
  direction: Direction;
  command: string[];
  size: number | null;
  tty: string | null;
}

export interface Terminal {
  readonly name: string;
  readonly wrapper?: "tmux";
  readonly reportsCssPixels?: boolean;
  /**
   * allows code to be ran at startup, useful for preparing the terminal environment for terminal-browser
   */
  prepare?(): void;
  /**
   * Allows terminal-browser to know which pane its being called from inside the terminal.
   * This gives terminal-browser the ability to know if a terminal-browser instance
   * is open inside the terminal-pane, and powers features such as:
   * - terminal-browser ls lists the browers inside the current terminal tab
   * - terminal-browser tab [url] will open in the browser inside the current terminal tab by default
   */
  getCurrentPane?(context: PaneContext): Promise<Pane | null>;
  /**
   * This powers terminal-browser's --split argument. This is useful when using terminal-browser w/ coding agents
   * since it allows agents to open a browser next to their TUI without having to know how to 
   * script the current terminal they are running in
   * 
   */
  split?(request: SplitRequest): Promise<void>;
}

export type Detect = (env: NodeJS.ProcessEnv, run: Run) => Terminal | null;


export function canSplit(terminal: Terminal | null): boolean {
  return Boolean(terminal?.split);
}
