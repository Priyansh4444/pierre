import type {
  FileDiffMetadata,
  Hunk,
  HunkExpansionRegion,
  HunkSeparators,
  VirtualFileMetrics,
} from '../types';
import { getDefaultHunkSeparatorHeight } from './computeVirtualFileMetrics';
import {
  getHunkSideEndBoundary,
  getHunkSideStartBoundary,
} from './getHunkSideBoundaries';

export interface ExpandedRegionResult {
  fromStart: number;
  fromEnd: number;
  rangeSize: number;
  collapsedLines: number;
  renderAll: boolean;
}

export interface GetExpandedRegionProps {
  isPartial: boolean;
  rangeSize: number;
  expandedHunks: Map<number, HunkExpansionRegion> | true | undefined;
  hunkIndex: number;
  collapsedContextThreshold: number;
}

export interface GetTrailingContextRangeSizeProps {
  fileDiff: FileDiffMetadata;
  errorPrefix: string;
}

export interface GetTrailingExpandedRegionProps extends GetTrailingContextRangeSizeProps {
  hunkIndex: number;
  expandedHunks: GetExpandedRegionProps['expandedHunks'];
  collapsedContextThreshold: number;
}

// One-based new-file line range covered by a hunk, as `[start, end)`.
export function getHunkAdditionLineRange(hunk: Hunk): [number, number] {
  return [
    getHunkSideStartBoundary(hunk.additionStart, hunk.additionCount) + 1,
    getHunkSideEndBoundary(hunk.additionStart, hunk.additionCount) + 1,
  ];
}

export interface HunkSeparatorLayout {
  height: number;
  gapBefore: number;
  gapAfter: number;
  totalHeight: number;
}

interface HunkSeparatorBaseProps {
  type: HunkSeparators;
  metrics: VirtualFileMetrics;
}

interface LeadingHunkSeparatorLayoutProps extends HunkSeparatorBaseProps {
  hunkIndex: number;
  hunkSpecs: string | undefined;
}

// Converts a collapsed unchanged range into the slices that should render near
// the start and end of that range for the active hunk expansion state.
export function getExpandedRegion({
  isPartial,
  rangeSize,
  expandedHunks,
  hunkIndex,
  collapsedContextThreshold,
}: GetExpandedRegionProps): ExpandedRegionResult {
  const normalizedRangeSize = Math.max(rangeSize, 0);
  if (normalizedRangeSize === 0 || isPartial) {
    return {
      fromStart: 0,
      fromEnd: 0,
      rangeSize: normalizedRangeSize,
      collapsedLines: normalizedRangeSize,
      renderAll: false,
    };
  }

  if (
    expandedHunks === true ||
    normalizedRangeSize <= collapsedContextThreshold
  ) {
    return {
      fromStart: normalizedRangeSize,
      fromEnd: 0,
      rangeSize: normalizedRangeSize,
      collapsedLines: 0,
      renderAll: true,
    };
  }

  const region = expandedHunks?.get(hunkIndex);
  const fromStart = Math.min(
    Math.max(region?.fromStart ?? 0, 0),
    normalizedRangeSize
  );
  const fromEnd = Math.min(
    Math.max(region?.fromEnd ?? 0, 0),
    normalizedRangeSize
  );
  const expandedCount = fromStart + fromEnd;
  const renderAll = expandedCount >= normalizedRangeSize;
  return {
    fromStart: renderAll ? normalizedRangeSize : fromStart,
    fromEnd: renderAll ? 0 : fromEnd,
    rangeSize: normalizedRangeSize,
    collapsedLines: Math.max(normalizedRangeSize - expandedCount, 0),
    renderAll,
  };
}

// Unchanged [addition, deletion] line counts after the final hunk, or undefined
// when neither side has any.
function getTrailingContextRemaining(
  fileDiff: FileDiffMetadata
): [number, number] | undefined {
  const lastHunk = fileDiff.hunks.at(-1);
  if (
    lastHunk == null ||
    fileDiff.isPartial ||
    fileDiff.additionLines.length === 0 ||
    fileDiff.deletionLines.length === 0
  ) {
    return undefined;
  }

  const additionRemaining =
    fileDiff.additionLines.length -
    getHunkSideEndBoundary(lastHunk.additionStart, lastHunk.additionCount);
  const deletionRemaining =
    fileDiff.deletionLines.length -
    getHunkSideEndBoundary(lastHunk.deletionStart, lastHunk.deletionCount);
  return additionRemaining > 0 || deletionRemaining > 0
    ? [additionRemaining, deletionRemaining]
    : undefined;
}

