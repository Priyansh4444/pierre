import {
  CORE_CSS_ATTRIBUTE,
  DEFAULT_CODE_VIEW_FILE_METRICS,
  DEFAULT_CODE_VIEW_LAYOUT,
  DEFAULT_COLLAPSED_CONTEXT_THRESHOLD,
  DEFAULT_SMOOTH_SCROLL_SETTINGS,
  DEFAULT_THEMES,
  DIFFS_DEVELOPMENT_BUILD,
  DIFFS_TAG_NAME,
  THEME_CSS_ATTRIBUTE,
  UNSAFE_CSS_ATTRIBUTE,
} from '../constants';
import type { Editor, EditorOptions } from '../editor/editor';
import type {
  EditCompletionDecision,
  EditorChangeEvent,
  EditorType,
} from '../editor/types';
import {
  getHighlighterIfLoaded,
  HighlighterDisposedError,
  preloadHighlighter,
} from '../highlighter/shared_highlighter';
import type { SelectionWriteOptions } from '../managers/InteractionManager';
import {
  dequeueRender,
  queueRender,
} from '../managers/UniversalRenderingManager';
import type {
  CodeViewDiffItem,
  CodeViewFileItem,
  CodeViewItem,
  CodeViewItemScrollTarget,
  CodeViewLayout,
  CodeViewLineScrollTarget,
  CodeViewPositionScrollTarget,
  CodeViewRangeScrollTarget,
  CodeViewScrollTarget,
  DiffsThemeNames,
  HunkSeparators,
  PendingCodeViewLayoutReset,
  SelectedLineRange,
  SelectionSide,
  SmoothScrollSettings,
  ThemesType,
  VirtualFileMetrics,
  VirtualWindowSpecs,
} from '../types';
import { areManagedSnapshotsEqual } from '../utils/areManagedSnapshotsEqual';
import { areObjectsEqual } from '../utils/areObjectsEqual';
import { areOptionsEqual } from '../utils/areOptionsEqual';
import { areSelectionsEqual } from '../utils/areSelectionsEqual';
import { areThemesEqual } from '../utils/areThemesEqual';
import { createCodeViewHeaderFooterHostElement } from '../utils/createCodeViewHeaderFooterHostElement';
import { createWindowFromScrollPosition } from '../utils/createWindowFromScrollPosition';
import { getThemes } from '../utils/getThemes';
import { isStyleNode } from '../utils/isStyleNode';
import { isFirefox } from '../utils/platform';
import { prefersReducedMotion } from '../utils/prefersReducedMotion';
import { resolvePreferredHighlighter } from '../utils/resolvePreferredHighlighter';
import { roundToDevicePixel } from '../utils/roundToDevicePixel';
import type { WorkerPoolManager } from '../worker';
import type { FileEditCompleteEvent, FileOptions } from './File';
import type { FileDiffEditCompleteEvent, FileDiffOptions } from './FileDiff';
import { VirtualizedFile } from './VirtualizedFile';
import { VirtualizedFileDiff } from './VirtualizedFileDiff';
import type { VirtualizerConfig } from './Virtualizer';

export type CodeViewCreateEditorOptions<
  EType extends EditorType,
  LAnnotation,
  Caret,
> = Required<Pick<EditorOptions<EType, LAnnotation, Caret>, 'onChange'>>;

type CodeViewEditor<LAnnotation, Caret> =
  | Editor<'file', LAnnotation, Caret>
  | Editor<'file-diff', LAnnotation, Caret>;

// When re-rendering content of the virtualizer, it's important that we
// maintain a visual anchor, usually this is the first fully visible element,
// whether it's an Item (a file or diff header), or a specific line.  If the
// rendered content ever ends up shifting things around, we'll need to reset
// the new position back to the viewportOffset, relative to where that element
// currently is
interface ItemAnchor {
  type: 'item';
  id: string;
  viewportOffset: number;
}

interface LineAnchor {
  type: 'line';
  id: string;
  lineNumber: number;
  side: SelectionSide | undefined;
  viewportOffset: number;
}

type ScrollAnchor = ItemAnchor | LineAnchor;

interface LineScrollPosition {
  top: number;
  height: number;
}

interface StickyBounds {
  stickyTop: number;
  stickyBottom: number;
}

// Per-record state for one of the always-rendered header/footer hosts, keeping
// its element, the callback that last populated it, and its measured height in a
// single place instead of parallel fields on the CodeView instance.
interface HeaderFooterHost {
  // The mounted host element, or undefined when the callback is absent.
  element: HTMLDivElement | undefined;
  // The renderCodeView{Header,Footer} callback that last populated `element`, so
  // a swapped reference can be detected and the host re-populated in place.
  render?(): HTMLElement | undefined;
  // Measured height, folded into the scroll-range / item-offset math. Stays 0
  // while the host is absent (a no-op) so the math is always coherent.
  height: number;
}

interface PagedScrollPosition {
  pagedScrollTop: number;
  scrollPageOffset: number;
}

interface AdvancedVirtualizedBaseItem {
  /** Current index of this record in the ordered items array. */
  index: number;
  /** Absolute top offset of this item inside the scroll content. */
  top: number;
  /** Total measured height reserved for this item. */
  height: number;
  /** Root <diffs-container> node currently mounted for this item, only exists
   * when rendered. */
  element: HTMLElement | undefined;
  /** Last controlled version observed for this record. */
  version: number | undefined;
  /** Last CodeView option revision this item rendered with. */
  renderedOptionsRevision: number;
}

// CodeView uses virtualized instances as identity keys for layout bookkeeping;
// their editor annotation and caret metadata are not part of that contract.
interface CodeViewVirtualizedInstanceKey {
  readonly __id: string;
  readonly renderType: 'virtualized';
}

interface CodeViewDiffItemContext<
  LAnnotation,
  Caret,
> extends AdvancedVirtualizedBaseItem {
  type: 'diff';
  /** Latest item snapshot for this record. Controlled updates can replace it. */
  item: CodeViewDiffItem<LAnnotation>;
  /** Virtualized diff instance responsible for rendering this item. */
  instance: VirtualizedFileDiff<LAnnotation, Caret>;
}

interface CodeViewFileItemContext<
  LAnnotation,
  Caret,
> extends AdvancedVirtualizedBaseItem {
  type: 'file';
  /** Latest item snapshot for this record. Controlled updates can replace it. */
  item: CodeViewFileItem<LAnnotation>;
  /** Virtualized file instance responsible for rendering this item. */
  instance: VirtualizedFile<LAnnotation, Caret>;
}

type CodeViewContextItem<LAnnotation, Caret> =
  | CodeViewDiffItemContext<LAnnotation, Caret>
  | CodeViewFileItemContext<LAnnotation, Caret>;

export interface CodeViewRenderedDiffItem<LAnnotation, Caret> {
  id: string;
  type: 'diff';
  item: CodeViewDiffItem<LAnnotation>;
  version: number | undefined;
  element: HTMLElement;
  instance: VirtualizedFileDiff<LAnnotation, Caret>;
}

export interface CodeViewRenderedFileItem<LAnnotation, Caret> {
  id: string;
  type: 'file';
  item: CodeViewFileItem<LAnnotation>;
  version: number | undefined;
  element: HTMLElement;
  instance: VirtualizedFile<LAnnotation, Caret>;
}

export type CodeViewRenderedItem<LAnnotation, Caret> =
  | CodeViewRenderedDiffItem<LAnnotation, Caret>
  | CodeViewRenderedFileItem<LAnnotation, Caret>;

// Everything the React layer portals into, published together so a single store
// subscription drives per-item slots AND the global header/footer.
export interface CodeViewSlotSnapshot<LAnnotation, Caret> {
  // Rendered items that need React-managed slot content (per-item headers,
  // annotations, gutter utilities), or undefined when none.
  items: CodeViewRenderedItem<LAnnotation, Caret>[] | undefined;
  // The always-rendered header/footer host elements React portals into, or
  // undefined when the corresponding renderCodeViewHeader/Footer callback is not
  // set. Because these live in the snapshot, a host mounting/unmounting changes
  // it and triggers a publish — which is how React learns about hosts that are
  // created on a later (worker-ready) render.
  header: HTMLElement | undefined;
  footer: HTMLElement | undefined;
}

export interface CodeViewLineSelection {
  id: string;
  range: SelectedLineRange;
}

export interface CodeViewCoordinator<LAnnotation, Caret> {
  hasHeaderRenderers: boolean;
  hasAnnotationRenderer: boolean;
  hasGutterRenderer: boolean;
  onSnapshotChange(
    snapshot: CodeViewSlotSnapshot<LAnnotation, Caret> | undefined
  ): void;
}

export type CodeViewScrollListener<LAnnotation, Caret> = (
  scrollTop: number,
  viewer: CodeView<LAnnotation, Caret>
) => void;

type OverloadCallbackArgs<TCallback> = TCallback extends (
  ...args: infer TArgs
) => unknown
  ? TArgs
  : never;

type CallbackReturn<TCallback> = TCallback extends (
  ...args: never[]
) => infer TReturn
  ? TReturn
  : never;

type OverloadFileCallbackArgs<
  LAnnotation,
  Caret,
  TKey extends keyof FileOptions<LAnnotation, Caret>,
> = OverloadCallbackArgs<NonNullable<FileOptions<LAnnotation, Caret>[TKey]>>;

type OverloadDiffCallbackArgs<
  LAnnotation,
  Caret,
  TKey extends keyof FileDiffOptions<LAnnotation, Caret>,
> = OverloadCallbackArgs<
  NonNullable<FileDiffOptions<LAnnotation, Caret>[TKey]>
>;

type CodeViewOptionCallback<
  LAnnotation,
  Caret,
  TKey extends keyof FileOptions<LAnnotation, Caret> &
    keyof FileDiffOptions<LAnnotation, Caret>,
> = {
  (
    ...args: [
      ...OverloadFileCallbackArgs<LAnnotation, Caret, TKey>,
      context: CodeViewFileItemContext<LAnnotation, Caret>,
    ]
  ): CallbackReturn<NonNullable<FileOptions<LAnnotation, Caret>[TKey]>>;
  (
    ...args: [
      ...OverloadDiffCallbackArgs<LAnnotation, Caret, TKey>,
      context: CodeViewDiffItemContext<LAnnotation, Caret>,
    ]
  ): CallbackReturn<NonNullable<FileDiffOptions<LAnnotation, Caret>[TKey]>>;
};

export const CODE_VIEW_DIFF_OPTION_KEYS = [
  'theme',
  'disableLineNumbers',
  'overflow',
  'themeType',
  'disableFileHeader',
  'disableVirtualizationBuffers',
  'preferredHighlighter',
  'useCSSClasses',
  'useTokenTransformer',
  'tokenizeMaxLineLength',
  'tokenizeMaxLength',
  'unsafeCSS',
  'diffStyle',
  'diffIndicators',
  'disableBackground',
  'expandUnchanged',
  'loadDiffFiles',
  'parseDiffOptions',
  'collapsedContextThreshold',
  'lineDiffType',
  'maxLineDiffLength',
  'expansionLineCount',
  'lineHoverHighlight',
  'enableTokenInteractionsOnWhitespace',
  'enableGutterUtility',
  '__debugPointerEvents',
  'enableLineSelection',
  'controlledSelection',
  'disableErrorHandling',
] as const;

type CodeViewDiffOptionKeys = (typeof CODE_VIEW_DIFF_OPTION_KEYS)[number];

export const CODE_VIEW_FILE_OPTION_KEYS = [
  'theme',
  'disableLineNumbers',
  'overflow',
  'themeType',
  'disableFileHeader',
  'disableVirtualizationBuffers',
  'preferredHighlighter',
  'useCSSClasses',
  'useTokenTransformer',
  'tokenizeMaxLineLength',
  'tokenizeMaxLength',
  'unsafeCSS',
  'lineHoverHighlight',
  'enableTokenInteractionsOnWhitespace',
  'enableGutterUtility',
  '__debugPointerEvents',
  'enableLineSelection',
  'controlledSelection',
  'disableErrorHandling',
] as const;

type CodeViewPassThroughOptions<LAnnotation, Caret> = Pick<
  FileDiffOptions<LAnnotation, Caret>,
  CodeViewDiffOptionKeys
>;

export type CodeViewMode = 'file' | 'diff';

// Mode-indexed lookups for the onItemEditComplete signature, so a file event
// always pairs with a file item and a diff event with a diff item.
export interface CodeViewItemEditCompleteEventMap<LAnnotation, Caret> {
  file: FileEditCompleteEvent<LAnnotation, Caret>;
  diff: FileDiffEditCompleteEvent<LAnnotation, Caret>;
}

export interface CodeViewModeItemMap<LAnnotation> {
  file: CodeViewFileItem<LAnnotation>;
  diff: CodeViewDiffItem<LAnnotation>;
}

export type CodeViewItemEditCompleteHandler<LAnnotation, Caret> = <
  TMode extends CodeViewMode,
>(
  event: CodeViewItemEditCompleteEventMap<LAnnotation, Caret>[TMode],
  item: CodeViewModeItemMap<LAnnotation>[TMode],
  nextItem: CodeViewModeItemMap<LAnnotation>[TMode]
) => EditCompletionDecision;

type CodeViewModeItemContext<
  LAnnotation,
  Caret,
  TMode extends CodeViewMode,
> = TMode extends 'file'
  ? CodeViewFileItemContext<LAnnotation, Caret>
  : CodeViewDiffItemContext<LAnnotation, Caret>;

const CODE_VIEW_SHARED_CALLBACK_KEYS = [
  'renderCustomHeader',
  'renderHeaderPrefix',
  'renderHeaderFilenameSuffix',
  'renderHeaderMetadata',
  'renderAnnotation',
  'renderGutterUtility',
  'onPostRender',
  'onGutterUtilityClick',
  'onLineClick',
  'onLineNumberClick',
  'onLineEnter',
  'onLineLeave',
  'onTokenClick',
  'onTokenEnter',
  'onTokenLeave',
] as const;

const CODE_VIEW_SELECTION_CALLBACK_KEYS = [
  'onLineSelected',
  'onLineSelectionStart',
  'onLineSelectionChange',
  'onLineSelectionEnd',
] as const;

type CodeViewSharedCallbackKeys =
  (typeof CODE_VIEW_SHARED_CALLBACK_KEYS)[number];

type CodeViewSelectionCallbackKeys =
  (typeof CODE_VIEW_SELECTION_CALLBACK_KEYS)[number];

const CODE_VIEW_ITEM_OPTIONS_STATE = Symbol('CodeView.itemOptionsState');

type CodeViewItemCallbackCache = Partial<
  Record<CodeViewSharedCallbackKeys | CodeViewSelectionCallbackKeys, unknown>
>;

// Each item gets a tiny state record and an options object whose properties
// come from a shared prototype. This avoids retaining dozens of getter closures
// and property descriptors per item while still letting the item instance read
// the latest CodeView options whenever it renders.
interface CodeViewItemOptionsState<LAnnotation> {
  // Store the id instead of the item object so item -> instance -> options does
  // not form a strong cycle back to the item context. The id also lets
  // updateItemId() keep reused instances pointed at the current record.
  id: string;
  // Callback wrappers are only needed when a renderer/interaction path reads a
  // callback option, so this cache stays absent for plain CodeView items.
  callbackCache?: CodeViewItemCallbackCache;
  // Set when the item is removed while completing an edit session, so the
  // completion adapter can still resolve the item.
  removedItem?: CodeViewItem<LAnnotation>;
}

// Editor bookkeeping for one edit-mode item. `state` is the attached
// instance's options state, shared so the id one updateItemId rename keeps
// current serves the onChange closure and the completion adapter alike.
// `dispose` comes from the latest `editor.edit()` attachment: it tears the
// editor down and completes the session on the instance it attached to.
interface CodeViewItemEditorRecord<LAnnotation, Caret> {
  editor: CodeViewEditor<LAnnotation, Caret>;
  state: CodeViewItemOptionsState<LAnnotation>;
  dispose(): void;
}

