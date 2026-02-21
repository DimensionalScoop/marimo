/* Copyright 2026 Marimo. All rights reserved. */

import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate, keymap } from "@codemirror/view";
import {
  commands,
  globalStateSync,
  resetMode,
} from "codemirror-helix";
import { goToDefinitionAtCursorPosition } from "../go-to-definition/utils";
import { cellActionsState, cellIdState } from "../cells/state";

// ---------------------------------------------------------------------------
// Mode types — values come from codemirror-helix internals.
// These are stable across the library's versions (the enum is fundamental to
// the model), but they are not exported.  We derive them from the exported
// `resetMode` instance rather than hard-coding magic numbers so that a future
// rename would surface as a type error rather than a silent regression.
// ---------------------------------------------------------------------------

/**
 * The `StateEffectType` used by codemirror-helix for all mode transitions.
 *
 * `resetMode` is `MODE_EFF.NORMAL` — a `StateEffect` *instance*, not a type.
 * Every CM6 `StateEffect` instance exposes its `.type` property, which *is*
 * the `StateEffectType` we can pass to `effect.is()`.
 */
const modeEffectType = resetMode.type as ReturnType<
  typeof StateEffect.define<{ type: number; minor: number }>
>;

/** Helix mode type constants, mirroring the library's internal enum. */
const HelixMode = {
  Normal: 0,
  Insert: 1,
  Select: 4,
} as const;

/** Helix minor-mode constants (sub-modes within Normal/Select). */
const HelixMinor = {
  Normal: 2,
  Goto: 3,
  Match: 5,
  Space: 6,
} as const;

// ---------------------------------------------------------------------------
// Mode StateField
// ---------------------------------------------------------------------------

interface HelixModeState {
  /** Major mode: 0=Normal, 1=Insert, 4=Select */
  type: number;
  /** Minor mode (only meaningful when type === Normal): 2=Normal, 3=Goto, … */
  minor: number;
}

/**
 * A `StateField` that tracks the current helix mode by observing every
 * `modeEffect` dispatched through the editor state.
 *
 * This is the only reliable way to tell Normal from Select mode: both have
 * non-empty selections, so selection shape alone is insufficient.
 */
export const helixModeField = StateField.define<HelixModeState>({
  create: () => ({ type: HelixMode.Normal, minor: HelixMinor.Normal }),
  update(mode, tr) {
    for (const effect of tr.effects) {
      if (effect.is(modeEffectType)) {
        const { type, minor = HelixMinor.Normal } = effect.value;
        return { type, minor };
      }
    }
    return mode;
  },
});

export function isInHelixNormalMode(view: EditorView): boolean {
  const m = view.state.field(helixModeField, false);
  // Treat missing field (e.g. in tests without helix()) as normal mode.
  if (!m) return true;
  return m.type === HelixMode.Normal && m.minor === HelixMinor.Normal;
}

export function isInHelixInsertMode(view: EditorView): boolean {
  const m = view.state.field(helixModeField, false);
  if (!m) return false;
  return m.type === HelixMode.Insert;
}

// ---------------------------------------------------------------------------
// Boundary checks
// ---------------------------------------------------------------------------

/**
 * End-of-document check for helix normal mode.
 *
 * Helix's normal-mode cursor is always a range.  At end-of-document
 * that range is `{from: docLength-1, to: docLength}`.
 */
function isAtEndOfEditorHelix(view: EditorView): boolean {
  const { main } = view.state.selection;
  const docLength = view.state.doc.length;
  if (docLength === 0) return true;
  return main.from === docLength - 1 && main.to === docLength;
}

/**
 * Start-of-document check for helix normal mode.
 *
 * We require both `from === 0` *and* that we are actually in normal mode
 * (not select mode, which can also have anchor at 0 for mid-document selections).
 */
function isAtStartOfEditorHelix(view: EditorView): boolean {
  if (!isInHelixNormalMode(view)) return false;
  return view.state.selection.main.from === 0;
}

// ---------------------------------------------------------------------------
// Main extension
// ---------------------------------------------------------------------------

/**
 * Helix extension for marimo, parallel to {@link vimKeymapExtension}.
 *
 * Wires up:
 * - Mode tracking via `helixModeField`
 * - Cell navigation: j/k at document boundaries in normal mode only
 * - Go-to-definition: `gd` sequence in normal mode, resets helix minor mode after
 * - Save command: `:w` / `:write` via the helix command palette
 * - Register sync across cell editors, gated on actual yank/delete operations
 * - Ctrl+Escape re-dispatch for React command-mode listeners
 */
