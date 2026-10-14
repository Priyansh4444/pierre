import type {
  AnnotationSide,
  DiffLineEventBaseProps,
  DiffTokenEventBaseProps,
  ExpansionDirections,
  LineEventBaseProps,
  LineTypes,
  MergeConflictResolution,
  SelectedLineRange,
  SelectionPoint,
  SelectionSide,
  TokenEventBase,
} from '../types';
import { areSelectionPointsEqual } from '../utils/areSelectionPointsEqual';
import { areSelectionsEqual } from '../utils/areSelectionsEqual';
import { createGutterUtilityElement } from '../utils/createGutterUtilityElement';
import { hastToHtml } from '../utils/hastToHtml';
import { isGutterUtilityPath } from '../utils/isGutterUtilityPath';
import { dequeueRender, queueRender } from './UniversalRenderingManager';

interface TokenCache {
  tokenElement: HTMLElement;
  lineCharStart: number;
  lineCharEnd: number;
  tokenText: string;
}

interface ExpandCache {
  hunkIndex: number | undefined;
  direction: ExpansionDirections;
  all: boolean;
}

export type LogTypes = 'click' | 'move' | 'both' | 'none';

export type InteractionManagerMode = 'file' | 'diff';

export interface OnLineClickProps extends LineEventBaseProps {
  event: PointerEvent;
}

export interface OnLineEnterLeaveProps extends LineEventBaseProps {
  event: PointerEvent;
}

export interface OnDiffLineClickProps extends DiffLineEventBaseProps {
  event: PointerEvent;
}

export interface OnDiffLineEnterLeaveProps extends DiffLineEventBaseProps {
  event: PointerEvent;
}

export interface SelectionWriteOptions {
  notify?: boolean;
  // Limit the selected-line highlight to one side's column of a split diff.
  // It has no effect on unified or single-file views, whose one code column
  // carries no side attribute.
  activeLineSide?: SelectionSide;
  // Highlight only the gutter line number, not the line background.
  lineNumberOnly?: boolean;
}

interface EditorActiveLineWriteOptions {
  lineNumberOnly?: boolean;
  side?: SelectionSide;
}

export type GetLineIndexUtility = (
  lineNumber: number,
  side?: SelectionSide
) => [number, number] | undefined;

type EventClickProps<TMode extends InteractionManagerMode> =
  TMode extends 'file' ? OnLineClickProps : OnDiffLineClickProps;

type PointerEventEnterLeaveProps<TMode extends InteractionManagerMode> =
  TMode extends 'file' ? OnLineEnterLeaveProps : OnDiffLineEnterLeaveProps;

type EventBaseProps<TMode extends InteractionManagerMode> = TMode extends 'file'
  ? LineEventBaseProps
  : DiffLineEventBaseProps;

export type OnTokenEventProps<TMode extends InteractionManagerMode> =
  TMode extends 'file' ? TokenEventBase : DiffTokenEventBaseProps;

interface ExpandoEventProps {
  type: 'line-info';
  hunkIndex: number;
  direction: ExpansionDirections;
  all: boolean;
}

export type GetHoveredLineResult<TMode extends InteractionManagerMode> =
  TMode extends 'file'
    ? { lineNumber: number }
    : { lineNumber: number; side: AnnotationSide };

interface SelectionInfo {
  lineNumber: number;
  eventSide: SelectionSide | undefined;
  lineIndex: number;
}

type SelectionHitSource = 'event-path' | 'coordinates-first';

interface SelectionHitOptions {
  source: SelectionHitSource;
  excludeUtility?: boolean;
}

interface SelectionInfoOptions extends SelectionHitOptions {
  requireNumberColumn: boolean;
}

interface SelectionEnds {
  top: SelectionPoint;
  bottom: SelectionPoint;
}

interface LineRenderState {
  range: SelectedLineRange | null;
  highlightSide: SelectionSide | undefined;
  lineNumberOnly: boolean;
}

interface LineRenderColumn {
  content: HTMLElement;
  gutter: HTMLElement;
  renderEditorActiveLine: boolean;
  renderSelectedLines: boolean;
}

interface ResolvedLineTarget<TMode extends InteractionManagerMode> {
  kind: 'line';
  lineType: LineTypes;
  lineElement: HTMLElement;
  lineNumber: number;
  numberColumn: boolean;
  numberElement: HTMLElement;
  side: TMode extends 'diff' ? AnnotationSide : undefined;
  splitLineIndex: number | undefined;
}

interface ResolvedTokenTarget<TMode extends InteractionManagerMode> {
  kind: 'token';
  lineType: LineTypes;
  lineElement: HTMLElement;
  lineNumber: number;
  numberColumn: boolean;
  numberElement: HTMLElement;
  side: TMode extends 'diff' ? AnnotationSide : undefined;
  splitLineIndex: number | undefined;
  tokenElement: HTMLElement;
  tokenText: string;
  lineCharStart: number;
  lineCharEnd: number;
}

export interface MergeConflictActionTarget {
  kind: 'merge-conflict-action';
  resolution: MergeConflictResolution;
  conflictIndex: number;
}

type ResolvedPointerTarget<TMode extends InteractionManagerMode> =
  | ResolvedLineTarget<TMode>
  | ResolvedTokenTarget<TMode>
  | ExpandoEventProps
  | MergeConflictActionTarget;

type LinePointerTarget<TMode extends InteractionManagerMode> =
  ResolvedLineTarget<TMode>;

type TokenPointerTarget<TMode extends InteractionManagerMode> =
  ResolvedTokenTarget<TMode>;

type HoverableLinePointerTarget<TMode extends InteractionManagerMode> =
  | LinePointerTarget<TMode>
  | TokenPointerTarget<TMode>;

interface SessionIdle {
  mode: 'idle';
}

interface SessionSelecting {
  mode: 'selecting';
  pointerId: number;
}

interface SessionPendingSingleLineUnselect {
  mode: 'pendingSingleLineUnselect';
  pointerId: number;
  anchor: SelectionPoint;
  pending: SelectionPoint;
}

interface SessionGutterSelecting {
  mode: 'gutterSelecting';
  pointerId: number;
  anchor: SelectionPoint;
  current: SelectionPoint;
}

type PointerSession =
  | SessionIdle
  | SessionSelecting
  | SessionPendingSingleLineUnselect
  | SessionGutterSelecting;

export interface InteractionManagerBaseOptions<
  TMode extends InteractionManagerMode,
> {
  lineHoverHighlight?: 'disabled' | 'both' | 'number' | 'line';
  enableTokenInteractionsOnWhitespace?: boolean;
  enableGutterUtility?: boolean;
  onGutterUtilityClick?(range: SelectedLineRange): unknown;
  onLineClick?(props: EventClickProps<TMode>): unknown;
  onLineNumberClick?(props: EventClickProps<TMode>): unknown;
  onLineEnter?(props: PointerEventEnterLeaveProps<TMode>): unknown;
  onLineLeave?(props: PointerEventEnterLeaveProps<TMode>): unknown;
  onTokenClick?(props: OnTokenEventProps<TMode>, event: MouseEvent): unknown;
  onTokenEnter?(props: OnTokenEventProps<TMode>, event: PointerEvent): unknown;
  onTokenLeave?(props: OnTokenEventProps<TMode>, event: PointerEvent): unknown;
  __debugPointerEvents?: LogTypes;
  enableLineSelection?: boolean;
  controlledSelection?: boolean;
  onLineSelected?: (range: SelectedLineRange | null) => void;
  onLineSelectionStart?: (range: SelectedLineRange | null) => void;
  onLineSelectionChange?: (range: SelectedLineRange | null) => void;
  onLineSelectionEnd?: (range: SelectedLineRange | null) => void;
  getLineIndex?: GetLineIndexUtility;
}

export interface InteractionManagerOptions<
  TMode extends InteractionManagerMode,
> extends InteractionManagerBaseOptions<TMode> {
  usesCustomGutterUtility?: boolean;
  onHunkExpand?(
    hunkIndex: number,
    direction: ExpansionDirections,
    expansionLineCountOverride?: number
  ): unknown;
  onMergeConflictActionClick?(target: MergeConflictActionTarget): void;
}

