import { resolveFindAgainShortcut } from './command';
import { buildSearchReplacementText } from './pieceTable';
import { isPrimaryModifier } from './platform';
import { getEditorIconSvg, type SVGSpriteNames } from './sprite';
import type { TextDocument } from './textDocument';
import type { ResolvedTextEdit } from './types';
import { h } from './utils';

export type MatchRange = [startOffset: number, endOffset: number];

export type SearchPanelMode = 'find' | 'replace';

export interface SearchParams {
  text: string;
  replaceText: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface SearchPanelOptions {
  textDocument: TextDocument;
  containerElement: HTMLElement;
  defaultQuery: string;
  mode?: SearchPanelMode;
  initialMatch?: MatchRange;
  scrollToMatch: (nextMatch: MatchRange, retainFocus: boolean) => void;
  applyReplace: (edits: ResolvedTextEdit[]) => void;
  onUpdate: (
    matches: MatchRange[],
    options?: { syncSelection?: boolean }
  ) => MatchRange | undefined;
  onClose: () => void;
}

export class SearchPanelWidget {
  #container: HTMLDivElement;
  #inputElement: HTMLInputElement;
  #updateMatches: (options?: { syncSelection?: boolean }) => void;
  #applyMode: (mode: SearchPanelMode) => void;
  #navigate: (findPrevious: boolean) => void;
  #close: () => void;

