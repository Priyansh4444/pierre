// Parses a file containing git merge conflict markers (<<<<<<< / ======= / >>>>>>>)
// into a synthetic unified diff. The core idea: treat the conflict file as though
// "current" lines are deletions and "incoming" lines are additions. Lines outside
// conflicts (and optional "base" sections from diff3) become shared context.
//
// The result is a standard FileDiffMetadata with hunks — identical in shape to what
// you'd get from parsing a real unified diff — plus a parallel array of
// MergeConflictDiffActions that anchor each conflict region to positions within the
// hunk structure. Downstream consumers (e.g. the merge conflict UI) use these
// anchors to overlay conflict markers onto the diff view.
//
// Architecture note: all helper functions are module-level (not closures inside the
// main function) and receive a shared ParseState object by reference. This avoids
// per-call scope-chain traversal on the hot path (~20K lines), where every line
// triggers 2-3 helper calls.
//
// ---
// NOTE: This file was nearly entirely written and optimized by AI. It has a
// verification harness that any future changes (human or AI) should be validated
// against:
//
//   Snapshot tests (from packages/diffs/):
//     bun test parseMergeConflictDiffFromFile
//
//   Performance benchmark (checksum must match 31314920):
//     moonx diffs:benchmark-parse-merge-conflict
//
// If you encounter a bug:
//   1. Add a new test case in test/parseMergeConflictDiffFromFile.test.ts with
//      input that reproduces the failure. Use toMatchSnapshot() so the expected
//      output is captured automatically once fixed.
//   2. Run `bun test parseMergeConflictDiffFromFile` from packages/diffs/ to
//      confirm the new test fails.
//   3. Use an AI agent with extended/high thinking to fix the logic — the
//      snapshot tests and benchmark provide a tight feedback loop. The agent
//      should iterate until all snapshots pass AND the benchmark checksum
//      matches. Update snapshots with `bun test test/parseMergeConflictDiffFromFile.test.ts -u`
//      only after verifying the new output is correct.
// ---

import type {
  FileContents,
  FileDiffMetadata,
  Hunk,
  MergeConflictMarkerRow,
  MergeConflictMarkerRowType,
  MergeConflictRegion,
  ProcessFileConflictData,
} from '../types';
import {
  getHunkSideEndBoundary,
  getHunkSideStartBoundary,
} from './getHunkSideBoundaries';

export interface ParseMergeConflictDiffFromFileResult {
  fileDiff: FileDiffMetadata;
  currentFile: FileContents;
  incomingFile: FileContents;
  actions: (MergeConflictDiffAction | undefined)[];
  markerRows: MergeConflictMarkerRow[];
}

export interface MergeConflictDiffAction extends ProcessFileConflictData {
  // Kept for callback consumers that still need the original unresolved-region
  // source-line coordinates alongside structural hunk-content anchors.
  conflict: MergeConflictRegion;
  conflictIndex: number;
  markerLines: {
    start: string;
    base?: string;
    separator: string;
    end: string;
  };
}

// Which section of a conflict we're currently inside while scanning lines.
// Progresses: current → (optional) base → incoming.
type MergeConflictStage = 'current' | 'base' | 'incoming';
type MergeConflictMarkerType = 'start' | 'base' | 'separator' | 'end';

// Controls how buffered context lines are trimmed when flushed to hunkContent:
//   'leading'       — first flush of a hunk; trim excess from the start
//   'before-change' — flush between changes; emit all buffered lines
//   'trailing'      — last flush of a hunk; trim excess from the end
type ContextFlushMode = 'before-change' | 'leading' | 'trailing';

// Mutable accumulator for building a single Hunk. Tracks line counts, the
// hunkContent array (sequence of context/change groups), and a "context buffer"
// that defers writing context lines until we know whether they're leading,
// trailing, or mid-hunk context.
//
// The context buffer avoids eagerly committing context lines to hunkContent.
// When a change line arrives, we flush the buffer — trimming to maxContextLines
// if it's the leading or trailing edge of a hunk, or splitting into two hunks
// if the gap between changes exceeds maxContextLines * 2.
interface HunkBuilder {
  additionStart: number;
  deletionStart: number;
  additionCount: number;
  deletionCount: number;
  additionLines: number;
  deletionLines: number;
  additionLineIndex: number;
  deletionLineIndex: number;
  hunkContent: Hunk['hunkContent'];
  // Context buffer: instead of storing per-line index arrays, we track the
  // starting indices and a count. Since context lines always push to both
  // additionLines and deletionLines consecutively, indices can be derived.
  contextBufferAdditionStart: number;
  contextBufferDeletionStart: number;
  contextBufferCount: number;
  // Sparse map of buffer-offset → conflictIndex for base-section context lines.
  // Empty for most buffers since base lines are rare.
  contextBufferBaseConflicts: Map<number, number> | undefined;
}

