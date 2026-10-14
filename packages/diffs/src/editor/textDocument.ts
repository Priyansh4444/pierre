import { countLineBreaks } from '../utils/computeFileOffsets';
import {
  coalesceEditStackEntries,
  createEditStackEntry,
  EditStack,
  shouldCoalesceEditStackEntry,
} from './editStack';
import { PieceTable } from './pieceTable';
import type { SearchParams } from './searchPanel';
import { setTextDocumentChangeTransaction } from './textDocumentChangeTransaction';
import type {
  EditHistoryState,
  EditorChange,
  EditorLineAnnotation,
  EditorSelection,
  EditorType,
  Position,
  Range,
  ResolvedTextEdit,
  TextEdit,
} from './types';

export type { Position, Range, TextEdit } from './types';

export interface TextDocumentChange {
  /** The edits that were applied to the text document. */
  readonly changes: EditorChange[];
  /** First line whose rendered content or tokenizer state may have changed. */
  readonly startLine: number;
  /** Character on the first changed line where the edit began. */
  readonly startCharacter: number;
  /** Character on the original last changed line where the edit ended. */
  readonly endCharacter: number;
  /** Last line whose rendered content may have changed after the edit. */
  readonly endLine: number;
  /** Whether the original edit range ended at the previous document EOF. */
  readonly endedAtDocumentEnd: boolean;
  /** Line count before the edit was applied. */
  readonly previousLineCount: number;
  /** Line count after the edit was applied. */
  readonly lineCount: number;
  /** Difference between the old and new line counts. */
  readonly lineDelta: number;
  /** Exact rendered line ranges touched by each edit after the edit was applied. */
  readonly changedLineRanges: readonly [startLine: number, endLine: number][];
  /** Per-edit rendered line ranges before adjacent ranges are coalesced. */
  readonly changedLineChanges?: readonly [
    startLine: number,
    endLine: number,
    lineDelta: number,
    startCharacter?: number,
    endCharacter?: number,
    endedAtDocumentEnd?: boolean,
  ][];
}

// Metadata-less replay results include the resolved edits so Editor can remap
// its live selections without storing a snapshot on the history entry.
type TextDocumentHistoryResult<EType extends EditorType, LAnnotation> = [
  change: TextDocumentChange,
  selections?: EditorSelection[],
  lineAnnotations?: EditorLineAnnotation<EType, LAnnotation>[],
  selectionEdits?: ResolvedTextEdit[],
];

/**
 * A vscode-languageserver-textdocument compatible text document.
 */
export class TextDocument<
  EType extends EditorType = EditorType,
  LAnnotation = unknown,
