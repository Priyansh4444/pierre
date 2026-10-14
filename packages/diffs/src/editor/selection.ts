import { applyDocumentChangeToLineAnnotations } from './lineAnnotations';
import type { TextDocument, TextDocumentChange } from './textDocument';
import type {
  EditorLineAnnotation,
  EditorSelection,
  EditorType,
  Position,
  Range,
  ResolvedTextEdit,
  SelectionDirection,
  TextEdit,
} from './types';
import {
  createSegmenter,
  endsWithLineBreak,
  getGraphemeSegmenter,
  getLineNumberAttr,
} from './utils';

export const DirectionBackward = -1;
export const DirectionNone = 0;
export const DirectionForward = 1;

const AUTO_SURROUND_CLOSE_CHARS = new Map([
  ["'", "'"],
  ['"', '"'],
  ['`', '`'],
  ['{', '}'],
  ['[', ']'],
  ['<', '>'],
  ['(', ')'],
]);

export interface CursorMoveOptions {
  getSoftLineOffsets?: (line: number) => ArrayLike<number> | undefined;
  /**
   * Fold-skip resolver for vertical motion crossing document lines: the
   * nearest renderable line at or beyond the target in the move direction,
   * or undefined when everything that way is hidden inside a collapsed
   * region (the caret then stays put). Soft-line moves within one document
   * line never consult it.
   */
  resolveRenderableLine?: ResolveRenderableLine;
}

interface SoftLineInfo {
  start: number;
  end: number;
  index: number;
  count: number;
}

export function convertSelection(
  range: StaticRange,
  direction: SelectionDirection = DirectionNone
): EditorSelection | undefined {
  const start = boundaryToPosition(range.startContainer, range.startOffset);
  const end = boundaryToPosition(range.endContainer, range.endOffset);
  if (start === null || end === null) {
    return undefined;
  }
  return { start, end, direction };
}

export function resolveIndentEdits(
  textDocument: TextDocument,
  selection: EditorSelection,
  tabSize: number,
  outdent: boolean
): [edits: TextEdit[], nextSelection: EditorSelection] {
  const { start, end } = selection;
  const edits: TextEdit[] = [];
  let nextStart = start;
  let nextEnd = end;
  const blockIndent = start.line !== end.line;
  let endLine = end.line;
  if (start.line < end.line && end.character === 0) {
    endLine--;
  }
  for (let line = start.line; line <= endLine; line++) {
    const lineText = textDocument.getLineText(line);
    if (blockIndent && lineText.trim().length === 0) {
      continue;
    }
    const indentUnit = lineText.startsWith('\t') ? '\t' : ' '.repeat(tabSize);
    let deleteLength = 0;
    let newText = indentUnit;
    if (outdent) {
      if (lineText.startsWith('\t')) {
        deleteLength = 1;
      } else if (lineText.startsWith(' ')) {
        const leadingSpacesLength =
          lineText.length - lineText.trimStart().length;
        deleteLength = Math.min(indentUnit.length, leadingSpacesLength);
      }
      if (deleteLength === 0) {
        continue;
      }
      newText = '';
    }
    edits.push({
      range: {
        start: { line, character: 0 },
        end: { line, character: deleteLength },
      },
      newText,
    });
    const delta = newText.length - deleteLength;
    if (line === start.line) {
      nextStart = { ...start, character: Math.max(0, start.character + delta) };
    }
    if (line === end.line) {
      nextEnd = { ...end, character: Math.max(0, end.character + delta) };
    }
  }
  return [edits, { ...selection, start: nextStart, end: nextEnd }];
}

/**
 * The nearest zero-based document line at or beyond `line` in `direction`
 * that has a rendered row, or undefined when everything that way is hidden
 * inside a collapsed region. Vertical caret motion uses it to skip collapsed
 * regions atomically, like code folds.
 */
export type ResolveRenderableLine = (
  line: number,
  direction: 'up' | 'down'
) => number | undefined;

export function mapCursorMove(
  textDocument: TextDocument,
  selections: EditorSelection[],
  shortcut: 'textStart' | 'start' | 'end' | 'up' | 'down' | 'left' | 'right',
  options: CursorMoveOptions = {}
): EditorSelection[] {
  const lineCount = textDocument.lineCount;
  const resolveLine: ResolveRenderableLine =
    options.resolveRenderableLine ?? ((line) => line);
  return selections.map((selection) => {
    let { line, character } =
      shortcut === 'up' || shortcut === 'left'
        ? selection.start
        : selection.end;
    if (
      shortcut === 'textStart' ||
      shortcut === 'start' ||
      shortcut === 'end'
    ) {
      const caret = getCaretPosition(selection);
      line = caret.line;
      character = caret.character;
      const softLine = getSoftLineInfo(textDocument, line, character, options);
      if (shortcut === 'textStart') {
        const softLineText = textDocument
          .getLineText(line)
          .slice(softLine.start, softLine.end);
        const indent = softLine.start + getLeadingSpaces(softLineText);
        character = character === indent ? softLine.start : indent;
      } else {
        character = shortcut === 'start' ? softLine.start : softLine.end;
      }
    } else if (shortcut === 'up') {
      const moved = moveBySoftLine(textDocument, line, character, -1, options);
      if (moved !== undefined) {
        line = moved.line;
        character = moved.character;
      } else if (line > 0) {
        // Fold-skip: when the line above is collapsed, jump to the nearest
        // renderable line above it; stay put when nothing above renders.
        line = resolveLine(line - 1, 'up') ?? line;
      }
    } else if (shortcut === 'down') {
      const moved = moveBySoftLine(textDocument, line, character, 1, options);
      if (moved !== undefined) {
        line = moved.line;
        character = moved.character;
      } else if (line < lineCount - 1) {
        line = Math.min(resolveLine(line + 1, 'down') ?? line, lineCount - 1);
      }
    } else if (isCollapsedSelection(selection)) {
      const lineLength = textDocument.getLineLength(line);
      character = Math.min(character, lineLength);
      if (shortcut === 'left') {
        if (character > 0) {
          // Step left by a whole grapheme so the caret never lands inside an
          // emoji or other multi-code-unit character.
          character = stepCharacterByGrapheme(
            textDocument,
            line,
            character,
            false
          );
        } else if (line > 0) {
          // Fold-skip: land at the end of the nearest renderable line above;
          // stay put when everything above is collapsed.
          const targetLine = resolveLine(line - 1, 'up');
          if (targetLine !== undefined) {
            line = targetLine;
            character = textDocument.getLineLength(line);
          }
        }
      } else if (character < lineLength) {
        character = stepCharacterByGrapheme(
          textDocument,
          line,
          character,
          true
        );
      } else if (line < lineCount - 1) {
        // Fold-skip: land at the start of the nearest renderable line below;
        // stay put when everything below is collapsed.
        const targetLine = resolveLine(line + 1, 'down');
        if (targetLine !== undefined) {
          line = Math.min(targetLine, lineCount - 1);
          character = 0;
        }
      }
    }
    const pos = { line, character };
    return {
      start: pos,
      end: pos,
      direction: DirectionNone,
    };
  });
}

