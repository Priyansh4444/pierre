import {
  POPOVER_BOUNDARY_LINES,
  type PopoverManager,
  setPopoverPositionStyles,
} from './popover';
import { selectionIntersects } from './selection';
import type { TextDocument } from './textDocument';
import type { Range } from './types';
import { addEventListener, getLineNumberAttr, h } from './utils';

const MARKER_POPOVER_SHOW_DELAY_MS = 300;
const MARKER_POPOVER_HIDE_DELAY_MS = 100;
const MARKER_POPOVER_PLACEMENT_KEY = 'marker-popover';

export type MarkerSeverity = 'error' | 'warning' | 'info' | 'hint';

export interface Marker extends Range {
  severity: MarkerSeverity;
  message: string | { html: string } | HTMLElement;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface MarkerRenderOptions {
  popoverManager: PopoverManager;
  getLineHeight: () => number;
  getOverlayElement: () => HTMLElement | undefined;
  getGutterWidth: () => number;
  getCharX: (line: number, character: number) => [number, number];
  getLineY: (line: number) => number;
  isMouseDown: () => boolean;
}

export class MarkerRenderer {
  #options: MarkerRenderOptions;
  #markers: Marker[] = [];
  // Document line count, used only by the no-viewport document-edge fallback.
  #lineCount = 0;
  #markerPopoverElement?: HTMLElement;
  #markerPopoverEventDisposes?: (() => void)[];
  #markerEventDisposes?: (() => void)[];
  #markerPopoverShowTimeout?: ReturnType<typeof setTimeout>;
  #markerPopoverHideTimeout?: ReturnType<typeof setTimeout>;
  #pendingMarkerPopoverIndex?: number;
  #hoveredMarkerIndex?: number;
  #isMarkerPopoverHovered = false;

  constructor(editor: MarkerRenderOptions) {
    this.#options = editor;
  }

  get markers(): readonly Marker[] {
    return this.#markers;
  }

  isPopoverVisible(): boolean {
    return this.#hoveredMarkerIndex !== undefined;
  }

  updatePopoverPosition(): void {
    const hoveredMarkerIndex = this.#hoveredMarkerIndex;
    const popover = this.#markerPopoverElement;
    if (hoveredMarkerIndex === undefined || popover === undefined) {
      return;
    }
    const marker = this.#markers[hoveredMarkerIndex];
    if (marker === undefined) {
      this.removePopover();
      return;
    }
    this.#positionMarkerPopover(
      popover,
      marker.start.line,
      marker.start.character
    );
  }

