import { DEFAULT_THEMES } from '../constants';
import type { MergeConflictActionTarget } from '../managers/InteractionManager';
import { pluckInteractionOptions } from '../managers/InteractionManager';
import type { HunksRenderResult } from '../renderers/DiffHunksRenderer';
import {
  UnresolvedFileHunksRenderer,
  type UnresolvedFileHunksRendererOptions,
} from '../renderers/UnresolvedFileHunksRenderer';
import type {
  FileContents,
  FileDiffMetadata,
  MergeConflictActionPayload,
  MergeConflictMarkerRow,
  MergeConflictResolution,
  PostRenderPhase,
} from '../types';
import { areFilesEqual } from '../utils/areFilesEqual';
import { areMergeConflictActionsEqual } from '../utils/areMergeConflictActionsEqual';
import { createAnnotationWrapperNode } from '../utils/createAnnotationWrapperNode';
import { getMergeConflictActionSlotName } from '../utils/getMergeConflictActionSlotName';
import {
  buildMergeConflictMarkerRows,
  getMergeConflictActionAnchor,
  type MergeConflictDiffAction,
  parseMergeConflictDiffFromFile,
} from '../utils/parseMergeConflictDiffFromFile';
import { resolveConflict as resolveConflictDiff } from '../utils/resolveConflict';
import { shouldUseTokenTransformer } from '../utils/shouldUseTokenTransformer';
import { splitFileContents } from '../utils/splitFileContents';
import type { WorkerPoolManager } from '../worker';
import {
  FileDiff,
  type FileDiffOptions,
  type FileDiffRenderBaseProps,
} from './FileDiff';

export type RenderMergeConflictActions<LAnnotation> = (
  action: MergeConflictDiffAction,
  instance: UnresolvedFile<LAnnotation>
) => HTMLElement | DocumentFragment | null | undefined;

export type MergeConflictActionsTypeOption<LAnnotation> =
  | 'none'
  | 'default'
  | RenderMergeConflictActions<LAnnotation>;

export interface UnresolvedFileOptions<LAnnotation> extends Omit<
  FileDiffOptions<LAnnotation, undefined>,
  'diffStyle' | 'onPostRender'
> {
  onPostRender?(
    node: HTMLElement,
    instance: UnresolvedFile<LAnnotation>,
    phase: PostRenderPhase
  ): unknown;
  mergeConflictActionsType?: MergeConflictActionsTypeOption<LAnnotation>;
  onMergeConflictAction?(
    payload: MergeConflictActionPayload,
    instance: UnresolvedFile<LAnnotation>
  ): void;
  onMergeConflictResolve?(
    file: FileContents,
    payload: MergeConflictActionPayload
  ): void;
  maxContextLines?: number;
}

export interface UnresolvedFileRenderProps<
  LAnnotation,
> extends FileDiffRenderBaseProps<LAnnotation> {
  file?: FileContents;
  actions?: (MergeConflictDiffAction | undefined)[];
  markerRows?: MergeConflictMarkerRow[];
}

export interface UnresolvedFileHydrationProps<LAnnotation> extends Omit<
  UnresolvedFileRenderProps<LAnnotation>,
  'file'
> {
  file?: FileContents;
  fileContainer: HTMLElement;
  prerenderedHTML?: string;
}

interface MergeConflictActionElementCache {
  element: HTMLElement;
  action: MergeConflictDiffAction;
}

interface GetOrComputeDiffProps {
  file: FileContents | undefined;
  fileDiff: FileDiffMetadata | undefined;
  actions: (MergeConflictDiffAction | undefined)[] | undefined;
  markerRows: MergeConflictMarkerRow[] | undefined;
}

interface GetOrComputeDiffResult {
  fileDiff: FileDiffMetadata;
  actions: (MergeConflictDiffAction | undefined)[];
  markerRows: MergeConflictMarkerRow[];
}

interface ResolveConflictReturn {
  file: FileContents;
  fileDiff: FileDiffMetadata;
  actions: (MergeConflictDiffAction | undefined)[];
  markerRows: MergeConflictMarkerRow[];
}

type UnresolvedFileDataCache = GetOrComputeDiffProps;

let instanceId = -1;

export class UnresolvedFile<LAnnotation = undefined> extends FileDiff<
  LAnnotation,
  undefined