function moveBySoftLine(
  textDocument: TextDocument,
  line: number,
  character: number,
  direction: -1 | 1,
  options: CursorMoveOptions
): Position | undefined {
  if (options.getSoftLineOffsets === undefined) {
    return undefined;
  }

  const current = getSoftLineInfo(textDocument, line, character, options);
  const targetIndex = current.index + direction;
  let targetLine = line;
  let target: SoftLineInfo;

  if (targetIndex >= 0 && targetIndex < current.count) {
    target = getSoftLineInfoAtIndex(
      textDocument.getLineLength(line),
      options.getSoftLineOffsets(line),
      targetIndex
    );
  } else {
    const nextLine = line + direction;
    if (nextLine < 0 || nextLine >= textDocument.lineCount) {
      return { line, character };
    }

    // Fold-skip: crossing to another document line skips collapsed regions;
    // when nothing renders in that direction the caret stays put.
    const resolvedLine =
      options.resolveRenderableLine == null
        ? nextLine
        : options.resolveRenderableLine(
            nextLine,
            direction < 0 ? 'up' : 'down'
          );
    if (resolvedLine === undefined) {
      return { line, character };
    }

    targetLine = Math.min(resolvedLine, textDocument.lineCount - 1);
    // Infinity clamps to the last soft line.
    target = getSoftLineInfoAtIndex(
      textDocument.getLineLength(targetLine),
      options.getSoftLineOffsets(targetLine),
      direction < 0 ? Infinity : 0
    );
  }

  const column = Math.max(0, character - current.start);
  const targetCharacter = target.start + column;
  const landedCharacter =
    target.index === target.count - 1
      ? targetCharacter
      : Math.min(targetCharacter, target.end);
  const targetLineText = textDocument.getLineText(targetLine);
  // Keep goal-column overshoots, but snap real offsets out of graphemes.
  return {
    line: targetLine,
    character:
      landedCharacter > targetLineText.length
        ? landedCharacter
        : snapCharacterToGraphemeBoundary(targetLineText, landedCharacter),
  };
}

// Snaps an editable position to the end of its grapheme so edits cannot split
// a user-visible character. Stop once the containing cluster is resolved.
export function snapCharacterToGraphemeBoundary(
  lineText: string,
  character: number
): number {
  if (character <= 0 || character >= lineText.length) {
    return character;
  }

  const segmenter = getGraphemeSegmenter();
  if (segmenter !== undefined) {
    for (const segment of segmenter.segment(lineText)) {
      if (character <= segment.index) {
        return character;
      }
      const segmentEnd = segment.index + segment.segment.length;
      if (character < segmentEnd) {
        return segmentEnd;
      }
    }
    return character;
  }

  // Degraded path for engines lacking Intl.Segmenter: preserve code points.
  let segmentStart = 0;
  for (const codePoint of lineText) {
    if (character <= segmentStart) {
      return character;
    }
    const segmentEnd = segmentStart + codePoint.length;
    if (character < segmentEnd) {
      return segmentEnd;
    }
    segmentStart = segmentEnd;
  }
  return character;
}

function getSoftLineInfo(
  textDocument: TextDocument,
  line: number,
  character: number,
  options: CursorMoveOptions
): SoftLineInfo {
  const lineLength = textDocument.getLineLength(line);
  const offsets = options.getSoftLineOffsets?.(line);
  if (offsets === undefined || offsets.length < 2) {
    return { start: 0, end: lineLength, index: 0, count: 1 };
  }

  for (let index = 0; index + 1 < offsets.length; index++) {
    const softLine = getSoftLineInfoAtIndex(lineLength, offsets, index);
    if (character >= softLine.start && character <= softLine.end) {
      return softLine;
    }
  }

  return getSoftLineInfoAtIndex(
    lineLength,
    offsets,
    character < (offsets[0] ?? 0) ? 0 : offsets.length - 2
  );
}

// Reads soft line `index`, clamped to the existing soft lines, from the wrap
// offsets of a line.
function getSoftLineInfoAtIndex(
  lineLength: number,
  offsets: ArrayLike<number> | undefined,
  index: number
): SoftLineInfo {
  if (offsets === undefined || offsets.length < 2) {
    return { start: 0, end: lineLength, index: 0, count: 1 };
  }

  const count = offsets.length - 1;
  const boundedIndex = Math.max(0, Math.min(index, count - 1));
  const start = Math.max(0, Math.min(lineLength, offsets[boundedIndex] ?? 0));
  const end = Math.max(
    start,
    Math.min(lineLength, offsets[boundedIndex + 1] ?? lineLength)
  );
  return { start, end, index: boundedIndex, count };
}

// Same as mapCursorMove, but with shift key pressed.
export function mapSelectionShift(
  textDocument: TextDocument,
  selections: EditorSelection[],
  shortcut: 'textStart' | 'start' | 'end' | 'up' | 'down' | 'left' | 'right',
  options: CursorMoveOptions = {}
): EditorSelection[] {
  return selections.map((selection) => {
    const focus = getCaretPosition(selection);
    const [movedFocusSelection] = mapCursorMove(
      textDocument,
      [{ start: focus, end: focus, direction: DirectionNone }],
      shortcut,
      options
    );
    return createSelectionFrom(selection, movedFocusSelection);
  });
}

// Converts selections to document offsets ordered by start, end, then index.
function getOrderedSelectionOffsets(
  textDocument: TextDocument,
  selections: EditorSelection[]
): { index: number; start: number; end: number }[] {
  const ordered: { index: number; start: number; end: number }[] = [];
  let isAlreadyOrdered = true;
  for (let index = 0; index < selections.length; index++) {
    const entry = {
      index,
      start: textDocument.offsetAt(selections[index].start),
      end: textDocument.offsetAt(selections[index].end),
    };
    const previous = ordered[index - 1];
    if (
      previous !== undefined &&
      (entry.start < previous.start ||
        (entry.start === previous.start && entry.end < previous.end))
    ) {
      isAlreadyOrdered = false;
    }
    ordered.push(entry);
  }
  if (!isAlreadyOrdered) {
    ordered.sort((a, b) => {
      if (a.start !== b.start) {
        return a.start - b.start;
      }
      return a.end !== b.end ? a.end - b.end : a.index - b.index;
    });
  }
  return ordered;
}

// Applies resolved edits for a selection command, then records the resulting
// selections and line annotations on the undo entry.
function applySelectionEdits<EType extends EditorType, LAnnotation>(
  textDocument: TextDocument<EType, LAnnotation>,
  selections: EditorSelection[],
  edits: ResolvedTextEdit[],
  nextOffsetPairs: [anchorOffset: number, focusOffset: number][],
  lineAnnotations: EditorLineAnnotation<EType, LAnnotation>[] | undefined,
  undoBoundary?: boolean
): { nextSelections: EditorSelection[]; change?: TextDocumentChange } {
  const change = textDocument.applyResolvedEdits(
    edits,
    true,
    selections,
    undefined,
    undoBoundary
  );
  const nextSelections = createSelectionsFromOffsetPairs(
    textDocument,
    nextOffsetPairs
  );
  textDocument.setLastUndoSelectionsAfter(nextSelections);
  if (change !== undefined && lineAnnotations !== undefined) {
    const nextLineAnnotations = applyDocumentChangeToLineAnnotations(
      change,
      lineAnnotations
    );
    if (nextLineAnnotations !== undefined) {
      textDocument.setLastUndoLineAnnotations(
        lineAnnotations,
        nextLineAnnotations
      );
    }
  }
  return { nextSelections, change };
}

export function applyTextChangeToSelections<
  EType extends EditorType,
  LAnnotation,