> {
  #uri: string;
  #languageId: string;
  #version: number;
  #pieceTable: PieceTable;
  #editStack: EditStack<EType, LAnnotation>;
  #eol: '\n' | '\r\n' | '\r';

  constructor(
    uri: string,
    text: string,
    languageId = 'text',
    version = 0,
    editStack: EditStack<EType, LAnnotation> = new EditStack(),
    eol?: '\n' | '\r\n' | '\r'
  ) {
    this.#uri = new URL(uri, 'file://').toString();
    this.#languageId = languageId;
    this.#version = version;
    this.#pieceTable = new PieceTable(text);
    this.#editStack = editStack;

    // The line ending the document uses, detected once from its first line. Lets
    // inserted or pasted text match the rest of the file instead of leaving
    // mixed endings behind and keeps that convention stable as the file is
    // edited. Defaults to Unix `\n` when the initial text has no line break.
    if (eol == null) {
      const firstLine = this.#pieceTable.getLineText(0, true);
      eol = firstLine.endsWith('\r\n')
        ? '\r\n'
        : firstLine.endsWith('\r')
          ? '\r'
          : '\n';
    }
    this.#eol = eol;
  }

  get uri(): string {
    return this.#uri;
  }

  get languageId(): string {
    return this.#languageId;
  }

  get version(): number {
    return this.#version;
  }

  get lineCount(): number {
    return this.#pieceTable.lineCount;
  }

  get eol(): '\n' | '\r\n' | '\r' {
    return this.#eol;
  }

  get history(): EditHistoryState<EType, LAnnotation> {
    return this.#editStack.getLiveState();
  }

  get canUndo(): boolean {
    return this.#editStack.canUndo;
  }

  get canRedo(): boolean {
    return this.#editStack.canRedo;
  }

  /** Clear undo and redo history without changing the document contents. */
  clearHistory(): void {
    this.#editStack.clear();
  }

  positionAt(offset: number): Position {
    return this.normalizePosition(this.#pieceTable.positionAt(offset));
  }

  positionsAt(offsets: readonly number[]): Position[] {
    return offsets.map((offset) => this.positionAt(offset));
  }

  offsetAt(position: Position): number {
    return this.#pieceTable.offsetAt(this.normalizePosition(position));
  }

  getText(range?: Range): string {
    if (range === undefined) {
      return this.#pieceTable.getText();
    }
    // Clamp the range to visible line content before extracting text. A
    // preserved vertical-move "goal column" can leave a selection focus whose
    // character overshoots a shorter line; without this, the piece table clamps
    // to the line's offset span (which includes the trailing line break) and
    // copy/cut would pull in that newline. Mirrors `offsetAt`, which normalizes
    // positions the same way.
    return this.#pieceTable.getText({
      start: this.normalizePosition(range.start),
      end: this.normalizePosition(range.end),
    });
  }

  getLineText(line: number, includeLineBreak?: boolean): string {
    return this.#pieceTable.getLineText(line, includeLineBreak);
  }

  // Rewrites every line break in `text` to the document's EOL. Clipboard text
  // can carry Windows (`\r\n`) or classic-Mac (`\r`) breaks; inserting it
  // verbatim would leave mixed line endings in a file that uses one style.
  normalizeEol(text: string): string {
    return text.replace(/\r\n|\r|\n/g, this.eol);
  }

  getLineLength(line: number, includeLineBreak?: boolean): number {
    return this.#pieceTable.getLineLength(line, includeLineBreak);
  }

  charAt(offset: number): string;
  charAt(position: Position): string;
  charAt(positionOrOffset: Position | number): string {
    return this.#pieceTable.charAt(
      typeof positionOrOffset === 'number'
        ? positionOrOffset
        : this.offsetAt(positionOrOffset)
    );
  }

  getTextSlice(start: number, end: number): string {
    return this.#pieceTable.getTextSlice(start, end);
  }

  findNextNonOverlappingSubstring(
    needle: string,
    occupied: readonly [start: number, end: number][]
  ): number | undefined {
    return this.#pieceTable.findNextNonOverlappingSubstring(needle, occupied);
  }

  search(searchParams: SearchParams): [start: number, end: number][] {
    return this.#pieceTable.search(searchParams);
  }

  applyEdits(
    edits: TextEdit[],
    updateHistory = true,
    selectionsBefore?: EditorSelection[],
    selectionsAfter?: EditorSelection[],
    undoBoundary = false
  ): TextDocumentChange | undefined {
    if (edits.length === 0) {
      return;
    }
    return this.#applyResolvedEdits(
      this.resolveEdits(edits),
      updateHistory,
      selectionsBefore,
      selectionsAfter,
      undoBoundary
    );
  }

  // Converts line/character ranges to the exact UTF-16 offsets applyEdits
  // uses, including widening invalid boundaries so they cannot split a valid
  // surrogate pair. Editor caret remapping uses the same resolved geometry.
  resolveEdits(edits: readonly TextEdit[]): ResolvedTextEdit[] {
    return edits.map((edit) => {
      const start = this.offsetAt(edit.range.start);
      const end = this.offsetAt(edit.range.end);
      return this.#normalizeResolvedEdit({
        start: Math.min(start, end),
        end: Math.max(start, end),
        text: edit.newText,
      });
    });
  }

  applyResolvedEdits(
    edits: ResolvedTextEdit[],
    updateHistory = true,
    selectionsBefore?: EditorSelection[],
    selectionsAfter?: EditorSelection[],
    undoBoundary = false
  ): TextDocumentChange | undefined {
    if (edits.length === 0) {
      return undefined;
    }
    return this.#applyResolvedEdits(
      edits.map((edit) => this.#normalizeResolvedEdit(edit)),
      updateHistory,
      selectionsBefore,
      selectionsAfter,
      undoBoundary
    );
  }

  // Every edit joins the undo timeline: an edit applied with
  // `updateHistory=false` affects the edit stack exactly as the identical
  // call with `updateHistory=true` and no selections or undo boundary would.
  // The flag only controls whether the caller's interaction metadata is
  // recorded on the entry; the entry itself is always pushed (clearing any
  // pending redo) and coalesces by the normal geometry rules. This keeps a
  // mixed tracked/untracked sequence equivalent to the all-tracked sequence —
  // undo-to-exhaustion restores the original text, redo-to-exhaustion the
  // final text — instead of leaving frozen entries whose offsets go stale.
  // Only history replay (undo/redo) writes to the buffer without recording.
  #applyResolvedEdits(
    resolvedEdits: ResolvedTextEdit[],
    updateHistory: boolean,
    selectionsBefore: EditorSelection[] | undefined,
    selectionsAfter: EditorSelection[] | undefined,
    undoBoundary: boolean
  ): TextDocumentChange {
    // Sorts in place; callers pass a fresh array. Zero-width edits go before
    // ranges at the same start so validation and application do not depend on
    // the caller's batch order.
    resolvedEdits.sort((a, b) => {
      const startDelta = a.start - b.start;
      return startDelta === 0 ? a.end - b.end : startDelta;
    });
    for (let i = 0; i < resolvedEdits.length - 1; i++) {
      if (resolvedEdits[i].end > resolvedEdits[i + 1].start) {
        throw new Error('Overlapping text edits are not supported');
      }
    }
    const entry = createEditStackEntry(
      this,
      resolvedEdits,
      this.#version,
      this.#version + 1,
      updateHistory ? selectionsBefore : undefined,
      updateHistory ? selectionsAfter : undefined
    );
    if (updateHistory && undoBoundary) {
      entry.undoBoundary = true;
    }
    const previousEntry = this.#editStack.peekUndoForCoalescing();
    const change = this.#applyResolvedEditsToBuffer(resolvedEdits);
    this.#version++;
    if (
      change.lineDelta === 0 &&
      shouldCoalesceEditStackEntry(previousEntry, entry)
    ) {
      this.#editStack.replaceLastUndo(
        coalesceEditStackEntries(previousEntry!, entry)
      );
    } else {
      this.#editStack.push(entry);
    }
    setTextDocumentChangeTransaction(change, {
      appliedEdits: entry.forwardEdits,
      inverseEdits: entry.inverseEdits,
    });
    return change;
  }

  setLastUndoSelectionsAfter(selections: EditorSelection[]): void {
    this.#editStack.setLastUndoSelectionsAfter(selections);
  }

  setLastUndoLineAnnotations(
    lineAnnotationsBefore: EditorLineAnnotation<EType, LAnnotation>[],
    lineAnnotationsAfter: EditorLineAnnotation<EType, LAnnotation>[]
  ): void {
    this.#editStack.setLastUndoLineAnnotations(
      lineAnnotationsBefore,
      lineAnnotationsAfter
    );
  }

  undo(): TextDocumentHistoryResult<EType, LAnnotation> | undefined {
    const entry = this.#editStack.popUndoToRedo();
    return entry === undefined
      ? undefined
      : this.#replay(
          entry.inverseEdits,
          entry.forwardEdits,
          entry.versionBefore,
          entry.selectionsBefore,
          entry.lineAnnotationsBefore
        );
  }

  redo(): TextDocumentHistoryResult<EType, LAnnotation> | undefined {
    const entry = this.#editStack.popRedoToUndo();
    return entry === undefined
      ? undefined
      : this.#replay(
          entry.forwardEdits,
          entry.inverseEdits,
          entry.versionAfter,
          entry.selectionsAfter,
          entry.lineAnnotationsAfter
        );
  }

  // Writes one side of a history entry to the buffer without recording it;
  // undo and redo differ only in which side they pass.
  #replay(
    appliedEdits: ResolvedTextEdit[],
    inverseEdits: ResolvedTextEdit[],
    version: number,
    selections: EditorSelection[] | undefined,
    lineAnnotations: EditorLineAnnotation<EType, LAnnotation>[] | undefined
  ): TextDocumentHistoryResult<EType, LAnnotation> {
    const change = this.#applyResolvedEditsToBuffer(appliedEdits);
    setTextDocumentChangeTransaction(change, { appliedEdits, inverseEdits });
    this.#version = version;
    return [
      change,
      selections?.slice(),
      lineAnnotations?.slice(),
      selections === undefined
        ? appliedEdits.map((edit) => ({ ...edit }))
        : undefined,
    ];
  }

  normalizePosition(position: Position): Position {
    const line = TextDocument.#clampIndex(position.line, this.lineCount - 1);
    return {
      line,
      character: TextDocument.#clampIndex(
        position.character,
        this.getLineLength(line)
      ),
    };
  }

  // Math.min/max pass NaN through, and a fractional index breaks the
  // integer-keyed line-offset lookup — either way the resolved offset becomes
  // NaN and a degenerate edit range can swallow the whole document. Malformed
  // components clamp like any other out-of-range value: NaN and -Infinity act
  // as 0, fractions floor, +Infinity clamps to the max.
  static #clampIndex(value: number, max: number): number {
    if (Number.isNaN(value)) {
      return 0;
    }
    return Math.max(0, Math.min(Math.floor(value), max));
  }

  // Snaps an insertion before a pair and widens replacement boundaries
  // outward, so every edit addresses whole UTF-16 surrogate pairs.
  #normalizeResolvedEdit(edit: ResolvedTextEdit): ResolvedTextEdit {
    let { start, end } = edit;
    const isInsertion = start === end;
    if (this.#isInsideSurrogatePair(start)) {
      start--;
    }
    if (isInsertion) {
      end = start;
    } else if (this.#isInsideSurrogatePair(end)) {
      end++;
    }
    return { start, end, text: edit.text };
  }

  // A UTF-16 offset is invalid when it sits between the high and low units of
  // one well-formed surrogate pair. Lone surrogate units remain addressable.
  #isInsideSurrogatePair(offset: number): boolean {
    const previous = this.#pieceTable.charAt(offset - 1).charCodeAt(0);
    const next = this.#pieceTable.charAt(offset).charCodeAt(0);
    return (
      previous >= 0xd800 &&
      previous <= 0xdbff &&
      next >= 0xdc00 &&
      next <= 0xdfff
    );
  }

  #applyResolvedEditsToBuffer(edits: ResolvedTextEdit[]): TextDocumentChange {
    const pieceTable = this.#pieceTable;
    const previousLineCount = pieceTable.lineCount;
    const previousLastLine = previousLineCount - 1;
    const previousLastLineLength = pieceTable.getLineLength(previousLastLine);
    const editPositions = this.positionsAt(
      edits.flatMap((edit) => [edit.start, edit.end])
    );
    const changes: EditorChange[] = [];
    const changedLineRanges: [number, number][] = [];
    const changedLineChanges: [
      startLine: number,
      endLine: number,
      lineDelta: number,
      startCharacter: number,
      endCharacter: number,
      endedAtDocumentEnd: boolean,
    ][] = [];
    let startLine = Infinity;
    let endLine = 0;
    let lineDeltaBeforeEdit = 0;
    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i];
      const start = editPositions[i * 2];
      const end = editPositions[i * 2 + 1];
      const insertedLineSpan = countLineBreaks(edit.text);
      const changedStartLine = start.line + lineDeltaBeforeEdit;
      const changedEndLine = changedStartLine + insertedLineSpan;
      const lineDelta = insertedLineSpan - (end.line - start.line);
      startLine = Math.min(startLine, start.line);
      endLine = Math.max(endLine, changedEndLine);
      const lastRange = changedLineRanges[changedLineRanges.length - 1];
      if (lastRange !== undefined && changedStartLine <= lastRange[1] + 1) {
        lastRange[1] = Math.max(lastRange[1], changedEndLine);
      } else {
        changedLineRanges.push([changedStartLine, changedEndLine]);
      }
      changedLineChanges.push([
        changedStartLine,
        changedEndLine,
        lineDelta,
        start.character,
        end.character,
        end.line === previousLastLine &&
          end.character === previousLastLineLength,
      ]);
      changes.push({ ...edit, range: { start, end } });
      lineDeltaBeforeEdit += lineDelta;
    }
    const endPosition = editPositions[editPositions.length - 1];
    pieceTable.applyEdits(edits);
    const lineCount = pieceTable.lineCount;
    return {
      changes,
      startLine,
      startCharacter: editPositions[0].character,
      endCharacter: endPosition.character,
      endLine: Math.min(endLine, lineCount - 1),
      endedAtDocumentEnd:
        endPosition.line === previousLastLine &&
        endPosition.character === previousLastLineLength,
      previousLineCount,
      lineCount,
      lineDelta: lineCount - previousLineCount,
      changedLineRanges,
      changedLineChanges,
    };
  }
}
