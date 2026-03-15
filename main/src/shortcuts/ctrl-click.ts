import process from "process";
import { execSync } from "child_process";
import { uIOhook, UiohookKey as Key } from "uiohook-napi";
import type { OverlayWindow } from "../windowing/OverlayWindow";
import type { HostClipboard } from "./HostClipboard";

const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Random delay 5–15 ms between actions. */
const smallDelay = () => delay(5 + Math.random() * 10);

type AutoSellCurrency = "annulment" | "divine" | "exalted" | "chaos";

/** Screen positions for currency selection (game UI). */
const CURRENCY_CLICKS = {
  dropdown: { x: 2338, y: 1912 },
  exalted: { x: 2338, y: 1944 },
  divine: { x: 2338, y: 2024 },
  chaos: { x: 2338, y: 2049 },
  annulment: { x: 2338, y: 2155 },
  priceBox: { x: 2200, y: 1915 },
} as const;

function clickAt(x: number, y: number) {
  if (process.platform !== "linux") return;
  execSync(`xdotool mousemove --sync ${Math.round(x)} ${Math.round(y)} sleep 0.03 click 1 sleep 0.04`, {
    stdio: "ignore",
    timeout: 2000,
  });
}

/**
 * Linux only: get IDs of slave (physical) pointer devices.
 * We disable these during auto-sell so the user cannot move the mouse;
 * xdotool synthetic events still work because they use XTest, not these devices.
 */
function getSlavePointerIds(): number[] {
  if (process.platform !== "linux") return [];
  try {
    const out = execSync("xinput list", {
      encoding: "utf8",
      timeout: 2000,
    });
    const ids: number[] = [];
    // Lines like "   ↳ Logitech USB Receiver    id=10    [slave  pointer  (2)]"
    const re = /id=(\d+)\s+\[slave\s+pointer/;
    for (const line of out.split("\n")) {
      const m = line.match(re);
      if (m) ids.push(parseInt(m[1], 10));
    }
    return ids;
  } catch {
    return [];
  }
}

/** Linux only: disable slave pointers so user cannot move mouse during auto-sell. Returns ids that were disabled. */
function disablePointer(): number[] {
  if (process.platform !== "linux") return [];
  const ids = getSlavePointerIds();
  for (const id of ids) {
    try {
      execSync(`xinput disable ${id}`, {
        stdio: "ignore",
        timeout: 2000,
      });
    } catch {
      // skip this device
    }
  }
  return ids;
}

/** Linux only: re-enable pointer devices by id. Call in finally after disablePointer(). */
function enablePointer(ids: number[]): void {
  if (process.platform !== "linux" || ids.length === 0) return;
  for (const id of ids) {
    try {
      execSync(`xinput enable ${id}`, {
        stdio: "ignore",
        timeout: 2000,
      });
    } catch {
      // ignore; device may already be enabled
    }
  }
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
/** Y offset (pixels) for currency/price UI clicks: 1–2 height = 0, 3 height = +23, 4 height = +46. */
function currencyClickYOffset(itemHeight: number | undefined): number {
  if (itemHeight === 3) return 23;
  if (itemHeight === 4) return 46;
  return 0;
}

export function ctrlLeftClick(
  overlay: OverlayWindow,
  position?: { x: number; y: number },
  options?: {
    price?: string;
    currency?: AutoSellCurrency;
    clipboard: HostClipboard;
    /** Item height in inventory squares (1–4). 3 and 4 apply Y offset to UI clicks. */
    itemHeight?: number;
  },
): void {
  const yOffset = currencyClickYOffset(options?.itemHeight);

  (async () => {
    overlay.assertGameActive();
    await delay(40);

    const disabledPointerIds = disablePointer();
    try {
      if (process.platform === "linux") {
        // Single rounding here; position is already in screen pixels from main.
        const x = position ? Math.round(position.x) : "";
        const y = position ? Math.round(position.y) : "";
        const movePart =
          x !== "" && y !== ""
            ? `mousemove --sync ${x} ${y} sleep 0.05 `
            : "";
        const cmd = `xdotool ${movePart}keydown control sleep 0.04 click 1 sleep 0.03 keyup control`;
        execSync(cmd, { stdio: "ignore", timeout: 2000 });
      }
      // TODO: Windows/macOS - use platform-specific input simulation

      if (options?.currency) {
        await delay(80);
        clickAt(CURRENCY_CLICKS.dropdown.x, CURRENCY_CLICKS.dropdown.y + yOffset);
        await smallDelay();
        const currPos = CURRENCY_CLICKS[options.currency];
        clickAt(currPos.x, currPos.y + yOffset);
        await smallDelay();
        clickAt(CURRENCY_CLICKS.priceBox.x, CURRENCY_CLICKS.priceBox.y + yOffset);
        await smallDelay();
        await delay(40);
      }

      if (options?.price != null && options.price.length > 0 && options.clipboard) {
        if (!options?.currency) await delay(80);
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
    } finally {
      enablePointer(disabledPointerIds);
    }
  })().catch(() => {});
}
