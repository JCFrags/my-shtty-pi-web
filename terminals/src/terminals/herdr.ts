import { shellQuote } from "../shared";
import type { Detect, Direction } from "../terminal";

interface HerdrPaneSplitResult {
  result: { pane: { pane_id: string } };
}

const NATIVE_DIRECTION: Record<Direction, "right" | "down"> = {
  right: "right",
  left: "right",
  down: "down",
  up: "down",
};

const OPPOSITE: Record<"right" | "down", "left" | "up"> = { right: "left", down: "up" };

export const herdr: Detect = (env, run) => {
  if (!env.HERDR_PANE_ID) return null;

  const bin = env.HERDR_BIN_PATH || "herdr";
  const herdr = (args: string[]) => run(bin, args);

  async function splitPane(args: string[]): Promise<HerdrPaneSplitResult> {
    try {
      return JSON.parse(await herdr(["pane", "split", ...args, "--right-click", "pane"]));
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      if (!stderr.includes("--right-click")) throw error;
      return JSON.parse(await herdr(["pane", "split", ...args]));
    }
  }

  return {
    name: "herdr",
    getCurrentPane: async () => ({ id: env.HERDR_PANE_ID!, tab: env.HERDR_TAB_ID! }),
    async split({ from, direction, command, size }) {
      const native = NATIVE_DIRECTION[direction];
      const ratio = size ? ["--ratio", String(size)] : [];
      const { result } = await splitPane(["--pane", from.id, "--direction", native, "--focus", ...ratio]);
      const newPaneId = result.pane.pane_id;
      if (direction === "left" || direction === "up") {
        await herdr(["pane", "swap", "--pane", newPaneId, "--direction", OPPOSITE[native]]);
      }
      await herdr(["pane", "run", newPaneId, shellQuote(command)]);
    },
  };
};