>(
  textDocument: TextDocument<EType, LAnnotation>,
  selections: EditorSelection[],
  edit: ResolvedTextEdit,
  lineAnnotations?: EditorLineAnnotation<EType, LAnnotation>[],
  tabSize = 2,
  undoBoundary = false
): {
  nextSelections: EditorSelection[];
  change?: TextDocumentChange;
} {
  const primarySelection = selections[selections.length - 1];
  if (primarySelection === undefined) {
    return { nextSelections: [] };
  }
  const ordered = getOrderedSelectionOffsets(textDocument, selections);
  const adjustedChange = normalizeLeadingIndentForChange(
    textDocument,
    edit,
    tabSize
  );
  const startDelta =
    adjustedChange.start - textDocument.offsetAt(primarySelection.start);
  const endDelta =
    adjustedChange.end - textDocument.offsetAt(primarySelection.end);
  const edits: ResolvedTextEdit[] = [];
  const nextOffsetPairs = Array.from<[number, number]>({
    length: selections.length,
  });
  let offsetDelta = 0;
  let mergedGroup:
    | { start: number; end: number; indices: number[] }
    | undefined;
  const finalizeMergedGroup = () => {
    if (mergedGroup === undefined) {
      return;
    }
    const { start, end, text } = normalizeLeadingIndentForChange(
      textDocument,
      {
        start: mergedGroup.start,
        end: mergedGroup.end,
        text: adjustedChange.text,
      },
      tabSize
    );
    const newText = expandSingleNewlineInsert(textDocument, text, start);
    edits.push({ start, end, text: newText });
    const caret = mergedGroup.start + offsetDelta + newText.length;
    const nextOffsets: [number, number] = [caret, caret];
    for (const index of mergedGroup.indices) {
      nextOffsetPairs[index] = nextOffsets;
    }
    offsetDelta += newText.length - (end - start);
  };
  for (const entry of ordered) {
    const startOffset = Math.max(0, entry.start + startDelta);
    const endOffset = Math.max(startOffset, entry.end + endDelta);
    if (mergedGroup !== undefined && startOffset < mergedGroup.end) {
      mergedGroup.end = Math.max(mergedGroup.end, endOffset);
      mergedGroup.indices.push(entry.index);
      continue;
    }
    finalizeMergedGroup();
    mergedGroup = {
      start: startOffset,
      end: endOffset,
      indices: [entry.index],
    };
  }
  finalizeMergedGroup();

  return applySelectionEdits(
    textDocument,
    selections,
    edits,
    nextOffsetPairs,
    lineAnnotations,
    undoBoundary
  );
}

// Applies text replacements to multiple selections. Texts pair by selection
// index unless they are explicitly marked as document ordered.
export function applyTextReplaceToSelections<
  EType extends EditorType,
  LAnnotation,
>(
  textDocument: TextDocument<EType, LAnnotation>,
  selections: EditorSelection[],
  texts: string[],
  lineAnnotations?: EditorLineAnnotation<EType, LAnnotation>[],
  undoBoundary = false,
  textOrder: 'selection' | 'document' = 'selection'
): {
  nextSelections: EditorSelection[];
  change?: TextDocumentChange;
} {
  if (selections.length !== texts.length) {
    throw new Error(
      'Selection text replacements must match the selection count'
    );
  }
  const ordered = getOrderedSelectionOffsets(textDocument, selections);
  const edits: ResolvedTextEdit[] = [];
  const nextOffsetPairs = Array.from<[number, number]>({
    length: selections.length,
  });
  if (texts.every((text) => text === '')) {
    for (const entry of ordered) {
      if (entry.start >= entry.end) {
        continue;
      }
      const last = edits[edits.length - 1];
      if (last !== undefined && entry.start < last.end) {
        edits[edits.length - 1] = {
          start: last.start,
          end: Math.max(last.end, entry.end),
          text: '',
        };
      } else {
        edits.push({ start: entry.start, end: entry.end, text: '' });
      }
    }
    if (edits.length === 0) {
      return { nextSelections: selections };
    }
    for (const entry of ordered) {
      const next = remapOffsetThroughEdits(entry.end, edits);
      nextOffsetPairs[entry.index] = [next, next];
    }
  } else {
    let offsetDelta = 0;
    for (let index = 0; index < ordered.length; index++) {
      const entry = ordered[index];
      if (index > 0 && entry.start < ordered[index - 1].end) {
        throw new Error('Overlapping multi-selection edits are not supported');
      }
      const newText = expandSingleNewlineInsert(
        textDocument,
        texts[textOrder === 'document' ? index : entry.index],
        entry.start
      );
      edits.push({ start: entry.start, end: entry.end, text: newText });
      const insertStart = entry.start + offsetDelta;
      let nextOffsets: [number, number] = [
        insertStart + newText.length,
        insertStart + newText.length,
      ];
      // When the new text still contains the replaced text (auto-surround),
      // reselect it like VS Code/CodeMirror. Check the exact surround first so
      // the substring search cannot match the new opening delimiter instead.
      if (entry.end > entry.start) {
        const originalText = textDocument.getTextSlice(entry.start, entry.end);
        const preservedOffset =
          newText.length === originalText.length + 2 &&
          AUTO_SURROUND_CLOSE_CHARS.get(newText[0]) ===
            newText[newText.length - 1] &&
          newText.slice(1, -1) === originalText
            ? 1
            : newText.indexOf(originalText);
        if (preservedOffset !== -1) {
          const rangeStart = insertStart + preservedOffset;
          nextOffsets = [rangeStart, rangeStart + originalText.length];
        }
      }
      nextOffsetPairs[entry.index] = nextOffsets;
      offsetDelta += newText.length - (entry.end - entry.start);
    }
  }
  return applySelectionEdits(
    textDocument,
    selections,
    edits,
    nextOffsetPairs,
    lineAnnotations,
    undoBoundary
  );
}

export type AutoSurround =
  | 'default'
  | 'never'
  | 'brackets'
  | 'quotes'
  | 'languageDefined';

// Returns per-selection replacement text when typing a surround character over
// non-collapsed selections, matching VS Code auto-surround behavior.
export function getAutoSurroundReplacementTexts(
  textDocument: TextDocument,
  selections: EditorSelection[],
  char: string,
  autoSurround?: AutoSurround
): string[] | undefined {
  const closeChar = AUTO_SURROUND_CLOSE_CHARS.get(char);
  const isQuote = char === "'" || char === '"' || char === '`';
  if (
    closeChar === undefined ||
    selections.length === 0 ||
    autoSurround === 'never' ||
    (autoSurround === 'brackets' && isQuote) ||
    (autoSurround === 'quotes' && !isQuote)
  ) {
    return undefined;
  }
  const replacements: string[] = [];
  for (const selection of selections) {
    if (isCollapsedSelection(selection)) {
      return undefined;
    }
    replacements.push(char + textDocument.getText(selection) + closeChar);
  }
  return replacements;
}

// Swaps the two characters adjacent to a collapsed selection, matching browser
// insertTranspose (Ctrl+T) behavior.
export function applyTransposeToSelections<
  EType extends EditorType,
  LAnnotation,
>(
  textDocument: TextDocument<EType, LAnnotation>,
  selections: EditorSelection[],
  lineAnnotations?: EditorLineAnnotation<EType, LAnnotation>[]
): {
  nextSelections: EditorSelection[];
  change?: TextDocumentChange;
} {
  const edits: ResolvedTextEdit[] = [];
  const nextOffsetPairs: Array<[number, number]> = [];

  for (const selection of selections) {
    const isBackward = selection.direction === DirectionBackward;
    const anchor = textDocument.offsetAt(
      isBackward ? selection.end : selection.start
    );
    const focus = textDocument.offsetAt(
      isBackward ? selection.start : selection.end
    );
    if (!isCollapsedSelection(selection)) {
      nextOffsetPairs.push([anchor, focus]);
      continue;
    }
    const { line, character } = selection.start;
    const lineText = textDocument.getLineText(line);
    const lineLength = lineText.length;
    // Document offset of column 0 on this line, used to translate the
    // grapheme-cluster columns below back into document offsets.
    const lineStart = anchor - character;
    const graphemeStarts = getLineGraphemeStarts(lineText);

    if (character > 0 && character < lineLength) {
      // Swap the whole grapheme before the caret with the one after it so a
      // surrogate pair (emoji) on either side is moved intact.
      const before = findClusterBreak(
        lineText,
        character,
        false,
        graphemeStarts
      );
      const after = findClusterBreak(lineText, character, true, graphemeStarts);
      edits.push({
        start: lineStart + before,
        end: lineStart + after,
        text:
          lineText.slice(character, after) + lineText.slice(before, character),
      });
      nextOffsetPairs.push([lineStart + after, lineStart + after]);
    } else if (character === lineLength && graphemeStarts.length >= 2) {
      // Swap the last two graphemes on the line.
      const lastStart = graphemeStarts[graphemeStarts.length - 1];
      const secondLastStart = graphemeStarts[graphemeStarts.length - 2];
      edits.push({
        start: lineStart + secondLastStart,
        end: anchor,
        text:
          lineText.slice(lastStart) +
          lineText.slice(secondLastStart, lastStart),
      });
      nextOffsetPairs.push([anchor, anchor]);
    } else if (character === 0 && line > 0 && lineLength > 0) {
      // Carry the previous line's last grapheme and this line's first grapheme
      // across the line break, swapping their order.
      const prevLineText = textDocument.getLineText(line - 1);
      const prevLength = prevLineText.length;
      const prevEnd = textDocument.offsetAt({
        line: line - 1,
        character: prevLength,
      });
      const prevGraphemeStart = findClusterBreak(
        prevLineText,
        prevLength,
        false,
        getLineGraphemeStarts(prevLineText)
      );
      const firstEnd = findClusterBreak(lineText, 0, true, graphemeStarts);
      const prevStart = prevEnd - (prevLength - prevGraphemeStart);
      const newText =
        lineText.slice(0, firstEnd) +
        textDocument.getTextSlice(prevEnd, anchor) +
        prevLineText.slice(prevGraphemeStart);
      edits.push({ start: prevStart, end: anchor + firstEnd, text: newText });
      const caret = prevStart + newText.length;
      nextOffsetPairs.push([caret, caret]);
    } else {
      nextOffsetPairs.push([anchor, focus]);
    }
  }

  if (edits.length === 0) {
    return { nextSelections: selections };
  }

  edits.sort((a, b) => a.start - b.start);
  for (let index = 1; index < edits.length; index++) {
    if (edits[index].start < edits[index - 1].end) {
      throw new Error('Overlapping multi-selection edits are not supported');
    }
  }
  return applySelectionEdits(
    textDocument,
    selections,
    edits,
    nextOffsetPairs,
    lineAnnotations
  );
}