// Tracks an in-progress conflict as we scan through its lines. Pushed onto
// conflictStack when we hit a <<<<<<< marker, and popped + finalized when we
// hit the matching >>>>>>> marker. The `stage` field tells processLine which
// section we're in so it knows whether to emit deletions, context, or additions.
interface ConflictFrame {
  conflictIndex: number;
  stage: MergeConflictStage;
  startLineIndex: number;
  baseMarkerLineIndex?: number;
  separatorLineIndex?: number;
  markerLines: {
    start: string;
    base?: string;
    separator?: string;
  };
}

// Bundles all mutable state shared across parse helper functions, replacing
// closure-captured variables with a single object passed by reference.
//
// The two key arrays — deletionLines and additionLines — are the synthetic
// "before" and "after" file contents. Context lines are pushed to both arrays
// (identical on both sides). Current-side conflict lines go only into
// deletionLines; incoming-side lines go only into additionLines. After parsing,
// joining each array produces the resolved file for that side.
interface ParseState {
  // "Before" file lines (context + current-side conflict content).
  deletionLines: string[];
  // "After" file lines (context + incoming-side conflict content).
  additionLines: string[];
  // Stack of open conflict regions (supports nested conflicts, though rare).
  conflictStack: ConflictFrame[];
  // One action per conflict, indexed by conflictIndex. Each one is created at
  // its start marker and accumulates content indices during parsing.
  actions: MergeConflictDiffAction[];
  // Finalized hunks, appended as context gaps cause hunk splits.
  hunks: Hunk[];
  // Running line totals used to compute hunk splitLineStart/unifiedLineStart.
  splitLineCount: number;
  unifiedLineCount: number;
  // 1-based line number where the previous hunk ended (for collapsedBefore).
  lastHunkEnd: number;
  // The hunk currently being built; undefined before the first line.
  activeHunk: HunkBuilder | undefined;
  maxContextLines: number;
  // Cached maxContextLines * 2 (the threshold for splitting a hunk).
  maxContextLines2: number;
}

export function getMergeConflictActionAnchor(
  action: MergeConflictDiffAction,
  fileDiff: FileDiffMetadata
): { hunkIndex: number; lineIndex: number } | undefined {
  const hunk = fileDiff.hunks[action.hunkIndex];
  if (hunk == null) {
    return undefined;
  }
  let lineIndex = hunk.unifiedLineStart;
  for (let index = 0; index < action.startContentIndex; index++) {
    const content = hunk.hunkContent[index];
    lineIndex +=
      content.type === 'context'
        ? content.lines
        : content.deletions + content.additions;
  }
  return { hunkIndex: action.hunkIndex, lineIndex };
}