export class InteractionManager<TMode extends InteractionManagerMode> {
  private hoveredLine: EventBaseProps<TMode> | undefined;
  private hoveredToken: OnTokenEventProps<TMode> | undefined;
  private pre: HTMLPreElement | undefined;

  private gutterUtilityLine: EventBaseProps<TMode> | undefined;
  private gutterUtilityContainer: HTMLDivElement | undefined;
  private gutterUtilityButton: HTMLButtonElement | undefined;
  private gutterUtilitySlot: HTMLSlotElement | undefined;

  private interactiveLinesAttr = false;
  private interactiveLineNumbersAttr = false;

  private hasPointerListeners = false;
  private hasDocumentPointerListeners = false;

  private selectedRange: SelectedLineRange | null = null;
  private selectedRangeHighlightSide: SelectionSide | undefined;
  private selectedRangeLineNumberOnly = false;
  // Editor caret highlights are retained separately so selected lines and the
  // cursor line can render without overwriting each other.
  private editorActiveLine: number | null = null;
  private editorActiveLineSide: SelectionSide | undefined;
  private editorLineNumberOnly = false;
  private proposedSelectedRange: SelectedLineRange | null | undefined;
  private renderedSelectedLinesState: LineRenderState | undefined;
  private renderedEditorActiveLineState: LineRenderState | undefined;
  private selectionAnchor: SelectionPoint | undefined;
  private pointerSession: PointerSession = { mode: 'idle' };

  constructor(
    private mode: TMode,
    private options: InteractionManagerOptions<TMode>
  ) {}

  setOptions(options: InteractionManagerOptions<TMode>): void {
    this.options = options;
  }

  cleanUp(): void {
    this.pre?.removeEventListener('click', this.handlePointerClick);
    this.pre?.removeEventListener('pointerdown', this.handlePointerDown);
    this.pre?.removeEventListener('pointermove', this.handlePointerMove);
    this.pre?.removeEventListener('pointerleave', this.handlePointerLeave);
    this.pre?.removeAttribute('data-interactive-lines');
    this.pre?.removeAttribute('data-interactive-line-numbers');
    this.pre = undefined;
    this.removeGutterUtility();
    this.clearHoveredLine();
    this.hoveredToken = undefined;
    this.detachDocumentPointerListeners();
    this.clearPointerSession();
    dequeueRender(this.renderSelection);
    this.interactiveLinesAttr = false;
    this.interactiveLineNumbersAttr = false;
    this.hasPointerListeners = false;
    this.setSelectionDirty();
  }

  setup(pre: HTMLPreElement): void {
    this.setSelectionDirty();
    const { usesCustomGutterUtility = false, enableGutterUtility = false } =
      this.options;

    const newContainer = this.pre !== pre;
    if (newContainer) {
      this.cleanUp();
      this.pre = pre;
    }

    if (enableGutterUtility) {
      this.ensureGutterUtilityNode(usesCustomGutterUtility);
    } else if (this.gutterUtilityContainer != null) {
      this.removeGutterUtility();
      if (this.pointerSession.mode === 'gutterSelecting') {
        this.clearPointerSession();
        this.detachDocumentPointerListeners();
      }
    }

    this.syncPointerListeners(pre);
    this.updateInteractiveLineAttributes();
    this.renderSelection();
    this.placeUtility();
  }

  private removeGutterUtility(): void {
    this.gutterUtilityContainer?.remove();
    this.gutterUtilityLine = undefined;
    this.gutterUtilityContainer = undefined;
    this.gutterUtilityButton = undefined;
    this.gutterUtilitySlot = undefined;
  }

  setSelectionDirty(): void {
    this.renderedSelectedLinesState = undefined;
    this.renderedEditorActiveLineState = undefined;
  }

  isSelectionDirty(): boolean {
    return (
      this.renderedSelectedLinesState === undefined ||
      this.renderedEditorActiveLineState === undefined
    );
  }

  setSelection(
    range: SelectedLineRange | null,
    options?: SelectionWriteOptions
  ): void {
    const isRangeChange = !(
      range === this.selectedRange ||
      areSelectionsEqual(range ?? undefined, this.selectedRange ?? undefined)
    );
    const lineNumberOnly = options?.lineNumberOnly ?? false;
    const isStyleChange =
      options?.activeLineSide !== this.selectedRangeHighlightSide ||
      lineNumberOnly !== this.selectedRangeLineNumberOnly;
    if (!this.isSelectionDirty() && !isRangeChange && !isStyleChange) {
      return;
    }
    this.proposedSelectedRange = undefined;
    this.selectedRange = range;
    this.selectedRangeHighlightSide = options?.activeLineSide;
    this.selectedRangeLineNumberOnly = lineNumberOnly;
    this.renderSelection();
    this.placeUtility();
    if (isRangeChange && options?.notify !== false) {
      this.options.onLineSelected?.(range);
    }
  }

  // Update the editor caret decoration without changing selected lines,
  // callbacks, or gutter utility placement.
  setEditorActiveLine(
    lineNumber: number | null,
    { lineNumberOnly = false, side }: EditorActiveLineWriteOptions = {}
  ): void {
    const isLineChange = lineNumber !== this.editorActiveLine;
    const isStyleChange =
      side !== this.editorActiveLineSide ||
      lineNumberOnly !== this.editorLineNumberOnly;
    if (!this.isSelectionDirty() && !isLineChange && !isStyleChange) {
      return;
    }
    this.editorActiveLine = lineNumber;
    this.editorActiveLineSide = side;
    this.editorLineNumberOnly = lineNumberOnly;
    this.renderSelection();
  }

  getSelection(): SelectedLineRange | null {
    return this.selectedRange;
  }

  getHoveredLine = (): GetHoveredLineResult<TMode> | undefined => {
    const gutterUtilityLine = this.gutterUtilityLine ?? this.hoveredLine;
    if (gutterUtilityLine != null) {
      if (this.mode === 'diff' && gutterUtilityLine.type === 'diff-line') {
        return {
          lineNumber: gutterUtilityLine.lineNumber,
          side: gutterUtilityLine.annotationSide,
        } as GetHoveredLineResult<TMode>;
      }
      if (this.mode === 'file' && gutterUtilityLine.type === 'line') {
        return {
          lineNumber: gutterUtilityLine.lineNumber,
        } as GetHoveredLineResult<TMode>;
      }
    }
    return undefined;
  };

  handlePointerClick = (event: MouseEvent): void => {
    const {
      onHunkExpand,
      onLineClick,
      onLineNumberClick,
      onTokenClick,
      onMergeConflictActionClick,
    } = this.options;
    if (
      onHunkExpand == null &&
      onLineClick == null &&
      onLineNumberClick == null &&
      onMergeConflictActionClick == null &&
      onTokenClick == null
    ) {
      return;
    }
    if (
      this.options.onGutterUtilityClick != null &&
      isGutterUtilityPath(event.composedPath())
    ) {
      return;
    }
    debugLogIfEnabled(
      this.options.__debugPointerEvents,
      'click',
      'FileDiff.DEBUG.handlePointerClick:',
      event
    );
    this.handlePointerEvent('click', event);
  };

  handlePointerMove = (event: PointerEvent): void => {
    // Touch and pen moves are active drag/scroll gestures, not hover. Keeping
    // hover mouse-only prevents content scrolls from leaving stale utilities.
    if (event.pointerType !== 'mouse') {
      return;
    }

    const {
      lineHoverHighlight = 'disabled',
      onLineEnter,
      onLineLeave,
      onTokenEnter,
      onTokenLeave,
      enableGutterUtility = false,
    } = this.options;
    if (
      lineHoverHighlight === 'disabled' &&
      !enableGutterUtility &&
      onLineEnter == null &&
      onLineLeave == null &&
      onTokenEnter == null &&
      onTokenLeave == null
    ) {
      return;
    }
    debugLogIfEnabled(
      this.options.__debugPointerEvents,
      'move',
      'FileDiff.DEBUG.handlePointerMove:',
      event
    );
    // should we perhaps throttle this a bit because move can be fast as fuk
    // boiiii
    this.handlePointerEvent('move', event);
  };

