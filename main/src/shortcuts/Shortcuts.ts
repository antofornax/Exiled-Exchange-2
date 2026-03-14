import { screen, globalShortcut } from "electron";
import type { Point } from "electron";
import {
  uIOhook,
  UiohookKey,
  UiohookWheelEvent,
  UiohookMouseEvent,
} from "uiohook-napi";
import {
  isModKey,
  KeyToElectron,
  mergeTwoHotkeys,
} from "../../../ipc/KeyToCode";
import { typeInChat, stashSearch } from "./text-box";
import { ctrlLeftClick } from "./ctrl-click";
import { WidgetAreaTracker } from "../windowing/WidgetAreaTracker";
import { HostClipboard } from "./HostClipboard";
import { OcrWorker } from "../vision/link-main";
import type { ShortcutAction } from "../../../ipc/types";
import type { Logger } from "../RemoteLogger";
import type { OverlayWindow } from "../windowing/OverlayWindow";
import type { GameWindow } from "../windowing/GameWindow";
import type { GameConfig } from "../host-files/GameConfig";
import type { ServerEvents } from "../server";

type UiohookKeyT = keyof typeof UiohookKey;
const UiohookToName = Object.fromEntries(
  Object.entries(UiohookKey).map(([k, v]) => [v, k]),
);

/** Convert DIP point to screen pixels on Linux (same as WidgetAreaTracker). xdotool needs screen pixels. */
function dipToScreenPointLinux(point: Point): Point {
  const display = screen.getDisplayNearestPoint(point);
  const scale = (v: number, bound: number, native: number) =>
    (v - bound + native) * display.scaleFactor;
  return {
    x: Math.round(
      scale(point.x, display.bounds.x, display.nativeOrigin.x),
    ),
    y: Math.round(
      scale(point.y, display.bounds.y, display.nativeOrigin.y),
    ),
  };
}

/** Convert screen pixels to DIP on Linux (inverse of dipToScreenPointLinux). For renderer payload. */
function screenPointToDipLinux(screenPoint: Point): Point {
  const displays = screen.getAllDisplays();
  for (const display of displays) {
    const scale = (v: number, bound: number, native: number) =>
      (v - bound + native) * display.scaleFactor;
    const left = scale(display.bounds.x, display.bounds.x, display.nativeOrigin.x);
    const top = scale(display.bounds.y, display.bounds.y, display.nativeOrigin.y);
    const right = left + display.bounds.width * display.scaleFactor;
    const bottom = top + display.bounds.height * display.scaleFactor;
    if (
      screenPoint.x >= left &&
      screenPoint.x < right &&
      screenPoint.y >= top &&
      screenPoint.y < bottom
    ) {
      const inv = (px: number, bound: number, native: number) =>
        px / display.scaleFactor + bound - native;
      return {
        x: Math.round(inv(screenPoint.x, display.bounds.x, display.nativeOrigin.x)),
        y: Math.round(inv(screenPoint.y, display.bounds.y, display.nativeOrigin.y)),
      };
    }
  }
  return screenPoint;
}

export class Shortcuts {
  private actions: ShortcutAction[] = [];
  private stashScroll = false;
  private logKeys = false;
  private areaTracker: WidgetAreaTracker;
  private clipboard: HostClipboard;
  /** Cursor position (screen pixels) at the moment the price-check hotkey was pressed. Single source of truth for auto-sell. */
  private lastPriceCheckCursorPosition: { x: number; y: number } | null = null;
  /** Last cursor position from uiohook mousemove (screen pixels). Used for price-check so we record position at keypress time, not after focus/overlay changes. */
  private lastUiohookCursor: { x: number; y: number } | null = null;

  static async create(
    logger: Logger,
    overlay: OverlayWindow,
    poeWindow: GameWindow,
    gameConfig: GameConfig,
    server: ServerEvents,
  ) {
    const ocrWorker = await OcrWorker.create();
    const shortcuts = new Shortcuts(
      logger,
      overlay,
      poeWindow,
      gameConfig,
      server,
      ocrWorker,
    );
    return shortcuts;
  }