// Main entry point. Walks every line of the conflict file exactly once,
// dispatching each line through processLine which routes it to the appropriate
// emitter (context or change). After the loop, finalizes the last hunk,
// validates all conflicts were closed, and assembles the result.
//
// The three phases are:
//   1. Line-by-line scan  — builds hunks and conflict actions incrementally
//   2. Post-loop cleanup  — flushes trailing context, finalizes last hunk
//   3. Result assembly    — joins line arrays, builds marker rows for the UI
export function parseMergeConflictDiffFromFile(
  file: FileContents,
  maxContextLines: number = 6
): ParseMergeConflictDiffFromFileResult {
  // Never allow maxContextLines to drop below 1 or else things break.
  maxContextLines = Math.max(maxContextLines, 1);

  const s: ParseState = {
    deletionLines: [],
    additionLines: [],
    conflictStack: [],
    actions: [],
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    lastHunkEnd: 0,
    activeHunk: undefined,
    maxContextLines,
    maxContextLines2: maxContextLines * 2,
  };

  // Phase 1: Line-by-line scan. We inline the indexOf loop here (rather than
  // calling a helper with a callback) to avoid creating a closure on the hot
  // path. Each line is sliced and dispatched to processLine.
  const { contents } = file;
  let lineStart = 0;
  let lineIndex = 0;
  for (
    let newlinePos = contents.indexOf('\n');
    newlinePos !== -1;
    newlinePos = contents.indexOf('\n', lineStart)
  ) {
    processLine(s, contents.slice(lineStart, newlinePos + 1), lineIndex++);
    lineStart = newlinePos + 1;
  }
  if (lineStart < contents.length) {
    processLine(s, contents.slice(lineStart), lineIndex);
  }

  // Phase 2: Post-loop cleanup. Any unclosed conflict is an error. If the
  // last hunk has buffered context lines, flush them as trailing context and
  // finalize the hunk.
  if (s.conflictStack.length > 0) {
    throw new Error(
      'parseMergeConflictDiffFromFile: unfinished merge conflict marker stack'
    );
  }

  const hunk = s.activeHunk;
  if (hunk != null && hunk.hunkContent.length > 0) {
    flushBufferedContext(s, hunk, 'trailing');
    finalizeActiveHunk(s, hunk);
  }

  // Phase 3: Result assembly. Account for any collapsed lines after the last
  // hunk, then join the line arrays to produce resolved file contents.
  if (
    s.hunks.length > 0 &&
    s.additionLines.length > 0 &&
    s.deletionLines.length > 0
  ) {
    const collapsedAfter = Math.max(s.additionLines.length - s.lastHunkEnd, 0);
    s.splitLineCount += collapsedAfter;
    s.unifiedLineCount += collapsedAfter;
  }

  const currentContents = s.deletionLines.join('');
  const incomingContents = s.additionLines.join('');

  let type: FileDiffMetadata['type'] = 'change';
  if (incomingContents === '') {
    type = 'deleted';
  } else if (currentContents === '') {
    type = 'new';
  }

  const fileDiff: FileDiffMetadata = {
    name: file.name,
    prevName: undefined,
    type,
    hunks: s.hunks,
    splitLineCount: s.splitLineCount,
    unifiedLineCount: s.unifiedLineCount,
    isPartial: false,
    deletionLines: s.deletionLines,
    additionLines: s.additionLines,
    cacheKey:
      file.cacheKey != null
        ? `${file.cacheKey}:merge-conflict-diff`
        : undefined,
  };

  return {
    fileDiff,
    currentFile: createResolvedConflictFile(file, 'current', currentContents),
    incomingFile: createResolvedConflictFile(
      file,
      'incoming',
      incomingContents
    ),
    actions: s.actions,
    markerRows: buildMergeConflictMarkerRows(fileDiff, s.actions),
  };
}

// ---------------------------------------------------------------------------
// Module-level parse helpers. Each receives ParseState by reference rather
// than capturing variables via closure. The call graph from the hot path is:
//
//   processLine
//     ├─ emitContextLine    → ensureActiveHunk
//     ├─ emitChangeLine     → ensureActiveHunk, flushBufferedContext,
//     │                       finalizeActiveHunk, assignConflictContent
//     ├─ handleStartMarker
//     └─ finalizeConflict
// ---------------------------------------------------------------------------

// Routes a single source line to the right emitter based on whether we're
// inside a conflict and, if so, which section (current/base/incoming).
// Outside conflicts, only the start marker (<<<<<<< / charCode 60) can
// change state, so we skip the full marker check for non-'<' lines.
function processLine(s: ParseState, line: string, index: number): void {
  const frame = s.conflictStack[s.conflictStack.length - 1];

  // Outside any conflict: only start markers (<<<<<<<) can transition state.
  // Skip the full marker check for lines that can't be start markers.
  if (frame == null) {
    if (
      line.length >= 7 &&
      line.charCodeAt(0) === 60 &&
      getMergeConflictMarkerType(line) === 'start'
    ) {
      handleStartMarker(s, line, index);
    } else {
      emitContextLine(s, line);
    }
    return;
  }

  // Inside a conflict: all marker types must be checked.
  const markerType = getMergeConflictMarkerType(line);
  if (markerType === 'start') {
    handleStartMarker(s, line, index);
  } else if (markerType === 'base') {
    frame.stage = 'base';
    frame.baseMarkerLineIndex = index;
    frame.markerLines.base = line;
  } else if (markerType === 'separator') {
    frame.stage = 'incoming';
    frame.separatorLineIndex = index;
    frame.markerLines.separator = line;
  } else if (markerType === 'end') {
    finalizeConflict(s, s.conflictStack.pop()!, index, line);
  } else if (frame.stage === 'base') {
    emitContextLine(s, line, frame.conflictIndex);
  } else {
    emitChangeLine(s, line, frame.conflictIndex, frame.stage);
  }
}

