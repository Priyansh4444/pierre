import type { CreatePatchOptionsNonabortable } from 'diff';

import type { FileDiffMetadata, Hunk } from '../types';
import { cleanLastNewline } from './cleanLastNewline';
import {
  getHunkSideEndBoundary,
  getHunkSideStartBoundary,
} from './getHunkSideBoundaries';
import { parseDiffFromFile } from './parseDiffFromFile';
import { hasTrailingContextMismatch } from './virtualDiffLayout';

type HunkMetadataUpdate = Pick<
  FileDiffMetadata,
  'hunks' | 'splitLineCount' | 'unifiedLineCount' | 'type'
>;

type FullDiffHunkUpdate = HunkMetadataUpdate &
  Pick<FileDiffMetadata, 'additionLines' | 'deletionLines'>;

// Rebuilds all hunk metadata from the current deletion/addition line arrays.
export function recomputeDiffHunks(
  diff: FileDiffMetadata,
  parseDiffOptions?: CreatePatchOptionsNonabortable
): FullDiffHunkUpdate {
  const {
    hunks,
    splitLineCount,
    unifiedLineCount,
    additionLines,
    deletionLines,
    type,
  } = parseDiffFromFile(
    {
      name: diff.prevName ?? diff.name,
      contents: diff.deletionLines.join(''),
    },
    {
      name: diff.name,
      contents: diff.additionLines.join(''),
      lang: diff.lang,
    },
    parseDiffOptions
  );
  return {
    hunks,
    splitLineCount,
    unifiedLineCount,
    additionLines,
    deletionLines,
    type,
  };
}

// After delete-all the editable side is blank and much shorter than the deletion
// side. A normal recompute can still treat newline-only additions as context and
// render the first editable row deep in split view instead of at the top.
export function shouldTopAlignAdditionRecompute(
  diff: FileDiffMetadata,
  additionLines: string[]
): boolean {
  return (
    additionLines.length > 0 &&
    additionLines.length < diff.deletionLines.length &&
    additionLines.every((line) => line.trim().length === 0)
  );
}

// Rebuilds hunk metadata while keeping the editable addition rows top-aligned in
// split view. The sentinel only shapes hunks; the caller's addition lines are
// preserved so the editor document stays the source of truth.
export function recomputeTopAlignedAdditionDiff(
  diff: FileDiffMetadata,
  additionLines: string[],
  parseDiffOptions?: CreatePatchOptionsNonabortable
): FullDiffHunkUpdate {
  const deletionContents = diff.deletionLines.join('');
  // Placeholder addition contents that diff as one top-aligned change row per
  // line. Bare `\\n` sentinels align as context against the first deletion
  // lines, which pushes the real addition rows down in split view.
  const count = Math.max(additionLines.length, 1);
  let additionSentinel = Array.from(
    { length: count },
    (_, index) => `${' '.repeat(index + 1)}\n`
  ).join('');
  if (additionSentinel === deletionContents) {
    additionSentinel = Array.from(
      { length: count },
      (_, index) => `\u0000${' '.repeat(index)}\n`
    ).join('');
  }
  return {
    ...recomputeDiffHunks(
      { ...diff, additionLines: [additionSentinel] },
      parseDiffOptions
    ),
    additionLines,
  };
}

// Rebuilds hunk metadata when the editable side has been emptied of all text.
//
// The editor always keeps one (empty) line for an empty document, but an empty
// string splits into zero addition lines, so a normal recompute produces a diff
// with no addition rows at all. Rendering that leaves the attached editor with
// no line element to host its caret.
export function recomputeEmptyDocumentDiff(
  diff: FileDiffMetadata,
  parseDiffOptions?: CreatePatchOptionsNonabortable
): FullDiffHunkUpdate {
  return recomputeTopAlignedAdditionDiff(diff, [''], parseDiffOptions);
}