// Returns true when trailing-context line counts disagree between sides.
export function hasTrailingContextMismatch(
  fileDiff: FileDiffMetadata
): boolean {
  const remaining = getTrailingContextRemaining(fileDiff);
  return remaining != null && remaining[0] !== remaining[1];
}

// Measures the unchanged tail after the final hunk. Both sides must have the
// same remaining length because trailing context represents paired lines.
export function getTrailingContextRangeSize({
  fileDiff,
  errorPrefix,
}: GetTrailingContextRangeSizeProps): number {
  const remaining = getTrailingContextRemaining(fileDiff);
  if (remaining == null) {
    return 0;
  }
  const [additionRemaining, deletionRemaining] = remaining;
  if (additionRemaining !== deletionRemaining) {
    throw new Error(
      `${errorPrefix}: trailing context mismatch (additions=${additionRemaining}, deletions=${deletionRemaining}) for ${fileDiff.name}`
    );
  }
  return additionRemaining;
}

export function getTrailingExpandedRegion({
  fileDiff,
  hunkIndex,
  expandedHunks,
  collapsedContextThreshold,
  errorPrefix,
}: GetTrailingExpandedRegionProps): ExpandedRegionResult | undefined {
  if (hunkIndex !== fileDiff.hunks.length - 1) {
    return undefined;
  }

  const trailingRangeSize = getTrailingContextRangeSize({
    fileDiff,
    errorPrefix,
  });
  if (trailingRangeSize <= 0) {
    return undefined;
  }

  if (
    expandedHunks === true ||
    trailingRangeSize <= collapsedContextThreshold
  ) {
    return {
      fromStart: trailingRangeSize,
      fromEnd: 0,
      rangeSize: trailingRangeSize,
      collapsedLines: 0,
      renderAll: true,
    };
  }

  // The final trailing separator only exposes upward partial expansion. Treat it
  // as a bottom-only pseudo-hunk and ignore unsupported downward expansion.
  const region = expandedHunks?.get(fileDiff.hunks.length);
  const fromStart = Math.min(
    Math.max(region?.fromStart ?? 0, 0),
    trailingRangeSize
  );
  return {
    fromStart,
    fromEnd: 0,
    rangeSize: trailingRangeSize,
    collapsedLines: trailingRangeSize - fromStart,
    renderAll: fromStart >= trailingRangeSize,
  };
}

export interface IsAdditionLineRenderableProps {
  fileDiff: FileDiffMetadata;
  /** One-based line number in the new file. */
  lineNumber: number;
  expandedHunks: Map<number, HunkExpansionRegion> | true | undefined;
  collapsedContextThreshold: number;
}

// Whether a one-based new-file line currently has (or will have on scroll) a
// rendered row under the given expansion state — the editor-facing visibility
// oracle. False only for lines hidden inside a collapsed unchanged region;
// lines outside the diff's modeled range report true so callers keep their
// existing missing-row handling. Computed from the same inputs as
// `iterateOverDiff` so layout math and the oracle cannot diverge.
export function isAdditionLineRenderable({
  fileDiff,
  lineNumber,
  expandedHunks,
  collapsedContextThreshold,
}: IsAdditionLineRenderableProps): boolean {
  if (expandedHunks === true || fileDiff.isPartial) {
    return true;
  }

  for (const [hunkIndex, hunk] of fileDiff.hunks.entries()) {
    const [hunkStart, hunkEnd] = getHunkAdditionLineRange(hunk);
    if (lineNumber < hunkStart) {
      // Inside the collapsed gap before this hunk: renderable only within
      // the expanded slices at the gap's edges.
      const region = getExpandedRegion({
        isPartial: fileDiff.isPartial,
        rangeSize: hunk.collapsedBefore,
        expandedHunks,
        hunkIndex,
        collapsedContextThreshold,
      });
      const gapStart = hunkStart - region.rangeSize;
      return (
        region.renderAll ||
        lineNumber < gapStart + region.fromStart ||
        lineNumber >= hunkStart - region.fromEnd
      );
    }
    if (lineNumber < hunkEnd) {
      return true;
    }
  }

  const trailingRegion = getTrailingExpandedRegion({
    fileDiff,
    hunkIndex: fileDiff.hunks.length - 1,
    expandedHunks,
    collapsedContextThreshold,
    errorPrefix: 'isAdditionLineRenderable',
  });
  if (trailingRegion == null || trailingRegion.renderAll) {
    return true;
  }
  const lastHunk = fileDiff.hunks[fileDiff.hunks.length - 1];
  const [, trailingStart] = getHunkAdditionLineRange(lastHunk);
  return (
    lineNumber < trailingStart + trailingRegion.fromStart ||
    lineNumber >= trailingStart + trailingRegion.rangeSize
  );
}

