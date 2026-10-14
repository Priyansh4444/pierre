import type { ElementContent, Element as HASTElement } from 'hast';

import {
  CUSTOM_HEADER_SLOT_ID,
  DEFAULT_COLLAPSED_CONTEXT_THRESHOLD,
  DEFAULT_THEMES,
  DEFAULT_TOKENIZE_MAX_LENGTH,
  DIFFS_TAG_NAME,
  EMPTY_RENDER_RANGE,
  HEADER_FILENAME_SUFFIX_SLOT_ID,
  HEADER_METADATA_SLOT_ID,
  HEADER_PREFIX_SLOT_ID,
  THEME_CSS_ATTRIBUTE,
  UNSAFE_CSS_ATTRIBUTE,
} from '../constants';
import type { Editor } from '../editor/editor';
import type { TextDocument } from '../editor/textDocument';
import type {
  CapturedDiffSessionState,
  EditCompletionDecision,
  EditorActiveLineOptions,
  EditorChangeEvent,
  FileDiffEditCompleteEvent,
  RetainedDiffSessionSnapshot,
} from '../editor/types';
import {
  getHighlighterIfLoaded,
  getSharedHighlighter,
  HighlighterDisposedError,
} from '../highlighter/shared_highlighter';
import {
  type GetHoveredLineResult,
  type GetLineIndexUtility,
  InteractionManager,
  type InteractionManagerBaseOptions,
  pluckInteractionOptions,
  type SelectionWriteOptions,
} from '../managers/InteractionManager';
import { ResizeManager } from '../managers/ResizeManager';
import { ScrollSyncManager } from '../managers/ScrollSyncManager';
import {
  dequeueRender,
  queueRender,
} from '../managers/UniversalRenderingManager';
import {
  DiffHunksRenderer,
  type DiffHunksRendererOptions,
  type HunksRenderResult,
} from '../renderers/DiffHunksRenderer';
import { SVGSpriteSheet } from '../sprite';
export type { FileDiffEditCompleteEvent } from '../editor/types';
import type {
  AppliedThemeStyleCache,
  BaseCodeOptions,
  BaseDiffOptions,
  CustomPreProperties,
  DiffLineAnnotation,
  ExpansionDirections,
  DiffsHighlighter,
  FileContents,
  FileDiffMetadata,
  HighlightedToken,
  HunkData,
  HunkSeparators,
  LineAnnotation,
  MaybeDiffFileInput,
  PostRenderPhase,
  PrePropertiesConfig,
  RenderHeaderFilenameSuffixCallback,
  RenderHeaderMetadataCallback,
  RenderHeaderPrefixCallback,
  RenderRange,
  SelectedLineRange,
  SelectionSide,
  ThemeTypes,
} from '../types';
import { areDiffLineAnnotationsEqual } from '../utils/areDiffLineAnnotationsEqual';
import { areDiffTargetsEqual } from '../utils/areDiffTargetsEqual';
import { areFilesEqual } from '../utils/areFilesEqual';
import { areHunkDataEqual } from '../utils/areHunkDataEqual';
import { arePrePropertiesEqual } from '../utils/arePrePropertiesEqual';
import { areRenderRangesEqual } from '../utils/areRenderRangesEqual';
import { areThemesEqual } from '../utils/areThemesEqual';
import { awaitWithTimeout } from '../utils/awaitWithTimeout';
import {
  cloneFileDiffMetadata,
  cloneHunks,
} from '../utils/cloneFileDiffMetadata';
import { createAnnotationWrapperNode } from '../utils/createAnnotationWrapperNode';
import { createGutterUtilityContentNode } from '../utils/createGutterUtilityContentNode';
import { createUnsafeCSSStyleNode } from '../utils/createUnsafeCSSStyleNode';
import {
  patchScrollbarGutterSize,
  wrapThemeCSS,
  wrapUnsafeCSS,
} from '../utils/cssWrappers';
import {
  adoptEditSessionAnnotations,
  type EditSessionAnnotations,
  resolveEditSessionSlotName,
  writeEditSessionAnnotations,
} from '../utils/editSessionAnnotations';
import {
  captureExpansionAnchors,
  finishEditSessionForDiff,
  rebuildExpansionFromAnchors,
} from '../utils/editSessionHunks';
import { getDiffFileInput } from '../utils/getDiffFileInput';
import { getDiffHunksRendererOptions } from '../utils/getDiffHunksRendererOptions';
import { getFiletypeFromFileName } from '../utils/getFiletypeFromFileName';
import { getHunkSideStartBoundary } from '../utils/getHunkSideBoundaries';
import { getLineAnnotationName } from '../utils/getLineAnnotationName';
import { getOrCreateCodeNode } from '../utils/getOrCreateCodeNode';
import { getThemes } from '../utils/getThemes';
import { guardWebKitScrollDuringRebuild } from '../utils/guardWebKitScrollDuringRebuild';
import { hastToHtml } from '../utils/hastToHtml';
import { upsertHostThemeStyle } from '../utils/hostTheme';
import { hydratePartialDiff } from '../utils/hydratePartialDiff';
import { isDefaultRenderRange } from '../utils/isDefaultRenderRange';
import { isDiffPlainText } from '../utils/isDiffPlainText';
import { isStyleNode } from '../utils/isStyleNode';
import { iterateOverDiff } from '../utils/iterateOverDiff';
import { parseDiffFromFile } from '../utils/parseDiffFromFile';
import { isSafari } from '../utils/platform';
import { prerenderHTMLIfNecessary } from '../utils/prerenderHTMLIfNecessary';
import { resolvePreferredHighlighter } from '../utils/resolvePreferredHighlighter';
import { getMeasuredScrollbarGutter } from '../utils/scrollbarGutter';
import { setPreNodeProperties } from '../utils/setWrapperNodeProps';
import { splitFileContents } from '../utils/splitFileContents';
import { recomputeDiffRenderLineCounts } from '../utils/updateDiffHunks';
import {
  getExpandedRegion,
  getHunkAdditionLineRange,
  getNearestRenderableAdditionLine,
  getTrailingExpandedRegion,
  isAdditionLineRenderable,
} from '../utils/virtualDiffLayout';
import type { WorkerPoolManager } from '../worker';
import { isHandledWorkerPoolError } from '../worker/errors';
import { DiffsContainerLoaded } from './web-components';

type LoadedPartialDiffContents = Awaited<
  ReturnType<NonNullable<BaseDiffOptions['loadDiffFiles']>>
>;

type DeferredSelectedLinesWrite = [
  range: SelectedLineRange | null,
  options: SelectionWriteOptions | undefined,
];

type DeferredEditorActiveLineWrite = [
  lineNumber: number | null,
  options: EditorActiveLineOptions | undefined,
];

interface UpdateRenderCacheOptions {
  shouldRefreshDiffsView?: boolean;
  lineCountChangeInFlight?: boolean;
  changedDocumentLines?: ReadonlyMap<number, string>;
  documentLineCount?: number;
}

function canHydrateDiff(fileDiff: FileDiffMetadata): boolean {
  return (
    fileDiff.isPartial &&
    (fileDiff.type === 'change' ||
      fileDiff.type === 'rename-changed' ||
      fileDiff.type === 'rename-pure')
  );
}

function shouldResetUndoState(
  prevDiff: FileDiffMetadata,
  nextDiff: FileDiffMetadata
): boolean {
  if (prevDiff.isPartial || nextDiff.isPartial) {
    throw new Error(
      'FileDiff.shouldResetEditorForExternalDiff: diffs must be fully hydrated'
    );
  }
  return (
    prevDiff.name !== nextDiff.name ||
    (prevDiff.lang ?? getFiletypeFromFileName(prevDiff.name)) !==
      (nextDiff.lang ?? getFiletypeFromFileName(nextDiff.name)) ||
    (prevDiff.type === 'new') !== (nextDiff.type === 'new') ||
    !areLinesEqual(prevDiff.deletionLines, nextDiff.deletionLines)
  );
}

function areLinesEqual(first: string[], second: string[]): boolean {
  return (
    first.length === second.length &&
    first.every((line, index) => line === second[index])
  );
}

export interface FileDiffRenderBaseProps<LAnnotation> {
  fileDiff?: FileDiffMetadata;
  deferManagers?: boolean;
  forceRender?: boolean;
  preventEmit?: boolean;
  fileContainer?: HTMLElement;
  containerWrapper?: HTMLElement;
  lineAnnotations?: DiffLineAnnotation<LAnnotation>[];
  renderRange?: RenderRange;
}

export type FileDiffRenderProps<LAnnotation> =
  FileDiffRenderBaseProps<LAnnotation> & MaybeDiffFileInput;

export type FileDiffHydrationProps<LAnnotation> = Omit<
  FileDiffRenderBaseProps<LAnnotation>,
  'fileContainer'
> &
  MaybeDiffFileInput & {
    fileContainer: HTMLElement;
    prerenderedHTML?: string;
  };

export type FileDiffType = 'file-diff' | 'unresolved-file';

export type FileDiffEditChangeHandler<LAnnotation, Caret> = (
  event: EditorChangeEvent<'file-diff', LAnnotation, Caret>
) => void;

/**
 * Decides a completed edit synchronously: return `'accept'` to install the
 * event's `fileDiff` and annotations, or `'reject'` to restore the original
 * values. The event is frozen, so re-key the accepted diff in place
 * (`event.fileDiff.cacheKey = '…'`) before accepting. The event's editor is
 * detached and returns its final state from `getViewState()`. A missing handler
 * rejects.
 */
export type FileDiffEditCompleteHandler<LAnnotation, Caret> = (
  event: FileDiffEditCompleteEvent<LAnnotation, Caret>
) => EditCompletionDecision;

export interface FileDiffOptions<LAnnotation, Caret>
  extends
    Omit<BaseDiffOptions, 'hunkSeparators'>,
    InteractionManagerBaseOptions<'diff'> {
  hunkSeparators?:
    | Exclude<HunkSeparators, 'custom'> /**
       * @deprecated Custom hunk separator functions are deprecated and will be
       * removed in a future version.
       */
    | ((
        hunk: HunkData,
        instance: FileDiff<LAnnotation, Caret>
      ) => HTMLElement | DocumentFragment | null | undefined);
  disableFileHeader?: boolean;
  renderHeaderPrefix?: RenderHeaderPrefixCallback;
  renderHeaderFilenameSuffix?: RenderHeaderFilenameSuffixCallback;
  renderHeaderMetadata?: RenderHeaderMetadataCallback;
  renderCustomHeader?: RenderHeaderMetadataCallback;
  /**
   * When true, errors during rendering are rethrown instead of being caught
   * and displayed in the DOM. Useful for testing or when you want to handle
   * errors yourself.
   */
  disableErrorHandling?: boolean;
  renderAnnotation?(
    annotation: DiffLineAnnotation<LAnnotation>
  ): HTMLElement | undefined;
  renderGutterUtility?(
    getHoveredRow: () => GetHoveredLineResult<'diff'> | undefined
  ): HTMLElement | null | undefined;

  onPostRender?(
    node: HTMLElement,
    instance: FileDiff<LAnnotation, Caret>,
    phase: PostRenderPhase
  ): unknown;

  /**
   * Fired for every document change of an active edit session on this
   * component, with the same `EditorChangeEvent` the editor reports through
   * its own `onChange`. Do not feed the event's file back into the component
   * while the session is active.
   */
  onEditChange?: FileDiffEditChangeHandler<LAnnotation, Caret>;

  /**
   * Fired when `edit` toggles false or a component unmounts, including when the
   * final contents are unchanged. If no callback is provided, the component
   * reverts to the last `fileDiff` or `oldFile`/`newFiles` and annotations
   * passed into it. The callback receives the detached editor with its final
   * pre-detach state.
   */
  onEditComplete?: FileDiffEditCompleteHandler<LAnnotation, Caret>;
}

interface AnnotationElementCache<LAnnotation> {
  element: HTMLElement;
  annotation: DiffLineAnnotation<LAnnotation>;
}

interface CustomHunkElementCache {
  element: HTMLElement;
  hunkData: HunkData;
}

interface ColumnElements {
  gutter: HTMLElement;
  content: HTMLElement;
}

type CodeColumn = [
  columnType: 'unified' | 'deletions' | 'additions',
  column: ColumnElements | undefined,
];

type HeaderSlotContent = Element | string | number | null | undefined;

interface PendingFileLoad {
  fileDiff: FileDiffMetadata;
  promise: Promise<void>;
}

type HydrationSetup<LAnnotation> = {
  fileDiff: FileDiffMetadata | undefined;
  lineAnnotations: DiffLineAnnotation<LAnnotation>[] | undefined;
} & MaybeDiffFileInput;

interface HeaderCache {
  lastRenderedHTML: string | undefined;
  html: string | undefined;
  fileDiff: FileDiffMetadata | undefined;
}

interface EditSession<LAnnotation> {
  diff: FileDiffMetadata;
  annotations:
    | EditSessionAnnotations<DiffLineAnnotation<LAnnotation>>
    | undefined;
  /*
   * `outgoingDiff` keeps the diff the document still holds (the render already
   * shows the new `diff`): its presence signals the pending replacement, and it
   * supplies the old-file side both for the undo-reset decision and for
   * capturing session state.
   */
  outgoingDiff: FileDiffMetadata | undefined;
}

let instanceId = -1;

export class FileDiff<LAnnotation = undefined, Caret = undefined> {
  // NOTE(amadeus): We sorta need this to ensure the web-component file is
  // properly loaded
  static LoadedCustomComponent: boolean = DiffsContainerLoaded;

  readonly __id: string = `file-diff:${++instanceId}`;
  readonly type: FileDiffType = 'file-diff';

  protected fileContainer: HTMLElement | undefined;
  protected spriteSVG: SVGElement | undefined;
  protected pre: HTMLPreElement | undefined;
  protected codeUnified: HTMLElement | undefined;
  protected codeDeletions: HTMLElement | undefined;
  protected codeAdditions: HTMLElement | undefined;
  protected bufferBefore: HTMLElement | undefined;
  protected bufferAfter: HTMLElement | undefined;
  protected themeCSSStyle: HTMLStyleElement | undefined;
  protected appliedThemeCSS: AppliedThemeStyleCache | undefined;
  protected hasAdoptedThemeCSS = false;
  protected unsafeCSSStyle: HTMLStyleElement | undefined;
  protected appliedUnsafeCSS: string | undefined;
  protected gutterUtilityContent: HTMLElement | undefined;

