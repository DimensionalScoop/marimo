/* Copyright 2026 Marimo. All rights reserved. */

import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap } from "@codemirror/view";
import { commands, resetMode } from "codemirror-helix";
import { cellActionsState, cellIdState } from "../cells/state";
import { goToDefinitionAtCursorPosition } from "../go-to-definition/utils";
import { onIdle } from "@/utils/idle";
import { Logger } from "@/utils/Logger";

// ---------------------------------------------------------------------------
// Mode field — tracks helix mode so we can guard j/k and sync across cells.
// We extract the StateEffectType from the exported `resetMode` effect instance
// rather than importing it directly (it's not exported by codemirror-helix).
// ---------------------------------------------------------------------------

const modeEffectType = (resetMode as unknown as { type: ReturnType<typeof StateEffect.define> }).type;

export type HelixModeState = { type: number; minor: number };

// mode.type: 0=Normal, 1=Insert, 4=Select
const helixModeField = StateField.define<HelixModeState>({
  create: () => ({ type: 0, minor: 2 }),
  update(mode, tr) {
    for (const effect of tr.effects) {
      if (effect.is(modeEffectType)) {
        return effect.value as HelixModeState;
      }
    }
    return mode;
  },
});

export function isInHelixNormalMode(view: EditorView): boolean {
  return (view.state.field(helixModeField, false)?.type ?? 0) === 0;
}

export function isInHelixInsertMode(view: EditorView): boolean {
  return (view.state.field(helixModeField, false)?.type ?? 0) === 1;
}

// ---------------------------------------------------------------------------
// Boundary helpers
// In helix normal mode, the cursor is always a non-empty range {from:N, to:N+1}.
// isAtStartOfEditor (from===0 && to===0) would never match, so we need our own.
// ---------------------------------------------------------------------------

function isAtStartOfEditorHelix(view: EditorView): boolean {
  const main = view.state.selection.main;
  return main.from === 0 && isInHelixNormalMode(view);
}

function isAtEndOfEditorHelix(view: EditorView): boolean {
  const main = view.state.selection.main;
  const docLength = view.state.doc.length;
  // In helix normal mode the cursor at end is {from: docLength-1, to: docLength}
  return main.to >= docLength && isInHelixNormalMode(view);
}

// ---------------------------------------------------------------------------
// Main extension
// ---------------------------------------------------------------------------

export function helixKeymapExtension(): Extension[] {
  return [
    helixModeField,

    // Cell boundary navigation — normal mode only
    keymap.of([{
      key: "j",
      run: (view) => {
        if (!isAtEndOfEditorHelix(view)) return false;
        const actions = view.state.facet(cellActionsState);
        const cellId = view.state.facet(cellIdState);
        actions.moveToNextCell({ cellId, before: false, noCreate: true });
        return true;
      },
    }]),
    keymap.of([{
      key: "k",
      run: (view) => {
        if (!isAtStartOfEditorHelix(view)) return false;
        const actions = view.state.facet(cellActionsState);
        const cellId = view.state.facet(cellIdState);
        actions.moveToNextCell({ cellId, before: true, noCreate: true });
        return true;
      },
    }]),

    // Ctrl-[ exits insert mode on Linux/Windows (CodeMirror's default is dedent)
    // Helix doesn't bind this natively, same situation as vim.
    keymap.of([{
      linux: "Ctrl-[",
      win: "Ctrl-[",
      run(view) {
        if (!isInHelixInsertMode(view)) return false;
        view.dispatch({ effects: modeEffectType.of({ type: 0, minor: 2 }) });
        return true;
      },
    }]),

    // gd — go to definition
    goToDefinitionKeymap(),

    // :w / :write — save notebook
    commands.of([{
      name: "write",
      aliases: ["w"],
      help: "Save notebook",
      handler(view) {
        const actions = view.state.facet(cellActionsState);
        actions.saveNotebook();
      },
    }]),

    // Re-dispatch Ctrl+Escape so React Aria's useKeyboard on the cell container
    // receives it. Helix swallows the event the same way vim does.
    EditorView.domEventHandlers({
      keydown(event, view) {
        if (event.ctrlKey && event.key === "Escape") {
          view.dom.dispatchEvent(new KeyboardEvent(event.type, event));
          return true;
        }
        return false;
      },
    }),

    // Mode sync across all open cell editors (mirrors CodeMirrorVimSync in vim.ts)
    ViewPlugin.define((view) => {
      requestAnimationFrame(() => {
        HelixModeSync.INSTANCES.addInstance(view);
      });
      return {
        update(update) {
          const prev = update.startState.field(helixModeField, false);
          const next = update.state.field(helixModeField, false);
          if (next && prev && (prev.type !== next.type || prev.minor !== next.minor)) {
            if (HelixModeSync.INSTANCES.isBroadcasting) return;
            HelixModeSync.INSTANCES.isBroadcasting = true;
            // Defer to keep the active editor snappy, same as CodeMirrorVimSync
            onIdle(() => {
              HelixModeSync.INSTANCES.broadcastModeChange(view, next);
              HelixModeSync.INSTANCES.isBroadcasting = false;
            });
          }
        },
        destroy() {
          HelixModeSync.INSTANCES.removeInstance(view);
        },
      };
    }),
  ];
}

