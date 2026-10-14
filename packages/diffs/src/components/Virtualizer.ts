import {
  dequeueRender,
  queueRender,
} from '../managers/UniversalRenderingManager';
import type { VirtualWindowSpecs } from '../types';
import { areVirtualWindowSpecsEqual } from '../utils/areVirtualWindowSpecsEqual';
import { createWindowFromScrollPosition } from '../utils/createWindowFromScrollPosition';

interface SubscribedInstance {
  onRender(dirty: boolean): boolean;
  reconcileHeights(): boolean;
  setVisibility(visible: boolean): void;
}

interface ScrollAnchor {
  fileElement: HTMLElement;
  fileTypeOffset: 'top' | 'bottom';
  fileOffset: number;
  lineIndex: string | undefined;
  lineOffset: number | undefined;
}

// 800 seems like the healthy overscan required to
// keep safari from blanking... if we catch it tho, maybe 900
const DEFAULT_OVERSCROLL_SIZE = 1000;
const INTERSECTION_OBSERVER_MARGIN = DEFAULT_OVERSCROLL_SIZE * 4;
const INTERSECTION_OBSERVER_THRESHOLD = [0, 0.000001, 0.99999, 1];

export interface VirtualizerConfig {
  /** Extra pixels rendered above and below the viewport to reduce blanking during fast scrolls. */
  overscrollSize: number;
  /** Margin used by IntersectionObserver to decide when items should be considered visible. */
  intersectionObserverMargin: number;
  /** Enables noisy resize logs to help tune metrics and investigate scroll jitter. */
  resizeDebugging: boolean;
}

export interface VirtualizerScrollOptions {
  top: number;
  behavior?: ScrollBehavior;
}

const DEFAULT_VIRTUALIZER_CONFIG: VirtualizerConfig = {
  overscrollSize: DEFAULT_OVERSCROLL_SIZE,
  intersectionObserverMargin: INTERSECTION_OBSERVER_MARGIN,
  resizeDebugging: false,
};

let lastSize = 0;

let instance = -1;

export class Virtualizer {
  static __STOP: boolean = false;
  static __lastScrollPosition = 0;

  public readonly __id: string = `virtualizer-${++instance}`;
  public readonly config: VirtualizerConfig;
  public type = 'simple' as const;
  private intersectionObserver: IntersectionObserver | undefined;
  private scrollTop: number = 0;
  private height: number = 0;
  private scrollHeight: number = 0;
  private windowSpecs: VirtualWindowSpecs = { top: 0, bottom: 0 };
  private root: HTMLElement | Document | undefined;
  private contentContainer: HTMLElement | undefined;

  private resizeObserver: ResizeObserver | undefined;
  private observers: Map<HTMLElement, SubscribedInstance> = new Map();
  private visibleInstances: Map<HTMLElement, SubscribedInstance> = new Map();
  private visibleInstancesDirty: boolean = false;
  private instancesChanged: Set<SubscribedInstance> = new Set();
  // Instances whose content was (re)painted outside a virtualizer-driven
  // onRender — host/React render calls, async highlight completions — and
  // still need a measured-height reconciliation pass. See
  // requestHeightReconcile.
  private reconcileQueue: Set<SubscribedInstance> = new Set();

  private scrollDirty = true;
  private heightDirty = true;
  private scrollHeightDirty = true;
  private renderedObservers = 0;
  private connectQueue: Map<HTMLElement, SubscribedInstance> = new Map();

  constructor(config?: Partial<VirtualizerConfig>) {
    this.config = { ...DEFAULT_VIRTUALIZER_CONFIG, ...config };
  }