// NOTE(amadeus): It should be noted that there are times when various JS
// tooling will try and enumerate various parts of our code when logging, and
// sometimes this can trigger on the options prototype directly which won't
// have access to an internal state.  This forces us to be defensive later on
// which is important
function getItemOptionsState<LAnnotation>(
  options: object
): CodeViewItemOptionsState<LAnnotation> | undefined {
  return (
    options as {
      [CODE_VIEW_ITEM_OPTIONS_STATE]?: CodeViewItemOptionsState<LAnnotation>;
    }
  )[CODE_VIEW_ITEM_OPTIONS_STATE];
}

type CodeViewSharedCallbackOptions<LAnnotation, Caret> = {
  [TKey in CodeViewSharedCallbackKeys]?: CodeViewOptionCallback<
    LAnnotation,
    Caret,
    TKey
  >;
};

type CodeViewSelectionCallbackOptions<LAnnotation, Caret> = {
  [TKey in CodeViewSelectionCallbackKeys]?: CodeViewOptionCallback<
    LAnnotation,
    Caret,
    TKey
  >;
};

function defineItemOption(
  target: object,
  key: string,
  get: (receiver: object) => unknown
): void {
  // These accessors usually live on the shared prototype. Passing `this` to the
  // getter lets one shared accessor resolve per-item state from the receiving
  // options object instead of closing over an individual item.
  Object.defineProperty(target, key, {
    configurable: false,
    enumerable: true,
    get(this: object) {
      return get(this);
    },
  });
}

export interface CodeViewOptions<LAnnotation, Caret>
  extends
    CodeViewPassThroughOptions<LAnnotation, Caret>,
    CodeViewSharedCallbackOptions<LAnnotation, Caret>,
    CodeViewSelectionCallbackOptions<LAnnotation, Caret> {
  hunkSeparators?: Exclude<HunkSeparators, 'custom'>;
  itemMetrics?: Partial<VirtualFileMetrics>;
  pointerEventsOnScroll?: boolean;
  smoothScrollSettings?: SmoothScrollSettings;
  stickyHeaders?: boolean;
  controlledSelection?: boolean;
  onSelectedLinesChange?(selection: CodeViewLineSelection | null): void;
  layout?: CodeViewLayout;
  /**
   * Return an in-memory retention key for an item's editable draft and
   * undo/redo history. Called only when CodeView creates the item's editor.
   */
  getEditStateKey?(item: CodeViewItem<LAnnotation>): string | undefined;
  /**
   * Create an editor for an item entering edit mode (`edit: true`). Providing
   * this option is what enables item editing. Pass the given options into the
   * editor constructor — `new Editor(editorType, options, editStateKey)` —
   * so CodeView can route document changes to `onItemEditChange` and retain
   * history when requested. CodeView owns the returned editor's lifecycle: it
   * associates with the edited item, suspends and resumes rendering across
   * virtualization unmounts and collapse, and tears the editor down when the
   * session ends (edit off or removal).
   */
  createEditor?<EType extends EditorType>(
    editorType: EType,
    options: CodeViewCreateEditorOptions<EType, LAnnotation, Caret>,
    editStateKey?: string
  ): Editor<EType, LAnnotation, Caret>;
  /**
   * Called with the editor's `EditorChangeEvent` and the owning item whenever
   * the edited document changes, from internal (edit) changes or external
   * (CodeViewItem) changes. The event contains that same attached editor.
   *
   * Do not feed these changes back into item state.
   */
  onItemEditChange?(
    event: EditorChangeEvent<EditorType, LAnnotation, Caret>,
    item: CodeViewItem<LAnnotation>
  ): void;
  /**
   * Called once when an edit session ends: edit to false, the item is removed
   * from items, or the viewer tears down (`reset()`/`cleanUp()`, where the
   * result is not installed because the viewer is going away). Collapse does
   * not call it because the session remains active until the item expands.
   *
   * The event carries the completed `file`/`fileDiff` built from the edit
   * session. `item` is the item that owned the session, and `nextItem` is
   * the accepted replacement CodeView built from it: the event's completed
   * value and annotations, `edit: false`, and a bumped `version`. Return
   * `'accept'` to install the edit — CodeView applies `nextItem` through the
   * item update path when the item still exists, and a controlled owner puts
   * the same `nextItem` into its state — or `'reject'` to revert. The event is
   * frozen; re-key the accepted value in place (`event.fileDiff.cacheKey =
   * '…'`) before accepting. The event contains the detached editor with its
   * final pre-detach state.
   */
  onItemEditComplete?: CodeViewItemEditCompleteHandler<LAnnotation, Caret>;

  /** Render a non-virtualized element at the very start of the scroll content,
   * before the first item. It is always rendered and scrolls with the content.
   * Return the same element across calls and mutate it in place to update;
   * height changes are measured automatically. */
  renderCodeViewHeader?(): HTMLElement | undefined;
  /** Render a non-virtualized element at the very end of the scroll content,
   * after the last item. Always rendered; height changes are measured
   * automatically. */
  renderCodeViewFooter?(): HTMLElement | undefined;

  /** Internal dev-only check to ensure your `itemMetrics` are correct.  Its
   * automatically disabled in a production build because it will hurt
   * performance fairly significantly */
  __devOnlyValidateItemHeights?: boolean;
}

const DEFAULT_SCROLL_INTERACTION_RESTORE_DELAY_MS = 120;
const SUB_PIXEL_TOLERANCE = 1;
const SCROLLING_CODE_OVERFLOW_FIX_VARIABLE = '--diffs-overflow-override';

// Browsers cap how tall an element can be, so very large content scrolls
// inside a fixed-height container instead. When the scroll position gets
// close to either end of that container, we shift the content and jump the
// scroll position back toward the middle, so there is always room to keep
// scrolling.
interface ScrollRebaseConfig {
  // Height of the scroll container, in CSS pixels.
  containerHeight: number;
  // Scrolling up past this point jumps back down to `targetBottom`.
  triggerTop: number;
  // Where a jump lands after scrolling down past `threshold`.
  targetTop: number;
  // Where a jump lands after scrolling up past `triggerTop`.
  targetBottom: number;
  // Scrolling down past this point jumps back up to `targetTop`.
  threshold: number;
}

function createScrollRebaseConfig(
  containerHeight: number,
  triggerTop: number,
  targetTop: number
): ScrollRebaseConfig {
  return {
    containerHeight,
    triggerTop,
    targetTop,
    targetBottom: containerHeight - targetTop,
    threshold: containerHeight - triggerTop,
  };
}

const DEFAULT_SCROLL_REBASE = createScrollRebaseConfig(
  12_000_000,
  1_000_000,
  2_000_000
);

// Firefox loses precision on very large positions: past about 16.7 million
// device pixels, some letters render a pixel lower than their neighbors. A
// smaller container keeps positions under that limit, even on high-density
// or zoomed-in screens.
const FIREFOX_SCROLL_REBASE = createScrollRebaseConfig(
  2 ** 22,
  500_000,
  1_000_000
);

interface ScrollToAnimation {
  position: number;
  velocity: number;
  lastTimestamp: number;
}

interface SpringStepResult {
  position: number;
  velocity: number;
}

// Any user-driven scroll intent cancels an in-flight programmatic scroll.
// pointerdown catches scrollbar drag (the scrollbar belongs to root);
// wheel / touchstart cover trackpad + touch scroll; keydown covers arrow
// keys, PgUp/PgDn, Home/End on a focused scroll container.
const USER_SCROLL_EVENTS = [
  'wheel',
  'touchstart',
  'pointerdown',
  'keydown',
] as const;

// Options (with their defaults) whose change also changes estimated diff
// heights.
const DIFF_ESTIMATE_OPTION_DEFAULTS = [
  ['disableFileHeader', false],
  ['hunkSeparators', 'line-info'],
  ['expandUnchanged', false],
  ['collapsedContextThreshold', DEFAULT_COLLAPSED_CONTEXT_THRESHOLD],
] as const;

// Options (with their defaults) whose change invalidates item layout.
// `unsafeCSS` has no default and is compared directly.
const ITEM_LAYOUT_OPTION_DEFAULTS = [
  ['overflow', 'scroll'],
  ['disableLineNumbers', false],
  ['diffStyle', 'split'],
  ['diffIndicators', 'bars'],
  ...DIFF_ESTIMATE_OPTION_DEFAULTS,
] as const;

function hasOptionChanged<LAnnotation, Caret>(
  previousOptions: CodeViewOptions<LAnnotation, Caret>,
  nextOptions: CodeViewOptions<LAnnotation, Caret>,
  defaults: readonly (readonly [
    keyof CodeViewOptions<LAnnotation, Caret>,
    unknown,
  ])[]
): boolean {
  return defaults.some(
    ([key, fallback]) =>
      (previousOptions[key] ?? fallback) !== (nextOptions[key] ?? fallback)
  );
}

// A vibe slopped heuristic to detect mobile safari only
const MOBILE_SAFARI = (() => {
  const { navigator } = globalThis;

  const userAgent = navigator.userAgent;
  const isIOS = /iP(?:hone|ad|od)/.test(userAgent);
  const isIPadOS =
    navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;

  return (
    (isIOS || isIPadOS) &&
    /AppleWebKit/.test(userAgent) &&
    /Safari/.test(userAgent) &&
    !/(CriOS|FxiOS|EdgiOS|OPiOS)/.test(userAgent)
  );
})();

type PendingAlignTypes = Exclude<CodeViewLineScrollTarget['align'], 'nearest'>;

interface PendingLineTarget extends Omit<CodeViewLineScrollTarget, 'align'> {
  align?: PendingAlignTypes;
}

interface PendingRangeTarget extends Omit<CodeViewRangeScrollTarget, 'align'> {
  align?: PendingAlignTypes;
}

interface PendingItemTarget extends Omit<CodeViewItemScrollTarget, 'align'> {
  align?: PendingAlignTypes;
}

type PendingScrollTarget =
  | CodeViewPositionScrollTarget
  | PendingLineTarget
  | PendingRangeTarget
  | PendingItemTarget;

type CodeViewItemMap<LAnnotation, Caret> = Map<
  string,
  CodeViewContextItem<LAnnotation, Caret>
>;

const INITIAL_RENDER_STATE = {
  scrollTop: -1,
  firstIndex: -1,
  lastIndex: -1,
  stickyHeight: 0,
  stickyTop: -1,
  stickyBottom: -1,
};

export class CodeView<LAnnotation = undefined, Caret = undefined> {
  static __STOP = false;
  static __lastScrollPosition = 0;

  public type = 'advanced' as const;
  public readonly config: VirtualizerConfig = {
    overscrollSize: 200,
    intersectionObserverMargin: 0,
    resizeDebugging: false,
  };
  private items: CodeViewContextItem<LAnnotation, Caret>[] = [];
  private idToItem: CodeViewItemMap<LAnnotation, Caret> = new Map();
  private selectedLines: CodeViewLineSelection | null = null;
  // One editor per edit-mode item, created lazily via options.createEditor.
  // Entries survive virtualization unmounts with their editor association;
  // attachedEditors tracks which entries currently render an editor surface.
  // Each record shares its instance's options
  // state, whose `id` updateItemId keeps pointed at the current item.
  private itemEditors: Map<
    string,
    CodeViewItemEditorRecord<LAnnotation, Caret>
  > = new Map();
  private attachedEditors: Set<string> = new Set();
  // NOTE(amadeus): We should probably attach an id to instances and use that
  // for lookups, instead of maintaining this map...
  private instanceToItem: Map<
    CodeViewVirtualizedInstanceKey,
    CodeViewContextItem<LAnnotation, Caret>
  > = new Map();
  private layoutDirtyIndex: number | undefined;
  private pendingLayoutReset: PendingCodeViewLayoutReset | undefined;
  private renderOptionsRevision = 0;
  private slotCoordinator: CodeViewCoordinator<LAnnotation, Caret> | undefined;
  private slotSnapshot: CodeViewSlotSnapshot<LAnnotation, Caret> | undefined;
  private scrollListeners: Set<CodeViewScrollListener<LAnnotation, Caret>> =
    new Set();
  private scrollHeight = 0;
  private containerHeight = -1;
  private scrollTop: number = 0;
  private scrollPageOffset: number = 0;
  private readonly scrollRebaseConfig: ScrollRebaseConfig = isFirefox()
    ? FIREFOX_SCROLL_REBASE
    : DEFAULT_SCROLL_REBASE;
  private scrollDirty = true;
  private scrollInteractionFixTimer: ReturnType<typeof setTimeout> | undefined;
  private pointerEventsDisabled = false;
  private codeOverflowFix = false;
  private height: number = 0;
  private heightDirty = true;
  private windowSpecs: VirtualWindowSpecs = { top: 0, bottom: 0 };
  private renderState = { ...INITIAL_RENDER_STATE };
  private itemMetricsCache: VirtualFileMetrics = DEFAULT_CODE_VIEW_FILE_METRICS;
  private readonly fileOptionsPrototype: object;
  private readonly diffOptionsPrototype: object;
  // Pending scroll target, either instant or smooth. The next render cycle
  // will attempt to resolve it's position instantly or as part of a dynamic
  // animation.
  //
  // - 'item' / 'line' targets stay here until isPendingTargetSettled returns
  //   true. Their destination top is re-derived from live layout every frame,
  //   absorbing async measurement (annotations, line wrap) that shifts the
  //   target mid-flight.
  // - 'position' targets settle on the first frame that applies their
  //   scrollTop — there is no layout-dependent destination to chase.
  private pendingScrollTarget: PendingScrollTarget | undefined;
  private pendingLayoutAnchor: ScrollAnchor | undefined;
  private shouldFixContainerFocus = false;

  // Active smooth-scroll animation state. Only populated while a scrollTo
  // with `behavior: 'smooth'` is in flight; cleared on settle (position +
  // velocity within epsilon of the destination) or on user-input abort.
  //
  // - position: current interpolated scrollTop, in CSS pixels.
  // - velocity: rate of change, in CSS pixels per millisecond.
  // - lastTimestamp: High Resolution Time (same clock as RAF timestamps)
  //   of the previous integration step.
  private scrollAnimation: ScrollToAnimation | undefined;

  private root: HTMLElement | undefined;
  private resizeObserver: ResizeObserver | undefined;

  private container: HTMLDivElement | undefined = document.createElement('div');
  private stickyContainer = document.createElement('div');
  private stickyOffset = document.createElement('div');
  // Always-rendered, non-virtualized header/footer hosts (element wrapper,
  // last-used render callback, and the measured height). They mount as
  // normal-flow siblings of `container` inside `root` — the header before it
  // and the footer after it.  Created lazily, never virtualized, so no pool
  // elements required
  private header: HeaderFooterHost = {
    element: undefined,
    render: undefined,
    height: 0,
  };
  private footer: HeaderFooterHost = {
    element: undefined,
    render: undefined,
    height: 0,
  };
  private elementPool: HTMLElement[] = [];
  private elementPoolVersion = 0;
  private elementPoolTracker = new WeakMap<HTMLElement, number>();
  // Container-managed elements may still have externally-owned light DOM slot
  // children after release, so hold them here until they are safe to reuse.
  // i.e. the react CodeView component will require a separate react cleanup
  // phase that we don't want to interrupt
  private pendingElementPool: HTMLElement[] = [];
  private options: CodeViewOptions<LAnnotation, Caret>;
  private workerManager: WorkerPoolManager | undefined;
  private isReadySubscription: (() => void) | undefined;
  private pendingHighlighterTheme: DiffsThemeNames | ThemesType | undefined;
  private isContainerManaged: boolean;

