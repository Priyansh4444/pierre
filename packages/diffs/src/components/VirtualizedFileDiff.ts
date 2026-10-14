import { DEFAULT_COLLAPSED_CONTEXT_THRESHOLD } from '../constants';
import type { TextDocument } from '../editor/textDocument';
import type {
  BaseDiffOptions,
  DiffLineAnnotation,
  ExpansionDirections,
  FileContents,
  FileDiffMetadata,
  Hunk,
  HunkSeparators,
  NumericScrollLineAnchor,
  PendingCodeViewLayoutReset,
  RenderRange,
  RenderWindow,
  SelectionSide,
  StickySpecs,
  ThemeTypes,
  VirtualFileMetrics,
} from '../types';
import { areDiffTargetsEqual } from '../utils/areDiffTargetsEqual';
import { areFilesEqual } from '../utils/areFilesEqual';
import { areObjectsEqual } from '../utils/areObjectsEqual';
import { areOptionsEqual } from '../utils/areOptionsEqual';
import { awaitWithTimeout } from '../utils/awaitWithTimeout';
import { computeEstimatedDiffHeights } from '../utils/computeEstimatedDiffHeights';
import {
  computeVirtualFileMetrics,
  getVirtualFileHeaderHeight,
  getVirtualFileHeaderRegion,
  getVirtualFilePaddingBottom,
} from '../utils/computeVirtualFileMetrics';
import { getDiffFileInput } from '../utils/getDiffFileInput';
import { hydratePartialDiff } from '../utils/hydratePartialDiff';
import {
  FILE_ANNOTATION_DOM_KEY,
  FILE_ANNOTATION_LINE_NUMBER,
  shouldRenderFileAnnotations,
} from '../utils/includesFileAnnotations';
import { iterateOverDiff } from '../utils/iterateOverDiff';
import { parseDiffFromFile } from '../utils/parseDiffFromFile';
import {
  getExpandedRegion,
  getLeadingHunkSeparatorLayout,
  getTrailingExpandedRegion,
  getTrailingHunkSeparatorLayout,
  isAdditionLineRenderable,
} from '../utils/virtualDiffLayout';
import type { WorkerPoolManager } from '../worker';
import type { CodeView } from './CodeView';
import {
  FileDiff,
  type FileDiffOptions,
  type FileDiffRenderProps,
} from './FileDiff';
import type { Virtualizer } from './Virtualizer';

type LoadedPartialDiffContents = Awaited<
  ReturnType<NonNullable<BaseDiffOptions['loadDiffFiles']>>
>;

interface DiffLayoutCheckpoint {
  renderedLineIndex: number;
  lineIndex: number;
  top: number;
}

interface DiffLayoutCache {
  // Sparse map: view-specific line index -> measured height delta from the
  // baseline line height. Only stores lines that differ from the estimate.
  heightDeltas: Map<number, number>;
  // Aggregate delta from estimated height, including source row deltas and the
  // zero-baseline file annotation row height.
  measuredHeightDeltaTotal: number;
  // Baseline estimated heights for the active diff content. These are preserved
  // across style/collapse toggles and cleared only when estimate inputs change.
  estimatedSplitHeight: number | undefined;
  estimatedUnifiedHeight: number | undefined;
  // Sparse measured positions used to resume deep geometry scans near a target
  // diff line, rendered row, or scroll offset instead of replaying layout from
  // the first hunk.
  checkpoints: DiffLayoutCheckpoint[];
  // Total renderable diff rows for the current diff style and expansion state.
  totalLines: number;
  // Measured height for the file annotation row. Starts at 0 so
  // unmeasured annotations behave like all other unmeasured annotations.
  fileAnnotationHeight: number;
  // Ghost text rows folded into `heightDeltas`. `ghostTextRows` is the editor's
  // own map (zero-based new-file line -> rows), replaced rather than mutated, so
  // identity alone says whether anything changed. `ghostTextRowsByIndex` is the
  // same data keyed by this view's row index, which the deltas use.
  ghostTextRows: ReadonlyMap<number, number>;
  ghostTextRowsByIndex: Map<number, number>;
}

interface PendingLoadedDiff {
  expectedDiff: FileDiffMetadata;
  nextDiff: FileDiffMetadata;
  files: LoadedPartialDiffContents;
}

type PendingExpansion = [
  hunkIndex: number,
  direction: ExpansionDirections,
  expansionLineCountOverride: number | undefined,
];

interface PendingRender {
  latestDiff: FileDiffMetadata;
  diff: FileDiffMetadata;
}

export const VIRTUALIZED_FILE_DIFF_LAYOUT_CHECKPOINT_INTERVAL = 3_000;
const NO_GHOST_TEXT_ROWS: ReadonlyMap<number, number> = new Map();

let instanceId = -1;

export class VirtualizedFileDiff<
  LAnnotation = undefined,
  Caret = undefined,
