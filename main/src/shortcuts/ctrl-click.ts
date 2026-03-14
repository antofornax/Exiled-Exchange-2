import { execSync } from "child_process";
import type { OverlayWindow } from "../windowing/OverlayWindow";

const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Focus the game window and simulate Ctrl+Left Click.
 * If position is provided, moves the cursor there first (e.g. back to the item).
 * On Linux uses one chained xdotool command so the game sees a single coherent
 * Ctrl+click. Uses X11 key name "control" and longer sleeps so the game registers input.
 * Used by the "Auto sell item" button.
 * Position is rounded to nearest pixel once here so the click is within 1px of intended (≤5px spec).
 */
export function ctrlLeftClick(
  overlay: OverlayWindow,
  position?: { x: number; y: number },
): void {
  (async () => {
    overlay.assertGameActive();
    await delay(120);

    if (process.platform === "linux") {
      // Single rounding here; position is already in screen pixels from main.
      const x = position ? Math.round(position.x) : "";
      const y = position ? Math.round(position.y) : "";
      const movePart =
        x !== "" && y !== ""
          ? `mousemove --sync ${x} ${y} sleep 0.2 `
          : "";
      const cmd = `xdotool ${movePart}keydown control sleep 0.15 click 1 sleep 0.1 keyup control`;
      execSync(cmd, { stdio: "ignore", timeout: 2000 });
    }
    // TODO: Windows/macOS - use platform-specific input simulation
  })().catch(() => {});
}
