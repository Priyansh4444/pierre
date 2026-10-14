import type { TextDocument } from './textDocument';
import type {
  EditHistoryCoalescingMode,
  EditHistoryEntry,
  EditHistoryState,
  EditorLineAnnotation,
  EditorSelection,
  EditorType,
  ResolvedTextEdit,
} from './types';

// Largest number of undo or redo entries kept; oldest entries drop first once exceeded.
const DEFAULT_EDIT_STACK_MAX_ENTRIES = 100;

export type EditStackEntry<
  EType extends EditorType,
  LAnnotation = unknown,
> = EditHistoryEntry<EType, LAnnotation>;
type EditStackCoalescingMode = EditHistoryCoalescingMode;

/** Options for the edit stack. */
export interface EditStackOptions {
  /** The maximum number of entries to keep in the undo stack. */
  maxEntries?: number;
}

export class EditStack<EType extends EditorType, LAnnotation = unknown> {
  #undoStack: EditStackEntry<EType, LAnnotation>[] = [];
  #redoStack: EditStackEntry<EType, LAnnotation>[] = [];
  #maxEntries: number;
  #canCoalesce = false;

  constructor(options?: EditStackOptions) {
    this.#maxEntries = Math.max(
      1,
      options?.maxEntries ?? DEFAULT_EDIT_STACK_MAX_ENTRIES
    );
  }

  get canUndo(): boolean {
    return this.#undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.#redoStack.length > 0;
  }

  // A live view over this stack without copying its entries.
  getLiveState(): EditHistoryState<EType, LAnnotation> {
    return Object.defineProperties(
      {},
      {
        undoStack: {
          enumerable: true,
          get: () => this.#undoStack,
        },
        redoStack: {
          enumerable: true,
          get: () => this.#redoStack,
        },
        maxEntries: {
          enumerable: true,
          get: () => this.#maxEntries,
        },
        canCoalesce: {
          enumerable: true,
          get: () => this.#canCoalesce,
        },
      }
    ) as EditHistoryState<EType, LAnnotation>;
  }

  clear(): void {
    this.#undoStack.length = 0;
    this.#redoStack.length = 0;
    this.#canCoalesce = false;
  }

  push(entry: EditStackEntry<EType, LAnnotation>): void {
    this.#undoStack.push(entry);
    this.#redoStack.length = 0;
    this.#canCoalesce = true;
    if (this.#undoStack.length > this.#maxEntries) {
      this.#undoStack.shift();
    }
  }

  setLastUndoSelectionsAfter(selections: EditorSelection[]): void {
    const lastEntry = this.peekUndo();
    if (lastEntry !== undefined) {
      lastEntry.selectionsAfter = selections.map((selection) => ({
        ...selection,
      }));
    }
  }

  setLastUndoLineAnnotations(
    lineAnnotationsBefore: EditorLineAnnotation<EType, LAnnotation>[],
    lineAnnotationsAfter: EditorLineAnnotation<EType, LAnnotation>[]
  ): void {
    const lastEntry = this.peekUndo();
    if (lastEntry !== undefined) {
      lastEntry.lineAnnotationsBefore = lineAnnotationsBefore.slice();
      lastEntry.lineAnnotationsAfter = lineAnnotationsAfter.slice();
    }
  }

  peekUndo(): EditStackEntry<EType, LAnnotation> | undefined {
    return this.#undoStack[this.#undoStack.length - 1];
  }

  // The last undo entry, only while its coalescing group is open.
  peekUndoForCoalescing(): EditStackEntry<EType, LAnnotation> | undefined {
    return this.#canCoalesce ? this.peekUndo() : undefined;
  }

  replaceLastUndo(entry: EditStackEntry<EType, LAnnotation>): void {
    if (this.#undoStack.length === 0) {
      this.push(entry);
      return;
    }
    this.#undoStack[this.#undoStack.length - 1] = entry;
    this.#redoStack.length = 0;
    this.#canCoalesce = true;
  }

  popUndoToRedo(): EditStackEntry<EType, LAnnotation> | void {
    const entry = this.#undoStack.pop();
    if (entry !== undefined) {
      this.#redoStack.push(entry);
      this.#canCoalesce = false;
      return entry;
    }
  }

  popRedoToUndo(): EditStackEntry<EType, LAnnotation> | void {
    const entry = this.#redoStack.pop();
    if (entry !== undefined) {
      this.#undoStack.push(entry);
      this.#canCoalesce = false;
      return entry;
    }
  }
}