  setup(root: HTMLElement | Document, contentContainer?: Element): void {
    if (this.root != null) {
      return;
    }
    this.root = root;
    this.resizeObserver = new ResizeObserver(this.handleContainerResize);
    this.intersectionObserver = new IntersectionObserver(
      this.handleIntersectionChange,
      {
        root: this.root,
        threshold: INTERSECTION_OBSERVER_THRESHOLD,
        rootMargin: `${this.config.intersectionObserverMargin}px 0px ${this.config.intersectionObserverMargin}px 0px`,
        // FIXME(amadeus): Figure out the other settings we'll want in here, or
        // if we should make them configurable...
      }
    );
    if (root instanceof Document) {
      window.addEventListener('scroll', this.handleWindowScroll, {
        passive: true,
      });
      window.addEventListener('resize', this.handleWindowResize, {
        passive: true,
      });
      this.resizeObserver.observe(root.documentElement);
    } else {
      root.addEventListener('scroll', this.handleElementScroll, {
        passive: true,
      });
      this.resizeObserver.observe(root);
      contentContainer ??= root.firstElementChild ?? undefined;
      if (contentContainer instanceof HTMLElement) {
        this.contentContainer = contentContainer;
        this.resizeObserver.observe(contentContainer);
      }
    }

    // FIXME(amadeus): Remove me before release
    window.__INSTANCE = this;
    window.__TOGGLE = () => {
      if (Virtualizer.__STOP) {
        Virtualizer.__STOP = false;
        const scroller = this.getScrollContainerElement() ?? window;
        scroller.scrollTo({ top: Virtualizer.__lastScrollPosition });
        queueRender(this.computeRenderRangeAndEmit);
      } else {
        Virtualizer.__lastScrollPosition = this.getScrollTop();
        Virtualizer.__STOP = true;
      }
    };
    for (const [container, instance] of this.connectQueue) {
      this.connect(container, instance);
    }
    this.connectQueue.clear();
    this.markDOMDirty();
    queueRender(this.computeRenderRangeAndEmit);
  }

  instanceChanged(instance: SubscribedInstance, domDirty: boolean): void {
    this.instancesChanged.add(instance);
    if (domDirty) {
      this.markDOMDirty();
    }
    queueRender(this.computeRenderRangeAndEmit);
  }

  // The render loop only reconciles heights for instances it repainted
  // itself, but content can also land outside a virtualizer pass (a
  // host/React-driven render call, an async highlight completion). Those
  // renders queue themselves here so their measured line deltas — wrapped
  // lines, annotation heights — are re-captured; otherwise a layout reset
  // (e.g. an edit-session exit recompute) leaves the instance stuck on its
  // baseline estimate and its placeholder renders the wrong height.
  requestHeightReconcile(instance: SubscribedInstance): void {
    this.reconcileQueue.add(instance);
    queueRender(this.computeRenderRangeAndEmit);
  }

  getWindowSpecs(): VirtualWindowSpecs {
    if (this.windowSpecs.top === 0 && this.windowSpecs.bottom === 0) {
      this.windowSpecs = createWindowFromScrollPosition({
        scrollTop: this.getScrollTop(),
        height: this.getHeight(),
        scrollHeight: this.getScrollHeight(),
        overscrollSize: this.config.overscrollSize,
      });
    }
    return this.windowSpecs;
  }

  getRoot(): HTMLElement | Document | undefined {
    return this.root;
  }

  isInstanceVisible(elementTop: number, elementHeight: number): boolean {
    const scrollTop = this.getScrollTop();
    const height = this.getHeight();
    const margin = this.config.intersectionObserverMargin;
    const top = scrollTop - margin;
    const bottom = scrollTop + height + margin;
    return !(elementTop < top - elementHeight || elementTop > bottom);
  }

  private handleContainerResize = (entries: ResizeObserverEntry[]) => {
    if (this.root == null) return;
    let shouldQueueUpdate = false;
    for (const entry of entries) {
      const blockSize = entry.borderBoxSize[0].blockSize;
      const isDocument = this.root instanceof Document;
      if (!isDocument && entry.target === this.root) {
        if (blockSize !== this.height) {
          this.heightDirty = true;
          shouldQueueUpdate = true;
        }
      } else if (
        isDocument
          ? blockSize !== this.scrollHeight
          : entry.target === this.contentContainer
      ) {
        this.scrollHeightDirty = true;
        shouldQueueUpdate = true;
        if (this.config.resizeDebugging) {
          console.log(
            isDocument
              ? 'Virtualizer: content size change'
              : 'Virtualizer: scroller size change',
            this.__id,
            { sizeChange: blockSize - lastSize, newSize: blockSize }
          );
          lastSize = blockSize;
        }
      }
    }

    if (shouldQueueUpdate) {
      queueRender(this.computeRenderRangeAndEmit);
    }
  };