  constructor(
    options: CodeViewOptions<LAnnotation, Caret> = { theme: DEFAULT_THEMES },
    workerManager?: WorkerPoolManager | undefined,
    isContainerManaged = false
  ) {
    this.options = options;
    this.computeMetricsCache(options.itemMetrics);
    this.fileOptionsPrototype = this.createOptionsPrototype('file');
    this.diffOptionsPrototype = this.createOptionsPrototype('diff');
    this.workerManager = workerManager;
    this.isContainerManaged = isContainerManaged;

    this.stickyOffset.style.contain = 'layout size';
    const { style } = this.stickyContainer;
    style.position = 'sticky';
    style.width = '100%';
    style.contain = 'layout style inline-size';
    style.isolation = 'isolate';
    style.display = 'flex';
    style.flexDirection = 'column';
  }

  private getLayout(): CodeViewLayout {
    return this.options.layout ?? DEFAULT_CODE_VIEW_LAYOUT;
  }

  // Absolute offset (in scroll pixels) from the top of the scroll content to the
  // first virtualized item. paddingTop is the container's top margin; the header
  // host height is the always-rendered header that sits before the items and
  // pushes every item down by its measured height. Anchor/scroll-target math adds
  // this to an item's local `top` to get its absolute scroll position.
  private getItemTopOffset(): number {
    return this.getLayout().paddingTop + this.header.height;
  }

  private computeMetricsCache(
    itemMetrics: Partial<VirtualFileMetrics> | undefined
  ): VirtualFileMetrics {
    this.itemMetricsCache = {
      hunkLineCount:
        itemMetrics?.hunkLineCount ??
        DEFAULT_CODE_VIEW_FILE_METRICS.hunkLineCount,
      lineHeight:
        itemMetrics?.lineHeight ?? DEFAULT_CODE_VIEW_FILE_METRICS.lineHeight,
      diffHeaderHeight:
        itemMetrics?.diffHeaderHeight ??
        DEFAULT_CODE_VIEW_FILE_METRICS.diffHeaderHeight,
      hunkSeparatorHeight: itemMetrics?.hunkSeparatorHeight,
      spacing: itemMetrics?.spacing ?? DEFAULT_CODE_VIEW_FILE_METRICS.spacing,
      paddingTop: itemMetrics?.paddingTop,
      paddingBottom: itemMetrics?.paddingBottom,
    };
    return this.itemMetricsCache;
  }

  private getSmoothScrollSettings(): SmoothScrollSettings {
    return this.options.smoothScrollSettings ?? DEFAULT_SMOOTH_SCROLL_SETTINGS;
  }

  private shouldValidateItemHeights(): boolean {
    return (
      DIFFS_DEVELOPMENT_BUILD &&
      this.options.__devOnlyValidateItemHeights === true
    );
  }

  private validateRenderedItemHeight(
    item: CodeViewContextItem<LAnnotation, Caret>
  ): void {
    if (!this.shouldValidateItemHeights() || item.element == null) {
      return;
    }

    const stickySpecs = item.instance.getAdvancedStickySpecs();
    if (stickySpecs == null) {
      return;
    }

    const expectedHeight = stickySpecs.height;
    const actualHeight = item.element.getBoundingClientRect().height;

    if (expectedHeight === actualHeight) {
      return;
    }

    console.error(
      'CodeView: reconciled item height does not match DOM height',
      {
        id: item.item.id,
        type: item.type,
        index: item.index,
        version: item.version,
        expectedHeight,
        actualHeight,
        delta: actualHeight - expectedHeight,
        stickyTopOffset: stickySpecs.topOffset,
        virtualizedHeight: item.instance.getVirtualizedHeight(),
        top: item.top,
        scrollTop: this.getScrollTop(),
        windowSpecs: { ...this.windowSpecs },
        element: item.element,
        instance: item.instance,
      }
    );
  }

  // Dev-only invariant check: the sticky container only holds the currently
  // rendered item content, so its measured block-size must equal the
  // `stickyHeight` we derived from the first/last item sticky specs. Individual
  // item heights can all be correct while this aggregate is still wrong (for
  // example when an edge item reports a logical-bottom offset while it only
  // rendered its header), and that mismatch is what drives the sticky container
  // to position against the wrong bounds.
  private validateStickyContainerHeight(): void {
    if (!this.shouldValidateItemHeights()) {
      return;
    }

    const { firstIndex, lastIndex, stickyHeight, stickyTop, stickyBottom } =
      this.renderState;
    if (firstIndex === -1 || lastIndex === -1) {
      return;
    }

    const actualHeight = this.stickyContainer.getBoundingClientRect().height;
    if (Math.abs(actualHeight - stickyHeight) < SUB_PIXEL_TOLERANCE) {
      return;
    }

    console.error(
      'CodeView: sticky container height does not match computed layout',
      {
        computedStickyHeight: stickyHeight,
        actualStickyHeight: actualHeight,
        delta: actualHeight - stickyHeight,
        stickyTop,
        stickyBottom,
        firstIndex,
        lastIndex,
        firstStickySpecs:
          this.items[firstIndex]?.instance.getAdvancedStickySpecs(),
        lastStickySpecs:
          this.items[lastIndex]?.instance.getAdvancedStickySpecs(),
        scrollTop: this.getScrollTop(),
        scrollPageOffset: this.scrollPageOffset,
        windowSpecs: { ...this.windowSpecs },
        stickyContainer: this.stickyContainer,
      }
    );
  }

  private clearScrollInteractionTimer(): void {
    if (this.scrollInteractionFixTimer != null) {
      clearTimeout(this.scrollInteractionFixTimer);
      this.scrollInteractionFixTimer = undefined;
    }
  }

  private suspendScrollInteractions(): void {
    this.clearScrollInteractionTimer();

    if (
      this.options.pointerEventsOnScroll !== true &&
      !this.pointerEventsDisabled
    ) {
      this.stickyContainer.style.pointerEvents = 'none';
      this.pointerEventsDisabled = true;
    }

    // This is a really important fix for mobile safari; under aggressive scroll
    // conditions we'll eventually crash/reload the page. It appears to be
    // caused by the fact that the code wrapper elements are horizontally
    // scrollable, so while aggressively scrolling, we disable scrolling. We
    // don't want to apply this fix to good browsers since in those cases it
    // can fuck with layout in ways that aren't appropriate
    if (MOBILE_SAFARI && !this.codeOverflowFix) {
      this.stickyContainer.style.setProperty(
        SCROLLING_CODE_OVERFLOW_FIX_VARIABLE,
        'hidden'
      );
      this.codeOverflowFix = true;
    }

    this.scrollInteractionFixTimer = setTimeout(
      this.restoreScrollInteractions,
      DEFAULT_SCROLL_INTERACTION_RESTORE_DELAY_MS
    );
  }

  private restoreScrollInteractions = (): void => {
    this.clearScrollInteractionTimer();

    if (this.pointerEventsDisabled) {
      this.stickyContainer.style.removeProperty('pointer-events');
      this.pointerEventsDisabled = false;
    }

    if (this.codeOverflowFix) {
      this.stickyContainer.style.setProperty(
        SCROLLING_CODE_OVERFLOW_FIX_VARIABLE,
        'auto'
      );
      this.codeOverflowFix = false;
    }
  };

  private syncLayout(): void {
    const { gap, paddingBottom, paddingTop } = this.getLayout();
    this.stickyContainer.style.gap = `${gap}px`;
    this.container?.style.setProperty('margin-top', `${paddingTop}px`);
    this.container?.style.setProperty('margin-bottom', `${paddingBottom}px`);
  }

  // Reconcile a single host record: create + position + populate it when its
  // callback first appears, re-populate it when the callback reference changes,
  // and tear it down when the callback is removed. Otherwise the mounted host is
  // left untouched (its content is owned by the caller, or by React via a portal).
  // Mutates the record in place and returns whether its content changed.
  private reconcileHost(type: 'header' | 'footer'): boolean {
    const { container } = this;
    if (this.root == null || container == null) {
      return false;
    }

    const host = type === 'header' ? this.header : this.footer;
    const render =
      type === 'header'
        ? this.options.renderCodeViewHeader
        : this.options.renderCodeViewFooter;

    // Callback removed → the host should not exist; tear it down and reset height.
    if (render == null) {
      if (host.element == null) {
        return false;
      }
      this.resizeObserver?.unobserve(host.element);
      host.element.remove();
      host.element = undefined;
      host.render = undefined;
      this.setHostHeight(host, 0);
      return false;
    }

    // Same callback on a mounted host → its content is already current (the
    // common per-frame path).
    if (host.element != null && render === host.render) {
      return false;
    }

    // Callback added or swapped → ensure the host exists, then repopulate it from
    // the callback's latest output. A returned element replaces the content; a
    // nullish return empties the host, EXCEPT in container-managed (React) mode
    // where React owns the host's light DOM via a portal, so it is left untouched
    // (mirroring how cleanElement guards item light DOM).
    const element = (host.element ??= createCodeViewHeaderFooterHostElement(
      type,
      container,
      this.resizeObserver
    ));
    const content = render();
    if (content != null) {
      element.replaceChildren(content);
    } else if (!this.isContainerManaged && element.children.length > 0) {
      element.textContent = '';
    }
    host.render = render;
    return true;
  }

  // Store a host's measured height, flagging the scroll state dirty when it
  // actually changed so the surrounding render cycle re-derives the scroll range
  // and re-anchors (the header offset shifts every item's position).
  private setHostHeight(host: HeaderFooterHost, height: number): void {
    if (host.height === height) {
      return;
    }
    host.height = height;
    this.scrollDirty = true;
  }

  public setup(root: HTMLElement): void {
    if (this.root != null) {
      throw new Error('CodeView.setup: already setup');
    }
    this.workerManager?.subscribeToThemeChanges(this);
    this.root = root;
    root.style.overflowAnchor = 'none';
    if (!root.hasAttribute('tabindex')) {
      root.tabIndex = -1;
    }
    const container = (this.container ??= document.createElement('div'));
    // NOTE(amadeus): We can't put `size` in here or it breaks
    // Firefox's sticky headers
    container.style.contain = 'layout style';
    this.syncLayout();
    container.appendChild(this.stickyOffset);
    container.appendChild(this.stickyContainer);
    root.appendChild(container);
    this.scrollDirty = true;
    this.heightDirty = true;
    this.resizeObserver = new ResizeObserver(this.handleResize);
    this.resizeObserver.observe(this.stickyContainer);
    root.addEventListener('scroll', this.handleScroll, { passive: true });
    for (const type of USER_SCROLL_EVENTS) {
      root.addEventListener(type, this.clearPendingScroll, { passive: true });
    }
    this.resizeObserver.observe(root);
    this.render(true);

    // FIXME(amadeus): Remove me before release
    window.__INSTANCE = this;
    // Test code to bring back in if needed
    // window.__CODE_VIEW_SCROLL_BEFORE_REBASE = (pixelsBefore = 1_000) => {
    //   const target = this.clampScrollTop(
    //     this.scrollPageOffset + this.scrollRebaseConfig.threshold - pixelsBefore
    //   );
    //   this.scrollTo({
    //     type: 'position',
    //     position: target,
    //     behavior: 'instant',
    //   });
    // };
    window.__TOGGLE = () => {
      if (CodeView.__STOP) {
        CodeView.__STOP = false;
        this.scrollTo({
          type: 'position',
          position: CodeView.__lastScrollPosition,
          behavior: 'instant',
        });
      } else {
        CodeView.__lastScrollPosition = this.getScrollTop();
        CodeView.__STOP = true;
      }
    };
  }

  public reset(): void {
    dequeueRender(this.computeRenderRangeAndEmit);
    this.clearReadySubscription();
    this.restoreScrollInteractions();
    const { firstIndex, lastIndex } = this.renderState;
    if (firstIndex !== -1) {
      for (let index = firstIndex; index <= lastIndex; index++) {
        const item = this.items[index];
        if (item == null) {
          throw new Error(
            `CodeView.cleanAllRenderedItems: Item does not exist at index: ${index}`
          );
        }
        this.releaseRenderedItem(item);
      }
    }
    const { items: discardedItems } = this;
    // Ending an edit session must fire onItemEditComplete. All items are being
    // discarded, so sessions end like item removals: nothing gets installed or
    // written back. Sessions settle after the item maps below are cleared, to
    // ensure they act like removals
    const teardownSessions = [...this.itemEditors.values()];
    for (const { state } of teardownSessions) {
      const item = this.idToItem.get(state.id);
      if (item != null) {
        state.removedItem = item.item;
      }
    }
    this.itemEditors.clear();
    this.attachedEditors.clear();
    this.selectedLines = null;
    this.items = [];
    this.idToItem.clear();
    this.instanceToItem.clear();
    // Keeps the first error so every session and item still settles.
    let failure: { error: unknown } | undefined;
    for (const record of teardownSessions) {
      try {
        record.editor.cleanUp('discard');
      } catch (error) {
        failure ??= { error };
      }
    }
    for (const item of discardedItems) {
      try {
        item.instance.cleanUp();
      } catch (error) {
        failure ??= { error };
      }
    }
    this.layoutDirtyIndex = undefined;
    this.pendingLayoutReset = undefined;
    this.stickyContainer.textContent = '';
    this.stickyOffset.style.height = '';
    this.container?.style.removeProperty('height');
    this.containerHeight = -1;
    this.windowSpecs = { top: 0, bottom: 0 };
    this.pendingLayoutAnchor = undefined;
    this.shouldFixContainerFocus = false;
    this.height = 0;
    this.scrollTop = 0;
    this.scrollPageOffset = 0;
    this.scrollHeight = 0;
    this.scrollDirty = true;
    this.heightDirty = true;
    this.resetRenderState();
    // NOTE(amadeus): Container managed CodeView controls when flushing
    // occurs. This is mostly to make imperative vanilla js api easier to work
    // with
    if (!this.isContainerManaged) {
      this.flushSlotCoordinator();
    }
    if (failure != null) {
      throw failure.error;
    }
  }

  public cleanUp(): void {
    // A throwing completion handler must not stop the teardown below; the
    // reset settles every session first and its error rethrows at the end.
    try {
      this.reset();
    } finally {
      const { root } = this;
      this.clearElementPool();
      this.restoreScrollInteractions();
      this.workerManager?.unsubscribeToThemeChanges(this);
      this.resizeObserver?.disconnect();
      this.resizeObserver = undefined;
      root?.removeEventListener('scroll', this.handleScroll);
      for (const type of USER_SCROLL_EVENTS) {
        root?.removeEventListener(type, this.clearPendingScroll);
      }
      root?.style.removeProperty('overflow-anchor');
      this.container?.remove();
      this.stickyOffset.remove();
      this.stickyContainer.remove();
      this.stickyContainer.textContent = '';
      for (const host of [this.header, this.footer]) {
        host.element?.remove();
        host.element = undefined;
        host.render = undefined;
        host.height = 0;
      }
      this.root = undefined;
      this.container = undefined;
    }
  }

  private getElementPoolLimit() {
    const viewportSize = this.getHeight() + this.config.overscrollSize * 2;
    const { diffHeaderHeight } = this.itemMetricsCache;
    // The goal here roughly is to hold an element pool that's maxed out at
    // around the size of all collapsed files, doubled if `isContainerManaged`
    // because we have to wait an additional render tick to actually re-use the
    // elements
    return (
      Math.max(
        8,
        Math.ceil(viewportSize / Math.max(diffHeaderHeight, 10)) + 1
      ) * (this.isContainerManaged ? 2 : 1)
    );
  }

  private acquireElement(): HTMLElement {
    // Promote pending elements whose externally-owned light DOM is now gone.
    if (this.pendingElementPool.length > 0) {
      const { pendingElementPool: pendingElements } = this;
      this.pendingElementPool = [];
      const poolLimit = this.getElementPoolLimit();
      for (const element of pendingElements) {
        if (!this.isElementPoolGenerationCurrent(element)) {
          continue;
        }
        if (
          element.childNodes.length === 0 &&
          this.elementPool.length < poolLimit
        ) {
          this.elementPool.push(element);
        } else if (this.getElementPoolSize() < poolLimit) {
          this.pendingElementPool.push(element);
        }
      }
    }
    let element = this.elementPool.pop();
    while (element != null && !this.isElementPoolGenerationCurrent(element)) {
      element = this.elementPool.pop();
    }
    element ??= document.createElement(DIFFS_TAG_NAME);
    this.elementPoolTracker.set(element, this.elementPoolVersion);
    return element;
  }