// Lazily creates the active HunkBuilder if one doesn't exist yet. The hunk's
// start positions are derived from the current length of the line arrays
// (1-based, matching unified diff conventions).
function ensureActiveHunk(s: ParseState): HunkBuilder {
  s.activeHunk ??= createHunkBuilder(
    s.additionLines.length + 1,
    s.deletionLines.length + 1
  );
  return s.activeHunk;
}

// "Anchors" a conflict to its position in the hunk's content array. Each
// conflict needs to know which hunk it lives in (hunkIndex) and which content
// entries correspond to its current/base/incoming sections. This is called
// every time we emit a change or context line that belongs to a conflict, and
// it incrementally widens the start/end content range.
function assignConflictContent(
  s: ParseState,
  conflictIndex: number,
  role: MergeConflictStage,
  contentIndex: number
): void {
  const action = s.actions[conflictIndex];
  const hunkIndex = s.hunks.length;
  if (action.hunkIndex < 0) {
    action.hunkIndex = hunkIndex;
  } else if (action.hunkIndex !== hunkIndex) {
    throw new Error(
      `parseMergeConflictDiffFromFile: conflict ${conflictIndex} spans multiple hunks and cannot be anchored`
    );
  }

  if (action.startContentIndex < 0) {
    action.startContentIndex = contentIndex;
  }
  action.endContentIndex = contentIndex;
  action.endMarkerContentIndex = contentIndex;

  if (role === 'current') {
    action.currentContentIndex ??= contentIndex;
  } else if (role === 'base') {
    action.baseContentIndex ??= contentIndex;
  } else {
    action.incomingContentIndex = contentIndex;
  }
}

// Drains the hunk's context buffer into hunkContent, applying mode-dependent
// trimming. The buffer accumulates context lines without committing them,
// because we don't know yet whether they'll be leading context (trim start),
// trailing context (trim end), or mid-hunk context (keep all). The mode tells
// us which case we're in:
//
//   'leading'       — first change in a new hunk; drop lines beyond
//                     maxContextLines from the front, and shift the hunk's
//                     start position forward accordingly.
//   'trailing'      — last flush before hunk finalization; keep at most
//                     maxContextLines from the front of the buffer.
//   'before-change' — mid-hunk context between two changes; emit everything.
function flushBufferedContext(
  s: ParseState,
  hunk: HunkBuilder,
  mode: ContextFlushMode
): void {
  let count = hunk.contextBufferCount;
  let addStart = hunk.contextBufferAdditionStart;
  let delStart = hunk.contextBufferDeletionStart;

  if (mode !== 'before-change' && count > s.maxContextLines) {
    if (mode === 'leading') {
      const difference = count - s.maxContextLines;
      addStart += difference;
      delStart += difference;
      hunk.additionStart += difference;
      hunk.deletionStart += difference;
      hunk.additionLineIndex += difference;
      hunk.deletionLineIndex += difference;
    }
    count = s.maxContextLines;
  }

  if (count > 0) {
    // Bulk-append context: coalesce with previous context entry or create new
    // one. This avoids a per-line loop — significant when maxContextLines is
    // large.
    const hunkContent = hunk.hunkContent;
    const lastContent = hunkContent[hunkContent.length - 1];
    if (lastContent?.type === 'context') {
      lastContent.lines += count;
    } else {
      hunkContent.push({
        type: 'context',
        lines: count,
        additionLineIndex: addStart,
        deletionLineIndex: delStart,
      });
    }
    hunk.additionCount += count;
    hunk.deletionCount += count;

    // Assign base-section conflict anchors (rare — only when base lines exist)
    const baseConflicts = hunk.contextBufferBaseConflicts;
    if (baseConflicts != null) {
      const bufferStartOffset = addStart - hunk.contextBufferAdditionStart;
      for (const [offset, conflictIndex] of baseConflicts) {
        if (offset >= bufferStartOffset && offset < bufferStartOffset + count) {
          assignConflictContent(
            s,
            conflictIndex,
            'base',
            hunkContent.length - 1
          );
        }
      }
    }
  }
  hunk.contextBufferCount = 0;
  hunk.contextBufferBaseConflicts = undefined;
}

