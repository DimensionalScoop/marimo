/* Copyright 2026 Marimo. All rights reserved. */

import { EditorSelection, EditorState, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { commands, helix } from "codemirror-helix";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockedFunction,
} from "vitest";
import type { CellId } from "@/core/cells/ids";
import { HotkeyProvider } from "@/core/hotkeys/hotkeys";
import type { CodemirrorCellActions } from "../../cells/state";
import { cellActionsState, cellIdState } from "../../cells/state";
import {
  helixKeymapExtension,
  helixModeField,
  isInHelixInsertMode,
  isInHelixNormalMode,
} from "../helix";
import { KEYMAP_PRESETS, keymapBundle } from "../keymaps";

vi.mock("../../go-to-definition/utils", () => ({
  goToDefinitionAtCursorPosition: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCellActions(
  overrides: Partial<CodemirrorCellActions> = {},
): CodemirrorCellActions {
  return {
    moveToNextCell: vi.fn(),
    saveNotebook: vi.fn(),
    deleteCell: vi.fn(),
    updateCellCode: vi.fn(),
    createManyBelow: vi.fn(),
    toggleHideCode: vi.fn(() => false),
    aiCellCompletion: vi.fn(() => false),
    onRun: vi.fn(),
    afterToggleMarkdown: vi.fn(),
    ...overrides,
  } as unknown as CodemirrorCellActions;
}

const CELL_ID = "test-cell" as CellId;

function createHelixEditor(
  doc: string,
  cellActions: CodemirrorCellActions,
): EditorView {
  const state = EditorState.create({
    doc,
    extensions: [
      helix(),
      // Prec.high mirrors the production keymapBundle setup so our key:"g" / key:"d"
      // bindings run before helix's own keymaps — required for gd interception.
      Prec.high(helixKeymapExtension()),
      cellIdState.of(CELL_ID),
      cellActionsState.of(cellActions),
    ],
  });
  return new EditorView({ state, parent: document.body });
}

/** Fire helix's init setTimeout which converts the point cursor to a range. */
function flushHelixInit() {
  vi.runAllTimers();
}

function pressKey(
  view: EditorView,
  key: string,
  opts: KeyboardEventInit = {},
): void {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...opts,
    }),
  );
}

// ---------------------------------------------------------------------------
// helixModeField — effect-based mode tracking
// ---------------------------------------------------------------------------