  private releaseRenderedItem(
    item: CodeViewContextItem<LAnnotation, Caret>
  ): void {
    const { element } = item;
    if (element != null) {
      const { activeElement } = document;
      if (
        activeElement === element ||
        element.contains(activeElement) ||
        element.shadowRoot?.activeElement != null
      ) {
        this.shouldFixContainerFocus = true;
      }
    }

    item.instance.cleanUp(true);
    // Instance cleanup suspends the editor surface. The association stays in
    // itemEditors so the same component and editor resume on remount.
    this.attachedEditors.delete(item.item.id);
    item.element = undefined;
    if (element == null) {
      return;
    }

    element.remove();
    // Strip item-specific DOM while keeping the expensive shared shell assets
    // that are valid for every item in this CodeView until shared options
    // change.
    const { shadowRoot } = element;
    if (shadowRoot != null) {
      for (const child of Array.from(shadowRoot.children)) {
        const isSharedAsset =
          child instanceof SVGElement ||
          (isStyleNode(child) &&
            (child.hasAttribute(CORE_CSS_ATTRIBUTE) ||
              child.hasAttribute(THEME_CSS_ATTRIBUTE) ||
              child.hasAttribute(UNSAFE_CSS_ATTRIBUTE)));
        if (!isSharedAsset) {
          child.remove();
        }
      }
    }
    if (!this.isContainerManaged) {
      element.replaceChildren();
    }

    const poolLimit = this.getElementPoolLimit();
    if (
      !this.isElementPoolGenerationCurrent(element) ||
      this.getElementPoolSize() >= poolLimit
    ) {
      return;
    }
    if (element.childNodes.length === 0) {
      this.elementPool.push(element);
    } else {
      this.pendingElementPool.push(element);
    }
  }

  private getElementPoolSize(): number {
    return this.elementPool.length + this.pendingElementPool.length;
  }

  private clearElementPool(): void {
    this.elementPool.length = 0;
    this.pendingElementPool.length = 0;
  }

  private invalidateElementPool(): void {
    this.elementPoolVersion++;
    this.clearElementPool();
  }

  private isElementPoolGenerationCurrent(element: HTMLElement): boolean {
    return this.elementPoolTracker.get(element) === this.elementPoolVersion;
  }

  public scrollTo(target: CodeViewScrollTarget): void {
    if (this.root == null) {
      return;
    }

    const pendingTarget = this.normalizeScrollTarget(target);
    if (pendingTarget == null) {
      return;
    }

    const destination = this.resolveScrollTargetTop(pendingTarget);
    if (destination == null) {
      return;
    }

    if (pendingTarget.type !== 'position') {
      void this.idToItem.get(pendingTarget.id)?.instance.primeHighlightCache();
    }

    // 'smooth-auto' animates only short jumps (within 10 viewports).
    const { behavior } = pendingTarget;
    if (
      !prefersReducedMotion() &&
      (behavior === 'smooth' ||
        (behavior === 'smooth-auto' &&
          Math.abs(destination - this.getScrollTop()) <= this.getHeight() * 10))
    ) {
      // Use ??= so if we have an animation in progress it will be smoothly
      // transitioned into the new target and not reset
      this.scrollAnimation ??= {
        position: this.getScrollTop(),
        velocity: 0,
        // Since we kick off a render to requestAnimationFrame, by initializing
        // lastTimestamp as performance.now() it means we can begin animating
        // on the next render call and not wait a frame to get frame time
        lastTimestamp: performance.now(),
      };
    } else {
      this.scrollAnimation = undefined;
    }

    // We'll attempt to scroll to this new target on the next render frame
    this.suspendScrollInteractions();
    this.pendingLayoutAnchor = undefined;
    this.pendingScrollTarget = pendingTarget;
    this.render();
  }

  public setSelectedLines(
    selection: CodeViewLineSelection | null,
    options?: SelectionWriteOptions
  ): void {
    this.applySelectedLines(selection, options);
  }

  public getSelectedLines(): CodeViewLineSelection | null {
    return this.selectedLines;
  }

  public clearSelectedLines(options?: SelectionWriteOptions): void {
    this.applySelectedLines(null, options);
  }

  public getItem(itemId: string): CodeViewItem<LAnnotation> | undefined {
    return this.idToItem.get(itemId)?.item;
  }

  /**
   * Returns the editor while this item is being edited. Partial diffs get an
   * editor after their files load; scrolling away or collapsing keeps it.
   */
  public getEditor(
    itemId: string
  ): CodeViewEditor<LAnnotation, Caret> | undefined {
    return this.itemEditors.get(itemId)?.editor;
  }

  public updateItem(input: CodeViewItem<LAnnotation>): boolean {
    const item = this.idToItem.get(input.id);
    if (item == null) {
      console.error(`CodeView.updateItem: unknown item id "${input.id}"`);
      return false;
    }

    if (!this.syncItemRecord(item, input)) {
      return false;
    }

    this.markItemLayoutDirty(item);
    this.scrollDirty = true;
    this.render();
    this.syncItemEditors();
    this.syncSelection();
    return true;
  }

  public updateItemId(oldId: string, newId: string): boolean {
    if (oldId === newId) {
      return true;
    }

    const item = this.idToItem.get(oldId);
    if (item == null) {
      console.error(`CodeView.updateItemId: unknown item id "${oldId}"`);
      return false;
    }

    if (this.idToItem.has(newId)) {
      console.error(`CodeView.updateItemId: duplicate item id "${newId}"`);
      return false;
    }

    this.idToItem.delete(oldId);
    item.item.id = newId;
    this.idToItem.set(newId, item);
    const state = getItemOptionsState<LAnnotation>(item.instance.options);
    if (state == null) {
      throw new Error(`CodeView.updateItemOptionsId: No valid state`);
    }
    state.id = newId;

    if (this.selectedLines?.id === oldId) {
      this.selectedLines = { ...this.selectedLines, id: newId };
      this.options.onSelectedLinesChange?.(this.selectedLines);
    }
    const editorRecord = this.itemEditors.get(oldId);
    if (editorRecord != null) {
      this.itemEditors.delete(oldId);
      this.itemEditors.set(newId, editorRecord);
      if (this.attachedEditors.delete(oldId)) {
        this.attachedEditors.add(newId);
      }
    }
    const { pendingScrollTarget } = this;
    if (
      pendingScrollTarget != null &&
      pendingScrollTarget.type !== 'position' &&
      pendingScrollTarget.id === oldId
    ) {
      this.pendingScrollTarget = { ...pendingScrollTarget, id: newId };
    }
    if (this.pendingLayoutAnchor?.id === oldId) {
      this.pendingLayoutAnchor.id = newId;
    }
    this.render();
    return true;
  }

  public addItem(input: CodeViewItem<LAnnotation>): void {
    this.addItems([input]);
  }

  public addItems(inputs: readonly CodeViewItem<LAnnotation>[]): void {
    this.appendItemsInternal(inputs);
    this.syncItemEditors();
    this.syncSelection();
  }

  public removeItem(itemId: string): boolean {
    const item = this.idToItem.get(itemId);
    if (item == null) {
      console.error(`CodeView.removeItem: unknown item id "${itemId}"`);
      return false;
    }

    const nextItems: CodeViewItem<LAnnotation>[] = [];
    for (const current of this.items) {
      if (current !== item) {
        nextItems.push(current.item);
      }
    }
    this.setItems(nextItems);
    return true;
  }

  public setItems(items: readonly CodeViewItem<LAnnotation>[]): void {
    let removedItemsById:
      | Readonly<CodeViewItemMap<LAnnotation, Caret>>
      | undefined;
    if (this.items.length === 0) {
      this.appendItemsInternal(items);
    } else if (!this.tryAppendItems(items)) {
      removedItemsById = this.reconcileItems(items);
    }
    try {
      this.syncItemEditors(removedItemsById);
    } finally {
      for (const removedItem of removedItemsById?.values() ?? []) {
        removedItem.instance.cleanUp();
      }
    }
    this.syncSelection();
  }

  // Append new records to the viewer while preserving existing layout state.
  // This is the shared path for imperative adds and the append-only reconcile
  // fast path, so it measures new items immediately and only triggers render
  // once at the end.
  private appendItemsInternal(
    inputs: readonly CodeViewItem<LAnnotation>[],
    render = true
  ): void {
    if (inputs.length === 0) {
      return;
    }

    const layout = this.getLayout();
    let nextTop = this.items.length === 0 ? 0 : this.scrollHeight + layout.gap;
    const appendedTop = nextTop;
    for (const input of inputs) {
      if (this.idToItem.has(input.id)) {
        throw new Error(`CodeView.addItem: duplicate id "${input.id}"`);
      }

      const item = this.createItem(input, this.items.length, nextTop);
      this.items.push(item);
      this.idToItem.set(input.id, item);
      this.instanceToItem.set(item.instance, item);
      item.instance.cleanUp(true);
      item.height = updateItemLayout(item, nextTop);
      nextTop += item.height + layout.gap;
    }

    this.scrollHeight = nextTop - layout.gap;
    this.scrollDirty = true;
    if (!render) {
      return;
    }
    // Items appended below the rendered window only grow the scroll range.
    if (
      this.container != null &&
      this.renderState.firstIndex !== -1 &&
      this.pendingScrollTarget == null &&
      this.scrollAnimation == null &&
      this.layoutDirtyIndex == null &&
      appendedTop > this.windowSpecs.bottom
    ) {
      this.syncContainerHeight();
    } else {
      this.render();
    }
  }

  public onThemeChange(): void {
    this.invalidateElementPool();
  }

  public setOptions(
    options: CodeViewOptions<LAnnotation, Caret> | undefined
  ): void {
    if (options == null) {
      return;
    }

    this.capturePendingLayoutAnchor();
    const { options: prevOptions } = this;
    const previousLayout = this.getLayout();
    const { itemMetricsCache: previousItemMetrics } = this;

    const unsafeCSSChanged = prevOptions.unsafeCSS !== options.unsafeCSS;
    if (
      unsafeCSSChanged ||
      !areThemesEqual(
        prevOptions.theme ?? DEFAULT_THEMES,
        options.theme ?? DEFAULT_THEMES
      ) ||
      (prevOptions.themeType ?? 'system') !== (options.themeType ?? 'system')
    ) {
      this.invalidateElementPool();
    }

    this.options = options;
    const nextItemMetrics = this.computeMetricsCache(options.itemMetrics);
    const itemMetricsChanged = !areObjectsEqual(
      previousItemMetrics,
      nextItemMetrics
    );
    const layoutChanged = !areObjectsEqual(previousLayout, this.getLayout());
    if (layoutChanged) {
      this.syncLayout();
    }

    const itemLayoutChanged =
      itemMetricsChanged ||
      unsafeCSSChanged ||
      hasOptionChanged(prevOptions, options, ITEM_LAYOUT_OPTION_DEFAULTS);
    if (itemLayoutChanged) {
      const previousReset = this.pendingLayoutReset;
      this.pendingLayoutReset = {
        metrics: itemMetricsChanged ? nextItemMetrics : previousReset?.metrics,
        resetFileLayoutCache: true,
        resetDiffLayoutCache: true,
        includeEstimatedDiffHeights:
          previousReset?.includeEstimatedDiffHeights === true ||
          itemMetricsChanged ||
          hasOptionChanged(prevOptions, options, DIFF_ESTIMATE_OPTION_DEFAULTS),
      };
    }

    if (layoutChanged || itemLayoutChanged) {
      this.markLayoutDirtyFromIndex(0);
      this.scrollDirty = true;
    }

    if (!areOptionsEqual(prevOptions, options)) {
      this.renderOptionsRevision++;
    }

    this.syncItemEditors();

    // Render when there are items, OR when the header/footer presence changed —
    // an otherwise-empty CodeView still needs a render to mount/unmount its hosts.
    const headerFooterChanged =
      prevOptions.renderCodeViewHeader !== options.renderCodeViewHeader ||
      prevOptions.renderCodeViewFooter !== options.renderCodeViewFooter;
    if (
      !this.isContainerManaged &&
      (this.items.length > 0 || headerFooterChanged)
    ) {
      this.render();
    }
  }

  public capturePendingLayoutAnchor(
    nextItems: Readonly<CodeViewItemMap<LAnnotation, Caret>> = this.idToItem
  ): void {
    if (
      this.root == null ||
      this.items.length === 0 ||
      this.pendingScrollTarget != null
    ) {
      return;
    }

    this.pendingLayoutAnchor = this.getScrollAnchor(
      this.getScrollTop(),
      nextItems
    );
  }

  public render(immediate = false): void {
    if (CodeView.__STOP) {
      return;
    }
    if (immediate) {
      dequeueRender(this.computeRenderRangeAndEmit);
      this.computeRenderRangeAndEmit();
    } else {
      queueRender(this.computeRenderRangeAndEmit);
    }
  }

  private isReady(): boolean {
    const { workerManager } = this;
    // A failed worker pool never reaches the 'initialized' state (it reverts
    // to 'waiting' with workersFailed: true), so it renders through the shared
    // highlighter instead.
    if (workerManager == null || workerManager.getStats().workersFailed) {
      return this.isSharedHighlighterReady();
    }
    if (workerManager.isInitialized()) {
      this.clearReadySubscription();
      return true;
    }

    this.isReadySubscription ??= workerManager.subscribeToStatChanges(
      (stats) => {
        if (stats.managerState !== 'initialized' && !stats.workersFailed) {
          return;
        }

        this.clearReadySubscription();
        this.render(true);
      }
    );

    // If the worker is awiting on initialization, we should attempt to
    // initialize
    if (workerManager.getStats().managerState === 'waiting') {
      void workerManager.initialize().catch(() => {});
    }
    return false;
  }

  private clearReadySubscription(): void {
    if (this.isReadySubscription == null) {
      return;
    }
    this.isReadySubscription();
    this.isReadySubscription = undefined;
    this.pendingHighlighterTheme = undefined;
  }

  private isSharedHighlighterReady(): boolean {
    const theme =
      this.workerManager?.getFileRenderOptions().theme ??
      this.options.theme ??
      DEFAULT_THEMES;
    if (getHighlighterIfLoaded({ theme }) != null) {
      this.clearReadySubscription();
      return true;
    }
    // A pending request for an obsolete theme must not block the current one.
    if (!areThemesEqual(this.pendingHighlighterTheme, theme)) {
      this.clearReadySubscription();
    }
    this.isReadySubscription ??= (() => {
      this.pendingHighlighterTheme = theme;
      let cancelled = false;
      void preloadHighlighter({
        themes: getThemes(theme),
        langs: [],
        preferredHighlighter: resolvePreferredHighlighter(
          this.workerManager,
          this.options
        ),
      }).then(
        () => {
          if (cancelled) {
            return;
          }
          this.clearReadySubscription();
          this.render(true);
        },
        (error: unknown) => {
          if (cancelled) {
            return;
          }
          // Let a later render retry without looping on a failing loader.
          this.clearReadySubscription();
          if (!(error instanceof HighlighterDisposedError)) {
            console.error(error);
          }
        }
      );
      return () => {
        cancelled = true;
      };
    })();
    return false;
  }

  public instanceChanged(
    instance: CodeViewVirtualizedInstanceKey,
    layoutDirty: boolean
  ): void {
    // NOTE(amadeus): This is technically broken at the moment. What we
    // probably SHOULD do to fix is, it push the instance to some sort of
    // instance changed set, then iterate through all items and re-compute
    // everything to get new tops?
    const item = this.instanceToItem.get(instance);
    if (item == null) {
      throw new Error(
        'CodeView.instanceChanged: An instance has changed that is not registered'
      );
    }
    if (layoutDirty) {
      this.markItemLayoutDirty(item);
    }
    this.render();
  }

  public getWindowSpecs(): VirtualWindowSpecs {
    return this.windowSpecs;
  }