  protected headerElement: HTMLElement | undefined;
  protected headerPrefix: HTMLElement | undefined;
  protected headerFilenameSuffix: HTMLElement | undefined;
  protected headerMetadata: HTMLElement | undefined;
  protected headerCustom: HTMLElement | undefined;
  protected separatorCache: Map<string, CustomHunkElementCache> = new Map();
  protected errorWrapper: HTMLElement | undefined;
  protected placeHolder: HTMLElement | undefined;

  protected hunksRenderer: DiffHunksRenderer<LAnnotation>;
  protected resizeManager: ResizeManager;
  protected scrollSyncManager: ScrollSyncManager;
  protected interactionManager: InteractionManager<'diff'>;

  protected annotationCache: Map<string, AnnotationElementCache<LAnnotation>> =
    new Map();
  protected lineAnnotations: DiffLineAnnotation<LAnnotation>[] = [];
  protected managersDirty = false;

  protected deletionFile?: FileContents | null;
  protected additionFile?: FileContents | null;
  public fileDiff: FileDiffMetadata | undefined;
  private editSession: EditSession<LAnnotation> | undefined;
  protected renderedDiff: FileDiffMetadata | undefined;
  protected renderRange: RenderRange | undefined;
  protected pendingFiles: PendingFileLoad | undefined;
  protected appliedPreAttributes: PrePropertiesConfig | undefined;
  protected headerCache: HeaderCache = {
    lastRenderedHTML: undefined,
    html: undefined,
    fileDiff: undefined,
  };
  protected lastRowCount: number | undefined;
  private mounted = false;

  protected enabled = true;

  protected editor: Editor<'file-diff', LAnnotation, Caret> | undefined;
  protected refreshViewTimeout: ReturnType<typeof setTimeout> | undefined;
  // Defer selected-line and editor active-line writes while a refresh rebuilds
  // the diff rows. This is separate from the timeout because the refresh can
  // escalate to a full rerender without one.
  protected lineStateRefreshPending = false;
  protected deferredSelectedLines: DeferredSelectedLinesWrite | undefined;
  protected deferredEditorActiveLine: DeferredEditorActiveLineWrite | undefined;

  constructor(
    public options: FileDiffOptions<LAnnotation, Caret> = {
      theme: DEFAULT_THEMES,
    },
    protected workerManager?: WorkerPoolManager | undefined,
    protected isContainerManaged = false
  ) {
    this.hunksRenderer = this.createHunksRenderer(options);
    this.resizeManager = new ResizeManager();
    this.scrollSyncManager = new ScrollSyncManager();
    this.interactionManager = new InteractionManager(
      'diff',
      this.getInteractionOptions()
    );
    this.workerManager?.subscribeToThemeChanges(this);
  }

  // Hunk expansion clicks only apply to custom and line-info separators.
  private getInteractionOptions() {
    const { options } = this;
    const hunkSeparators = options.hunkSeparators ?? 'line-info';
    return pluckInteractionOptions<'diff'>(
      options,
      typeof hunkSeparators === 'function' ||
        hunkSeparators === 'line-info' ||
        hunkSeparators === 'line-info-basic'
        ? this.handleExpandHunk
        : undefined,
      this.getLineIndex
    );
  }

  protected handleHighlightRender = (): void => {
    this.rerender();
  };

  private getTheme() {
    return (
      this.workerManager?.getDiffRenderOptions().theme ??
      this.options.theme ??
      DEFAULT_THEMES
    );
  }

  protected getHunksRendererOptions(
    options: FileDiffOptions<LAnnotation, Caret>
  ): DiffHunksRendererOptions {
    return getDiffHunksRendererOptions(options);
  }

  protected createHunksRenderer(
    options: FileDiffOptions<LAnnotation, Caret>
  ): DiffHunksRenderer<LAnnotation> {
    return new DiffHunksRenderer<LAnnotation>(
      this.getHunksRendererOptions(options),
      this.getAnnotationSlotName,
      this.handleHighlightRender,
      this.workerManager
    );
  }

  public getLineIndex: GetLineIndexUtility = (
    lineNumber: number,
    side: SelectionSide = 'additions'
  ) => {
    return this.getLineIndexForDiff(
      this.getDiffForLineIndex(),
      lineNumber,
      side
    );
  };

  protected getDiffForLineIndex(): FileDiffMetadata | undefined {
    return this.getRenderedDiff();
  }

  // Resolve source lines against the same diff that produced the rendered
  // rows. During an asynchronous replacement, that can be the previous diff.
  protected getLineIndexForDiff(
    fileDiff: FileDiffMetadata | undefined,
    lineNumber: number,
    side: SelectionSide
  ): [number, number] | undefined {
    if (fileDiff == null) {
      return undefined;
    }
    const lastHunk = fileDiff.hunks.at(-1);
    for (const hunk of fileDiff.hunks) {
      const hunkStart =
        side === 'deletions' ? hunk.deletionStart : hunk.additionStart;
      const hunkCount =
        side === 'deletions' ? hunk.deletionCount : hunk.additionCount;
      let currentLineNumber =
        getHunkSideStartBoundary(hunkStart, hunkCount) + 1;
      let splitIndex = hunk.splitLineStart;
      let unifiedIndex = hunk.unifiedLineStart;

      // If we've selected a line between or before a hunk,
      // we should grab its index here
      if (lineNumber < currentLineNumber) {
        const difference = currentLineNumber - lineNumber;
        return [
          Math.max(unifiedIndex - difference, 0),
          Math.max(splitIndex - difference, 0),
        ];
      }

      if (lineNumber >= currentLineNumber + hunkCount) {
        if (hunk === lastHunk) {
          const difference = lineNumber - (currentLineNumber + hunkCount);
          return [
            unifiedIndex + hunk.unifiedLineCount + difference,
            splitIndex + hunk.splitLineCount + difference,
          ];
        }
        continue;
      }

      for (const content of hunk.hunkContent) {
        if (content.type === 'context') {
          if (lineNumber < currentLineNumber + content.lines) {
            const difference = lineNumber - currentLineNumber;
            return [unifiedIndex + difference, splitIndex + difference];
          }
          currentLineNumber += content.lines;
          splitIndex += content.lines;
          unifiedIndex += content.lines;
        } else {
          const sideCount =
            side === 'deletions' ? content.deletions : content.additions;
          if (lineNumber < currentLineNumber + sideCount) {
            const difference = lineNumber - currentLineNumber;
            return [
              unifiedIndex +
                (side === 'additions' ? content.deletions : 0) +
                difference,
              splitIndex + difference,
            ];
          }
          currentLineNumber += sideCount;
          splitIndex += Math.max(content.deletions, content.additions);
          unifiedIndex += content.deletions + content.additions;
        }
      }

      return undefined;
    }
    return undefined;
  }

  // FIXME(amadeus): This is a bit of a looming issue that I'll need to resolve:
  // * Do we publicly allow merging of options or do we have individualized setters?
  // * When setting new options, we need to figure out what settings require a
  //   re-render and which can just be applied more elegantly
  // * There's also an issue of options that live here on the File class and
  //   those that live on the Hunk class, and it's a bit of an issue with passing
  //   settings down and mirroring them (not great...)
  public setOptions(
    options: FileDiffOptions<LAnnotation, Caret> | undefined
  ): void {
    if (options == null) return;
    this.options = options;
    this.clearReusableHeader();
    this.hunksRenderer.setOptions(this.getHunksRendererOptions(options));
    this.syncInteractionOptions();
  }

  protected syncInteractionOptions(): void {
    this.interactionManager.setOptions(this.getInteractionOptions());
  }

  public setThemeType(themeType: ThemeTypes): void {
    if ((this.options.themeType ?? 'system') === themeType) {
      return;
    }
    this.options = { ...this.options, themeType };
    this.applyCachedThemeState(themeType);
  }

  private applyCachedThemeState(themeType: ThemeTypes): boolean {
    const { appliedThemeCSS, fileContainer } = this;
    if (
      typeof this.options.theme === 'string' ||
      fileContainer == null ||
      appliedThemeCSS == null ||
      appliedThemeCSS.themeType === (appliedThemeCSS.baseThemeType ?? themeType)
    ) {
      return false;
    }
    this.applyThemeState(
      fileContainer,
      appliedThemeCSS.themeStyles,
      themeType,
      appliedThemeCSS.baseThemeType
    );
    return true;
  }

  public getHoveredLine = (): GetHoveredLineResult<'diff'> | undefined => {
    return this.interactionManager.getHoveredLine();
  };

  public getAnnotationSlotName = (
    annotation: LineAnnotation<LAnnotation> | DiffLineAnnotation<LAnnotation>
  ): string => {
    return resolveEditSessionSlotName(
      this.editSession?.annotations,
      annotation,
      getLineAnnotationName
    );
  };

  // Return the annotations this component currently renders. Once editing
  // starts, the private session state owns them.
  protected getLatestAnnotations(): DiffLineAnnotation<LAnnotation>[] {
    return this.editSession?.annotations?.current ?? this.lineAnnotations;
  }

  // Returns true when the caller passed annotations this component has not
  // handled yet. Re-renders often re-pass an annotations array the component
  // already holds — the external one, or one the active session tracks — and
  // treating those repeats as new writes would move annotations, so they are
  // recognized by identity and ignored.
  protected isNewAnnotations(
    lineAnnotations: DiffLineAnnotation<LAnnotation>[]
  ): boolean {
    const session = this.editSession?.annotations;
    return (
      lineAnnotations !== this.lineAnnotations &&
      (session == null ||
        (lineAnnotations !== session.provided &&
          lineAnnotations !== session.current))
    );
  }

  public setLineAnnotations(
    lineAnnotations: DiffLineAnnotation<LAnnotation>[]
  ): void {
    const sessionAnnotations = this.editSession?.annotations;
    if (sessionAnnotations == null) {
      this.lineAnnotations = lineAnnotations;
    } else if (this.isNewAnnotations(lineAnnotations)) {
      // Externally provided annotations are the source of truth: they become
      // the new external collection and the session renders them at the line
      // numbers given. The caller owns whether those positions still make
      // sense after an edit; a revert renders this collection unchanged
      // rather than moving them.
      this.lineAnnotations = lineAnnotations;
      writeEditSessionAnnotations(
        sessionAnnotations,
        lineAnnotations,
        getLineAnnotationName
      );
    }
  }

  // Takes annotations the editor remapped and makes them what the session
  // renders: updates the session, feeds the renderer, and re-renders
  // annotation rows. Returns true when new annotations were adopted —
  // virtualized subclasses override this and refresh their layout on true.
  //
  // The editor delivers annotations through two calls. An edit that changes
  // the line count sends them with the structural rebuild
  // (applyDocumentChange) and again with the change event (__acceptEditorChange);
  // the identity check makes the second call a no-op. An edit that keeps the
  // line count skips the rebuild, so the event is its only path here.
  //
  // The annotations the caller passed in are never touched — stale
  // re-renders keep deduping against them.
  protected syncEditSessionAnnotationsFromEditor(
    lineAnnotations: DiffLineAnnotation<LAnnotation>[]
  ): boolean {
    const session = this.editSession?.annotations;
    if (session == null || lineAnnotations === session.current) {
      return false;
    }
    session.current = lineAnnotations;
    this.hunksRenderer.setLineAnnotations(lineAnnotations);
    this.renderAnnotations();
    return true;
  }

  public setSelectedLines(
    range: SelectedLineRange | null,
    options?: SelectionWriteOptions
  ): void {
    if (this.lineStateRefreshPending) {
      this.deferredSelectedLines = [range, options];
    } else {
      this.interactionManager.setSelection(range, options);
    }
  }

  public setEditorActiveLine(
    lineNumber: number | null,
    options?: EditorActiveLineOptions
  ): void {
    if (this.lineStateRefreshPending) {
      this.deferredEditorActiveLine = [lineNumber, options];
    } else {
      this.interactionManager.setEditorActiveLine(lineNumber, {
        lineNumberOnly: options?.lineNumberOnly,
        side: options?.side ?? 'additions',
      });
    }
  }

  // A refresh can receive selected-lines and editor active-line writes in either
  // order. Apply the latest value from each after the rows are stable.
  protected flushDeferredLineState(): void {
    const {
      deferredEditorActiveLine: editorActiveLine,
      deferredSelectedLines: selectedLines,
    } = this;
    this.lineStateRefreshPending = false;
    this.deferredEditorActiveLine = undefined;
    this.deferredSelectedLines = undefined;

    if (editorActiveLine != null) {
      this.setEditorActiveLine(...editorActiveLine);
    }
    if (selectedLines != null) {
      this.interactionManager.setSelection(...selectedLines);
    }
  }

  public flushManagers(): void {
    const { pre } = this;
    if (this.managersDirty && pre != null) {
      const { diffStyle = 'split', overflow = 'scroll' } = this.options;
      this.interactionManager.setup(pre);
      this.resizeManager.setup(pre, {
        disableAnnotations: overflow === 'wrap',
        columnVariables: this.shouldApplyColumnVariables(overflow)
          ? 'apply'
          : 'measure',
      });
      if (overflow === 'scroll' && diffStyle === 'split') {
        this.scrollSyncManager.setup(
          pre,
          this.codeDeletions,
          this.codeAdditions
        );
      } else {
        this.scrollSyncManager.cleanUp();
      }
    }
    this.managersDirty = false;
  }

  protected shouldApplyColumnVariables(overflow: 'scroll' | 'wrap'): boolean {
    if (typeof this.options.hunkSeparators === 'function') {
      return true;
    }
    return (
      overflow === 'scroll' &&
      (this.getLatestAnnotations().length > 0 ||
        this.pre?.hasAttribute('data-has-merge-conflict') === true)
    );
  }