  handlePointerLeave = (event: PointerEvent): void => {
    const { __debugPointerEvents } = this.options;
    debugLogIfEnabled(
      __debugPointerEvents,
      'move',
      'FileDiff.DEBUG.handlePointerLeave: no event'
    );
    if (this.hoveredLine == null && this.hoveredToken == null) {
      debugLogIfEnabled(
        __debugPointerEvents,
        'move',
        'FileDiff.DEBUG.handlePointerLeave: returned early, no hovered line or token'
      );
      return;
    }
    if (this.hoveredToken != null) {
      this.options.onTokenLeave?.(this.hoveredToken, event);
      this.hoveredToken = undefined;
    }

    if (this.hoveredLine != null) {
      this.options.onLineLeave?.({
        ...this.hoveredLine,
        event,
      } as PointerEventEnterLeaveProps<TMode>);
      this.clearHoveredLine();
    }
    this.placeUtility();
  };

  private handlePointerEvent(
    eventType: 'click' | 'move',
    event: PointerEvent | MouseEvent
  ) {
    const { __debugPointerEvents } = this.options;
    const composedPath = event.composedPath();
    debugLogIfEnabled(
      __debugPointerEvents,
      eventType,
      'FileDiff.DEBUG.handlePointerEvent:',
      { eventType, composedPath }
    );
    const target = this.resolvePointerTarget(composedPath);
    debugLogIfEnabled(
      __debugPointerEvents,
      eventType,
      'FileDiff.DEBUG.handlePointerEvent: resolvePointerTarget result:',
      target
    );

    const {
      onLineClick,
      onLineNumberClick,
      onLineEnter,
      onLineLeave,
      onTokenClick,
      onTokenEnter,
      onTokenLeave,
      onHunkExpand,
      onMergeConflictActionClick,
    } = this.options;

    switch (eventType) {
      case 'move': {
        const sameLine =
          isHoverableLinePointerTarget(target) &&
          this.hoveredLine?.lineElement === target.lineElement;
        const sameToken =
          isTokenPointerTarget(target) &&
          this.hoveredToken?.tokenElement === target.tokenElement;

        // Handle token transitions
        if (!sameToken) {
          if (this.hoveredToken != null) {
            onTokenLeave?.(this.hoveredToken, event as PointerEvent);
            this.hoveredToken = undefined;
          }
          if (isTokenPointerTarget(target)) {
            this.hoveredToken = this.toTokenEventBaseProps(target);
            onTokenEnter?.(this.hoveredToken, event as PointerEvent);
          }
        }

        // Handle line transitions
        if (!sameLine) {
          if (this.hoveredLine != null) {
            onLineLeave?.({
              ...this.hoveredLine,
              event: event as PointerEvent,
            } as PointerEventEnterLeaveProps<TMode>);
            this.clearHoveredLine();
          }
          if (isHoverableLinePointerTarget(target)) {
            this.clearHoveredLine();
            const hoveredLine = this.toEventBaseProps(target);
            this.hoveredLine = hoveredLine;
            const { lineHoverHighlight } = this.options;
            if (
              lineHoverHighlight === 'both' ||
              lineHoverHighlight === 'line'
            ) {
              hoveredLine.lineElement.setAttribute('data-hovered', '');
            }
            if (
              lineHoverHighlight === 'both' ||
              lineHoverHighlight === 'number'
            ) {
              hoveredLine.numberElement.setAttribute('data-hovered', '');
            }
            this.placeUtility();
            onLineEnter?.({
              ...hoveredLine,
              event: event as PointerEvent,
            } as PointerEventEnterLeaveProps<TMode>);
          } else {
            this.placeUtility();
          }
        }
        break;
      }
      case 'click': {
        if (target == null) {
          break;
        }
        if (
          isMergeConflictActionPointerTarget(target) &&
          onMergeConflictActionClick != null
        ) {
          onMergeConflictActionClick(target);
          break;
        }
        if (isExpandoPointerTarget(target) && onHunkExpand != null) {
          onHunkExpand(
            target.hunkIndex,
            target.all || event.shiftKey ? 'both' : target.direction,
            target.all || event.shiftKey ? Number.POSITIVE_INFINITY : undefined
          );
          break;
        }

        if (!isHoverableLinePointerTarget(target)) {
          break;
        }

        if (isTokenPointerTarget(target) && onTokenClick != null) {
          onTokenClick(this.toTokenEventBaseProps(target), event);
        }

        const clickProps = {
          ...this.toEventBaseProps(target),
          event: event as PointerEvent,
        } as EventClickProps<TMode>;
        if (onLineNumberClick != null && target.numberColumn) {
          onLineNumberClick(clickProps);
        } else {
          onLineClick?.(clickProps);
        }
        break;
      }
    }
  }

  private syncPointerListeners(pre: HTMLPreElement): void {
    const {
      __debugPointerEvents,
      lineHoverHighlight = 'disabled',
      onLineClick,
      onLineNumberClick,
      onLineEnter,
      onLineLeave,
      onTokenClick,
      onTokenEnter,
      onTokenLeave,
      onHunkExpand,
      onMergeConflictActionClick,
      enableGutterUtility = false,
      enableLineSelection = false,
      onGutterUtilityClick,
    } = this.options;
    const enableGutterSelection = onGutterUtilityClick != null;
    const shouldAttachPointerListeners =
      lineHoverHighlight !== 'disabled' ||
      onLineClick != null ||
      onLineNumberClick != null ||
      onLineEnter != null ||
      onLineLeave != null ||
      onTokenClick != null ||
      onTokenEnter != null ||
      onTokenLeave != null ||
      onHunkExpand != null ||
      onMergeConflictActionClick != null ||
      enableGutterUtility ||
      enableLineSelection ||
      enableGutterSelection;

    if (shouldAttachPointerListeners && !this.hasPointerListeners) {
      pre.addEventListener('click', this.handlePointerClick);
      pre.addEventListener('pointerdown', this.handlePointerDown);
      pre.addEventListener('pointermove', this.handlePointerMove);
      pre.addEventListener('pointerleave', this.handlePointerLeave);
      this.hasPointerListeners = true;

      debugLogIfEnabled(
        __debugPointerEvents,
        'click',
        'FileDiff.DEBUG.attachEventListeners: Attaching click events for:',
        [
          onLineClick != null && 'onLineClick',
          onLineNumberClick != null && 'onLineNumberClick',
          onHunkExpand != null && 'expandable hunk separators',
          onMergeConflictActionClick != null && 'merge conflict actions',
        ].filter(Boolean)
      );
      debugLogIfEnabled(
        __debugPointerEvents,
        'move',
        'FileDiff.DEBUG.attachEventListeners: Attaching pointer move event'
      );
      debugLogIfEnabled(
        __debugPointerEvents,
        'move',
        'FileDiff.DEBUG.attachEventListeners: Attaching pointer leave event'
      );
    } else if (!shouldAttachPointerListeners && this.hasPointerListeners) {
      pre.removeEventListener('click', this.handlePointerClick);
      pre.removeEventListener('pointerdown', this.handlePointerDown);
      pre.removeEventListener('pointermove', this.handlePointerMove);
      pre.removeEventListener('pointerleave', this.handlePointerLeave);
      this.hasPointerListeners = false;
    }

    const { mode } = this.pointerSession;
    if (
      (!enableLineSelection &&
        (mode === 'selecting' || mode === 'pendingSingleLineUnselect')) ||
      (!enableGutterSelection && mode === 'gutterSelecting')
    ) {
      this.clearPointerSession();
      this.detachDocumentPointerListeners();
      this.selectionAnchor = undefined;
    }
  }