> {
  override readonly __id: string = `unresolved-file:${++instanceId}`;
  override readonly type = 'unresolved-file';

  protected computedCache: UnresolvedFileDataCache = {
    file: undefined,
    fileDiff: undefined,
    actions: undefined,
    markerRows: undefined,
  };
  private conflictActions: (MergeConflictDiffAction | undefined)[] = [];
  private conflictActionCache: Map<string, MergeConflictActionElementCache> =
    new Map();

  constructor(
    public override options: UnresolvedFileOptions<LAnnotation> = {
      theme: DEFAULT_THEMES,
    },
    workerManager?: WorkerPoolManager | undefined,
    isContainerManaged = false
  ) {
    super(undefined, workerManager, isContainerManaged);
    this.setOptions(options);
  }

  override setOptions(
    options: UnresolvedFileOptions<LAnnotation> | undefined
  ): void {
    if (options == null) {
      return;
    }

    if (
      options.onMergeConflictAction != null &&
      options.onMergeConflictResolve != null
    ) {
      throw new Error(
        'UnresolvedFile: onMergeConflictAction and onMergeConflictResolve are mutually exclusive. Use only one callback.'
      );
    }

    this.options = options;
    this.hunksRenderer.setOptions(this.getHunksRendererOptions(options));
    this.syncInteractionOptions();
  }

  // UnresolvedFile adds a merge-conflict-action click handler to the
  // InteractionManager. FileDiff.syncInteractionOptions() re-runs on every
  // re-render and during hydration; without this override it would rebuild the
  // interaction options without that handler, so resolving one conflict (which
  // re-renders the diff) would silently disable every remaining action button.
  protected override syncInteractionOptions(): void {
    this.interactionManager.setOptions(
      pluckInteractionOptions(
        this.options,
        typeof this.options.hunkSeparators === 'function' ||
          (this.options.hunkSeparators ?? 'line-info') === 'line-info' ||
          this.options.hunkSeparators === 'line-info-basic'
          ? this.handleExpandHunk
          : undefined,
        this.getLineIndex,
        this.handleMergeConflictActionClick
      )
    );
  }

  protected override createHunksRenderer(
    options: UnresolvedFileOptions<LAnnotation>
  ): UnresolvedFileHunksRenderer<LAnnotation> {
    return new UnresolvedFileHunksRenderer<LAnnotation>(
      this.getHunksRendererOptions(options),
      this.getAnnotationSlotName,
      this.handleHighlightRender,
      this.workerManager
    );
  }

  protected override getHunksRendererOptions(
    options: UnresolvedFileOptions<LAnnotation>
  ): UnresolvedFileHunksRendererOptions {
    return getUnresolvedDiffHunksRendererOptions(options, this.options);
  }

  protected override applyPreNodeAttributes(
    pre: HTMLPreElement,
    result: HunksRenderResult
  ): void {
    super.applyPreNodeAttributes(pre, result, {
      'data-has-merge-conflict': '',
    });
  }

  override cleanUp(): void {
    this.emitPostRender(true);
    this.clearMergeConflictActionCache();
    this.computedCache = {
      file: undefined,
      fileDiff: undefined,
      actions: undefined,
      markerRows: undefined,
    };
    this.conflictActions = [];
    super.cleanUp();
  }

  private getOrComputeDiff({
    file,
    fileDiff,
    actions,
    markerRows,
  }: GetOrComputeDiffProps): GetOrComputeDiffResult | undefined {
    const { maxContextLines, onMergeConflictAction } = this.options;
    const cachedFile = this.computedCache.file;
    // We are dealing with a controlled component
    if (onMergeConflictAction != null) {
      const hasFileDiff = fileDiff != null;
      if (
        hasFileDiff !== (actions != null) ||
        hasFileDiff !== (markerRows != null)
      ) {
        throw new Error(
          'UnresolvedFile.getOrComputeDiff: fileDiff, actions, and markerRows must be passed together'
        );
      }
      // If we were provided a new fileDiff/actions/markerRows, we are a FULLY
      // controlled component, which means we will not do any computation
      if (fileDiff != null && actions != null && markerRows != null) {
        this.computedCache = {
          file: file ?? cachedFile,
          fileDiff,
          actions,
          markerRows,
        };
      }
      // If we were provided a new file, we should attempt to parse out a new
      // diff/actions if we haven't computed it before. Once we initialize from
      // a file, later updates must flow through fileDiff/actions instead of
      // reparsing from a new file input. Otherwise we use the cache as is.
      else if (file != null || cachedFile != null) {
        if (
          file != null &&
          cachedFile != null &&
          !areFilesEqual(file, cachedFile) &&
          this.computedCache.fileDiff != null &&
          this.computedCache.actions != null
        ) {
          throw new Error(
            'UnresolvedFile.getOrComputeDiff: file can only be used to initialize unresolved state once. Pass fileDiff and actions for subsequent updates.'
          );
        }
        const sourceFile = file ?? cachedFile;
        if (
          sourceFile != null &&
          (!areFilesEqual(sourceFile, cachedFile) ||
            this.computedCache.fileDiff == null ||
            this.computedCache.actions == null)
        ) {
          const computed = parseMergeConflictDiffFromFile(
            sourceFile,
            maxContextLines
          );
          this.computedCache = {
            file: sourceFile,
            fileDiff: computed.fileDiff,
            actions: computed.actions,
            markerRows: computed.markerRows,
          };
        }
      }
    }
    // If we are uncontrolled we only rely on the file and only use the first
    // version. After that, the cached diff/action pair is the source of
    // truth and we should not accept a new file input.
    else {
      if (fileDiff != null || actions != null || markerRows != null) {
        throw new Error(
          'UnresolvedFile.getOrComputeDiff: fileDiff, actions, and markerRows are only usable in controlled mode, you must pass in `onMergeConflictAction`'
        );
      }
      if (
        file != null &&
        cachedFile != null &&
        !areFilesEqual(file, cachedFile)
      ) {
        throw new Error(
          'UnresolvedFile.getOrComputeDiff: uncontrolled unresolved files parse the file only once. Later updates must come from the cached diff state.'
        );
      }
      this.computedCache.file ??= file;
      if (
        this.computedCache.fileDiff == null &&
        this.computedCache.file != null
      ) {
        const computed = parseMergeConflictDiffFromFile(
          this.computedCache.file,
          maxContextLines
        );
        this.computedCache.fileDiff = computed.fileDiff;
        this.computedCache.actions = computed.actions;
        this.computedCache.markerRows = computed.markerRows;
      }
    }
    // The cache is now the source of truth in every mode
    ({ fileDiff, actions, markerRows } = this.computedCache);
    if (fileDiff == null || actions == null || markerRows == null) {
      return undefined;
    }
    return { fileDiff, actions, markerRows };
  }

  override hydrate(props: UnresolvedFileHydrationProps<LAnnotation>): void {
    const {
      file,
      fileDiff,
      actions,
      markerRows,
      lineAnnotations,
      fileContainer,
      prerenderedHTML,
      preventEmit = false,
    } = props;
    const source = this.getOrComputeDiff({
      file,
      fileDiff,
      actions,
      markerRows,
    });
    if (source == null) {
      return;
    }
    this.hydrateElements(fileContainer, prerenderedHTML);
    this.setActiveMergeConflictState(source.actions, source.markerRows);
    // If necessary hydration elements don't exist, we should assume a full
    // render
    if (
      (this.options.collapsed !== true && this.pre == null) ||
      (this.options.disableFileHeader !== true && this.headerElement == null)
    ) {
      this.render({ ...props, preventEmit: true });
    }
    // Otherwise orchestrate our setup
    else {
      this.hydrationSetup({ fileDiff: source.fileDiff, lineAnnotations });
      if (this.pre != null) {
        this.renderMergeConflictActionSlots();
      }
    }
    if (!preventEmit) {
      this.emitPostRender();
    }
  }

  override rerender(): void {
    if (!this.enabled || this.fileDiff == null) {
      return;
    }
    this.render({ forceRender: true, renderRange: this.renderRange });
  }

  override render(props: UnresolvedFileRenderProps<LAnnotation> = {}): boolean {
    const {
      file,
      fileDiff,
      actions,
      markerRows,
      lineAnnotations,
      preventEmit = false,
      ...rest
    } = props;
    const source = this.getOrComputeDiff({
      file,
      fileDiff,
      actions,
      markerRows,
    });
    if (source == null) {
      return false;
    }
    this.setActiveMergeConflictState(source.actions, source.markerRows);
    const didRender = super.render({
      ...rest,
      fileDiff: source.fileDiff,
      lineAnnotations,
      preventEmit: true,
    });
    if (didRender) {
      this.renderMergeConflictActionSlots();
      if (!preventEmit) {
        this.emitPostRender();
      }
    }
    return didRender;
  }

  public resolveConflict(
    conflictIndex: number,
    resolution: MergeConflictResolution,
    fileDiff: FileDiffMetadata | undefined = this.computedCache.fileDiff
  ): ResolveConflictReturn | undefined {
    const action = this.conflictActions[conflictIndex];
    if (fileDiff == null || action == null) {
      return undefined;
    }

    if (action.conflictIndex !== conflictIndex) {
      console.error({ conflictIndex, action });
      throw new Error(
        "UnresolvedFile.resolveConflict: conflictIndex and conflictAction don't match"
      );
    }

    const newFileDiff = resolveConflictDiff(fileDiff, action, resolution);
    const previousFile = this.computedCache.file;
    const { conflict } = action;
    const { startLineIndex, separatorLineIndex, endLineIndex } = conflict;
    const currentEndIndex = conflict.baseMarkerLineIndex ?? separatorLineIndex;
    const currentLineCount = currentEndIndex - startLineIndex - 1;
    const incomingLineCount = endLineIndex - separatorLineIndex - 1;
    const lineDelta =
      (resolution === 'current'
        ? currentLineCount
        : resolution === 'incoming'
          ? incomingLineCount
          : currentLineCount + incomingLineCount) -
      (endLineIndex - startLineIndex + 1);

    // The diff resolver keeps hunk/content group indexes stable, so later
    // conflicts only need their source line numbers shifted in the rebuilt
    // file text.
    const actions = this.conflictActions.map((other, index) => {
      if (index === conflictIndex || other == null) {
        return undefined;
      }
      const region = other.conflict;
      return region.startLineIndex > endLineIndex
        ? {
            ...other,
            conflict: {
              ...region,
              startLineIndex: region.startLineIndex + lineDelta,
              startLineNumber: region.startLineNumber + lineDelta,
              separatorLineIndex: region.separatorLineIndex + lineDelta,
              separatorLineNumber: region.separatorLineNumber + lineDelta,
              endLineIndex: region.endLineIndex + lineDelta,
              endLineNumber: region.endLineNumber + lineDelta,
              baseMarkerLineIndex:
                region.baseMarkerLineIndex != null
                  ? region.baseMarkerLineIndex + lineDelta
                  : undefined,
              baseMarkerLineNumber:
                region.baseMarkerLineNumber != null
                  ? region.baseMarkerLineNumber + lineDelta
                  : undefined,
            },
          }
        : other;
    });
    const markerRows = buildMergeConflictMarkerRows(newFileDiff, actions);

    // Rebuild the unresolved file text from the previous unresolved source so
    // the remaining marker blocks are preserved exactly.
    const lines = splitFileContents(previousFile?.contents ?? '');
    const currentLines = lines.slice(startLineIndex + 1, currentEndIndex);
    const incomingLines = lines.slice(separatorLineIndex + 1, endLineIndex);
    const replacementLines =
      resolution === 'current'
        ? currentLines
        : resolution === 'incoming'
          ? incomingLines
          : [...currentLines, ...incomingLines];

    return {
      file: {
        name: previousFile?.name ?? newFileDiff.name,
        contents: [
          ...lines.slice(0, startLineIndex),
          ...replacementLines,
          ...lines.slice(endLineIndex + 1),
        ].join(''),
        cacheKey:
          previousFile?.cacheKey != null
            ? `${previousFile.cacheKey}:mc-${conflictIndex}-${resolution}`
            : undefined,
      },
      fileDiff: newFileDiff,
      actions,
      markerRows,
    };
  }

  private setActiveMergeConflictState(
    actions: (MergeConflictDiffAction | undefined)[],
    markerRows: MergeConflictMarkerRow[]
  ): void {
    this.conflictActions = actions;
    if (
      this.computedCache.fileDiff != null &&
      this.hunksRenderer instanceof UnresolvedFileHunksRenderer
    ) {
      this.hunksRenderer.setConflictState(
        this.options.mergeConflictActionsType === 'none' ? [] : actions,
        markerRows,
        this.computedCache.fileDiff
      );
    }
  }

  private handleMergeConflictActionClick = ({
    conflictIndex,
    resolution,
  }: MergeConflictActionTarget): void => {
    const action = this.conflictActions[conflictIndex];
    if (action == null) {
      return;
    }
    if (action.conflictIndex !== conflictIndex) {
      console.error({ conflictIndex, action });
      throw new Error(
        "UnresolvedFile.handleMergeConflictActionClick: conflictIndex and conflictAction don't match"
      );
    }
    const payload: MergeConflictActionPayload = {
      resolution,
      conflict: action.conflict,
    };
    if (this.options.onMergeConflictAction != null) {
      this.options.onMergeConflictAction(payload, this);
      return;
    }
    const resolved = this.resolveConflict(conflictIndex, resolution);
    if (resolved == null) {
      return;
    }
    const { file, fileDiff, actions, markerRows } = resolved;
    this.computedCache = { file, fileDiff, actions, markerRows };
    this.setActiveMergeConflictState(actions, markerRows);
    // NOTE(amadeus): This is a bit jank, but helps to ensure we don't see a
    // bunch of jittery re-renders as things resolve out.  In a more perfect
    // world we would have a more elegant way to kick off a render to the
    // highlighter and then resolve actions in a cleaner way, but time is short
    // right now.  Can't let perfect be the enemy of good
    if (this.workerManager != null) {
      // Because we are using a workerManager, if we fire off the renderDiff
      // call, it will eventually get back to us in a callback which will
      // trigger a re-render
      this.hunksRenderer.renderDiff(fileDiff);
    } else {
      this.render({ forceRender: true });
    }
    this.options.onMergeConflictResolve?.(file, payload);
  };

  private renderMergeConflictActionSlots(): void {
    const { fileDiff } = this.computedCache;
    if (
      this.isContainerManaged ||
      this.fileContainer == null ||
      typeof this.options.mergeConflictActionsType !== 'function' ||
      this.conflictActions.length === 0 ||
      fileDiff == null
    ) {
      this.clearMergeConflictActionCache();
      return;
    }
    const staleActions = new Map(this.conflictActionCache);
    for (
      let actionIndex = 0;
      actionIndex < this.conflictActions.length;
      actionIndex++
    ) {
      const action = this.conflictActions[actionIndex];
      if (action == null) {
        continue;
      }
      if (action.conflictIndex !== actionIndex) {
        console.error({ conflictIndex: actionIndex, action });
        throw new Error(
          "UnresolvedFile.renderMergeConflictActionSlots: conflictIndex and conflictAction don't match"
        );
      }
      const anchor = getMergeConflictActionAnchor(action, fileDiff);
      if (anchor == null) {
        continue;
      }
      const slotName = getMergeConflictActionSlotName({
        hunkIndex: anchor.hunkIndex,
        lineIndex: anchor.lineIndex,
        conflictIndex: actionIndex,
      });
      const id = `${actionIndex}-${slotName}`;
      let cache = this.conflictActionCache.get(id);
      if (
        cache == null ||
        !areMergeConflictActionsEqual(cache.action, action)
      ) {
        cache?.element.remove();
        let rendered =
          typeof this.options.mergeConflictActionsType === 'function'
            ? this.options.mergeConflictActionsType(action, this)
            : undefined;
        if (
          typeof DocumentFragment !== 'undefined' &&
          rendered instanceof DocumentFragment
        ) {
          const wrapper = document.createElement('div');
          wrapper.style.display = 'contents';
          wrapper.appendChild(rendered);
          rendered = wrapper;
        }
        if (!(rendered instanceof HTMLElement)) {
          continue;
        }
        const element = createAnnotationWrapperNode(slotName);
        element.appendChild(rendered);
        this.fileContainer.appendChild(element);
        cache = { element, action };
        this.conflictActionCache.set(id, cache);
      }
      staleActions.delete(id);
    }
    for (const [id, { element }] of staleActions) {
      this.conflictActionCache.delete(id);
      element.remove();
    }
  }

  private clearMergeConflictActionCache(): void {
    for (const { element } of this.conflictActionCache.values()) {
      element.remove();
    }
    this.conflictActionCache.clear();
  }
}

// NOTE(amadeus): Should probably pull this out into a util, and make variants
// for all component types
export function getUnresolvedDiffHunksRendererOptions<LAnnotation>(
  options?: UnresolvedFileOptions<LAnnotation>,
  baseOptions?: UnresolvedFileOptions<LAnnotation>
): UnresolvedFileHunksRendererOptions {
  const merged = { ...baseOptions, ...options };
  return {
    ...merged,
    useTokenTransformer: shouldUseTokenTransformer<'diff'>(merged),
    hunkSeparators:
      typeof options?.hunkSeparators === 'function'
        ? 'custom'
        : options?.hunkSeparators,
    mergeConflictActionsType:
      typeof options?.mergeConflictActionsType === 'function'
        ? 'custom'
        : options?.mergeConflictActionsType,
  };
}