  public getCodeScrollLeft(): number {
    return Math.max(
      this.codeUnified?.scrollLeft ?? 0,
      this.codeDeletions?.scrollLeft ?? 0,
      this.codeAdditions?.scrollLeft ?? 0
    );
  }

  public setCodeScrollLeft(position: number): void {
    for (const code of [
      this.codeUnified,
      this.codeAdditions,
      this.codeDeletions,
    ]) {
      if (code != null) {
        code.scrollLeft = position;
      }
    }
  }

  public __getEffectiveCodeOptions(): BaseCodeOptions {
    return { ...this.options, ...this.hunksRenderer.getEffectiveCodeOptions() };
  }

  public cleanUp(recycle: boolean = false): void {
    const { editor } = this;
    dequeueRender(this.handleEditSessionRender);
    this.emitPostRender(true);
    // Tear the editor down while the code scrollers still exist. A recycle
    // keeps its document and undo history; a full teardown drops them as the
    // session ends.
    editor?.cleanUp(recycle ? 'recycle' : 'discard');
    if (!recycle) {
      this.editor = undefined;
    }
    this.resizeManager.cleanUp();
    this.interactionManager.cleanUp();
    this.scrollSyncManager.cleanUp();
    this.managersDirty = false;
    this.workerManager?.unsubscribeToThemeChanges(this);
    this.renderRange = undefined;

    // Clean up the elements
    if (!this.isContainerManaged) {
      this.fileContainer?.remove();
    }
    this.fileContainer = undefined;
    this.mounted = false;
    this.clearAuxiliaryNodes();
    this.pre = undefined;
    this.codeUnified = undefined;
    this.codeDeletions = undefined;
    this.codeAdditions = undefined;
    this.bufferBefore?.remove();
    this.bufferBefore = undefined;
    this.bufferAfter?.remove();
    this.bufferAfter = undefined;
    this.appliedPreAttributes = undefined;
    this.headerElement = undefined;
    this.headerPrefix = undefined;
    this.headerFilenameSuffix = undefined;
    this.headerMetadata = undefined;
    this.headerCustom = undefined;
    this.placeHolder?.remove();
    this.placeHolder = undefined;
    this.headerCache.lastRenderedHTML = undefined;
    this.errorWrapper?.remove();
    this.errorWrapper = undefined;
    this.spriteSVG = undefined;
    this.lastRowCount = undefined;
    this.themeCSSStyle = undefined;
    this.appliedThemeCSS = undefined;
    this.hasAdoptedThemeCSS = false;
    this.unsafeCSSStyle = undefined;
    this.appliedUnsafeCSS = undefined;

    if (recycle) {
      this.hunksRenderer.recycle();
    } else {
      this.pendingFiles = undefined;
      this.lineAnnotations = [];
      this.clearReusableHeader();
      this.hunksRenderer.cleanUp();
      this.workerManager = undefined;
      // Clean up the data
      this.fileDiff = undefined;
      this.editSession = undefined;
      this.renderedDiff = undefined;
      this.deletionFile = undefined;
      this.additionFile = undefined;
    }
    clearTimeout(this.refreshViewTimeout);
    this.refreshViewTimeout = undefined;
    this.lineStateRefreshPending = false;
    this.deferredEditorActiveLine = undefined;
    this.deferredSelectedLines = undefined;
    this.enabled = false;
  }

  public virtualizedSetup(): void {
    this.enabled = true;
    this.workerManager?.subscribeToThemeChanges(this);
  }

  public hydrate({
    fileContainer,
    prerenderedHTML,
    preventEmit = false,
    lineAnnotations,
    fileDiff,
    ...fileInputProps
  }: FileDiffHydrationProps<LAnnotation>): void {
    if (!this.enabled) {
      throw new Error(
        'FileDiff.hydrate: attempting to call hydrate after cleaned up'
      );
    }
    if (this.fileContainer != null) {
      throw new Error(
        'FileDiff.hydrate: hydrate can only be called before the instance has rendered or hydrated'
      );
    }
    const fileInput = getDiffFileInput(fileInputProps, 'FileDiff.hydrate');
    this.hydrateElements(fileContainer, prerenderedHTML);
    // An editor attached before hydration may carry a retained keyed document
    // and its session-shaped hunks. Render through that private session instead
    // of adopting external markup, so hydration cannot recompute or flash it.
    const forceEditorRender = this.editor != null;
    const { collapsed = false, disableFileHeader = false } = this.options;
    // A file input always carries at least one side.
    const hasFile = fileInput != null;
    if (
      forceEditorRender ||
      (!collapsed &&
        this.pre == null &&
        ((fileDiff != null && fileDiff.hunks.length > 0) || hasFile)) ||
      (!disableFileHeader &&
        this.headerElement == null &&
        (fileDiff != null || hasFile))
    ) {
      this.render({
        ...fileInputProps,
        fileContainer,
        lineAnnotations,
        fileDiff,
        forceRender: forceEditorRender || fileInputProps.forceRender,
        preventEmit: true,
      });
    }
    // Otherwise orchestrate our setup
    else {
      this.hydrationSetup({
        fileDiff,
        lineAnnotations,
        ...fileInput,
      });
    }
    if (!preventEmit) {
      this.emitPostRender();
    }
  }

  protected hydrateElements(
    fileContainer: HTMLElement,
    prerenderedHTML: string | undefined
  ): void {
    if (this.fileContainer !== fileContainer) {
      this.emitPostRender(true);
    }
    prerenderHTMLIfNecessary(fileContainer, prerenderedHTML);
    for (const element of fileContainer.shadowRoot?.children ?? []) {
      if (element instanceof SVGElement) {
        this.spriteSVG = element;
      } else if (element instanceof HTMLPreElement) {
        this.pre = element;
      } else if (
        element instanceof HTMLElement &&
        'diffsHeader' in element.dataset
      ) {
        this.headerElement = element;
      } else if (element instanceof HTMLStyleElement) {
        if (element.hasAttribute(THEME_CSS_ATTRIBUTE)) {
          this.themeCSSStyle = element;
        } else if (element.hasAttribute(UNSAFE_CSS_ATTRIBUTE)) {
          this.unsafeCSSStyle = element;
          this.appliedUnsafeCSS = element.textContent;
        }
      }
    }
    if (this.pre != null) {
      this.syncCodeNodesFromPre(this.pre);
      this.pre.removeAttribute('data-dehydrated');
    }
    this.fileContainer = fileContainer;
    const { shadowRoot } = fileContainer;
    if (shadowRoot != null && this.themeCSSStyle != null) {
      this.themeCSSStyle.textContent = patchScrollbarGutterSize(
        this.themeCSSStyle.textContent ?? '',
        getMeasuredScrollbarGutter(shadowRoot)
      );
    }
  }

  protected hydrationSetup({
    fileDiff,
    oldFile,
    newFile,
    lineAnnotations,
  }: HydrationSetup<LAnnotation>): void {
    // It's possible we are hydrating a pure-rename and therefore there will be
    // no pre element
    this.lineAnnotations = lineAnnotations ?? this.lineAnnotations;
    this.additionFile = newFile;
    this.deletionFile = oldFile;
    this.fileDiff =
      fileDiff ??
      (oldFile !== undefined && newFile !== undefined
        ? parseDiffFromFile(oldFile, newFile, this.options.parseDiffOptions)
        : undefined);

    if (this.pre == null) {
      return;
    }

    this.syncInteractionOptions();
    this.hunksRenderer.hydrate(this.fileDiff);
    this.renderedDiff = this.fileDiff;
    // FIXME(amadeus): not sure how to handle this yet...
    // this.renderSeparators();
    this.renderAnnotations();
    this.renderGutterUtility();
    this.injectUnsafeCSS();
    this.managersDirty = true;
    this.flushManagers();
  }

  public rerender(): void {
    if (
      !this.enabled ||
      (this.fileDiff == null &&
        this.additionFile == null &&
        this.deletionFile == null)
    ) {
      return;
    }
    this.render({ forceRender: true, renderRange: this.renderRange });
  }

  public onThemeChange(): void {
    this.hunksRenderer.clearRenderCache();
    this.rerender();
  }

  // This wrapper must stay separate from `expandHunk` because subclasses like
  // `VirtualizedFileDiff` replace `expandHunk` with their own instance field
  // after `super()` returns. `InteractionManager` is created in this base
  // constructor, so it needs a stable callback that resolves `this.expandHunk`
  // at click time instead of capturing the base implementation too early.
  public handleExpandHunk = (
    hunkIndex: number,
    direction: ExpansionDirections,
    expansionLineCountOverride?: number
  ): void => {
    this.expandHunk(hunkIndex, direction, expansionLineCountOverride);
  };

  public expandHunk = (
    hunkIndex: number,
    direction: ExpansionDirections,
    expansionLineCountOverride?: number
  ): void => {
    this.loadFilesIfNecessary();
    this.hunksRenderer.expandHunk(
      hunkIndex,
      direction,
      expansionLineCountOverride
    );
    this.rerender();
  };

  protected loadFilesIfNecessary(): void {
    const {
      fileDiff,
      options: { loadDiffFiles },
    } = this;
    if (
      fileDiff == null ||
      !canHydrateDiff(fileDiff) ||
      this.pendingFiles?.fileDiff === fileDiff
    ) {
      return;
    }
    if (loadDiffFiles == null) {
      throw new Error(
        'FileDiff: loadDiffFiles is required to load full files for a partial diff'
      );
    }

    const promise = (async () => {
      try {
        const files = await loadDiffFiles(fileDiff);
        if (this.fileDiff === fileDiff) {
          await this.handleFilesLoaded(fileDiff, files);
        }
      } catch (error: unknown) {
        if (this.options.disableErrorHandling === true) {
          throw error;
        }
        console.error(error);
      }
    })();
    const pendingFiles: PendingFileLoad = (this.pendingFiles = {
      fileDiff,
      promise,
    });
    // Track the exact request object so an older completion for the same diff
    // cannot clear a newer request.
    pendingFiles.promise = promise.finally(() => {
      if (this.pendingFiles === pendingFiles) {
        this.pendingFiles = undefined;
      }
    });
  }

  /**
   * In order to start an edit session, you must be using a `fileDiff` that
   * includes the full contents for both files. In other words, `isPartial`
   * must be false You can use `prepareForEditing` to hydrate if
   * `loadDiffFiles` was passed in to `options`
   */
  public __canAttachEditor(): boolean {
    return this.fileDiff != null && !this.fileDiff.isPartial;
  }

  /**
   * Load a partial diff before starting a new edit session. Call this before
   * Editor.edit when the diff may still be partial; it resolves only when this
   * instance has a complete diff to edit.
   */
  public async prepareForEditing(): Promise<void> {
    if (this.__canAttachEditor()) {
      return;
    }
    // __prepareForEditing already throws for partial diffs that cannot hydrate.
    const pending = this.__prepareForEditing();
    if (pending == null) {
      throw new Error(
        'FileDiff.prepareForEditing: a partial diff requires loadDiffFiles'
      );
    }
    await pending;
    if (!this.__canAttachEditor()) {
      throw new Error(
        'FileDiff.prepareForEditing: the diff did not finish loading'
      );
    }
  }

  /** Hydrate a diff if necessary  */
  public __prepareForEditing(): Promise<void> | undefined {
    if (this.__canAttachEditor()) {
      return undefined;
    }
    if (this.fileDiff?.isPartial === true && !canHydrateDiff(this.fileDiff)) {
      throw new Error(
        'FileDiff: this partial diff cannot be hydrated; provide a complete diff to edit'
      );
    }
    this.loadFilesIfNecessary();
    return this.pendingFiles?.promise;
  }

  protected async handleFilesLoaded(
    expectedDiff: FileDiffMetadata,
    files: LoadedPartialDiffContents
  ): Promise<void> {
    if (this.fileDiff !== expectedDiff || !expectedDiff.isPartial) {
      return;
    }
    hydratePartialDiff('merge', expectedDiff, files);
    this.setHydratedState(files);
    if (!this.installHydratedSessionDiff(expectedDiff)) {
      await awaitWithTimeout(() => this.primeHighlightCache(expectedDiff));
      if (!this.enabled || this.fileDiff !== expectedDiff) {
        return;
      }
    }
    this.rerender();
  }

  // Install a loaded replacement in the edit session before the editor syncs.
  protected installHydratedSessionDiff(
    expectedDiff: FileDiffMetadata
  ): boolean {
    if (expectedDiff.isPartial) {
      throw new Error(
        'FileDiff.installHydratedSessionDiff: diffs cannot be partial for editing'
      );
    }
    if (
      this.fileDiff !== expectedDiff ||
      this.editSession?.outgoingDiff == null
    ) {
      return false;
    }
    this.installEditSession(expectedDiff);
    return true;
  }

  // Install a replacement diff from the caller; returns false when it is the
  // diff already installed. During an edit session the diff the editor's
  // document still holds is kept as `outgoingDiff` until the editor syncs, so
  // it can decide whether the swap keeps or resets undo history.
  protected updateExternalDiff(
    incomingExternalDiff: FileDiffMetadata,
    lineAnnotations?: DiffLineAnnotation<LAnnotation>[]
  ): boolean {
    if (areDiffTargetsEqual(this.fileDiff, incomingExternalDiff)) {
      return false;
    }

    const outgoingDiff =
      this.editSession?.outgoingDiff ?? this.editSession?.diff;
    this.fileDiff = incomingExternalDiff;
    if (outgoingDiff != null) {
      if (incomingExternalDiff.isPartial) {
        this.loadFilesIfNecessary();
      } else {
        this.installEditSession(incomingExternalDiff);
      }
      if (this.editSession != null) {
        this.editSession.outgoingDiff = outgoingDiff;
      }
    }
    if (this.editSession?.annotations != null && lineAnnotations != null) {
      // These annotations arrived with the new diff, so their line numbers
      // describe it. The positions the session tracked for the old document
      // mean nothing now: the session restarts from these annotations, and
      // they also become what renders once the session ends.
      this.lineAnnotations = lineAnnotations;
      this.editSession.annotations = adoptEditSessionAnnotations(
        lineAnnotations,
        getLineAnnotationName,
        this.editSession.annotations
      );
    }
    return true;
  }