  private constructor(
    private logger: Logger,
    private overlay: OverlayWindow,
    private poeWindow: GameWindow,
    private gameConfig: GameConfig,
    private server: ServerEvents,
    private ocrWorker: OcrWorker,
  ) {
    this.areaTracker = new WidgetAreaTracker(server, overlay);
    this.clipboard = new HostClipboard(logger);

    uIOhook.on("mousemove", (e: UiohookMouseEvent) => {
      this.lastUiohookCursor = { x: e.x, y: e.y };
    });

    this.poeWindow.on("active-change", (isActive) => {
      process.nextTick(() => {
        if (isActive === this.poeWindow.isActive) {
          if (isActive) {
            this.register();
          } else {
            this.unregister();
          }
        }
      });
    });

    this.server.onEventAnyClient("CLIENT->MAIN::user-action", (e) => {
      if (e.action === "stash-search") {
        stashSearch(e.text, this.clipboard, this.overlay);
      } else if (e.action === "ctrl-left-click") {
        // Prefer position from renderer (DIP); fallback to main-stored (already screen pixels on Linux).
        const position =
          e.position != null && process.platform === "linux"
            ? dipToScreenPointLinux(e.position)
            : (e.position ?? this.lastPriceCheckCursorPosition ?? undefined);
        this.logger.write(
          `debug [Shortcuts] ctrl-left-click: renderer position=${JSON.stringify(e.position)} main-stored=${JSON.stringify(this.lastPriceCheckCursorPosition)} final=${JSON.stringify(position)}`,
        );
        if (position != null) {
          this.lastPriceCheckCursorPosition = position;
        }
        ctrlLeftClick(this.overlay, position, {
          price: e.price,
          currency: e.currency,
          clipboard: this.clipboard,
        });
      }
    });

    uIOhook.on("keydown", (e) => {
      if (!this.logKeys) return;
      const pressed = eventToString(e);
      this.logger.write(`debug [Shortcuts] Keydown ${pressed}`);
    });
    uIOhook.on("keyup", (e) => {
      if (!this.logKeys) return;
      this.logger.write(
        `debug [Shortcuts] Keyup ${
          UiohookToName[e.keycode] || "not_supported_key"
        }`,
      );
    });

    uIOhook.on("wheel", (e) => {
      if (!e.ctrlKey || !this.poeWindow.isActive || !this.stashScroll) return;

      if (!isStashArea(e, this.poeWindow)) {
        if (e.rotation > 0) {
          uIOhook.keyTap(UiohookKey.ArrowRight);
        } else if (e.rotation < 0) {
          uIOhook.keyTap(UiohookKey.ArrowLeft);
        }
      }
    });
  }

  updateActions(
    actions: ShortcutAction[],
    stashScroll: boolean,
    logKeys: boolean,
    restoreClipboard: boolean,
    language: string,
  ) {
    this.stashScroll = stashScroll;
    this.logKeys = logKeys;
    this.clipboard.updateOptions(restoreClipboard);
    this.ocrWorker.updateOptions(language);

    const copyItemShortcut = mergeTwoHotkeys(
      "Ctrl + C",
      this.gameConfig.showModsKey,
    );
    if (copyItemShortcut !== "Ctrl + C") {
      actions.push({
        shortcut: copyItemShortcut,
        action: { type: "test-only" },
      });
    }

    const allShortcuts = new Set([
      "Ctrl + C",
      "Ctrl + V",
      "Ctrl + A",
      "Ctrl + F",
      "Ctrl + Enter",
      "Home",
      "Delete",
      "Enter",
      "ArrowUp",
      "ArrowRight",
      "ArrowLeft",
      copyItemShortcut,
    ]);

    for (const action of actions) {
      if (
        allShortcuts.has(action.shortcut) &&
        action.action.type !== "test-only"
      ) {
        this.logger.write(
          `error [Shortcuts] Hotkey "${action.shortcut}" reserved by the game will not be registered.`,
        );
      }
    }
    actions = actions.filter((action) => !allShortcuts.has(action.shortcut));

    const duplicates = new Set<string>();
    for (const action of actions) {
      if (allShortcuts.has(action.shortcut)) {
        this.logger.write(
          `error [Shortcuts] It is not possible to use the same hotkey "${action.shortcut}" for multiple actions.`,
        );
        duplicates.add(action.shortcut);
      } else {
        allShortcuts.add(action.shortcut);
      }
    }
    this.actions = actions.filter(
      (action) =>
        !duplicates.has(action.shortcut) ||
        action.action.type === "toggle-overlay",
    );
  }