  cleanUp(): void {
    dequeueRender(this.computeRenderRangeAndEmit);
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = undefined;
    this.root?.removeEventListener('scroll', this.handleElementScroll);
    window.removeEventListener('scroll', this.handleWindowScroll);
    window.removeEventListener('resize', this.handleWindowResize);
    this.root = undefined;
    this.contentContainer = undefined;
    this.observers.clear();
    this.visibleInstances.clear();
    this.instancesChanged.clear();
    this.reconcileQueue.clear();
    this.connectQueue.clear();
    this.visibleInstancesDirty = false;
    this.windowSpecs = { top: 0, bottom: 0 };
    this.scrollTop = 0;
    this.height = 0;
    this.scrollHeight = 0;
    this.scrollDirty = true;
    this.heightDirty = true;
    this.scrollHeightDirty = true;
  }

  getOffsetInScrollContainer(element: HTMLElement): number {
    return (
      this.getScrollTop() +
      getRelativeBoundingTop(element, this.getScrollContainerElement())
    );
  }

  connect(container: HTMLElement, instance: SubscribedInstance): () => void {
    if (this.observers.has(container)) {
      throw new Error('Virtualizer.connect: instance is already connected...');
    }
    // If we are racing against the intersectionObserver, then we should just
    // queue up the connection for when the observer does get set up
    if (this.intersectionObserver == null) {
      this.connectQueue.set(container, instance);
    } else {
      // FIXME(amadeus): Go through the connection phase a bit more closely...
      this.intersectionObserver.observe(container);
      this.observers.set(container, instance);
      this.instancesChanged.add(instance);
      this.markDOMDirty();
      queueRender(this.computeRenderRangeAndEmit);
    }
    return () => this.disconnect(container);
  }

  disconnect(container: HTMLElement): void {
    const instance = this.observers.get(container);
    this.connectQueue.delete(container);
    if (instance == null) {
      return;
    }
    this.intersectionObserver?.unobserve(container);
    this.observers.delete(container);
    this.instancesChanged.delete(instance);
    this.reconcileQueue.delete(instance);
    if (this.visibleInstances.delete(container)) {
      this.visibleInstancesDirty = true;
    }
    this.markDOMDirty();
    queueRender(this.computeRenderRangeAndEmit);
  }

  private handleWindowResize = () => {
    if (Virtualizer.__STOP || window.innerHeight === this.height) {
      return;
    }
    this.heightDirty = true;
    queueRender(this.computeRenderRangeAndEmit);
  };

  private handleWindowScroll = () => {
    if (Virtualizer.__STOP || !(this.root instanceof Document)) {
      return;
    }
    this.scrollDirty = true;
    queueRender(this.computeRenderRangeAndEmit);
  };

  private handleElementScroll = () => {
    if (
      Virtualizer.__STOP ||
      this.root == null ||
      this.root instanceof Document
    ) {
      return;
    }
    this.scrollDirty = true;
    queueRender(this.computeRenderRangeAndEmit);
  };

  private computeRenderRangeAndEmit = () => {
    if (Virtualizer.__STOP) {
      return;
    }
    const wrapperDirty = this.heightDirty || this.scrollHeightDirty;
    let instancesHaveChanged = this.instancesChanged.size > 0;

    // If we got an emitted update from a bunch of instances, we should skip
    // the window check first and attempt to render with existing logic first
    // and then queue up a corrected render after
    if (!instancesHaveChanged) {
      const windowSpecs = createWindowFromScrollPosition({
        scrollTop: this.getScrollTop(),
        height: this.getHeight(),
        scrollHeight: this.getScrollHeight(),
        overscrollSize: this.config.overscrollSize,
      });
      if (
        !wrapperDirty &&
        areVirtualWindowSpecsEqual(this.windowSpecs, windowSpecs) &&
        this.renderedObservers === this.observers.size &&
        !this.visibleInstancesDirty &&
        this.reconcileQueue.size === 0
      ) {
        return;
      }
      this.windowSpecs = windowSpecs;
    }
    this.visibleInstancesDirty = false;
    this.renderedObservers = this.observers.size;
    const anchor = this.getScrollAnchor(this.height);
    const updatedInstances = new Set<SubscribedInstance>();
    // NOTE(amadeus): If the wrapper is dirty, we need to force every component
    // to re-render
    for (const instance of wrapperDirty
      ? this.observers.values()
      : this.visibleInstances.values()) {
      if (instance.onRender(wrapperDirty)) {
        updatedInstances.add(instance);
      }
    }
    for (const instance of this.instancesChanged) {
      if (!updatedInstances.has(instance) && instance.onRender(wrapperDirty)) {
        updatedInstances.add(instance);
      }
    }

    this.scrollFix(anchor);

    for (const instance of updatedInstances) {
      this.reconcileQueue.delete(instance);
      instance.reconcileHeights();
    }
    // Reconcile externally-rendered instances that may have new heights
    for (const instance of this.reconcileQueue) {
      if (instance.reconcileHeights()) {
        instancesHaveChanged = true;
      }
    }
    this.reconcileQueue.clear();
    instancesHaveChanged ||= this.instancesChanged.size > 0;

    // Reconciliation reads virtualized offsets and can consume dirty geometry
    // flags, so mark after it when an instance update needs a corrected pass.
    if (instancesHaveChanged) {
      this.markDOMDirty();
    }

    if (instancesHaveChanged || wrapperDirty) {
      queueRender(this.computeRenderRangeAndEmit);
    }
    this.instancesChanged.clear();
  };