> extends FileDiff<LAnnotation, Caret> {
  override readonly __id: string = `little-virtualized-file-diff:${++instanceId}`;
  public readonly renderType = 'virtualized';

  public top: number | undefined;
  public height: number = 0;
  private metrics: VirtualFileMetrics;
  private cache: DiffLayoutCache = {
    heightDeltas: new Map(),
    measuredHeightDeltaTotal: 0,
    estimatedSplitHeight: undefined,
    estimatedUnifiedHeight: undefined,
    checkpoints: [],
    totalLines: 0,
    fileAnnotationHeight: 0,
    ghostTextRows: NO_GHOST_TEXT_ROWS,
    ghostTextRowsByIndex: new Map(),
  };
  private isVisible: boolean = false;
  private isSetup: boolean = false;
  private virtualizer: Virtualizer | CodeView<LAnnotation, Caret>;
  private layoutDirty = true;
  private forceRenderOverride: true | undefined;
  private currentCollapsed: boolean | undefined;
  private pendingHydratedDiff: PendingLoadedDiff | undefined;
  private pendingExpansions: PendingExpansion[] | undefined;
  // Remember which diff the layout was calculated from, even when only a
  // placeholder is rendered. Async highlighting clears this through rerender()
  // so layout can use the newly available content. CodeView updates it during
  // its layout pass.
  private pendingRender: PendingRender | undefined;

  constructor(
    options: FileDiffOptions<LAnnotation, Caret> | undefined,
    virtualizer: Virtualizer | CodeView<LAnnotation, Caret>,
    metrics?: Partial<VirtualFileMetrics>,
    workerManager?: WorkerPoolManager,
    isContainerManaged = false
  ) {
    super(options, workerManager, isContainerManaged);
    this.virtualizer = virtualizer;
    this.metrics = computeVirtualFileMetrics(metrics);
  }

  public setMetrics(
    metrics?: Partial<VirtualFileMetrics>,
    force = false
  ): void {
    const nextMetrics = computeVirtualFileMetrics(metrics);
    if (!force && areObjectsEqual(this.metrics, nextMetrics)) {
      return;
    }

    this.metrics = nextMetrics;
    this.resetLayoutCache(true);
  }

  override setLineAnnotations(
    lineAnnotations: DiffLineAnnotation<LAnnotation>[]
  ): void {
    if (this.syncLineAnnotations(lineAnnotations)) {
      this.forceRenderOverride = true;
    }
  }

  // Keep measured row heights as estimates when annotations change; rendering
  // will replace them with the updated heights without discarding other rows.
  private syncLineAnnotations(
    lineAnnotations: DiffLineAnnotation<LAnnotation>[] | undefined
  ): boolean {
    if (
      lineAnnotations == null ||
      !this.isNewAnnotations(lineAnnotations) ||
      (lineAnnotations.length === 0 && this.getLatestAnnotations().length === 0)
    ) {
      return false;
    }
    super.setLineAnnotations(lineAnnotations);
    return true;
  }

  protected override syncEditSessionAnnotationsFromEditor(
    lineAnnotations: DiffLineAnnotation<LAnnotation>[]
  ): boolean {
    const synced = super.syncEditSessionAnnotationsFromEditor(lineAnnotations);
    if (synced) {
      this.forceRenderOverride = true;
    }
    return synced;
  }

  // Get the height for a line, using cached value if available.
  // If not cached and hasMetadataLine is true, adds lineHeight for the metadata.
  private getLineHeight(lineIndex: number, hasMetadataLine = false): number {
    return (
      this.metrics.lineHeight * (hasMetadataLine ? 2 : 1) +
      (this.cache.heightDeltas.get(lineIndex) ?? 0)
    );
  }

  override setOptions(
    options: FileDiffOptions<LAnnotation, Caret> | undefined
  ): void {
    if (this.isAdvancedMode()) {
      throw new Error(
        'VirtualizedFileDiff.setOptions cannot be used inside CodeView. Update CodeView options instead.'
      );
    }

    if (options == null) return;
    const { options: previousOptions } = this;
    const optionsChanged = !areOptionsEqual(previousOptions, options);
    // Options that feed the estimated diff heights; they are a subset of the
    // options that change layout.
    const estimateChanged =
      optionsChanged &&
      ((previousOptions.disableFileHeader ?? false) !==
        (options.disableFileHeader ?? false) ||
        (previousOptions.hunkSeparators ?? 'line-info') !==
          (options.hunkSeparators ?? 'line-info') ||
        Boolean(previousOptions.loadDiffFiles) !==
          Boolean(options.loadDiffFiles) ||
        (previousOptions.expandUnchanged ?? false) !==
          (options.expandUnchanged ?? false) ||
        (previousOptions.collapsedContextThreshold ??
          DEFAULT_COLLAPSED_CONTEXT_THRESHOLD) !==
          (options.collapsedContextThreshold ??
            DEFAULT_COLLAPSED_CONTEXT_THRESHOLD));
    const layoutChanged =
      estimateChanged ||
      (optionsChanged &&
        ((previousOptions.diffStyle ?? 'split') !==
          (options.diffStyle ?? 'split') ||
          (previousOptions.overflow ?? 'scroll') !==
            (options.overflow ?? 'scroll') ||
          (previousOptions.collapsed ?? false) !==
            (options.collapsed ?? false) ||
          (previousOptions.disableLineNumbers ?? false) !==
            (options.disableLineNumbers ?? false) ||
          (previousOptions.diffIndicators ?? 'bars') !==
            (options.diffIndicators ?? 'bars') ||
          previousOptions.unsafeCSS !== options.unsafeCSS));

    super.setOptions(options);

    // Only simple mode gets here (CodeView threw above), so recompute now.
    if (layoutChanged) {
      this.resetLayoutCache(estimateChanged);
      this.computeApproximateSize();
    }
    // Any option can affect rendered DOM; only layout-affecting options clear
    // the measured height cache above.
    if (optionsChanged) {
      this.forceRenderOverride = true;
      this.virtualizer.instanceChanged(this, layoutChanged);
    }
  }

  override setThemeType(themeType: ThemeTypes): void {
    if (this.isAdvancedMode()) {
      throw new Error(
        'VirtualizedFileDiff.setThemeType cannot be used inside CodeView. Update CodeView options instead.'
      );
    }

    super.setThemeType(themeType);
  }

  // Drop measured heights (and ghost rows) on top of the derived layout.
  private resetLayoutCache(
    includeEstimatedHeights = false,
    resetRenderRange = true
  ): void {
    const { cache } = this;
    cache.fileAnnotationHeight = 0;
    cache.heightDeltas.clear();
    cache.measuredHeightDeltaTotal = 0;
    cache.ghostTextRows = NO_GHOST_TEXT_ROWS;
    cache.ghostTextRowsByIndex.clear();
    this.invalidateDerivedLayoutCache(
      includeEstimatedHeights,
      resetRenderRange
    );
  }

  private invalidateDerivedLayoutCache(
    includeEstimatedHeights: boolean,
    resetRenderRange = true
  ): void {
    const { cache } = this;
    this.layoutDirty = true;
    cache.checkpoints.length = 0;
    cache.totalLines = 0;
    if (includeEstimatedHeights) {
      cache.estimatedSplitHeight = undefined;
      cache.estimatedUnifiedHeight = undefined;
    }
    if (resetRenderRange) {
      this.renderRange = undefined;
    }
  }

  // Fold the ghost text rows the editor is showing below lines into the height
  // deltas. Ghost text sits in a margin below the row, which measuring never
  // includes, so the rows are added here on top of the row's own height, and
  // removed again when the ghost text changes or goes away, even for rows that
  // are not rendered right now. The editor keys by new-file line; the deltas
  // are keyed by this view's row index, so lines are translated the same way
  // getLinePosition does. The editor only reports lines that have a rendered
  // row (it draws a prediction all or nothing); the translation is undefined
  // only for a diff without hunks.
  private applyGhostTextRows(
    fileDiff: FileDiffMetadata,
    ghostTextRows: ReadonlyMap<number, number>
  ): boolean {
    const {
      cache,
      metrics: { lineHeight },
    } = this;
    const {
      heightDeltas,
      ghostTextRows: folded,
      ghostTextRowsByIndex: previous,
    } = cache;
    if (folded === ghostTextRows) {
      return false;
    }
    const diffStyle = this.getDiffStyle();
    const next = new Map<number, number>();
    for (const [line, rows] of ghostTextRows) {
      const indexes = this.getLineIndexForDiff(fileDiff, line + 1, 'additions');
      if (indexes == null) {
        continue;
      }
      next.set(indexes[diffStyle === 'split' ? 1 : 0], rows);
    }
    let changed = false;
    for (const rowIndex of new Set([...previous.keys(), ...next.keys()])) {
      const delta =
        ((next.get(rowIndex) ?? 0) - (previous.get(rowIndex) ?? 0)) *
        lineHeight;
      if (delta === 0) {
        continue;
      }
      const nextDelta = (heightDeltas.get(rowIndex) ?? 0) + delta;
      if (nextDelta === 0) {
        heightDeltas.delete(rowIndex);
      } else {
        heightDeltas.set(rowIndex, nextDelta);
      }
      cache.measuredHeightDeltaTotal += delta;
      changed = true;
    }
    cache.ghostTextRows = ghostTextRows;
    cache.ghostTextRowsByIndex = next;
    return changed;
  }

  // Measure rendered lines and update height cache.
  // Called after render to reconcile estimated vs actual heights.
  // Definitely need to optimize this in cases where there aren't any custom
  // line heights or in cases of extremely large files...
  public reconcileHeights(): boolean {
    const {
      cache,
      options: { overflow = 'scroll' },
      metrics: { lineHeight },
    } = this;
    // A placeholder may have a prepared layout before any content has
    // rendered.
    const fileDiff =
      this.placeHolder != null ? this.getLayoutDiff() : this.getRenderedDiff();
    if (this.fileContainer == null || fileDiff == null) {
      const hadHeight = this.height !== 0;
      this.height = 0;
      return hadHeight;
    }
    this.top = this.getVirtualizedTop();
    let hasHeightChange = this.applyGhostTextRows(
      fileDiff,
      this.editor?.__getGhostTextRows() ?? NO_GHOST_TEXT_ROWS
    );
    // Folding replaces the row-index map; measure against the newly folded
    // counts so reconciliation does not overwrite their height contribution.
    const { ghostTextRowsByIndex, heightDeltas } = cache;
    const measureAllRows =
      overflow !== 'scroll' ||
      this.getLatestAnnotations().length > 0 ||
      this.isResizeDebuggingEnabled();
    // Ghost-row changes affect placeholders too, but placeholders have no DOM
    // rows to measure. After the last annotation is removed, keep measuring
    // rendered rows until their previously cached heights have been corrected.
    if (
      this.placeHolder != null ||
      (!measureAllRows &&
        heightDeltas.size === 0 &&
        cache.fileAnnotationHeight === 0)
    ) {
      if (hasHeightChange) {
        this.computeApproximateSize(true);
        this.setPlaceholderHeight(this.height);
      }
      return hasHeightChange;
    }
    const diffStyle = this.getDiffStyle();
    const codeGroups =
      diffStyle === 'split'
        ? [this.codeDeletions, this.codeAdditions]
        : [this.codeUnified];

    // Keep offscreen file annotation measurements consistent with the buffers
    // computed for this render. A rendered top row can confirm their removal.
    if (
      this.renderRange != null &&
      shouldRenderFileAnnotations(this.renderRange)
    ) {
      let fileAnnotationHeight = 0;
      for (const codeGroup of codeGroups) {
        const content = codeGroup?.children[1];
        if (!(content instanceof HTMLElement)) continue;
        for (const child of content.children) {
          if (
            child instanceof HTMLElement &&
            child.dataset.lineAnnotation === FILE_ANNOTATION_DOM_KEY
          ) {
            fileAnnotationHeight = Math.max(
              fileAnnotationHeight,
              child.getBoundingClientRect().height
            );
          }
        }
      }
      const previousHeight = cache.fileAnnotationHeight;
      if (fileAnnotationHeight !== previousHeight) {
        cache.fileAnnotationHeight = fileAnnotationHeight;
        cache.measuredHeightDeltaTotal += fileAnnotationHeight - previousHeight;
        hasHeightChange = true;
      }
    }

    for (const codeGroup of codeGroups) {
      const content = codeGroup?.children[1];
      if (!(content instanceof HTMLElement)) continue;
      // The ghost prediction margin sits on the additions row. When the two
      // split columns share one grid, the deletions row stretches to that
      // taller track, so measuring it would count the rows twice; the
      // additions row is authoritative for a row pair with ghost text.
      const skipsGhostRows =
        diffStyle === 'split' && codeGroup === this.codeDeletions;
      for (const line of content.children) {
        if (!(line instanceof HTMLElement)) continue;

        // `data-line-index` is "unifiedIndex,splitIndex".
        const lineIndexAttr = line.dataset.lineIndex;
        if (lineIndexAttr == null) continue;
        const lineIndex = Number(
          lineIndexAttr.split(',')[diffStyle === 'split' ? 1 : 0]
        );

        const ghostRows = ghostTextRowsByIndex.get(lineIndex) ?? 0;
        if (skipsGhostRows && ghostRows > 0) continue;
        const previousDelta = heightDeltas.get(lineIndex) ?? 0;
        // With no annotations or wrapping, only stale custom measurements need
        // DOM reads. Ghost rows already have known heights from the editor.
        if (!measureAllRows && previousDelta === ghostRows * lineHeight) {
          continue;
        }
        let measuredHeight =
          line.getBoundingClientRect().height + ghostRows * lineHeight;
        // Annotations or noNewline metadata increase the size of the their
        // attached line
        const sibling = line.nextElementSibling;
        const hasMetadata =
          sibling instanceof HTMLElement && 'noNewline' in sibling.dataset;
        if (
          hasMetadata ||
          (sibling instanceof HTMLElement &&
            'lineAnnotation' in sibling.dataset)
        ) {
          measuredHeight += sibling.getBoundingClientRect().height;
        }
        const nextDelta = measuredHeight - lineHeight * (hasMetadata ? 2 : 1);

        if (nextDelta === previousDelta) {
          continue;
        }

        hasHeightChange = true;
        cache.measuredHeightDeltaTotal += nextDelta - previousDelta;
        if (nextDelta === 0) {
          heightDeltas.delete(lineIndex);
        } else {
          heightDeltas.set(lineIndex, nextDelta);
        }
      }
    }

    if (hasHeightChange || this.isResizeDebuggingEnabled()) {
      this.computeApproximateSize(true);
    }
    return hasHeightChange;
  }

  public onRender = (dirty: boolean): boolean => {
    if (this.fileContainer == null) {
      return false;
    }
    if (dirty) {
      this.top = this.getVirtualizedTop();
    }
    return this.render();
  };

  // Virtualized renders bypass FileDiff's queued render handler. Apply line
  // state deferred during the refresh once managers target the rebuilt rows.
  public override flushManagers(): void {
    super.flushManagers();
    if (this.lineStateRefreshPending) {
      this.flushDeferredLineState();
    }
  }

  // CodeView positions every item before updating the DOM. Recalculate this
  // item's layout whenever its content or position changes.
  public updateCodeViewLayout(
    fileDiff: FileDiffMetadata,
    top: number,
    reset?: PendingCodeViewLayoutReset,
    lineAnnotations?: DiffLineAnnotation<LAnnotation>[]
  ): number {
    let resetLayoutCache = false;
    let resetEstimatedHeights = false;
    const {
      pendingExpansions,
      pendingHydratedDiff,
      options: { collapsed = false },
    } = this;

    // Hydrate the `isPartial: true` diff if we have a pending hydration
    if (pendingHydratedDiff != null) {
      this.pendingHydratedDiff = undefined;
      if (pendingHydratedDiff.expectedDiff === fileDiff) {
        // We intentionally keep diff equality referential,
        // and treat it as a mutation
        Object.assign(fileDiff, pendingHydratedDiff.nextDiff);
        this.setHydratedState(pendingHydratedDiff.files);
        this.installHydratedSessionDiff(fileDiff);
        this.forceRenderOverride = true;
        resetLayoutCache = true;
        resetEstimatedHeights = true;
      }
    }

    // Go ahead and apply any queued expansion changes (the queue is never
    // empty while it exists)
    if (pendingExpansions != null) {
      this.pendingExpansions = undefined;
      for (const expansion of pendingExpansions) {
        this.hunksRenderer.expandHunk(...expansion);
      }
      this.forceRenderOverride = true;
      resetEstimatedHeights = true;
    }

    const diffChanged = this.updateExternalDiff(fileDiff, lineAnnotations);
    const {
      pendingRenderDiff,
      layoutDiffChanged,
      renderedDiffChanged,
      annotationsChanged,
    } = this.updatePendingRender(fileDiff, lineAnnotations);
    if (diffChanged || renderedDiffChanged || annotationsChanged) {
      this.forceRenderOverride = true;
    }

    if (layoutDiffChanged) {
      resetLayoutCache = true;
      resetEstimatedHeights = true;
    }
    if (reset?.resetDiffLayoutCache === true) {
      resetLayoutCache = true;
      if (reset.includeEstimatedDiffHeights) {
        resetEstimatedHeights = true;
      }
    }
    if (reset?.metrics != null) {
      this.metrics = computeVirtualFileMetrics(reset.metrics);
      resetLayoutCache = true;
      resetEstimatedHeights = true;
    }
    if (this.currentCollapsed !== collapsed) {
      this.currentCollapsed = collapsed;
      resetLayoutCache = true;
    }
    if (resetLayoutCache) {
      this.resetLayoutCache(resetEstimatedHeights);
    } else if (resetEstimatedHeights) {
      this.invalidateDerivedLayoutCache(true);
    }

    this.top = top;
    this.computeApproximateSize(false, pendingRenderDiff);
    return this.height;
  }

  public getLinePosition(
    lineNumber: number,
    side: SelectionSide = 'additions'
  ): { top: number; height: number } | undefined {
    const fileDiff = this.getLayoutDiff();
    if (fileDiff == null || lineNumber < 1) {
      return undefined;
    }

    const targetLineIndexes = this.getLineIndexForDiff(
      fileDiff,
      lineNumber,
      side
    );
    if (targetLineIndexes == null) {
      return undefined;
    }

    const {
      metrics,
      options: {
        disableFileHeader = false,
        expandUnchanged = false,
        collapsed = false,
        collapsedContextThreshold = DEFAULT_COLLAPSED_CONTEXT_THRESHOLD,
      },
    } = this;
    if (collapsed) {
      return {
        top: getVirtualFileHeaderHeight(metrics, disableFileHeader),
        height: 0,
      };
    }
    const diffStyle = this.getDiffStyle();
    const lineIndexKey =
      diffStyle === 'split' ? 'splitLineIndex' : 'unifiedLineIndex';
    const hunkSeparators = this.getHunkSeparatorType();
    const targetLineIndex = targetLineIndexes[diffStyle === 'split' ? 1 : 0];
    this.approximateLayoutCheckpoints(fileDiff);
    const checkpoint =
      targetLineIndex > 0
        ? this.getLayoutCheckpointBefore('lineIndex', targetLineIndex)
        : undefined;
    let top =
      checkpoint?.top ??
      getVirtualFileHeaderRegion(metrics, disableFileHeader) +
        this.cache.fileAnnotationHeight;

    let position: { top: number; height: number } | undefined;
    iterateOverDiff({
      diff: fileDiff,
      diffStyle,
      startingLine: checkpoint?.renderedLineIndex ?? 0,
      expandedHunks: expandUnchanged
        ? true
        : this.hunksRenderer.getExpandedHunksMap(),
      collapsedContextThreshold,
      callback: ({
        hunkIndex,
        hunk,
        collapsedBefore,
        collapsedAfter,
        deletionLine,
        additionLine,
      }) => {
        const lineIndex =
          additionLine != null
            ? additionLine[lineIndexKey]
            : deletionLine[lineIndexKey];

        if (collapsedBefore > 0) {
          const separator = getLeadingHunkSeparatorLayout({
            type: hunkSeparators,
            metrics,
            hunkIndex,
            hunkSpecs: hunk?.hunkSpecs,
          });
          if (separator != null) {
            top += separator.gapBefore;
            if (
              targetLineIndex >= lineIndex - collapsedBefore &&
              targetLineIndex < lineIndex
            ) {
              position = { top, height: separator.height };
              return true;
            }
            top += separator.height + separator.gapAfter;
          }
        }

        const lineHeight = this.getLineHeight(
          lineIndex,
          additionLine?.noEOFCR === true || deletionLine?.noEOFCR === true
        );
        if (lineIndex === targetLineIndex) {
          position = { top, height: lineHeight };
          return true;
        }
        top += lineHeight;

        if (collapsedAfter > 0) {
          const separator = getTrailingHunkSeparatorLayout({
            type: hunkSeparators,
            metrics,
          });
          if (separator != null) {
            if (
              targetLineIndex > lineIndex &&
              targetLineIndex <= lineIndex + collapsedAfter
            ) {
              position = {
                top: top + separator.gapBefore,
                height: separator.height,
              };
              return true;
            }
            top += separator.totalHeight;
          }
        }

        return false;
      },
    });

    return position;
  }

  public getEditorViewport(): HTMLElement | Document | undefined {
    return this.virtualizer.type === 'simple'
      ? this.virtualizer.getRoot()
      : this.virtualizer.getContainerElement();
  }

  public getNumericScrollAnchor(
    localViewportTop: number
  ): NumericScrollLineAnchor | undefined {
    const fileDiff = this.getLayoutDiff();
    const {
      metrics,
      options: {
        disableFileHeader = false,
        expandUnchanged = false,
        collapsed = false,
        collapsedContextThreshold = DEFAULT_COLLAPSED_CONTEXT_THRESHOLD,
      },
    } = this;
    if (fileDiff == null || collapsed) {
      return undefined;
    }

    const diffStyle = this.getDiffStyle();
    const lineIndexKey =
      diffStyle === 'split' ? 'splitLineIndex' : 'unifiedLineIndex';
    const hunkSeparators = this.getHunkSeparatorType();

    this.approximateLayoutCheckpoints(fileDiff);
    const checkpoint = this.getLayoutCheckpointBefore('top', localViewportTop);
    let top =
      checkpoint?.top ??
      getVirtualFileHeaderRegion(metrics, disableFileHeader) +
        this.cache.fileAnnotationHeight;
    let anchor: NumericScrollLineAnchor | undefined;

    // This may end up being quite expensive on extremely large files, we may
    // need to figure out how to anchor on different regions, or utilize
    // renderRange to shortcut this for us somehow
    iterateOverDiff({
      diff: fileDiff,
      diffStyle,
      startingLine: checkpoint?.renderedLineIndex ?? 0,
      expandedHunks: expandUnchanged
        ? true
        : this.hunksRenderer.getExpandedHunksMap(),
      collapsedContextThreshold,
      callback: ({
        hunkIndex,
        hunk,
        collapsedBefore,
        collapsedAfter,
        deletionLine,
        additionLine,
      }) => {
        if (collapsedBefore > 0) {
          top +=
            getLeadingHunkSeparatorLayout({
              type: hunkSeparators,
              metrics,
              hunkIndex,
              hunkSpecs: hunk?.hunkSpecs,
            })?.totalHeight ?? 0;
        }

        if (top >= localViewportTop) {
          anchor =
            deletionLine != null
              ? { lineNumber: deletionLine.lineNumber, side: 'deletions', top }
              : { lineNumber: additionLine.lineNumber, side: 'additions', top };
          return true;
        }

        top += this.getLineHeight(
          additionLine != null
            ? additionLine[lineIndexKey]
            : deletionLine[lineIndexKey],
          additionLine?.noEOFCR === true || deletionLine?.noEOFCR === true
        );

        if (collapsedAfter > 0) {
          top +=
            getTrailingHunkSeparatorLayout({ type: hunkSeparators, metrics })
              ?.totalHeight ?? 0;
        }

        return false;
      },
    });

    return anchor;
  }

  public getVirtualizedHeight(): number {
    return this.height;
  }

  public getAdvancedStickySpecs(
    windowSpecs?: RenderWindow
  ): StickySpecs | undefined {
    const fileDiff = this.getLayoutDiff();
    if (this.top == null || fileDiff == null) {
      return undefined;
    }
    if (this.options.collapsed === true) {
      return { topOffset: this.top, height: this.height };
    }
    const renderRange =
      windowSpecs != null
        ? this.computeRenderRangeFromWindow(fileDiff, this.top, windowSpecs)
        : this.renderRange;
    if (renderRange == null) {
      return undefined;
    }
    const { bufferBefore, bufferAfter, totalLines } = renderRange;
    // Rendered items flow contiguously in the sticky container with no buffer
    // spacers, so a header-only item (totalLines === 0, none of its rows fall
    // inside the window) must report where its header actually sits in that
    // flow, which depends on which side of the window its content is on:
    //  - content ABOVE the window (item starts above window.top): the header
    //    sits at the item's bottom so the following item connects, so offset by
    //    bufferAfter.
    //  - content BELOW the window (item starts at/after window.top, e.g. a
    //    trailing header peeking in at the bottom): the header renders at the
    //    item's top with nothing after it, so no offset. Always adding
    //    bufferAfter here made getStickyBounds over-measure the sticky
    //    container for that trailing case.
    let headerOnlyOffset = 0;
    if (totalLines === 0) {
      const activeWindow = windowSpecs ?? this.virtualizer.getWindowSpecs();
      if (this.top < activeWindow.top) {
        headerOnlyOffset = bufferAfter;
      }
    }
    return {
      topOffset: this.top + bufferBefore + headerOnlyOffset,
      height: this.height - (bufferBefore + bufferAfter),
    };
  }

  override cleanUp(recycle = false): void {
    const hadGhostTextRows = this.cache.ghostTextRows.size > 0;
    if (hadGhostTextRows) {
      this.layoutDirty = true;
    }
    const shouldRecomputeLayout =
      recycle &&
      this.isAdvancedMode() &&
      this.fileContainer != null &&
      (hadGhostTextRows ||
        !areDiffTargetsEqual(this.getRenderedDiff(), this.getLatestDiff()));
    if (this.fileContainer != null) {
      this.getSimpleVirtualizer()?.disconnect(this.fileContainer);
    }
    if (!recycle) {
      this.resetLayoutCache(true);
      this.pendingExpansions = undefined;
      this.pendingHydratedDiff = undefined;
    }
    this.pendingRender = undefined;
    this.isSetup = false;
    super.cleanUp(recycle);
    if (shouldRecomputeLayout) {
      this.virtualizer.instanceChanged(this, true);
    }
  }

  override expandHunk = (
    hunkIndex: number,
    direction: ExpansionDirections,
    expansionLineCountOverride?: number
  ): void => {
    if (this.fileDiff == null) {
      return;
    }
    this.loadFilesIfNecessary();
    if (this.isAdvancedMode()) {
      this.pendingExpansions ??= [];
      this.pendingExpansions.push([
        hunkIndex,
        direction,
        expansionLineCountOverride,
      ]);
    } else {
      this.hunksRenderer.expandHunk(
        hunkIndex,
        direction,
        expansionLineCountOverride
      );
      this.resetLayoutCache(true);
      this.computeApproximateSize();
    }
    this.forceRenderOverride = true;
    this.virtualizer.instanceChanged(this, true);
  };

  protected override async handleFilesLoaded(
    expectedDiff: FileDiffMetadata,
    files: LoadedPartialDiffContents
  ): Promise<void> {
    if (this.fileDiff !== expectedDiff || !expectedDiff.isPartial) {
      return;
    }
    // CodeView component requires careful control for anchor
    // fixing on re-renders, and thus we cannot apply the
    // next diff immediately. Instead we clone and stage it for
    // CodeView layout to consume at render time.
    if (this.isAdvancedMode()) {
      const nextDiff = hydratePartialDiff('clone', expectedDiff, files);
      await awaitWithTimeout(() => this.primeHighlightCache(nextDiff));
      if (this.fileDiff !== expectedDiff) {
        return;
      }
      this.pendingHydratedDiff = {
        expectedDiff,
        nextDiff,
        files,
      };
    } else {
      hydratePartialDiff('merge', expectedDiff, files);
      this.setHydratedState(files);
      if (!this.installHydratedSessionDiff(expectedDiff)) {
        await awaitWithTimeout(() => this.primeHighlightCache(expectedDiff));
        if (this.fileDiff !== expectedDiff) {
          return;
        }
      }
      this.resetLayoutCache(true);
      this.computeApproximateSize();
    }
    this.forceRenderOverride = true;
    this.virtualizer.instanceChanged(this, true);
  }

  protected override loadFilesIfNecessary(): void {
    if (this.pendingHydratedDiff != null) {
      if (this.pendingHydratedDiff.expectedDiff === this.fileDiff) {
        return;
      }
      this.pendingHydratedDiff = undefined;
    }

    super.loadFilesIfNecessary();
  }

  // In advanced (CodeView) mode, expansions are staged in pendingExpansions
  // until the next layout consume, so the renderer's expansion map lags a
  // just-requested reveal. Account for the staged expansions so callers (the
  // editor's caret-scroll retry) see the post-consume visibility.
  override isLineRenderable(lineNumber: number): boolean {
    if (super.isLineRenderable(lineNumber)) {
      return true;
    }
    const { pendingExpansions } = this;
    const fileDiff = this.getRenderedDiff();
    if (pendingExpansions == null || fileDiff == null) {
      return false;
    }
    const {
      expansionLineCount = 100,
      collapsedContextThreshold = DEFAULT_COLLAPSED_CONTEXT_THRESHOLD,
    } = this.options;
    const staged = new Map(this.hunksRenderer.getExpandedHunksMap());
    for (const [hunkIndex, direction, lineCountOverride] of pendingExpansions) {
      const region = {
        ...(staged.get(hunkIndex) ?? { fromStart: 0, fromEnd: 0 }),
      };
      const count = lineCountOverride ?? expansionLineCount;
      if (direction !== 'down') {
        region.fromStart += count;
      }
      if (direction !== 'up') {
        region.fromEnd += count;
      }
      staged.set(hunkIndex, region);
    }
    return isAdditionLineRenderable({
      fileDiff,
      lineNumber,
      expandedHunks: staged,
      collapsedContextThreshold,
    });
  }

  /**
   * Invalidate layout after an edit session changed the rendered row set
   * without a line-count change (a mid-session region change or the exit
   * recompute): estimated heights bake the hunk shapes in, and nothing else
   * invalidates them now that editing does not flip expandUnchanged. Public
   * so CodeView can run it when reaping a session whose instance was already
   * released.
   */
  public invalidateEditSessionLayout(): void {
    this.getSimpleVirtualizer()?.markDOMDirty();
    this.resetLayoutCache(true, false);
    this.computeApproximateSize();
    this.getSimpleVirtualizer()?.requestHeightReconcile(this);
  }

  // Session region changes need the same invalidation a document change
  // gets. The virtualizer is told the layout changed (rendered rows and
  // heights moved) and defers the actual render through its own queue; a
  // released instance stops at the cache invalidation and the host relayout
  // covers it.
  protected override escalateEditSessionRender(): void {
    this.invalidateEditSessionLayout();
    if (!this.enabled || this.fileDiff == null) {
      return;
    }
    this.forceRenderOverride = true;
    this.virtualizer.instanceChanged(this, true);
  }

  protected override shouldSelfHealEditSession(): boolean {
    // CodeView sessions retain their editor association while rendering is
    // suspended; CodeView itself runs the exit recompute when it reaps one.
    return !this.isAdvancedMode() && super.shouldSelfHealEditSession();
  }

  public setVisibility(visible: boolean): void {
    if (this.isAdvancedMode() || this.fileContainer == null) {
      return;
    }
    this.renderRange = undefined;
    if (visible && !this.isVisible) {
      this.top = this.getVirtualizedTop();
      this.isVisible = true;
    } else if (!visible && this.isVisible) {
      this.isVisible = false;
      this.rerender();
    }
  }

  override rerender(): void {
    if (
      !this.enabled ||
      (this.fileDiff == null &&
        this.additionFile == null &&
        this.deletionFile == null)
    ) {
      return;
    }
    const latestDiff = this.getLatestDiff();
    const nextRenderDiff =
      latestDiff == null
        ? undefined
        : this.hunksRenderer.getDiffForNextRender(latestDiff);
    // A completed async highlight can change which diff the next simple
    // virtualizer render will commit. CodeView refreshes this during layout.
    if (this.isSimpleMode()) {
      this.pendingRender = undefined;
    }
    this.forceRenderOverride = true;
    this.virtualizer.instanceChanged(
      this,
      !areDiffTargetsEqual(this.getRenderedDiff(), nextRenderDiff)
    );
  }

  // The editor changed the ghost text rows it shows below lines. Ask the
  // virtualizer for a layout pass, which folds them in (see
  // applyGhostTextRows). Layout state only changes inside that pass.
  public syncGhostTextRows(): void {
    const codeView = this.getAdvancedVirtualizer();
    if (codeView != null) {
      codeView.capturePendingLayoutAnchor();
      this.layoutDirty = true;
      codeView.instanceChanged(this, true);
    } else {
      this.getSimpleVirtualizer()?.requestHeightReconcile(this);
    }
  }

  // Normally triggered by the host when the document line count changes.
  override applyDocumentChange(
    textDocument: TextDocument<'file-diff', LAnnotation>,
    newLineAnnotations?: DiffLineAnnotation<LAnnotation>[],
    shouldUpdateBuffer = false
  ): void {
    const { renderRange: previousRenderRange } = this;
    // Capture the scroll anchor before the synchronous hunk rebuild and
    // measured-height wipe below; the host's next frame resolves it against
    // the new geometry so on-screen rows do not shift.
    this.getAdvancedVirtualizer()?.capturePendingLayoutAnchor();
    super.applyDocumentChange(textDocument, newLineAnnotations);
    this.getSimpleVirtualizer()?.markDOMDirty();
    this.resetLayoutCache(true, false);
    this.computeApproximateSize();

    const fileDiff = this.getRenderedDiff();
    if (
      shouldUpdateBuffer &&
      this.isSimpleMode() &&
      previousRenderRange != null &&
      fileDiff != null
    ) {
      // Update the buffers caused by the line-count change to ensure the host
      // scrolls to the correct position before re-rendering.
      const renderRange = this.computeRenderRangeFromWindow(
        fileDiff,
        this.top ?? 0,
        this.virtualizer.getWindowSpecs()
      );
      if (renderRange.bufferAfter !== previousRenderRange.bufferAfter) {
        this.updateBuffers(renderRange);
      }
    }

    this.forceRenderOverride = true;
    this.virtualizer.instanceChanged(this, true);
  }

  // Compute the approximate size from the cached baseline estimate plus any
  // measured height deltas observed in rendered rows.
  // The reason we refer to this as `approximate size` is because heights my
  // dynamically change for a number of reasons so we can never be fully sure
  // if the height is 100% accurate
  private computeApproximateSize(
    force = false,
    fileDiff: FileDiffMetadata | undefined = this.getLayoutDiff()
  ): void {
    const shouldValidateSize = this.isResizeDebuggingEnabled();
    if (!force && !this.layoutDirty && !shouldValidateSize) {
      return;
    }

    const { cache } = this;
    const isFirstCompute = this.height === 0;
    this.height = 0;
    cache.checkpoints = [];
    cache.totalLines = 0;
    if (fileDiff != null) {
      this.applyGhostTextRows(
        fileDiff,
        this.editor?.__getGhostTextRows() ?? NO_GHOST_TEXT_ROWS
      );
      const {
        disableFileHeader = false,
        collapsed = false,
        expandUnchanged = false,
        collapsedContextThreshold = DEFAULT_COLLAPSED_CONTEXT_THRESHOLD,
      } = this.options;
      if (collapsed) {
        this.height = getVirtualFileHeaderHeight(
          this.metrics,
          disableFileHeader
        );
      } else {
        // Baseline estimates survive style/collapse toggles; compute both
        // styles at once when either is missing.
        if (
          cache.estimatedSplitHeight == null ||
          cache.estimatedUnifiedHeight == null
        ) {
          const { splitHeight, unifiedHeight } = computeEstimatedDiffHeights({
            fileDiff,
            metrics: this.metrics,
            disableFileHeader,
            hunkSeparators: this.getHunkSeparatorType(),
            expandUnchanged,
            expandedHunks: this.hunksRenderer.getExpandedHunksMap(),
            collapsedContextThreshold,
            canHydratePartialDiff: canHydrateCollapsedContext(
              fileDiff,
              this.options.loadDiffFiles != null
            ),
          });
          cache.estimatedSplitHeight = splitHeight;
          cache.estimatedUnifiedHeight = unifiedHeight;
        }
        this.height =
          (this.getDiffStyle() === 'split'
            ? cache.estimatedSplitHeight
            : cache.estimatedUnifiedHeight) + cache.measuredHeightDeltaTotal;

        if (
          shouldValidateSize &&
          !isFirstCompute &&
          this.fileContainer != null
        ) {
          const elementHeight =
            this.fileContainer.getBoundingClientRect().height;
          if (elementHeight !== this.height) {
            console.log(
              'VirtualizedFileDiff.computeApproximateSize: computed height doesnt match',
              {
                name: fileDiff.name,
                elementHeight,
                computedHeight: this.height,
              }
            );
          } else {
            console.log(
              'VirtualizedFileDiff.computeApproximateSize: computed height IS CORRECT'
            );
          }
        }
      }
    }
    this.layoutDirty = false;
  }

  // CodeView calculates its next layout before updating the DOM. This keeps every
  // layout calculation within that frame tied to the same diff.
  private getLayoutDiff(): FileDiffMetadata | undefined {
    return this.pendingRender?.diff ?? this.getRenderedDiff();
  }

  override render({
    fileContainer,
    fileDiff,
    forceRender = false,
    lineAnnotations,
    ...fileInputProps
  }: FileDiffRenderProps<LAnnotation> = {}): boolean {
    const fileInput = getDiffFileInput(
      fileInputProps,
      'VirtualizedFileDiff.render'
    );
    const hasFileInput = fileInput != null;
    const oldFile = fileInput?.oldFile;
    const newFile = fileInput?.newFile;
    const filesDidChange =
      hasFileInput &&
      (!areOptionalFilesEqual(oldFile, this.deletionFile) ||
        !areOptionalFilesEqual(newFile, this.additionFile));
    let nextFileDiff = fileDiff ?? this.fileDiff;
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
    const { forceRenderOverride, isSetup } = this;
    this.forceRenderOverride = undefined;
    const targetChanged =
      nextFileDiff != null && !areDiffTargetsEqual(this.fileDiff, nextFileDiff);
    const dataChanged = targetChanged || filesDidChange;

    fileContainer = this.getOrCreateFileContainer(fileContainer);

    if (nextFileDiff == null) {
      console.error(
        'VirtualizedFileDiff.render: attempting to virtually render when we dont have the correct data'
      );
      return false;
    }
    if (targetChanged) {
      this.updateExternalDiff(nextFileDiff, lineAnnotations);
    }

    const {
      pendingRenderDiff,
      layoutDiffChanged,
      renderedDiffChanged,
      annotationsChanged,
    } =
      this.pendingRender != null &&
      this.pendingRender.latestDiff === this.getLatestDiff(nextFileDiff)
        ? {
            pendingRenderDiff: this.pendingRender.diff,
            layoutDiffChanged: false,
            renderedDiffChanged: false,
            annotationsChanged: this.syncLineAnnotations(lineAnnotations),
          }
        : this.updatePendingRender(nextFileDiff, lineAnnotations);

    if (layoutDiffChanged) {
      this.resetLayoutCache(true);
    }

    const simpleVirtualizer = this.getSimpleVirtualizer();
    if (!isSetup) {
      this.computeApproximateSize(false, pendingRenderDiff);
      this.top ??= this.getVirtualizedTop();
      if (simpleVirtualizer != null) {
        simpleVirtualizer.connect(fileContainer, this);
        this.isVisible = simpleVirtualizer.isInstanceVisible(
          this.top,
          this.height
        );
      } else {
        this.isVisible = true;
      }
      this.isSetup = true;
    } else {
      this.top ??= this.getVirtualizedTop();
      if (this.layoutDirty && simpleVirtualizer != null) {
        simpleVirtualizer.markDOMDirty();
        this.computeApproximateSize(false, pendingRenderDiff);
      }
    }

    if (
      !this.isVisible &&
      simpleVirtualizer != null &&
      (!dataChanged || !isSetup)
    ) {
      if (hasFileInput) {
        this.deletionFile = oldFile;
        this.additionFile = newFile;
      }
      if (targetChanged) {
        this.clearReusableHeader();
      }
      return this.renderPlaceholder(this.height);
    }

    return super.render({
      fileDiff: nextFileDiff,
      fileContainer,
      renderRange: this.computeRenderRangeFromWindow(
        pendingRenderDiff,
        this.top,
        this.virtualizer.getWindowSpecs()
      ),
      lineAnnotations,
      forceRender:
        (forceRenderOverride ?? forceRender) ||
        annotationsChanged ||
        renderedDiffChanged ||
        targetChanged,
      ...fileInputProps,
    });
  }

  protected override finalizeRender(): void {
    if (
      !areDiffTargetsEqual(this.getRenderedDiff(), this.pendingRender?.diff)
    ) {
      throw new Error(
        'VirtualizedFileDiff.render: rendered a different diff than its prepared layout'
      );
    }
    this.pendingRender = undefined;
    // Renders can be driven from outside the virtualizer (host/React render
    // calls, async highlight completions), and the virtualizer only
    // auto-reconciles renders it initiated. Queue a measured-height
    // reconciliation for every applied content render so line deltas
    // (wrapped lines, annotation heights) survive layout resets.
    this.getSimpleVirtualizer()?.requestHeightReconcile(this);
  }

  private updatePendingRender(
    nextFileDiff: FileDiffMetadata,
    lineAnnotations: DiffLineAnnotation<LAnnotation>[] | undefined
  ) {
    const latestDiff = this.getLatestDiff(nextFileDiff) ?? nextFileDiff;
    const previousRenderedDiff = this.getRenderedDiff();
    const { pendingRender } = this;
    const previousLayoutDiff = pendingRender?.diff ?? previousRenderedDiff;
    const pendingRenderDiff =
      this.hunksRenderer.getDiffForNextRender(latestDiff);

    this.pendingRender = { latestDiff, diff: pendingRenderDiff };

    return {
      pendingRenderDiff,
      annotationsChanged: this.syncLineAnnotations(lineAnnotations),
      layoutDiffChanged: !areDiffTargetsEqual(
        previousLayoutDiff,
        pendingRenderDiff
      ),
      renderedDiffChanged: !areDiffTargetsEqual(
        previousRenderedDiff,
        pendingRenderDiff
      ),
    };
  }

  public syncVirtualizedTop(): void {
    this.top = this.getVirtualizedTop();
  }

  protected override shouldDisableVirtualizationBuffers(): boolean {
    return this.isAdvancedMode() || super.shouldDisableVirtualizationBuffers();
  }

  // This WebKit dom manipulation scroll fix is not applicable in virtualized
  // environments, so we avoid the performance hit even on Webkit
  protected override shouldGuardRebuildScroll(): boolean {
    return false;
  }

  private isSimpleMode(): boolean {
    return this.virtualizer.type === 'simple';
  }

  private isAdvancedMode(): boolean {
    return this.virtualizer.type === 'advanced';
  }

  private getVirtualizedTop(): number {
    if (this.virtualizer.type === 'advanced') {
      return this.virtualizer.getLocalTopForInstance(this);
    }
    return this.fileContainer != null
      ? this.virtualizer.getOffsetInScrollContainer(this.fileContainer)
      : 0;
  }

  private getSimpleVirtualizer(): Virtualizer | undefined {
    return this.virtualizer.type === 'simple' ? this.virtualizer : undefined;
  }

  private getAdvancedVirtualizer(): CodeView<LAnnotation, Caret> | undefined {
    return this.virtualizer.type === 'advanced' ? this.virtualizer : undefined;
  }

  private isResizeDebuggingEnabled(): boolean {
    return this.getSimpleVirtualizer()?.config.resizeDebugging ?? false;
  }

  private getDiffStyle(): 'split' | 'unified' {
    return this.options.diffStyle ?? 'split';
  }

  private getHunkSeparatorType(): HunkSeparators {
    const { hunkSeparators } = this.options;
    return typeof hunkSeparators === 'function'
      ? 'custom'
      : (hunkSeparators ?? 'line-info');
  }

  private approximateLayoutCheckpoints(fileDiff: FileDiffMetadata): void {
    const { cache, metrics, options } = this;
    if (
      (!this.layoutDirty && cache.checkpoints.length > 0) ||
      fileDiff.hunks.length === 0 ||
      options.collapsed === true
    ) {
      return;
    }

    const {
      disableFileHeader = false,
      expandUnchanged = false,
      collapsedContextThreshold = DEFAULT_COLLAPSED_CONTEXT_THRESHOLD,
    } = options;
    const { lineHeight } = metrics;
    const finalHunkIndex = fileDiff.hunks.length - 1;
    const canHydratePartialDiff = canHydrateCollapsedContext(
      fileDiff,
      options.loadDiffFiles != null
    );
    const diffStyle = this.getDiffStyle();
    const hunkSeparators = this.getHunkSeparatorType();
    const expandedHunks = expandUnchanged
      ? true
      : this.hunksRenderer.getExpandedHunksMap();
    // Prefix sums over the measured height deltas sorted by line index, so
    // the delta total of any row range costs two binary searches.
    const deltaLineIndexes: number[] = [];
    const deltaTotals = [0];
    for (const [lineIndex, delta] of [...cache.heightDeltas].sort(
      (a, b) => a[0] - b[0]
    )) {
      deltaLineIndexes.push(lineIndex);
      deltaTotals.push(deltaTotals[deltaTotals.length - 1] + delta);
    }
    const heightDeltasBefore = (lineIndex: number): number => {
      let low = 0;
      let high = deltaLineIndexes.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (deltaLineIndexes[mid] < lineIndex) {
          low = mid + 1;
        } else {
          high = mid;
        }
      }
      return deltaTotals[low];
    };
    let top =
      getVirtualFileHeaderRegion(metrics, disableFileHeader) +
      cache.fileAnnotationHeight;
    let renderedLineIndex = 0;

    const processRows = (
      rowCount: number,
      startLineIndex: number,
      preSeparatorHeight = 0,
      postSeparatorHeight = 0,
      metadataOffsets: number[] = []
    ) => {
      if (rowCount <= 0) {
        return;
      }

      const blockStart = renderedLineIndex;
      const blockEnd = renderedLineIndex + rowCount;
      for (
        let nextCheckpoint =
          Math.ceil(
            blockStart / VIRTUALIZED_FILE_DIFF_LAYOUT_CHECKPOINT_INTERVAL
          ) * VIRTUALIZED_FILE_DIFF_LAYOUT_CHECKPOINT_INTERVAL;
        nextCheckpoint < blockEnd;
        nextCheckpoint += VIRTUALIZED_FILE_DIFF_LAYOUT_CHECKPOINT_INTERVAL
      ) {
        const offset = nextCheckpoint - blockStart;
        let metadataRows = 0;
        for (const metadataOffset of metadataOffsets) {
          if (metadataOffset < offset) {
            metadataRows++;
          }
        }
        cache.checkpoints.push({
          renderedLineIndex: nextCheckpoint,
          lineIndex: startLineIndex + offset,
          top:
            top +
            (offset > 0 ? preSeparatorHeight : 0) +
            offset * lineHeight +
            metadataRows * lineHeight +
            (heightDeltasBefore(startLineIndex + offset) -
              heightDeltasBefore(startLineIndex)),
        });
      }

      top +=
        preSeparatorHeight +
        rowCount * lineHeight +
        metadataOffsets.length * lineHeight +
        (heightDeltasBefore(startLineIndex + rowCount) -
          heightDeltasBefore(startLineIndex)) +
        postSeparatorHeight;
      renderedLineIndex = blockEnd;
    };

    for (let hunkIndex = 0; hunkIndex < fileDiff.hunks.length; hunkIndex++) {
      const hunk = fileDiff.hunks[hunkIndex];
      const hunkStart =
        diffStyle === 'split' ? hunk.splitLineStart : hunk.unifiedLineStart;
      const hunkRowCount =
        diffStyle === 'split' ? hunk.splitLineCount : hunk.unifiedLineCount;

      const leadingRegion = getExpandedRegion({
        isPartial: fileDiff.isPartial,
        rangeSize: hunk.collapsedBefore,
        expandedHunks,
        hunkIndex,
        collapsedContextThreshold,
      });
      // The leading separator sits above the expanded rows next to the hunk,
      // or above the hunk itself when none are expanded there.
      let leadingSeparatorHeight =
        leadingRegion.collapsedLines > 0
          ? (getLeadingHunkSeparatorLayout({
              type: hunkSeparators,
              metrics,
              hunkIndex,
              hunkSpecs: hunk.hunkSpecs,
            })?.totalHeight ?? 0)
          : 0;
      processRows(leadingRegion.fromStart, hunkStart - leadingRegion.rangeSize);
      processRows(
        leadingRegion.fromEnd,
        hunkStart - leadingRegion.fromEnd,
        leadingSeparatorHeight
      );
      if (leadingRegion.fromEnd > 0) {
        leadingSeparatorHeight = 0;
      }

      const isFinalHunk = hunkIndex === finalHunkIndex;
      const trailingRegion = isFinalHunk
        ? getTrailingExpandedRegion({
            fileDiff,
            hunkIndex,
            expandedHunks,
            collapsedContextThreshold,
            errorPrefix: 'VirtualizedFileDiff',
          })
        : undefined;
      const trailingSeparatorHeight =
        (trailingRegion != null && trailingRegion.collapsedLines > 0) ||
        (isFinalHunk && canHydratePartialDiff)
          ? (getTrailingHunkSeparatorLayout({ type: hunkSeparators, metrics })
              ?.totalHeight ?? 0)
          : 0;
      const trailingExpandedCount =
        trailingRegion != null
          ? trailingRegion.fromStart + trailingRegion.fromEnd
          : 0;

      processRows(
        hunkRowCount,
        hunkStart,
        leadingSeparatorHeight,
        trailingExpandedCount === 0 ? trailingSeparatorHeight : 0,
        getHunkMetadataOffsets(diffStyle, hunk, hunkRowCount)
      );
      if (trailingExpandedCount > 0) {
        processRows(
          trailingExpandedCount,
          hunkStart + hunkRowCount,
          0,
          trailingSeparatorHeight
        );
      }
    }

    cache.totalLines = renderedLineIndex;
  }

  // Find the nearest sparse layout checkpoint whose `key` (diff-style line
  // index or top offset) is at or before `value`. Checkpoints also store the
  // dense rendered-row index, so deep scans can resume from that rendered row
  // and replay only the nearby layout work instead of walking from the first
  // hunk. When `hunkLineCount` is provided, step backward to a rendered hunk
  // boundary so buffer calculations can reuse absolute hunk offsets safely.
  private getLayoutCheckpointBefore(
    key: 'lineIndex' | 'top',
    value: number,
    hunkLineCount?: number
  ): DiffLayoutCheckpoint | undefined {
    const { checkpoints } = this.cache;
    let low = 0;
    let high = checkpoints.length - 1;
    let index = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (checkpoints[mid][key] <= value) {
        index = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (hunkLineCount != null) {
      while (
        index >= 0 &&
        checkpoints[index].renderedLineIndex % hunkLineCount !== 0
      ) {
        index--;
      }
    }
    return index >= 0 ? checkpoints[index] : undefined;
  }

  private getExpandedLineCount(
    fileDiff: FileDiffMetadata,
    diffStyle: 'split' | 'unified'
  ): number {
    const {
      expandUnchanged = false,
      collapsedContextThreshold = DEFAULT_COLLAPSED_CONTEXT_THRESHOLD,
    } = this.options;
    const expandedHunks = expandUnchanged
      ? true
      : this.hunksRenderer.getExpandedHunksMap();
    let count = 0;
    for (const [hunkIndex, hunk] of fileDiff.hunks.entries()) {
      count +=
        diffStyle === 'split' ? hunk.splitLineCount : hunk.unifiedLineCount;
      // Partial diffs can't render collapsed context.
      if (!fileDiff.isPartial && hunk.collapsedBefore > 0) {
        const { fromStart, fromEnd, renderAll } = getExpandedRegion({
          isPartial: false,
          rangeSize: hunk.collapsedBefore,
          expandedHunks,
          hunkIndex,
          collapsedContextThreshold,
        });
        count += renderAll ? hunk.collapsedBefore : fromStart + fromEnd;
      }
    }

    const trailingRegion = fileDiff.isPartial
      ? undefined
      : getTrailingExpandedRegion({
          fileDiff,
          hunkIndex: fileDiff.hunks.length - 1,
          expandedHunks,
          collapsedContextThreshold,
          errorPrefix: 'VirtualizedFileDiff',
        });
    if (trailingRegion != null) {
      count += trailingRegion.fromStart + trailingRegion.fromEnd;
    }

    return count;
  }

  // Row total used to clamp render-range scrolling. Sparse layout checkpoints can
  // still hold a smaller pre-edit count until they are rebuilt, so always take
  // the max against the live diff metadata (including additionLines.length).
  private getLayoutLineCount(
    fileDiff: FileDiffMetadata,
    diffStyle: 'split' | 'unified'
  ): number {
    const expandedLineCount = this.getExpandedLineCount(fileDiff, diffStyle);
    const metadataLineCount =
      diffStyle === 'split'
        ? fileDiff.splitLineCount
        : fileDiff.unifiedLineCount;
    return Math.max(
      expandedLineCount,
      metadataLineCount,
      fileDiff.additionLines.length,
      fileDiff.deletionLines.length,
      this.cache.totalLines
    );
  }

  private computeRenderRangeFromWindow(
    fileDiff: FileDiffMetadata,
    fileTop: number,
    { top, bottom }: RenderWindow
  ): RenderRange {
    const {
      disableFileHeader = false,
      expandUnchanged = false,
      collapsedContextThreshold = DEFAULT_COLLAPSED_CONTEXT_THRESHOLD,
    } = this.options;
    const { hunkLineCount, lineHeight } = this.metrics;
    const diffStyle = this.getDiffStyle();
    const lineIndexKey =
      diffStyle === 'split' ? 'splitLineIndex' : 'unifiedLineIndex';
    const hunkSeparators = this.getHunkSeparatorType();
    const canHydratePartialDiff = canHydrateCollapsedContext(
      fileDiff,
      this.options.loadDiffFiles != null
    );
    const fileHeight = this.height;
    const headerRegion = getVirtualFileHeaderRegion(
      this.metrics,
      disableFileHeader
    );
    const paddingBottom =
      fileDiff.hunks.length > 0 ? getVirtualFilePaddingBottom(this.metrics) : 0;
    const { fileAnnotationHeight } = this.cache;
    const codeRegionTop = headerRegion + fileAnnotationHeight;
    const codeHeight = Math.max(
      0,
      fileHeight - headerRegion - fileAnnotationHeight - paddingBottom
    );

    // File is outside render window
    if (fileTop < top - fileHeight || fileTop > bottom) {
      return {
        startingLine: 0,
        totalLines: 0,
        bufferBefore: 0,
        bufferAfter: fileHeight - headerRegion - paddingBottom,
      };
    }

    // Whole file is under hunkLineCount, just render it all
    if (
      this.getLayoutLineCount(fileDiff, diffStyle) <= hunkLineCount ||
      fileDiff.hunks.length === 0
    ) {
      return {
        startingLine: 0,
        totalLines: hunkLineCount,
        bufferBefore: 0,
        bufferAfter: 0,
      };
    }

    this.approximateLayoutCheckpoints(fileDiff);
    const lineCount = this.getLayoutLineCount(fileDiff, diffStyle);

    const estimatedTargetLines = Math.ceil(
      Math.max(bottom - top, 0) / lineHeight
    );
    const totalLines =
      Math.ceil(estimatedTargetLines / hunkLineCount) * hunkLineCount +
      hunkLineCount;
    const totalHunks = totalLines / hunkLineCount;
    const hunkOffsets: number[] = [];
    // Halfway between top & bottom, represented as an absolute position
    const viewportCenter = (top + bottom) / 2;
    // Start the scan before the viewport so we collect hunk offsets that may be
    // needed for bufferBefore. This only chooses the scan origin; the returned
    // render range is still computed from the visible window below.
    const checkpoint = this.getLayoutCheckpointBefore(
      'top',
      Math.max(0, top - fileTop - totalLines * lineHeight * 2),
      hunkLineCount
    );

    let absoluteLineTop = fileTop + (checkpoint?.top ?? codeRegionTop);
    let currentLine = checkpoint?.renderedLineIndex ?? 0;
    let firstVisibleHunk: number | undefined;
    let centerHunk: number | undefined;
    let overflowCounter: number | undefined;

    iterateOverDiff({
      diff: fileDiff,
      diffStyle,
      startingLine: checkpoint?.renderedLineIndex ?? 0,
      expandedHunks: expandUnchanged
        ? true
        : this.hunksRenderer.getExpandedHunksMap(),
      collapsedContextThreshold,
      callback: ({
        hunkIndex,
        hunk,
        collapsedBefore,
        collapsedAfter,
        deletionLine,
        additionLine,
      }) => {
        const lineIndex =
          additionLine != null
            ? additionLine[lineIndexKey]
            : deletionLine[lineIndexKey];
        const gapAdjustment =
          collapsedBefore > 0
            ? (getLeadingHunkSeparatorLayout({
                type: hunkSeparators,
                metrics: this.metrics,
                hunkIndex,
                hunkSpecs: hunk?.hunkSpecs,
              })?.totalHeight ?? 0)
            : 0;

        absoluteLineTop += gapAdjustment;

        const isAtHunkBoundary = currentLine % hunkLineCount === 0;
        const currentHunk = Math.floor(currentLine / hunkLineCount);

        // Track the boundary positional offset at a hunk
        if (isAtHunkBoundary) {
          hunkOffsets[currentHunk] =
            absoluteLineTop - (fileTop + codeRegionTop + gapAdjustment);

          // Check if we should bail (overflow complete)
          if (overflowCounter != null) {
            if (overflowCounter <= 0) {
              return true;
            }
            overflowCounter--;
          }
        }

        const lineHeight = this.getLineHeight(
          lineIndex,
          additionLine?.noEOFCR === true || deletionLine?.noEOFCR === true
        );

        // Track visible region
        if (absoluteLineTop > top - lineHeight && absoluteLineTop < bottom) {
          firstVisibleHunk ??= currentHunk;
        }

        // Track which hunk contains the viewport center
        // If viewport center is above this line and we haven't set centerHunk yet,
        // this is the first line at or past the center
        if (
          centerHunk == null &&
          absoluteLineTop + lineHeight > viewportCenter
        ) {
          centerHunk = currentHunk;
        }

        // Start overflow when we are out of the viewport at a hunk boundary
        if (
          overflowCounter == null &&
          absoluteLineTop >= bottom &&
          isAtHunkBoundary
        ) {
          overflowCounter = totalHunks;
        }

        currentLine++;
        absoluteLineTop += lineHeight;

        // The final hunk row of a hydratable partial diff is followed by the
        // trailing separator too.
        if (
          collapsedAfter > 0 ||
          (canHydratePartialDiff &&
            hunk != null &&
            hunkIndex === fileDiff.hunks.length - 1 &&
            lineIndex ===
              (diffStyle === 'split'
                ? hunk.splitLineStart + hunk.splitLineCount
                : hunk.unifiedLineStart + hunk.unifiedLineCount) -
                1)
        ) {
          const trailingSeparator = getTrailingHunkSeparatorLayout({
            type: hunkSeparators,
            metrics: this.metrics,
          });
          if (trailingSeparator != null) {
            if (
              absoluteLineTop < bottom &&
              absoluteLineTop + trailingSeparator.totalHeight > top
            ) {
              firstVisibleHunk ??= currentHunk;
            }
            if (
              centerHunk == null &&
              absoluteLineTop + trailingSeparator.totalHeight > viewportCenter
            ) {
              centerHunk = currentHunk;
            }
            absoluteLineTop += trailingSeparator.totalHeight;
          }
        }

        return false;
      },
    });

    // No visible lines found; a visible measured file annotation row (whose
    // sides match a single-sided diff) still renders the first hunk.
    if (firstVisibleHunk == null) {
      const fileAnnotationTop = fileTop + headerRegion;
      const measuredFileAnnotationVisible =
        fileAnnotationHeight > 0 &&
        fileAnnotationTop < bottom &&
        fileAnnotationTop + fileAnnotationHeight > top &&
        this.getLatestAnnotations().some(
          ({ lineNumber, side }) =>
            lineNumber === FILE_ANNOTATION_LINE_NUMBER &&
            (fileDiff.type === 'new'
              ? side === 'additions'
              : fileDiff.type !== 'deleted' || side === 'deletions')
        );
      if (!measuredFileAnnotationVisible) {
        return {
          startingLine: 0,
          totalLines: 0,
          bufferBefore: 0,
          bufferAfter: fileHeight - headerRegion - paddingBottom,
        };
      }
      firstVisibleHunk = 0;
      centerHunk = 0;
    }

    // Calculate balanced startingLine centered around the viewport center
    // Fall back to firstVisibleHunk if center wasn't found (e.g., center in a gap)
    centerHunk ??= firstVisibleHunk;
    const idealStartHunk = Math.round(centerHunk - totalHunks / 2);

    // Clamp startHunk: at the beginning, reduce totalLines; at the end, shift startHunk back
    const maxStartHunk = Math.max(
      0,
      Math.ceil(lineCount / hunkLineCount) - totalHunks
    );
    const startHunk = Math.max(0, Math.min(idealStartHunk, maxStartHunk));
    const startingLine = startHunk * hunkLineCount;

    // If we wanted to start before 0, reduce totalLines by the clamped amount
    const clampedTotalLines =
      idealStartHunk < 0
        ? totalLines + idealStartHunk * hunkLineCount
        : totalLines;

    // Use hunkOffsets array for efficient buffer calculations
    const codeBufferBefore = hunkOffsets[startHunk] ?? 0;
    const bufferBefore =
      startingLine === 0 ? 0 : fileAnnotationHeight + codeBufferBefore;

    // Calculate bufferAfter using hunkOffset if available, otherwise use cumulative height
    const finalHunkIndex = startHunk + clampedTotalLines / hunkLineCount;
    const bufferAfter =
      finalHunkIndex < hunkOffsets.length
        ? codeHeight - hunkOffsets[finalHunkIndex]
        : // We stopped early, calculate from current position
          codeHeight - (absoluteLineTop - fileTop - codeRegionTop);

    return {
      startingLine,
      totalLines: clampedTotalLines,
      bufferBefore,
      bufferAfter: Math.max(0, bufferAfter),
    };
  }
}