  private register() {
    for (const entry of this.actions) {
      const isOk = globalShortcut.register(
        shortcutToElectron(entry.shortcut),
        () => {
          if (this.logKeys) {
            this.logger.write(
              `debug [Shortcuts] Action type: ${entry.action.type}`,
            );
          }

          if (entry.keepModKeys) {
            const nonModKey = entry.shortcut
              .split(" + ")
              .filter((key) => !isModKey(key))[0];
            uIOhook.keyToggle(UiohookKey[nonModKey as UiohookKeyT], "up");
          } else {
            entry.shortcut
              .split(" + ")
              .reverse()
              .forEach((key) => {
                uIOhook.keyToggle(UiohookKey[key as UiohookKeyT], "up");
              });
          }

          if (entry.action.type === "toggle-overlay") {
            this.areaTracker.removeListeners();
            this.overlay.toggleActiveState();
          } else if (entry.action.type === "paste-in-chat") {
            typeInChat(entry.action.text, entry.action.send, this.clipboard);
          } else if (entry.action.type === "trigger-event") {
            this.server.sendEventTo("broadcast", {
              name: "MAIN->CLIENT::widget-action",
              payload: { target: entry.action.target },
            });
          } else if (entry.action.type === "stash-search") {
            stashSearch(entry.action.text, this.clipboard, this.overlay);
          } else if (entry.action.type === "copy-item") {
            const { action } = entry;

            // Prefer uiohook cursor (recorded on mousemove) so position is correct when overlay had focus; fallback to Electron.
            const fallbackPosition = screen.getCursorScreenPoint();
            const positionForPriceCheck =
              action.target === "price-check" && this.lastUiohookCursor != null
                ? (process.platform === "linux"
                    ? screenPointToDipLinux(this.lastUiohookCursor)
                    : this.lastUiohookCursor)
                : fallbackPosition;

            if (action.target === "price-check") {
              this.lastPriceCheckCursorPosition =
                process.platform === "linux"
                  ? (this.lastUiohookCursor ?? dipToScreenPointLinux(fallbackPosition))
                  : { x: fallbackPosition.x, y: fallbackPosition.y };
              this.logger.write(
                `debug [Shortcuts] price-check hotkey: uiohook=${JSON.stringify(this.lastUiohookCursor)} stored screen px=${JSON.stringify(this.lastPriceCheckCursorPosition)} payload DIP=${JSON.stringify(positionForPriceCheck)}`,
              );
            }

            this.clipboard
              .readItemText()
              .then((clipboard) => {
                this.areaTracker.removeListeners();
                const itemTextPayload = {
                  name: "MAIN->CLIENT::item-text" as const,
                  payload: {
                    target: action.target,
                    clipboard,
                    position:
                      action.target === "price-check"
                        ? positionForPriceCheck
                        : fallbackPosition,
                    focusOverlay: Boolean(action.focusOverlay),
                  },
                };
                this.server.sendEventTo(
                  action.target === "price-check" ? "broadcast" : "last-active",
                  itemTextPayload,
                );
                if (action.focusOverlay && this.overlay.wasUsedRecently) {
                  this.overlay.assertOverlayActive();
                }
              })
              .catch(() => {});

            pressKeysToCopyItemText(
              entry.keepModKeys
                ? entry.shortcut.split(" + ").filter((key) => isModKey(key))
                : undefined,
              this.gameConfig.showModsKey,
            );
          } else if (
            entry.action.type === "ocr-text" &&
            entry.action.target === "heist-gems"
          ) {
            if (process.platform !== "win32") return;

            const { action } = entry;
            const pressTime = Date.now();
            const imageData = this.poeWindow.screenshot();
            this.ocrWorker
              .findHeistGems({
                width: this.poeWindow.bounds.width,
                height: this.poeWindow.bounds.height,
                data: imageData,
              })
              .then((result) => {
                this.server.sendEventTo("last-active", {
                  name: "MAIN->CLIENT::ocr-text",
                  payload: {
                    target: action.target,
                    pressTime,
                    ocrTime: result.elapsed,
                    paragraphs: result.recognized.map((p) => p.text),
                  },
                });
              })
              .catch(() => {});
          }
        },
      );

      if (!isOk) {
        this.logger.write(
          `error [Shortcuts] Failed to register a shortcut "${entry.shortcut}". It is already registered by another application.`,
        );
      }

      if (entry.action.type === "test-only") {
        globalShortcut.unregister(shortcutToElectron(entry.shortcut));
      }
    }
  }