// Deletes the range resolved for each selection.
function applyDeleteToSelections<EType extends EditorType, LAnnotation>(
  textDocument: TextDocument<EType, LAnnotation>,
  selections: EditorSelection[],
  lineAnnotations: EditorLineAnnotation<EType, LAnnotation>[] | undefined,
  resolveRange: (selection: EditorSelection) => [start: Position, end: Position]
): {
  nextSelections: EditorSelection[];
  change?: TextDocumentChange;
} {
  const deleteSelections = selections.map((selection): EditorSelection => {
    const [start, end] = resolveRange(selection);
    return { start, end, direction: DirectionNone };
  });
  return applyTextReplaceToSelections(
    textDocument,
    deleteSelections,
    deleteSelections.map(() => ''),
    lineAnnotations
  );
}

// Deletes from each selection to the end of its line, including the line break
// when the caret is already at the end of a non-final line. Non-collapsed
// selections delete their selected text instead.
export function applyDeleteHardLineForwardToSelections<
  EType extends EditorType,
  LAnnotation,
>(
  textDocument: TextDocument<EType, LAnnotation>,
  selections: EditorSelection[],
  lineAnnotations?: EditorLineAnnotation<EType, LAnnotation>[]
): {
  nextSelections: EditorSelection[];
  change?: TextDocumentChange;
} {
  return applyDeleteToSelections(
    textDocument,
    selections,
    lineAnnotations,
    (selection) => {
      if (!isCollapsedSelection(selection)) {
        return [selection.start, selection.end];
      }
      const { line, character } = selection.start;
      const lineLength = textDocument.getLineText(line).length;
      if (character < lineLength) {
        return [
          { line, character },
          { line, character: lineLength },
        ];
      }
      if (line < textDocument.lineCount - 1) {
        return [
          { line, character },
          { line: line + 1, character: 0 },
        ];
      }
      return [
        { line, character },
        { line, character },
      ];
    }
  );
}

// Deletes from each selection back to the start of its soft (visual) line.
// Non-collapsed selections delete their selected text instead.
export function applyDeleteSoftLineBackwardToSelections<
  EType extends EditorType,
  LAnnotation,
>(
  textDocument: TextDocument<EType, LAnnotation>,
  selections: EditorSelection[],
  getSoftLineStart?: (line: number, character: number) => number,
  lineAnnotations?: EditorLineAnnotation<EType, LAnnotation>[]
): {
  nextSelections: EditorSelection[];
  change?: TextDocumentChange;
} {
  return applyDeleteToSelections(
    textDocument,
    selections,
    lineAnnotations,
    (selection) => {
      if (!isCollapsedSelection(selection)) {
        return [selection.start, selection.end];
      }
      const caret = getCaretPosition(selection);
      const { line, character } = caret;
      const softLineStart = getSoftLineStart?.(line, character) ?? 0;
      if (character > softLineStart) {
        return [
          { line, character: softLineStart },
          { line, character },
        ];
      }
      if (line === 0) {
        return [caret, caret];
      }
      return [
        { line: line - 1, character: textDocument.getLineLength(line - 1) },
        { line, character: 0 },
      ];
    }
  );
}

// Deletes the word or separator group immediately before each selection.
// Non-collapsed selections delete their selected text instead.
export function applyDeleteWordBackwardToSelections<
  EType extends EditorType,
  LAnnotation,
>(
  textDocument: TextDocument<EType, LAnnotation>,
  selections: EditorSelection[],
  lineAnnotations?: EditorLineAnnotation<EType, LAnnotation>[]
): {
  nextSelections: EditorSelection[];
  change?: TextDocumentChange;
} {
  return applyDeleteToSelections(
    textDocument,
    selections,
    lineAnnotations,
    (selection) => {
      if (!isCollapsedSelection(selection)) {
        return [selection.start, selection.end];
      }
      const caret = getCaretPosition(selection);
      const { line, character: head } = caret;
      if (head === 0) {
        if (line === 0) {
          return [caret, caret];
        }
        return [
          { line: line - 1, character: textDocument.getLineLength(line - 1) },
          { line, character: 0 },
        ];
      }
      const lineText = textDocument.getLineText(line);
      const graphemeStarts = getLineGraphemeStarts(lineText);
      let pos = head;
      let match: number | undefined;
      while (pos > 0) {
        const prev = findClusterBreak(lineText, pos, false, graphemeStarts);
        const nextChar = lineText.slice(prev, pos);
        const nextMatch = !/\S/.test(nextChar)
          ? 0
          : /\p{Alphabetic}|\p{Number}|_/u.test(nextChar)
            ? 1
            : 2;
        if (match !== undefined && nextMatch !== match) {
          break;
        }
        if (nextMatch !== 0 || pos !== head) {
          match = nextMatch;
        }
        pos = prev;
      }
      return [
        { line, character: pos },
        { line, character: head },
      ];
    }
  );
}

// Resolves the document range deleted by Backspace or Delete at a collapsed
// caret. Non-collapsed selections delete their selected text instead.
export function resolveDeleteCharacterRange(
  textDocument: TextDocument,
  selection: EditorSelection,
  forward: boolean
): [start: Position, end: Position] {
  if (!isCollapsedSelection(selection)) {
    return [selection.start, selection.end];
  }

  const caret = getCaretPosition(selection);
  const { line } = caret;
  const lineLength = textDocument.getLineLength(line);
  // A preserved vertical-move goal column can overshoot a shorter line; clamp
  // before stepping so Backspace/Delete target the visible caret position.
  const character = Math.min(caret.character, lineLength);

  if (forward) {
    if (character < lineLength) {
      return [
        { line, character },
        {
          line,
          character: stepCharacterByGrapheme(
            textDocument,
            line,
            character,
            true
          ),
        },
      ];
    }
    if (line < textDocument.lineCount - 1) {
      return [
        { line, character: lineLength },
        { line: line + 1, character: 0 },
      ];
    }
  } else if (character > 0) {
    return [
      {
        line,
        character: stepCharacterByGrapheme(
          textDocument,
          line,
          character,
          false
        ),
      },
      { line, character },
    ];
  } else if (line > 0) {
    return [
      { line: line - 1, character: textDocument.getLineLength(line - 1) },
      { line, character: 0 },
    ];
  }
  return [caret, caret];
}

// Deletes one grapheme (or selected text) at each selection.
export function applyDeleteCharacterToSelections<
  EType extends EditorType,
  LAnnotation,
