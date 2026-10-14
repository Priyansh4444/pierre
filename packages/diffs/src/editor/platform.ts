import { isMacLike, isSafari } from '../utils/platform';

export { isMacLike, isSafari };

export function isPrimaryModifier(
  { metaKey, ctrlKey }: MouseEvent | KeyboardEvent,
  isMac: boolean = isMacLike()
): boolean {
  return isMac ? metaKey && !ctrlKey : ctrlKey && !metaKey;
}

export function isMoveCursorShortcut(
  e: KeyboardEvent
):
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'start'
  | 'textStart'
  | 'end'
  | undefined {
  // emacs key bindings
  if (isMacLike() && e.ctrlKey && !e.altKey && !e.metaKey) {
    switch (e.key) {
      case 'a':
        return 'start';
      case 'e':
        return 'end';
      case 'p':
        return 'up';
      case 'n':
        return 'down';
      case 'f':
        return 'right';
      case 'b':
        return 'left';
    }
  }

  if (!e.altKey && !e.ctrlKey && !e.metaKey) {
    switch (e.key) {
      case 'ArrowUp':
        return 'up';
      case 'ArrowDown':
        return 'down';
      case 'ArrowLeft':
        return 'left';
      case 'ArrowRight':
        return 'right';
      case 'Home':
        return 'start';
      case 'End':
        return 'end';
    }
  }

  if (isPrimaryModifier(e)) {
    if (e.key === 'ArrowLeft') {
      return 'textStart';
    }
    if (e.key === 'ArrowRight') {
      return 'end';
    }
  }

  return undefined;
}
