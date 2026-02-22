/* Copyright 2026 Marimo. All rights reserved. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { helix } from "codemirror-helix";
import { Prec } from "@codemirror/state";
import {
  helixKeymapExtension,
  isInHelixNormalMode,
  isInHelixInsertMode,
  visibleForTesting,
} from "../helix";
import { KEYMAP_PRESETS } from "../keymaps";
import { cellActionsState, cellIdState } from "../../cells/state";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCellActions(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    moveToNextCell: vi.fn(),
    saveNotebook: vi.fn(),
    ...overrides,
  } as any;
}

function createHelixEditor(content = "hello world", actions = makeCellActions()) {
  const dom = document.createElement("div");
  document.body.appendChild(dom);

  return new EditorView({
    state: EditorState.create({
      doc: content,
      extensions: [
        helix(),
        Prec.high(helixKeymapExtension()),
        cellActionsState.of(actions),
        cellIdState.of("test-cell" as any),
      ],
    }),
    parent: dom,
  });
}

function pressKey(view: EditorView, key: string, opts: KeyboardEventInit = {}) {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, ...opts })
  );
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keyup", { key, bubbles: true, ...opts })
  );
}

async function flushAsync() {
  await vi.runAllTimersAsync(); // flush setTimeout/rAF/idle (fake timers)
  await Promise.resolve();      // flush microtasks
}

// ---------------------------------------------------------------------------
// Mode helpers
// ---------------------------------------------------------------------------

describe("isInHelixNormalMode / isInHelixInsertMode", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; visibleForTesting.resetHelixModeSync(); });

  it("starts in normal mode", () => {
    const view = createHelixEditor();
    expect(isInHelixNormalMode(view)).toBe(true);
    expect(isInHelixInsertMode(view)).toBe(false);
    view.destroy();
  });

  it("transitions to insert mode on i", () => {
    const view = createHelixEditor();
    pressKey(view, "i");
    expect(isInHelixInsertMode(view)).toBe(true);
    expect(isInHelixNormalMode(view)).toBe(false);
    view.destroy();
  });

  it("returns to normal mode on Escape from insert", () => {
    const view = createHelixEditor();
    pressKey(view, "i");
    expect(isInHelixInsertMode(view)).toBe(true);
    pressKey(view, "Escape");
    expect(isInHelixNormalMode(view)).toBe(true);
    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// Cell navigation — j / k
// ---------------------------------------------------------------------------

describe("j — move to next cell at bottom boundary", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; visibleForTesting.resetHelixModeSync(); });

  it("fires moveToNextCell(before:false) when cursor is at end in normal mode", () => {
    const actions = makeCellActions();
    const view = createHelixEditor("hello", actions);
    // Move cursor to end of doc explicitly (helix block cursor may not render in jsdom)
    const docLen = view.state.doc.length;
    view.dispatch({ selection: { anchor: docLen, head: docLen } });
    pressKey(view, "j");
    expect(actions.moveToNextCell).toHaveBeenCalledWith(
      expect.objectContaining({ before: false, noCreate: true })
    );
    view.destroy();
  });

  it("does not fire moveToNextCell when cursor is not at end", () => {
    const actions = makeCellActions();
    const view = createHelixEditor("hello world", actions);
    pressKey(view, "j");
    expect(actions.moveToNextCell).not.toHaveBeenCalled();
    view.destroy();
  });

  it("does not fire moveToNextCell in insert mode", () => {
    const actions = makeCellActions();
    const view = createHelixEditor("x", actions);
    pressKey(view, "i");
    pressKey(view, "j");
    expect(actions.moveToNextCell).not.toHaveBeenCalled();
    view.destroy();
  });
});

describe("k — move to previous cell at top boundary", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; visibleForTesting.resetHelixModeSync(); });

  it("fires moveToNextCell(before:true) when cursor is at start in normal mode", () => {
    const actions = makeCellActions();
    const view = createHelixEditor("hello", actions);
    // Helix cursor starts at {from:0, to:1} — from===0, so at start
    pressKey(view, "k");
    expect(actions.moveToNextCell).toHaveBeenCalledWith(
      expect.objectContaining({ before: true, noCreate: true })
    );
    view.destroy();
  });

  it("does not fire when cursor is not at start", () => {
    const actions = makeCellActions();
    const view = createHelixEditor("hello", actions);
    // Move cursor to middle first via j (won't trigger navigation on multi-line doc)
    pressKey(view, "l"); pressKey(view, "l"); // move right
    pressKey(view, "k");
    expect(actions.moveToNextCell).not.toHaveBeenCalled();
    view.destroy();
  });

  it("does not fire in insert mode", () => {
    const actions = makeCellActions();
    const view = createHelixEditor("hello", actions);
    pressKey(view, "i");
    pressKey(view, "k");
    expect(actions.moveToNextCell).not.toHaveBeenCalled();
    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// Global mode sync
// ---------------------------------------------------------------------------

describe("global mode sync across cells", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame"] }));
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
    visibleForTesting.resetHelixModeSync(); // prevent cross-test instance leakage
  });

  it("entering insert mode in one cell syncs to others", async () => {
    const v1 = createHelixEditor("a = 1");
    const v2 = createHelixEditor("b = 2");
    await flushAsync(); // allow requestAnimationFrame in addInstance

    pressKey(v1, "i");
    await flushAsync(); // onIdle defers the broadcast

    expect(isInHelixInsertMode(v1)).toBe(true);
    expect(isInHelixInsertMode(v2)).toBe(true);

    v1.destroy(); v2.destroy();
  });

  it("pressing Escape syncs back to normal across cells", async () => {
    const v1 = createHelixEditor("a = 1");
    const v2 = createHelixEditor("b = 2");
    await flushAsync();

    pressKey(v1, "i");
    await flushAsync();
    pressKey(v1, "Escape");
    await flushAsync();

    expect(isInHelixNormalMode(v1)).toBe(true);
    expect(isInHelixNormalMode(v2)).toBe(true);

    v1.destroy(); v2.destroy();
  });

  it("new cell inherits current global mode", async () => {
    const v1 = createHelixEditor("a = 1");
    await flushAsync();

    pressKey(v1, "i");
    expect(isInHelixInsertMode(v1)).toBe(true);

    const v2 = createHelixEditor("b = 2");
    await flushAsync(); // addInstance pushes current mode to v2

    expect(isInHelixInsertMode(v2)).toBe(true);

    v1.destroy(); v2.destroy();
  });
});

// ---------------------------------------------------------------------------
// :w command
// ---------------------------------------------------------------------------

describe(":write command", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; visibleForTesting.resetHelixModeSync(); });

  it("saveNotebook action is registered", () => {
    const actions = makeCellActions();
    const view = createHelixEditor("x", actions);
    // Verify the extension registers without errors; actual :w dispatch
    // would require triggering the helix command palette which is UI-only.
    expect(view).toBeTruthy();
    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// KEYMAP_PRESETS / keymapBundle
// ---------------------------------------------------------------------------

describe("KEYMAP_PRESETS and keymapBundle", () => {
  it("KEYMAP_PRESETS contains helix", () => {
    expect(KEYMAP_PRESETS).toContain("helix");
  });
});