>(
  textDocument: TextDocument<EType, LAnnotation>,
  selections: EditorSelection[],
  forward: boolean,
  lineAnnotations?: EditorLineAnnotation<EType, LAnnotation>[],
  tabSize = 2
): {
  nextSelections: EditorSelection[];
  change?: TextDocumentChange;
} {
  return applyDeleteToSelections(
    textDocument,
    selections,
    lineAnnotations,
    (selection) => {
      const range = resolveDeleteCharacterRange(
        textDocument,
        selection,
        forward
      );
      // Only grow a Backspace into a full indent unit for a collapsed caret. When
      // the user has an explicit selection, Backspace must delete exactly that
      // selection rather than expanding it to a whole soft tab.
      if (forward || !isCollapsedSelection(selection)) {
        return range;
      }
      const { start, end } = normalizeLeadingIndentForChange(
        textDocument,
        {
          start: textDocument.offsetAt(range[0]),
          end: textDocument.offsetAt(range[1]),
          text: '',
        },
        tabSize
      );
      return [textDocument.positionAt(start), textDocument.positionAt(end)];
    }
  );
}

export function isCollapsedSelection(
  selection: EditorSelection | Range
): boolean {
  return (
    selection.start.line === selection.end.line &&
    selection.start.character === selection.end.character
  );
}

// Returns the caret (focus) position for a selection.
export function getCaretPosition(selection: EditorSelection): Position {
  return selection.direction === DirectionBackward
    ? selection.start
    : selection.end;
}

export function isLineEditable(lineType: string): boolean {
  return (
    lineType === 'context' ||
    lineType === 'context-expanded' ||
    lineType === 'change-addition'
  );
}

export function selectionIntersects(
  a: EditorSelection | Range,
  b: EditorSelection | Range
): boolean {
  const aCollapsed = isCollapsedSelection(a);
  const bCollapsed = isCollapsedSelection(b);
  if (aCollapsed && bCollapsed) {
    return comparePosition(a.start, b.start) === 0;
  }
  if (aCollapsed) {
    return (
      comparePosition(b.start, a.start) <= 0 &&
      comparePosition(a.start, b.end) <= 0
    );
  }
  if (bCollapsed) {
    return (
      comparePosition(a.start, b.start) <= 0 &&
      comparePosition(b.start, a.end) <= 0
    );
  }
  return (
    comparePosition(a.start, b.end) < 0 && comparePosition(b.start, a.end) < 0
  );
}

export function comparePosition(a: Position, b: Position): number {
  return a.line !== b.line ? a.line - b.line : a.character - b.character;
}

// Direction constants are -1/0/1, so Math.sign of the focus-anchor order
// gives the selection direction.
export function createSelectionFromAnchorAndFocusOffsets(
  textDocument: TextDocument,
  anchorOffset: number,
  focusOffset: number
): EditorSelection {
  return {
    start: textDocument.positionAt(Math.min(anchorOffset, focusOffset)),
    end: textDocument.positionAt(Math.max(anchorOffset, focusOffset)),
    direction: Math.sign(focusOffset - anchorOffset) as SelectionDirection,
  };
}

// Maps a single offset from the pre-edit document into the post-edit document.
// `edits` are resolved edits in pre-edit offsets, sorted ascending and
// non-overlapping. An offset at or after an edit's start shifts to the end of
// that edit's replacement (right gravity), so text inserted at the caret pushes
// the caret past it; an offset strictly before an edit is only shifted by the
// net length change of the edits that precede it.
export function remapOffsetThroughEdits(
  offset: number,
  edits: readonly ResolvedTextEdit[]
): number {
  let delta = 0;
  for (const edit of edits) {
    if (offset < edit.start) {
      break;
    }
    if (offset < edit.end) {
      return edit.start + delta + edit.text.length;
    }
    delta += edit.text.length - (edit.end - edit.start);
  }
  return offset + delta;
}

// Re-anchors selections after a batch of text edits has been applied, so the
// caret keeps pointing at the same logical location in the changed buffer.
// `selectionOffsets` (one `[start, end]` pair per selection) and `edits` are
// measured in the PRE-edit document; the returned selections are built from
// `textDocument`, which must already reflect the applied edits. Selection
// direction is preserved by remapping each edge and re-deriving anchor/focus.
export function remapSelectionsAfterEdits(
  textDocument: TextDocument,
  selections: readonly EditorSelection[],
  selectionOffsets: ReadonlyArray<readonly [number, number]>,
  edits: readonly ResolvedTextEdit[]
): EditorSelection[] {
  return selections.map((selection, index) => {
    const [startOffset, endOffset] = selectionOffsets[index];
    const nextStart = remapOffsetThroughEdits(startOffset, edits);
    const nextEnd = remapOffsetThroughEdits(endOffset, edits);
    const isBackward = selection.direction === DirectionBackward;
    return createSelectionFromAnchorAndFocusOffsets(
      textDocument,
      isBackward ? nextEnd : nextStart,
      isBackward ? nextStart : nextEnd
    );
  });
}

// Creates a selection from the anchor of `anchorSelection` to the end of
// `focusSelection`, or to its start when the anchor is after that start.
export function createSelectionFrom(
  anchorSelection: EditorSelection,
  focusSelection: EditorSelection
): EditorSelection {
  const anchor =
    anchorSelection.direction === DirectionBackward
      ? anchorSelection.end
      : anchorSelection.start;
  const focus =
    comparePosition(anchor, focusSelection.start) <= 0
      ? focusSelection.end
      : focusSelection.start;
  const direction = Math.sign(
    comparePosition(focus, anchor)
  ) as SelectionDirection;
  return direction < 0
    ? { start: focus, end: anchor, direction }
    : { start: anchor, end: focus, direction };
}

// Extends or shrinks the selection `original` using the endpoints of `target`,
// matching contenteditable shift + click extend behavior.
export function extendSelection(
  original: EditorSelection,
  target: EditorSelection
): EditorSelection {
  const leftExtended = comparePosition(target.start, original.start) < 0;
  const rightExtended = comparePosition(target.end, original.end) > 0;
  const backward =
    leftExtended === rightExtended
      ? original.direction === DirectionBackward
      : leftExtended;
  if (backward) {
    return {
      start: target.start,
      end: original.end,
      direction:
        comparePosition(target.start, original.end) === 0
          ? DirectionNone
          : DirectionBackward,
    };
  }
  return {
    start: original.start,
    end: target.end,
    direction:
      comparePosition(original.start, target.end) === 0
        ? DirectionNone
        : DirectionForward,
  };
}

export function extendSelections(
  selections: EditorSelection[],
  target: EditorSelection
): EditorSelection[] {
  return mergeOverlappingSelections(
    selections.map((selection) => extendSelection(selection, target))
  );
}

export function mergeOverlappingSelections(
  selections: EditorSelection[]
): EditorSelection[] {
  if (selections.length <= 1) {
    return selections;
  }
  const ordered = selections
    .map((selection, index) => ({ index, selection }))
    .sort((a, b) => {
      const startOrder = comparePosition(a.selection.start, b.selection.start);
      if (startOrder !== 0) {
        return startOrder;
      }
      const endOrder = comparePosition(a.selection.end, b.selection.end);
      return endOrder !== 0 ? endOrder : a.index - b.index;
    });
  const merged: {
    index: number;
    selection: EditorSelection;
  }[] = [];

  let current = ordered[0];
  for (let i = 1; i < ordered.length; i++) {
    const entry = ordered[i];
    if (!selectionIntersects(current.selection, entry.selection)) {
      merged.push(current);
      current = entry;
      continue;
    }
    const latest = entry.index > current.index ? entry : current;
    const start =
      comparePosition(entry.selection.start, current.selection.start) < 0
        ? entry.selection.start
        : current.selection.start;
    const end =
      comparePosition(entry.selection.end, current.selection.end) > 0
        ? entry.selection.end
        : current.selection.end;
    let direction = latest.selection.direction;
    if (direction === DirectionNone && comparePosition(start, end) !== 0) {
      direction =
        comparePosition(latest.selection.start, start) === 0
          ? DirectionBackward
          : DirectionForward;
    }
    current = { index: latest.index, selection: { direction, end, start } };
  }
  merged.push(current);

  return merged
    .sort((a, b) => a.index - b.index)
    .map(({ selection }) => selection);
}