  private scrollFix(anchor: ScrollAnchor | undefined) {
    if (anchor == null) {
      return;
    }
    const scrollContainer = this.getScrollContainerElement();
    const { lineIndex, lineOffset, fileElement, fileOffset, fileTypeOffset } =
      anchor;
    if (lineIndex != null && lineOffset != null) {
      const element = fileElement.shadowRoot?.querySelector(
        `[data-line][data-line-index="${lineIndex}"]`
      );
      if (element instanceof HTMLElement) {
        const top = getRelativeBoundingTop(element, scrollContainer);
        if (top !== lineOffset) {
          this.applyScrollFix(top - lineOffset);
        }
        return;
      }
    }
    const top = getRelativeBoundingTop(fileElement, scrollContainer);
    const edge =
      fileTypeOffset === 'top'
        ? top
        : top + fileElement.getBoundingClientRect().height;
    if (edge !== fileOffset) {
      this.applyScrollFix(edge - fileOffset);
    }
  }

  private applyScrollFix(scrollOffset: number) {
    if (this.root == null || this.root instanceof Document) {
      window.scrollTo({
        top: window.scrollY + scrollOffset,
        behavior: 'instant',
      });
    } else {
      this.root.scrollTo({
        top: this.root.scrollTop + scrollOffset,
        behavior: 'instant',
      });
    }
    // Because we fixed our scroll positions, it means something resized or
    // moved around, so we should mark everything as dirty so the
    // reconciliation call will get the latest data when figuring calling
    // .getOffsetInScrollContainer
    this.markDOMDirty();
  }

  // This function tries to figure out the closest file or line to the viewport
  // top that's visible to use as a relative marker for how to fix scroll
  // position after issuing dom updates
  private getScrollAnchor(viewportHeight: number): ScrollAnchor | undefined {
    const scrollContainer = this.getScrollContainerElement();
    let bestAnchor: ScrollAnchor | undefined;

    for (const fileElement of this.visibleInstances.keys()) {
      const fileTop = getRelativeBoundingTop(fileElement, scrollContainer);
      const fileBottom = fileTop + fileElement.offsetHeight;
      // Only use the bottom as anchor when the entire file is above viewport
      const fileOffset = fileBottom <= 0 ? fileBottom : fileTop;

      // Find the best line (first fully visible) within this file
      let bestLineIndex: string | undefined;
      let bestLineOffset: number | undefined;

      // Only search for lines if file potentially intersects viewport
      if (fileBottom > 0 && fileTop < viewportHeight) {
        for (const line of fileElement.shadowRoot?.querySelectorAll(
          '[data-line][data-line-index]'
        ) ?? []) {
          if (!(line instanceof HTMLElement)) continue;
          const lineOffset = getRelativeBoundingTop(line, scrollContainer);

          // Ignore lines with negative offsets (above viewport top)
          if (lineOffset < 0) continue;

          // First visible line in DOM order is the best one because
          // querySelectorAll will grab lines in order as they appear in the
          // DOM
          bestLineIndex = line.dataset.lineIndex;
          bestLineOffset = lineOffset;
          break;
        }
      }

      if (
        // If we don't already have an anchor we should set one
        bestAnchor == null ||
        // If we found a better line anchor, we should replace the old one
        (bestLineOffset != null &&
          (bestAnchor.lineOffset == null ||
            bestLineOffset < bestAnchor.lineOffset)) ||
        // Otherwise compare file only anchors: favor files with their tops in
        // view, or else the closest file
        (bestLineOffset == null &&
          bestAnchor.lineOffset == null &&
          ((fileOffset >= 0 &&
            (bestAnchor.fileOffset < 0 ||
              fileOffset < bestAnchor.fileOffset)) ||
            (fileOffset < 0 &&
              bestAnchor.fileOffset < 0 &&
              fileOffset > bestAnchor.fileOffset)))
      ) {
        bestAnchor = {
          fileElement,
          fileTypeOffset: fileBottom <= 0 ? 'bottom' : 'top',
          fileOffset,
          lineIndex: bestLineIndex,
          lineOffset: bestLineOffset,
        };
      }
    }

    return bestAnchor;
  }

