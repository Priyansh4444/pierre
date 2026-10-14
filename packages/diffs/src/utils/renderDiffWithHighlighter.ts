import { diffChars, diffWordsWithSpace } from 'diff';

import { DEFAULT_COLLAPSED_CONTEXT_THRESHOLD } from '../constants';
import type {
  DecorationItem,
  DiffsHighlighter,
  FileDiffMetadata,
  ForceDiffPlainTextOptions,
  LineDiffTypes,
  LineInfo,
  RenderDiffFilesResult,
  RenderDiffOptions,
  ThemedDiffResult,
} from '../types';
import { appendItems } from './appendItems';
import { cleanLastNewline } from './cleanLastNewline';
import { getFiletypeFromFileName } from './getFiletypeFromFileName';
import { getHighlighterThemeStyles } from './getHighlighterThemeStyles';
import { getTokenOptions } from './getTokenOptions';
import { iterateOverDiff } from './iterateOverDiff';
import {
  createDiffSpanDecoration,
  pushOrJoinSpan,
} from './parseDiffDecorations';
import { renderTokenLines } from './renderTokenLines';
import { setDeferredArrayItem } from './setDeferredArrayItem';

export function renderDiffWithHighlighter(
  diff: FileDiffMetadata,
  highlighter: DiffsHighlighter,
  options: RenderDiffOptions,
  {
    forcePlainText,
    lazyLineAST = false,
    startingLine,
    totalLines,
    expandedHunks,
    collapsedContextThreshold = DEFAULT_COLLAPSED_CONTEXT_THRESHOLD,
  }: ForceDiffPlainTextOptions = { forcePlainText: false }
): ThemedDiffResult {
  if (forcePlainText) {
    startingLine ??= 0;
    totalLines ??= Infinity;
  } else {
    // Tokenization must include preceding lines to preserve lexical state.
    startingLine = 0;
    totalLines = Infinity;
  }
  const isWindowedHighlight = startingLine > 0 || totalLines < Infinity;
  lazyLineAST &&= !forcePlainText && !options.useTokenTransformer;
  const baseThemeType =
    typeof options.theme === 'string'
      ? highlighter.getTheme(options.theme).type
      : undefined;
  const themeStyles = getHighlighterThemeStyles({
    theme: options.theme,
    highlighter,
  });

  // If we have a large file and we are rendering the WHOLE plain diff ast,
  // then we should remove the lineDiffType to make sure things render quickly.
  // For highlighted ASTs or windowed highlights, we should just inherit the
  // setting
  const lineDiffType =
    forcePlainText &&
    !isWindowedHighlight &&
    (diff.unifiedLineCount > 1000 || diff.splitLineCount > 1000)
      ? 'none'
      : options.lineDiffType;

  const code: RenderDiffFilesResult = {
    deletionLines: [],
    additionLines: [],
  };

  const {
    maxLineDiffLength,
    theme,
    useTokenTransformer,
    tokenizeMaxLineLength,
  } = options;
  const shouldGroupAll = !forcePlainText && !diff.isPartial;
  const buckets = new Map<number, RenderBucket>();

  function appendContent(
    lineContent: string,
    lineIndex: number,
    segments: HighlightSegment[],
    contentWrapper: LineContentBuffer
  ) {
    if (isWindowedHighlight) {
      let segment = segments.at(-1);
      if (
        segment == null ||
        segment.targetIndex + segment.count !== lineIndex
      ) {
        segment = {
          targetIndex: lineIndex,
          originalOffset: contentWrapper.length,
          count: 0,
        };
        segments.push(segment);
      }
      segment.count++;
    }
    contentWrapper.push(lineContent);
  }

  iterateOverDiff({
    diff,
    diffStyle: 'both',
    startingLine,
    totalLines,
    // Only plain text renders can be windowed
    expandedHunks: isWindowedHighlight ? expandedHunks : true,
    collapsedContextThreshold,
    callback: ({ hunkIndex, additionLine, deletionLine, type }) => {
      const bucketIndex = shouldGroupAll ? 0 : hunkIndex;
      let bucket = buckets.get(bucketIndex);
      if (bucket == null) {
        bucket = {
          deletionContent: new LineContentBuffer(),
          additionContent: new LineContentBuffer(),
          deletionInfo: [],
          additionInfo: [],
          deletionDecorations: [],
          additionDecorations: [],
          deletionSegments: [],
          additionSegments: [],
        };
        buckets.set(bucketIndex, bucket);
      }
      const splitLineIndex =
        additionLine != null
          ? additionLine.splitLineIndex
          : deletionLine.splitLineIndex;

      if (type === 'change' && additionLine != null && deletionLine != null) {
        computeLineDiffDecorations(
          diff.deletionLines[deletionLine.lineIndex],
          diff.additionLines[additionLine.lineIndex],
          bucket,
          lineDiffType,
          maxLineDiffLength
        );
      }

      if (deletionLine != null) {
        appendContent(
          diff.deletionLines[deletionLine.lineIndex],
          deletionLine.lineIndex,
          bucket.deletionSegments,
          bucket.deletionContent
        );
        bucket.deletionInfo.push({
          type: type === 'change' ? 'change-deletion' : type,
          lineNumber: deletionLine.lineNumber,
          altLineNumber:
            type === 'change'
              ? undefined
              : (additionLine.lineNumber ?? undefined),
          lineIndex: `${deletionLine.unifiedLineIndex},${splitLineIndex}`,
        });
      }

      if (additionLine != null) {
        appendContent(
          diff.additionLines[additionLine.lineIndex],
          additionLine.lineIndex,
          bucket.additionSegments,
          bucket.additionContent
        );
        bucket.additionInfo.push({
          type: type === 'change' ? 'change-addition' : type,
          lineNumber: additionLine.lineNumber,
          altLineNumber:
            type === 'change'
              ? undefined
              : (deletionLine.lineNumber ?? undefined),
          lineIndex: `${additionLine.unifiedLineIndex},${splitLineIndex}`,
        });
      }
    },
  });

  const languageOverride = forcePlainText ? 'text' : diff.lang;
  const renderFile = (
    name: string,
    contents: string,
    lineInfo: (LineInfo | undefined)[],
    decorations: DecorationItem[]
  ): RenderDiffFilesResult['additionLines'] =>
    contents === ''
      ? []
      : renderTokenLines(
          highlighter.codeToTokens(
            cleanLastNewline(contents),
            getTokenOptions(
              languageOverride ?? getFiletypeFromFileName(name),
              theme,
              tokenizeMaxLineLength
            )
          ).tokens,
          {
            state: { lineInfo },
            useTokenTransformer,
            decorations,
            lazyLineAST,
            cacheHtmlStyles: highlighter.name === 'highlights',
          }
        );

  for (const bucket of buckets.values()) {
    if (
      bucket.deletionContent.length === 0 &&
      bucket.additionContent.length === 0
    ) {
      continue;
    }

    const deletionLines = renderFile(
      diff.prevName ?? diff.name,
      bucket.deletionContent.value,
      bucket.deletionInfo,
      bucket.deletionDecorations
    );
    const additionLines = renderFile(
      diff.name,
      bucket.additionContent.value,
      bucket.additionInfo,
      bucket.additionDecorations
    );

    if (shouldGroupAll) {
      code.deletionLines = deletionLines;
      code.additionLines = additionLines;
      continue;
    }

    for (const [target, lines, segments] of [
      [code.deletionLines, deletionLines, bucket.deletionSegments],
      [code.additionLines, additionLines, bucket.additionSegments],
    ] as const) {
      if (segments.length > 0) {
        for (const segment of segments) {
          for (let index = 0; index < segment.count; index++) {
            target[segment.targetIndex + index] =
              lines[segment.originalOffset + index];
          }
        }
      } else if (lazyLineAST) {
        const offset = target.length;
        for (let index = 0; index < lines.length; index++) {
          setDeferredArrayItem(target, offset + index, () => lines[index]);
        }
      } else {
        appendItems(target, lines);
      }
    }
  }

  return { code, themeStyles, baseThemeType };
}

