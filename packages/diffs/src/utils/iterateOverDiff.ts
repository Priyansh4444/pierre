import { DEFAULT_COLLAPSED_CONTEXT_THRESHOLD } from '../constants';
import type { FileDiffMetadata, Hunk, HunkExpansionRegion } from '../types';
import { getHunkSideStartBoundary } from './getHunkSideBoundaries';
import {
  getExpandedRegion,
  getTrailingExpandedRegion,
} from './virtualDiffLayout';

export interface DiffLineMetadata {
  unifiedLineIndex: number;
  splitLineIndex: number;
  lineIndex: number;
  lineNumber: number;
  noEOFCR: boolean;
}

export interface DiffLineCallbackBase {
  hunkIndex: number;
  hunk: Hunk | undefined; // undefined for trailing expansion region
  collapsedBefore: number; // > 0 means separator before this line, value = hidden lines
  collapsedAfter: number; // > 0 only on final line if trailing collapsed content
}

interface DiffLineCallbackContextChange extends DiffLineCallbackBase {
  type: 'change' | 'context' | 'context-expanded';
  deletionLine: DiffLineMetadata;
  additionLine: DiffLineMetadata;
}

interface DiffLineCallbackChangeDeletion extends DiffLineCallbackBase {
  type: 'change';
  deletionLine: DiffLineMetadata;
  additionLine?: undefined;
}

interface DiffLineCallbackChangeAddition extends DiffLineCallbackBase {
  type: 'change';
  deletionLine?: undefined;
  additionLine: DiffLineMetadata;
}

export type DiffLineCallbackProps =
  | DiffLineCallbackContextChange
  | DiffLineCallbackChangeDeletion
  | DiffLineCallbackChangeAddition;

type LineIterationBounds = [startIndex: number, endIndex: number];

export type DiffLineCallback = (props: DiffLineCallbackProps) => boolean | void;

export interface IterateOverDiffProps {
  diff: FileDiffMetadata;
  diffStyle: 'unified' | 'split' | 'both';
  startingLine?: number;
  totalLines?: number;
  expandedHunks?: Map<number, HunkExpansionRegion> | true;
  collapsedContextThreshold?: number;
  callback: DiffLineCallback;
}