  private handleIntersectionChange = (
    entries: IntersectionObserverEntry[]
  ): void => {
    this.scrollDirty = true;
    for (const { target, isIntersecting } of entries) {
      if (!(target instanceof HTMLElement)) {
        throw new Error(
          'Virtualizer.handleIntersectionChange: target not an HTMLElement'
        );
      }
      const instance = this.observers.get(target);
      // IntersectionObserver delivers entries asynchronously, so an entry can
      // arrive after the target was unobserved via disconnect() or releaseElement().
      if (instance == null) {
        continue;
      }
      if (isIntersecting && !this.visibleInstances.has(target)) {
        instance.setVisibility(true);
        this.visibleInstances.set(target, instance);
        this.visibleInstancesDirty = true;
      } else if (!isIntersecting && this.visibleInstances.has(target)) {
        instance.setVisibility(false);
        this.visibleInstances.delete(target);
        this.visibleInstancesDirty = true;
      }
    }

    if (this.visibleInstancesDirty) {
      // Since this call is already debounced, should we just call
      // computeRenderRangeAndEmit directly?
      queueRender(this.computeRenderRangeAndEmit);
    }
    // Debug logging for visible instances
    // console.log(
    //   'handleIntersectionChange',
    //   ...Array.from(this.visibleInstances.keys())
    // );
  };

  /** Return the logical vertical position for the scroll container */
  public getScrollTop(): number {
    if (!this.scrollDirty) {
      return this.scrollTop;
    }
    this.scrollDirty = false;
    let scrollTop = 0;
    if (this.root instanceof Document) {
      scrollTop = window.scrollY;
    } else if (this.root != null) {
      scrollTop = this.root.scrollTop;
    }
    // Lets always make sure to clamp scroll position cases of
    // over/bounce scroll
    this.scrollTop = this.clampScrollTop(scrollTop);
    return this.scrollTop;
  }

  /** Scroll to a logical vertical position and queue the normal render pass. */
  public scrollTo({ top, behavior = 'auto' }: VirtualizerScrollOptions): void {
    const { root } = this;
    if (root == null) {
      return;
    }

    const scrollTop = this.clampScrollTop(top);
    if (root instanceof Document) {
      window.scrollTo({ top: scrollTop, behavior });
    } else {
      root.scrollTo({ top: scrollTop, behavior });
    }
    this.scrollDirty = true;
    queueRender(this.computeRenderRangeAndEmit);
  }

  private clampScrollTop(scrollTop: number): number {
    return Math.max(
      0,
      Math.min(scrollTop, this.getScrollHeight() - this.getHeight())
    );
  }

  private getScrollHeight() {
    if (!this.scrollHeightDirty) {
      return this.scrollHeight;
    }
    this.scrollHeightDirty = false;
    this.scrollHeight =
      this.root instanceof Document
        ? this.root.documentElement.scrollHeight
        : (this.root?.scrollHeight ?? 0);
    return this.scrollHeight;
  }

  private getHeight() {
    if (!this.heightDirty) {
      return this.height;
    }
    this.heightDirty = false;
    this.height =
      this.root instanceof Document
        ? globalThis.innerHeight
        : (this.root?.getBoundingClientRect().height ?? 0);
    return this.height;
  }

  markDOMDirty(): void {
    this.scrollDirty = true;
    this.scrollHeightDirty = true;
    this.heightDirty = true;
  }

  private getScrollContainerElement(): HTMLElement | undefined {
    return this.root == null || this.root instanceof Document
      ? undefined
      : this.root;
  }
}

// This function is like a generalized getBoundingClientRect for it's relative
// scroll container
function getRelativeBoundingTop(
  element: HTMLElement,
  scrollContainer: HTMLElement | undefined
) {
  const rect = element.getBoundingClientRect();
  const scrollContainerTop = scrollContainer?.getBoundingClientRect().top ?? 0;
  return rect.top - scrollContainerTop;
}