// Rebuilds diff hunks after an edit, top-aligning sparse addition sides when
// needed.
export function recomputeDiffHunksForEdit(
  diff: FileDiffMetadata,
  parseDiffOptions?: CreatePatchOptionsNonabortable
): FullDiffHunkUpdate {
  if (diff.additionLines.length === 0) {
    return recomputeEmptyDocumentDiff(diff, parseDiffOptions);
  }
  if (shouldTopAlignAdditionRecompute(diff, diff.additionLines)) {
    return recomputeTopAlignedAdditionDiff(
      diff,
      diff.additionLines,
      parseDiffOptions
    );
  }
  const recomputed = recomputeDiffHunks(diff, parseDiffOptions);
  preserveTrailingEditorBlankLine(recomputed, diff.additionLines);
  return recomputed;
}

// Re-adds the editor's phantom trailing empty line (a document ending in a
// newline exposes one extra empty line) as an addition row when the last
// hunk's final change block can absorb it, so the caret keeps a rendered row.
export function preserveTrailingEditorBlankLine(
  recomputed: Pick<
    FullDiffHunkUpdate,
    'hunks' | 'additionLines' | 'splitLineCount' | 'unifiedLineCount'
  >,
  additionLines: string[]
): void {
  const extraAdditionLineIndex = recomputed.additionLines.length;
  const extraLineCount = additionLines.length - extraAdditionLineIndex;
  const lastHunk = recomputed.hunks.at(-1);
  if (
    additionLines.length <= 1 ||
    additionLines.at(-1) !== '' ||
    extraLineCount <= 0 ||
    lastHunk == null ||
    getHunkSideEndBoundary(lastHunk.additionStart, lastHunk.additionCount) !==
      extraAdditionLineIndex
  ) {
    return;
  }

  for (const content of lastHunk.hunkContent) {
    if (
      content.type === 'change' &&
      content.additions < content.deletions &&
      content.additionLineIndex + content.additions === extraAdditionLineIndex
    ) {
      recomputed.additionLines = additionLines;
      content.additions += extraLineCount;
      lastHunk.additionCount += extraLineCount;
      lastHunk.additionLines += extraLineCount;
      recomputeDiffRenderLineCounts(recomputed);
      return;
    }
  }
}

// Updates hunk metadata after addition lines change; re-parses affected hunks
// only, and falls back to a full recompute when that is not safe.
export function updateDiffHunks(
  diff: FileDiffMetadata,
  changedAdditionLineIndexes: Iterable<number>,
  parseDiffOptions?: CreatePatchOptionsNonabortable
): HunkMetadataUpdate {
  let recompute =
    diff.isPartial || diff.deletionLines.length !== diff.additionLines.length;
  const changedLines = recompute ? [] : Array.from(changedAdditionLineIndexes);
  const affectedHunkIndexes = new Set<number>();
  for (const line of changedLines) {
    const additionLine = diff.additionLines[line];
    const deletionLine = diff.deletionLines[line];
    const hunkIndex = diff.hunks.findIndex(
      (hunk) =>
        line >= hunk.additionLineIndex &&
        line < hunk.additionLineIndex + hunk.additionCount
    );
    // Restoring a line to the old side can merge/split hunks across context
    // windows.
    if (
      additionLine == null ||
      deletionLine == null ||
      cleanLastNewline(additionLine) === cleanLastNewline(deletionLine) ||
      hunkIndex === -1
    ) {
      recompute = true;
      break;
    }
    affectedHunkIndexes.add(hunkIndex);
  }

  if (!recompute && changedLines.length > 0) {
    for (const hunkIndex of affectedHunkIndexes) {
      const hunk = diff.hunks[hunkIndex];
      const additionOffset = hunk.additionLineIndex;
      const deletionOffset = hunk.deletionLineIndex;
      const reparsed = parseDiffFromFile(
        {
          name: diff.prevName ?? diff.name,
          contents: diff.deletionLines
            .slice(deletionOffset, deletionOffset + hunk.deletionCount)
            .join(''),
        },
        {
          name: diff.name,
          contents: diff.additionLines
            .slice(additionOffset, additionOffset + hunk.additionCount)
            .join(''),
          lang: diff.lang,
        },
        { ...parseDiffOptions, context: 0 }
      );
      if (reparsed.hunks.length !== 1) {
        recompute = true;
        break;
      }

      const parsed = reparsed.hunks[0];
      hunk.hunkContent = parsed.hunkContent.map((content) => ({
        ...content,
        additionLineIndex: content.additionLineIndex + additionOffset,
        deletionLineIndex: content.deletionLineIndex + deletionOffset,
      }));
      hunk.additionLineIndex = additionOffset + parsed.additionLineIndex;
      hunk.additionStart += parsed.additionLineIndex;
      hunk.additionCount = parsed.additionCount;
      hunk.additionLines = parsed.additionLines;
      if (parsed.deletionLineIndex >= 0) {
        hunk.deletionLineIndex = deletionOffset + parsed.deletionLineIndex;
        hunk.deletionStart += parsed.deletionLineIndex;
      }
      hunk.deletionCount = parsed.deletionCount;
      hunk.deletionLines = parsed.deletionLines;
      recomputeHunkRenderLineCounts(hunk);
      syncHunkNoEOFCRFromFullFile(diff, hunkIndex);
    }

    if (!recompute) {
      recomputeDiffRenderLineCounts(diff);
      recompute = hasTrailingContextMismatch(diff);
    }
  }

  const result: HunkMetadataUpdate = recompute
    ? recomputeDiffHunks(diff, parseDiffOptions)
    : {
        hunks: diff.hunks,
        splitLineCount: diff.splitLineCount,
        unifiedLineCount: diff.unifiedLineCount,
        type: diff.type,
      };
  Object.assign(diff, result);
  return result;
}

