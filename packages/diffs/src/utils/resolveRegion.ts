import type { FileDiffMetadata, Hunk } from '../types';
import {
  getHunkSideEndBoundary,
  getHunkSideStartBoundary,
} from './getHunkSideBoundaries';

interface RegionResolutionTarget {
  hunkIndex: number;
  startContentIndex: number;
  endContentIndex: number;
  resolution: 'deletions' | 'additions' | 'both';
  indexesToDelete?: Set<number>;
}

export function resolveRegion(
  diff: FileDiffMetadata,
  target: RegionResolutionTarget
): FileDiffMetadata {
  const {
    resolution,
    hunkIndex,
    startContentIndex,
    endContentIndex,
    indexesToDelete = new Set(),
  } = target;
  const currentHunk = diff.hunks[hunkIndex];
  if (currentHunk == null) {
    console.error({ diff, hunkIndex });
    throw new Error(`resolveRegion: Invalid hunk index: ${hunkIndex}`);
  }

  if (
    startContentIndex < 0 ||
    endContentIndex >= currentHunk.hunkContent.length ||
    startContentIndex > endContentIndex
  ) {
    throw new Error(
      `resolveRegion: Invalid content range, ${startContentIndex}, ${endContentIndex}`
    );
  }

  const { hunks, additionLines, deletionLines, isPartial } = diff;
  const resolvedDiff: FileDiffMetadata = {
    ...diff,
    hunks: [],
    deletionLines: [],
    additionLines: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    cacheKey:
      diff.cacheKey != null
        ? `${diff.cacheKey}:${resolution[0]}-${hunkIndex}:${startContentIndex}-${endContentIndex}`
        : undefined,
  };

  // Where the next line lands in the resolved diff
  let nextAdditionLineIndex = 0;
  let nextDeletionLineIndex = 0;
  let nextAdditionStart = 1;
  let nextDeletionStart = 1;
  let splitLineCount = 0;
  let unifiedLineCount = 0;
  const updatesEOFState =
    hunkIndex === hunks.length - 1 &&
    endContentIndex === currentHunk.hunkContent.length - 1;

  for (const [index, hunk] of hunks.entries()) {
    const { collapsedBefore } = hunk;
    if (collapsedBefore > 0) {
      // Partial patches track omitted context in `collapsedBefore`, but those
      // lines do not exist in the diff's line arrays. Keep the virtual row
      // counts and file positions in sync without inventing hidden lines.
      if (!isPartial) {
        pushCollapsedContextLines(
          resolvedDiff,
          deletionLines,
          additionLines,
          getHunkSideStartBoundary(hunk.deletionStart, hunk.deletionCount) -
            collapsedBefore,
          getHunkSideStartBoundary(hunk.additionStart, hunk.additionCount) -
            collapsedBefore,
          collapsedBefore
        );
        nextAdditionLineIndex += collapsedBefore;
        nextDeletionLineIndex += collapsedBefore;
      }
      nextAdditionStart += collapsedBefore;
      nextDeletionStart += collapsedBefore;
      splitLineCount += collapsedBefore;
      unifiedLineCount += collapsedBefore;
    }

    const newHunk: Hunk = {
      ...hunk,
      hunkContent: [],
      additionStart: nextAdditionStart,
      deletionStart: nextDeletionStart,
      additionLineIndex: nextAdditionLineIndex,
      deletionLineIndex: nextDeletionLineIndex,
      additionCount: 0,
      deletionCount: 0,
      deletionLines: 0,
      additionLines: 0,
      splitLineStart: splitLineCount,
      unifiedLineStart: unifiedLineCount,
      splitLineCount: 0,
      unifiedLineCount: 0,
    };

    for (const [contentIndex, content] of hunk.hunkContent.entries()) {
      const isTargeted =
        index === hunkIndex &&
        contentIndex >= startContentIndex &&
        contentIndex <= endContentIndex;
      // If we are at an index to delete, replace with an empty context node
      if (isTargeted && indexesToDelete.has(contentIndex)) {
        newHunk.hunkContent.push({
          type: 'context',
          lines: 0,
          deletionLineIndex: nextDeletionLineIndex,
          additionLineIndex: nextAdditionLineIndex,
        });
        continue;
      }

      let lines: number;
      // There's nothing to `resolve` with context nodes, so just push them as
      // they are
      if (content.type === 'context') {
        for (let i = 0; i < content.lines; i++) {
          const line = additionLines[content.additionLineIndex + i];
          if (line == null) {
            console.error({ additionLines, content, i });
            throw new Error(
              'pushContentLinesToDiff: Context line does not exist'
            );
          }
          resolvedDiff.deletionLines.push(line);
          resolvedDiff.additionLines.push(line);
        }
        newHunk.hunkContent.push({
          ...content,
          additionLineIndex: nextAdditionLineIndex,
          deletionLineIndex: nextDeletionLineIndex,
        });
        lines = content.lines;
      }
      // Changes outside of the targeted region are pushed as they are
      else if (!isTargeted) {
        const { additions, deletions } = content;
        for (let i = 0; i < Math.max(deletions, additions); i++) {
          if (i < deletions) {
            const line = deletionLines[content.deletionLineIndex + i];
            if (line == null) {
              console.error({ deletionLines, content, i });
              throw new Error(
                'pushContentLinesToDiff: Deletion line does not exist'
              );
            }
            resolvedDiff.deletionLines.push(line);
          }
          if (i < additions) {
            const line = additionLines[content.additionLineIndex + i];
            if (line == null) {
              console.error({ additionLines, content, i });
              throw new Error(
                'pushContentLinesToDiff: Addition line does not exist'
              );
            }
            resolvedDiff.additionLines.push(line);
          }
        }
        newHunk.hunkContent.push({
          ...content,
          additionLineIndex: nextAdditionLineIndex,
          deletionLineIndex: nextDeletionLineIndex,
        });
        nextAdditionLineIndex += additions;
        nextDeletionLineIndex += deletions;
        nextAdditionStart += additions;
        nextDeletionStart += deletions;
        splitLineCount += Math.max(deletions, additions);
        unifiedLineCount += deletions + additions;
        newHunk.deletionLines += deletions;
        newHunk.additionLines += additions;
        continue;
      }
      // Looks like we have a change to resolve, the kept lines become context
      else {
        if (resolution === 'deletions' || resolution === 'both') {
          for (let i = 0; i < content.deletions; i++) {
            const line = deletionLines[content.deletionLineIndex + i];
            if (line == null) {
              console.error({ deletionLines, content, i });
              throw new Error(
                'pushResolveLinesToDiff: Deletion line does not exist'
              );
            }
            resolvedDiff.deletionLines.push(line);
            resolvedDiff.additionLines.push(line);
          }
        }
        if (resolution === 'additions' || resolution === 'both') {
          for (let i = 0; i < content.additions; i++) {
            const line = additionLines[content.additionLineIndex + i];
            if (line == null) {
              console.error({ additionLines, content, i });
              throw new Error(
                'pushResolveLinesToDiff: Addition line does not exist'
              );
            }
            resolvedDiff.deletionLines.push(line);
            resolvedDiff.additionLines.push(line);
          }
        }
        lines =
          resolution === 'deletions'
            ? content.deletions
            : resolution === 'additions'
              ? content.additions
              : content.deletions + content.additions;
        newHunk.hunkContent.push({
          type: 'context',
          lines,
          deletionLineIndex: nextDeletionLineIndex,
          additionLineIndex: nextAdditionLineIndex,
        });
      }
      nextAdditionLineIndex += lines;
      nextDeletionLineIndex += lines;
      nextAdditionStart += lines;
      nextDeletionStart += lines;
      splitLineCount += lines;
      unifiedLineCount += lines;
    }

    // Everything the hunk consumed since its start
    newHunk.additionCount = nextAdditionStart - newHunk.additionStart;
    newHunk.deletionCount = nextDeletionStart - newHunk.deletionStart;
    newHunk.splitLineCount = splitLineCount - newHunk.splitLineStart;
    newHunk.unifiedLineCount = unifiedLineCount - newHunk.unifiedLineStart;

    if (index === hunkIndex && updatesEOFState) {
      const noEOFCR =
        resolution === 'deletions'
          ? hunk.noEOFCRDeletions
          : hunk.noEOFCRAdditions;
      newHunk.noEOFCRAdditions = noEOFCR;
      newHunk.noEOFCRDeletions = noEOFCR;
    }

    if (newHunk.additionCount === 0) {
      newHunk.additionStart--;
      if (!isPartial) {
        newHunk.additionLineIndex--;
      }
    }
    if (newHunk.deletionCount === 0) {
      newHunk.deletionStart--;
      if (!isPartial) {
        newHunk.deletionLineIndex--;
      }
    }

    resolvedDiff.hunks.push(newHunk);
  }

  const finalHunk = hunks.at(-1);
  if (finalHunk != null && !isPartial) {
    const finalDeletionEnd = getHunkSideEndBoundary(
      finalHunk.deletionStart,
      finalHunk.deletionCount
    );
    const finalAdditionEnd = getHunkSideEndBoundary(
      finalHunk.additionStart,
      finalHunk.additionCount
    );
    const trailingContext = Math.min(
      deletionLines.length - finalDeletionEnd,
      additionLines.length - finalAdditionEnd
    );
    pushCollapsedContextLines(
      resolvedDiff,
      deletionLines,
      additionLines,
      finalDeletionEnd,
      finalAdditionEnd,
      trailingContext
    );
    splitLineCount += trailingContext;
    unifiedLineCount += trailingContext;
  }

  resolvedDiff.splitLineCount = splitLineCount;
  resolvedDiff.unifiedLineCount = unifiedLineCount;

  return resolvedDiff;
}

function pushCollapsedContextLines(
  diff: FileDiffMetadata,
  deletionLines: string[],
  additionLines: string[],
  deletionLineIndex: number,
  additionLineIndex: number,
  lineCount: number
) {
  for (let index = 0; index < lineCount; index++) {
    const deletionLine = deletionLines[deletionLineIndex + index];
    const additionLine = additionLines[additionLineIndex + index];
    if (deletionLine == null || additionLine == null) {
      throw new Error(
        'pushCollapsedContextLines: missing collapsed context line'
      );
    }
    diff.deletionLines.push(deletionLine);
    diff.additionLines.push(additionLine);
  }
}