export function helixKeymapExtension(): Extension[] {
  return [
    helixModeField,

    // Cell boundary navigation — strictly normal mode only
    keymap.of([
      {
        key: "j",
        run: (view) => {
          if (isAtEndOfEditorHelix(view) && isInHelixNormalMode(view)) {
            const actions = view.state.facet(cellActionsState);
            const cellId = view.state.facet(cellIdState);
            actions.moveToNextCell({ cellId, before: false, noCreate: true });
            return true;
          }
          return false;
        },
      },
    ]),
    keymap.of([
      {
        key: "k",
        run: (view) => {
          if (isAtStartOfEditorHelix(view)) {
            const actions = view.state.facet(cellActionsState);
            const cellId = view.state.facet(cellIdState);
            actions.moveToNextCell({ cellId, before: true, noCreate: true });
            return true;
          }
          return false;
        },
      },
    ]),

    // gd — go to definition, with helix minor-mode cleanup
    goToDefinitionKeymap(),

    // Register sync — fires only when registers actually change
    ViewPlugin.fromClass(
      class {
        constructor(private view: EditorView) {
          requestAnimationFrame(() =>
            HelixStateSync.INSTANCES.addInstance(view),
          );
        }
        update(update: ViewUpdate) {
          if (HelixStateSync.INSTANCES.hasYankEffect(update)) {
            HelixStateSync.INSTANCES.syncFrom(this.view);
          }
        }
        destroy() {
          HelixStateSync.INSTANCES.removeInstance(this.view);
        }
      },
    ),

    // Typable commands: :w / :write
    commands.of([
      {
        name: "write",
        aliases: ["w"],
        help: "Save notebook",
        handler(view) {
          const actions = view.state.facet(cellActionsState);
          actions.saveNotebook();
        },
      },
    ]),

    // Re-dispatch Ctrl+Escape so React components above the editor receive it.
    // Helix swallows this event the same way vim does.
    EditorView.domEventHandlers({
      keydown(event, view) {
        if (event.ctrlKey && event.key === "Escape") {
          view.dom.dispatchEvent(new KeyboardEvent(event.type, event));
          return true;
        }
        return false;
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// gd keymap
// ---------------------------------------------------------------------------

/**
 * Two-key sequence keymap for `gd` (go to definition).
 *
 * Design constraints:
 * - Must use explicit `key:` bindings (not `any`): helix's own `key: "d"`
 *   handler would be checked first at default priority and return true,
 *   preventing `any` from ever seeing `d`. With `Prec.high` wrapping the
 *   whole `helixKeymapExtension`, our bindings run before helix's.
 * - After we handle `d`, helix's goto minor mode is *not* reset (helix only
 *   resets it inside its own goto.* handlers, which we've bypassed). We
 *   manually dispatch a `modeEffectType` reset to keep helix's internal state
 *   consistent.
 * - The `awaitingGotoKey` flag is local to each extension instance so that a
 *   `g` press in cell A cannot trigger `gd` in cell B.
 */
function goToDefinitionKeymap(): Extension {
  let awaitingGotoKey = false;

  return keymap.of([
    {
      key: "g",
      run(view) {
        if (isInHelixNormalMode(view)) awaitingGotoKey = true;
        return false; // let helix handle g (enters goto-minor-mode)
      },
    },
    {
      key: "d",
      run(view) {
        // After pressing g, helix transitions to Goto minor mode (minor=3).
        // isInHelixNormalMode requires minor=Normal, so we check type directly.
        // awaitingGotoKey was only set while in normal type mode, so checking
        // type here just guards against a g-in-normal → i → d sequence.
        const mode = view.state.field(helixModeField, false);
        const inNormalType = !mode || mode.type === HelixMode.Normal;
        if (awaitingGotoKey && inNormalType) {
          awaitingGotoKey = false;
          goToDefinitionAtCursorPosition(view);
          // Reset helix's goto minor mode so the editor doesn't get stuck.
          // We bypassed helix's goto.d handler (which doesn't exist), so its
          // own state machine never ran the reset. Do it manually here.
          view.dispatch({
            effects: modeEffectType.of({
              type: HelixMode.Normal,
              minor: HelixMinor.Normal,
            }),
          });
          return true;
        }
        awaitingGotoKey = false;
        return false; // let helix handle d normally
      },
    },
    {
      // Reset tracker on any key outside the two-char gd sequence
      any(_view, event) {
        if (event.key !== "g" && event.key !== "d") {
          awaitingGotoKey = false;
        }
        return false;
      },
    },
  ]);
}

// ---------------------------------------------------------------------------
// State sync
// ---------------------------------------------------------------------------

/**
 * Synchronises helix global state (registers, theme) across all cell editors.
 *
 * Uses `globalStateSync()` from codemirror-helix, which generates the minimal
 * set of transactions needed to bring another editor's global state in line.
 *
 * Syncing is gated on the presence of a `yankEffect` in the update's
 * transactions — registers only change when the user yanks, deletes, or runs
 * a search. This avoids the O(N) overhead of dispatching to every cell on
 * every single keystroke during insert mode.
 *
 * The `yankEffectType` is lazily extracted from the first `globalStateSync`
 * call to avoid a chicken-and-egg problem at module load time.
 */
class HelixStateSync {
  private instances = new Set<EditorView>();
  private isBroadcasting = false;
  private yankEffectType: ReturnType<typeof StateEffect.define> | null = null;

  public static INSTANCES: HelixStateSync = new HelixStateSync();

  private constructor() {}

  addInstance(view: EditorView) {
    this.instances.add(view);
  }

  removeInstance(view: EditorView) {
    this.instances.delete(view);
  }

  /**
   * Lazily resolve the `yankEffectType` from the first available editor state.
   * `globalStateSync` always returns `[{ effects: yankEffect.of({reset:…}) }]`
   * so `specs[0].effects.type` is the `StateEffectType` we need.
   */
  private resolveYankEffectType(state: Parameters<typeof globalStateSync>[0]): void {
    if (this.yankEffectType) return;
    const spec = globalStateSync(state)[0] as { effects?: { type: typeof StateEffect.define } };
    this.yankEffectType = spec?.effects?.type ?? null;
  }

  hasYankEffect(update: ViewUpdate): boolean {
    this.resolveYankEffectType(update.state);
    if (!this.yankEffectType) return false;
    return update.transactions.some((tr) =>
      tr.effects.some((e) => e.is(this.yankEffectType!)),
    );
  }

  syncFrom(origin: EditorView) {
    if (this.isBroadcasting) return;
    this.isBroadcasting = true;
    const txSpecs = globalStateSync(origin.state);
    for (const view of this.instances) {
      if (view !== origin) {
        view.dispatch(...txSpecs);
      }
    }
    this.isBroadcasting = false;
  }
}