  public getContainerElement(): HTMLElement | undefined {
    return this.root;
  }

  // The always-rendered header/footer host elements, or undefined when the
  // corresponding renderCodeViewHeader/renderCodeViewFooter callback is not
  // set. React reads these to portal its header/footer nodes into the
  // vanilla-managed hosts.
  public getHeaderElement(): HTMLElement | undefined {
    return this.header.element;
  }

  public getFooterElement(): HTMLElement | undefined {
    return this.footer.element;
  }

  public getRenderedItems(): CodeViewRenderedItem<LAnnotation, Caret>[] {
    const { firstIndex, lastIndex } = this.renderState;
    if (firstIndex === -1) {
      return [];
    }

    const renderedItems: CodeViewRenderedItem<LAnnotation, Caret>[] = [];
    for (let index = firstIndex; index <= lastIndex; index++) {
      const item = this.items[index];
      if (item?.element != null) {
        renderedItems.push({
          id: item.item.id,
          type: item.type,
          item: item.item,
          version: item.version,
          element: item.element,
          instance: item.instance,
        } as CodeViewRenderedItem<LAnnotation, Caret>);
      }
    }
    return renderedItems;
  }

  public setSlotCoordinator(
    coordinator?: CodeViewCoordinator<LAnnotation, Caret>
  ): boolean {
    if (coordinator === this.slotCoordinator) {
      return false;
    }
    this.slotCoordinator = coordinator;
    this.slotSnapshot = undefined;
    return true;
  }

  // Combine the per-item slot items with the current header/footer host elements
  // into a single snapshot. Returns undefined only when there is nothing for
  // React to portal.
  public getSlotSnapshot({
    hasHeaderRenderers,
    hasAnnotationRenderer,
    hasGutterRenderer,
  }: CodeViewCoordinator<LAnnotation, Caret>):
    | CodeViewSlotSnapshot<LAnnotation, Caret>
    | undefined {
    let items: CodeViewRenderedItem<LAnnotation, Caret>[] | undefined =
      this.getRenderedItems();
    // Annotation-only renderers need just the items that have annotations.
    if (!hasHeaderRenderers && !hasGutterRenderer) {
      items = hasAnnotationRenderer
        ? items.filter(({ item }) => (item.annotations?.length ?? 0) > 0)
        : undefined;
    }
    if (items?.length === 0) {
      items = undefined;
    }
    const { element: header } = this.header;
    const { element: footer } = this.footer;
    if (items == null && header == null && footer == null) {
      return undefined;
    }
    return { items, header, footer };
  }

  public subscribeToScroll(
    listener: CodeViewScrollListener<LAnnotation, Caret>
  ): () => void {
    this.scrollListeners.add(listener);
    return () => {
      this.scrollListeners.delete(listener);
    };
  }

  public getLocalTopForInstance(
    instance: CodeViewVirtualizedInstanceKey
  ): number {
    const item = this.instanceToItem.get(instance);
    if (item == null) {
      throw new Error(
        'CodeView.getLocalTopForInstance: unknown virtualized instance'
      );
    }
    return item.top;
  }

  public getTopForItem(id: string): number | undefined {
    const item = this.idToItem.get(id);
    if (item == null) {
      return undefined;
    }
    return item.top + this.getItemTopOffset();
  }

  private createItem(
    input: CodeViewItem<LAnnotation>,
    index: number,
    top: number
  ): CodeViewContextItem<LAnnotation, Caret> {
    const { itemMetricsCache, workerManager, isContainerManaged } = this;
    const isDiff = input.type === 'diff';
    // The per-item options object owns only hidden, non-enumerable state. All
    // public option reads fall through to the shared prototype. Renderer option
    // builders must copy known keys explicitly, never rely on object spread.
    const options = Object.create(
      isDiff ? this.diffOptionsPrototype : this.fileOptionsPrototype
    ) as FileOptions<LAnnotation, Caret> & FileDiffOptions<LAnnotation, Caret>;
    Object.defineProperty(options, CODE_VIEW_ITEM_OPTIONS_STATE, {
      value: { id: input.id } satisfies CodeViewItemOptionsState<LAnnotation>,
    });
    const instance = isDiff
      ? new VirtualizedFileDiff<LAnnotation, Caret>(
          options,
          this,
          itemMetricsCache,
          workerManager,
          isContainerManaged
        )
      : new VirtualizedFile<LAnnotation, Caret>(
          options,
          this,
          itemMetricsCache,
          workerManager,
          isContainerManaged
        );
    return {
      type: isDiff ? 'diff' : 'file',
      item: input,
      version: input.version,
      index,
      top,
      height: 0,
      element: undefined,
      renderedOptionsRevision: this.renderOptionsRevision,
      instance,
    } as CodeViewContextItem<LAnnotation, Caret>;
  }

  private applySelectedLines(
    selection: CodeViewLineSelection | null,
    options?: SelectionWriteOptions
  ): void {
    const { selectedLines: prevSelection } = this;
    if (
      (selection == null && prevSelection == null) ||
      (selection != null &&
        prevSelection?.id === selection.id &&
        areSelectionsEqual(prevSelection.range, selection.range))
    ) {
      return;
    }

    // If we are selecting a new element and had a previous selection, null out
    // the current selection, otherwise if it's a selection on the same item
    // the next selection will take care of that for us
    if (prevSelection != null && prevSelection.id !== selection?.id) {
      this.idToItem
        .get(prevSelection.id)
        ?.instance.setSelectedLines(null, { notify: false });
    }

    this.selectedLines = selection;
    this.idToItem
      .get(selection?.id ?? '')
      ?.instance.setSelectedLines(selection?.range ?? null, options);
  }

  private syncSelection(): void {
    if (this.selectedLines == null) {
      return;
    }

    const item = this.idToItem.get(this.selectedLines.id);
    if (item == null) {
      this.selectedLines = null;
      this.options.onSelectedLinesChange?.(null);
      return;
    }

    item.instance.setSelectedLines(this.selectedLines.range, { notify: false });
  }

  // Lazily create and attach the editor for a mounted edit-mode item. Called
  // from the render loop for fresh mounts, remounts after virtualization
  // released the item, and items whose edit flag just turned on. Editors
  // persist across unmounts, so a remount resumes the existing editor and
  // document; the instance keeps its private session model so the remount
  // paints the edited text without changing the host input.
  private attachItemEditor(
    item: CodeViewContextItem<LAnnotation, Caret>
  ): void {
    const { id, edit, collapsed } = item.item;
    const { createEditor } = this.options;
    // Collapsing an edited item suspends editing until it expands again.
    if (
      item.element == null ||
      this.attachedEditors.has(id) ||
      edit !== true ||
      collapsed === true
    ) {
      return;
    }

    const record = this.itemEditors.get(id);
    let createdEditor: CodeViewEditor<LAnnotation, Caret> | undefined;
    try {
      if (
        record == null &&
        item.type === 'diff' &&
        !item.instance.__canAttachEditor()
      ) {
        void item.instance.__prepareForEditing();
        return;
      }
      if (record == null) {
        if (createEditor == null) {
          throw new Error(
            'CodeView: createEditor is required for items with edit: true'
          );
        }
        const state = getItemOptionsState<LAnnotation>(item.instance.options);
        if (state == null) {
          throw new Error(
            'CodeView.attachItemEditor: instance options are missing their state'
          );
        }
        // The onChange closure resolves the owning item through the options
        // state's current id (not the id captured here) so updateItemId
        // renames keep it pointed at the right item. It also reads the change
        // callback off this.options at invocation time so later setOptions
        // swaps aren't stranded on the callback captured at creation.
        const onChange = (
          event: EditorChangeEvent<EditorType, LAnnotation, Caret>
        ) => {
          const latest = this.idToItem.get(state.id);
          if (latest == null) {
            return;
          }
          this.options.onItemEditChange?.(event, latest.item);
        };
        const editor = createEditor(
          item.type === 'diff' ? 'file-diff' : 'file',
          { onChange },
          this.options.getEditStateKey?.(item.item)
        );
        createdEditor = editor as CodeViewEditor<LAnnotation, Caret>;
        this.itemEditors.set(id, {
          editor: createdEditor,
          state,
          dispose: editor.edit(item.instance),
        });
      } else {
        // A record's editor kind always matches its item's instance type.
        record.dispose = (
          record.editor as Editor<EditorType, LAnnotation, Caret>
        ).edit(item.instance);
      }
      this.attachedEditors.add(id);
    } catch (error) {
      // A newly-created editor that failed to attach is cleaned up; an
      // existing editor keeps its record and session for the next attempt.
      createdEditor?.cleanUp();
      // A render-time factory or attachment error aborts the frame before its
      // range is committed, so release this item immediately instead of
      // leaving an untracked async render behind.
      this.releaseRenderedItem(item);
      throw error;
    }
  }

  // Reconcile the editors CodeView is holding: complete sessions for items
  // whose edit turned off or that were removed, and suspend sessions for
  // collapsed items (the editor tears down, the record and the instance's
  // session stay for the next expand). Attachment happens in the render loop
  // via attachItemEditor.
  private syncItemEditors(
    removedItems?: Readonly<CodeViewItemMap<LAnnotation, Caret>>
  ): void {
    if (this.itemEditors.size === 0) {
      return;
    }

    const completions: CodeViewItemEditorRecord<LAnnotation, Caret>[] = [];
    for (const [id, record] of this.itemEditors) {
      const removedItem = removedItems?.get(id);
      if (removedItem != null) {
        // The item is gone from idToItem; leave it on the shared options
        // state for the completion adapter.
        record.state.removedItem = removedItem.item;
      } else {
        const item = this.idToItem.get(id);
        if (item != null) {
          const { edit = false, collapsed = false } = item.item;
          if (edit) {
            // Collapse suspends editor rendering. Keep its component
            // association, document, and undo history for expansion;
            // DOM-backed state resets.
            if (collapsed && this.attachedEditors.delete(id)) {
              record.editor.cleanUp('recycle');
            }
            continue;
          }
        }
      }
      // If we get here, it means the edit session is over and we need to queue
      // up completion
      this.itemEditors.delete(id);
      this.attachedEditors.delete(id);
      completions.push(record);
    }
    if (completions.length === 0) {
      return;
    }

    // dispose() runs onItemEditComplete, and that handler may call
    // updateItem/setItems, so it must not run while iterating itemEditors
    // above. If a handler throws, the other sessions still complete and the
    // first error rethrows at the end.
    let failure: { error: unknown } | undefined;
    for (const record of completions) {
      try {
        record.dispose();
      } catch (error) {
        failure ??= { error };
      }
      // Settling rerendered the instance with whatever the session decided;
      // its height may have changed.
      const item = this.idToItem.get(record.state.id);
      if (item != null) {
        this.markItemLayoutDirty(item);
      }
    }
    this.render();
    if (failure != null) {
      throw failure.error;
    }
  }

  // Item-instance `onEditComplete` adapter: builds the accepted next item,
  // hands it to `onItemEditComplete` alongside the event and the owning item,
  // and translates the identity of the returned item to the component return
  // contract.
  private completeItemEdit(
    state: CodeViewItemOptionsState<LAnnotation>,
    mode: CodeViewMode,
    event:
      | FileEditCompleteEvent<LAnnotation, Caret>
      | FileDiffEditCompleteEvent<LAnnotation, Caret>
  ): EditCompletionDecision {
    // The live record when the item still exists, or the removal-time record
    // left on the options state.
    const item = this.idToItem.get(state.id)?.item ?? state.removedItem;
    if (item == null) {
      throw new Error(
        `CodeView.onItemEditComplete: unknown item "${state.id}"`
      );
    }
    if (item.type !== mode) {
      throw new Error(
        `CodeView.onItemEditComplete: item "${state.id}" is not a ${mode} item`
      );
    }
    const nextItem = {
      ...item,
      annotations: event.lineAnnotations,
      edit: false,
      version: (item.version ?? 0) + 1,
    } as CodeViewItem<LAnnotation>;
    if (nextItem.type === 'diff') {
      nextItem.fileDiff = (
        event as FileDiffEditCompleteEvent<LAnnotation, Caret>
      ).fileDiff;
    } else {
      nextItem.file = (event as FileEditCompleteEvent<LAnnotation, Caret>).file;
    }
    const decision =
      this.options.onItemEditComplete?.(event, item, nextItem) ?? 'reject';
    if (decision === 'reject') {
      return 'reject';
    }
    if (this.idToItem.has(item.id)) {
      // The accepted item goes through the normal update path; updateItem
      // only queues its render, so nothing paints mid-settle. A removed
      // item's acceptance is recorded by the settle but never reinserted.
      this.updateItem(nextItem);
    }
    return 'accept';
  }

  // CodeView owns advanced option invalidation. These item option facades only
  // answer current option reads for the item instance that keeps them for its
  // lifetime. The accessors live on per-CodeView prototypes so large viewers do
  // not allocate the full option surface for every file or diff item.
  private createOptionsPrototype(mode: CodeViewMode): object {
    const prototype = {};

    for (const key of mode === 'file'
      ? CODE_VIEW_FILE_OPTION_KEYS
      : CODE_VIEW_DIFF_OPTION_KEYS) {
      defineItemOption(prototype, key, () => this.options[key]);
    }

    // Mapped options: served from CodeView-level names or per-item state
    // that the plain pass-through loop cannot express.
    defineItemOption(
      prototype,
      'stickyHeader',
      () => this.options.stickyHeaders
    );
    if (mode === 'diff') {
      defineItemOption(
        prototype,
        'hunkSeparators',
        () => this.options.hunkSeparators
      );
    }
    defineItemOption(prototype, 'collapsed', (receiver) => {
      const state = getItemOptionsState<LAnnotation>(receiver);
      if (state == null) {
        return undefined;
      }
      return this.getItemOptions(state, mode)?.item.collapsed;
    });
    defineItemOption(prototype, 'onEditComplete', (receiver) => {
      if (this.options.onItemEditComplete == null) {
        return undefined;
      }
      const state = getItemOptionsState<LAnnotation>(receiver);
      if (state == null) {
        return undefined;
      }
      return (
        event:
          | FileEditCompleteEvent<LAnnotation, Caret>
          | FileDiffEditCompleteEvent<LAnnotation, Caret>
      ) => this.completeItemEdit(state, mode, event);
    });

    // Callback options resolve to per-item wrappers that append the item
    // context. Selection wrappers also own CodeView selection sync, so they
    // exist even without a user callback.
    for (const keys of [
      CODE_VIEW_SHARED_CALLBACK_KEYS,
      CODE_VIEW_SELECTION_CALLBACK_KEYS,
    ]) {
      const isSelection = keys === CODE_VIEW_SELECTION_CALLBACK_KEYS;
      for (const key of keys) {
        defineItemOption(prototype, key, (receiver) => {
          if (!isSelection && this.options[key] == null) {
            return undefined;
          }
          const state = getItemOptionsState<LAnnotation>(receiver);
          if (state == null) {
            return undefined;
          }
          // Allocate wrapper storage only once a callback option is actually
          // observed. Most large CodeViews never read these callback properties.
          const callbackCache = (state.callbackCache ??= {});
          return (callbackCache[key] ??= (...args: unknown[]) => {
            const latest = this.getItemOptions(state, mode);
            if (latest == null) {
              return undefined;
            }
            if (isSelection) {
              const range = args[0] as SelectedLineRange | null;
              const selection =
                range == null ? null : { id: latest.item.id, range };
              if (
                this.options.controlledSelection !== true &&
                (range != null || this.selectedLines?.id === latest.item.id)
              ) {
                this.applySelectedLines(selection, { notify: false });
              }
              this.options.onSelectedLinesChange?.(selection);
            }
            const callback = this.options[key] as
              | ((...callbackArgs: unknown[]) => unknown)
              | undefined;
            return isSelection
              ? callback?.(args[0], latest)
              : callback?.(...args, latest);
          });
        });
      }
    }

    return prototype;
  }

