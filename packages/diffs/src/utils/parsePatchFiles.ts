import {
  COMMIT_METADATA_SPLIT,
  FILENAME_HEADER_REGEX,
  GIT_DIFF_FILE_BREAK_REGEX,
  INDEX_LINE_METADATA,
} from '../constants';
import type {
  ChangeContent,
  ContextContent,
  FileContents,
  FileDiffMetadata,
  Hunk,
  ParsedPatch,
} from '../types';
import { cleanLastNewline } from './cleanLastNewline';
import { composeCacheKey } from './composeCacheKey';
import { detachString, releaseStringDetachBuffer } from './detachString';
import {
  getHunkSideEndBoundary,
  getHunkSideStartBoundary,
} from './getHunkSideBoundaries';
import { parseQuotedDiffFileName } from './parseQuotedDiffFileName';
import { realignChangeContentBySimilarity } from './realignChangeContent';

// Keep quotes and transport prefixes until decoding, while allowing spaces in
// unquoted paths and escaped quotes inside quoted paths.
const GIT_DIFF_HEADER_FILENAMES =
  /^diff --git ("a\/(?:[^"\\]|\\.)*"|a\/.+?) ("b\/(?:[^"\\]|\\.)*"|b\/.+?)$/;

interface ParsedHunkHeader {
  additionCount: number;
  additionStart: number;
  deletionCount: number;
  deletionStart: number;
  hunkContext?: string;
}

export function processPatch(
  data: string,
  cacheKeyPrefix?: string,
  throwOnError?: boolean
): ParsedPatch {
  try {
    return _processPatch(data, cacheKeyPrefix, throwOnError);
  } finally {
    releaseStringDetachBuffer();
  }
}

function _processPatch(
  data: string,
  cacheKeyPrefix?: string,
  throwOnError = false,
  patchIndex?: number
): ParsedPatch {
  const isGitDiff =
    data.startsWith('diff --git') || data.includes('\ndiff --git');
  let patchMetadata: string | undefined;
  const files: FileDiffMetadata[] = [];
  for (const fileOrPatchMetadata of isGitDiff
    ? splitAtLinePrefix(data, 'diff --git')
    : splitUnifiedDiffFiles(data)) {
    // Anything that is not a file is most likely the introductory metadata
    // from the patch, or something is fucked with the diff format
    if (
      isGitDiff
        ? !GIT_DIFF_FILE_BREAK_REGEX.test(fileOrPatchMetadata)
        : !isUnifiedDiffFileHeaderAt(fileOrPatchMetadata, 0)
    ) {
      if (patchMetadata == null) {
        patchMetadata = detachString(fileOrPatchMetadata);
      } else if (throwOnError) {
        throw Error('parsePatchContent: unknown file blob');
      } else {
        console.error(
          'parsePatchContent: unknown file blob:',
          fileOrPatchMetadata
        );
      }
      continue;
    }
    files.push(
      _processFile(fileOrPatchMetadata, {
        cacheKey:
          cacheKeyPrefix != null
            ? patchIndex == null
              ? composeCacheKey(
                  'patch-file',
                  cacheKeyPrefix,
                  String(files.length)
                )
              : composeCacheKey(
                  'patch-file',
                  cacheKeyPrefix,
                  String(patchIndex),
                  String(files.length)
                )
            : undefined,
        isGitDiff,
        throwOnError,
      })
    );
  }
  return { patchMetadata, files };
}

interface ProcessFileOptions {
  cacheKey?: string;
  isGitDiff?: boolean;
  oldFile?: FileContents;
  newFile?: FileContents;
  throwOnError?: boolean;
}

export function processFile(
  fileDiffString: string,
  options?: ProcessFileOptions
): FileDiffMetadata | undefined {
  try {
    return _processFile(fileDiffString, options);
  } finally {
    releaseStringDetachBuffer();
  }
}

function _processFile(
  fileDiffString: string,
  {
    cacheKey,
    isGitDiff = GIT_DIFF_FILE_BREAK_REGEX.test(fileDiffString),
    oldFile,
    newFile,
    throwOnError = false,
  }: ProcessFileOptions = {}
): FileDiffMetadata {
  let lastHunkEnd = 0;
  const isPartial = oldFile == null || newFile == null;
  let deletionLineIndex = 0;
  let additionLineIndex = 0;
  // The first chunk is the file header, technically not a hunk
  const chunks = splitAtLinePrefix(fileDiffString, '@@ ');
  const currentFile: FileDiffMetadata = {
    name: '',
    type: 'change',
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial,
    // An empty file has no lines at all
    additionLines:
      isPartial || newFile.contents === ''
        ? []
        : splitFileContents(newFile.contents),
    deletionLines:
      isPartial || oldFile.contents === ''
        ? []
        : splitFileContents(oldFile.contents),
    cacheKey: cacheKey == null ? undefined : detachString(cacheKey),
  };

  for (const line of splitWithNewlines(chunks[0])) {
    if (line.startsWith('diff --git')) {
      const filenameMatch = line.trim().match(GIT_DIFF_HEADER_FILENAMES);
      if (filenameMatch == null) {
        if (throwOnError) {
          throw Error('parsePatchContent: invalid git diff header');
        }
        console.error('parsePatchContent: invalid git diff header', line);
        continue;
      }
      const prevName = decodeDiffFileName(filenameMatch[1], true);
      const name = decodeDiffFileName(filenameMatch[2], true);
      currentFile.name = detachString(name);
      if (prevName !== name) {
        currentFile.prevName = detachString(prevName);
      }
      continue;
    }

    const filenameMatch = line.match(FILENAME_HEADER_REGEX);
    if (filenameMatch != null) {
      const [, type, rawFileName] = filenameMatch;
      const fileName = decodeDiffFileName(rawFileName, isGitDiff);
      if (fileName !== '/dev/null') {
        const detachedFileName = detachString(fileName);
        currentFile.name = detachedFileName;
        if (type === '---') {
          currentFile.prevName = detachedFileName;
        }
      }
    }
    // Git diffs have a bunch of additional metadata we can pull from
    else if (isGitDiff) {
      if (line.startsWith('new mode ')) {
        currentFile.mode = detachString(line.slice('new mode'.length).trim());
      } else if (line.startsWith('old mode ')) {
        currentFile.prevMode = detachString(
          line.slice('old mode'.length).trim()
        );
      } else if (line.startsWith('new file mode')) {
        currentFile.type = 'new';
        currentFile.mode = detachString(
          line.slice('new file mode'.length).trim()
        );
      } else if (line.startsWith('deleted file mode')) {
        currentFile.type = 'deleted';
        currentFile.mode = detachString(
          line.slice('deleted file mode'.length).trim()
        );
      } else if (line.startsWith('similarity index')) {
        currentFile.type = line.startsWith('similarity index 100%')
          ? 'rename-pure'
          : 'rename-changed';
      } else if (line.startsWith('index ')) {
        const [, prevObjectId, newObjectId, mode] =
          line.trim().match(INDEX_LINE_METADATA) ?? [];
        if (prevObjectId != null) {
          currentFile.prevObjectId = detachString(prevObjectId);
        }
        if (newObjectId != null) {
          currentFile.newObjectId = detachString(newObjectId);
        }
        if (mode != null) {
          currentFile.mode = detachString(mode);
        }
      } else {
        // Pure renames and copies have no --- / +++ headers. These paths
        // are already relative to the repository, without transport
        // prefixes.
        const renameMatch = line.match(/^(?:rename|copy) (from|to) /);
        if (renameMatch != null) {
          const fileName = detachString(
            decodeDiffFileName(line.slice(renameMatch[0].length))
          );
          if (renameMatch[1] === 'from') {
            currentFile.prevName = fileName;
          } else {
            currentFile.name = fileName;
          }
        }
      }
    }
  }

  for (let chunkIndex = 1; chunkIndex < chunks.length; chunkIndex++) {
    const hunk = chunks[chunkIndex];
    const lines = splitWithNewlines(hunk);
    const firstLine = lines[0];
    const fileHeader = parseHunkHeader(firstLine);
    if (fileHeader == null) {
      if (throwOnError) {
        throw Error('parsePatchContent: Invalid hunk');
      }
      console.error('parsePatchContent: Invalid hunk', hunk);
      continue;
    }
    let additionLines = 0;
    let deletionLines = 0;

    // Otherwise, time to start parsing out the hunk
    let currentContent: ContextContent | ChangeContent | undefined;
    let lastLineType: 'context' | 'addition' | 'deletion' | undefined;

    // Strip trailing bare newlines (format-patch separators between commits)
    // if needed
    let lastLine = lines.at(-1);
    while (
      lastLine === '\n' ||
      lastLine === '\r' ||
      lastLine === '\r\n' ||
      lastLine === ''
    ) {
      lines.pop();
      lastLine = lines.at(-1);
    }

    const { additionStart, additionCount, deletionStart, deletionCount } =
      fileHeader;
    if (!isPartial) {
      deletionLineIndex = deletionStart - 1;
      additionLineIndex = additionStart - 1;
    }

    const hunkData: Hunk = {
      collapsedBefore: 0,

      splitLineCount: 0,
      splitLineStart: 0,

      unifiedLineCount: 0,
      unifiedLineStart: 0,

      additionCount,
      additionStart,
      additionLines,

      deletionCount,
      deletionStart,
      deletionLines,

      deletionLineIndex,
      additionLineIndex,

      hunkContent: [],
      hunkContext:
        fileHeader.hunkContext == null
          ? undefined
          : detachString(fileHeader.hunkContext),
      hunkSpecs: detachString(firstLine),

      noEOFCRAdditions: false,
      noEOFCRDeletions: false,
    };

    // Now we process each line of the hunk
    let parsedAdditionLines = 0;
    let parsedDeletionLines = 0;
    for (let lineIndex = 1; lineIndex < lines.length; lineIndex++) {
      const rawLine = lines[lineIndex];
      const firstChar = rawLine[0];
      const isBodyLine =
        firstChar === '+' || firstChar === '-' || firstChar === ' ';
      if (
        parsedAdditionLines >= additionCount &&
        parsedDeletionLines >= deletionCount &&
        firstChar !== '\\'
      ) {
        // A format-patch version separator (`-- `) ends the last hunk
        if (!isBodyLine || /^--[ \t\r\n]*$/.test(rawLine)) {
          break;
        }
        if (throwOnError) {
          throw Error('parsePatchContent: hunk has more lines than expected');
        }
      }

      if (firstChar === '\\') {
        if (currentContent == null) {
          continue;
        }
        // If we're dealing with partial content from a diff, we need to strip
        // newlines manually from the content
        if (lastLineType !== 'deletion') {
          hunkData.noEOFCRAdditions = true;
          if (isPartial) {
            currentFile.additionLines.push(
              cleanLastNewline(currentFile.additionLines.pop()!)
            );
          }
        }
        if (lastLineType !== 'addition') {
          hunkData.noEOFCRDeletions = true;
          if (isPartial) {
            currentFile.deletionLines.push(
              cleanLastNewline(currentFile.deletionLines.pop()!)
            );
          }
        }
        continue;
      }

      // If we can't properly process the line, well, lets just try to salvage
      // things and continue... It's possible an AI generated diff might have
      // some stray blank lines or something in there
      if (!isBodyLine) {
        if (throwOnError) {
          throw Error('parsePatchContent: invalid hunk line');
        }
        console.error(
          `parseLineType: Invalid firstChar: "${firstChar}", full line: "${rawLine}"`
        );
        console.error('processFile: invalid rawLine:', rawLine);
        continue;
      }

      if (firstChar === ' ') {
        if (
          throwOnError &&
          (parsedDeletionLines >= deletionCount ||
            parsedAdditionLines >= additionCount)
        ) {
          throw Error('parsePatchContent: hunk has too many context lines');
        }
        if (currentContent?.type !== 'context') {
          currentContent = {
            type: 'context',
            lines: 0,
            additionLineIndex,
            deletionLineIndex,
          };
          hunkData.hunkContent.push(currentContent);
        }
        currentContent.lines++;
        lastLineType = 'context';
      } else {
        const isAddition = firstChar === '+';
        if (
          throwOnError &&
          (isAddition
            ? parsedAdditionLines >= additionCount
            : parsedDeletionLines >= deletionCount)
        ) {
          throw Error(
            `parsePatchContent: hunk has too many ${isAddition ? 'addition' : 'deletion'} lines`
          );
        }
        if (currentContent?.type !== 'change') {
          currentContent = {
            type: 'change',
            additions: 0,
            deletions: 0,
            additionLineIndex,
            deletionLineIndex,
          };
          hunkData.hunkContent.push(currentContent);
        }
        if (isAddition) {
          currentContent.additions++;
          additionLines++;
          lastLineType = 'addition';
        } else {
          currentContent.deletions++;
          deletionLines++;
          lastLineType = 'deletion';
        }
      }

      const processedLine = rawLine.slice(1);
      const line = detachString(processedLine === '' ? '\n' : processedLine);
      if (firstChar !== '-') {
        additionLineIndex++;
        parsedAdditionLines++;
        if (isPartial) {
          currentFile.additionLines.push(line);
        }
      }
      if (firstChar !== '+') {
        deletionLineIndex++;
        parsedDeletionLines++;
        if (isPartial) {
          currentFile.deletionLines.push(line);
        }
      }
    }

    if (
      parsedAdditionLines !== additionCount ||
      parsedDeletionLines !== deletionCount
    ) {
      if (throwOnError) {
        throw Error('parsePatchContent: hunk line count mismatch');
      }
      console.error(
        `parsePatchContent: hunk line count mismatch: "${firstLine.trimEnd()}", declared old/new ${deletionCount}/${additionCount}, parsed old/new ${parsedDeletionLines}/${parsedAdditionLines}`
      );
      // Re-encode each original boundary using the repaired count. Zero-count
      // ranges use the boundary itself as their start; positive ranges use +1.
      const repairedAdditionStart =
        getHunkSideStartBoundary(additionStart, additionCount) +
        (parsedAdditionLines === 0 ? 0 : 1);
      const repairedDeletionStart =
        getHunkSideStartBoundary(deletionStart, deletionCount) +
        (parsedDeletionLines === 0 ? 0 : 1);

      // Hydrated hunks index into full-file line arrays, so their indexes must
      // move with repaired starts. Partial hunks index patch-built arrays.
      if (!isPartial) {
        const additionStartDelta = repairedAdditionStart - additionStart;
        const deletionStartDelta = repairedDeletionStart - deletionStart;
        hunkData.additionLineIndex += additionStartDelta;
        hunkData.deletionLineIndex += deletionStartDelta;
        for (const content of hunkData.hunkContent) {
          content.additionLineIndex += additionStartDelta;
          content.deletionLineIndex += deletionStartDelta;
        }
      }

      hunkData.additionStart = repairedAdditionStart;
      hunkData.deletionStart = repairedDeletionStart;
      hunkData.additionCount = parsedAdditionLines;
      hunkData.deletionCount = parsedDeletionLines;
    }

    hunkData.additionLines = additionLines;
    hunkData.deletionLines = deletionLines;

    hunkData.collapsedBefore = Math.max(
      getHunkSideStartBoundary(hunkData.additionStart, hunkData.additionCount) -
        lastHunkEnd,
      0
    );
    currentFile.hunks.push(hunkData);
    lastHunkEnd = getHunkSideEndBoundary(
      hunkData.additionStart,
      hunkData.additionCount
    );
    for (const content of hunkData.hunkContent) {
      if (content.type === 'context') {
        hunkData.splitLineCount += content.lines;
        hunkData.unifiedLineCount += content.lines;
      } else {
        hunkData.splitLineCount += Math.max(
          content.additions,
          content.deletions
        );
        hunkData.unifiedLineCount += content.deletions + content.additions;
      }
    }
    hunkData.splitLineStart =
      currentFile.splitLineCount + hunkData.collapsedBefore;
    hunkData.unifiedLineStart =
      currentFile.unifiedLineCount + hunkData.collapsedBefore;

    currentFile.splitLineCount +=
      hunkData.collapsedBefore + hunkData.splitLineCount;
    currentFile.unifiedLineCount +=
      hunkData.collapsedBefore + hunkData.unifiedLineCount;
  }
  if (
    throwOnError &&
    isPartial &&
    !isGitDiff &&
    currentFile.hunks.length === 0
  ) {
    throw Error('parsePatchContent: unified file has no hunks');
  }

  // Account for collapsed lines after the final hunk and increment the
  // split/unified counts properly
  if (
    currentFile.hunks.length > 0 &&
    !isPartial &&
    currentFile.additionLines.length > 0 &&
    currentFile.deletionLines.length > 0
  ) {
    const collapsedAfter = Math.max(
      currentFile.additionLines.length - lastHunkEnd,
      0
    );
    currentFile.splitLineCount += collapsedAfter;
    currentFile.unifiedLineCount += collapsedAfter;
  }

  // If this isn't a git diff style patch, then we'll need to sus out some
  // additional metadata manually
  if (!isGitDiff) {
    if (
      currentFile.prevName != null &&
      currentFile.name !== currentFile.prevName
    ) {
      currentFile.type =
        currentFile.hunks.length > 0 ? 'rename-changed' : 'rename-pure';
    }
    // Sort of a hack for detecting deleted/added files...
    else if (!oldFile?.contents && newFile?.contents) {
      currentFile.type = 'new';
    } else if (oldFile?.contents && !newFile?.contents) {
      currentFile.type = 'deleted';
    }
  }
  if (
    currentFile.type !== 'rename-pure' &&
    currentFile.type !== 'rename-changed'
  ) {
    currentFile.prevName = undefined;
  }
  // Pair change-block lines by similarity instead of the patch's positional
  // ordering. Partial diffs work too: their hunk line indexes point into the
  // patch-built line arrays, which hold every line a block references.
  realignChangeContentBySimilarity(currentFile);
  return currentFile;
}

/**
 * Parses a patch file string into an array of parsed patches.
 *
 * @param data - The raw patch file content (supports multi-commit patches)
 * @param cacheKeyPrefix - Optional prefix for collision-safe cache keys derived
 *   from the prefix, patch index, and file index. This enables caching of
 *   rendered diff results in the worker pool.
 * @param throwOnError - When true, invalid data throws. When false, invalid data
 *   is reported with `console.error` and the parser attempts to recover when
 *   possible. Recovery is best-effort and does not guarantee valid output.
 */
export function parsePatchFiles(
  data: string,
  cacheKeyPrefix?: string,
  throwOnError = false
): ParsedPatch[] {
  // NOTE(amadeus): This function is pretty forgiving in that it can accept a
  // patch file that includes commit metdata, multiple commits, or not
  const patches: ParsedPatch[] = [];
  for (const patch of data.startsWith('From ') || data.includes('\nFrom ')
    ? data.split(COMMIT_METADATA_SPLIT)
    : [data]) {
    try {
      patches.push(
        _processPatch(
          patch,
          cacheKeyPrefix,
          throwOnError,
          cacheKeyPrefix != null ? patches.length : undefined
        )
      );
    } catch (error) {
      if (throwOnError) {
        throw error;
      }
      console.error(error);
    } finally {
      releaseStringDetachBuffer();
    }
  }
  return patches;
}

// Decode only quoted tokens, preserving whitespace inside them. Git's a/ and
// b/ prefixes are part of the quoted token and must be removed after decoding.
function decodeDiffFileName(value: string, stripGitPrefix = false): string {
  const rawName = value.trim();
  const name = rawName.startsWith('"')
    ? (parseQuotedDiffFileName(rawName)?.fileName ?? rawName)
    : rawName;
  return stripGitPrefix && (name.startsWith('a/') || name.startsWith('b/'))
    ? name.slice(2)
    : name;
}

function splitFileContents(contents: string): string[] {
  const lines = splitWithNewlines(contents);
  for (let index = 0; index < lines.length; index++) {
    lines[index] = detachString(lines[index]);
  }
  return lines;
}

function splitWithNewlines(contents: string): string[] {
  const lines: string[] = [];
  let startIndex = 0;
  for (
    let newlineIndex = contents.indexOf('\n');
    newlineIndex !== -1;
    newlineIndex = contents.indexOf('\n', startIndex)
  ) {
    lines.push(contents.slice(startIndex, newlineIndex + 1));
    startIndex = newlineIndex + 1;
  }
  // Empty contents still produce one empty line
  if (startIndex < contents.length || lines.length === 0) {
    lines.push(contents.slice(startIndex));
  }
  return lines;
}

function splitUnifiedDiffFiles(contents: string): string[] {
  if (contents.length === 0) {
    return [''];
  }

  const parts: string[] = [];
  let partStartIndex = 0;
  let lineStartIndex = 0;
  let remainingDeletionLines = 0;
  let remainingAdditionLines = 0;
  let hasOpenedUnifiedFile = false;

  while (lineStartIndex < contents.length) {
    const nextLineStartIndex = getNextLineStartIndex(contents, lineStartIndex);
    if (remainingDeletionLines <= 0 && remainingAdditionLines <= 0) {
      if (isUnifiedDiffFileHeaderAt(contents, lineStartIndex)) {
        if (lineStartIndex > partStartIndex) {
          parts.push(contents.slice(partStartIndex, lineStartIndex));
        }
        partStartIndex = lineStartIndex;
        hasOpenedUnifiedFile = true;
        lineStartIndex = getNextLineStartIndex(contents, nextLineStartIndex);
        continue;
      }

      if (hasOpenedUnifiedFile && contents.startsWith('@@ -', lineStartIndex)) {
        const fileHeader = parseHunkHeader(
          contents.slice(lineStartIndex, nextLineStartIndex)
        );
        if (fileHeader != null) {
          remainingDeletionLines = fileHeader.deletionCount;
          remainingAdditionLines = fileHeader.additionCount;
        }
      }
      lineStartIndex = nextLineStartIndex;
      continue;
    }

    const firstChar = contents[lineStartIndex];
    if (firstChar === ' ' || firstChar === '-') {
      remainingDeletionLines = Math.max(remainingDeletionLines - 1, 0);
    }
    if (firstChar === ' ' || firstChar === '+') {
      remainingAdditionLines = Math.max(remainingAdditionLines - 1, 0);
    }
    lineStartIndex = nextLineStartIndex;
  }

  parts.push(contents.slice(partStartIndex));
  return parts;
}

function isUnifiedDiffFileHeaderAt(contents: string, lineStartIndex: number) {
  return (
    isUnifiedDiffHeaderLineAt(contents, lineStartIndex, '---') &&
    isUnifiedDiffHeaderLineAt(
      contents,
      getNextLineStartIndex(contents, lineStartIndex),
      '+++'
    )
  );
}

function isUnifiedDiffHeaderLineAt(
  contents: string,
  lineStartIndex: number,
  prefix: '---' | '+++'
): boolean {
  if (!contents.startsWith(prefix, lineStartIndex)) {
    return false;
  }

  const separator = contents[lineStartIndex + prefix.length];
  if (separator !== ' ' && separator !== '\t') {
    return false;
  }

  for (
    let index = lineStartIndex + prefix.length + 1;
    index < contents.length;
    index++
  ) {
    const char = contents[index];
    if (char === '\n' || char === '\r') {
      break;
    }
    if (char !== ' ' && char !== '\t') {
      return true;
    }
  }
  return false;
}

function getNextLineStartIndex(
  contents: string,
  lineStartIndex: number
): number {
  const newlineIndex = contents.indexOf('\n', lineStartIndex);
  return newlineIndex === -1 ? contents.length : newlineIndex + 1;
}

// Hand-rolled `@@ -start[,count] +start[,count] @@[ context]` parser, it is
// much faster than a regex. A missing count means 1.
function parseHunkHeader(line: string): ParsedHunkHeader | undefined {
  if (!line.startsWith('@@ -')) {
    return undefined;
  }

  const deletionStartResult = readPositiveInteger(line, 4);
  if (deletionStartResult == null) {
    return undefined;
  }
  let index = deletionStartResult.endIndex;

  let deletionCount = 1;
  if (line[index] === ',') {
    const deletionCountResult = readPositiveInteger(line, index + 1);
    if (deletionCountResult == null) {
      return undefined;
    }
    deletionCount = deletionCountResult.value;
    index = deletionCountResult.endIndex;
  }

  if (line[index] !== ' ' || line[index + 1] !== '+') {
    return undefined;
  }

  const additionStartResult = readPositiveInteger(line, index + 2);
  if (additionStartResult == null) {
    return undefined;
  }
  index = additionStartResult.endIndex;

  let additionCount = 1;
  if (line[index] === ',') {
    const additionCountResult = readPositiveInteger(line, index + 1);
    if (additionCountResult == null) {
      return undefined;
    }
    additionCount = additionCountResult.value;
    index = additionCountResult.endIndex;
  }

  if (
    line[index] !== ' ' ||
    line[index + 1] !== '@' ||
    line[index + 2] !== '@'
  ) {
    return undefined;
  }

  let hunkContext: string | undefined;
  if (line[index + 3] === ' ') {
    hunkContext = line.slice(index + 4);
    if (hunkContext.endsWith('\n')) {
      hunkContext = hunkContext.slice(
        0,
        hunkContext.endsWith('\r\n') ? -2 : -1
      );
    }
  }

  return {
    additionCount,
    additionStart: additionStartResult.value,
    deletionCount,
    deletionStart: deletionStartResult.value,
    hunkContext,
  };
}

function readPositiveInteger(
  value: string,
  startIndex: number
): { value: number; endIndex: number } | undefined {
  let index = startIndex;
  let parsedValue = 0;
  for (; index < value.length; index++) {
    const digit = value.charCodeAt(index) - 48;
    if (digit < 0 || digit > 9) {
      break;
    }
    parsedValue = parsedValue * 10 + digit;
  }
  return index === startIndex
    ? undefined
    : { value: parsedValue, endIndex: index };
}

function splitAtLinePrefix(contents: string, prefix: string): string[] {
  const newlinePrefix = `\n${prefix}`;
  const parts: string[] = [];
  let startIndex = 0;
  for (
    let newlineIndex = contents.indexOf(newlinePrefix);
    newlineIndex !== -1;
    newlineIndex = contents.indexOf(newlinePrefix, startIndex)
  ) {
    parts.push(contents.slice(startIndex, newlineIndex + 1));
    startIndex = newlineIndex + 1;
  }
  parts.push(contents.slice(startIndex));
  return parts;
}