  private updateInteractiveLineAttributes(): void {
    if (this.pre == null) {
      return;
    }

    const {
      onLineClick,
      onLineNumberClick,
      enableLineSelection = false,
    } = this.options;

    const shouldHaveInteractiveLines = onLineClick != null;
    const shouldHaveInteractiveLineNumbers =
      onLineNumberClick != null || enableLineSelection;

    if (shouldHaveInteractiveLines && !this.interactiveLinesAttr) {
      this.pre.setAttribute('data-interactive-lines', '');
      this.interactiveLinesAttr = true;
    } else if (!shouldHaveInteractiveLines && this.interactiveLinesAttr) {
      this.pre.removeAttribute('data-interactive-lines');
      this.interactiveLinesAttr = false;
    }

    if (shouldHaveInteractiveLineNumbers && !this.interactiveLineNumbersAttr) {
      this.pre.setAttribute('data-interactive-line-numbers', '');
      this.interactiveLineNumbersAttr = true;
    } else if (
      !shouldHaveInteractiveLineNumbers &&
      this.interactiveLineNumbersAttr
    ) {
      this.pre.removeAttribute('data-interactive-line-numbers');
      this.interactiveLineNumbersAttr = false;
    }
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (
      (event.pointerType === 'mouse' && event.button !== 0) ||
      this.pre == null ||
      this.pointerSession.mode !== 'idle'
    ) {
      return;
    }

    const path = event.composedPath();
    if (
      isGutterUtilityPath(path) &&
      this.options.onGutterUtilityClick != null
    ) {
      this.startGutterSelectionFromPointerDown(event);
    } else {
      if (event.pointerType !== 'mouse' && !this.placeUtilityFromSelection()) {
        const target = this.resolvePointerTarget(path);
        if (isLinePointerTarget(target) && target.numberColumn) {
          this.showUtilityOnLine(this.toEventBaseProps(target));
        }
      }
      this.startLineSelectionFromPointerDown(event);
    }
  };

  private startLineSelectionFromPointerDown(event: PointerEvent): void {
    const { enableLineSelection = false } = this.options;
    if (!enableLineSelection) {
      return;
    }

    const pointerInfo = this.resolveSelectionInfo(event, {
      source: 'event-path',
      requireNumberColumn: true,
    });
    if (pointerInfo == null) {
      return;
    }

    // Intentionally no preventDefault here. The line-number gutter uses
    // `user-select: none`, so a drag that starts on it never begins a native
    // text selection. Calling preventDefault would also cancel the browser's
    // native focus change, which stops a focusable host wrapper from receiving
    // focus (and the keyboard events it needs) when a line number is clicked.
    const { lineNumber, eventSide, lineIndex } = pointerInfo;

    const { selectedRange } = this;
    if (event.shiftKey && selectedRange != null) {
      const rowRange = this.getIndexesFromSelection(
        selectedRange,
        this.isSplitDiff()
      );
      if (rowRange == null) {
        return;
      }
      const useStart =
        rowRange.start <= rowRange.end
          ? lineIndex >= rowRange.start
          : lineIndex <= rowRange.end;
      this.selectionAnchor = {
        lineNumber: useStart ? selectedRange.start : selectedRange.end,
        side: useStart
          ? selectedRange.side
          : (selectedRange.endSide ?? selectedRange.side),
      };
    } else if (
      selectedRange?.start === lineNumber &&
      selectedRange.end === lineNumber
    ) {
      const point = { lineNumber, side: eventSide };
      this.selectionAnchor = point;
      this.pointerSession = {
        mode: 'pendingSingleLineUnselect',
        pointerId: event.pointerId,
        anchor: point,
        pending: point,
      };
      this.attachDocumentPointerListeners();
      return;
    } else {
      if (this.options.controlledSelection === true) {
        this.proposedSelectedRange = null;
      } else {
        this.selectedRange = null;
      }
      this.placeUtility();
      this.selectionAnchor = { lineNumber, side: eventSide };
    }
    this.updateSelection(lineNumber, eventSide, false);
    this.options.onLineSelectionStart?.(this.getCurrentSelectionRange());
    this.pointerSession = { mode: 'selecting', pointerId: event.pointerId };
    this.attachDocumentPointerListeners();
  }

  private startGutterSelectionFromPointerDown(event: PointerEvent): void {
    // If a selection already exists, the utility represents that whole range.
    // Dragging should start from the visual top and extend from the visual
    // bottom, regardless of the direction the range was originally created.
    const selectedEndpoints = this.currentSelectionEnds();
    const point =
      selectedEndpoints?.bottom ??
      this.resolveSelectionPoint(event, {
        source: 'event-path',
        excludeUtility: false,
      });
    const anchor = selectedEndpoints?.top ?? point;
    if (point == null || anchor == null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.pointerSession = {
      mode: 'gutterSelecting',
      pointerId: event.pointerId,
      anchor,
      current: point,
    };
    this.selectionAnchor = anchor;
    this.updateSelection(point.lineNumber, point.side, false);
    this.options.onLineSelectionStart?.(this.getCurrentSelectionRange());
    this.attachDocumentPointerListeners();
  }

  private handleDocumentPointerMove = (event: PointerEvent): void => {
    const session = this.pointerSession;
    if (session.mode === 'idle' || event.pointerId !== session.pointerId) {
      return;
    }
    event.preventDefault();
    if (session.mode === 'gutterSelecting') {
      const point = this.resolveSelectionPoint(event, {
        source: 'coordinates-first',
      });
      if (point != null) {
        session.current = point;
        this.updateSelection(point.lineNumber, point.side);
      }
      return;
    }
    const pointerInfo = this.resolveSelectionInfo(event, {
      source: 'coordinates-first',
      requireNumberColumn: false,
    });
    if (pointerInfo == null || this.selectionAnchor == null) {
      return;
    }
    const { lineNumber, eventSide } = pointerInfo;
    if (session.mode === 'selecting') {
      this.updateSelection(lineNumber, eventSide);
      return;
    }
    if (
      areSelectionPointsEqual(session.pending, { lineNumber, side: eventSide })
    ) {
      return;
    }
    this.updateSelection(lineNumber, eventSide, false);
    this.options.onLineSelectionStart?.(this.getCurrentSelectionRange());
    this.options.onLineSelectionChange?.(this.getCurrentSelectionRange());
    this.pointerSession = { mode: 'selecting', pointerId: event.pointerId };
  };

  private handleDocumentPointerUp = (event: PointerEvent): void => {
    const { onGutterUtilityClick } = this.options;
    const session = this.pointerSession;
    if (session.mode === 'idle' || event.pointerId !== session.pointerId) {
      return;
    }
    event.preventDefault();
    switch (session.mode) {
      case 'gutterSelecting': {
        const point = this.resolveSelectionPoint(event, {
          source: 'coordinates-first',
        });
        if (point != null) {
          session.current = point;
          this.updateSelection(point.lineNumber, point.side);
        }
        // Keep the completed gesture stable when callbacks synchronously
        // replace the manager's controlled or uncontrolled selection.
        const completedRange = this.buildSelectionRange(
          session.anchor.lineNumber,
          session.current.lineNumber,
          session.anchor.side,
          session.current.side
        );
        onGutterUtilityClick?.({ ...completedRange });
        this.selectionAnchor = undefined;
        this.options.onLineSelectionEnd?.(completedRange);
        this.options.onLineSelected?.(completedRange);
        this.proposedSelectedRange = undefined;
        this.clearPointerSession();
        this.detachDocumentPointerListeners();
        return;
      }
      case 'pendingSingleLineUnselect': {
        this.updateSelection(null, undefined, false);
        this.selectionAnchor = undefined;
        this.clearPointerSession();
        this.detachDocumentPointerListeners();
        break;
      }
      case 'selecting': {
        this.selectionAnchor = undefined;
        this.detachDocumentPointerListeners();
        this.clearPointerSession();
      }
    }
    this.options.onLineSelectionEnd?.(this.getCurrentSelectionRange());
    this.options.onLineSelected?.(this.getCurrentSelectionRange());
    this.proposedSelectedRange = undefined;
  };

  private handleDocumentPointerCancel = (event: PointerEvent): void => {
    if (
      this.pointerSession.mode === 'idle' ||
      event.pointerId !== this.pointerSession.pointerId
    ) {
      return;
    }
    this.selectionAnchor = undefined;
    this.proposedSelectedRange = undefined;
    this.clearPointerSession();
    this.detachDocumentPointerListeners();
  };

  private clearHoveredLine() {
    if (this.hoveredLine == null) {
      return;
    }
    this.hoveredLine.lineElement.removeAttribute('data-hovered');
    this.hoveredLine.numberElement.removeAttribute('data-hovered');
    this.hoveredLine = undefined;
  }

  private ensureGutterUtilityNode(useCustomGutterUtility: boolean): void {
    if (this.gutterUtilityContainer == null) {
      this.gutterUtilityContainer = document.createElement('div');
      this.gutterUtilityContainer.setAttribute('data-gutter-utility-slot', '');
    }
    let utilityNode: HTMLElement;
    if (useCustomGutterUtility) {
      this.gutterUtilityButton?.remove();
      this.gutterUtilityButton = undefined;
      if (this.gutterUtilitySlot == null) {
        this.gutterUtilitySlot = document.createElement('slot');
        this.gutterUtilitySlot.name = 'gutter-utility-slot';
      }
      utilityNode = this.gutterUtilitySlot;
    } else {
      this.gutterUtilitySlot?.remove();
      this.gutterUtilitySlot = undefined;
      if (this.gutterUtilityButton == null) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = hastToHtml(createGutterUtilityElement());
        const utilityButton = tempDiv.firstElementChild;
        if (!(utilityButton instanceof HTMLButtonElement)) {
          throw new Error(
            'InteractionManager.ensureGutterUtilityNode: Node element should be a button'
          );
        }
        utilityButton.remove();
        this.gutterUtilityButton = utilityButton;
      }
      utilityNode = this.gutterUtilityButton;
    }
    if (utilityNode.parentNode !== this.gutterUtilityContainer) {
      this.gutterUtilityContainer.replaceChildren(utilityNode);
    }
  }