  private getItemOptions<TMode extends CodeViewMode>(
    state: CodeViewItemOptionsState<LAnnotation>,
    mode: TMode
  ): CodeViewModeItemContext<LAnnotation, Caret, TMode> | undefined {
    const item = this.idToItem.get(state.id);
    if (item == null || item.type !== mode) {
      return undefined;
    }
    return item as CodeViewModeItemContext<LAnnotation, Caret, TMode>;
  }

  // Track the earliest index whose measured layout may now be stale. Later
  // render passes relayout from this point forward so we do not have to rebuild
  // positions for the whole list after every change.
  private markLayoutDirtyFromIndex(index: number): void {
    this.layoutDirtyIndex = Math.min(this.layoutDirtyIndex ?? index, index);
  }

  // Mark the earliest affected item as layout-dirty after an imperative change.
  // Each record carries its current array index so this stays O(1) even when
  // the viewer holds a very large number of items.
  private markItemLayoutDirty(
    item: CodeViewContextItem<LAnnotation, Caret>
  ): void {
    if (this.items[item.index] !== item) {
      throw new Error(
        `CodeView.markItemLayoutDirty: unknown item id "${item.item.id}"`
      );
    }

    this.markLayoutDirtyFromIndex(item.index);
  }

  // Detect the common controlled-update case where the new list simply extends
  // the existing ordered prefix. When that happens we can reuse every current
  // record in place, sync any versioned payload changes, and append only the new
  // tail instead of rebuilding the whole list.
  private tryAppendItems(items: readonly CodeViewItem<LAnnotation>[]): boolean {
    if (items.length <= this.items.length) {
      return false;
    }

    for (let index = 0; index < this.items.length; index++) {
      const existingItem = this.items[index];
      const nextItem = items[index];
      if (
        nextItem == null ||
        existingItem.item.id !== nextItem.id ||
        existingItem.type !== nextItem.type
      ) {
        return false;
      }
    }

    for (let index = 0; index < this.items.length; index++) {
      if (this.syncItemRecord(this.items[index], items[index])) {
        this.markLayoutDirtyFromIndex(index);
      }
    }

    this.appendItemsInternal(items.slice(this.items.length), false);
    this.scrollDirty = true;
    this.render();
    return true;
  }

  // Reconcile a new controlled item list against the existing records by id.
  // This reuses records and instances when type matches, cleans up removed
  // records, rebuilds the lookup maps, and marks layout dirty whenever order,
  // membership, or versioned item data changes.
  private reconcileItems(
    items: readonly CodeViewItem<LAnnotation>[]
  ): Readonly<CodeViewItemMap<LAnnotation, Caret>> | undefined {
    const { items: previousItems, idToItem: previousById } = this;
    const removedItems = new Set(previousItems);
    const nextItems: CodeViewContextItem<LAnnotation, Caret>[] = [];
    const nextIdToItem: Map<
      string,
      CodeViewContextItem<LAnnotation, Caret>
    > = new Map();
    const nextInstanceToItem: Map<
      | VirtualizedFileDiff<LAnnotation, Caret>
      | VirtualizedFile<LAnnotation, Caret>,
      CodeViewContextItem<LAnnotation, Caret>
    > = new Map();
    const removedItemsById: CodeViewItemMap<LAnnotation, Caret> = new Map();
    let firstDirtyIndex: number | undefined;

    for (let index = 0; index < items.length; index++) {
      const input = items[index];
      if (input == null) {
        throw new Error('CodeView.reconcileItems: missing input item');
      }
      if (nextIdToItem.has(input.id)) {
        throw new Error(`CodeView.setItems: duplicate id "${input.id}"`);
      }

      const previousItem = previousById.get(input.id);
      const reused = previousItem != null && previousItem.type === input.type;
      const item = reused ? previousItem : this.createItem(input, index, 0);
      item.index = index;
      if (reused) {
        removedItems.delete(previousItem);
      }
      // Indexes only grow, so the first dirty index is the first one set.
      if (
        !reused ||
        this.syncItemRecord(item, input) ||
        previousItems[index] !== item
      ) {
        firstDirtyIndex ??= index;
      }

      nextItems.push(item);
      nextIdToItem.set(input.id, item);
      nextInstanceToItem.set(item.instance, item);
    }

    if (firstDirtyIndex == null) {
      if (removedItems.size === 0) {
        return undefined;
      }
      firstDirtyIndex = Math.max(nextItems.length - 1, 0);
    }

    this.capturePendingLayoutAnchor(nextIdToItem);

    for (const removedItem of removedItems) {
      removedItemsById.set(removedItem.item.id, removedItem);
      this.releaseRenderedItem(removedItem);
    }

    this.items = nextItems;
    this.idToItem = nextIdToItem;
    this.instanceToItem = nextInstanceToItem;

    if (this.renderState.firstIndex >= nextItems.length) {
      this.resetRenderState();
    } else if (this.renderState.lastIndex >= nextItems.length) {
      this.renderState.lastIndex = nextItems.length - 1;
    }

    this.markLayoutDirtyFromIndex(firstDirtyIndex);
    this.scrollDirty = true;
    this.render();
    return removedItemsById.size > 0 ? removedItemsById : undefined;
  }

  // Update a reused record from the latest controlled item only when its item
  // version changes. Matching versions mean CodeView keeps the current record
  // snapshot, which lets imperative updates remain in place until the caller
  // intentionally publishes a newer version.
  private syncItemRecord(
    item: CodeViewContextItem<LAnnotation, Caret>,
    nextItem: CodeViewItem<LAnnotation>
  ): boolean {
    if (item.type !== nextItem.type) {
      throw new Error(
        `CodeView.syncItemRecord: type mismatch for id "${nextItem.id}"`
      );
    }

    if (item.version === nextItem.version) {
      return false;
    }

    item.item = nextItem;
    item.version = nextItem.version;
    item.renderedOptionsRevision = -1;
    return true;
  }

  private getMaxScrollTopForHeight(scrollHeight: number): number {
    const { paddingBottom, paddingTop } = this.getLayout();
    // The header/footer hosts live in `root` outside `container`, so they add to
    // the real scrollable range on top of the items + padding.
    return Math.max(
      paddingTop +
        this.header.height +
        scrollHeight +
        this.footer.height +
        paddingBottom -
        this.getHeight(),
      0
    );
  }

  private getMaxScrollTop(): number {
    return this.getMaxScrollTopForHeight(this.getScrollHeight());
  }

  private shouldRebaseScroll(): boolean {
    return this.getMaxScrollTop() > this.scrollRebaseConfig.threshold;
  }

  private getPagedScrollHeight(): number {
    return this.shouldRebaseScroll()
      ? Math.min(
          this.getScrollHeight(),
          this.scrollRebaseConfig.containerHeight
        )
      : this.getScrollHeight();
  }

  private getMaxPagedScrollTop(): number {
    return this.getMaxScrollTopForHeight(this.getPagedScrollHeight());
  }

  private clampPagedScrollTop(value: number): number {
    return Math.max(0, Math.min(value, this.getMaxPagedScrollTop()));
  }

  // Clamps a logical scroll position to the min/max allowable scroll range
  // based on the full computed content height.
  private clampScrollTop(value: number): number {
    return Math.max(0, Math.min(value, this.getMaxScrollTop()));
  }

  private getMaxScrollPageOffset(): number {
    return Math.max(this.getMaxScrollTop() - this.getMaxPagedScrollTop(), 0);
  }

  private clampScrollPageOffset(value: number): number {
    return Math.max(0, Math.min(value, this.getMaxScrollPageOffset()));
  }

  // Resolve how a logical scrollTop maps onto the reusable paged scroll window
  // without mutating the current page offset.
  private resolvePagedScrollPosition(
    logicalScrollTop: number
  ): PagedScrollPosition {
    if (!this.shouldRebaseScroll()) {
      return {
        pagedScrollTop: this.clampPagedScrollTop(logicalScrollTop),
        scrollPageOffset: 0,
      };
    }

    const { scrollRebaseConfig } = this;
    const currentPageOffset = this.clampScrollPageOffset(this.scrollPageOffset);
    const pagedScrollTop = logicalScrollTop - currentPageOffset;
    const pagedMaxScrollTop = this.getMaxPagedScrollTop();
    const shouldMoveDown =
      pagedScrollTop > scrollRebaseConfig.threshold &&
      currentPageOffset < this.getMaxScrollPageOffset();
    const shouldMoveUp =
      pagedScrollTop < scrollRebaseConfig.triggerTop && currentPageOffset > 0;

    if (
      pagedScrollTop < 0 ||
      pagedScrollTop > pagedMaxScrollTop ||
      shouldMoveDown ||
      shouldMoveUp
    ) {
      // Rebase toward the preferred paged position, then settle the offset
      // and paged position against each other's clamps.
      let nextPagedScrollTop = roundToDevicePixel(
        this.clampPagedScrollTop(
          shouldMoveUp
            ? Math.min(scrollRebaseConfig.targetBottom, pagedMaxScrollTop)
            : scrollRebaseConfig.targetTop
        )
      );
      let scrollPageOffset = this.clampScrollPageOffset(
        logicalScrollTop - nextPagedScrollTop
      );
      nextPagedScrollTop = roundToDevicePixel(
        this.clampPagedScrollTop(logicalScrollTop - scrollPageOffset)
      );
      scrollPageOffset = this.clampScrollPageOffset(
        logicalScrollTop - nextPagedScrollTop
      );
      return { pagedScrollTop: nextPagedScrollTop, scrollPageOffset };
    }

    return {
      pagedScrollTop: roundToDevicePixel(
        this.clampPagedScrollTop(pagedScrollTop)
      ),
      scrollPageOffset: currentPageOffset,
    };
  }

  private getPagedLayoutTop(logicalTop: number): number {
    if (!this.shouldRebaseScroll()) {
      return logicalTop;
    }
    return Math.max(logicalTop - this.scrollPageOffset, 0);
  }

  private getStickyHeaderOffset(): number {
    return this.options.stickyHeaders === true &&
      this.options.disableFileHeader !== true
      ? this.itemMetricsCache.diffHeaderHeight
      : 0;
  }

  // The item-space rect of a scroll target, or undefined (with a warning) when
  // its item, line, or range can't be resolved.
  private getScrollTargetRect(
    target:
      | CodeViewItemScrollTarget
      | CodeViewLineScrollTarget
      | CodeViewRangeScrollTarget
  ): LineScrollPosition | undefined {
    const item = this.idToItem.get(target.id);
    if (item == null) {
      console.warn(`CodeView.scrollTo: unknown item id "${target.id}"`);
      return undefined;
    }

    if (target.type === 'item') {
      return { top: item.top, height: item.height };
    }

    if (target.type === 'range') {
      const { range } = target;
      const endSide = range.endSide ?? range.side;
      const start = this.getLineScrollPosition(item, range.start, range.side);
      const end = this.getLineScrollPosition(item, range.end, endSide);
      if (start == null || end == null) {
        const startLabel = formatSelectedLinePoint(range.start, range.side);
        const endLabel = formatSelectedLinePoint(range.end, endSide);
        console.warn(
          `CodeView.scrollTo: unable to resolve range ${startLabel === endLabel ? startLabel : `${startLabel}-${endLabel}`} for item "${target.id}"`
        );
        return undefined;
      }

      const top = Math.min(start.top, end.top);
      const bottom = Math.max(start.top + start.height, end.top + end.height);
      return { top: item.top + top, height: bottom - top };
    }

    const linePosition = this.getLineScrollPosition(
      item,
      target.lineNumber,
      target.side
    );
    if (linePosition == null) {
      console.warn(
        `CodeView.scrollTo: unable to resolve line ${target.lineNumber} for item "${target.id}"`
      );
      return undefined;
    }

    return {
      top: item.top + linePosition.top,
      height: linePosition.height,
    };
  }

  private normalizeScrollTarget(
    target: CodeViewScrollTarget
  ): PendingScrollTarget | undefined {
    if (target.type === 'position' || target.align !== 'nearest') {
      return target as PendingScrollTarget;
    }

    const rect = this.getScrollTargetRect(target);
    if (rect == null) {
      return undefined;
    }

    // Determine a stable scrollTo target for `nearest` alignment. This is to
    // ensure that we don't experience any scroll bouncing
    const offset = target.offset ?? 0;
    const targetTop = this.getItemTopOffset() + rect.top;
    const targetBottom = targetTop + rect.height;
    const currentTop = this.getScrollTop();
    const visibleTop =
      currentTop +
      (target.type === 'line' || target.type === 'range'
        ? this.getStickyHeaderOffset()
        : 0);
    const visibleBottom = currentTop + this.getHeight();

    // If the item is spanning beyond the full viewport,
    // do nothing as it's already in view
    if (
      targetTop - offset <= visibleTop &&
      targetBottom + offset >= visibleBottom
    ) {
      return undefined;
    }

    // Let's use the top as the target
    if (targetTop - offset < visibleTop) {
      return { ...target, align: 'start' };
    }

    // Let's use the top as the target
    if (targetBottom + offset > visibleBottom) {
      return { ...target, align: 'end' };
    }

    // The element is already in view, nothing to do.
    return undefined;
  }

  // Resolve a target's clamped scroll position from its alignment, offset,
  // and (for 'start' line/range targets) the sticky header height. Returns
  // `undefined` when we can't resolve a target for whatever reason.
  private resolveScrollTargetTop(
    target: PendingScrollTarget
  ): number | undefined {
    if (target.type === 'position') {
      const clampedPosition = this.clampScrollTop(target.position);
      return clampedPosition !== target.position
        ? // If our position was clamped, we we shouldn't apply the sticky offset
          clampedPosition
        : this.clampScrollTop(target.position - this.getStickyHeaderOffset());
    }

    const rect = this.getScrollTargetRect(target);
    if (rect == null) {
      return undefined;
    }

    const { align, offset = 0 } = target;
    const { height } = rect;
    // rect.top is item-space (0 = first item's top); shift it into absolute
    // scroll coordinates. getItemTopOffset includes the header height, so
    // scrolling to an item/line lands correctly when a header is present.
    const top = rect.top + this.getItemTopOffset();
    const viewportHeight = this.getHeight();
    // If the target + offset is bigger than the viewport, 'center' falls back
    // to 'start'
    if (align === 'center' && height + offset < viewportHeight) {
      return this.clampScrollTop(top - (viewportHeight - height) / 2 + offset);
    }
    if (align === 'end') {
      return this.clampScrollTop(top - (viewportHeight - height) + offset);
    }
    const stickyOffset =
      target.type === 'item' ? 0 : this.getStickyHeaderOffset();
    return this.clampScrollTop(top - stickyOffset - offset);
  }

  private getLineScrollPosition(
    item: CodeViewContextItem<LAnnotation, Caret>,
    lineNumber: number,
    side: SelectionSide | undefined
  ): LineScrollPosition | undefined {
    return item.type === 'diff'
      ? item.instance.getLinePosition(lineNumber, side)
      : item.instance.getLinePosition(lineNumber);
  }

  // Closed-form critical-damped ODE step.
  //
  // Stable at any dt (Euler would blow up once ω·dt ≳ 1), so this survives
  // big RAF gaps (tab-wake, offscreen frames) and resize-driven ticks that
  // fire outside the normal RAF cadence.
  private computeSpringStep(
    animation: ScrollToAnimation,
    destination: number,
    frameTimestamp: number
  ): SpringStepResult {
    const dt = Math.max(0, frameTimestamp - animation.lastTimestamp);
    const { omega } = this.getSmoothScrollSettings();
    const decay = Math.exp(-omega * dt);
    const displacement = animation.position - destination;
    const springCoeff = animation.velocity + omega * displacement;
    const position = destination + (displacement + springCoeff * dt) * decay;
    const velocity =
      (springCoeff * (1 - omega * dt) - omega * displacement) * decay;
    return { position, velocity };
  }

