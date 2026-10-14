import {
  type PopoverViewportBounds,
  setPopoverPositionStyles,
} from './popover';
import type { TextDocument } from './textDocument';
import type { EditorSelection, EditorType, TextEdit } from './types';
import { h } from './utils';

export interface SelectionActionContext<
  EType extends EditorType = EditorType,
  LAnnotation = unknown,
> {
  /** The current selection (live: reflects keyboard-driven changes). */
  selection: EditorSelection;
  /** The text document. */
  textDocument: TextDocument<EType, LAnnotation>;
  /** Applies the edits to the text document. */
  applyEdits: (edits: TextEdit[]) => void;
  /** Gets the text of the current selection. */
  getSelectionText: () => string;
  /** Replaces the text of the current selection. */
  replaceSelectionText: (text: string) => void;
  /** Closes the selection action. */
  close: () => void;
}

export class SelectionActionWidget {
  #root: HTMLElement;
  // Cached border-box height, refreshed only when the popover's own size
  // actually changes (via #resizeObserver below)
  #height: number;
  #resizeObserver: ResizeObserver;

  constructor(
    selectionActionElement: HTMLElement,
    overlayElement: HTMLElement,
    onHeightChange: () => void
  ) {
    this.#root = h(
      'div',
      {
        dataset: { editorWidget: '', selectionActionPopover: '' },
        contentEditable: 'false',
        children: [selectionActionElement],
      },
      overlayElement
    );
    this.#height = this.#root.offsetHeight;
    this.#resizeObserver = new ResizeObserver(() => {
      const height = this.#root.offsetHeight;
      if (height !== this.#height) {
        this.#height = height;
        onHeightChange();
      }
    });
    this.#resizeObserver.observe(this.#root);
  }

  // `visible` is whether the selection intersects the viewport.
  reposition(
    left: number,
    top: number,
    gutterWidth: number,
    placeAbove: boolean,
    visible: boolean,
    viewport?: PopoverViewportBounds
  ): void {
    this.#root.style.visibility = visible ? '' : 'hidden';
    setPopoverPositionStyles(this.#root, {
      gutterWidth,
      placeAbove,
      viewport,
      x: left,
      y: top,
    });
  }

  get height(): number {
    return this.#height;
  }

  cleanup(): void {
    this.#resizeObserver.disconnect();
    this.#root.remove();
  }
}