export function syncHunkNoEOFCRFromFullFile(
  diff: FileDiffMetadata,
  hunkIndex: number
): void {
  const hunk = diff.hunks[hunkIndex];
  if (hunk == null) {
    return;
  }

  // Only the last hunk can touch the end of the file.
  const isLastHunk = hunkIndex === diff.hunks.length - 1;
  const lastAdditionLine = diff.additionLines.at(-1);
  const lastDeletionLine = diff.deletionLines.at(-1);
  hunk.noEOFCRAdditions =
    isLastHunk &&
    lastAdditionLine != null &&
    lastAdditionLine !== '' &&
    !lastAdditionLine.endsWith('\n');
  hunk.noEOFCRDeletions =
    isLastHunk &&
    lastDeletionLine != null &&
    lastDeletionLine !== '' &&
    !lastDeletionLine.endsWith('\n');
}

export function recomputeHunkRenderLineCounts(hunk: Hunk): void {
  let splitLineCount = 0;
  let unifiedLineCount = 0;

  for (const content of hunk.hunkContent) {
    if (content.type === 'context') {
      splitLineCount += content.lines;
      unifiedLineCount += content.lines;
    } else {
      splitLineCount += Math.max(content.additions, content.deletions);
      unifiedLineCount += content.additions + content.deletions;
    }
  }

  hunk.splitLineCount = splitLineCount;
  hunk.unifiedLineCount = unifiedLineCount;
}

export function recomputeDiffRenderLineCounts(
  diff: Pick<
    FileDiffMetadata,
    'hunks' | 'splitLineCount' | 'unifiedLineCount' | 'additionLines'
  >
): void {
  let splitTotal = 0;
  let unifiedTotal = 0;
  let lastHunkAdditionEnd = 0;

  for (const hunk of diff.hunks) {
    hunk.collapsedBefore = Math.max(
      getHunkSideStartBoundary(hunk.additionStart, hunk.additionCount) -
        lastHunkAdditionEnd,
      0
    );
    hunk.splitLineStart = splitTotal + hunk.collapsedBefore;
    hunk.unifiedLineStart = unifiedTotal + hunk.collapsedBefore;

    recomputeHunkRenderLineCounts(hunk);

    splitTotal += hunk.collapsedBefore + hunk.splitLineCount;
    unifiedTotal += hunk.collapsedBefore + hunk.unifiedLineCount;
    lastHunkAdditionEnd = getHunkSideEndBoundary(
      hunk.additionStart,
      hunk.additionCount
    );
  }

  // Lines collapsed after the final hunk
  if (diff.hunks.length > 0) {
    const collapsedAfter = Math.max(
      diff.additionLines.length - lastHunkAdditionEnd,
      0
    );
    splitTotal += collapsedAfter;
    unifiedTotal += collapsedAfter;
  }

  diff.splitLineCount = splitTotal;
  diff.unifiedLineCount = unifiedTotal;
}
