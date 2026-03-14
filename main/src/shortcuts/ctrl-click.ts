import process from "process";
import { execSync } from "child_process";
import { uIOhook, UiohookKey as Key } from "uiohook-napi";
import type { OverlayWindow } from "../windowing/OverlayWindow";
import type { HostClipboard } from "./HostClipboard";

const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Random delay 30–80 ms between actions for more human-like behavior. */
const smallDelay = () => delay(30 + Math.random() * 50);

type AutoSellCurrency = "annulment" | "divine" | "exalted" | "chaos";

/** Screen positions for currency selection (game UI). */
const CURRENCY_CLICKS = {
  dropdown: { x: 2343, y: 1805 },
  exalted: { x: 2294, y: 1835 },
  divine: { x: 2336, y: 1915 },
  chaos: { x: 2325, y: 1937 },
  annulment: { x: 2339, y: 2048 },
  priceBox: { x: 2194, y: 1810 },
} as const;

function clickAt(x: number, y: number) {
  if (process.platform !== "linux") return;
  execSync(`xdotool mousemove --sync ${Math.round(x)} ${Math.round(y)} sleep 0.12 click 1 sleep 0.15`, {
    stdio: "ignore",
    timeout: 2000,
  });
}

/**
 * Focus the game window and simulate Ctrl+Left Click.
 * If position is provided, moves the cursor there first (e.g. back to the item).
 * If options.currency is set, after the ctrl+click runs: click dropdown → click currency option → click price box.
 * If options.price is set, after that types the price (paste) and Enter.
 * On Linux uses one chained xdotool command so the game sees a single coherent
 * Ctrl+click. Uses X11 key name "control" and longer sleeps so the game registers input.
 * Used by the "Auto sell item" button.
 * Position is rounded to nearest pixel once here so the click is within 1px of intended (≤5px spec).
 */
export function ctrlLeftClick(
  overlay: OverlayWindow,
  position?: { x: number; y: number },
  options?: {
    price?: string;
    currency?: AutoSellCurrency;
    clipboard: HostClipboard;
  },
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

    if (options?.currency) {
      await delay(350);
      clickAt(CURRENCY_CLICKS.dropdown.x, CURRENCY_CLICKS.dropdown.y);
      await smallDelay();
      const currPos = CURRENCY_CLICKS[options.currency];
      clickAt(currPos.x, currPos.y);
      await smallDelay();
      clickAt(CURRENCY_CLICKS.priceBox.x, CURRENCY_CLICKS.priceBox.y);
      await smallDelay();
      await delay(150);
    }

    if (options?.price != null && options.price.length > 0 && options.clipboard) {
      if (!options?.currency) await delay(350);
      const modifier =
        process.platform === "darwin" ? Key.Meta : Key.Ctrl;
      uIOhook.keyTap(Key.A, [modifier]);
      await smallDelay();
      options.clipboard.restoreShortly((clipboard) => {
        clipboard.writeText(options.price!);
        uIOhook.keyTap(Key.V, [modifier]);
      });
      await smallDelay();
      uIOhook.keyTap(Key.Enter);
    }
  })().catch(() => {});
}