  // The gutter utility follows the active selection first because a selected
  // range is more stable than transient hover/touch state. Without a
  // selection, desktop hover and mobile tap reveal can still place it on a
  // single row.
  private placeUtility(): void {
    if (this.placeUtilityFromSelection()) {
      return;
    }
    if (this.hoveredLine != null) {
      this.showUtilityOnLine(this.hoveredLine);
      return;
    }
    this.hideUtility();
  }

  private placeUtilityFromSelection(): boolean {
    const endpoints = this.currentSelectionEnds();
    if (endpoints == null) {
      return false;
    }
    const target = this.targetForSelectionPoint(endpoints.bottom);
    if (target == null) {
      this.hideUtility();
    } else {
      this.showUtilityOnLine(this.toEventBaseProps(target));
    }
    return true;
  }

  private showUtilityOnLine(line: EventBaseProps<TMode>): void {
    if (this.gutterUtilityContainer == null) {
      return;
    }
    this.gutterUtilityLine = line;
    line.numberElement.appendChild(this.gutterUtilityContainer);
  }

  private hideUtility(): void {
    this.gutterUtilityContainer?.remove();
    this.gutterUtilityLine = undefined;
  }

  // Selection ranges preserve drag direction, so compare rendered row indexes to
  // find the visually top-most and bottom-most endpoints.
  private currentSelectionEnds(): SelectionEnds | undefined {
    const range = this.getCurrentSelectionRange();
    const rowRange =
      range != null
        ? this.getIndexesFromSelection(range, this.isSplitDiff())
        : undefined;
    if (range == null || rowRange == null) {
      return undefined;
    }
    const start = { lineNumber: range.start, side: range.side };
    const end = { lineNumber: range.end, side: range.endSide ?? range.side };
    return rowRange.start > rowRange.end
      ? { top: end, bottom: start }
      : { top: start, bottom: end };
  }