describe("helixModeField", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("starts in normal mode", () => {
    const view = createHelixEditor("hello", makeCellActions());
    const m = view.state.field(helixModeField);
    expect(m.type).toBe(0); // Normal
    expect(m.minor).toBe(2); // Normal minor
    view.destroy();
  });

  it("transitions to insert mode when i is pressed", () => {
    const view = createHelixEditor("hello", makeCellActions());
    flushHelixInit();
    pressKey(view, "i");
    const m = view.state.field(helixModeField);
    expect(m.type).toBe(1); // Insert
    view.destroy();
  });

  it("transitions to select mode when v is pressed", () => {
    const view = createHelixEditor("hello", makeCellActions());
    flushHelixInit();
    pressKey(view, "v");
    const m = view.state.field(helixModeField);
    expect(m.type).toBe(4); // Select
    view.destroy();
  });

  it("returns to normal mode after Escape from insert", () => {
    const view = createHelixEditor("hello", makeCellActions());
    flushHelixInit();
    pressKey(view, "i");
    pressKey(view, "Escape");
    const m = view.state.field(helixModeField);
    expect(m.type).toBe(0);
    expect(m.minor).toBe(2);
    view.destroy();
  });

  it("enters goto minor mode (minor=3) when g is pressed in normal mode", () => {
    const view = createHelixEditor("hello world", makeCellActions());
    flushHelixInit();
    pressKey(view, "g");
    const m = view.state.field(helixModeField);
    expect(m.type).toBe(0); // still Normal major mode
    expect(m.minor).toBe(3); // Goto minor mode
    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// isInHelixNormalMode / isInHelixInsertMode
// ---------------------------------------------------------------------------

describe("isInHelixNormalMode / isInHelixInsertMode", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("returns normal=true, insert=false initially", () => {
    const view = createHelixEditor("hello", makeCellActions());
    expect(isInHelixNormalMode(view)).toBe(true);
    expect(isInHelixInsertMode(view)).toBe(false);
    view.destroy();
  });

  it("flips after pressing i", () => {
    const view = createHelixEditor("hello", makeCellActions());
    flushHelixInit();
    pressKey(view, "i");
    expect(isInHelixNormalMode(view)).toBe(false);
    expect(isInHelixInsertMode(view)).toBe(true);
    view.destroy();
  });

  it("returns false for select mode in isInHelixNormalMode", () => {
    const view = createHelixEditor("hello", makeCellActions());
    flushHelixInit();
    pressKey(view, "v"); // select mode
    expect(isInHelixNormalMode(view)).toBe(false);
    expect(isInHelixInsertMode(view)).toBe(false);
    view.destroy();
  });

  it("returns false for goto minor mode in isInHelixNormalMode", () => {
    const view = createHelixEditor("hello world", makeCellActions());
    flushHelixInit();
    pressKey(view, "g"); // goto minor mode
    // type=Normal but minor=Goto — should NOT count as normal mode for navigation
    expect(isInHelixNormalMode(view)).toBe(false);
    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// Cell boundary navigation
// ---------------------------------------------------------------------------

describe("cell boundary navigation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("moves to next cell on j at end-of-doc in normal mode", () => {
    const moveToNextCell = vi.fn();
    const view = createHelixEditor("hi", makeCellActions({ moveToNextCell }));
    flushHelixInit();

    const len = view.state.doc.length;
    view.dispatch({ selection: EditorSelection.range(len, len - 1) });
    expect(isInHelixNormalMode(view)).toBe(true);

    pressKey(view, "j");
    expect(moveToNextCell).toHaveBeenCalledWith({
      cellId: CELL_ID,
      before: false,
      noCreate: true,
    });
    view.destroy();
  });

  it("does NOT move to next cell on j in insert mode", () => {
    const moveToNextCell = vi.fn();
    const view = createHelixEditor("hi", makeCellActions({ moveToNextCell }));
    flushHelixInit();
    pressKey(view, "i");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    pressKey(view, "j");
    expect(moveToNextCell).not.toHaveBeenCalled();
    view.destroy();
  });

  it("does NOT move to next cell on j in select mode", () => {
    const moveToNextCell = vi.fn();
    const view = createHelixEditor("hi", makeCellActions({ moveToNextCell }));
    flushHelixInit();
    pressKey(view, "v"); // select mode
    const len = view.state.doc.length;
    view.dispatch({ selection: EditorSelection.range(len, len - 1) });
    pressKey(view, "j");
    expect(moveToNextCell).not.toHaveBeenCalled();
    view.destroy();
  });

  it("does NOT move when j is pressed mid-document", () => {
    const moveToNextCell = vi.fn();
    const view = createHelixEditor(
      "hello world",
      makeCellActions({ moveToNextCell }),
    );
    flushHelixInit();
    view.dispatch({ selection: EditorSelection.range(4, 3) });
    pressKey(view, "j");
    expect(moveToNextCell).not.toHaveBeenCalled();
    view.destroy();
  });

  it("moves to previous cell on k at start-of-doc in normal mode", () => {
    const moveToNextCell = vi.fn();
    const view = createHelixEditor("hi", makeCellActions({ moveToNextCell }));
    flushHelixInit();
    view.dispatch({ selection: EditorSelection.range(1, 0) });
    pressKey(view, "k");
    expect(moveToNextCell).toHaveBeenCalledWith({
      cellId: CELL_ID,
      before: true,
      noCreate: true,
    });
    view.destroy();
  });

  it("does NOT move to previous cell on k in insert mode", () => {
    const moveToNextCell = vi.fn();
    const view = createHelixEditor("hi", makeCellActions({ moveToNextCell }));
    flushHelixInit();
    pressKey(view, "i");
    view.dispatch({ selection: { anchor: 0 } });
    pressKey(view, "k");
    expect(moveToNextCell).not.toHaveBeenCalled();
    view.destroy();
  });

  it("does NOT move to previous cell on k when a selection starts at 0 in select mode", () => {
    // select mode with anchor=0, head=3: main.from===0 but we're NOT in normal mode
    const moveToNextCell = vi.fn();
    const view = createHelixEditor(
      "hello world",
      makeCellActions({ moveToNextCell }),
    );
    flushHelixInit();
    pressKey(view, "v"); // enter select mode
    // Manually set a selection whose from===0 (simulates user selecting from top)
    view.dispatch({ selection: EditorSelection.range(0, 3) });
    expect(isInHelixNormalMode(view)).toBe(false); // still select mode
    pressKey(view, "k");
    expect(moveToNextCell).not.toHaveBeenCalled();
    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// gd two-key sequence
// ---------------------------------------------------------------------------

describe("gd two-key sequence", () => {
  let goTo: MockedFunction<(view: EditorView) => void>;

  beforeEach(async () => {
    vi.useFakeTimers();
    const mod = await import("../../go-to-definition/utils");
    goTo = mod.goToDefinitionAtCursorPosition as MockedFunction<
      (view: EditorView) => void
    >;
    goTo.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("calls goToDefinitionAtCursorPosition on g → d in normal mode", () => {
    const view = createHelixEditor("my_var = 1", makeCellActions());
    flushHelixInit();
    expect(isInHelixNormalMode(view)).toBe(true);

    pressKey(view, "g"); // sets awaitingGotoKey, helix enters goto minor mode
    pressKey(view, "d"); // our Prec.high binding intercepts

    expect(goTo).toHaveBeenCalledWith(view);
    view.destroy();
  });

  it("resets helix to normal mode after gd (no stuck goto-minor state)", () => {
    const view = createHelixEditor("my_var = 1", makeCellActions());
    flushHelixInit();

    pressKey(view, "g");
    expect(view.state.field(helixModeField).minor).toBe(3); // Goto minor

    pressKey(view, "d");
    expect(view.state.field(helixModeField).minor).toBe(2); // back to Normal minor
    view.destroy();
  });

  it("does NOT call goToDefinitionAtCursorPosition on g → d in insert mode", () => {
    const view = createHelixEditor("my_var = 1", makeCellActions());
    flushHelixInit();
    pressKey(view, "i"); // insert mode
    pressKey(view, "g");
    pressKey(view, "d");
    expect(goTo).not.toHaveBeenCalled();
    view.destroy();
  });

  it("does NOT call goToDefinitionAtCursorPosition on g → d in select mode", () => {
    const view = createHelixEditor("my_var = 1", makeCellActions());
    flushHelixInit();
    pressKey(view, "v"); // select mode
    pressKey(view, "g");
    pressKey(view, "d");
    expect(goTo).not.toHaveBeenCalled();
    view.destroy();
  });

  it("resets tracker when g is followed by a non-d key", () => {
    const view = createHelixEditor("my_var = 1", makeCellActions());
    flushHelixInit();
    pressKey(view, "g");
    pressKey(view, "e"); // not d — resets tracker
    pressKey(view, "d"); // should NOT trigger gd now
    expect(goTo).not.toHaveBeenCalled();
    view.destroy();
  });

  it("gd flag is per-instance: g in cell A does not trigger gd in cell B", () => {
    const view1 = createHelixEditor("a = 1", makeCellActions());
    const view2 = createHelixEditor("b = 2", makeCellActions());
    flushHelixInit();

    pressKey(view1, "g");
    pressKey(view2, "d"); // different view — should not fire

    expect(goTo).not.toHaveBeenCalled();
    view1.destroy();
    view2.destroy();
  });
});

// ---------------------------------------------------------------------------
// :write / :w
// ---------------------------------------------------------------------------

describe(":write / :w command", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("registers a 'write' command with 'w' alias that calls saveNotebook", () => {
    const saveNotebook = vi.fn();
    const view = createHelixEditor("x = 1", makeCellActions({ saveNotebook }));
    flushHelixInit();

    const registered = view.state.facet(commands).flat();
    const writeCmd = registered.find(
      (c: { name: string }) => c.name === "write",
    );
    expect(writeCmd).toBeDefined();
    expect(writeCmd?.aliases).toContain("w");

    writeCmd?.handler(view, []);
    expect(saveNotebook).toHaveBeenCalledOnce();
    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// Ctrl+Escape re-dispatch
// ---------------------------------------------------------------------------

describe("Ctrl+Escape re-dispatch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("re-dispatches Ctrl+Escape upward so React keyboard listeners receive it", () => {
    const view = createHelixEditor("x = 1", makeCellActions());
    flushHelixInit();

    const received: KeyboardEvent[] = [];
    view.dom.addEventListener("keydown", (e) =>
      received.push(e as KeyboardEvent),
    );

    pressKey(view, "Escape", { ctrlKey: true });

    expect(
      received.filter((e) => e.ctrlKey && e.key === "Escape").length,
    ).toBeGreaterThanOrEqual(1);
    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// keymapBundle integration
// ---------------------------------------------------------------------------

describe("KEYMAP_PRESETS and keymapBundle", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("KEYMAP_PRESETS contains helix", () => {
    expect(KEYMAP_PRESETS).toContain("helix");
  });

  it("keymapBundle(helix) returns a non-empty extension array", () => {
    const extensions = keymapBundle(
      { preset: "helix", overrides: {}, destructive_delete: true },
      HotkeyProvider.create(),
    );
    expect(extensions.length).toBeGreaterThan(0);
  });

  it("keymapBundle(helix) creates an EditorState without throwing", () => {
    const extensions = keymapBundle(
      { preset: "helix", overrides: {}, destructive_delete: true },
      HotkeyProvider.create(),
    );
    expect(() =>
      EditorState.create({
        doc: "test",
        extensions: [
          ...extensions,
          cellIdState.of(CELL_ID),
          cellActionsState.of(makeCellActions()),
        ],
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Global mode sync
// ---------------------------------------------------------------------------

describe("global mode sync across cells", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("pressing i in one cell puts all other cells into insert mode", () => {
    const view1 = createHelixEditor("a = 1", makeCellActions());
    const view2 = createHelixEditor("b = 2", makeCellActions());
    const view3 = createHelixEditor("c = 3", makeCellActions());
    flushHelixInit();

    expect(isInHelixNormalMode(view1)).toBe(true);
    expect(isInHelixNormalMode(view2)).toBe(true);
    expect(isInHelixNormalMode(view3)).toBe(true);

    pressKey(view1, "i"); // switch cell 1 to insert

    expect(isInHelixInsertMode(view1)).toBe(true);
    expect(isInHelixInsertMode(view2)).toBe(true); // synced
    expect(isInHelixInsertMode(view3)).toBe(true); // synced

    view1.destroy();
    view2.destroy();
    view3.destroy();
  });

  it("pressing Escape in one cell returns all cells to normal mode", () => {
    const view1 = createHelixEditor("a = 1", makeCellActions());
    const view2 = createHelixEditor("b = 2", makeCellActions());
    flushHelixInit();

    pressKey(view1, "i");
    expect(isInHelixInsertMode(view2)).toBe(true);

    pressKey(view1, "Escape");
    expect(isInHelixNormalMode(view1)).toBe(true);
    expect(isInHelixNormalMode(view2)).toBe(true);

    view1.destroy();
    view2.destroy();
  });

  it("a newly added cell inherits the current global mode", () => {
    const view1 = createHelixEditor("a = 1", makeCellActions());
    flushHelixInit();
    pressKey(view1, "i"); // global mode is now insert
    expect(isInHelixInsertMode(view1)).toBe(true);

    // New cell mounts while mode is insert
    const view2 = createHelixEditor("b = 2", makeCellActions());
    flushHelixInit(); // triggers addInstance → pushes current mode to view2

    expect(isInHelixInsertMode(view2)).toBe(true);

    view1.destroy();
    view2.destroy();
  });

  it("mode sync does not create broadcast loops", () => {
    const view1 = createHelixEditor("a = 1", makeCellActions());
    const view2 = createHelixEditor("b = 2", makeCellActions());
    flushHelixInit();

    // Trigger several rapid mode changes — if loops occurred we'd get a stack overflow
    expect(() => {
      pressKey(view1, "i");
      pressKey(view1, "Escape");
      pressKey(view2, "i");
      pressKey(view2, "Escape");
    }).not.toThrow();

    expect(isInHelixNormalMode(view1)).toBe(true);
    expect(isInHelixNormalMode(view2)).toBe(true);

    view1.destroy();
    view2.destroy();
  });
});