  setMarkers(markers: Marker[], textDocument: TextDocument): void {
    this.#lineCount = textDocument.lineCount;
    this.#markers = markers.map((marker) => ({
      ...marker,
      start: textDocument.normalizePosition(marker.start),
      end: textDocument.normalizePosition(marker.end),
    }));
    this.removePopover();
  }

  listenHover(contentEl: HTMLElement): void {
    this.#markerEventDisposes?.forEach((dispose) => dispose());
    this.#markerEventDisposes = undefined;
    if (this.#markers.length === 0) {
      return;
    }

    this.#markerEventDisposes = [
      addEventListener(contentEl, 'mouseover', (e) => {
        if (this.#options.isMouseDown()) {
          return;
        }
        const target = e.composedPath()[0] as HTMLElement | undefined;
        if (target === undefined) {
          return;
        }

        const markerIndex = this.#findHoveredMarkerIndex(target);
        if (markerIndex === undefined) {
          this.#cancelMarkerPopoverShow();
          this.#scheduleMarkerPopoverHide();
          return;
        }
        if (
          markerIndex === this.#hoveredMarkerIndex ||
          markerIndex === this.#pendingMarkerPopoverIndex
        ) {
          this.#cancelMarkerPopoverHide();
          return;
        }

        this.#cancelMarkerPopoverShow();
        this.#cancelMarkerPopoverHide();
        if (this.#markerPopoverElement !== undefined) {
          this.#renderMarkerPopover(markerIndex);
          return;
        }

        this.#pendingMarkerPopoverIndex = markerIndex;
        this.#markerPopoverShowTimeout = setTimeout(() => {
          this.#markerPopoverShowTimeout = undefined;
          this.#pendingMarkerPopoverIndex = undefined;
          this.#renderMarkerPopover(markerIndex);
        }, MARKER_POPOVER_SHOW_DELAY_MS);
      }),
      addEventListener(contentEl, 'mouseleave', () => {
        this.#cancelMarkerPopoverShow();
        this.#scheduleMarkerPopoverHide();
      }),
    ];
  }

  removePopover(): void {
    this.#cancelMarkerPopoverShow();
    this.#cancelMarkerPopoverHide();
    this.#markerPopoverEventDisposes?.forEach((dispose) => dispose());
    this.#markerPopoverEventDisposes = undefined;
    this.#markerPopoverElement?.remove();
    this.#markerPopoverElement = undefined;
    this.#hoveredMarkerIndex = undefined;
    this.#isMarkerPopoverHovered = false;
    this.#options.popoverManager.resetPlacement(MARKER_POPOVER_PLACEMENT_KEY);
  }

  cleanup(): void {
    this.#markerEventDisposes?.forEach((dispose) => dispose());
    this.#markerEventDisposes = undefined;
    this.removePopover();
    this.#markers = [];
  }

  #findHoveredMarkerIndex(target: HTMLElement): number | undefined {
    const lineElement = target.closest('[data-line]');
    if (lineElement == null) {
      return;
    }

    const lineNumber = getLineNumberAttr(lineElement as HTMLElement);
    if (lineNumber === undefined) {
      return;
    }

    let character: number | undefined = 0;
    if (target.tagName === 'SPAN') {
      character = getLineNumberAttr(target, 'char');
    } else if (target.tagName !== 'BR') {
      return;
    }
    if (character === undefined) {
      return;
    }

    const position = { line: lineNumber - 1, character };
    const caret = { start: position, end: position };
    for (let i = this.#markers.length - 1; i >= 0; i--) {
      if (selectionIntersects(caret, this.#markers[i])) {
        return i;
      }
    }
    return undefined;
  }

  #cancelMarkerPopoverShow(): void {
    clearTimeout(this.#markerPopoverShowTimeout);
    this.#markerPopoverShowTimeout = undefined;
    this.#pendingMarkerPopoverIndex = undefined;
  }

  #cancelMarkerPopoverHide(): void {
    clearTimeout(this.#markerPopoverHideTimeout);
    this.#markerPopoverHideTimeout = undefined;
  }

  #scheduleMarkerPopoverHide(): void {
    if (this.#isMarkerPopoverHovered) {
      return;
    }

    this.#cancelMarkerPopoverHide();
    this.#markerPopoverHideTimeout = setTimeout(() => {
      this.#markerPopoverHideTimeout = undefined;
      if (!this.#isMarkerPopoverHovered) {
        this.removePopover();
      }
    }, MARKER_POPOVER_HIDE_DELAY_MS);
  }

  // Positions the popover for a marker at `(line, character)` in overlay
  // coordinate space (see [data-marker-popover] in editor.css): prefers below,
  // flipping above when below would be clipped by the visible scrollport.
  // Must run after the popover's content is final, since it reads the
  // popover's rendered height to decide whether either side fits.
  #positionMarkerPopover(
    popover: HTMLElement,
    line: number,
    character: number
  ): void {
    const { getCharX, getLineY, getLineHeight, popoverManager } = this.#options;
    const [left, wrapLine] = getCharX(line, character);
    const lineHeight = getLineHeight();
    const rowTop = getLineY(line) + wrapLine * lineHeight;
    const popoverHeight = popover.offsetHeight;
    const viewport = popoverManager.getPlacementBounds();
    const placeAbove =
      popoverManager.choosePlacement({
        preferred: {
          top: rowTop + lineHeight,
          bottom: rowTop + lineHeight + popoverHeight,
        },
        fallback: { top: rowTop - popoverHeight, bottom: rowTop },
        viewport,
        popoverHeight,
        atDocumentEdge: line >= this.#lineCount - POPOVER_BOUNDARY_LINES,
        placementKey: MARKER_POPOVER_PLACEMENT_KEY,
      }) === 'fallback';

    // When placed above, `y` is the top edge of the marker's row and the
    // popover is shifted up by its own height.
    setPopoverPositionStyles(popover, {
      gutterWidth: this.#options.getGutterWidth(),
      placeAbove,
      viewport,
      x: left,
      y: placeAbove ? rowTop : rowTop + lineHeight,
    });
  }

  #renderMarkerPopover(hoveredMarkerIndex: number): void {
    if (hoveredMarkerIndex === this.#hoveredMarkerIndex) {
      return;
    }

    const overlayElement = this.#options.getOverlayElement();
    if (hoveredMarkerIndex >= this.#markers.length || overlayElement == null) {
      return;
    }

    const { start, message, severity } = this.#markers[hoveredMarkerIndex];
    this.#options.popoverManager.resetPlacement(MARKER_POPOVER_PLACEMENT_KEY);

    // The popover element is reused across hovers.
    let popover = this.#markerPopoverElement;
    if (popover === undefined) {
      popover = this.#markerPopoverElement = h(
        'div',
        {
          dataset: { editorWidget: '', markerPopover: '' },
          children: [h('div', { dataset: 'markerMessage' })],
        },
        overlayElement
      );
      this.#markerPopoverEventDisposes = [
        addEventListener(popover, 'mouseenter', () => {
          this.#isMarkerPopoverHovered = true;
          this.#cancelMarkerPopoverHide();
        }),
        addEventListener(popover, 'mouseleave', () => {
          this.#isMarkerPopoverHovered = false;
          this.#scheduleMarkerPopoverHide();
        }),
      ];
    }

    // Marks the popover with data-marker-<severity> (the same boolean attribute
    // the squiggle range element uses) so the CSS severity palette can target
    // both with one selector. A previous hover's severity is cleared first.
    for (const key of Object.values(MARKER_SEVERITY_DATASET_KEYS)) {
      delete popover.dataset[key];
    }
    popover.dataset[markerSeverityDatasetKey(severity)] = '';
    const content = popover.firstElementChild as HTMLElement | null;
    if (content?.dataset.markerMessage !== undefined) {
      if (typeof message === 'string') {
        content.textContent = message;
      } else if (message instanceof HTMLElement) {
        content.replaceChildren(message);
      } else {
        content.innerHTML = message.html;
      }
    }
    // Position after updating content: a different message size changes
    // the offsetHeight #positionMarkerPopover reads to decide placement.
    this.#positionMarkerPopover(popover, start.line, start.character);
    this.#hoveredMarkerIndex = hoveredMarkerIndex;
  }
}

const MARKER_SEVERITY_DATASET_KEYS: Record<MarkerSeverity, string> = {
  error: 'markerError',
  warning: 'markerWarning',
  info: 'markerInfo',
  hint: 'markerHint',
};

export function markerSeverityDatasetKey(severity: MarkerSeverity): string {
  return MARKER_SEVERITY_DATASET_KEYS[severity];
}
