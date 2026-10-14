import { type CreatePatchOptionsNonabortable, createTwoFilesPatch } from 'diff';

import type { FileContents, FileDiffMetadata } from '../types';
import { composeCacheKey } from './composeCacheKey';
import { processFile } from './parsePatchFiles';

/**
 * Parses a diff from two file contents objects.
 *
 * If both `oldFile` and `newFile` have a `cacheKey`, the resulting diff gets a
 * collision-safe key derived from both values.
 */
export function parseDiffFromFile(
  oldFile: FileContents | null,
  newFile: FileContents | null,
  options?: CreatePatchOptionsNonabortable,
  throwOnError = false
): FileDiffMetadata {
  if (oldFile === null && newFile === null) {
    throw new Error(
      'parseDiffFromFile: You must pass oldFile, newFile, or both'
    );
  }

  const resolvedOldFile = oldFile ?? { name: '/dev/null', contents: '' };
  const resolvedNewFile = newFile ?? { name: '/dev/null', contents: '' };
  const patch = createTwoFilesPatch(
    resolvedOldFile.name,
    resolvedNewFile.name,
    resolvedOldFile.contents,
    resolvedNewFile.contents,
    resolvedOldFile.header,
    resolvedNewFile.header,
    options
  );

  const fileData = processFile(patch, {
    cacheKey:
      oldFile?.cacheKey != null && newFile?.cacheKey != null
        ? composeCacheKey('diff', oldFile.cacheKey, newFile.cacheKey)
        : undefined,
    oldFile: resolvedOldFile,
    newFile: resolvedNewFile,
    throwOnError,
  });
  if (fileData == null) {
    throw new Error(
      'parseDiffFrom: FileInvalid diff -- probably need to fix something -- if the files are the same maybe?'
    );
  }
  if (oldFile === null) {
    fileData.type = 'new';
    fileData.prevName = undefined;
  } else if (newFile === null) {
    fileData.type = 'deleted';
    fileData.prevName = undefined;
  }
  // If we've been provided an override for language in the newFile, let’s pass
  // it through to FileDiffMetadata.
  const language =
    newFile?.lang ?? (newFile === null ? oldFile?.lang : undefined);
  if (language != null) {
    fileData.lang = language;
  }
  return fileData;
}