export function iterateOverDiff({
  diff,
  diffStyle,
  startingLine = 0,
  totalLines = Infinity,
  expandedHunks,
  collapsedContextThreshold = DEFAULT_COLLAPSED_CONTEXT_THRESHOLD,
  callback,
}: IterateOverDiffProps): void {
  const viewportEnd = startingLine + totalLines;
  const isWindowedHighlight = startingLine > 0 || totalLines < Infinity;
  const useUnified = diffStyle !== 'split';
  const useSplit = diffStyle !== 'unified';
  const finalHunkIndex = diff.hunks.length - 1;
  let startHunkIndex = 0;
  let splitCount = 0;
  let unifiedCount = 0;

  // Seek to the hunk that contains `startingLine`, a dense rendered-row index
  // (not a raw split/unified line index). prefixRows[N] is the active style's
  // row count before hunk N under the current expansion settings; a binary
  // search finds the first hunk whose rows cross `startingLine` and seeds the
  // counter as if every prior hunk had already been walked.
  if (startingLine > 0 && diffStyle !== 'both') {
    const prefixRows = [0];
    for (let index = 0; index <= finalHunkIndex; index++) {
      const hunk = diff.hunks[index];
      const leadingRegion = getExpandedRegion({
        isPartial: diff.isPartial,
        rangeSize: hunk.collapsedBefore,
        expandedHunks,
        hunkIndex: index,
        collapsedContextThreshold,
      });
      const trailingRegion =
        index === finalHunkIndex
          ? getTrailingExpandedRegion({
              fileDiff: diff,
              hunkIndex: index,
              expandedHunks,
              collapsedContextThreshold,
              errorPrefix: 'iterateOverDiff',
            })
          : undefined;
      prefixRows.push(
        prefixRows[index] +
          leadingRegion.fromStart +
          leadingRegion.fromEnd +
          (useUnified ? hunk.unifiedLineCount : hunk.splitLineCount) +
          (trailingRegion == null
            ? 0
            : trailingRegion.fromStart + trailingRegion.fromEnd)
      );
    }

    let low = 0;
    let high = finalHunkIndex;
    startHunkIndex = diff.hunks.length;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (prefixRows[mid + 1] > startingLine) {
        startHunkIndex = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    if (useUnified) {
      unifiedCount = prefixRows[startHunkIndex];
    } else {
      splitCount = prefixRows[startHunkIndex];
    }
  }

  const shouldBreak = () =>
    isWindowedHighlight &&
    (!useUnified || unifiedCount >= viewportEnd) &&
    (!useSplit || splitCount >= viewportEnd);

  const shouldSkip = (unifiedRows: number, splitRows: number) =>
    isWindowedHighlight &&
    (!useUnified ||
      (unifiedRows > 0 && unifiedCount + unifiedRows <= startingLine)) &&
    (!useSplit || (splitRows > 0 && splitCount + splitRows <= startingLine));

  const incrementCounts = (unifiedRows: number, splitRows: number) => {
    if (useUnified) {
      unifiedCount += unifiedRows;
    }
    if (useSplit) {
      splitCount += splitRows;
    }
  };

  // Visible [start, end) offsets, moved by `shift`, of `count` rows that start
  // at rendered row `rows`.
  const clipRows = (
    rows: number,
    count: number,
    shift = 0
  ): LineIterationBounds | undefined => {
    const start = Math.max(0, startingLine - rows);
    const end = Math.min(count, viewportEnd - rows);
    return end > start ? [start + shift, end + shift] : undefined;
  };

  // Walk context rows through the active window while keeping split and
  // unified counters aligned. Rows are clipped to one hull around the window;
  // `diffStyle: both` can leave gaps inside it, so every row is still checked
  // before it is emitted.
  const walkContextLines = (
    count: number,
    emitLine: (index: number) => boolean | void,
    onSkippedStart?: () => void,
    shouldStop?: () => boolean
  ): boolean => {
    let startIndex = 0;
    let endIndex = count;
    if (isWindowedHighlight && count > 0) {
      const unifiedRange = useUnified
        ? clipRows(unifiedCount, count)
        : undefined;
      const splitRange = useSplit ? clipRows(splitCount, count) : undefined;
      if (unifiedRange != null && splitRange != null) {
        startIndex = Math.min(unifiedRange[0], splitRange[0]);
        endIndex = Math.max(unifiedRange[1], splitRange[1]);
      } else {
        [startIndex, endIndex] = unifiedRange ?? splitRange ?? [0, 0];
      }
    }
    if (startIndex > 0) {
      incrementCounts(startIndex, startIndex);
      onSkippedStart?.();
    }

    for (let index = startIndex; index < count; index++) {
      if (shouldStop?.() === true) {
        return true;
      }
      if (index >= endIndex) {
        incrementCounts(count - index, count - index);
        break;
      }
      const inWindow =
        !isWindowedHighlight ||
        (useUnified &&
          unifiedCount >= startingLine &&
          unifiedCount < viewportEnd) ||
        (useSplit && splitCount >= startingLine && splitCount < viewportEnd);
      incrementCounts(1, 1);
      if (inWindow && emitLine(index) === true) {
        return true;
      }
    }
    return false;
  };

  hunkIterator: for (
    let hunkIndex = startHunkIndex;
    hunkIndex < diff.hunks.length;
    hunkIndex++
  ) {
    if (shouldBreak()) {
      break;
    }
    const hunk = diff.hunks[hunkIndex];
    const deletionBoundary = getHunkSideStartBoundary(
      hunk.deletionStart,
      hunk.deletionCount
    );
    const additionBoundary = getHunkSideStartBoundary(
      hunk.additionStart,
      hunk.additionCount
    );
    // Line cursors at the start of the current hunk content block.
    let unifiedLineIndex = hunk.unifiedLineStart;
    let splitLineIndex = hunk.splitLineStart;
    let deletionLineIndex =
      !diff.isPartial && hunk.deletionCount === 0
        ? deletionBoundary
        : hunk.deletionLineIndex;
    let additionLineIndex =
      !diff.isPartial && hunk.additionCount === 0
        ? additionBoundary
        : hunk.additionLineIndex;
    let deletionLineNumber = deletionBoundary + 1;
    let additionLineNumber = additionBoundary + 1;

    const leadingRegion = getExpandedRegion({
      isPartial: diff.isPartial,
      rangeSize: hunk.collapsedBefore,
      expandedHunks,
      hunkIndex,
      collapsedContextThreshold,
    });
    const trailingRegion =
      hunkIndex === finalHunkIndex
        ? getTrailingExpandedRegion({
            fileDiff: diff,
            hunkIndex,
            expandedHunks,
            collapsedContextThreshold,
            errorPrefix: 'iterateOverDiff',
          })
        : undefined;
    const expandedLineCount = leadingRegion.fromStart + leadingRegion.fromEnd;

    function getTrailingCollapsedAfter(
      unifiedRowIndex: number,
      splitRowIndex: number
    ) {
      if (
        trailingRegion == null ||
        trailingRegion.collapsedLines <= 0 ||
        trailingRegion.fromStart + trailingRegion.fromEnd > 0
      ) {
        return 0;
      }
      const isLastRow =
        diffStyle === 'unified'
          ? unifiedRowIndex ===
            hunk.unifiedLineStart + hunk.unifiedLineCount - 1
          : splitRowIndex === hunk.splitLineStart + hunk.splitLineCount - 1;
      return isLastRow ? trailingRegion.collapsedLines : 0;
    }

    let consumedCollapsed = leadingRegion.collapsedLines === 0;
    function consumePendingCollapsed() {
      if (consumedCollapsed) {
        return 0;
      }
      consumedCollapsed = true;
      return leadingRegion.collapsedLines;
    }

    // Emits the paired context row `index` rows past the line cursors. Trailing
    // rows after the last hunk belong to a pseudo-hunk with no hunk data.
    let rowHunkIndex = hunkIndex;
    let rowHunk: Hunk | undefined = hunk;
    const emitContextRow = (
      index: number,
      type: 'context' | 'context-expanded',
      collapsedBefore: number,
      collapsedAfter: number,
      noEOFCRDeletion = false,
      noEOFCRAddition = false
    ) => {
      const unifiedRowIndex = unifiedLineIndex + index;
      const splitRowIndex = splitLineIndex + index;
      return callback({
        hunkIndex: rowHunkIndex,
        hunk: rowHunk,
        collapsedBefore,
        collapsedAfter,
        type,
        deletionLine: {
          lineNumber: deletionLineNumber + index,
          lineIndex: deletionLineIndex + index,
          noEOFCR: noEOFCRDeletion,
          unifiedLineIndex: unifiedRowIndex,
          splitLineIndex: splitRowIndex,
        },
        additionLine: {
          unifiedLineIndex: unifiedRowIndex,
          splitLineIndex: splitRowIndex,
          lineIndex: additionLineIndex + index,
          lineNumber: additionLineNumber + index,
          noEOFCR: noEOFCRAddition,
        },
      });
    };

    // Expanded rows of the leading gap: `fromStart` rows at the top of the gap,
    // then `fromEnd` rows right above the hunk.
    if (!shouldSkip(expandedLineCount, expandedLineCount)) {
      if (
        walkContextLines(leadingRegion.fromStart, (index) =>
          emitContextRow(
            index - leadingRegion.rangeSize,
            'context-expanded',
            0,
            0
          )
        ) ||
        walkContextLines(
          leadingRegion.fromEnd,
          (index) =>
            emitContextRow(
              index - leadingRegion.fromEnd,
              'context-expanded',
              consumePendingCollapsed(),
              0
            ),
          // The collapsed separator belongs before this fromEnd slice. If the
          // render window starts inside the slice, consume it with the skipped
          // rows so it is not attached to the first emitted row.
          consumePendingCollapsed
        )
      ) {
        break;
      }
    } else {
      incrementCounts(expandedLineCount, expandedLineCount);
      consumePendingCollapsed();
    }

    const lastContent = hunk.hunkContent.at(-1);
    for (const content of hunk.hunkContent) {
      if (shouldBreak()) {
        break hunkIterator;
      }
      const isLastContent = content === lastContent;

      if (content.type === 'context') {
        if (!shouldSkip(content.lines, content.lines)) {
          if (
            walkContextLines(
              content.lines,
              (index) => {
                const isLastLine = isLastContent && index === content.lines - 1;
                return emitContextRow(
                  index,
                  'context',
                  consumePendingCollapsed(),
                  getTrailingCollapsedAfter(
                    unifiedLineIndex + index,
                    splitLineIndex + index
                  ),
                  isLastLine && hunk.noEOFCRDeletions,
                  isLastLine && hunk.noEOFCRAdditions
                );
              },
              // When windowing starts inside context content, the leading
              // separator was above the visible range and should not be
              // emitted on the first rendered context line.
              consumePendingCollapsed
            )
          ) {
            break hunkIterator;
          }
        } else {
          incrementCounts(content.lines, content.lines);
          consumePendingCollapsed();
        }
        unifiedLineIndex += content.lines;
        splitLineIndex += content.lines;
        deletionLineIndex += content.lines;
        additionLineIndex += content.lines;
        deletionLineNumber += content.lines;
        additionLineNumber += content.lines;
        continue;
      }

      const splitRows = Math.max(content.deletions, content.additions);
      const unifiedRows = content.deletions + content.additions;
      if (!shouldSkip(unifiedRows, splitRows)) {
        // Clip the change block to the rows that can be visible in the active
        // coordinate space. `diffStyle: both` iterates in split row space, but
        // includes the unified ranges too so either view gets the rows it needs.
        const ranges: LineIterationBounds[] = [];
        if (!isWindowedHighlight) {
          ranges.push([0, diffStyle === 'unified' ? unifiedRows : splitRows]);
        } else {
          const visibleRanges = [];
          if (useUnified) {
            visibleRanges.push(
              clipRows(unifiedCount, content.deletions),
              // Unified iteration lists additions after the deletions.
              clipRows(
                unifiedCount + content.deletions,
                content.additions,
                diffStyle === 'unified' ? content.deletions : 0
              )
            );
          }
          if (useSplit) {
            visibleRanges.push(
              clipRows(splitCount, content.deletions),
              clipRows(splitCount, content.additions)
            );
          }
          for (const range of visibleRanges
            .filter((range) => range != null)
            .sort((a, b) => a[0] - b[0])) {
            const last = ranges.at(-1);
            if (last != null && range[0] <= last[1]) {
              last[1] = Math.max(last[1], range[1]);
            } else {
              ranges.push(range);
            }
          }
        }
        if ((ranges[0]?.[0] ?? 0) > 0) {
          // Change rows can be windowed from the middle of the block too. In
          // that case the leading separator belongs to skipped rows, not to
          // the first visible deletion/addition row.
          consumePendingCollapsed();
        }
        // Ranges are already clipped to the active window. Counts move once
        // for the whole change block after the selected rows emit.
        for (const [rangeStart, rangeEnd] of ranges) {
          for (let index = rangeStart; index < rangeEnd; index++) {
            const isDeletion = index < content.deletions;
            const isAddition =
              diffStyle === 'unified' ? !isDeletion : index < content.additions;
            const additionIndex =
              diffStyle === 'unified' ? index - content.deletions : index;
            const unifiedRowIndex = unifiedLineIndex + index;
            const splitRowIndex =
              splitLineIndex + (isDeletion ? index : additionIndex);
            const lastRowIndex =
              diffStyle === 'unified' ? unifiedRows - 1 : splitRows - 1;
            // At least one side is set: ranges never pass the block's rows.
            const props = {
              type: 'change',
              hunkIndex,
              hunk,
              collapsedAfter: getTrailingCollapsedAfter(
                unifiedRowIndex,
                splitRowIndex
              ),
              collapsedBefore: consumePendingCollapsed(),
              deletionLine: isDeletion
                ? {
                    lineNumber: deletionLineNumber + index,
                    lineIndex: deletionLineIndex + index,
                    noEOFCR:
                      isLastContent &&
                      index ===
                        (diffStyle === 'unified'
                          ? content.deletions - 1
                          : lastRowIndex) &&
                      hunk.noEOFCRDeletions,
                    unifiedLineIndex: unifiedRowIndex,
                    splitLineIndex: splitRowIndex,
                  }
                : undefined,
              additionLine: isAddition
                ? {
                    unifiedLineIndex:
                      unifiedLineIndex + content.deletions + additionIndex,
                    splitLineIndex: splitRowIndex,
                    lineIndex: additionLineIndex + additionIndex,
                    lineNumber: additionLineNumber + additionIndex,
                    noEOFCR:
                      isLastContent &&
                      index === lastRowIndex &&
                      hunk.noEOFCRAdditions,
                  }
                : undefined,
            } as DiffLineCallbackProps;
            if (callback(props) ?? false) {
              break hunkIterator;
            }
          }
        }
      }

      consumePendingCollapsed();
      incrementCounts(unifiedRows, splitRows);
      unifiedLineIndex += unifiedRows;
      splitLineIndex += splitRows;
      deletionLineIndex += content.deletions;
      additionLineIndex += content.additions;
      deletionLineNumber += content.deletions;
      additionLineNumber += content.additions;
    }

    // Only the final hunk has a trailing region, so the loop ends either way.
    if (trailingRegion != null) {
      const { collapsedLines, fromStart, fromEnd } = trailingRegion;
      const len = fromStart + fromEnd;
      rowHunkIndex = diff.hunks.length;
      rowHunk = undefined;
      walkContextLines(
        len,
        (index) =>
          emitContextRow(
            index,
            'context-expanded',
            0,
            index === len - 1 ? collapsedLines : 0
          ),
        undefined,
        shouldBreak
      );
    }
  }
}