export function createEditStackEntry<EType extends EditorType, LAnnotation>(
  textDocument: TextDocument<EType, LAnnotation>,
  resolvedEdits: ResolvedTextEdit[],
  versionBefore: number,
  versionAfter: number,
  selectionsBefore?: EditorSelection[],
  selectionsAfter?: EditorSelection[]
): EditStackEntry<EType, LAnnotation> {
  const forwardEdits = resolvedEdits
    .map((edit) => ({ ...edit }))
    .sort((a, b) => a.start - b.start);
  let coalescingMode: EditStackCoalescingMode | undefined;
  if (selectionsBefore?.length === forwardEdits.length) {
    const caretOffsets: number[] = [];
    for (const selection of selectionsBefore) {
      if (
        selection.start.line !== selection.end.line ||
        selection.start.character !== selection.end.character
      ) {
        break;
      }
      caretOffsets.push(textDocument.offsetAt(selection.start));
    }
    if (caretOffsets.length === forwardEdits.length) {
      caretOffsets.sort((a, b) => a - b);
      let isBackspace = true;
      let isDelete = true;
      for (let i = 0; i < forwardEdits.length; i++) {
        const edit = forwardEdits[i];
        if (edit.text.length > 0 || edit.start === edit.end) {
          isBackspace = false;
          isDelete = false;
          break;
        }
        isBackspace &&= caretOffsets[i] === edit.end;
        isDelete &&= caretOffsets[i] === edit.start;
      }
      coalescingMode = isBackspace
        ? 'backspace'
        : isDelete
          ? 'delete'
          : undefined;
    }
  }
  return {
    forwardEdits,
    inverseEdits: buildInverseEdits(
      forwardEdits,
      forwardEdits.map((edit) =>
        textDocument.getTextSlice(edit.start, edit.end)
      )
    ),
    versionBefore,
    versionAfter,
    selectionsBefore: selectionsBefore?.map((selection) => ({
      ...selection,
    })),
    selectionsAfter: selectionsAfter?.map((selection) => ({ ...selection })),
    // Keep these keys so every entry has the same shape.
    lineAnnotationsBefore: undefined,
    lineAnnotationsAfter: undefined,
    coalescingMode,
  };
}

// Determines if the change matches one of these modes:
// - 'insert': simple typing
// - 'backspace': backward delete
// - 'delete': forward delete
export function shouldCoalesceEditStackEntry<
  EType extends EditorType,
  LAnnotation,
>(
  previousEntry: EditStackEntry<EType, LAnnotation> | undefined,
  nextEntry: EditStackEntry<EType, LAnnotation>
): boolean {
  if (
    previousEntry === undefined ||
    previousEntry.undoBoundary === true ||
    nextEntry.undoBoundary === true ||
    previousEntry.forwardEdits.length === 0 ||
    previousEntry.forwardEdits.length !== previousEntry.inverseEdits.length ||
    previousEntry.forwardEdits.length !== nextEntry.forwardEdits.length ||
    nextEntry.forwardEdits.length !== nextEntry.inverseEdits.length
  ) {
    return false;
  }
  let mode: EditStackCoalescingMode | undefined;
  for (let i = 0; i < previousEntry.forwardEdits.length; i++) {
    const previousForward = previousEntry.forwardEdits[i];
    const previousInverse = previousEntry.inverseEdits[i];
    const nextForward = nextEntry.forwardEdits[i];
    const nextInverse = nextEntry.inverseEdits[i];
    let nextMode: EditStackCoalescingMode;
    if (
      previousForward.start <= previousForward.end &&
      previousForward.text.length > 0 &&
      !previousForward.text.includes('\n') &&
      !previousInverse.text.includes('\n') &&
      nextForward.start === nextForward.end &&
      nextForward.text.length > 0 &&
      !nextForward.text.includes('\n') &&
      nextInverse.text.length === 0
    ) {
      // Merge only when the next insert starts exactly where the previous
      // inserted text ends, in after-edit offsets. `previousInverse.end` marks
      // that point, since undo replaces exactly the inserted range. A
      // base-offset check can't tell this apart from a caret that jumped to the
      // left edge: both edges of a pure insert map back to the same base offset,
      // so typing "a" then "b" at the left edge would merge as "ab" while the
      // buffer holds "ba", corrupting redo.
      if (nextForward.start !== previousInverse.end) {
        return false;
      }
      nextMode = 'insert';
    } else if (
      previousForward.text.length === 0 &&
      previousForward.end > previousForward.start &&
      previousInverse.text.length > 0 &&
      nextForward.text.length === 0 &&
      nextForward.end > nextForward.start &&
      nextInverse.text.length > 0
    ) {
      const mappedNextStart = mapOffsetAfterForwardBatchToBefore(
        nextForward.start,
        previousEntry.forwardEdits
      );
      if (mappedNextStart === previousForward.end) {
        nextMode = 'delete';
      } else if (
        mappedNextStart + (nextForward.end - nextForward.start) ===
        previousForward.start
      ) {
        nextMode = 'backspace';
      } else {
        return false;
      }
    } else {
      return false;
    }
    mode ??= nextMode;
    if (
      mode !== nextMode ||
      (previousEntry.coalescingMode ?? nextMode) !== nextMode ||
      (nextEntry.coalescingMode ?? nextMode) !== nextMode
    ) {
      return false;
    }
  }
  return mode !== undefined;
}