  // For the pending scroll target, advance any in-flight smooth scroll
  // animation by frame time (adopting the anchoring correction) and return the
  // scrollTop to move towards.
  private advanceScrollAnimation(
    target: PendingScrollTarget,
    frameTimestamp: number,
    anchorDelta: number
  ): number | undefined {
    const destination = this.resolveScrollTargetTop(target);
    if (destination == null) {
      this.pendingScrollTarget = undefined;
      this.scrollAnimation = undefined;
      return undefined;
    }
    const animation = this.scrollAnimation;
    if (animation == null) {
      return destination;
    }

    animation.position += anchorDelta;

    const { position, velocity } = this.computeSpringStep(
      animation,
      destination,
      frameTimestamp
    );
    animation.lastTimestamp = frameTimestamp;
    animation.position = position;
    animation.velocity = velocity;

    const { positionEpsilon, velocityEpsilon } = this.getSmoothScrollSettings();
    if (
      Math.abs(destination - position) <= positionEpsilon &&
      Math.abs(velocity) <= velocityEpsilon
    ) {
      this.scrollAnimation = undefined;
      return destination;
    }

    return position;
  }

  private computeRenderRangeAndEmit = (
    timestamp: number = performance.now()
  ): void => {
    if (CodeView.__STOP || this.container == null) {
      return;
    }
    if (!this.isReady()) {
      return;
    }

    // Read the current viewport and logical scroll position before making DOM
    // mutations, then capture an anchor that can survive layout recalculation.
    const viewportHeight = this.getHeight();
    const initialScrollTop = this.getScrollTop();
    let scrollTopAfterLayout = initialScrollTop;
    // Typically a pendingLayoutAnchor will be created from a setOptions call,
    // that will force us to attempt to fit to a new scroll position to not
    // allow the viewport to jump around on us. This can also be triggered
    // later on if a particular item marks itself as dirty
    let computeScrollCorrection = this.pendingLayoutAnchor != null;
    // We need to grab the anchor before we re-compute any layout updates, or
    // else we'll get invalid anchor reference data.  If we have a
    // pendingLayoutAnchor it will just grab that for us instead of attempting
    // to compute one
    let scrollAnchor = this.getScrollAnchor(scrollTopAfterLayout);

    // If any item marked itself as difty, we should re-compute everything
    // after it and then force a new scroll top correction if we aren't already
    if (this.layoutDirtyIndex != null) {
      this.recomputeLayout(this.layoutDirtyIndex, this.pendingLayoutReset);
      this.layoutDirtyIndex = undefined;
      this.pendingLayoutReset = undefined;
      computeScrollCorrection = true;
    }

    // If layout shifted, resolve the logical scrollTop that keeps the captured
    // anchor in the same viewport position.
    if (computeScrollCorrection && scrollAnchor != null) {
      const anchoredScrollTopAfterLayout =
        this.resolveAnchoredScrollTop(scrollAnchor);
      if (anchoredScrollTopAfterLayout != null) {
        const layoutAnchorDelta =
          anchoredScrollTopAfterLayout - scrollTopAfterLayout;
        scrollTopAfterLayout = anchoredScrollTopAfterLayout;
        if (this.scrollAnimation != null) {
          // If we have a delta measurement adjustment, we have to pass that
          // change onto the scroll animation to ensure the animation remains
          // stable, later on
          this.scrollAnimation.position += layoutAnchorDelta;
        }
      }
    }
    // Recomputing layout can shrink the scroll range, for example when items
    // collapse, so clamp current scroll position and update DOM so scroll
    // changes are valid before deriving the render window for this frame.
    if (computeScrollCorrection) {
      scrollTopAfterLayout = this.clampScrollTop(scrollTopAfterLayout);
      this.syncContainerHeight();
    }

    // Resolve the logical scrollTop this render frame should target: the
    // pending target's destination, or the next smooth-scroll spring step
    // toward it. The paged root scrollTop is derived later only if the
    // scaffold needs to move.
    let targetScrollTop = scrollTopAfterLayout;
    const destination =
      this.pendingScrollTarget != null
        ? this.resolveScrollTargetTop(this.pendingScrollTarget)
        : undefined;
    if (destination != null) {
      targetScrollTop =
        this.scrollAnimation == null
          ? destination
          : this.computeSpringStep(this.scrollAnimation, destination, timestamp)
              .position;
    }

    // When performing very large scroll jumps, we should attempt to render the
    // bare minimum to ensure we can paint quickly. We'll queue up another
    // render at the end to fill things out on the next tick. If we had to
    // correct layout-adjusted scroll state then we should not fitPerfectly
    // because there's a good chance we'll be re-rendering the same elements
    // again
    const fitPerfectly =
      !computeScrollCorrection &&
      (this.renderState.scrollTop === -1 ||
        Math.abs(targetScrollTop - this.renderState.scrollTop) >
          viewportHeight + this.config.overscrollSize * 2);

    // If we are doing a `fitPerfectly` render it means we are rendering
    // completely new content which means no need to scroll fix anything
    if (fitPerfectly) {
      scrollAnchor = undefined;
    }

    // Compute the projected logical window, then synchronize the paged scroll
    // scaffold before mutating rendered items.
    this.windowSpecs = createWindowFromScrollPosition({
      // The window is in item-space (0 = first item's top); subtract the header so
      // a tall header can't desync which items fall inside the render window.
      scrollTop: targetScrollTop - this.header.height,
      height: viewportHeight,
      scrollHeight: this.getScrollHeight(),
      fitPerfectly,
      // We actually need a bit of overscroll even when attempting to fit
      // perfectly because we round to the nearest container and we may need
      // to render the gaps before and after a perfectly fit element to include
      // the spacing between. We do this by adding the gap and header height
      // above and below the viewport
      fitPerfectlyOverscroll:
        this.getLayout().gap + this.itemMetricsCache.diffHeaderHeight,
      overscrollSize: this.config.overscrollSize,
    });
    let syncedScrollTop = initialScrollTop;
    if (
      (this.pendingScrollTarget != null &&
        targetScrollTop !== syncedScrollTop) ||
      this.resolvePagedScrollPosition(
        roundToDevicePixel(this.clampScrollTop(targetScrollTop))
      ).scrollPageOffset !== this.scrollPageOffset
    ) {
      // Apply programmatic scrolls and user-driven page rebases before DOM
      // mutations so the browser reconciles the render against the right
      // paged scroll position.
      this.applyScrollFix(targetScrollTop, syncedScrollTop);
      syncedScrollTop = targetScrollTop;
    }

    // Reconcile the currently mounted DOM against the new projected render
    // window, cleaning up any elements that are no longer visible.
    const { top, bottom } = this.windowSpecs;
    const { firstIndex, lastIndex } = this.renderState;
    if (firstIndex >= 0) {
      for (let index = firstIndex; index <= lastIndex; index++) {
        const item = this.items[index];
        if (item == null) {
          throw new Error(
            `CodeView.computeRenderRangeAndEmit: No item at index: ${index}`
          );
        }
        const isVisible = item.top > top - item.height && item.top <= bottom;
        // If not visible, we should unmount it and clean it up
        if (!isVisible) {
          this.releaseRenderedItem(item);
        }
      }
    }

    // Mount/unmount/re-populate the header/footer hosts to match the current
    // renderCodeViewHeader/renderCodeViewFooter options, in the same
    // DOM-mutation window as the items: after the scroll anchor was captured
    // above and before the post-render anchor resolve below. A changed host is
    // measured synchronously in the read phase.
    const headerChanged = this.reconcileHost('header');
    const hostsChanged = this.reconcileHost('footer') || headerChanged;

    let prevElement: HTMLElement | undefined;
    const updatedItems = new Set<CodeViewContextItem<LAnnotation, Caret>>();
    const startingIndex = this.findFirstVisibleIndex(top);
    const lastRenderedIndex = this.findLastVisibleIndex(bottom);

    for (
      let itemIndex = startingIndex;
      itemIndex <= lastRenderedIndex;
      itemIndex++
    ) {
      const item = this.items[itemIndex];
      // If the item isn't rendered yet, we need to create a wrapper element
      // for it and render it, otherwise kick off a render as necessary
      const mounting = item.element == null;
      const element = (item.element ??= this.acquireElement());
      // Keep the rendered DOM order aligned with the record order, even for
      // reused elements already mounted elsewhere in the sticky container.
      if (prevElement == null) {
        if (this.stickyContainer.firstChild !== element) {
          this.stickyContainer.prepend(element);
        }
      } else if (prevElement.nextSibling !== element) {
        prevElement.after(element);
      }
      if (mounting) {
        item.instance.virtualizedSetup();
      }
      const fileContainer = mounting ? element : undefined;
      const forceRender =
        !mounting &&
        item.renderedOptionsRevision !== this.renderOptionsRevision;
      const rendered =
        item.type === 'diff'
          ? item.instance.render({
              deferManagers: true,
              fileContainer,
              fileDiff: item.item.fileDiff,
              forceRender,
              lineAnnotations: item.item.annotations ?? [],
            })
          : item.instance.render({
              deferManagers: true,
              fileContainer,
              file: item.item.file,
              forceRender,
              lineAnnotations: item.item.annotations ?? [],
            });
      if (rendered) {
        item.renderedOptionsRevision = this.renderOptionsRevision;
        updatedItems.add(item);
      }
      prevElement = element;
      // Bind editors after the item render kicked off; attachItemEditor
      // no-ops unless the item is in edit mode and not already attached.
      if (item.item.edit === true) {
        this.attachItemEditor(item);
      }
    }

    this.renderState.firstIndex =
      startingIndex <= lastRenderedIndex ? startingIndex : -1;
    this.renderState.lastIndex = lastRenderedIndex;

    this.flushSlotCoordinator();
    for (const item of updatedItems) {
      item.instance.flushManagers();
    }
    // Read phase: measure a freshly mounted or re-populated host now so its
    // getBoundingClientRect batches into the same reflow as the item height reads.
    if (hostsChanged) {
      for (const host of [this.header, this.footer]) {
        if (host.element != null) {
          this.setHostHeight(host, host.element.getBoundingClientRect().height);
        }
      }
    }
    this.reconcileRenderedItems(updatedItems);
    this.syncContainerHeight();
    this.updateStickyPositioning();

    // Now that the dom has been flushed and we've computed our updated
    // item/line metrics, we should attempt to resolve any scroll anchors and
    // scroll animation data.  We have already applied the desired scroll
    // position before rendering, so the only scroll changes should be to
    // scrollFix from lines that did not match their computed state.
    //
    // - No pending scrollTo target → Only attempt to scrollFix if there's a
    //   mismatch
    // - Instant pending scrollTo target → Resolve target anchor position and
    //   apply any necessary scroll fixes
    // - Smooth pending scrollTo target → Apply necessary scrollFix if
    //   necessary and rebase/update the outstanding spring animation values.
    const anchoredScrollTopAfterRender =
      scrollAnchor != null
        ? this.resolveAnchoredScrollTop(scrollAnchor)
        : undefined;
    if (scrollAnchor === this.pendingLayoutAnchor) {
      this.pendingLayoutAnchor = undefined;
    }
    // The amount of computed layout shift from the render
    const postRenderAnchorDelta =
      anchoredScrollTopAfterRender != null
        ? anchoredScrollTopAfterRender - scrollTopAfterLayout
        : 0;

    let postRenderScrollTop = anchoredScrollTopAfterRender ?? targetScrollTop;
    let shouldCheckPendingTargetSettled = false;
    if (this.pendingScrollTarget != null) {
      const pendingTargetScrollTop = this.advanceScrollAnimation(
        this.pendingScrollTarget,
        timestamp,
        postRenderAnchorDelta
      );
      shouldCheckPendingTargetSettled = pendingTargetScrollTop != null;
      // If something bad happened with our pending scroll target, then we'd
      // fall back here. Unlikely to happen in practice, but we need to reset
      // the scrollTop if so
      postRenderScrollTop = pendingTargetScrollTop ?? scrollTopAfterLayout;
    }
    // If the new intended scroll position has changed, we should apply that
    // now to bring everything in line
    if (postRenderScrollTop !== syncedScrollTop) {
      this.applyScrollFix(postRenderScrollTop, syncedScrollTop);
      syncedScrollTop = postRenderScrollTop;
    }
    if (
      shouldCheckPendingTargetSettled &&
      this.pendingScrollTarget != null &&
      this.isPendingTargetSettled(this.pendingScrollTarget)
    ) {
      this.pendingScrollTarget = undefined;
      this.scrollAnimation = undefined;
    }
    this.renderState.scrollTop = roundToDevicePixel(syncedScrollTop);

    // The post-render scroll-correction block above can call applyScrollFix ->
    // syncPagedScrollScaffolding -> applyStickyPositioning, which recomputes
    // renderState.stickyHeight from getStickyBounds(windowSpecs) for the
    // corrected scroll position. The rendered DOM slice was committed earlier in
    // this frame for the pre-correction window and is not re-rendered here, so
    // that windowSpecs-based value can diverge from the committed slice by the
    // scroll-correction delta. Recompute sticky positioning from the committed
    // renderRange (no-arg path) so renderState.stickyHeight matches the slice
    // actually in the DOM before we validate it.
    this.updateStickyPositioning();

    this.validateStickyContainerHeight();
    if (this.shouldFixContainerFocus) {
      this.shouldFixContainerFocus = false;
      this.root?.focus({ preventScroll: true });
    }

    // If we are hitting a fitPerfectly heuristic, we should queue up another
    // render to fill out content. If we are performing a scroll animation we'll
    // need another render to continue.
    if (fitPerfectly || this.scrollAnimation != null) {
      this.render();
    }
  };

  private syncContainerHeight(): void {
    const pagedScrollHeight = this.getPagedScrollHeight();
    if (this.container == null || this.containerHeight === pagedScrollHeight) {
      return;
    }

    this.container.style.height = `${pagedScrollHeight}px`;
    this.containerHeight = pagedScrollHeight;
  }

  private getStickyBounds(
    windowSpecs?: VirtualWindowSpecs
  ): StickyBounds | undefined {
    const { firstIndex, lastIndex } =
      windowSpecs != null
        ? {
            firstIndex: this.findFirstVisibleIndex(windowSpecs.top),
            lastIndex: this.findLastVisibleIndex(windowSpecs.bottom),
          }
        : this.renderState;

    if (firstIndex === -1 || lastIndex === -1 || firstIndex > lastIndex) {
      return undefined;
    }
    const firstStickySpecs =
      this.items[firstIndex]?.instance.getAdvancedStickySpecs(windowSpecs);
    const lastStickySpecs =
      this.items[lastIndex]?.instance.getAdvancedStickySpecs(windowSpecs);

    if (firstStickySpecs == null || lastStickySpecs == null) {
      return undefined;
    }

    return {
      stickyTop: this.getPagedLayoutTop(
        Math.max(firstStickySpecs.topOffset, 0)
      ),
      stickyBottom: this.getPagedLayoutTop(
        lastStickySpecs.topOffset + lastStickySpecs.height
      ),
    };
  }

  private applyStickyPositioning({
    stickyTop,
    stickyBottom,
  }: StickyBounds): void {
    const height = this.getHeight();
    const { itemMetricsCache: itemMetrics } = this;
    const stickyContainerHeight = stickyBottom - stickyTop;

    this.renderState.stickyHeight = stickyContainerHeight;
    this.renderState.stickyTop = stickyTop;
    this.renderState.stickyBottom = stickyBottom;

    this.stickyOffset.style.height = `${stickyTop}px`;
    // NOTE(amadeus): Wee polish lad -- when dragging the scrollbar up or
    // down quickly, this prevents the laggy scroll view from lining up with
    // the numbers exactly
    const randomOffset = ((Math.random() * itemMetrics.lineHeight) >> 0) * -1;
    const stickyJitter =
      -Math.max(stickyContainerHeight + randomOffset, 0) + height;
    this.stickyContainer.style.top = `${stickyJitter}px`;
    this.stickyContainer.style.bottom = `${stickyJitter + itemMetrics.diffHeaderHeight}px`;
  }