  constructor({
    textDocument,
    containerElement,
    defaultQuery,
    mode = 'find',
    initialMatch,
    scrollToMatch,
    applyReplace,
    onUpdate,
    onClose,
  }: SearchPanelOptions) {
    const searchParams: SearchParams = {
      text: defaultQuery,
      replaceText: '',
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    };

    const matches = {
      all: [] as MatchRange[],
      current: undefined as MatchRange | undefined,
    };

    // Default to the empty-query "no results" state so it shows on open before
    // any search runs.
    const matchResultElement = h('div', {
      dataset: { matches: '', noMatches: '' },
      textContent: 'No results',
    });
    const updateMatches = (options?: { syncSelection?: boolean }) => {
      matches.all =
        searchParams.text !== '' ? textDocument.search(searchParams) : [];
      const noMatches = matches.all.length === 0;
      prevButton.disabled = noMatches;
      nextButton.disabled = noMatches;

      // An empty query and a query with zero hits are the same "no results"
      // state. Both push an empty match set through onUpdate so the editor
      // drops #matches and clears the painted highlights.
      if (noMatches) {
        matchResultElement.textContent = 'No results';
        matchResultElement.dataset.noMatches = '';
        matches.current = undefined;
        onUpdate([]);
        return;
      }

      delete matchResultElement.dataset.noMatches;
      updateCurrentMatch(
        options?.syncSelection === false
          ? onUpdate(matches.all, { syncSelection: false })
          : onUpdate(matches.all)
      );
    };
    this.#updateMatches = updateMatches;

    const updateCurrentMatch = (currentMatch: MatchRange | undefined) => {
      if (currentMatch === undefined) {
        matchResultElement.textContent = `${matches.all.length} results`;
      } else {
        const [start, end] = currentMatch;
        const index = matches.all.findIndex(
          (m) => m[0] === start && m[1] === end
        );
        matchResultElement.textContent = `${index + 1} of ${matches.all.length}`;
      }
      matches.current = currentMatch;
    };

    const findNextMatch = (
      findPrevious: boolean = false,
      retainFocus: boolean = false
    ) => {
      const allMatches = matches.all;
      let nextMatch: MatchRange | undefined = allMatches[0];
      if (findPrevious) {
        const searchOffset = matches.current?.[0] ?? 0;
        nextMatch = allMatches.at(-1);
        for (const m of allMatches) {
          if (m[1] <= searchOffset) {
            nextMatch = m;
          } else {
            break;
          }
        }
      } else {
        const searchOffset = matches.current?.[1] ?? 0;
        for (const m of allMatches) {
          if (m[0] >= searchOffset) {
            nextMatch = m;
            break;
          }
        }
      }
      if (nextMatch !== undefined) {
        updateCurrentMatch(nextMatch);
        scrollToMatch(nextMatch, retainFocus);
      }
      matches.current = nextMatch;
    };
    // Keep focus in the panel when stepping through matches from the inputs.
    this.#navigate = (findPrevious: boolean) =>
      findNextMatch(findPrevious, true);

    const buildReplacementEdit = (
      matchStart: number,
      matchEnd: number
    ): ResolvedTextEdit => ({
      start: matchStart,
      end: matchEnd,
      text: buildSearchReplacementText(
        (offset) => textDocument.positionAt(offset),
        (position) => textDocument.offsetAt(position),
        (line) => textDocument.getLineText(line),
        searchParams,
        matchStart,
        matchEnd
      ),
    });

    // An empty query never has matches, so these only check the match list.
    const replace = () => {
      if (matches.all.length === 0) {
        return;
      }
      if (matches.current === undefined) {
        findNextMatch(false, true);
      }
      const currentMatch = matches.current;
      if (currentMatch === undefined) {
        return;
      }

      const [start, end] = currentMatch;
      const edit = buildReplacementEdit(start, end);
      applyReplace([edit]);

      // Collapse after the replacement so the next search pass advances.
      const caret = start + edit.text.length;
      scrollToMatch([caret, caret], true);
      matches.current = undefined;
      updateMatches();
    };

    const replaceAll = () => {
      if (matches.all.length === 0) {
        return;
      }

      applyReplace(
        matches.all.map(([start, end]) => buildReplacementEdit(start, end))
      );
      matches.current = undefined;
      updateMatches();
    };

    const close = () => {
      this.cleanup();
      onClose();
    };
    this.#close = close;

    // Shared builder for the panel's icon controls. Every clickable control is a
    // real <button> so it gets focus, keyboard activation, and native disabled
    // handling for free; `getEditorIconSvg` marks the glyph aria-hidden, so the
    // accessible name comes from `label` (also used as the hover title).
    const iconButton = (opts: {
      icon: SVGSpriteNames;
      label: string;
      size?: number;
      dataset?: Record<string, string>;
      onClick: () => void;
    }) =>
      h('button', {
        type: 'button',
        title: opts.label,
        ariaLabel: opts.label,
        dataset: { searchIcon: '', ...opts.dataset },
        innerHTML: getEditorIconSvg(opts.icon, opts.size),
        onclick: opts.onClick,
      });

    // Builds an always-visible icon button that toggles one boolean search
    // option (case/whole-word/regex). The button reflects its on/off state via
    // `aria-pressed` so the stylesheet can highlight it and assistive tech can
    // announce it.
    const makeToggle = (
      icon: SVGSpriteNames,
      title: string,
      key: 'caseSensitive' | 'wholeWord' | 'regex'
    ) => {
      const button = iconButton({
        icon,
        label: title,
        size: 14,
        onClick: () => {
          const next = !searchParams[key];
          button.ariaPressed = String(next);
          searchParams[key] = next;
          updateMatches();
        },
      });
      button.ariaPressed = String(searchParams[key]);
      return button;
    };

    // Shared keyboard handling for the find and replace inputs.
    const onInputKeyDown = (e: KeyboardEvent, isFindInput: boolean) => {
      if (e.isComposing || e.keyCode === 229) {
        return;
      }
      const findAgain = resolveFindAgainShortcut(e);
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (isFindInput) {
          findNextMatch(e.shiftKey, true);
        } else {
          replace();
        }
      } else if (findAgain !== undefined) {
        // Override the native browser find-again shortcut so cmd+g steps to
        // the next match and cmd+shift+g to the previous one.
        e.preventDefault();
        findNextMatch(findAgain === 'previous', true);
      } else if (
        isFindInput &&
        isPrimaryModifier(e) &&
        (e.key === 'f' || e.code === 'KeyF')
      ) {
        // Prevent the default browser search panel and switch the panel mode
        // in place (cmd+f -> find, cmd+opt+f -> find/replace).
        e.preventDefault();
        this.#applyMode(e.altKey ? 'replace' : 'find');
      }
    };