  // When an editor opens a document saved under a document key,
  // `retainedDocument` restores its text and undo history. It is omitted when
  // replacing the diff in an open editor so the replacement is handled as a
  // new external update instead of overwriting the document being edited.
  private installEditSession(
    externalDiff: FileDiffMetadata,
    retainedDocument?: FileContents,
    retainedSession?: RetainedDiffSessionSnapshot
  ): void {
    // A retained session is only resumable while the old file (name and
    // contents) is unchanged; otherwise the restored hunks would be invalid.
    const oldFile = retainedSession?.oldFile;
    if (
      retainedSession != null &&
      (oldFile == null
        ? externalDiff.type !== 'new'
        : externalDiff.type === 'new' ||
          oldFile.name !== (externalDiff.prevName ?? externalDiff.name) ||
          !areLinesEqual(oldFile.lines, externalDiff.deletionLines))
    ) {
      throw new Error(
        'FileDiff: retained session cannot resume against a different old file'
      );
    }
    // Edit sessions incrementally clone the diff as needed while editing,
    // initially we start with a top level fast clone
    const sessionDiff = { ...externalDiff };
    delete sessionDiff.cacheKey;
    let documentDiff = retainedSession == null ? externalDiff : undefined;
    if (retainedDocument != null) {
      const { name, lang, contents } = retainedDocument;
      const externalContents = externalDiff.additionLines.join('');
      if (contents !== externalContents && retainedSession == null) {
        throw new Error(
          'FileDiff: retained edits are missing their diff session state'
        );
      }
      if (
        name !== externalDiff.name ||
        lang !== externalDiff.lang ||
        contents !== externalContents
      ) {
        sessionDiff.name = name;
        sessionDiff.lang = lang;
        documentDiff = undefined;
      }
      if (retainedSession != null) {
        sessionDiff.additionLines = splitFileContents(contents);
        sessionDiff.type = retainedSession.type;
        sessionDiff.hunks = retainedSession.hunks;
        sessionDiff.editSessionDirty = true;
        recomputeDiffRenderLineCounts(sessionDiff);
      }
    }
    this.editSession = {
      diff: sessionDiff,
      // Seed annotations when the session is created so the adopt-block in
      // updateExternalDiff fires on the next external update — this is what an
      // attach-before-hydrate (React) mount relies on, since the session does
      // not exist yet at attach. A live session keeps the ones it tracks.
      annotations:
        this.editSession?.annotations ??
        adoptEditSessionAnnotations(
          this.lineAnnotations,
          getLineAnnotationName
        ),
      outgoingDiff: this.editSession?.outgoingDiff,
    };
    this.hunksRenderer.beginEditSession(sessionDiff, documentDiff);
  }

  protected setHydratedState(files: LoadedPartialDiffContents): void {
    this.deletionFile = files.oldFile;
    this.additionFile = files.newFile;
    this.workerManager?.cleanUpTasks(this.hunksRenderer);
    this.hunksRenderer.clearRenderCache();
  }

  public render({
    fileDiff,
    deferManagers = false,
    forceRender = false,
    preventEmit = false,
    lineAnnotations,
    fileContainer,
    containerWrapper,
    renderRange,
    ...fileInputProps
  }: FileDiffRenderProps<LAnnotation>): boolean {
    if (!this.enabled) {
      // NOTE(amadeus): May need to be a silent failure? Making it loud for now
      // to better understand it
      throw new Error(
        'FileDiff.render: attempting to call render after cleaned up'
      );
    }

    const fileInput = getDiffFileInput(fileInputProps, 'FileDiff.render');
    const oldFile = fileInput?.oldFile;
    const newFile = fileInput?.newFile;

    // postpone background tokenizing to next frame for avoiding UI freeze
    // during render
    this.editor?.__postponeBgTokenizeToNextFrame();

    const {
      collapsed = false,
      themeType = 'system',
      expandUnchanged = false,
    } = this.options;
    const nextRenderRange = collapsed ? undefined : renderRange;
    const themeChanged =
      this.appliedThemeCSS != null &&
      !areThemesEqual(this.appliedThemeCSS.theme, this.getTheme());
    const hasFileInput = fileInput != null;
    const filesDidChange =
      hasFileInput &&
      (!areOptionalFilesEqual(oldFile, this.deletionFile) ||
        !areOptionalFilesEqual(newFile, this.additionFile));
    let diffDidChange =
      fileDiff != null && !areDiffTargetsEqual(fileDiff, this.fileDiff);
    const annotationsChanged =
      lineAnnotations != null &&
      (lineAnnotations.length > 0 || this.getLatestAnnotations().length > 0) &&
      this.isNewAnnotations(lineAnnotations);

    if (
      !collapsed &&
      areRenderRangesEqual(nextRenderRange, this.renderRange) &&
      !forceRender &&
      !annotationsChanged &&
      !themeChanged &&
      // If using the fileDiff API, lets check to see if they are equal to
      // avoid doing work
      ((fileDiff != null && !diffDidChange) ||
        // If using the oldFile/newFile API then lets check to see if they are
        // equal
        (fileDiff == null && !filesDidChange))
    ) {
      const rendered = this.applyCachedThemeState(themeType);
      if (rendered) {
        this.finalizeRender();
      }
      return rendered;
    }

    let nextFileDiff = diffDidChange ? fileDiff : undefined;
    if (
      fileDiff == null &&
      hasFileInput &&
      (filesDidChange || this.fileDiff == null)
    ) {
      nextFileDiff = parseDiffFromFile(
        fileInput.oldFile,
        fileInput.newFile,
        this.options.parseDiffOptions
      );
    }

    const { renderRange: previousRenderRange } = this;
    this.renderRange = nextRenderRange;
    // Store files only when this render actually carried a file input:
    // internal rerenders pass none, and wiping the pair here would defeat the
    // oldFile/newFile early-return on every later host render. An explicit
    // fileDiff input supersedes a previously parsed pair, so clear it then.
    if (hasFileInput) {
      this.deletionFile = oldFile;
      this.additionFile = newFile;
    } else if (fileDiff != null) {
      this.deletionFile = undefined;
      this.additionFile = undefined;
    }

    if (nextFileDiff != null) {
      diffDidChange = true;
      this.updateExternalDiff(nextFileDiff, lineAnnotations);
      this.clearReusableHeader();
    }

    if (lineAnnotations != null) {
      this.setLineAnnotations(lineAnnotations);
    }

    const latestDiff = this.getLatestDiff();
    if (latestDiff == null) {
      return false;
    }
    // Backstop for sessions that ended without their exit hook running (e.g.
    // session-shaped metadata reused after a host teardown): restore
    // recompute-shaped hunks before rendering.
    if (
      latestDiff.editSessionDirty === true &&
      this.shouldSelfHealEditSession()
    ) {
      finishEditSessionForDiff(latestDiff, this.options.parseDiffOptions);
      void this.hunksRenderer.refreshHighlightedResult();
    }
    if (expandUnchanged) {
      this.loadFilesIfNecessary();
    }
    this.hunksRenderer.setOptions(this.getHunksRendererOptions(this.options));
    this.syncInteractionOptions();

    this.hunksRenderer.setLineAnnotations(this.getLatestAnnotations());

    const { disableErrorHandling = false, disableFileHeader = false } =
      this.options;

    if (disableFileHeader) {
      // Remove existing header from DOM
      if (this.headerElement != null) {
        this.headerElement.remove();
        this.headerElement = undefined;
        this.headerCache.lastRenderedHTML = undefined;
      }
      this.clearHeaderSlots();
    }
    fileContainer = this.getOrCreateFileContainer(
      fileContainer,
      containerWrapper
    );
    this.applyCachedThemeState(themeType);

    if (collapsed) {
      this.removeRenderedCode();

      try {
        const hunksResult = this.hunksRenderer.renderDiff(
          latestDiff,
          EMPTY_RENDER_RANGE
        );
        if (hunksResult != null) {
          this.applyThemeState(
            fileContainer,
            hunksResult.themeStyles,
            themeType,
            hunksResult.baseThemeType
          );
          if (hunksResult.headerElement != null) {
            this.applyHeaderToDOM(
              hunksResult.headerElement,
              fileContainer,
              hunksResult.fileDiff
            );
          }
        }
        this.renderSeparators([]);
        this.renderedDiff = hunksResult?.fileDiff ?? latestDiff;
        this.injectUnsafeCSS();
      } catch (error: unknown) {
        this.handleRenderError(error, fileContainer, disableErrorHandling);
      }
      this.finalizeRender();
      if (!preventEmit) {
        this.emitPostRender();
      }
      return true;
    }

    try {
      const pre = this.getOrCreatePreNode(fileContainer);

      // Attempt to partially render; if we can't, perform a full render
      if (
        forceRender ||
        annotationsChanged ||
        filesDidChange ||
        diffDidChange ||
        themeChanged ||
        typeof this.options.hunkSeparators === 'function' ||
        !areDiffTargetsEqual(this.renderedDiff, latestDiff) ||
        !this.applyPartialRender(
          latestDiff,
          previousRenderRange,
          nextRenderRange
        )
      ) {
        const hunksResult = this.hunksRenderer.renderDiff(
          latestDiff,
          nextRenderRange
        );
        if (hunksResult == null) {
          if (
            this.workerManager?.isInitialized() === false &&
            this.workerManager.isWorkingPool()
          ) {
            void this.workerManager
              .initialize()
              .catch(() => {})
              .then(() => this.rerender());
          }
          return false;
        }

        this.applyThemeState(
          fileContainer,
          hunksResult.themeStyles,
          themeType,
          hunksResult.baseThemeType
        );

        if (hunksResult.headerElement != null) {
          this.applyHeaderToDOM(
            hunksResult.headerElement,
            fileContainer,
            hunksResult.fileDiff
          );
        }
        if (
          hunksResult.additionsContentAST != null ||
          hunksResult.deletionsContentAST != null ||
          hunksResult.unifiedContentAST != null
        ) {
          if (this.shouldGuardRebuildScroll()) {
            guardWebKitScrollDuringRebuild(pre, () =>
              this.replaceCodeColumns(pre, hunksResult)
            );
          } else {
            this.replaceCodeColumns(pre, hunksResult);
          }
        } else if (this.pre != null) {
          this.pre.remove();
          this.pre = undefined;
        }
        this.renderSeparators(hunksResult.hunkData);
        this.renderedDiff = hunksResult.fileDiff;
      }
      this.applyBuffers(pre, nextRenderRange);
      this.injectUnsafeCSS();
      this.renderAnnotations();
      this.renderGutterUtility();

      this.managersDirty = true;
      if (!deferManagers) {
        this.flushManagers();
      }

      this.finalizeRender();
      if (this.editor != null) {
        this.syncRenderViewToEditor();
      }
    } catch (error: unknown) {
      this.handleRenderError(error, fileContainer, disableErrorHandling);
    }
    if (!preventEmit) {
      this.emitPostRender();
    }
    return true;
  }

  protected finalizeRender(): void {}

  protected emitPostRender(unmount = false): void {
    const { fileContainer, mounted, options } = this;
    if (unmount) {
      this.mounted = false;
      if (mounted && fileContainer != null) {
        options.onPostRender?.(fileContainer, this, 'unmount');
      }
    } else if (fileContainer != null) {
      this.mounted = true;
      const { onPostRender } = options;
      onPostRender?.(fileContainer, this, mounted ? 'update' : 'mount');
    }
  }

  // Return the newest diff this component intends to display. An active edit
  // session owns that state instead of the caller-provided diff.
  protected getLatestDiff(
    fileDiff: FileDiffMetadata | undefined = this.fileDiff
  ): FileDiffMetadata | undefined {
    return this.editSession?.diff ?? fileDiff;
  }

  // Return the diff that produced the DOM currently owned by this instance.
  // It can trail getLatestDiff while replacement highlighting is pending.
  protected getRenderedDiff(): FileDiffMetadata | undefined {
    return this.renderedDiff;
  }

  private syncRenderViewToEditor(): void {
    const { editor, fileContainer } = this;
    const fileDiff = this.getLatestDiff();
    if (
      editor == null ||
      fileContainer == null ||
      fileDiff == null ||
      fileDiff.isPartial
    ) {
      return;
    }
    const lineAnnotations = this.getLatestAnnotations();
    let { renderRange } = this;
    // The stored render range is in rendered-row units for the windowed AST
    // pipeline, but the editor consumes render ranges in document-line units.
    // Derive the addition-side document window covered by the rendered rows:
    // startingLine = first addition line with a row in the window, totalLines =
    // last such line - first + 1, and 0 when the window holds no addition rows
    // (e.g. a pure-deletion run taller than the viewport).
    if (renderRange != null && !isDefaultRenderRange(renderRange)) {
      const {
        diffStyle = 'split',
        expandUnchanged = false,
        collapsedContextThreshold = DEFAULT_COLLAPSED_CONTEXT_THRESHOLD,
      } = this.options;
      let firstLineNumber: number | undefined;
      let lastLineNumber: number | undefined;
      iterateOverDiff({
        diff: fileDiff,
        diffStyle,
        startingLine: renderRange.startingLine,
        totalLines: renderRange.totalLines,
        expandedHunks: expandUnchanged
          ? true
          : this.hunksRenderer.getExpandedHunksMap(),
        collapsedContextThreshold,
        callback: ({ additionLine }) => {
          if (additionLine != null) {
            firstLineNumber ??= additionLine.lineNumber;
            lastLineNumber = additionLine.lineNumber;
          }
        },
      });
      renderRange =
        firstLineNumber == null || lastLineNumber == null
          ? { ...renderRange, startingLine: 0, totalLines: 0 }
          : {
              ...renderRange,
              startingLine: firstLineNumber - 1,
              totalLines: lastLineNumber - firstLineNumber + 1,
            };
    }
    const sync = (highlighter: DiffsHighlighter): void => {
      if (
        !this.enabled ||
        this.editor !== editor ||
        this.fileContainer !== fileContainer ||
        this.getLatestDiff() !== fileDiff
      ) {
        return;
      }
      const replacement = this.editSession?.outgoingDiff;
      const { fileDiff: externalDiff } = this;
      const externalDocument =
        replacement != null && externalDiff != null && replacement !== fileDiff;
      const resetHistory =
        externalDocument && shouldResetUndoState(replacement, externalDiff);
      editor.__syncRenderView({
        highlighter,
        fileContainer,
        fileDiff,
        lineAnnotations,
        renderRange,
        externalDocument,
        resetHistory,
      });
    };
    const theme = this.getTheme();
    const lang = fileDiff.lang ?? getFiletypeFromFileName(fileDiff.name);
    // Sync synchronously whenever the shared highlighter is ready; otherwise
    // load it and sync once it resolves.
    const highlighter = getHighlighterIfLoaded({
      theme,
      lang,
    });
    if (highlighter != null) {
      sync(highlighter);
    } else {
      void getSharedHighlighter({
        themes: getThemes(theme),
        langs: ['text', lang],
        preferredHighlighter: resolvePreferredHighlighter(
          this.workerManager,
          this.options
        ),
      })
        .then(sync)
        .catch((error: unknown) => {
          if (!(error instanceof HighlighterDisposedError)) {
            console.error(error);
          }
        });
    }
  }