export interface GetNearestRenderableAdditionLineProps extends IsAdditionLineRenderableProps {
  direction: 'up' | 'down';
}

// The nearest renderable new-file line at or beyond `lineNumber` in the given
// direction (one-based), or undefined when every line that way is hidden
// inside collapsed regions. Sequential caret motion uses this to skip over
// collapsed regions like code folds; it walks the hunk metadata once instead
// of probing line by line across a gap.
export function getNearestRenderableAdditionLine({
  fileDiff,
  lineNumber,
  direction,
  expandedHunks,
  collapsedContextThreshold,
}: GetNearestRenderableAdditionLineProps): number | undefined {
  if (expandedHunks === true || fileDiff.isPartial) {
    return lineNumber;
  }

  // Renderable [start, end) line ranges in ascending order, plus the
  // exclusive end of the modeled range — anything past it (the editor's
  // phantom document-end line) counts as renderable.
  const ranges: Array<[start: number, end: number]> = [];
  let modeledEnd = 1;
  for (const [hunkIndex, hunk] of fileDiff.hunks.entries()) {
    const [hunkStart, hunkEnd] = getHunkAdditionLineRange(hunk);
    const region = getExpandedRegion({
      isPartial: fileDiff.isPartial,
      rangeSize: hunk.collapsedBefore,
      expandedHunks,
      hunkIndex,
      collapsedContextThreshold,
    });
    const gapStart = hunkStart - region.rangeSize;
    if (region.renderAll) {
      ranges.push([gapStart, hunkStart]);
    } else {
      if (region.fromStart > 0) {
        ranges.push([gapStart, gapStart + region.fromStart]);
      }
      if (region.fromEnd > 0) {
        ranges.push([hunkStart - region.fromEnd, hunkStart]);
      }
    }
    ranges.push([hunkStart, hunkEnd]);
    modeledEnd = hunkEnd;
  }
  const trailingRegion = getTrailingExpandedRegion({
    fileDiff,
    hunkIndex: fileDiff.hunks.length - 1,
    expandedHunks,
    collapsedContextThreshold,
    errorPrefix: 'getNearestRenderableAdditionLine',
  });
  if (trailingRegion != null) {
    const trailingStart = modeledEnd;
    modeledEnd = trailingStart + trailingRegion.rangeSize;
    if (trailingRegion.renderAll) {
      ranges.push([trailingStart, modeledEnd]);
    } else if (trailingRegion.fromStart > 0) {
      ranges.push([trailingStart, trailingStart + trailingRegion.fromStart]);
    }
  }

  if (lineNumber >= modeledEnd) {
    return lineNumber;
  }
  if (direction === 'down') {
    for (const [start, end] of ranges) {
      if (end > lineNumber) {
        return Math.max(start, lineNumber);
      }
    }
    return undefined;
  }
  for (let index = ranges.length - 1; index >= 0; index--) {
    const [start, end] = ranges[index];
    if (start <= lineNumber) {
      return Math.min(end - 1, lineNumber);
    }
  }
  return undefined;
}

// Mirrors the renderer/CSS spacing rules for the separator shown before a hunk.
export function getLeadingHunkSeparatorLayout({
  type,
  metrics,
  hunkIndex,
  hunkSpecs,
}: LeadingHunkSeparatorLayoutProps): HunkSeparatorLayout | undefined {
  if (
    (type === 'simple' && hunkIndex <= 0) ||
    (type === 'metadata' && hunkSpecs == null)
  ) {
    return undefined;
  }

  const height =
    metrics.hunkSeparatorHeight ?? getDefaultHunkSeparatorHeight(type);
  const gap =
    type === 'simple' || type === 'metadata' || type === 'line-info-basic'
      ? 0
      : metrics.spacing;
  const gapBefore = hunkIndex > 0 ? gap : 0;
  return {
    height,
    gapBefore,
    gapAfter: gap,
    totalHeight: gapBefore + height + gap,
  };
}

// Mirrors the renderer/CSS spacing rules for the separator shown after the last
// hunk when trailing unchanged context is collapsed.
export function getTrailingHunkSeparatorLayout({
  type,
  metrics,
}: HunkSeparatorBaseProps): HunkSeparatorLayout | undefined {
  if (type === 'simple' || type === 'metadata') {
    return undefined;
  }

  const height =
    metrics.hunkSeparatorHeight ?? getDefaultHunkSeparatorHeight(type);
  const gapBefore = type === 'line-info-basic' ? 0 : metrics.spacing;
  return {
    height,
    gapBefore,
    gapAfter: 0,
    totalHeight: gapBefore + height,
  };
}