    this.#inputElement = h('input', {
      type: 'text',
      placeholder: 'Search',
      dataset: 'search',
      value: defaultQuery,
      oninput: (e: Event) => {
        searchParams.text = (e.target as HTMLInputElement).value;
        matches.current = undefined;
        updateMatches();
      },
      onkeydown: (e: KeyboardEvent) => onInputKeyDown(e, true),
    });

    // Held so the no-results state can toggle their native disabled flag.
    const prevButton = iconButton({
      icon: 'arrow-up',
      label: 'Previous',
      onClick: () => {
        findNextMatch(true);
      },
    });
    const nextButton = iconButton({
      icon: 'arrow-down',
      label: 'Next',
      onClick: () => {
        findNextMatch();
      },
    });
    prevButton.disabled = true;
    nextButton.disabled = true;

    // Cells are positioned by CSS grid-template-areas (see editor.css), so DOM
    // order here only drives tab/reading order, not layout. Keep the replace
    // input directly after the find input (and its toggles) so Tab walks
    // find -> replace before reaching the nav arrows and close button.
    const gridElement = h('div', {
      dataset: { searchGrid: '', mode },
      children: [
        h('div', {
          dataset: { inputBox: '', find: '' },
          children: [
            this.#inputElement,
            // The search-option toggles overlay the find input's right edge.
            h('div', {
              dataset: 'searchToggles',
              children: [
                makeToggle('case', 'Match Case', 'caseSensitive'),
                makeToggle('whole-word', 'Whole Word', 'wholeWord'),
                makeToggle('regex', 'Regexp', 'regex'),
              ],
            }),
          ],
        }),
        // Replace cells are hidden together in find-only mode.
        h('div', {
          dataset: { inputBox: '', replace: '', replaceCell: '' },
          children: [
            h('input', {
              type: 'text',
              placeholder: 'Replace',
              dataset: 'replace',
              value: '',
              oninput: (e: Event) => {
                searchParams.replaceText = (e.target as HTMLInputElement).value;
              },
              onkeydown: (e: KeyboardEvent) => onInputKeyDown(e, false),
            }),
          ],
        }),
        h('div', {
          dataset: { replaceActions: '', replaceCell: '' },
          children: [
            iconButton({ icon: 'replace', label: 'Replace', onClick: replace }),
            iconButton({
              icon: 'replace-all',
              label: 'Replace All',
              onClick: replaceAll,
            }),
          ],
        }),
        matchResultElement,
        h('div', { dataset: 'searchNav', children: [prevButton, nextButton] }),
        iconButton({
          icon: 'close',
          label: 'Close',
          onClick: close,
          dataset: { searchClose: '' },
        }),
      ],
    });

    // Toggles the panel between find and find/replace modes by showing or
    // hiding the replace cells, then returns focus to the find input.
    this.#applyMode = (next: SearchPanelMode) => {
      gridElement.dataset.mode = next;
      this.#inputElement.focus();
      this.#inputElement.select();
    };

    this.#container = h('div', {
      dataset: 'searchPanel',
      children: [
        h('div', {
          dataset: 'editorWidget',
          children: [gridElement],
        }),
      ],
    });

    matches.current = initialMatch;
    containerElement.before(this.#container);

    requestAnimationFrame(() => {
      if (initialMatch !== undefined) {
        updateMatches();
      } else {
        onUpdate([]);
      }
      this.#inputElement.select();
    });
  }

  focus(): void {
    this.#inputElement.focus();
  }

  navigate(findPrevious: boolean): void {
    this.#navigate(findPrevious);
  }

  updateMatches(options?: { syncSelection?: boolean }): void {
    this.#updateMatches(options);
  }

  setMode(mode: SearchPanelMode): void {
    this.#applyMode(mode);
  }

  // Tears the panel down the way the close button and Escape-in-input do:
  // removes the DOM and runs onClose so the editor clears its match highlights.
  // Prefer this over cleanup() for any user-initiated dismissal.
  close(): void {
    this.#close();
  }

  // DOM-only teardown. Does NOT run onClose, so it leaves the editor's match
  // highlights in place; only use it when the caller clears that state itself
  // (e.g. a full editor reset). User-initiated dismissals should call close().
  cleanup(): void {
    this.#container.remove();
  }
}