// Converts the mutable HunkBuilder into an immutable Hunk and pushes it onto
// s.hunks. Computes line counts for split and unified view, the collapsed-
// before gap (lines between the previous hunk and this one), and the hunk
// header string (e.g. "@@ -1,5 +1,7 @@").
function finalizeActiveHunk(s: ParseState, hunk: HunkBuilder): void {
  let hunkSplitLineCount = 0;
  let hunkUnifiedLineCount = 0;
  for (const content of hunk.hunkContent) {
    if (content.type === 'context') {
      hunkSplitLineCount += content.lines;
      hunkUnifiedLineCount += content.lines;
    } else {
      hunkSplitLineCount += Math.max(content.additions, content.deletions);
      hunkUnifiedLineCount += content.additions + content.deletions;
    }
  }

  // While building, each side's start is "next line to consume" (1-based). A
  // side that finished with zero lines must shift down to the unified `N,0`
  // convention (start names the line the hunk applies after), which is what
  // hunk headers, getHunkSideStartBoundary, and downstream boundary math all
  // assume — e.g. a whole-file deletion emits `+0,0`, not `+1,0`.
  const additionStart =
    hunk.additionCount === 0 ? hunk.additionStart - 1 : hunk.additionStart;
  const deletionStart =
    hunk.deletionCount === 0 ? hunk.deletionStart - 1 : hunk.deletionStart;

  const collapsedBefore = Math.max(
    getHunkSideStartBoundary(additionStart, hunk.additionCount) - s.lastHunkEnd,
    0
  );
  s.hunks.push({
    collapsedBefore,
    additionStart,
    additionCount: hunk.additionCount,
    additionLines: hunk.additionLines,
    additionLineIndex: hunk.additionLineIndex,
    deletionStart,
    deletionCount: hunk.deletionCount,
    deletionLines: hunk.deletionLines,
    deletionLineIndex: hunk.deletionLineIndex,
    hunkContent: hunk.hunkContent,
    hunkContext: undefined,
    hunkSpecs: `@@ -${formatHunkRange(deletionStart, hunk.deletionCount)} +${formatHunkRange(additionStart, hunk.additionCount)} @@\n`,
    splitLineStart: s.splitLineCount + collapsedBefore,
    splitLineCount: hunkSplitLineCount,
    unifiedLineStart: s.unifiedLineCount + collapsedBefore,
    unifiedLineCount: hunkUnifiedLineCount,
    noEOFCRAdditions: false,
    noEOFCRDeletions: false,
  });
  s.splitLineCount += collapsedBefore + hunkSplitLineCount;
  s.unifiedLineCount += collapsedBefore + hunkUnifiedLineCount;
  s.lastHunkEnd = getHunkSideEndBoundary(additionStart, hunk.additionCount);
}

// Adds a context line (identical on both sides of the diff). The line is pushed
// to both additionLines and deletionLines, then buffered in the hunk's context
// buffer rather than committed to hunkContent immediately. This deferred write
// is what enables the leading/trailing trim logic in flushBufferedContext.
//
// For base-section lines inside a diff3 conflict, pass the conflict index so
// the buffer can record the association; when the buffer is flushed, those
// lines get anchored to the conflict via assignConflictContent.
function emitContextLine(
  s: ParseState,
  line: string,
  baseConflictIndex: number = -1
): void {
  const hunk = ensureActiveHunk(s);
  // Reset buffer start on first line after a flush/creation.
  if (hunk.contextBufferCount === 0) {
    hunk.contextBufferAdditionStart = s.additionLines.length;
    hunk.contextBufferDeletionStart = s.deletionLines.length;
  }
  s.additionLines.push(line);
  s.deletionLines.push(line);
  if (baseConflictIndex >= 0) {
    hunk.contextBufferBaseConflicts ??= new Map();
    hunk.contextBufferBaseConflicts.set(
      hunk.contextBufferCount,
      baseConflictIndex
    );
  }
  hunk.contextBufferCount++;
}