  private targetForSelectionPoint(
    point: SelectionPoint
  ): LinePointerTarget<TMode> | undefined {
    if (this.pre == null) {
      return undefined;
    }
    const indexes = this.getLineIndex(point.lineNumber, point.side);
    if (indexes == null) {
      return undefined;
    }
    const lineIndex =
      this.mode === 'diff' ? `${indexes[0]},${indexes[1]}` : `${indexes[0]}`;
    // Rebuild the real gutter-row target from the selection point so the
    // utility can anchor to the visible row even when the point came from
    // controlled state rather than a pointer event.
    const candidates = this.pre.querySelectorAll(
      `[data-column-number="${point.lineNumber}"][data-line-index="${lineIndex}"]`
    );
    for (const element of candidates) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }
      const target = this.resolvePointerTarget(getElementPath(element));
      if (!isLinePointerTarget(target)) {
        continue;
      }
      if (
        this.mode === 'diff' &&
        point.side != null &&
        target.side !== point.side
      ) {
        continue;
      }
      return target;
    }
    return undefined;
  }

  private attachDocumentPointerListeners(): void {
    if (this.hasDocumentPointerListeners) {
      return;
    }
    document.addEventListener('pointermove', this.handleDocumentPointerMove);
    document.addEventListener('pointerup', this.handleDocumentPointerUp);
    document.addEventListener(
      'pointercancel',
      this.handleDocumentPointerCancel
    );
    this.hasDocumentPointerListeners = true;
  }

  private detachDocumentPointerListeners(): void {
    if (!this.hasDocumentPointerListeners) {
      return;
    }
    document.removeEventListener('pointermove', this.handleDocumentPointerMove);
    document.removeEventListener('pointerup', this.handleDocumentPointerUp);
    document.removeEventListener(
      'pointercancel',
      this.handleDocumentPointerCancel
    );
    this.hasDocumentPointerListeners = false;
  }

  private clearPointerSession(): void {
    this.pointerSession = { mode: 'idle' };
  }

  private resolveSelectionInfo(
    event: PointerEvent,
    options: SelectionInfoOptions
  ): SelectionInfo | undefined {
    const path = this.resolveSelectionPath(event, options);
    const target = path != null ? this.resolvePointerTarget(path) : undefined;
    if (
      !isLinePointerTarget(target) ||
      (options.requireNumberColumn && !target.numberColumn) ||
      target.splitLineIndex == null
    ) {
      return undefined;
    }
    return {
      lineIndex: target.splitLineIndex,
      lineNumber: target.lineNumber,
      eventSide: this.mode === 'diff' ? target.side : undefined,
    };
  }

  private resolveSelectionPoint(
    event: PointerEvent,
    options: SelectionHitOptions
  ): SelectionPoint | undefined {
    const path = this.resolveSelectionPath(event, options);
    const target = path != null ? this.resolvePointerTarget(path) : undefined;
    return isLinePointerTarget(target)
      ? {
          lineNumber: target.lineNumber,
          side: this.mode === 'diff' ? target.side : undefined,
        }
      : undefined;
  }

  private resolveSelectionPath(
    event: PointerEvent,
    options: SelectionHitOptions
  ): (EventTarget | undefined)[] | undefined {
    const excludeUtility = options.excludeUtility !== false;
    if (options.source === 'coordinates-first') {
      // Touch pointers can keep dispatching move/up events to the element
      // where the drag began. Prefer the row currently under the finger, and
      // fall back to the event path only when coordinate hit-testing cannot
      // run at all (tests and older DOMs). A hit that is not a valid row
      // returns undefined so the last selected row stays sticky.
      const root = this.pre?.getRootNode();
      const hitRoot = hasElementFromPoint(root)
        ? root
        : hasElementFromPoint(document)
          ? document
          : undefined;
      if (
        hitRoot != null &&
        Number.isFinite(event.clientX) &&
        Number.isFinite(event.clientY)
      ) {
        const element = hitRoot.elementFromPoint(event.clientX, event.clientY);
        return element != null
          ? this.pathFromElement(element, excludeUtility)
          : undefined;
      }
    }
    return this.pathFromEventPath(event.composedPath(), excludeUtility);
  }

  private pathFromEventPath(
    path: (EventTarget | undefined)[],
    excludeUtility: boolean
  ): (EventTarget | undefined)[] | undefined {
    if (excludeUtility && isGutterUtilityPath(path)) {
      return undefined;
    }
    for (const element of path) {
      if (element instanceof Element) {
        return this.pathFromElement(element, excludeUtility);
      }
    }
    return undefined;
  }

  private pathFromElement(
    element: Element,
    excludeUtility: boolean
  ): (EventTarget | undefined)[] | undefined {
    const path = getElementPath(element);
    if (excludeUtility && isGutterUtilityPath(path)) {
      return undefined;
    }
    // Selection is row-based, not child-element-based. Lateral movement over
    // tokens, annotations, or line-number text should still update to the
    // nearest content or gutter row; anything else is ignored by returning
    // undefined.
    const row = element.closest('[data-line], [data-column-number]');
    if (row instanceof HTMLElement) {
      return getElementPath(row);
    }
    // Annotation hits, direct or through slotted content projected into the
    // shadow annotation row, resolve to the row above. Don't trust the slot
    // name for the line number: during an edit session an annotation keeps
    // its original name while edits move it to other lines, so parse the
    // name only as a fallback.
    const annotatedRow =
      getAnnotatedRow(
        element.closest(
          '[data-line-annotation], [data-gutter-buffer="annotation"]'
        )
      ) ?? getAnnotatedRow(annotationRowFromSlot(element));
    if (annotatedRow != null) {
      return getElementPath(annotatedRow);
    }
    const point = selectionPointFromAnnotationSlot(element);
    const target =
      point != null ? this.targetForSelectionPoint(point) : undefined;
    return target != null ? getElementPath(target.lineElement) : undefined;
  }

  private getLineIndex(
    lineNumber: number,
    side?: SelectionSide
  ): [number, number] | undefined {
    const { getLineIndex } = this.options;
    return getLineIndex != null
      ? getLineIndex(lineNumber, side)
      : [lineNumber - 1, lineNumber - 1];
  }

  private getCurrentSelectionRange(): SelectedLineRange | null {
    return this.proposedSelectedRange !== undefined
      ? this.proposedSelectedRange
      : this.selectedRange;
  }

  private updateSelection(
    currentLine: number | null,
    side?: SelectionSide,
    emitChange = true
  ): void {
    const nextRange =
      currentLine == null
        ? null
        : this.buildSelectionRange(
            this.selectionAnchor?.lineNumber ?? currentLine,
            currentLine,
            this.selectionAnchor?.side ?? side,
            side
          );
    if (
      areSelectionsEqual(
        this.getCurrentSelectionRange() ?? undefined,
        nextRange ?? undefined
      )
    ) {
      return;
    }
    this.selectedRangeHighlightSide = undefined;
    this.selectedRangeLineNumberOnly = false;
    if (this.options.controlledSelection === true) {
      this.proposedSelectedRange = nextRange;
    } else {
      this.selectedRange = nextRange;
      queueRender(this.renderSelection);
    }
    this.placeUtility();
    if (emitChange) {
      this.options.onLineSelectionChange?.(this.getCurrentSelectionRange());
    }
  }

  private getIndexesFromSelection(
    selectedRange: SelectedLineRange,
    split: boolean
  ): { start: number; end: number } | undefined {
    if (this.pre == null) {
      return undefined;
    }
    const startIndexes = this.getLineIndex(
      selectedRange.start,
      selectedRange.side
    );
    const finalIndexes = this.getLineIndex(
      selectedRange.end,
      selectedRange.endSide ?? selectedRange.side
    );

    return startIndexes != null && finalIndexes != null
      ? {
          start: split ? startIndexes[1] : startIndexes[0],
          end: split ? finalIndexes[1] : finalIndexes[0],
        }
      : undefined;
  }

  // Resolve a desired line range before touching the last successful DOM
  // state, so a transient line-index mismatch leaves that rendering intact and
  // dirty.
  private resolveLineRenderRange(
    state: LineRenderState,
    split: boolean,
    source: 'selected-lines' | 'editor-active-line'
  ): { start: number; end: number } | undefined {
    if (state.range == null) {
      return undefined;
    }
    const rowRange = this.getIndexesFromSelection(state.range, split);
    if (rowRange == null) {
      console.error({ rowRange, range: state.range });
      throw new Error(
        `InteractionManager.renderSelection: No valid ${source} rowRange`
      );
    }
    return rowRange;
  }

  private renderSelection = (): void => {
    dequeueRender(this.renderSelection);
    if (this.pre == null) {
      return;
    }
    // Selected lines and the editor active line render together while their
    // DOM attributes keep independent rendered states.
    const selectedLines: LineRenderState = {
      range: this.selectedRange,
      highlightSide: this.selectedRangeHighlightSide,
      lineNumberOnly: this.selectedRangeLineNumberOnly,
    };
    const editorActiveLine: LineRenderState = {
      range:
        this.editorActiveLine == null
          ? null
          : {
              start: this.editorActiveLine,
              end: this.editorActiveLine,
              side: this.editorActiveLineSide,
            },
      highlightSide: this.editorActiveLineSide,
      lineNumberOnly: this.editorLineNumberOnly,
    };
    const selectedLinesChanged = !areLineRenderStatesEqual(
      this.renderedSelectedLinesState,
      selectedLines
    );
    const editorActiveLineChanged = !areLineRenderStatesEqual(
      this.renderedEditorActiveLineState,
      editorActiveLine
    );
    if (!selectedLinesChanged && !editorActiveLineChanged) {
      return;
    }

    // A changed channel remains explicitly dirty until its DOM update finishes,
    // which lets an identical write retry after a transient render failure.
    if (selectedLinesChanged) {
      this.renderedSelectedLinesState = undefined;
    }
    if (editorActiveLineChanged) {
      this.renderedEditorActiveLineState = undefined;
    }

    const split = this.pre.getAttribute('data-diff-type') === 'split';
    const selectedRowRange = !selectedLinesChanged
      ? undefined
      : this.resolveLineRenderRange(selectedLines, split, 'selected-lines');
    const editorRowRange = !editorActiveLineChanged
      ? undefined
      : this.resolveLineRenderRange(
          editorActiveLine,
          split,
          'editor-active-line'
        );
    // Validate every code column that will receive changed attributes before
    // clearing either channel's previous rendering.
    const columns: LineRenderColumn[] = [];
    if (selectedRowRange != null || editorRowRange != null) {
      const { children: codeElements } = this.pre;
      if (codeElements.length > 2) {
        console.error(codeElements);
        throw new Error(
          'InteractionManager.renderSelection: Somehow there are more than 2 code elements...'
        );
      }
      for (const code of codeElements) {
        const side: SelectionSide | undefined = code.hasAttribute(
          'data-deletions'
        )
          ? 'deletions'
          : code.hasAttribute('data-additions')
            ? 'additions'
            : undefined;
        const renderSelectedLines =
          selectedRowRange != null &&
          (selectedLines.highlightSide == null ||
            side == null ||
            selectedLines.highlightSide === side);
        const renderEditorActiveLine =
          editorRowRange != null &&
          (editorActiveLine.highlightSide == null ||
            side == null ||
            editorActiveLine.highlightSide === side);
        if (!renderSelectedLines && !renderEditorActiveLine) {
          continue;
        }

        const [gutter, content] = code.children;
        if (
          !(gutter instanceof HTMLElement) ||
          !(content instanceof HTMLElement)
        ) {
          throw new Error(
            'InteractionManager.renderSelection: missing gutter or content element'
          );
        }
        if (content.children.length !== gutter.children.length) {
          throw new Error(
            'InteractionManager.renderSelection: gutter and content children dont match, something is wrong'
          );
        }
        columns.push({
          content,
          gutter,
          renderEditorActiveLine,
          renderSelectedLines,
        });
      }
    }
    const selectedLinesComplete =
      selectedLines.range == null ||
      columns.some((column) => column.renderSelectedLines);
    const editorActiveLineComplete =
      editorActiveLine.range == null ||
      columns.some((column) => column.renderEditorActiveLine);

    if (selectedLinesChanged) {
      for (const element of this.pre.querySelectorAll('[data-selected-line]')) {
        element.removeAttribute('data-selected-line');
      }
    }
    if (editorActiveLineChanged) {
      for (const element of this.pre.querySelectorAll(
        '[data-editor-active-line]'
      )) {
        element.removeAttribute('data-editor-active-line');
      }
    }

    const selectedFirst =
      selectedRowRange == null
        ? undefined
        : Math.min(selectedRowRange.start, selectedRowRange.end);
    const selectedLast =
      selectedRowRange == null
        ? undefined
        : Math.max(selectedRowRange.start, selectedRowRange.end);
    const selectedIsSingle = selectedFirst === selectedLast;
    const editorLineIndex = editorRowRange?.start;
    for (const column of columns) {
      const { content, gutter, renderEditorActiveLine, renderSelectedLines } =
        column;
      const finalLineIndex = Math.max(
        renderSelectedLines ? (selectedLast ?? -Infinity) : -Infinity,
        renderEditorActiveLine ? (editorLineIndex ?? -Infinity) : -Infinity
      );
      const len = content.children.length;
      for (let i = 0; i < len; i++) {
        const contentElement = content.children[i];
        const gutterElement = gutter.children[i];
        if (
          !(contentElement instanceof HTMLElement) ||
          !(gutterElement instanceof HTMLElement)
        ) {
          continue;
        }

        const lineIndex = this.parseLineIndex(contentElement, split);
        if ((lineIndex ?? 0) > finalLineIndex) {
          break;
        }
        if (lineIndex == null) {
          continue;
        }
        if (
          renderSelectedLines &&
          selectedFirst != null &&
          selectedLast != null &&
          lineIndex >= selectedFirst &&
          lineIndex <= selectedLast
        ) {
          let attributeValue = selectedIsSingle
            ? 'single'
            : lineIndex === selectedFirst
              ? 'first'
              : lineIndex === selectedLast
                ? 'last'
                : '';
          gutterElement.setAttribute('data-selected-line', attributeValue);
          // A number-only highlight marks just the gutter number, leaving the
          // line background and any annotation rows untouched.
          if (!selectedLines.lineNumberOnly) {
            contentElement.setAttribute('data-selected-line', attributeValue);
            if (
              gutterElement.nextSibling instanceof HTMLElement &&
              contentElement.nextSibling instanceof HTMLElement &&
              (contentElement.nextSibling.hasAttribute(
                'data-line-annotation'
              ) ||
                contentElement.nextSibling.hasAttribute(
                  'data-merge-conflict-actions'
                ))
            ) {
              if (selectedIsSingle) {
                attributeValue = 'last';
                contentElement.setAttribute('data-selected-line', 'first');
              } else if (lineIndex === selectedFirst) {
                attributeValue = '';
              } else if (lineIndex === selectedLast) {
                contentElement.setAttribute('data-selected-line', '');
              }
              contentElement.nextSibling.setAttribute(
                'data-selected-line',
                attributeValue
              );
              gutterElement.nextSibling.setAttribute(
                'data-selected-line',
                attributeValue
              );
            }
          }
        }
        if (renderEditorActiveLine && lineIndex === editorLineIndex) {
          gutterElement.setAttribute('data-editor-active-line', '');
          if (!editorActiveLine.lineNumberOnly) {
            contentElement.setAttribute('data-editor-active-line', '');
          }
        }
      }
    }

    if (selectedLinesChanged && selectedLinesComplete) {
      this.renderedSelectedLinesState = selectedLines;
    }
    if (editorActiveLineChanged && editorActiveLineComplete) {
      this.renderedEditorActiveLineState = editorActiveLine;
    }
  };

  private toEventBaseProps(
    target: HoverableLinePointerTarget<TMode>
  ): EventBaseProps<TMode> {
    if (this.mode === 'file') {
      return {
        type: 'line',
        lineElement: target.lineElement,
        lineNumber: target.lineNumber,
        numberColumn: target.numberColumn,
        numberElement: target.numberElement,
      } as EventBaseProps<TMode>;
    }

    return {
      type: 'diff-line',
      annotationSide: target.side as AnnotationSide,
      lineType: target.lineType,
      lineElement: target.lineElement,
      numberElement: target.numberElement,
      lineNumber: target.lineNumber,
      numberColumn: target.numberColumn,
    } as EventBaseProps<TMode>;
  }

  private toTokenEventBaseProps({
    lineCharEnd,
    lineCharStart,
    lineNumber,
    side,
    tokenElement,
    tokenText,
  }: TokenPointerTarget<TMode>): OnTokenEventProps<TMode> {
    if (this.mode === 'file') {
      return {
        type: 'token',
        lineCharEnd,
        lineCharStart,
        lineNumber,
        tokenElement,
        tokenText,
      } as OnTokenEventProps<TMode>;
    }

    return {
      type: 'token',
      lineCharEnd,
      lineCharStart,
      lineNumber,
      side,
      tokenElement,
      tokenText,
    } as OnTokenEventProps<TMode>;
  }

  private buildSelectionRange(
    start: number,
    end: number,
    side?: SelectionSide,
    endSide?: SelectionSide
  ): SelectedLineRange {
    return {
      start,
      end,
      ...(side != null ? { side } : {}),
      ...(side !== endSide && endSide != null ? { endSide } : {}),
    };
  }

  private resolvePointerTarget(
    path: (EventTarget | undefined)[]
  ): ResolvedPointerTarget<TMode> | undefined {
    let numberColumn = false;
    let lineType: LineTypes | undefined;
    let codeElement: HTMLElement | undefined;
    let lineElement: HTMLElement | undefined;
    let lineIndexValue: string | null | undefined;
    let numberElement: HTMLElement | undefined;
    let tokenElement: HTMLElement | undefined;
    let tokenInfo: TokenCache | undefined;
    let expandInfo: ExpandCache | undefined;
    let lineNumber: number | undefined;
    let mergeConflictActionTarget: MergeConflictActionTarget | undefined;

    for (const element of path) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }

      if (
        mergeConflictActionTarget == null &&
        element.hasAttribute('data-merge-conflict-action')
      ) {
        const resolution = element.getAttribute('data-merge-conflict-action');
        const conflictIndex = Number.parseInt(
          element.getAttribute('data-merge-conflict-conflict-index') ?? '',
          10
        );
        if (
          (resolution === 'current' ||
            resolution === 'incoming' ||
            resolution === 'both') &&
          Number.isFinite(conflictIndex)
        ) {
          mergeConflictActionTarget = {
            kind: 'merge-conflict-action',
            resolution,
            conflictIndex,
          };
        }
      }

      if (tokenElement == null && element.hasAttribute('data-char')) {
        tokenElement = element;
        const lineCharStart = Number.parseInt(
          element.getAttribute('data-char') ?? '',
          10
        );
        if (!Number.isNaN(lineCharStart)) {
          const tokenText = element.textContent ?? '';
          if (
            tokenText.trim() !== '' ||
            this.options.enableTokenInteractionsOnWhitespace === true
          ) {
            tokenInfo = {
              tokenElement,
              lineCharStart,
              lineCharEnd: lineCharStart + tokenText.length,
              tokenText,
            };
          }
          continue;
        }
      }

      const columnNumber =
        numberElement == null
          ? element.getAttribute('data-column-number')
          : null;
      if (columnNumber != null) {
        numberElement = element;
        lineNumber = Number.parseInt(columnNumber, 10);
        numberColumn = true;
        lineType = getLineTypeFromElement(element);
        lineIndexValue = element.getAttribute('data-line-index');
        continue;
      }

      const lineAttr =
        lineElement == null ? element.getAttribute('data-line') : null;
      if (lineAttr != null) {
        lineElement = element;
        lineNumber = Number.parseInt(lineAttr, 10);
        lineType = getLineTypeFromElement(element);
        lineIndexValue = element.getAttribute('data-line-index');
        continue;
      }

      if (
        expandInfo == null &&
        (element.hasAttribute('data-expand-button') ||
          element.hasAttribute('data-unmodified-lines'))
      ) {
        expandInfo = {
          hunkIndex: undefined,
          direction: element.hasAttribute('data-expand-up')
            ? 'up'
            : element.hasAttribute('data-expand-down')
              ? 'down'
              : 'both',
          all: element.hasAttribute('data-expand-all-button'),
        };
        continue;
      }

      const expandIndexValue =
        expandInfo != null ? element.getAttribute('data-expand-index') : null;
      if (expandInfo != null && expandIndexValue != null) {
        const expandIndex = Number.parseInt(expandIndexValue, 10);
        if (!Number.isNaN(expandIndex)) {
          expandInfo.hunkIndex = expandIndex;
        }
        continue;
      }

      if (codeElement == null && element.hasAttribute('data-code')) {
        codeElement = element;
        break;
      }
    }

    if (mergeConflictActionTarget != null) {
      return mergeConflictActionTarget;
    }

    if (expandInfo?.hunkIndex != null) {
      return {
        type: 'line-info',
        hunkIndex: expandInfo.hunkIndex,
        direction: expandInfo.direction,
        all: expandInfo.all,
      };
    }

    lineElement ??=
      lineIndexValue != null
        ? queryHTMLElement(
            codeElement,
            `[data-line][data-line-index="${lineIndexValue}"]`
          )
        : undefined;
    numberElement ??=
      lineIndexValue != null
        ? queryHTMLElement(
            codeElement,
            `[data-column-number][data-line-index="${lineIndexValue}"]`
          )
        : undefined;

    if (
      codeElement == null ||
      lineElement == null ||
      numberElement == null ||
      lineType == null ||
      lineNumber == null ||
      Number.isNaN(lineNumber)
    ) {
      return undefined;
    }

    return {
      kind: tokenInfo != null ? 'token' : 'line',
      lineType,
      lineElement,
      lineNumber,
      numberColumn,
      numberElement,
      side:
        this.mode === 'file'
          ? undefined
          : getAnnotationSide(lineType, codeElement),
      splitLineIndex: this.parseLineIndex(lineElement, this.isSplitDiff()),
      ...tokenInfo,
    } as ResolvedPointerTarget<TMode>;
  }

  private isSplitDiff(): boolean {
    return this.pre?.getAttribute('data-diff-type') === 'split';
  }

  private parseLineIndex(
    element: HTMLElement,
    split: boolean
  ): number | undefined {
    const lineIndexes = (element.getAttribute('data-line-index') ?? '')
      .split(',')
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => !Number.isNaN(value));

    if (split && lineIndexes.length === 2) {
      return lineIndexes[1];
    }
    if (!split) {
      return lineIndexes[0];
    }
    return undefined;
  }
}

