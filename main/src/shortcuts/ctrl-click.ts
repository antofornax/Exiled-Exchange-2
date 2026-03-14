import process from "process";
import { execSync } from "child_process";
import { uIOhook, UiohookKey as Key } from "uiohook-napi";
import type { OverlayWindow } from "../windowing/OverlayWindow";
import type { HostClipboard } from "./HostClipboard";

const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Focus the game window and simulate Ctrl+Left Click.
 * If position is provided, moves the cursor there first (e.g. back to the item).
 * If options.price is set, after the click types the price (paste) and Enter.
 * On Linux uses one chained xdotool command so the game sees a single coherent
 * Ctrl+click. Uses X11 key name "control" and longer sleeps so the game registers input.
 * Used by the "Auto sell item" button.
 * Position is rounded to nearest pixel once here so the click is within 1px of intended (≤5px spec).
 */
export function ctrlLeftClick(
  overlay: OverlayWindow,
  position?: { x: number; y: number },
  options?: { price?: string; clipboard: HostClipboard },
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

    if (options?.price != null && options.price.length > 0 && options.clipboard) {
      await delay(350);
      const modifier =
        process.platform === "darwin" ? Key.Meta : Key.Ctrl;
      options.clipboard.restoreShortly((clipboard) => {
        clipboard.writeText(options.price!);
        uIOhook.keyTap(Key.V, [modifier]);
      });
      // Small random delay before Enter for more human-like behavior (e.g. 60–180 ms)
      await delay(60 + Math.random() * 120);
      uIOhook.keyTap(Key.Enter);
    }
  })().catch(() => {});
}