// Adds the inline diff highlights of a changed line pair to the bucket.
function computeLineDiffDecorations(
  deletionLine: string | undefined,
  additionLine: string | undefined,
  bucket: RenderBucket,
  lineDiffType: LineDiffTypes,
  maxLineDiffLength: number
): void {
  if (deletionLine == null || additionLine == null || lineDiffType === 'none') {
    return;
  }
  // NOTE(amadeus): Because we visually trim trailing newlines when rendering,
  // we also gotta make sure the diff parsing doesn't include the newline
  // character that could be there...
  deletionLine = cleanLastNewline(deletionLine);
  additionLine = cleanLastNewline(additionLine);
  // If we have really long lines, we probably shouldn't compute diffs on them.
  if (
    deletionLine.length > maxLineDiffLength ||
    additionLine.length > maxLineDiffLength
  ) {
    return;
  }
  const lineDiff =
    lineDiffType === 'char'
      ? diffChars(deletionLine, additionLine)
      : diffWordsWithSpace(deletionLine, additionLine);
  // The bucket line each highlight lands on
  const deletionLineIndex = bucket.deletionContent.length;
  const additionLineIndex = bucket.additionContent.length;
  const { deletionDecorations, additionDecorations } = bucket;

  if (lineDiffType === 'word-line') {
    // Push one decoration per side covering the first through last changed
    // token, so each line only has one highlight. Offsets come straight from
    // the diff items, skipping the span arrays the other word modes build.
    let deletionOffset = 0;
    let additionOffset = 0;
    let deletionStart = -1;
    let deletionEnd = 0;
    let additionStart = -1;
    let additionEnd = 0;
    for (const { value, added, removed } of lineDiff) {
      if (removed) {
        if (deletionStart === -1) deletionStart = deletionOffset;
        deletionOffset += value.length;
        deletionEnd = deletionOffset;
      } else if (added) {
        if (additionStart === -1) additionStart = additionOffset;
        additionOffset += value.length;
        additionEnd = additionOffset;
      } else {
        deletionOffset += value.length;
        additionOffset += value.length;
      }
    }
    if (deletionStart !== -1) {
      deletionDecorations.push(
        createDiffSpanDecoration({
          line: deletionLineIndex,
          spanStart: deletionStart,
          spanLength: deletionEnd - deletionStart,
        })
      );
    }
    if (additionStart !== -1) {
      additionDecorations.push(
        createDiffSpanDecoration({
          line: additionLineIndex,
          spanStart: additionStart,
          spanLength: additionEnd - additionStart,
        })
      );
    }
    return;
  }

  const deletionSpans: [0 | 1, string][] = [];
  const additionSpans: [0 | 1, string][] = [];
  const enableJoin = lineDiffType === 'word-alt';
  const lastItem = lineDiff.at(-1);
  for (const item of lineDiff) {
    const isLastItem = item === lastItem;
    if (!item.added && !item.removed) {
      pushOrJoinSpan({
        item,
        arr: deletionSpans,
        enableJoin,
        isNeutral: true,
        isLastItem,
      });
      pushOrJoinSpan({
        item,
        arr: additionSpans,
        enableJoin,
        isNeutral: true,
        isLastItem,
      });
    } else {
      pushOrJoinSpan({
        item,
        arr: item.removed ? deletionSpans : additionSpans,
        enableJoin,
        isLastItem,
      });
    }
  }
  for (const [spans, line, decorations] of [
    [deletionSpans, deletionLineIndex, deletionDecorations],
    [additionSpans, additionLineIndex, additionDecorations],
  ] as const) {
    let spanStart = 0;
    for (const [isChanged, text] of spans) {
      if (isChanged === 1) {
        decorations.push(
          createDiffSpanDecoration({
            line,
            spanStart,
            spanLength: text.length,
          })
        );
      }
      spanStart += text.length;
    }
  }
}

interface HighlightSegment {
  // The where the highlighted region starts
  originalOffset: number;
  // Where to place the highlighted line in RenderDiffFilesResult
  targetIndex: number;
  // Number of highlighted lines
  count: number;
}

// Joins line contents into one string while counting the lines.
class LineContentBuffer {
  value = '';
  length = 0;
  push(value: string): void {
    this.value += value;
    this.length++;
  }
}

interface RenderBucket {
  deletionContent: LineContentBuffer;
  additionContent: LineContentBuffer;
  deletionInfo: (LineInfo | undefined)[];
  additionInfo: (LineInfo | undefined)[];
  deletionDecorations: DecorationItem[];
  additionDecorations: DecorationItem[];
  deletionSegments: HighlightSegment[];
  additionSegments: HighlightSegment[];
}