// Adds a change line to the current hunk: current-side lines are deletions,
// incoming-side lines are additions. This is the main "work" function on the
// hot path and orchestrates several steps:
//   1. If there's a large context gap since the last change, split the hunk
//   2. Flush any buffered context lines (leading trim on first change, or
//      pass-through for mid-hunk context)
//   3. Append/coalesce the change into hunkContent
//   4. Push the line to the appropriate line array (additions or deletions)
//   5. Anchor the conflict action to the content index
function emitChangeLine(
  s: ParseState,
  line: string,
  conflictIndex: number,
  role: 'current' | 'incoming'
): void {
  let hunk = ensureActiveHunk(s);
  // If the context gap since the last change exceeds 2x maxContextLines,
  // split into two hunks (just like `diff -U` does): the first
  // maxContextLines of the buffer become trailing context of the current
  // hunk, and the last maxContextLines seed a new hunk as leading context.
  // The middle of the buffer is the collapsed region between them.
  if (
    hunk.hunkContent.length > 0 &&
    hunk.contextBufferCount > s.maxContextLines2
  ) {
    const count = hunk.contextBufferCount;
    const tailOffset = count - s.maxContextLines;
    const omittedContextLineCount = count - s.maxContextLines2;
    const nextAddStart = hunk.contextBufferAdditionStart + tailOffset;
    const nextDelStart = hunk.contextBufferDeletionStart + tailOffset;

    // Extract base conflicts that fall within the trailing portion.
    let nextBaseConflicts: Map<number, number> | undefined;
    if (hunk.contextBufferBaseConflicts != null) {
      for (const [offset, ci] of hunk.contextBufferBaseConflicts) {
        if (offset >= tailOffset) {
          nextBaseConflicts ??= new Map();
          nextBaseConflicts.set(offset - tailOffset, ci);
        }
      }
    }

    flushBufferedContext(s, hunk, 'trailing');
    finalizeActiveHunk(s, hunk);

    const nextHunk = createHunkBuilder(
      hunk.additionStart + hunk.additionCount + omittedContextLineCount,
      hunk.deletionStart + hunk.deletionCount + omittedContextLineCount
    );
    nextHunk.contextBufferAdditionStart = nextAddStart;
    nextHunk.contextBufferDeletionStart = nextDelStart;
    nextHunk.contextBufferCount = s.maxContextLines;
    nextHunk.contextBufferBaseConflicts = nextBaseConflicts;
    s.activeHunk = hunk = nextHunk;
  }

  flushBufferedContext(
    s,
    hunk,
    hunk.hunkContent.length === 0 ? 'leading' : 'before-change'
  );

  // Coalesce with the previous change group to keep hunkContent compact.
  const hunkContent = hunk.hunkContent;
  let lastContent = hunkContent[hunkContent.length - 1];
  if (lastContent?.type !== 'change') {
    lastContent = {
      type: 'change',
      additions: 0,
      deletions: 0,
      additionLineIndex: s.additionLines.length,
      deletionLineIndex: s.deletionLines.length,
    };
    hunkContent.push(lastContent);
  }

  if (role === 'incoming') {
    s.additionLines.push(line);
    lastContent.additions++;
    hunk.additionCount++;
    hunk.additionLines++;
  } else {
    s.deletionLines.push(line);
    lastContent.deletions++;
    hunk.deletionCount++;
    hunk.deletionLines++;
  }
  assignConflictContent(s, conflictIndex, role, hunkContent.length - 1);
}

// Called when we hit a >>>>>>> end marker. Takes the completed ConflictFrame
// and writes the final source-line coordinates and marker text into the
// conflict action. Also handles empty-side conflicts: if one side had no
// content lines, we fall back to the other side's content index so the action
// always has valid anchors. This is what makes conflicts like "add vs nothing"
// or "nothing vs add" representable.
function finalizeConflict(
  s: ParseState,
  frame: ConflictFrame,
  endLineIndex: number,
  endMarkerLine: string
): void {
  if (frame.separatorLineIndex == null || frame.markerLines.separator == null) {
    throw new Error(
      `parseMergeConflictDiffFromFile: conflict ${frame.conflictIndex} is missing a separator marker`
    );
  }

  const action = s.actions[frame.conflictIndex];
  action.markerLines.separator = frame.markerLines.separator;
  action.markerLines.end = endMarkerLine;
  if (frame.markerLines.base != null) {
    action.markerLines.base = frame.markerLines.base;
  }

  action.conflict = {
    conflictIndex: frame.conflictIndex,
    startLineIndex: frame.startLineIndex,
    startLineNumber: frame.startLineIndex + 1,
    separatorLineIndex: frame.separatorLineIndex,
    separatorLineNumber: frame.separatorLineIndex + 1,
    endLineIndex,
    endLineNumber: endLineIndex + 1,
    baseMarkerLineIndex: frame.baseMarkerLineIndex,
    baseMarkerLineNumber:
      frame.baseMarkerLineIndex != null
        ? frame.baseMarkerLineIndex + 1
        : undefined,
  };

  // If one side of the conflict was empty (e.g. "add vs nothing"), its content
  // index will be undefined. Use the other side as a fallback so the action
  // always has a valid anchor for the UI to render.
  const fallbackContentIndex =
    action.currentContentIndex ?? action.incomingContentIndex;
  action.currentContentIndex ??= fallbackContentIndex;
  action.incomingContentIndex ??= fallbackContentIndex;

  // Every anchor is set by the first assignConflictContent call, so a negative
  // start means the conflict has no content lines at all.
  if (action.startContentIndex < 0) {
    throw new Error(
      `parseMergeConflictDiffFromFile: failed to anchor merge conflict ${frame.conflictIndex}`
    );
  }
}