// Converts selections into merged line blocks for line-based commands.
export function getSelectedLineBlocks(
  selections: EditorSelection[]
): { startLine: number; endLine: number }[] {
  const blocks = selections
    .map((selection) => {
      let endLine = selection.end.line;
      if (selection.end.character === 0 && !isCollapsedSelection(selection)) {
        endLine--;
      }
      return {
        startLine: selection.start.line,
        endLine: Math.max(selection.start.line, endLine),
      };
    })
    .sort((a, b) =>
      a.startLine !== b.startLine
        ? a.startLine - b.startLine
        : a.endLine - b.endLine
    );

  const merged: { startLine: number; endLine: number }[] = [];
  for (const block of blocks) {
    const previous = merged.at(-1);
    if (previous !== undefined && block.startLine <= previous.endLine + 1) {
      previous.endLine = Math.max(previous.endLine, block.endLine);
    } else {
      merged.push(block);
    }
  }
  return merged;
}

// Moves a selection's line positions after its lines are shifted, clamping to
// the target document bounds.
export function shiftSelectionLines(
  selection: EditorSelection,
  direction: -1 | 1,
  lineCount: number,
  getLineLength: (line: number) => number
): EditorSelection {
  const shiftPosition = (position: Position): Position => {
    const line = position.line + direction;
    if (line >= lineCount) {
      const lastLine = Math.max(0, lineCount - 1);
      return { line: lastLine, character: getLineLength(lastLine) };
    }
    return line < 0
      ? { line: 0, character: 0 }
      : { line, character: position.character };
  };

  return {
    start: shiftPosition(selection.start),
    end: shiftPosition(selection.end),
    direction: selection.direction,
  };
}

// Finds the next matching word and updates the selections.
export function findNextMatch(
  textDocument: TextDocument,
  selections: EditorSelection[]
): EditorSelection[] | undefined {
  if (selections.length === 0) {
    return undefined;
  }

  const normalizedSelections = selections.map((selection) =>
    isCollapsedSelection(selection)
      ? expandCollapsedSelectionToWord(textDocument, selection)
      : selection
  );
  const texts = normalizedSelections.map((s) => textDocument.getText(s));
  const needle = texts[0];
  if (needle.length === 0 || texts.some((t) => t !== needle)) {
    return undefined;
  }

  const occupied = normalizedSelections.map((s): [number, number] => [
    textDocument.offsetAt(s.start),
    textDocument.offsetAt(s.end),
  ]);
  const nextOffset = textDocument.findNextNonOverlappingSubstring(
    needle,
    occupied
  );
  if (nextOffset === undefined) {
    // A collapsed caret expanded to its word is a new selection object.
    return normalizedSelections.some(
      (selection, index) => selection !== selections[index]
    )
      ? normalizedSelections
      : undefined;
  }
  return [
    ...normalizedSelections,
    createSelectionFromAnchorAndFocusOffsets(
      textDocument,
      nextOffset,
      nextOffset + needle.length
    ),
  ];
}

export function getDocumentFullSelection(
  textDocument: TextDocument
): EditorSelection {
  const lastLine = textDocument.lineCount - 1;
  return {
    start: { line: 0, character: 0 },
    end: { line: lastLine, character: textDocument.getLineLength(lastLine) },
    direction: DirectionForward,
  };
}

export function getDocumentBoundarySelection(
  textDocument: TextDocument,
  atEnd: boolean,
  trimmedEndNewLine?: boolean
): EditorSelection {
  let line = 0;
  if (atEnd) {
    line = textDocument.lineCount - 1;
    if (
      trimmedEndNewLine === true &&
      line > 0 &&
      textDocument.getLineLength(line) === 0
    ) {
      line--;
    }
  }
  const start = {
    line,
    character: atEnd ? textDocument.getLineLength(line) : 0,
  };
  return { start, end: start, direction: DirectionForward };
}

interface ClipboardRegion {
  start: number;
  end: number;
}

// Resolves the document offset range each selection contributes to the
// clipboard, ordered by position. A collapsed selection contributes its whole
// logical line including the trailing line break; the final line has no
// trailing break to include. A ranged selection contributes the selected text.
function resolveClipboardRegions(
  textDocument: TextDocument,
  selections: EditorSelection[]
): ClipboardRegion[] {
  return selections
    .map((selection): ClipboardRegion => {
      if (isCollapsedSelection(selection)) {
        const { line } = selection.start;
        return {
          start: textDocument.offsetAt({ line, character: 0 }),
          end:
            line < textDocument.lineCount - 1
              ? textDocument.offsetAt({ line: line + 1, character: 0 })
              : textDocument.offsetAt({
                  line,
                  character: textDocument.getLineLength(line),
                }),
        };
      }
      const start = textDocument.offsetAt(selection.start);
      const end = textDocument.offsetAt(selection.end);
      return { start: Math.min(start, end), end: Math.max(start, end) };
    })
    .sort((a, b) => (a.start !== b.start ? a.start - b.start : a.end - b.end));
}

// Gets the text contributed by each selection in document order, preserving
// the pairing needed to paste the values into another set of selections.
export function getSelectionClipboardTexts(
  textDocument: TextDocument,
  selections: EditorSelection[]
): string[] {
  return resolveClipboardRegions(textDocument, selections).map(
    ({ start, end }) => textDocument.getTextSlice(start, end)
  );
}

// Get the clipboard text of the selections for the given text document. Used by
// both copy and cut so the two stay in sync. Overlapping regions (e.g. several
// carets on one line) are merged so the same text is never emitted twice, and a
// line-ending separator is inserted only between regions that aren't already
// contiguous in the document.
export function getSelectionText(
  textDocument: TextDocument,
  selections: EditorSelection[]
): string {
  const eol = textDocument.eol;
  let result = '';
  let prevEnd = -1;
  for (const { start, end } of resolveClipboardRegions(
    textDocument,
    selections
  )) {
    // A region contiguous with or overlapping the previous one only adds the
    // text past it.
    const from = Math.max(start, prevEnd);
    if (end <= from) {
      continue;
    }
    if (start > prevEnd && result.length > 0 && !endsWithLineBreak(result)) {
      result += eol;
    }
    result += textDocument.getTextSlice(from, end);
    prevEnd = end;
  }
  return result;
}