  private reconcileRenderedItems(
    updatedItems?: Set<CodeViewContextItem<LAnnotation, Caret>>
  ): void {
    const { firstIndex, lastIndex } = this.renderState;
    if (firstIndex === -1) {
      return;
    }

    const { gap } = this.getLayout();
    let currentTop = -1;
    let heightChanged = false;
    // Iterate through the rendered items to reconcile height. If a height
    // has changed, we'll have to iterate all the way till the end to update
    // all appropriate heights
    for (let index = firstIndex; index < this.items.length; index++) {
      // If we've incurred no height changes and ended, we can abort
      if (!heightChanged && index > lastIndex) {
        break;
      }
      const item = this.items[index];
      if (currentTop === -1) {
        currentTop = item.top;
      } else if (item.top !== currentTop) {
        item.top = currentTop;
        item.instance.syncVirtualizedTop();
        heightChanged = true;
      }
      // If updatedInstances provided, only reconcile those. If not provided
      // (resize path), reconcile all rendered items.
      if (updatedItems == null ? index <= lastIndex : updatedItems.has(item)) {
        if (item.instance.reconcileHeights()) {
          heightChanged = true;
          item.height = item.instance.getVirtualizedHeight();
        }
        this.validateRenderedItemHeight(item);
      }
      currentTop += item.instance.getVirtualizedHeight();
      if (index < this.items.length - 1) {
        currentTop += gap;
      }
    }

    if (heightChanged) {
      this.scrollDirty = true;
      this.scrollHeight = currentTop;
    }
  }

  private updateStickyPositioning(): void {
    const stickyBounds = this.getStickyBounds();
    if (stickyBounds == null) {
      // No rendered slice means no sticky scaffold: clear the spacer so an
      // emptied viewer sheds the offset height captured from the last
      // rendered layout instead of keeping phantom space in the container.
      if (this.renderState.firstIndex === -1) {
        this.stickyOffset.style.height = '';
      }
      return;
    }
    const { stickyTop, stickyBottom } = stickyBounds;
    const stickyContainerHeight = stickyBottom - stickyTop;

    if (
      stickyContainerHeight === this.renderState.stickyHeight &&
      stickyTop === this.renderState.stickyTop &&
      stickyBottom === this.renderState.stickyBottom
    ) {
      return;
    }

    this.applyStickyPositioning(stickyBounds);
  }

  private handleScroll = (): void => {
    if (CodeView.__STOP) {
      return;
    }
    this.suspendScrollInteractions();
    this.scrollDirty = true;
    // Avoid DOM thrash of checking scroll position if we don't need it
    if (this.scrollListeners.size > 0) {
      const scrollTop = this.getScrollTop();
      for (const listener of this.scrollListeners) {
        listener(scrollTop, this);
      }
    }
    this.render();
  };

  // Abort any in-flight programmatic scroll when the user takes over.
  // Attached to root as a passive listener for wheel / touchstart /
  // pointerdown / keydown; we never mutate the event, just drop our state.
  private clearPendingScroll = (): void => {
    this.pendingScrollTarget = undefined;
    this.pendingLayoutAnchor = undefined;
    this.scrollAnimation = undefined;
  };

  private handleResize = (entries: ResizeObserverEntry[]) => {
    let shouldRender = false;
    for (const { target, borderBoxSize } of entries) {
      // The sticky container resizes from a render (which it will probably
      // ignore) or when an annotation or line wrap changes its content. A
      // header/footer host resizes after mount from async content, fonts, or a
      // React portal filling in.
      let host: HeaderFooterHost | undefined;
      if (target === this.header.element) {
        host = this.header;
      } else if (target === this.footer.element) {
        host = this.footer;
      } else if (target !== this.stickyContainer) {
        // Root element resize (element-mode only)
        this.scrollDirty = true;
        this.heightDirty = true;
        shouldRender = true;
        continue;
      }
      const { blockSize } = borderBoxSize[0];
      if (
        host == null
          ? Math.abs(blockSize - this.renderState.stickyHeight) <
            SUB_PIXEL_TOLERANCE
          : blockSize === host.height
      ) {
        continue;
      }
      // Capture the anchor before the layout change and resolve it after, so
      // the delta cancels the shift and content in the viewport doesn't jump.
      // A footer only changes the scroll range, so its anchor resolves to no
      // change (or a clamp when it shrinks below the current scroll).
      const currentScrollTop = this.getScrollTop();
      const anchor = this.getScrollAnchor(currentScrollTop);
      if (host == null) {
        this.reconcileRenderedItems();
        this.updateStickyPositioning();
      } else {
        // Items are untouched by a host resize; the trailing render()
        // reconciles the range and render window.
        this.setHostHeight(host, blockSize);
      }
      const anchoredScrollTop =
        anchor != null ? this.resolveAnchoredScrollTop(anchor) : undefined;
      if (anchoredScrollTop != null) {
        this.applyScrollFix(anchoredScrollTop, currentScrollTop);
        // Shift the animation by the scroll fix delta so it continues
        // smoothly as if the scroll fix never happened
        if (this.scrollAnimation != null) {
          this.scrollAnimation.position += anchoredScrollTop - currentScrollTop;
        }
      }
      if (
        this.pendingScrollTarget != null &&
        this.isPendingTargetSettled(this.pendingScrollTarget)
      ) {
        this.pendingScrollTarget = undefined;
        this.scrollAnimation = undefined;
      }
      shouldRender = true;
    }

    // If the DOM changed in an unexpected way, we should kick
    // off a synchronous render immediately because it will
    // ensure no visual jitter if we need to scroll fix
    if (shouldRender) {
      this.render(true);
    }
  };

  // Attempt to find a scroll anchor based on built in metrics of the existing
  // rendered files/diff.
  //
  // A scroll anchor represents the first fully visible element (in other
  // words, the first file or first line who's top is fully in the viewport).
  private getScrollAnchor(
    scrollTop: number,
    availableItems: ReadonlyMap<
      string,
      CodeViewContextItem<LAnnotation, Caret>
    > = this.idToItem
  ): ScrollAnchor | undefined {
    let skippedItem: CodeViewContextItem<LAnnotation, Caret> | undefined;

    const { pendingLayoutAnchor } = this;
    if (pendingLayoutAnchor != null) {
      skippedItem = this.idToItem.get(pendingLayoutAnchor.id);
      if (
        skippedItem != null &&
        availableItems.get(pendingLayoutAnchor.id) === skippedItem
      ) {
        return pendingLayoutAnchor;
      }
    }

    // We shouldn't scroll anchor when at the top, this way if a custom header
    // gets asynchronously added it won't be hidden when added.  Also like,
    // logically it doesn't make sense to anchor at the top of the document,
    // you probably want to see stuff added at the top...
    if (scrollTop <= 0) {
      return undefined;
    }

    const { firstIndex, lastIndex, stickyTop, stickyBottom } = this.renderState;
    if (firstIndex === -1 || lastIndex === -1) {
      return undefined;
    }

    const viewportHeight = this.getHeight();
    // If we have no previoius frame, we shouldn't scroll anchor
    if (stickyTop === -1 || stickyBottom === -1) {
      return undefined;
    }

    for (let index = firstIndex; index <= lastIndex; index++) {
      const item = this.items[index];
      if (item == null) {
        continue;
      }

      const absoluteItemTop = this.getItemTopOffset() + item.top;
      const absoluteItemBottom = absoluteItemTop + item.height;
      // Skip items entirely above the viewport since we can't see it
      if (absoluteItemBottom <= scrollTop) {
        continue;
      }
      // If the item starts below the viewport bottom we are done searching.
      if (absoluteItemTop >= scrollTop + viewportHeight) {
        break;
      }

      if (availableItems.get(item.item.id) !== item) {
        skippedItem ??= item;
        continue;
      }

      if (absoluteItemTop >= scrollTop) {
        return {
          type: 'item',
          id: item.item.id,
          viewportOffset: absoluteItemTop - scrollTop,
        };
      }

      // The item's top is scrolled past, so grab the first fully visible line
      // below the sticky header (if enabled)
      const lineAnchor = item.instance.getNumericScrollAnchor(
        scrollTop + this.getStickyHeaderOffset() - absoluteItemTop
      );
      if (lineAnchor != null) {
        const absoluteLineTop = absoluteItemTop + lineAnchor.top;
        return {
          type: 'line',
          id: item.item.id,
          lineNumber: lineAnchor.lineNumber,
          side: lineAnchor.side,
          viewportOffset: absoluteLineTop - scrollTop,
        };
      }
    }

    // If we couldn't find an anchored item and we have a skipped item, lets
    // attempt to anchor to the top of the item that came after it
    if (skippedItem != null) {
      for (
        let index = skippedItem.index + 1;
        index < this.items.length;
        index++
      ) {
        const candidate = this.items[index];
        if (
          candidate != null &&
          availableItems.get(candidate.item.id) === candidate
        ) {
          return {
            type: 'item',
            id: candidate.item.id,
            viewportOffset: 0,
          };
        }
      }
    }

    // I don't think we'll ever make it this far...
    return undefined;
  }

  // Given a scroll anchor, attempt to resolve a newly updated (and clamped)
  // scroll position to keep the anchored element in place, or undefined when
  // we can't resolve a position for whatever reason.
  private resolveAnchoredScrollTop(anchor: ScrollAnchor): number | undefined {
    const item = this.idToItem.get(anchor.id);
    if (item == null) {
      return undefined;
    }

    let top = this.getItemTopOffset() + item.top;
    if (anchor.type === 'line') {
      const linePosition = this.getLineScrollPosition(
        item,
        anchor.lineNumber,
        anchor.side
      );
      if (linePosition == null) {
        return undefined;
      }
      top += linePosition.top;
    }
    return this.clampScrollTop(top - anchor.viewportOffset);
  }

  // Apply a device-pixel-rounded scroll position if it differs from the last
  // logical scrollTop synchronized into the paged scroll scaffold.
  private applyScrollFix(
    targetScrollTop: number,
    syncedScrollTop: number
  ): void {
    if (this.root == null) {
      return;
    }
    const roundedTargetScrollTop = roundToDevicePixel(
      this.clampScrollTop(targetScrollTop)
    );
    const roundedSyncedScrollTop = roundToDevicePixel(syncedScrollTop);

    const { scrollPageOffset: previousPageOffset } = this;
    const syncedPagedScrollTop = roundToDevicePixel(
      this.clampPagedScrollTop(roundedSyncedScrollTop - previousPageOffset)
    );
    const { pagedScrollTop, scrollPageOffset } =
      this.resolvePagedScrollPosition(roundedTargetScrollTop);

    const pagedChanged = pagedScrollTop !== syncedPagedScrollTop;
    const rebaseChanged = previousPageOffset !== scrollPageOffset;
    if (
      roundedTargetScrollTop === this.renderState.scrollTop &&
      roundedTargetScrollTop === roundedSyncedScrollTop &&
      !pagedChanged &&
      !rebaseChanged
    ) {
      return;
    }
    this.suspendScrollInteractions();
    if (pagedChanged || rebaseChanged) {
      // Sync the paged scroll scaffold for the new page offset
      const { windowSpecs } = this;
      this.scrollPageOffset = scrollPageOffset;
      this.syncContainerHeight();
      const stickyBounds = this.getStickyBounds(windowSpecs);
      if (stickyBounds == null) {
        this.stickyOffset.style.height = `${this.getPagedLayoutTop(windowSpecs.top)}px`;
      } else {
        this.applyStickyPositioning(stickyBounds);
      }
    }
    if (pagedChanged) {
      this.root.scrollTo({ top: pagedScrollTop, behavior: 'instant' });
    }
    // Keep cached scroll state in sync with writes we performed ourselves, so
    // later reads do not need to touch layout just to discover the same value.
    this.renderState.scrollTop = roundedTargetScrollTop;
    this.scrollTop = roundedTargetScrollTop;
    this.scrollDirty = false;
  }

  // Decide whether a pending programmatic scroll has reached its destination
  // and should be cleared.
  private isPendingTargetSettled(target: PendingScrollTarget): boolean {
    const top = this.resolveScrollTargetTop(target);
    if (top == null) {
      return true;
    }
    return roundToDevicePixel(this.getScrollTop()) === roundToDevicePixel(top);
  }

  public getScrollTop(): number {
    if (!this.scrollDirty) {
      return this.scrollTop;
    }
    this.scrollDirty = false;
    const rootScrollTop = this.root?.scrollTop ?? 0;
    this.scrollTop = this.clampScrollTop(rootScrollTop + this.scrollPageOffset);
    return this.scrollTop;
  }

  public getHeight(): number {
    if (!this.heightDirty) {
      return this.height;
    }
    this.heightDirty = false;
    this.height = this.root?.getBoundingClientRect().height ?? 0;
    return this.height;
  }

  public getScrollHeight(): number {
    return this.scrollHeight;
  }

  private flushSlotCoordinator(): void {
    if (this.slotCoordinator == null) {
      return;
    }

    const slotSnapshot = this.getSlotSnapshot(this.slotCoordinator);
    if (areManagedSnapshotsEqual(this.slotSnapshot, slotSnapshot)) {
      return;
    }

    this.slotSnapshot = slotSnapshot;
    this.slotCoordinator.onSnapshotChange(slotSnapshot);
  }

  // Find the first item whose bottom edge crosses into the viewport window.
  // This lets scroll-time rendering jump directly near the visible range instead
  // of linearly scanning from the start of very large item lists.
  private findFirstVisibleIndex(top: number): number {
    let low = 0;
    let high = this.items.length - 1;
    let result = this.items.length;

    while (low <= high) {
      const mid = (low + high) >> 1;
      const item = this.items[mid];
      if (item.top + item.height > top) {
        result = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    return result;
  }

  // Find the last item whose top edge is still within the viewport window.
  // Paired with findFirstVisibleIndex, this bounds the render loop to only the
  // slice of items that can actually intersect the current scroll range.
  private findLastVisibleIndex(bottom: number): number {
    let low = 0;
    let high = this.items.length - 1;
    let result = -1;

    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.items[mid].top <= bottom) {
        result = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return result;
  }

  // Recompute measured tops and heights starting from the earliest dirty item.
  // Earlier items keep their existing layout, while everything from startIndex
  // onward is remeasured so downstream positions and total scroll height stay
  // consistent after inserts, removals, or versioned item updates.
  private recomputeLayout(
    startIndex: number,
    reset: PendingCodeViewLayoutReset | undefined
  ): void {
    if (this.items.length === 0) {
      this.scrollHeight = 0;
      return;
    }

    const layout = this.getLayout();
    let runningTop = 0;
    if (startIndex > 0) {
      const previousItem = this.items[startIndex - 1];
      if (previousItem == null) {
        throw new Error('CodeView.recomputeLayout: invalid dirty index');
      }
      runningTop = previousItem.top + previousItem.height + layout.gap;
    }

    for (let index = startIndex; index < this.items.length; index++) {
      const item = this.items[index];
      item.top = runningTop;
      item.height = updateItemLayout(item, runningTop, reset);
      runningTop += item.height;
      if (index < this.items.length - 1) {
        runningTop += layout.gap;
      }
    }

    if (runningTop !== this.scrollHeight) {
      this.scrollDirty = true;
    }
    this.scrollHeight = runningTop;
  }

  private resetRenderState() {
    Object.assign(this.renderState, INITIAL_RENDER_STATE);
  }
}

// Lay out an item's current file or diff at `top` and return its height.
function updateItemLayout<LAnnotation, Caret>(
  item: CodeViewContextItem<LAnnotation, Caret>,
  top: number,
  reset?: PendingCodeViewLayoutReset
): number {
  return item.type === 'diff'
    ? item.instance.updateCodeViewLayout(
        item.item.fileDiff,
        top,
        reset,
        item.item.annotations ?? []
      )
    : item.instance.updateCodeViewLayout(
        item.item.file,
        top,
        reset,
        item.item.annotations ?? []
      );
}

function formatSelectedLinePoint(
  lineNumber: number,
  side: SelectionSide | undefined
): string {
  if (side == null) {
    return `${lineNumber}`;
  }

  return `${side === 'deletions' ? 'D' : 'A'}${lineNumber}`;
}