type InteractionPluckOptions<TMode extends InteractionManagerMode> =
  InteractionManagerBaseOptions<TMode> & {
    renderGutterUtility?(
      getHoveredRow: () => GetHoveredLineResult<TMode> | undefined
    ): HTMLElement | null | undefined;
  };

export function pluckInteractionOptions<TMode extends InteractionManagerMode>(
  {
    enableTokenInteractionsOnWhitespace,
    enableGutterUtility,
    lineHoverHighlight,
    onGutterUtilityClick,
    onLineClick,
    onLineEnter,
    onLineLeave,
    onLineNumberClick,
    onTokenClick,
    onTokenEnter,
    onTokenLeave,
    renderGutterUtility,
    __debugPointerEvents,
    enableLineSelection,
    controlledSelection,
    onLineSelected,
    onLineSelectionStart,
    onLineSelectionChange,
    onLineSelectionEnd,
  }: InteractionPluckOptions<TMode>,
  onHunkExpand?: (
    hunkIndex: number,
    direction: ExpansionDirections,
    expansionLineCountOverride?: number
  ) => unknown,
  getLineIndex?: GetLineIndexUtility,
  onMergeConflictActionClick?: (target: MergeConflictActionTarget) => void
): InteractionManagerOptions<TMode> {
  if (onGutterUtilityClick != null && renderGutterUtility != null) {
    throw new Error(
      "Cannot use both 'onGutterUtilityClick' and 'renderGutterUtility'. Use only one gutter utility API."
    );
  }
  return {
    enableTokenInteractionsOnWhitespace,
    enableGutterUtility: enableGutterUtility ?? false,
    usesCustomGutterUtility: renderGutterUtility != null,
    lineHoverHighlight,

    onGutterUtilityClick,
    onHunkExpand,
    onMergeConflictActionClick,
    onLineClick,
    onLineEnter,
    onLineLeave,
    onLineNumberClick,
    onTokenClick,
    onTokenEnter,
    onTokenLeave,
    __debugPointerEvents,

    enableLineSelection,
    controlledSelection,
    onLineSelected,
    onLineSelectionStart,
    onLineSelectionChange,
    onLineSelectionEnd,

    getLineIndex,
  };
}

