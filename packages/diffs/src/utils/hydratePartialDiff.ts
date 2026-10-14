import type { FileDiffLoadedFiles, FileDiffMetadata, Hunk } from '../types';
import { cloneFileDiffMetadata } from './cloneFileDiffMetadata';
import { composeCacheKey } from './composeCacheKey';
import {
  getHunkSideEndBoundary,
  getHunkSideStartBoundary,
} from './getHunkSideBoundaries';
import { splitFileContents } from './splitFileContents';

/**
 * Hydrates a partial diff in place with full file line arrays.
 */
export function hydratePartialDiff(
  type: 'clone' | 'merge',
  fileDiff: FileDiffMetadata,
  { oldFile, newFile }: FileDiffLoadedFiles
): FileDiffMetadata {
  const targetFileDiff =
    type === 'clone' ? cloneFileDiffMetadata(fileDiff) : fileDiff;

  if (!targetFileDiff.isPartial) {
    throw new Error('hydratePartialDiff: fileDiff must be partial');
  }

  const requires = `hydratePartialDiff: ${targetFileDiff.type} diff for ${targetFileDiff.name} requires`;
  let loadedCacheKey: string | undefined;
  switch (targetFileDiff.type) {
    case 'change':
    case 'rename-changed': {
      if (oldFile == null) {
        throw new Error(`${requires} oldFile`);
      }
      if (newFile == null) {
        throw new Error(`${requires} newFile`);
      }
      const deletionLines = splitFileContents(oldFile.contents);
      const additionLines = splitFileContents(newFile.contents);
      const hunks: Hunk[] = [];
      let splitLineCount = 0;
      let unifiedLineCount = 0;
      let lastHunkAdditionEnd = 0;

      for (const hunk of targetFileDiff.hunks) {
        const additionLineIndex = Math.max(hunk.additionStart - 1, 0);
        const deletionLineIndex = Math.max(hunk.deletionStart - 1, 0);
        let contentAdditionLineIndex = additionLineIndex;
        let contentDeletionLineIndex = deletionLineIndex;
        let hunkAdditionLines = 0;
        let hunkDeletionLines = 0;
        let hunkSplitLineCount = 0;
        let hunkUnifiedLineCount = 0;
        const hunkContent: Hunk['hunkContent'] = [];

        for (const content of hunk.hunkContent) {
          hunkContent.push({
            ...content,
            additionLineIndex: contentAdditionLineIndex,
            deletionLineIndex: contentDeletionLineIndex,
          });
          if (content.type === 'context') {
            contentAdditionLineIndex += content.lines;
            contentDeletionLineIndex += content.lines;
            hunkSplitLineCount += content.lines;
            hunkUnifiedLineCount += content.lines;
          } else {
            contentAdditionLineIndex += content.additions;
            contentDeletionLineIndex += content.deletions;
            hunkAdditionLines += content.additions;
            hunkDeletionLines += content.deletions;
            hunkSplitLineCount += Math.max(
              content.additions,
              content.deletions
            );
            hunkUnifiedLineCount += content.additions + content.deletions;
          }
        }

        const collapsedBefore = Math.max(
          getHunkSideStartBoundary(hunk.additionStart, hunk.additionCount) -
            lastHunkAdditionEnd,
          0
        );
        hunks.push({
          ...hunk,
          collapsedBefore,
          additionLineIndex,
          deletionLineIndex,
          additionLines: hunkAdditionLines,
          deletionLines: hunkDeletionLines,
          hunkContent,
          splitLineStart: splitLineCount + collapsedBefore,
          unifiedLineStart: unifiedLineCount + collapsedBefore,
          splitLineCount: hunkSplitLineCount,
          unifiedLineCount: hunkUnifiedLineCount,
        });

        splitLineCount += collapsedBefore + hunkSplitLineCount;
        unifiedLineCount += collapsedBefore + hunkUnifiedLineCount;
        lastHunkAdditionEnd = getHunkSideEndBoundary(
          hunk.additionStart,
          hunk.additionCount
        );
      }

      if (hunks.length > 0) {
        const collapsedAfter = Math.max(
          additionLines.length - lastHunkAdditionEnd,
          0
        );
        splitLineCount += collapsedAfter;
        unifiedLineCount += collapsedAfter;
      }

      targetFileDiff.hunks = hunks;
      targetFileDiff.splitLineCount = splitLineCount;
      targetFileDiff.unifiedLineCount = unifiedLineCount;
      targetFileDiff.isPartial = false;
      targetFileDiff.deletionLines = deletionLines;
      targetFileDiff.additionLines = additionLines;
      loadedCacheKey =
        oldFile.cacheKey != null && newFile.cacheKey != null
          ? composeCacheKey(
              'hydrated-files',
              oldFile.cacheKey,
              newFile.cacheKey
            )
          : undefined;
      break;
    }
    case 'rename-pure': {
      if (newFile == null) {
        throw new Error(`${requires} newFile`);
      }
      if (oldFile !== null) {
        throw new Error(`${requires} oldFile to be null`);
      }
      const lines = splitFileContents(newFile.contents);
      targetFileDiff.isPartial = false;
      targetFileDiff.deletionLines = lines;
      targetFileDiff.additionLines = lines;
      loadedCacheKey = newFile.cacheKey;
      break;
    }
    default:
      throw new Error(
        `hydratePartialDiff: ${targetFileDiff.type} diffs cannot be hydrated from loaded files`
      );
  }

  const cacheKey =
    targetFileDiff.cacheKey != null
      ? `${targetFileDiff.cacheKey}:hydrated`
      : loadedCacheKey;
  if (cacheKey == null) {
    delete targetFileDiff.cacheKey;
  } else {
    targetFileDiff.cacheKey = cacheKey;
  }
  return targetFileDiff;
}