  /** @internal The editor applied or edited past the pending external replacement. */
  public __acknowledgeDocumentUpdate(): void {
    if (this.editSession != null) {
      this.editSession.outgoingDiff = undefined;
    }
  }

  /** @internal Settle annotations locally. */
  public __acceptEditorChange(
    event: EditorChangeEvent<'file-diff', LAnnotation, Caret>
  ): void {
    const { lineAnnotations } = event;
    if (lineAnnotations != null) {
      this.syncEditSessionAnnotationsFromEditor(lineAnnotations);
    }
  }

  public emitEditChange(
    event: EditorChangeEvent<'file-diff', LAnnotation, Caret>
  ): void {
    const { onEditChange } = this.options;
    onEditChange?.(event);
  }

  /**
   * @internal Capture the current diff session, or return `undefined` when no
   * complete compatible session exists.
   *
   * When `clone` is true, the returned lines and hunks are copied.
   */
  public __captureDocumentSessionState(
    clone = true
  ): CapturedDiffSessionState | undefined {
    let { fileDiff, editSession: { diff: sessionDiff, outgoingDiff } = {} } =
      this;
    if (outgoingDiff != null && fileDiff != null) {
      if (!fileDiff.isPartial && shouldResetUndoState(outgoingDiff, fileDiff)) {
        return undefined;
      }
      sessionDiff = outgoingDiff;
    }
    if (sessionDiff == null || sessionDiff.isPartial) {
      return undefined;
    }
    return {
      diffSession: {
        oldFile:
          sessionDiff.type !== 'new'
            ? {
                name: sessionDiff.prevName ?? sessionDiff.name,
                lines: clone
                  ? [...sessionDiff.deletionLines]
                  : sessionDiff.deletionLines,
              }
            : null,
        type: sessionDiff.type,
        hunks: clone ? cloneHunks(sessionDiff.hunks) : sessionDiff.hunks,
      },
      hasChanges: sessionDiff.editSessionDirty === true,
    };
  }

  /** @internal Associate this component with its editor for a render lifecycle. */
  public __attachEditor(
    editor: Editor<'file-diff', LAnnotation, Caret>
  ): () => void {
    // Editing is a plain file-diff concern only. Subclasses with their own
    // hunk semantics (UnresolvedFile) are not editable, so an editor must
    // never attach to them.
    if (this.type !== 'file-diff') {
      throw new Error(
        `FileDiff.__attachEditor: cannot attach an editor to a "${this.type}" diff`
      );
    }
    if (this.editor != null) {
      throw new Error('FileDiff.__attachEditor: an editor is already attached');
    }
    if (!this.__canAttachEditor()) {
      throw new Error(
        'FileDiff.__attachEditor: a complete diff is required before editing'
      );
    }
    const detach = () => {
      this.editor = undefined;
      this.hunksRenderer.endEditSession();
      this.finalizeEditSessionHunks();
    };
    try {
      this.resumeEditorRendering(editor);
      return detach;
    } catch (error) {
      detach();
      throw error;
    }
  }

  /** @internal Resume rendering for the editor already associated with this component. */
  public __resumeEditor(editor: Editor<'file-diff', LAnnotation, Caret>): void {
    if (this.editor !== editor) {
      throw new Error('FileDiff.__resumeEditor: editor association changed');
    }
    this.resumeEditorRendering(editor);
  }

  private resumeEditorRendering(
    editor: Editor<'file-diff', LAnnotation, Caret>
  ): void {
    const { fileDiff: externalDiff } = this;
    const pendingReplacement = this.editSession?.outgoingDiff;
    // A pending replacement whose diff was partial when it arrived installs now
    // that we are (re)attaching with a hydrated diff.
    if (
      pendingReplacement != null &&
      externalDiff != null &&
      !externalDiff.isPartial &&
      this.editSession?.diff === pendingReplacement
    ) {
      this.installEditSession(externalDiff);
    }
    if (
      this.editSession == null &&
      externalDiff != null &&
      !externalDiff.isPartial
    ) {
      this.installEditSession(
        externalDiff,
        editor.__getDocumentContents({
          name: externalDiff.name,
          lang: externalDiff.lang,
          contents: externalDiff.additionLines.join(''),
        }),
        editor.__getDocumentSessionState()
      );
    } else if (this.editSession != null) {
      this.hunksRenderer.beginEditSession(this.editSession.diff);
    }
    this.editor = editor;
    // The editor sync below refuses partial diffs (it needs the full file
    // contents); kick off hydration so the loaded re-render re-runs it.
    if (this.fileDiff?.isPartial === true) {
      this.loadFilesIfNecessary();
    }
    const editSessionDiff = this.editSession?.diff;
    if (this.hunksRenderer.editorRenderReady()) {
      // Compatible markup can be reused without repainting. Once the renderer
      // transfers that cache to the private session, the existing DOM belongs
      // to the session as well.
      if (
        editSessionDiff != null &&
        this.hunksRenderer.diffCache === editSessionDiff
      ) {
        this.renderedDiff = editSessionDiff;
      }
      this.syncRenderViewToEditor();
    } else {
      // The current markup is missing the editor's token metadata, or its
      // highlight is still pending: render through the session, which also
      // syncs the render view once it paints.
      this.rerender();
    }
  }

  /**
   * @internal
   *
   * Ends the edit session and settles which diff this component renders.
   * Requires the editor to be detached first. Does nothing when no session
   * exists, so callers can invoke it again safely after it has settled.
   *
   * `onEditComplete` receives the completed diff, current external diff,
   * complete file pair, and both annotation collections even when the final
   * text is unchanged. In `install` mode, accepting installs the completed diff
   * and its annotations; rejecting or having no handler restores the external
   * values. `discard` mode always restores the external values. An accepted
   * diff cannot reuse the replaced diff's `cacheKey`.
   */
  public __completeEditSession(
    editor: Editor<'file-diff', LAnnotation, Caret>,
    mode: 'install' | 'discard'
  ): void {
    const {
      editSession,
      fileDiff: externalDiff,
      lineAnnotations: externalAnnotations,
    } = this;
    if (editSession == null || externalDiff == null) {
      return;
    }
    const { diff: editSessionDiff, annotations: editSessionAnnotations } =
      editSession;
    if (this.editor != null) {
      throw new Error(
        'FileDiff.__completeEditSession: detach the editor before completing the session'
      );
    }
    this.hunksRenderer.endEditSession();
    this.finalizeEditSessionHunks();

    const install = mode === 'install';
    const sessionAnnotationsCurrent = editSessionAnnotations?.current;
    let failed = false;
    let failure: unknown;
    const completedDiff = cloneFileDiffMetadata(editSessionDiff);
    const newFile: FileContents = {
      name: completedDiff.name,
      contents: completedDiff.additionLines.join(''),
    };
    if (completedDiff.lang != null) {
      newFile.lang = completedDiff.lang;
    }
    const event: FileDiffEditCompleteEvent<LAnnotation, Caret> = {
      fileDiff: completedDiff,
      editor,
      originalFileDiff: externalDiff,
      oldFile:
        completedDiff.type === 'new'
          ? null
          : {
              name: completedDiff.prevName ?? completedDiff.name,
              contents: completedDiff.deletionLines.join(''),
            },
      newFile,
      lineAnnotations: sessionAnnotationsCurrent,
      originalLineAnnotations: externalAnnotations,
    };
    // Frozen so a handler cannot swap the event's fileDiff/originalFileDiff
    // references; nested mutation (i.e. a fresh cacheKey on event.fileDiff)
    // still works.
    Object.freeze(event);
    try {
      editor.__emitEditComplete(event);
      if (this.options.onEditComplete?.(event) === 'accept') {
        if (
          completedDiff.cacheKey != null &&
          completedDiff.cacheKey === externalDiff.cacheKey
        ) {
          throw new Error(
            'FileDiff.__completeEditSession: an accepted diff must not reuse the replaced diff cacheKey'
          );
        }
        if (install) {
          this.fileDiff = completedDiff;
          // Callers using the oldFile/newFile API get the stored pair
          // refreshed so their next render with the event's files does not
          // reparse over the accepted diff. Every editable pair has a new
          // side (deleted files cannot be edited), so that is the check.
          if (this.additionFile != null) {
            this.deletionFile = event.oldFile;
            this.additionFile = newFile;
          }
          if (sessionAnnotationsCurrent != null) {
            this.lineAnnotations = sessionAnnotationsCurrent;
          }
        }
      }
    } catch (error) {
      failed = true;
      failure = error;
    }
    this.editSession = undefined;
    if (install && this.fileContainer != null) {
      this.rerender();
    }
    if (failed) {
      throw failure;
    }
  }

  /**
   * Run the session-end recompute: restore recompute-shaped hunks (a
   * context-only region collapses away, boundaries re-derive), preserve
   * expansion state best-effort via old-side anchors, and repaint through
   * the session render path — which also invalidates virtualized layout,
   * since nothing else does at exit now that editing does not flip
   * expandUnchanged. Marker-guarded and idempotent; CodeView also calls this
   * when ending a session whose detach closure was consumed by a recycle.
   * Safe on a cleaned-up instance: the recompute is pure metadata work and
   * the deferred rerender is enabled-guarded. Returns true when a recompute
   * ran.
   */
  public finalizeEditSessionHunks(): boolean {
    const fileDiff = this.getLatestDiff();
    if (fileDiff == null || fileDiff.editSessionDirty !== true) {
      return false;
    }
    const { collapsedContextThreshold = DEFAULT_COLLAPSED_CONTEXT_THRESHOLD } =
      this.options;
    const anchors = captureExpansionAnchors(
      fileDiff,
      this.hunksRenderer.getExpandedHunksMap(),
      collapsedContextThreshold
    );
    finishEditSessionForDiff(fileDiff, this.options.parseDiffOptions);
    this.hunksRenderer.setExpandedHunksMap(
      rebuildExpansionFromAnchors(fileDiff, anchors)
    );
    void this.hunksRenderer.refreshHighlightedResult();
    this.escalateEditSessionRender();
    return true;
  }

  // normally triggered by the host when the document line count changes
  public applyDocumentChange(
    textDocument: TextDocument<'file-diff', LAnnotation>,
    newLineAnnotations?: DiffLineAnnotation<LAnnotation>[]
  ): void {
    this.beginSessionUpdate('applyDocumentChange');
    this.hunksRenderer.applyDocumentChange(textDocument);
    if (newLineAnnotations != null) {
      this.syncEditSessionAnnotationsFromEditor(newLineAnnotations);
    }
    this.rerender();
    this.interactionManager.setSelectionDirty();
  }

  /** Update the private diff without editor DOM, then rehighlight on return. */
  public applySuspendedDocumentChange(
    textDocument: TextDocument<'file-diff', LAnnotation>,
    newLineAnnotations?: DiffLineAnnotation<LAnnotation>[]
  ): void {
    this.applyDocumentChange(textDocument, newLineAnnotations);
    this.hunksRenderer.clearRenderCache();
  }

  public updateRenderCache(
    dirtyLines: Map<number, Array<HighlightedToken>>,
    themeType: 'dark' | 'light',
    options: UpdateRenderCacheOptions = {}
  ): void {
    this.beginSessionUpdate('updateRenderCache');
    const regionsChanged = this.hunksRenderer.updateRenderCache(
      dirtyLines,
      themeType,
      options.lineCountChangeInFlight,
      options.changedDocumentLines,
      options.documentLineCount
    );
    // A same-line-count edit that reshaped the session regions (an edit into
    // a collapsed gap) changes the rendered row set, which the debounced
    // line-type refresh below cannot express. Escalate to a deferred full
    // re-render — never a synchronous one, since this runs mid-editor-pass
    // and rebuilding rows the editor is about to touch detaches its geometry
    // caches.
    if (!regionsChanged && options.shouldRefreshDiffsView !== true) {
      return;
    }
    clearTimeout(this.refreshViewTimeout);
    this.refreshViewTimeout = undefined;
    this.lineStateRefreshPending = true;
    if (regionsChanged) {
      this.escalateEditSessionRender();
      return;
    }
    this.refreshViewTimeout = setTimeout(() => {
      this.refreshViewTimeout = undefined;
      const { diffStyle } = this.options;
      const fileDiff = this.getLatestDiff();
      const hunksResult =
        fileDiff != null && (diffStyle === 'split' || diffStyle === 'unified')
          ? this.hunksRenderer.renderDiff(fileDiff, this.renderRange)
          : undefined;
      const columns = hunksResult != null ? this.getCodeColumns() : undefined;
      if (hunksResult != null && columns != null) {
        const rebuild = (): void => {
          for (const [columnType, column] of columns) {
            if (column == null) {
              continue;
            }
            const ast = this.hunksRenderer.renderCodeAST(
              columnType,
              hunksResult
            );
            for (const [element, children] of [
              [column.gutter, getElementChildren(ast?.[0])],
              [column.content, getElementChildren(ast?.[1])],
            ] as const) {
              if (children == null) {
                continue;
              }
              if (diffStyle === 'unified') {
                element.innerHTML = hastToHtml(children);
              } else if (element.childElementCount === children.length) {
                for (let i = 0; i < children.length; i++) {
                  const row = element.children[i] as HTMLElement;
                  const lineType = (children[i] as HASTElement).properties[
                    'data-line-type'
                  ] as string | undefined;
                  if (lineType != null && row.dataset.lineType !== lineType) {
                    row.dataset.lineType = lineType;
                  }
                }
              }
            }
            if (
              diffStyle === 'unified' &&
              hunksResult.rowCount !== this.lastRowCount
            ) {
              this.applyRowSpan(column, hunksResult.rowCount);
              this.lastRowCount = hunksResult.rowCount;
            }
          }
          this.renderedDiff = hunksResult.fileDiff;
        };
        // Split view only patches each row's `data-line-type`; unified view
        // re-renders its columns.
        if (diffStyle === 'split') {
          rebuild();
        } else {
          if (this.shouldGuardRebuildScroll()) {
            guardWebKitScrollDuringRebuild(this.pre, rebuild);
          } else {
            rebuild();
          }
          this.renderSeparators(hunksResult.hunkData);
          this.managersDirty = true;
          this.flushManagers();
          this.syncRenderViewToEditor();
        }
      }
      this.flushDeferredLineState();
    }, 150);
  }