function isLinePointerTarget<TMode extends InteractionManagerMode>(
  target: ResolvedPointerTarget<TMode> | undefined
): target is LinePointerTarget<TMode> {
  return target != null && 'kind' in target && target.kind === 'line';
}

function isTokenPointerTarget<TMode extends InteractionManagerMode>(
  target: ResolvedPointerTarget<TMode> | undefined
): target is TokenPointerTarget<TMode> {
  return target != null && 'kind' in target && target.kind === 'token';
}

function isHoverableLinePointerTarget<TMode extends InteractionManagerMode>(
  target: ResolvedPointerTarget<TMode> | undefined
): target is HoverableLinePointerTarget<TMode> {
  return isLinePointerTarget(target) || isTokenPointerTarget(target);
}

function isExpandoPointerTarget<TMode extends InteractionManagerMode>(
  target: ResolvedPointerTarget<TMode>
): target is ExpandoEventProps {
  return 'type' in target && target.type === 'line-info';
}

function isMergeConflictActionPointerTarget<
  TMode extends InteractionManagerMode,
>(target: ResolvedPointerTarget<TMode>): target is MergeConflictActionTarget {
  return 'kind' in target && target.kind === 'merge-conflict-action';
}

function queryHTMLElement(
  parent: HTMLElement | undefined,
  query: string
): HTMLElement | undefined {
  const element = parent?.querySelector(query);
  return element instanceof HTMLElement ? element : undefined;
}

function getElementPath(element: Node): EventTarget[] {
  const path: EventTarget[] = [];
  let current: Node | null = element;
  while (current != null) {
    path.push(current);
    current = current.parentNode;
  }
  return path;
}

// Annotation rows belong to the code or gutter row directly above them.
function getAnnotatedRow(
  annotationRow: Element | null | undefined
): HTMLElement | undefined {
  const row =
    annotationRow instanceof HTMLElement
      ? annotationRow.previousElementSibling
      : undefined;
  return row instanceof HTMLElement &&
    (row.hasAttribute('data-line') || row.hasAttribute('data-column-number'))
    ? row
    : undefined;
}

// Resolve the shadow annotation row an event target projects into, from
// either slotted light-DOM content or the slot element itself.
function annotationRowFromSlot(element: Element): HTMLElement | undefined {
  const slotted = element.closest('[slot^="annotation-"]');
  const slot =
    slotted instanceof HTMLElement && slotted.assignedSlot != null
      ? slotted.assignedSlot
      : element.tagName === 'SLOT'
        ? element
        : undefined;
  const row = slot?.closest('[data-line-annotation]');
  return row instanceof HTMLElement ? row : undefined;
}

// Parses `annotation-[side-]<line>` from slotted content or the slot itself.
function selectionPointFromAnnotationSlot(
  element: Element
): SelectionPoint | undefined {
  const slottedElement = element.closest('[slot^="annotation-"]');
  const slotName =
    slottedElement instanceof HTMLElement
      ? slottedElement.getAttribute('slot')
      : element instanceof HTMLElement
        ? element.getAttribute('name')
        : null;
  const match =
    slotName != null
      ? /^annotation-(?:(additions|deletions)-)?(\d+)$/.exec(slotName)
      : null;
  if (match == null) {
    return undefined;
  }
  const lineNumber = Number.parseInt(match[2], 10);
  if (!Number.isFinite(lineNumber) || lineNumber <= 0) {
    return undefined;
  }
  return { lineNumber, side: match[1] as SelectionSide | undefined };
}

interface ElementFromPointRoot {
  elementFromPoint(x: number, y: number): Element | null;
}

function hasElementFromPoint(
  value: Node | undefined
): value is Node & ElementFromPointRoot {
  return (
    value != null &&
    typeof (value as Partial<ElementFromPointRoot>).elementFromPoint ===
      'function'
  );
}

function areLineRenderStatesEqual(
  first: LineRenderState | undefined,
  second: LineRenderState
): boolean {
  const firstRange = first?.range ?? null;
  return (
    first?.highlightSide === second.highlightSide &&
    first?.lineNumberOnly === second.lineNumberOnly &&
    (firstRange === second.range ||
      areSelectionsEqual(firstRange ?? undefined, second.range ?? undefined))
  );
}

function getAnnotationSide(
  lineType: LineTypes,
  codeElement: HTMLElement
): AnnotationSide {
  switch (lineType) {
    case 'change-deletion':
      return 'deletions';
    case 'change-addition':
      return 'additions';
    default:
      return codeElement.hasAttribute('data-deletions')
        ? 'deletions'
        : 'additions';
  }
}

function getLineTypeFromElement(element: HTMLElement): LineTypes | undefined {
  const lineType = element.getAttribute('data-line-type');
  return lineType === 'change-deletion' ||
    lineType === 'change-addition' ||
    lineType === 'context' ||
    lineType === 'context-expanded'
    ? lineType
    : undefined;
}

function debugLogIfEnabled(
  debugLogType: LogTypes | undefined,
  logIfType: 'move' | 'click',
  ...args: unknown[]
) {
  if (debugLogType === 'both' || debugLogType === logIfType) {
    console.log(...args);
  }
}