// Resolves the clipboard text, merged deletions, and resulting caret offsets
// for a cut. The clipboard text comes from the shared getSelectionText helper
// so cut stays in sync with copy, while the deletions are computed per
// selection and merged so overlapping cuts delete their shared text once.
// A ranged selection removes only the selected text. A caret-only cut removes
// the whole logical line: non-final lines delete their trailing line break;
// the final line deletes the preceding break so no empty line is left behind.
export function resolveSelectionCut(
  textDocument: TextDocument,
  selections: EditorSelection[]
): {
  text: string;
  edits: ResolvedTextEdit[];
  nextSelectionOffsets: number[];
} {
  const orderedCuts = selections
    .map((selection, index) => {
      let start: number;
      let end: number;
      if (!isCollapsedSelection(selection)) {
        const ordered = comparePosition(selection.start, selection.end) <= 0;
        start = textDocument.offsetAt(
          ordered ? selection.start : selection.end
        );
        end = textDocument.offsetAt(ordered ? selection.end : selection.start);
      } else {
        const { line } = selection.start;
        if (line < textDocument.lineCount - 1) {
          start = textDocument.offsetAt({ line, character: 0 });
          end = textDocument.offsetAt({ line: line + 1, character: 0 });
        } else {
          start =
            line > 0
              ? textDocument.offsetAt({
                  line: line - 1,
                  character: textDocument.getLineLength(line - 1),
                })
              : textDocument.offsetAt({ line, character: 0 });
          end = textDocument.offsetAt({
            line,
            character: textDocument.getLineLength(line),
          });
        }
      }
      return { index, edit: { start, end, text: '' } };
    })
    .sort((a, b) => {
      if (a.edit.start !== b.edit.start) {
        return a.edit.start - b.edit.start;
      }
      return a.edit.end !== b.edit.end
        ? a.edit.end - b.edit.end
        : a.index - b.index;
    });

  const edits: ResolvedTextEdit[] = [];
  for (const { edit } of orderedCuts) {
    if (edit.start >= edit.end) {
      continue;
    }
    const last = edits.at(-1);
    if (last !== undefined && edit.start <= last.end) {
      edits[edits.length - 1] = {
        start: last.start,
        end: Math.max(last.end, edit.end),
        text: '',
      };
    } else {
      edits.push(edit);
    }
  }

  const nextSelectionOffsets: number[] = Array.from({
    length: orderedCuts.length,
  });
  let editIndex = 0;
  let offsetDelta = 0;
  for (const cut of orderedCuts) {
    while (editIndex < edits.length && cut.edit.start > edits[editIndex].end) {
      const edit = edits[editIndex];
      offsetDelta -= edit.end - edit.start;
      editIndex++;
    }
    const edit = edits[editIndex];
    nextSelectionOffsets[cut.index] =
      (edit !== undefined &&
      cut.edit.start >= edit.start &&
      cut.edit.start <= edit.end
        ? edit.start
        : cut.edit.start) + offsetDelta;
  }

  return {
    text: getSelectionText(textDocument, selections),
    edits,
    nextSelectionOffsets,
  };
}

// Get the DOM anchor node and offset for a character in a line element.
export function getSelectionAnchor(
  lineElement: HTMLElement,
  character: number
): [Node, number] {
  const ch = Math.max(0, character);
  const tokens = collectTokens(lineElement);
  for (const token of tokens) {
    const base = getCharacterIndex(token)!;
    if (ch <= base + (token.textContent?.length ?? 0)) {
      const anchor = textAt(token, ch - base);
      if (anchor !== null) {
        return anchor;
      }
    }
  }

  const last = tokens.at(-1);
  if (last !== undefined) {
    return textAt(last, last.textContent?.length ?? 0) ?? [last, 0];
  }

  let textOffset = 0;
  let lastTextNode: Text | null = null;
  for (const child of lineElement.childNodes) {
    if (child.nodeType === 1 && (child as HTMLElement).tagName === 'BR') {
      return [child, 0];
    }
    if (child.nodeType !== 3) {
      continue;
    }
    lastTextNode = child as Text;
    const len = getTextOffset(lastTextNode.textContent);
    if (ch <= textOffset + len) {
      return [
        lastTextNode,
        getTextOffset(lastTextNode.textContent, ch - textOffset),
      ];
    }
    textOffset += len;
  }

  return lastTextNode !== null
    ? [lastTextNode, getTextOffset(lastTextNode.textContent)]
    : [lineElement, 0];
}

// Expands a zero-width selection to the word-like segment that contains the caret.
export function expandCollapsedSelectionToWord(
  textDocument: TextDocument,
  selection: EditorSelection
): EditorSelection {
  const { line, character } = selection.start;
  const lineText = textDocument.getLineText(line);
  const ch = Math.max(0, Math.min(character, lineText.length));
  // Degraded path for engines lacking Intl.Segmenter: treat runs of
  // alphanumeric/underscore characters as words.
  const words: Iterable<{
    index: number;
    segment: string;
    isWordLike?: boolean;
  }> =
    createSegmenter({ granularity: 'word' })?.segment(lineText) ??
    Array.from(
      lineText.matchAll(/[\p{Alphabetic}\p{Number}_]+/gu),
      (match) => ({
        index: match.index,
        segment: match[0],
        isWordLike: true,
      })
    );
  for (const { index, segment, isWordLike } of words) {
    const end = index + segment.length;
    // Match when the cursor is inside the word or immediately touching
    // one of its boundaries — not when separated by non-word characters.
    if (isWordLike === true && ch >= index && ch <= end) {
      return {
        start: { line, character: index },
        end: { line, character: end },
        direction: DirectionForward,
      };
    }
  }
  return selection;
}

function findClusterBreak(
  text: string,
  pos: number,
  forward: boolean,
  graphemeStarts: number[]
): number {
  if (forward) {
    for (const start of graphemeStarts) {
      if (start > pos) {
        return start;
      }
    }
    return text.length;
  }
  for (let i = graphemeStarts.length - 1; i >= 0; i--) {
    const start = graphemeStarts[i];
    if (start < pos) {
      return start;
    }
  }
  return 0;
}

// Lists the start column of every grapheme cluster on a line (always starting
// at 0). Used to step the caret and to transpose by whole graphemes so a
// surrogate pair (emoji) or combining sequence is never split.
function getLineGraphemeStarts(lineText: string): number[] {
  const graphemeStarts = [0];
  const segmenter = getGraphemeSegmenter();
  if (segmenter !== undefined) {
    for (const { index } of segmenter.segment(lineText)) {
      if (index > 0) {
        graphemeStarts.push(index);
      }
    }
    return graphemeStarts;
  }
  // Degraded path for engines lacking Intl.Segmenter: step by code point
  // (keeps surrogate pairs intact, but not combining sequences).
  let index = 0;
  for (const codePoint of lineText) {
    if (index > 0) {
      graphemeStarts.push(index);
    }
    index += codePoint.length;
  }
  return graphemeStarts;
}

// Returns the character column one grapheme cluster to the left or right of
// `character` on `line`. Stepping by grapheme rather than by a single UTF-16
// code unit keeps the caret from landing inside an emoji or other multi-unit
// character. Crossing a line boundary is left to the caller.
function stepCharacterByGrapheme(
  textDocument: TextDocument,
  line: number,
  character: number,
  forward: boolean
): number {
  const lineLength = textDocument.getLineLength(line);
  if (forward && character >= lineLength) {
    return lineLength;
  }
  if (!forward && character <= 0) {
    return 0;
  }
  const lineStart = textDocument.offsetAt({ line, character: 0 });
  const segmenter = getGraphemeSegmenter();
  if (forward) {
    const suffix = textDocument.getTextSlice(
      lineStart + character,
      lineStart + lineLength
    );
    if (segmenter !== undefined) {
      for (const segment of segmenter.segment(suffix)) {
        return character + segment.segment.length;
      }
    } else {
      // Degraded path for engines lacking Intl.Segmenter: step one code point.
      for (const codePoint of suffix) {
        return character + codePoint.length;
      }
    }
    return lineLength;
  }
  const prefix = textDocument.getTextSlice(lineStart, lineStart + character);
  let prevStart = 0;
  if (segmenter !== undefined) {
    for (const { index } of segmenter.segment(prefix)) {
      prevStart = index;
    }
    return prevStart;
  }
  // Degraded path for engines lacking Intl.Segmenter: step one code point.
  let index = 0;
  for (const codePoint of prefix) {
    prevStart = index;
    index += codePoint.length;
  }
  return prevStart;
}

// When the user inserts a lone line break, copy the current line's indentation onto the new line.
function expandSingleNewlineInsert(
  textDocument: TextDocument,
  insertText: string,
  insertStartOffset: number
): string {
  if (insertText !== '\n' && insertText !== '\r' && insertText !== '\r\n') {
    return insertText;
  }
  const lineText = textDocument.getLineText(
    textDocument.positionAt(insertStartOffset).line
  );
  return insertText + lineText.slice(0, getLeadingSpaces(lineText));
}

function getLeadingSpaces(text: string): number {
  let indent = 0;
  for (; indent < text.length; indent++) {
    const c = text.charCodeAt(indent);
    if (c !== /* space */ 32 && c !== /* tab */ 9) {
      break;
    }
  }
  return indent;
}