// Pushes a new ConflictFrame onto the stack and creates a placeholder action.
// The action starts with sentinel values (-1 for indices) that get filled in
// as we encounter content lines and markers. The frame tracks which section
// we're scanning (current → base → incoming); the action is the final output
// that downstream consumers use.
function handleStartMarker(
  s: ParseState,
  line: string,
  lineIndex: number
): void {
  const conflictIndex = s.actions.length;
  s.conflictStack.push({
    conflictIndex,
    stage: 'current',
    startLineIndex: lineIndex,
    markerLines: { start: line },
  });
  s.actions.push({
    conflict: {
      conflictIndex,
      startLineIndex: lineIndex,
      startLineNumber: lineIndex + 1,
      separatorLineIndex: lineIndex,
      separatorLineNumber: lineIndex + 1,
      endLineIndex: lineIndex,
      endLineNumber: lineIndex + 1,
      baseMarkerLineIndex: undefined,
      baseMarkerLineNumber: undefined,
    },
    conflictIndex,
    hunkIndex: -1,
    startContentIndex: -1,
    endContentIndex: -1,
    endMarkerContentIndex: -1,
    markerLines: {
      start: line,
      separator: '',
      end: '',
    },
  });
}

function createHunkBuilder(
  additionStart: number,
  deletionStart: number
): HunkBuilder {
  return {
    additionStart,
    deletionStart,
    additionCount: 0,
    deletionCount: 0,
    additionLines: 0,
    deletionLines: 0,
    additionLineIndex: Math.max(additionStart - 1, 0),
    deletionLineIndex: Math.max(deletionStart - 1, 0),
    hunkContent: [],
    contextBufferAdditionStart: Math.max(additionStart - 1, 0),
    contextBufferDeletionStart: Math.max(deletionStart - 1, 0),
    contextBufferCount: 0,
    contextBufferBaseConflicts: undefined,
  };
}