  // Copy-on-write the session's addition lines (still shared with the
  // external diff or the old side), then point the renderer at the session.
  private beginSessionUpdate(caller: string): void {
    const editSessionDiff = this.editSession?.diff;
    if (editSessionDiff == null) {
      throw new Error(`FileDiff.${caller}: requires an active edit session`);
    }
    if (
      editSessionDiff.additionLines === this.fileDiff?.additionLines ||
      editSessionDiff.additionLines === editSessionDiff.deletionLines
    ) {
      editSessionDiff.additionLines = [...editSessionDiff.additionLines];
    }
    this.hunksRenderer.beginEditSession(editSessionDiff);
  }

  // Editor-facing visibility oracle: whether a one-based new-file line has
  // (or will have on scroll) a rendered row under the current expansion
  // state. See isAdditionLineRenderable.
  public isLineRenderable(lineNumber: number): boolean {
    const fileDiff = this.getRenderedDiff();
    if (fileDiff == null) {
      return true;
    }
    const {
      expandUnchanged = false,
      collapsedContextThreshold = DEFAULT_COLLAPSED_CONTEXT_THRESHOLD,
    } = this.options;
    return isAdditionLineRenderable({
      fileDiff,
      lineNumber,
      expandedHunks: expandUnchanged
        ? true
        : this.hunksRenderer.getExpandedHunksMap(),
      collapsedContextThreshold,
    });
  }

  // Fold-skip companion to isLineRenderable: the nearest renderable one-based
  // new-file line at or beyond lineNumber in the given direction.
  public getNearestRenderableLine(
    lineNumber: number,
    direction: 'up' | 'down'
  ): number | undefined {
    const fileDiff = this.getRenderedDiff();
    if (fileDiff == null) {
      return lineNumber;
    }
    const {
      expandUnchanged = false,
      collapsedContextThreshold = DEFAULT_COLLAPSED_CONTEXT_THRESHOLD,
    } = this.options;
    return getNearestRenderableAdditionLine({
      fileDiff,
      lineNumber,
      direction,
      expandedHunks: expandUnchanged
        ? true
        : this.hunksRenderer.getExpandedHunksMap(),
      collapsedContextThreshold,
    });
  }

  // Expand collapsed context so a one-based new-file line can render: one
  // deterministic expansion from the nearest gap edge, sized to reach the
  // target plus the normal expansion step (clamped to the gap at render).
  // Routed through expandHunk so subclass expansion flows (CodeView's
  // deferred pendingExpansions) apply.
  public revealLine(lineNumber: number): boolean {
    const fileDiff = this.getRenderedDiff();
    const {
      expandUnchanged = false,
      collapsedContextThreshold = DEFAULT_COLLAPSED_CONTEXT_THRESHOLD,
      expansionLineCount = 100,
    } = this.options;
    if (fileDiff == null || fileDiff.isPartial || expandUnchanged) {
      return false;
    }
    const expandedHunks = this.hunksRenderer.getExpandedHunksMap();

    for (const [hunkIndex, hunk] of fileDiff.hunks.entries()) {
      const [hunkStart, hunkEnd] = getHunkAdditionLineRange(hunk);
      if (lineNumber < hunkStart) {
        const region = getExpandedRegion({
          isPartial: false,
          rangeSize: hunk.collapsedBefore,
          expandedHunks,
          hunkIndex,
          collapsedContextThreshold,
        });
        const gapStart = hunkStart - region.rangeSize;
        if (
          region.renderAll ||
          lineNumber < gapStart + region.fromStart ||
          lineNumber >= hunkStart - region.fromEnd
        ) {
          return false;
        }
        const fromStartDistance =
          lineNumber - (gapStart + region.fromStart) + 1;
        const fromEndDistance = hunkStart - region.fromEnd - lineNumber;
        const expandUp = fromStartDistance <= fromEndDistance;
        this.expandHunk(
          hunkIndex,
          expandUp ? 'up' : 'down',
          (expandUp ? fromStartDistance : fromEndDistance) + expansionLineCount
        );
        return true;
      }
      if (lineNumber < hunkEnd) {
        return false;
      }
    }

    const trailingRegion = getTrailingExpandedRegion({
      fileDiff,
      hunkIndex: fileDiff.hunks.length - 1,
      expandedHunks,
      collapsedContextThreshold,
      errorPrefix: 'FileDiff.revealLine',
    });
    if (trailingRegion == null || trailingRegion.renderAll) {
      return false;
    }
    const lastHunk = fileDiff.hunks[fileDiff.hunks.length - 1];
    const [, trailingStart] = getHunkAdditionLineRange(lastHunk);
    if (
      lineNumber < trailingStart + trailingRegion.fromStart ||
      lineNumber >= trailingStart + trailingRegion.rangeSize
    ) {
      return false;
    }
    this.expandHunk(
      fileDiff.hunks.length,
      'up',
      lineNumber -
        (trailingStart + trailingRegion.fromStart) +
        1 +
        expansionLineCount
    );
    return true;
  }

  // Whether render() may run the session-exit recompute on dirty metadata.
  // False while an editor is attached (the session is live). CodeView-managed
  // instances override this: their sessions survive recycling with no editor
  // attached, and CodeView runs the exit recompute itself when it reaps a
  // session.
  protected shouldSelfHealEditSession(): boolean {
    return this.editor == null;
  }

  // Deferred full re-render for session region changes. The subsequent
  // render() ends in syncRenderViewToEditor, which resets the editor's
  // geometry caches against the rebuilt rows. VirtualizedFileDiff overrides
  // this to also invalidate its layout caches.
  protected escalateEditSessionRender(): void {
    queueRender(this.handleEditSessionRender);
  }

  private handleEditSessionRender = (): void => {
    this.rerender();
    this.flushDeferredLineState();
  };

  private removeRenderedCode(): void {
    this.resizeManager.cleanUp();
    this.scrollSyncManager.cleanUp();
    this.interactionManager.cleanUp();
    this.clearAuxiliaryNodes();

    this.bufferBefore?.remove();
    this.bufferBefore = undefined;
    this.bufferAfter?.remove();
    this.bufferAfter = undefined;

    this.codeUnified?.remove();
    this.codeUnified = undefined;
    this.codeDeletions?.remove();
    this.codeDeletions = undefined;
    this.codeAdditions?.remove();
    this.codeAdditions = undefined;

    this.pre?.remove();
    this.pre = undefined;

    this.appliedPreAttributes = undefined;
    this.lastRowCount = undefined;
  }

  private clearAuxiliaryNodes(): void {
    for (const { element } of this.separatorCache.values()) {
      element.remove();
    }
    this.separatorCache.clear();

    for (const { element } of this.annotationCache.values()) {
      element.remove();
    }
    this.annotationCache.clear();

    this.gutterUtilityContent?.remove();
    this.gutterUtilityContent = undefined;
  }

  public renderPlaceholder(height: number): boolean {
    if (this.fileContainer == null) {
      return false;
    }
    this.emitPostRender(true);
    this.removeRenderedCode();
    this.clearHeaderSlots();
    this.cleanupErrorWrapper();
    this.headerElement?.remove();
    this.spriteSVG?.remove();
    this.themeCSSStyle?.remove();
    this.unsafeCSSStyle?.remove();
    this.headerElement = undefined;
    this.spriteSVG = undefined;
    this.themeCSSStyle = undefined;
    this.appliedThemeCSS = undefined;
    this.hasAdoptedThemeCSS = false;
    this.unsafeCSSStyle = undefined;
    this.appliedUnsafeCSS = undefined;
    this.headerCache.lastRenderedHTML = undefined;
    this.mounted = false;

    if (this.placeHolder == null) {
      const shadowRoot =
        this.fileContainer.shadowRoot ??
        this.fileContainer.attachShadow({ mode: 'open' });
      this.placeHolder = document.createElement('div');
      this.placeHolder.dataset.placeholder = '';
      shadowRoot.appendChild(this.placeHolder);
    }
    return this.setPlaceholderHeight(height);
  }

  protected setPlaceholderHeight(height: number): boolean {
    if (this.placeHolder == null) {
      return false;
    }
    this.placeHolder.style.setProperty('height', `${height}px`);
    return true;
  }

  public async primeHighlightCache(
    fileDiff: FileDiffMetadata | undefined = this.fileDiff
  ): Promise<void> {
    const { workerManager } = this;
    if (
      fileDiff == null ||
      workerManager == null ||
      !workerManager.isWorkingPool() ||
      fileDiff.cacheKey == null ||
      isDiffPlainText(fileDiff) ||
      Math.max(fileDiff.additionLines.length, fileDiff.deletionLines.length) >
        (this.options.tokenizeMaxLength ?? DEFAULT_TOKENIZE_MAX_LENGTH)
    ) {
      return;
    }

    await workerManager
      .primeDiffHighlightCache(fileDiff)
      .catch((error: unknown) => {
        if (!isHandledWorkerPoolError(error)) {
          console.error(error);
        }
      });
  }

  private renderSeparators(hunkData: HunkData[]): void {
    const { hunkSeparators } = this.options;
    const staleSeparators = new Map(this.separatorCache);
    if (
      !this.isContainerManaged &&
      this.fileContainer != null &&
      typeof hunkSeparators === 'function'
    ) {
      for (const hunk of hunkData) {
        const id = hunk.slotName;
        const cache = this.separatorCache.get(id);
        if (cache == null || !areHunkDataEqual(hunk, cache.hunkData)) {
          cache?.element.remove();
          const element = document.createElement('div');
          element.style.display = 'contents';
          element.slot = id;
          const child = hunkSeparators(hunk, this);
          if (child != null) {
            element.appendChild(child);
          }
          this.fileContainer.appendChild(element);
          this.separatorCache.set(id, { element, hunkData: hunk });
        }
        staleSeparators.delete(id);
      }
    }
    for (const [id, { element }] of staleSeparators) {
      this.separatorCache.delete(id);
      element.remove();
    }
  }

  protected renderAnnotations(): void {
    const staleAnnotations = new Map(this.annotationCache);
    const { renderAnnotation } = this.options;
    if (
      !this.isContainerManaged &&
      this.fileContainer != null &&
      renderAnnotation != null
    ) {
      for (const [index, annotation] of this.getLatestAnnotations().entries()) {
        const name = this.getAnnotationSlotName(annotation);
        const id = `${index}-${name}`;
        const cache = this.annotationCache.get(id);
        if (
          cache == null ||
          !areDiffLineAnnotationsEqual(annotation, cache.annotation)
        ) {
          cache?.element.remove();
          const content = renderAnnotation(annotation);
          // If we can't render anything, then we should not render anything
          // and clear the annotation cache if necessary.
          if (content == null) {
            continue;
          }
          const element = createAnnotationWrapperNode(name);
          element.appendChild(content);
          this.fileContainer.appendChild(element);
          this.annotationCache.set(id, { element, annotation });
        }
        staleAnnotations.delete(id);
      }
    }
    for (const [id, { element }] of staleAnnotations) {
      this.annotationCache.delete(id);
      element.remove();
    }
  }

  protected renderGutterUtility(): void {
    const {
      fileContainer,
      options: { renderGutterUtility },
    } = this;
    const element =
      fileContainer != null
        ? renderGutterUtility?.(this.interactionManager.getHoveredLine)
        : undefined;
    if (element == null) {
      this.gutterUtilityContent?.remove();
      this.gutterUtilityContent = undefined;
    } else if (this.gutterUtilityContent == null) {
      const gutterUtilityContent = createGutterUtilityContentNode();
      gutterUtilityContent.appendChild(element);
      fileContainer?.appendChild(gutterUtilityContent);
      this.gutterUtilityContent = gutterUtilityContent;
    }
  }