  private unregister() {
    globalShortcut.unregisterAll();
  }
}

function pressKeysToCopyItemText(
  pressedModKeys: string[] = [],
  showModsKey: string,
) {
  let keys = mergeTwoHotkeys("Ctrl + C", showModsKey).split(" + ");
  keys = keys.filter((key) => key !== "C");
  if (process.platform !== "darwin") {
    // On non-Mac platforms, don't toggle keys that are already being pressed.
    //
    // For unknown reasons, we need to toggle pressed keys on Mac for advanced
    // mod descriptions to be copied. You can test this by setting the shortcut
    // to "Alt + any letter". They'll work with this line, but not if it's
    // commented out.
    keys = keys.filter((key) => !pressedModKeys.includes(key));
  }

  for (const key of keys) {
    uIOhook.keyToggle(UiohookKey[key as UiohookKeyT], "down");
  }

  // finally press `C` to copy text
  uIOhook.keyTap(UiohookKey.C);

  // Timeout to enforce release of keys
  // Game was dropping the release inputs for some reason
  setTimeout(() => {
    keys.reverse();
    for (const key of keys) {
      uIOhook.keyToggle(UiohookKey[key as UiohookKeyT], "up");
    }
  }, 10);
}

function isStashArea(mouse: UiohookWheelEvent, poeWindow: GameWindow): boolean {
  if (
    !poeWindow.bounds ||
    mouse.x > poeWindow.bounds.x + poeWindow.uiSidebarWidth
  )
    return false;

  return (
    mouse.y > poeWindow.bounds.y + (poeWindow.bounds.height * 154) / 1600 &&
    mouse.y < poeWindow.bounds.y + (poeWindow.bounds.height * 1192) / 1600
  );
}

function eventToString(e: {
  keycode: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}) {
  const { ctrlKey, shiftKey, altKey } = e;

  let code = UiohookToName[e.keycode];
  if (!code) return "not_supported_key";

  if (code === "Shift" || code === "Alt" || code === "Ctrl") return code;

  if (ctrlKey && shiftKey && altKey) code = `Ctrl + Shift + Alt + ${code}`;
  else if (shiftKey && altKey) code = `Shift + Alt + ${code}`;
  else if (ctrlKey && shiftKey) code = `Ctrl + Shift + ${code}`;
  else if (ctrlKey && altKey) code = `Ctrl + Alt + ${code}`;
  else if (altKey) code = `Alt + ${code}`;
  else if (ctrlKey) code = `Ctrl + ${code}`;
  else if (shiftKey) code = `Shift + ${code}`;

  return code;
}

function shortcutToElectron(shortcut: string) {
  return shortcut
    .split(" + ")
    .map((k) => KeyToElectron[k as keyof typeof KeyToElectron])
    .join("+");
}