function formatHunkRange(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

// Detects whether a line is a merge conflict marker by inspecting the first
// character and counting consecutive repetitions. Git conflict markers are
// 7+ repeated characters:
//   '<' (60)  = start   (<<<<<<< current)
//   '|' (124) = base    (||||||| base)
//   '=' (61)  = separator (=======)
//   '>' (62)  = end     (>>>>>>> incoming)
// The separator must be exactly '=======' with no trailing text; other markers
// allow an optional whitespace + label (e.g. "<<<<<<< HEAD").
function getMergeConflictMarkerType(
  line: string
): MergeConflictMarkerType | undefined {
  if (line.length < 7) {
    return undefined;
  }

  const markerCode = line.charCodeAt(0);
  if (
    markerCode !== 60 &&
    markerCode !== 62 &&
    markerCode !== 61 &&
    markerCode !== 124
  ) {
    return undefined;
  }

  // Line length without its trailing \n and \r
  let lineEnd = line.length;
  if (line.charCodeAt(lineEnd - 1) === 10) {
    lineEnd--;
  }
  if (line.charCodeAt(lineEnd - 1) === 13) {
    lineEnd--;
  }

  let markerLength = 1;
  while (
    markerLength < lineEnd &&
    line.charCodeAt(markerLength) === markerCode
  ) {
    markerLength++;
  }

  if (markerLength < 7) {
    return undefined;
  }

  if (markerCode === 61) {
    return markerLength === lineEnd ? 'separator' : undefined;
  }

  // Tab, \n, vertical tab, form feed, \r (9-13) or space
  const nextCode = line.charCodeAt(markerLength);
  if (
    markerLength !== lineEnd &&
    !((nextCode >= 9 && nextCode <= 13) || nextCode === 32)
  ) {
    return undefined;
  }

  return markerCode === 60 ? 'start' : markerCode === 62 ? 'end' : 'base';
}

function createResolvedConflictFile(
  file: FileContents,
  side: 'current' | 'incoming',
  contents: string
): FileContents {
  return {
    ...file,
    contents,
    cacheKey:
      file.cacheKey != null
        ? `${file.cacheKey}:merge-conflict-${side}`
        : undefined,
  };
}

// Builds the marker row array that tells the UI where to render conflict
// decorations (start/base/separator/end lines) in the diff view. Each marker
// row maps a conflict marker to a specific line index in unified view.
//
// This is a post-processing step over the finalized hunks and actions. It
// caches cumulative line-start positions per hunk to avoid recomputing them
// for every marker.
export function buildMergeConflictMarkerRows(
  fileDiff: FileDiffMetadata,
  actions: (MergeConflictDiffAction | undefined)[]
): MergeConflictMarkerRow[] {
  const markerRows: MergeConflictMarkerRow[] = [];
  const hunkLineStartCache: number[][] = [];

  // Only called with the hunk index of an action whose hunk exists.
  const getLineStart = (hunkIndex: number, contentIndex: number): number => {
    const hunk = fileDiff.hunks[hunkIndex];
    let starts = hunkLineStartCache[hunkIndex];
    if (starts == null) {
      starts = new Array<number>(hunk.hunkContent.length + 1);
      let lineIndex = hunk.unifiedLineStart;
      starts[0] = lineIndex;
      for (let index = 0; index < hunk.hunkContent.length; index++) {
        const content = hunk.hunkContent[index];
        lineIndex +=
          content.type === 'context'
            ? content.lines
            : content.deletions + content.additions;
        starts[index + 1] = lineIndex;
      }
      hunkLineStartCache[hunkIndex] = starts;
    }
    return starts[Math.max(contentIndex, 0)] ?? hunk.unifiedLineStart;
  };

  for (const action of actions) {
    if (action == null) {
      continue;
    }

    const { hunkIndex, currentContentIndex, baseContentIndex, markerLines } =
      action;
    const hunk = fileDiff.hunks[hunkIndex];
    if (hunk == null) {
      continue;
    }

    const actionLineIndex = getLineStart(hunkIndex, action.startContentIndex);
    markerRows.push(
      createMergeConflictMarkerRow(
        action,
        'marker-start',
        action.startContentIndex,
        markerLines.start,
        actionLineIndex
      )
    );

    if (baseContentIndex != null) {
      const { incomingContentIndex } = action;
      if (
        currentContentIndex == null ||
        incomingContentIndex == null ||
        markerLines.base == null
      ) {
        continue;
      }

      const currentChange = hunk.hunkContent[currentContentIndex];
      const baseContext = hunk.hunkContent[baseContentIndex];
      const incomingChange = hunk.hunkContent[incomingContentIndex];
      if (
        currentChange?.type !== 'change' ||
        baseContext?.type !== 'context' ||
        incomingChange?.type !== 'change'
      ) {
        continue;
      }

      markerRows.push(
        createMergeConflictMarkerRow(
          action,
          'marker-base',
          baseContentIndex,
          markerLines.base,
          getLineStart(hunkIndex, currentContentIndex) + currentChange.deletions
        ),
        createMergeConflictMarkerRow(
          action,
          'marker-separator',
          baseContentIndex,
          markerLines.separator,
          getLineStart(hunkIndex, incomingContentIndex)
        )
      );
    } else {
      if (currentContentIndex == null) {
        continue;
      }
      const content = hunk.hunkContent[currentContentIndex];
      if (content?.type !== 'change') {
        continue;
      }

      markerRows.push(
        createMergeConflictMarkerRow(
          action,
          'marker-separator',
          currentContentIndex,
          markerLines.separator,
          content.deletions > 0
            ? getLineStart(hunkIndex, currentContentIndex) + content.deletions
            : actionLineIndex
        )
      );
    }

    markerRows.push(
      createMergeConflictMarkerRow(
        action,
        'marker-end',
        action.endMarkerContentIndex,
        markerLines.end,
        Math.max(
          getLineStart(hunkIndex, action.endMarkerContentIndex),
          getLineStart(hunkIndex, action.endMarkerContentIndex + 1) - 1
        )
      )
    );
  }

  return markerRows;
}

function createMergeConflictMarkerRow(
  action: MergeConflictDiffAction,
  type: MergeConflictMarkerRowType,
  contentIndex: number,
  lineText: string,
  lineIndex: number
): MergeConflictMarkerRow {
  return {
    type,
    hunkIndex: action.hunkIndex,
    contentIndex,
    conflictIndex: action.conflictIndex,
    lineText,
    lineIndex,
  };
}