// Row offsets (within a hunk body of `rowCount` rows) that carry a trailing
// noNewline metadata row.
function getHunkMetadataOffsets(
  diffStyle: 'split' | 'unified',
  hunk: Hunk,
  rowCount: number
): number[] {
  const lastContent = hunk.hunkContent.at(-1);
  if (
    rowCount <= 0 ||
    (!hunk.noEOFCRAdditions && !hunk.noEOFCRDeletions) ||
    lastContent == null
  ) {
    return [];
  }
  if (lastContent.type === 'context') {
    return [rowCount - 1];
  }
  const { additions, deletions } = lastContent;
  if (diffStyle === 'split') {
    return additions > 0 || deletions > 0 ? [rowCount - 1] : [];
  }
  const offsets: number[] = [];
  if (deletions > 0 && hunk.noEOFCRDeletions) {
    offsets.push(rowCount - additions - 1);
  }
  if (additions > 0 && hunk.noEOFCRAdditions) {
    offsets.push(rowCount - 1);
  }
  return offsets;
}

function canHydrateCollapsedContext(
  fileDiff: FileDiffMetadata,
  hasFileLoader: boolean
): boolean {
  return (
    fileDiff.isPartial &&
    hasFileLoader &&
    (fileDiff.type === 'change' || fileDiff.type === 'rename-changed')
  );
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