  protected getOrCreateFileContainer(
    fileContainer?: HTMLElement,
    parentNode?: HTMLElement
  ): HTMLElement {
    const { fileContainer: previousContainer } = this;
    const nextContainer =
      fileContainer ??
      previousContainer ??
      document.createElement(DIFFS_TAG_NAME);
    const containerChanged = previousContainer !== nextContainer;
    if (containerChanged) {
      if (previousContainer != null) {
        this.editor?.__captureFocusForDOMReplacement();
      }
      this.emitPostRender(true);
      if (previousContainer != null) {
        this.headerCache.lastRenderedHTML = undefined;
        this.headerElement = undefined;
      }
    }
    this.fileContainer = nextContainer;
    if (parentNode != null && nextContainer.parentNode !== parentNode) {
      parentNode.appendChild(nextContainer);
    }
    // NOTE(amadeus): Adopting a reused shell is technically not safe outside
    // of the CodeView component: it assumes all the elements have the correct
    // content based on CodeView global options.
    if (containerChanged && nextContainer.shadowRoot != null) {
      for (const element of nextContainer.shadowRoot.children) {
        if (element instanceof SVGElement) {
          this.spriteSVG ??= element;
        } else if (isStyleNode(element)) {
          if (element.hasAttribute(THEME_CSS_ATTRIBUTE)) {
            this.themeCSSStyle ??= element;
            this.hasAdoptedThemeCSS = true;
          } else if (element.hasAttribute(UNSAFE_CSS_ATTRIBUTE)) {
            this.unsafeCSSStyle ??= element;
            this.appliedUnsafeCSS ??= this.options.unsafeCSS ?? undefined;
          }
        }
      }
    }
    const shadowRoot =
      nextContainer.shadowRoot ?? nextContainer.attachShadow({ mode: 'open' });
    if (this.spriteSVG == null) {
      const fragment = document.createElement('div');
      fragment.innerHTML = SVGSpriteSheet;
      const { firstChild } = fragment;
      if (firstChild instanceof SVGElement) {
        this.spriteSVG = firstChild;
      }
    }
    if (this.spriteSVG != null && this.spriteSVG.parentNode !== shadowRoot) {
      shadowRoot.appendChild(this.spriteSVG);
    }
    return nextContainer;
  }

  private getOrCreatePreNode(container: HTMLElement): HTMLPreElement {
    const shadowRoot =
      container.shadowRoot ?? container.attachShadow({ mode: 'open' });
    // If we haven't created a pre element yet, lets go ahead and do that
    if (this.pre == null) {
      this.pre = document.createElement('pre');
      this.appliedPreAttributes = undefined;
      this.codeUnified = undefined;
      this.codeDeletions = undefined;
      this.codeAdditions = undefined;
      shadowRoot.appendChild(this.pre);
    }
    // If we have a new parent container for the pre element, lets go ahead and
    // move it into the new container
    else if (this.pre.parentNode !== shadowRoot) {
      this.editor?.__captureFocusForDOMReplacement();
      shadowRoot.appendChild(this.pre);
      this.appliedPreAttributes = undefined;
    }

    this.placeHolder?.remove();
    this.placeHolder = undefined;

    return this.pre;
  }

  protected syncCodeNodesFromPre(pre: HTMLPreElement): void {
    this.codeUnified = undefined;
    this.codeDeletions = undefined;
    this.codeAdditions = undefined;
    for (const child of pre.children) {
      if (!(child instanceof HTMLElement)) {
        continue;
      }
      if (child.hasAttribute('data-unified')) {
        this.codeUnified = child;
      } else if (child.hasAttribute('data-deletions')) {
        this.codeDeletions = child;
      } else if (child.hasAttribute('data-additions')) {
        this.codeAdditions = child;
      }
    }
  }

  private applyHeaderToDOM(
    headerAST: HASTElement,
    container: HTMLElement,
    fileDiff: FileDiffMetadata
  ): void {
    this.cleanupErrorWrapper();
    this.placeHolder?.remove();
    this.placeHolder = undefined;
    // Session metadata changes in place, so an HTML cache created from the
    // external diff cannot describe the current edit-session header.
    const {
      headerCache: {
        fileDiff: cachedHeaderDiff,
        html: cachedHeaderHTML,
        lastRenderedHTML,
      },
    } = this;
    const editSessionDiff = this.editSession?.diff;
    const reusableHeaderHTML =
      fileDiff !== editSessionDiff &&
      areDiffTargetsEqual(cachedHeaderDiff, fileDiff)
        ? cachedHeaderHTML
        : undefined;
    const headerHTML = reusableHeaderHTML ?? hastToHtml(headerAST);
    this.headerCache.html = headerHTML;
    this.headerCache.fileDiff = fileDiff;
    if (headerHTML !== lastRenderedHTML) {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = headerHTML;
      const newHeader = tempDiv.firstElementChild;
      if (!(newHeader instanceof HTMLElement)) {
        return;
      }
      if (this.headerElement != null) {
        container.shadowRoot?.replaceChild(newHeader, this.headerElement);
      } else {
        container.shadowRoot?.prepend(newHeader);
      }
      this.headerElement = newHeader;
      this.headerCache.lastRenderedHTML = headerHTML;
    }

    if (this.isContainerManaged) {
      return;
    }

    const {
      renderCustomHeader,
      renderHeaderPrefix,
      renderHeaderFilenameSuffix,
      renderHeaderMetadata,
    } = this.options;

    // Run every slot callback before touching the DOM; a custom header
    // replaces the prefix, suffix and metadata slots.
    let custom: HeaderSlotContent;
    let prefix: HeaderSlotContent;
    let suffix: HeaderSlotContent;
    let metadata: HeaderSlotContent;
    if (renderCustomHeader != null) {
      custom = renderCustomHeader(fileDiff);
    } else {
      prefix = renderHeaderPrefix?.(fileDiff);
      suffix = renderHeaderFilenameSuffix?.(fileDiff);
      metadata = renderHeaderMetadata?.(fileDiff);
    }
    this.headerCustom = this.upsertHeaderSlotElement(
      container,
      this.headerCustom,
      CUSTOM_HEADER_SLOT_ID,
      custom
    );
    this.headerPrefix = this.upsertHeaderSlotElement(
      container,
      this.headerPrefix,
      HEADER_PREFIX_SLOT_ID,
      prefix
    );
    this.headerFilenameSuffix = this.upsertHeaderSlotElement(
      container,
      this.headerFilenameSuffix,
      HEADER_FILENAME_SUFFIX_SLOT_ID,
      suffix
    );
    this.headerMetadata = this.upsertHeaderSlotElement(
      container,
      this.headerMetadata,
      HEADER_METADATA_SLOT_ID,
      metadata
    );
  }

  protected clearReusableHeader(): void {
    this.headerCache.html = undefined;
    this.headerCache.fileDiff = undefined;
  }

  private clearHeaderSlots(): void {
    this.headerPrefix?.remove();
    this.headerFilenameSuffix?.remove();
    this.headerMetadata?.remove();
    this.headerCustom?.remove();
    this.headerPrefix = undefined;
    this.headerFilenameSuffix = undefined;
    this.headerMetadata = undefined;
    this.headerCustom = undefined;
  }

  // Header slot callbacks are presence-based render hooks, not reactive views.
  private upsertHeaderSlotElement(
    container: HTMLElement,
    current: HTMLElement | undefined,
    slot: string,
    content: HeaderSlotContent
  ): HTMLElement | undefined {
    if (content == null) {
      current?.remove();
      return undefined;
    }
    let element = current;
    if (element == null) {
      element = document.createElement('div');
      element.slot = slot;
      container.appendChild(element);
    }
    element.replaceChildren();
    if (content instanceof Element) {
      element.appendChild(content);
    } else {
      element.innerText = `${content}`;
    }
    return element;
  }

  protected injectUnsafeCSS(): void {
    const { unsafeCSS } = this.options;
    this.pre?.toggleAttribute('data-custom-styles', Boolean(unsafeCSS));
    const shadowRoot = this.fileContainer?.shadowRoot;
    if (shadowRoot == null) {
      return;
    }

    if (unsafeCSS == null || unsafeCSS === '') {
      this.unsafeCSSStyle?.remove();
      this.unsafeCSSStyle = undefined;
      this.appliedUnsafeCSS = undefined;
      return;
    }

    if (
      this.unsafeCSSStyle?.parentNode === shadowRoot &&
      this.appliedUnsafeCSS === unsafeCSS
    ) {
      return;
    }

    // Create or update the style element
    this.unsafeCSSStyle ??= createUnsafeCSSStyleNode();
    if (this.unsafeCSSStyle.parentNode !== shadowRoot) {
      shadowRoot.appendChild(this.unsafeCSSStyle);
    }
    // Wrap in @layer unsafe to match SSR behavior
    this.unsafeCSSStyle.textContent = wrapUnsafeCSS(unsafeCSS);
    this.appliedUnsafeCSS = unsafeCSS;
  }

  private applyThemeState(
    container: HTMLElement,
    themeStyles: string,
    themeType: ThemeTypes,
    baseThemeType?: 'light' | 'dark'
  ): void {
    const shadowRoot =
      container.shadowRoot ?? container.attachShadow({ mode: 'open' });
    const effectiveThemeType = baseThemeType ?? themeType;
    const currentTheme = this.getTheme();
    const theme =
      typeof currentTheme === 'string' ? currentTheme : { ...currentTheme };
    const scrollbarGutter = getMeasuredScrollbarGutter(shadowRoot);
    if (
      this.themeCSSStyle?.parentNode === shadowRoot &&
      this.appliedThemeCSS?.themeStyles === themeStyles &&
      this.appliedThemeCSS.themeType === effectiveThemeType &&
      this.appliedThemeCSS.scrollbarGutter === scrollbarGutter
    ) {
      this.appliedThemeCSS.theme = theme;
      return;
    }
    // An adopted shell already carries matching theme CSS; only record it.
    if (
      this.hasAdoptedThemeCSS &&
      this.themeCSSStyle?.parentNode === shadowRoot
    ) {
      this.hasAdoptedThemeCSS = false;
    } else {
      this.themeCSSStyle = upsertHostThemeStyle({
        shadowRoot,
        currentNode: this.themeCSSStyle,
        themeCSS: wrapThemeCSS(
          themeStyles,
          effectiveThemeType,
          scrollbarGutter
        ),
      });
    }
    this.appliedThemeCSS =
      this.themeCSSStyle != null
        ? {
            theme,
            themeStyles,
            themeType: effectiveThemeType,
            baseThemeType,
            scrollbarGutter,
          }
        : undefined;
  }

  // A boolean check to ensure that edit mode in WebKit doesn't cause potential
  // scroll jumps to due bugs with WebKit. The workarounds have performance
  // implications so we avoid running the workarounds on browsers or scenarios
  // where they are not applicable
  protected shouldGuardRebuildScroll(): boolean {
    return this.editor != null && isSafari();
  }

  private replaceCodeColumns(
    pre: HTMLPreElement,
    result: HunksRenderResult
  ): void {
    const { overflow = 'scroll' } = this.options;
    const { rowCount } = result;
    const containerSize =
      (this.options.hunkSeparators ?? 'line-info') === 'line-info';
    const rowSpan = overflow === 'wrap' ? rowCount : undefined;
    this.cleanupErrorWrapper();
    this.applyPreNodeAttributes(pre, result);

    const codeElements: HTMLElement[] = [];
    // Renders a column AST into its code element. An existing gutter/content
    // pair is filled in place: in edit mode the content element is the
    // focused contenteditable, and replacing it ends the browser's editing
    // session (focus tears down and restores, and iOS answers every session
    // restart with an animated caret reveal).
    const applyColumn = (
      code: HTMLElement | undefined,
      columnType: 'unified' | 'deletions' | 'additions',
      ast: ElementContent[]
    ): HTMLElement => {
      const element = getOrCreateCodeNode({
        code,
        columnType,
        rowSpan,
        containerSize,
      });
      const columns = this.getColumnPair(element);
      const gutterChildren = getElementChildren(ast[0]);
      const contentChildren = getElementChildren(ast[1]);
      if (
        columns != null &&
        gutterChildren != null &&
        contentChildren != null
      ) {
        columns.gutter.innerHTML = hastToHtml(gutterChildren);
        columns.content.innerHTML = hastToHtml(contentChildren);
        if (rowCount !== this.lastRowCount) {
          this.applyRowSpan(columns, rowCount);
        }
      } else {
        element.innerHTML = this.hunksRenderer.renderPartialHTML(ast);
      }
      codeElements.push(element);
      return element;
    };

    let shouldReplace: boolean;
    const unifiedAST = this.hunksRenderer.renderCodeAST('unified', result);
    this.editor?.__captureFocusForDOMReplacement();
    if (unifiedAST != null) {
      shouldReplace =
        this.codeUnified == null ||
        this.codeAdditions != null ||
        this.codeDeletions != null;
      this.codeDeletions?.remove();
      this.codeDeletions = undefined;
      this.codeAdditions?.remove();
      this.codeAdditions = undefined;
      this.codeUnified = applyColumn(this.codeUnified, 'unified', unifiedAST);
    } else {
      const deletionsAST = this.hunksRenderer.renderCodeAST(
        'deletions',
        result
      );
      const additionsAST = this.hunksRenderer.renderCodeAST(
        'additions',
        result
      );
      shouldReplace =
        this.codeUnified != null ||
        (deletionsAST != null && this.codeDeletions == null) ||
        (additionsAST != null && this.codeAdditions == null);
      this.codeUnified?.remove();
      this.codeUnified = undefined;
      if (deletionsAST != null) {
        this.codeDeletions = applyColumn(
          this.codeDeletions,
          'deletions',
          deletionsAST
        );
      } else {
        this.codeDeletions?.remove();
        this.codeDeletions = undefined;
      }
      if (additionsAST != null) {
        this.codeAdditions = applyColumn(
          this.codeAdditions,
          'additions',
          additionsAST
        );
      } else {
        this.codeAdditions?.remove();
        this.codeAdditions = undefined;
      }
    }

    if (codeElements.length === 0) {
      pre.textContent = '';
    } else if (shouldReplace) {
      pre.replaceChildren(...codeElements);
    }

    this.lastRowCount = rowCount;
  }