// ---------------------------------------------------------------------------
// gd keymap
// After g, helix enters Goto minor mode. We intercept d before helix sees it,
// run go-to-definition, then manually reset helix back to Normal (helix only
// resets minor mode via its own goto.* handlers — goto.d doesn't exist).
// ---------------------------------------------------------------------------

function goToDefinitionKeymap(): Extension {
  let awaitingGotoKey = false;

  return keymap.of([
    {
      key: "g",
      run(view) {
        if (isInHelixNormalMode(view)) awaitingGotoKey = true;
        return false; // let helix handle g (enters goto minor mode)
      },
    },
    {
      key: "d",
      run(view) {
        if (!awaitingGotoKey) return false;
        awaitingGotoKey = false;
        // Only fire in normal-type mode (awaitingGotoKey was set in normal, but
        // user could have pressed i between g and d)
        if ((view.state.field(helixModeField, false)?.type ?? 0) !== 0) return false;
        goToDefinitionAtCursorPosition(view);
        // Reset goto minor mode — helix won't do it since we consumed d
        view.dispatch({ effects: modeEffectType.of({ type: 0, minor: 2 }) });
        return true;
      },
    },
    {
      any(_view, event) {
        if (event.key !== "g" && event.key !== "d") awaitingGotoKey = false;
        return false;
      },
    },
  ]);
}

// ---------------------------------------------------------------------------
// Mode sync (mirrors CodeMirrorVimSync from vim.ts)
// ---------------------------------------------------------------------------

class HelixModeSync {
  private instances = new Set<EditorView>();
  isBroadcasting = false;

  public static INSTANCES = new HelixModeSync();
  private constructor() {}

  addInstance(view: EditorView) {
    this.instances.add(view);

    // Push the current global mode to the new cell so it doesn't start in
    // Normal while every other cell is in Insert.
    const donor = [...this.instances].find((v) => v !== view);
    if (!donor) return;
    const currentMode = donor.state.field(helixModeField, false);
    if (currentMode) {
      view.dispatch({ effects: modeEffectType.of(currentMode) });
    }
  }

  removeInstance(view: EditorView) {
    this.instances.delete(view);
  }

  /** Reset all state — for use in tests only. */
  reset() {
    this.instances.clear();
    this.isBroadcasting = false;
  }

  broadcastModeChange(origin: EditorView, mode: HelixModeState) {
    for (const view of this.instances) {
      if (view === origin) continue;
      try {
        view.dispatch({ effects: modeEffectType.of(mode) });
      } catch (e) {
        Logger.warn("HelixModeSync: failed to broadcast mode change", e);
      }
    }
  }
}

export const visibleForTesting = {
  resetHelixModeSync: () => HelixModeSync.INSTANCES.reset(),
};