// Coalesces edit stack entries for simple typing and single-character deletes.
export function coalesceEditStackEntries<EType extends EditorType, LAnnotation>(
  previousEntry: EditStackEntry<EType, LAnnotation>,
  nextEntry: EditStackEntry<EType, LAnnotation>
): EditStackEntry<EType, LAnnotation> {
  const forwardEdits: ResolvedTextEdit[] = [];
  const replacedTexts: string[] = [];
  let coalescingMode: EditStackCoalescingMode | undefined;
  for (let i = 0; i < previousEntry.forwardEdits.length; i++) {
    const previousForward = previousEntry.forwardEdits[i];
    const previousInverse = previousEntry.inverseEdits[i];
    const nextForward = nextEntry.forwardEdits[i];
    const nextInverse = nextEntry.inverseEdits[i];

    if (previousForward.text.length > 0) {
      coalescingMode ??= 'insert';
      forwardEdits.push({
        start: previousForward.start,
        end: previousForward.end,
        text: previousForward.text + nextForward.text,
      });
      replacedTexts.push(previousInverse.text);
      continue;
    }

    const mappedNextStart = mapOffsetAfterForwardBatchToBefore(
      nextForward.start,
      previousEntry.forwardEdits
    );
    if (mappedNextStart === previousForward.end) {
      coalescingMode ??= 'delete';
      forwardEdits.push({
        start: previousForward.start,
        end: mappedNextStart + (nextForward.end - nextForward.start),
        text: '',
      });
      replacedTexts.push(previousInverse.text + nextInverse.text);
      continue;
    }

    coalescingMode ??= 'backspace';
    forwardEdits.push({
      start: Math.min(previousForward.start, mappedNextStart),
      end: previousForward.end,
      text: '',
    });
    replacedTexts.push(nextInverse.text + previousInverse.text);
  }

  return {
    forwardEdits,
    inverseEdits: buildInverseEdits(forwardEdits, replacedTexts),
    versionBefore: previousEntry.versionBefore,
    versionAfter: nextEntry.versionAfter,
    selectionsBefore: previousEntry.selectionsBefore?.slice(),
    selectionsAfter: nextEntry.selectionsAfter?.slice(),
    lineAnnotationsBefore: previousEntry.lineAnnotationsBefore?.slice(),
    lineAnnotationsAfter: nextEntry.lineAnnotationsAfter?.slice(),
    coalescingMode,
  };
}

function buildInverseEdits(
  forwardEdits: readonly ResolvedTextEdit[],
  replacedTexts: readonly string[]
): ResolvedTextEdit[] {
  const inverseEdits: ResolvedTextEdit[] = [];
  for (let i = 0, offsetDelta = 0; i < forwardEdits.length; i++) {
    const edit = forwardEdits[i];
    const startAfterEdit = edit.start + offsetDelta;
    inverseEdits.push({
      start: startAfterEdit,
      end: startAfterEdit + edit.text.length,
      text: replacedTexts[i],
    });
    offsetDelta += edit.text.length - (edit.end - edit.start);
  }
  return inverseEdits;
}

function mapOffsetAfterForwardBatchToBefore(
  offsetAfter: number,
  forwardEdits: readonly ResolvedTextEdit[]
): number {
  let offset = offsetAfter;
  for (const edit of forwardEdits) {
    const oldLength = edit.end - edit.start;
    if (offset >= edit.start + edit.text.length) {
      offset -= edit.text.length - oldLength;
    } else if (offset >= edit.start) {
      offset = edit.start + Math.min(offset - edit.start, oldLength);
    }
  }
  return offset;
}