function createSelectionsFromOffsetPairs(
  textDocument: TextDocument,
  offsetPairs: readonly [anchorOffset: number, focusOffset: number][]
): EditorSelection[] {
  const normalizedOffsets: number[] = [];
  for (const [anchorOffset, focusOffset] of offsetPairs) {
    normalizedOffsets.push(
      Math.min(anchorOffset, focusOffset),
      Math.max(anchorOffset, focusOffset)
    );
  }
  const positions = textDocument.positionsAt(normalizedOffsets);
  return offsetPairs.map(([anchorOffset, focusOffset], index) => ({
    start: positions[index * 2],
    end: positions[index * 2 + 1],
    direction: Math.sign(focusOffset - anchorOffset) as SelectionDirection,
  }));
}

// Expands a backspace over leading spaces into one soft-tab width so mixed hard/soft indentation
// behaves like the explicit outdent command.
function normalizeLeadingIndentForChange(
  textDocument: TextDocument,
  change: ResolvedTextEdit,
  tabSize: number
): ResolvedTextEdit {
  if (change.text !== '' || change.start !== change.end - 1) {
    return change;
  }
  const { line, character } = textDocument.positionAt(change.end);
  const leadingText = textDocument.getLineText(line).slice(0, character);
  const softTabText = leadingText.slice(Math.max(0, character - tabSize));
  return !/[^ \t]/.test(leadingText) &&
    softTabText.length === tabSize &&
    /^ +$/.test(softTabText)
    ? { ...change, start: change.end - tabSize }
    : change;
}

function boundaryToPosition(node: Node, offset: number): Position | null {
  let lineEl: HTMLElement | null =
    node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
  while (lineEl !== null && getLineIndex(lineEl) === undefined) {
    lineEl = lineEl.parentElement;
  }
  if (lineEl === null) {
    return null;
  }
  const line = getLineIndex(lineEl)!;

  if (node.nodeType === 3) {
    // A text node reaching here has a parent: the line lookup started there.
    if (findTokenSpan(node.parentElement!) !== null) {
      return { line, character: getLineChildEnd(node, offset) };
    }
    return {
      line,
      character:
        offsetBefore(lineEl, node) + getTextOffset(node.textContent, offset),
    };
  }

  if (node.nodeType !== 1) {
    return null;
  }
  const el = node as HTMLElement;
  if (el.tagName === 'DIV') {
    return {
      line,
      character: offset > 0 ? getLineChildEnd(el.childNodes[offset - 1]) : 0,
    };
  }
  if (el.tagName === 'BR') {
    return { line, character: 0 };
  }
  if (el.tagName === 'SPAN') {
    const next = el.childNodes[offset];
    if (next?.nodeType === 1) {
      const nextBase = getCharacterIndex(next as HTMLElement);
      if (nextBase !== undefined) {
        return { line, character: nextBase };
      }
      const token = findTokenSpan(next as HTMLElement);
      if (token !== null) {
        return { line, character: getCharacterIndex(token)! };
      }
    }
    return {
      line,
      character:
        offset > 0
          ? getLineChildEnd(el.childNodes[offset - 1])
          : offsetBefore(lineEl, el),
    };
  }
  return { line, character: offsetBefore(lineEl, el) };
}

function collectTokens(line: HTMLElement): HTMLElement[] {
  const tokens: HTMLElement[] = [];
  for (const child of line.childNodes) {
    const el = child as HTMLElement;
    if (child.nodeType !== 1 || el.tagName !== 'SPAN') {
      continue;
    }
    if (getCharacterIndex(el) !== undefined) {
      tokens.push(el);
      continue;
    }
    for (const nested of el.childNodes) {
      if (
        nested.nodeType === 1 &&
        getCharacterIndex(nested as HTMLElement) !== undefined
      ) {
        tokens.push(nested as HTMLElement);
      }
    }
  }
  return tokens;
}

function textAt(token: HTMLElement, offset: number): [Node, number] | null {
  let remaining = Math.max(0, offset);
  const stack: Array<{ container: Node; index: number }> = [
    { container: token, index: 0 },
  ];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.container.childNodes.length) {
      stack.pop();
      continue;
    }
    const walkNode = frame.container.childNodes[frame.index];
    frame.index++;
    if (walkNode.nodeType === 3) {
      const len = getTextOffset(walkNode.textContent);
      if (remaining <= len) {
        return [walkNode, remaining];
      }
      remaining -= len;
    } else if (walkNode.nodeType === 1) {
      stack.push({ container: walkNode, index: 0 });
    }
  }
  return null;
}

function textLengthBefore(root: Node, target: Node): number {
  let before = 0;
  const stack: Array<{ container: Node; index: number }> = [
    { container: root, index: 0 },
  ];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.container.childNodes.length) {
      stack.pop();
      continue;
    }
    const walkNode = frame.container.childNodes[frame.index];
    if (walkNode === target) {
      return before;
    }
    frame.index++;
    if (walkNode.nodeType === 3) {
      before += getTextOffset(walkNode.textContent);
    } else if (walkNode.nodeType === 1) {
      stack.push({ container: walkNode, index: 0 });
    }
  }
  return before;
}

function isInside(token: HTMLElement, node: Node): boolean {
  let current: Node | null = node;
  while (current !== null) {
    if (current === token) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

// Only the child just before `node` matters: each line child end is absolute.
function offsetBefore(line: HTMLElement, node: Node): number {
  if (node.parentElement === line) {
    const index = Array.prototype.indexOf.call(line.childNodes, node);
    return index > 0 ? getLineChildEnd(line.childNodes[index - 1]) : 0;
  }
  for (const token of collectTokens(line)) {
    if (isInside(token, node)) {
      return (
        getCharacterIndex(token)! +
        (node.nodeType === 3 ? textLengthBefore(token, node) : 0)
      );
    }
  }
  let offset = 0;
  let target: HTMLElement | null =
    node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
  while (
    target !== null &&
    target.parentElement !== null &&
    getLineIndex(target.parentElement) === undefined
  ) {
    const parent = target.parentElement;
    const index = Array.prototype.indexOf.call(parent.childNodes, target);
    if (index > 0) {
      offset = getLineChildEnd(parent.childNodes[index - 1]);
    }
    target = parent;
  }
  return offset;
}

function findTokenSpan(el: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = el;
  while (current !== null) {
    if (getLineIndex(current) !== undefined) {
      return null;
    }
    if (getCharacterIndex(current) !== undefined) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function getLineChildEnd(
  child: Node | undefined,
  textOffsetInChild?: number
): number {
  if (child === undefined) {
    return 0;
  }
  if (child.nodeType === 3) {
    const parent = child.parentElement;
    const token = parent === null ? null : findTokenSpan(parent);
    if (token === null) {
      return 0;
    }
    return (
      getCharacterIndex(token)! +
      textLengthBefore(token, child) +
      getTextOffset(child.textContent, textOffsetInChild)
    );
  }
  if (child.nodeType !== 1) {
    return 0;
  }
  const el = child as HTMLElement;
  if (el.tagName !== 'SPAN' && el.tagName !== 'BR') {
    return 0;
  }
  const base = getCharacterIndex(el);
  if (base !== undefined) {
    return base + (el.textContent?.length ?? 0);
  }
  let end = 0;
  for (const token of el.childNodes) {
    end = Math.max(end, getLineChildEnd(token));
  }
  return end;
}

function getLineIndex(el: HTMLElement): number | undefined {
  const line =
    el.dataset.lineType === 'change-deletion'
      ? undefined
      : getLineNumberAttr(el);
  return line === undefined ? undefined : line - 1;
}

function getCharacterIndex(el: HTMLElement): number | undefined {
  return getLineNumberAttr(el, 'char');
}

// Clamps `offset` to the text before its first line break.
function getTextOffset(
  text: string | null | undefined,
  offset = Infinity
): number {
  const value = text ?? '';
  const lineBreakIndex = value.search(/[\r\n]/);
  return Math.min(
    offset,
    lineBreakIndex === -1 ? value.length : lineBreakIndex
  );
}