  private applyPartialRender(
    fileDiff: FileDiffMetadata,
    previousRenderRange: RenderRange | undefined,
    renderRange: RenderRange | undefined
  ): boolean {
    const { lastRowCount } = this;
    if (
      this.pre == null ||
      // We must have a current and previous render range to do a partial render
      previousRenderRange == null ||
      renderRange == null ||
      // Neither render range may be infinite
      !Number.isFinite(previousRenderRange.totalLines) ||
      !Number.isFinite(renderRange.totalLines) ||
      lastRowCount == null
    ) {
      return false;
    }
    const columns = this.getCodeColumns();
    if (columns == null) {
      return false;
    }

    const previousStart = previousRenderRange.startingLine;
    const nextStart = renderRange.startingLine;
    const previousEnd = previousStart + previousRenderRange.totalLines;
    const nextEnd = nextStart + renderRange.totalLines;

    const overlapStart = Math.max(previousStart, nextStart);
    const overlapEnd = Math.min(previousEnd, nextEnd);
    if (overlapEnd <= overlapStart) {
      return false;
    }

    // Trim the rows outside the overlap from both ends of every column.
    const preTrimCount = overlapStart - previousStart;
    const postTrimStart =
      previousEnd > overlapEnd ? overlapEnd - previousStart : -1;
    let trimmedRows: number | undefined;
    if (preTrimCount > 0 || postTrimStart >= 0) {
      for (const [, column] of columns) {
        if (column == null) {
          continue;
        }
        const removedRows = this.trimColumnRows(
          column,
          preTrimCount,
          postTrimStart
        );
        if (trimmedRows != null && trimmedRows !== removedRows) {
          throw new Error('FileDiff.trimColumns: split columns out of sync');
        }
        trimmedRows = removedRows;
      }
    }

    let rowCount = lastRowCount - (trimmedRows ?? 0);
    if (rowCount < 0) {
      throw new Error(
        'FileDiff.applyPartialRender: trimmed beyond DOM row count'
      );
    }

    const renderChunk = (
      startingLine: number,
      totalLines: number
    ): HunksRenderResult | undefined =>
      totalLines > 0
        ? this.hunksRenderer.renderDiff(fileDiff, {
            startingLine,
            totalLines,
            bufferBefore: 0,
            bufferAfter: 0,
          })
        : undefined;

    const prependResult = renderChunk(nextStart, overlapStart - nextStart);
    if (prependResult == null && nextStart < overlapStart) {
      return false;
    }

    const appendResult = renderChunk(overlapEnd, nextEnd - overlapEnd);
    if (appendResult == null && nextEnd > overlapEnd) {
      return false;
    }

    const applyChunk = (
      result: HunksRenderResult | undefined,
      insertPosition: 'afterbegin' | 'beforeend'
    ) => {
      if (result == null) {
        return;
      }
      for (const [columnType, column] of columns) {
        this.renderPartialColumn(
          column,
          this.hunksRenderer.renderCodeAST(columnType, result),
          insertPosition
        );
      }
      rowCount += result.rowCount;
      this.renderedDiff = result.fileDiff;
    };

    this.cleanupErrorWrapper();
    applyChunk(prependResult, 'afterbegin');
    applyChunk(appendResult, 'beforeend');

    if (lastRowCount !== rowCount) {
      for (const [, column] of columns) {
        this.applyRowSpan(column, rowCount);
      }
      this.lastRowCount = rowCount;
    }

    return true;
  }

  private renderPartialColumn(
    column: ColumnElements | undefined,
    ast: ElementContent[] | undefined,
    insertPosition: 'afterbegin' | 'beforeend'
  ) {
    if (column == null || ast == null) {
      return;
    }
    const gutterChildren = getElementChildren(ast[0]);
    const contentChildren = getElementChildren(ast[1]);
    if (gutterChildren == null || contentChildren == null) {
      throw new Error('FileDiff.insertPartialHTML: Unexpected AST structure');
    }
    // A chunk that starts (or ends) with a buffer row next to the existing
    // edge buffer row grows that row instead of inserting another one.
    const append = insertPosition === 'beforeend';
    const edgeHASTElement = contentChildren.at(append ? 0 : -1);
    if (
      edgeHASTElement?.type === 'element' &&
      typeof edgeHASTElement.properties['data-buffer-size'] === 'number'
    ) {
      const contentElement = append
        ? column.content.lastElementChild
        : column.content.firstElementChild;
      const gutterElement = append
        ? column.gutter.lastElementChild
        : column.gutter.firstElementChild;
      if (
        contentElement instanceof HTMLElement &&
        gutterElement instanceof HTMLElement
      ) {
        const currentSize = this.getBufferSize(contentElement.dataset);
        if (currentSize != null) {
          if (append) {
            gutterChildren.shift();
            contentChildren.shift();
          } else {
            gutterChildren.pop();
            contentChildren.pop();
          }
          const size =
            currentSize + edgeHASTElement.properties['data-buffer-size'];
          this.updateBufferSize(contentElement, size);
          this.updateBufferSize(gutterElement, size);
        }
      }
    }

    column.gutter.insertAdjacentHTML(
      insertPosition,
      this.hunksRenderer.renderPartialHTML(gutterChildren)
    );
    column.content.insertAdjacentHTML(
      insertPosition,
      this.hunksRenderer.renderPartialHTML(contentChildren)
    );
  }

  private applyRowSpan(
    column: ColumnElements | undefined,
    rowCount: number
  ): void {
    column?.gutter.style.setProperty('grid-row', `span ${rowCount}`);
    column?.content.style.setProperty('grid-row', `span ${rowCount}`);
  }

  private trimColumnRows(
    columns: ColumnElements,
    preTrimCount: number,
    postTrimStart: number
  ): number {
    let visibleLineIndex = 0;
    let rowCount = 0;
    let rowIndex = 0;
    let pendingMetadataTrim = false;
    const hasPostTrim = postTrimStart >= 0;

    const contentChildren = Array.from(columns.content.children);
    const gutterChildren = Array.from(columns.gutter.children);
    if (contentChildren.length !== gutterChildren.length) {
      throw new Error('FileDiff.trimColumnRows: columns do not match');
    }

    while (rowIndex < contentChildren.length) {
      if (preTrimCount <= 0 && !hasPostTrim && !pendingMetadataTrim) {
        break;
      }
      const gutterElement = gutterChildren[rowIndex];
      const contentElement = contentChildren[rowIndex];
      rowIndex++;

      if (
        !(gutterElement instanceof HTMLElement) ||
        !(contentElement instanceof HTMLElement)
      ) {
        console.error({ gutterElement, contentElement });
        throw new Error('FileDiff.trimColumnRows: invalid row elements');
      }

      if (pendingMetadataTrim) {
        pendingMetadataTrim = false;
        if (
          (gutterElement.dataset.gutterBuffer === 'annotation' &&
            'lineAnnotation' in contentElement.dataset) ||
          (gutterElement.dataset.gutterBuffer === 'metadata' &&
            'noNewline' in contentElement.dataset)
        ) {
          gutterElement.remove();
          contentElement.remove();
          rowCount++;
          continue;
        }
      }

      // Line rows count towards line indices; separators, annotations and
      // noNewline metadata rows are trimmed alongside them but do not.
      const isLine =
        'lineIndex' in gutterElement.dataset &&
        'lineIndex' in contentElement.dataset;
      if (
        isLine ||
        ('separator' in gutterElement.dataset &&
          'separator' in contentElement.dataset) ||
        (gutterElement.dataset.gutterBuffer === 'annotation' &&
          'lineAnnotation' in contentElement.dataset) ||
        (gutterElement.dataset.gutterBuffer === 'metadata' &&
          'noNewline' in contentElement.dataset)
      ) {
        if (
          preTrimCount > 0 ||
          (hasPostTrim && visibleLineIndex >= postTrimStart)
        ) {
          gutterElement.remove();
          contentElement.remove();
          rowCount++;
          if (isLine && preTrimCount > 0) {
            preTrimCount--;
            pendingMetadataTrim = preTrimCount === 0;
          }
        }
        if (isLine) {
          visibleLineIndex++;
        }
        continue;
      }

      if (
        gutterElement.dataset.gutterBuffer === 'buffer' &&
        'contentBuffer' in contentElement.dataset
      ) {
        const totalRows = this.getBufferSize(contentElement.dataset);
        if (totalRows == null) {
          throw new Error('FileDiff.trimColumnRows: invalid element');
        }
        // Buffers are never empty, so they shrink until fully trimmed.
        let rowsToRemove = 0;
        if (preTrimCount > 0) {
          rowsToRemove = Math.min(preTrimCount, totalRows);
          preTrimCount -= rowsToRemove;
          pendingMetadataTrim =
            preTrimCount === 0 && rowsToRemove === totalRows;
        }
        // If we are in a post clip era...
        else if (hasPostTrim) {
          rowsToRemove = Math.min(
            Math.max(visibleLineIndex + totalRows - postTrimStart, 0),
            totalRows
          );
        }
        if (rowsToRemove >= totalRows) {
          gutterElement.remove();
          contentElement.remove();
        } else if (rowsToRemove > 0) {
          this.updateBufferSize(gutterElement, totalRows - rowsToRemove);
          this.updateBufferSize(contentElement, totalRows - rowsToRemove);
        }
        rowCount += rowsToRemove;
        visibleLineIndex += totalRows;
        continue;
      }

      console.error({ gutterElement, contentElement });
      throw new Error('FileDiff.trimColumnRows: unknown row elements');
    }

    return rowCount;
  }

  private getBufferSize(properties: DOMStringMap): number | undefined {
    const parsed = Number.parseInt(properties.bufferSize ?? '', 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  private updateBufferSize(element: HTMLElement, size: number): void {
    element.dataset.bufferSize = `${size}`;
    element.style.setProperty('grid-row', `span ${size}`);
    element.style.setProperty('min-height', `calc(${size} * 1lh)`);
  }

  private getColumnPair(
    code: HTMLElement | undefined
  ): ColumnElements | undefined {
    if (code == null) {
      return undefined;
    }
    const gutter = code.children[0];
    const content = code.children[1];
    if (
      !(gutter instanceof HTMLElement) ||
      !(content instanceof HTMLElement) ||
      gutter.dataset.gutter == null ||
      content.dataset.content == null
    ) {
      return undefined;
    }
    return { gutter, content };
  }

  // The rendered gutter/content pair of each code column for the current
  // diff style, or undefined when none exist.
  private getCodeColumns(): CodeColumn[] | undefined {
    const columns: CodeColumn[] =
      this.options.diffStyle === 'unified'
        ? [['unified', this.getColumnPair(this.codeUnified)]]
        : [
            ['deletions', this.getColumnPair(this.codeDeletions)],
            ['additions', this.getColumnPair(this.codeAdditions)],
          ];
    return columns.some(([, column]) => column != null) ? columns : undefined;
  }

  protected updateBuffers(renderRange: RenderRange): void {
    if (this.pre != null) {
      this.applyBuffers(this.pre, renderRange);
    }
  }

  private applyBuffers(
    pre: HTMLPreElement,
    renderRange: RenderRange | undefined
  ) {
    const enabled =
      renderRange != null && !this.shouldDisableVirtualizationBuffers();
    // NOTE(amadeus): A very hacky pass at buffers outside the pre elements...
    // i may need to improve this...
    const applyBuffer = (
      buffer: HTMLElement | undefined,
      side: 'before' | 'after',
      height: number
    ): HTMLElement | undefined => {
      if (enabled && height > 0) {
        if (buffer == null) {
          buffer = document.createElement('div');
          buffer.dataset.virtualizerBuffer = side;
          if (side === 'before') {
            pre.before(buffer);
          } else {
            pre.after(buffer);
          }
        }
        buffer.style.setProperty('height', `${height}px`);
        buffer.style.setProperty('contain', 'strict');
        return buffer;
      }
      buffer?.remove();
      return undefined;
    };
    this.bufferBefore = applyBuffer(
      this.bufferBefore,
      'before',
      renderRange?.bufferBefore ?? 0
    );
    this.bufferAfter = applyBuffer(
      this.bufferAfter,
      'after',
      renderRange?.bufferAfter ?? 0
    );
  }

  protected shouldDisableVirtualizationBuffers(): boolean {
    return this.options.disableVirtualizationBuffers ?? false;
  }

  protected applyPreNodeAttributes(
    pre: HTMLPreElement,
    { additionsContentAST, deletionsContentAST, totalLines }: HunksRenderResult,
    customProperties?: CustomPreProperties
  ): void {
    const {
      diffIndicators = 'bars',
      disableBackground = false,
      disableLineNumbers = false,
      overflow = 'scroll',
      diffStyle = 'split',
    } = this.options;
    const preProperties: PrePropertiesConfig = {
      type: 'diff',
      diffIndicators,
      disableBackground,
      disableLineNumbers,
      overflow,
      split:
        diffStyle === 'unified'
          ? false
          : additionsContentAST != null && deletionsContentAST != null,
      totalLines,
      customProperties,
    };
    if (arePrePropertiesEqual(preProperties, this.appliedPreAttributes)) {
      return;
    }
    setPreNodeProperties(pre, preProperties);
    this.appliedPreAttributes = preProperties;
  }

  private handleRenderError(
    error: unknown,
    container: HTMLElement,
    disableErrorHandling: boolean
  ) {
    if (disableErrorHandling) {
      throw error;
    }
    console.error(error);
    if (!(error instanceof Error)) {
      return;
    }
    this.cleanupErrorWrapper();
    this.pre?.remove();
    this.pre = undefined;
    this.appliedPreAttributes = undefined;
    const shadowRoot =
      container.shadowRoot ?? container.attachShadow({ mode: 'open' });
    this.errorWrapper ??= document.createElement('div');
    this.errorWrapper.dataset.errorWrapper = '';
    this.errorWrapper.textContent = '';
    shadowRoot.appendChild(this.errorWrapper);
    const errorMessage = document.createElement('div');
    errorMessage.dataset.errorMessage = '';
    errorMessage.innerText = error.message;
    this.errorWrapper.appendChild(errorMessage);
    const errorStack = document.createElement('pre');
    errorStack.dataset.errorStack = '';
    errorStack.innerText = error.stack ?? 'No Error Stack';
    this.errorWrapper.appendChild(errorStack);
  }

  private cleanupErrorWrapper() {
    this.errorWrapper?.remove();
    this.errorWrapper = undefined;
  }
}

function areOptionalFilesEqual(
  fileA: FileContents | null | undefined,
  fileB: FileContents | null | undefined
): boolean {
  if (fileA == null || fileB == null) {
    return fileA == null && fileB == null;
  }
  return areFilesEqual(fileA, fileB);
}

function getElementChildren(
  node: ElementContent | undefined
): ElementContent[] | undefined {
  if (node == null || node.type !== 'element') {
    return undefined;
  }
  return node.children ?? [];
}
