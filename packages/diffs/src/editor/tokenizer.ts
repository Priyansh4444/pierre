import { colorUtils } from '@pierre/theming/color';

import { DEFAULT_THEMES } from '../constants';
import type { DiffsEditorTokenizer } from '../highlighter/DiffsEditorTokenizer';
import type {
  BaseCodeOptions,
  DiffsHighlighter,
  HighlightedToken,
  RenderRange,
} from '../types';
import type { TextDocument, TextDocumentChange } from './textDocument';
import { addEventListener, h } from './utils';

export interface EditorTokenizerProps {
  highlighter: DiffsHighlighter;
  textDocument: TextDocument;
  codeOptions: BaseCodeOptions;
  matchBrackets?: boolean;
  setStyle: (style: string) => void;
  onDeferTokenize: (
    lines: Map<number, Array<HighlightedToken>>,
    themeType: 'dark' | 'light'
  ) => void;
  // Fired after the active theme (light/dark mode or theme name) changes and the
  // new theme CSS has been applied. Lets the editor recompute overlay pieces
  // that captured a resolved theme color, e.g. rounded selection corner masks.
  onThemeChange?: () => void;
  __debug?: boolean;
}

// Applies editor theme CSS and delegates tokenization to the selected backend.
export class EditorTokenizer {
  #highlighter: DiffsHighlighter;
  #tokenizer: DiffsEditorTokenizer;
  #mediaQueryList: MediaQueryList;
  #themeType: 'light' | 'dark' = 'dark';
  #themeName = '';
  #setStyle: EditorTokenizerProps['setStyle'];
  #onThemeChange: EditorTokenizerProps['onThemeChange'];
  #disposes?: (() => void)[];

  get themeType(): 'light' | 'dark' {
    return this.#themeType;
  }

  get highlighter(): DiffsHighlighter {
    return this.#highlighter;
  }

  constructor({
    codeOptions,
    highlighter,
    textDocument,
    matchBrackets,
    setStyle,
    onDeferTokenize,
    onThemeChange,
    __debug,
  }: EditorTokenizerProps) {
    const {
      themeType: themeTypeOption = 'system',
      theme = DEFAULT_THEMES,
      tokenizeMaxLineLength = 1000,
    } = codeOptions;
    this.#mediaQueryList = window.matchMedia('(prefers-color-scheme: dark)');
    // Prefer the host document's computed color-scheme (page CSS/classes can
    // force light/dark while the OS media query differs) over matchMedia.
    const themeType =
      themeTypeOption === 'system'
        ? this.#resolveSystemThemeType()
        : themeTypeOption;
    // Only track the document/system color scheme when the surface follows it
    // (`themeType: 'system'`). A surface pinned to an explicit 'dark'/'light'
    // theme keeps that theme regardless of the page, so re-tokenizing after an
    // edit must emit the same `--diffs-token-{theme}` variable the SSR markup
    // used; otherwise the edited tokens fall back to the default foreground.
    if (typeof theme !== 'string' && themeTypeOption === 'system') {
      // Re-read computed color-scheme so a host-forced scheme still wins when
      // the OS preference changes underneath it.
      const followSystemTheme = () => {
        const themeType = this.#resolveSystemThemeType();
        this.#emitThemeChange(theme[themeType], themeType);
      };
      const observer = new MutationObserver((mutations) => {
        for (const { type, attributeName } of mutations) {
          if (
            type === 'attributes' &&
            attributeName !== null &&
            (attributeName === 'class' || attributeName.startsWith('data-'))
          ) {
            followSystemTheme();
            break;
          }
        }
      });
      observer.observe(document.documentElement, { attributes: true });
      observer.observe(document.body, { attributes: true });
      this.#disposes = [
        addEventListener(this.#mediaQueryList, 'change', followSystemTheme),
        () => observer.disconnect(),
      ];
    }
    this.#highlighter = highlighter;
    this.#setStyle = setStyle;
    this.#onThemeChange = onThemeChange;
    this.#setTheme(
      typeof theme === 'string' ? theme : theme[themeType],
      typeof theme === 'string' ? undefined : themeType
    );
    this.#tokenizer = highlighter.createEditorTokenizer({
      textDocument,
      theme: this.#themeName,
      tokenizeMaxLineLength,
      matchBrackets,
      __debug,
      onDeferTokenize: (lines) => onDeferTokenize(lines, this.#themeType),
    });
  }

  // By default, diffs components support dual themes, but the tokenizer only renders
  // the preferred theme. When the theme type is changed, the tokenizer will re-tokenize the document.
  #emitThemeChange(themeName: string, themeType: 'light' | 'dark') {
    if (themeName === this.#themeName && themeType === this.#themeType) {
      return;
    }
    this.#setTheme(themeName, themeType);
    this.#tokenizer.setTheme(themeName);
    // The theme CSS is now applied, so overlay pieces that captured a resolved
    // theme color (e.g. rounded selection corner masks) can recompute against
    // the new colors instead of keeping the old light/dark value.
    this.#onThemeChange?.();
  }

  // Respect an explicit host color-scheme override. When the computed value
  // advertises support for both schemes, let the OS preference choose one.
  #resolveSystemThemeType(): 'light' | 'dark' {
    try {
      if (
        typeof document !== 'undefined' &&
        typeof getComputedStyle === 'function' &&
        document.body != null
      ) {
        const colorSchemes = getComputedStyle(document.body).colorScheme.split(
          /\s+/
        );
        const supportsDark = colorSchemes.includes('dark');
        const supportsLight = colorSchemes.includes('light');
        // A single host-forced scheme wins. `light dark` only declares support
        // for both schemes, so the media query still selects the active one.
        if (supportsDark !== supportsLight) {
          return supportsDark ? 'dark' : 'light';
        }
      }
    } catch {
      // jsdom and similar harnesses may lack getComputedStyle or throw; fall
      // through to the OS media query.
    }
    return this.#mediaQueryList.matches ? 'dark' : 'light';
  }

  // Re-apply the editor's theme from the surface's current code options. Edit
  // mode reuses a single tokenizer across re-renders, so when the host swaps the
  // theme — a theme picker, a light/dark toggle, etc. — we must recompute the
  // active theme and re-tokenize. Without this the editor keeps rendering the
  // theme it captured when it first attached (stale line-highlight background
  // and token colors). System-driven changes are still handled by the
  // observers wired up in the constructor; this covers explicit `themeType`/
  // `theme` option changes that those observers don't see.
  syncTheme(codeOptions: BaseCodeOptions): void {
    const { themeType = 'system', theme = DEFAULT_THEMES } = codeOptions;
    // A single pinned theme does not follow the themeType option or system
    // scheme flips; its own classification stays authoritative.
    if (typeof theme === 'string') {
      this.#emitThemeChange(theme, this.#highlighter.getTheme(theme).type);
      return;
    }
    const nextThemeType =
      themeType === 'system' ? this.#resolveSystemThemeType() : themeType;
    this.#emitThemeChange(theme[nextThemeType], nextThemeType);
  }

  #setTheme(themeName: string, themeType?: 'light' | 'dark') {
    const theme = this.#highlighter.getTheme(themeName);
    const { colors = {} } = theme;
    const lineHighlightBackground = colors['editor.lineHighlightBackground'];
    // A usable theme background opts into the semantic active-line mix.
    // Missing backgrounds retain the resolved row color and rely on a border.
    const hasLineHighlightBackground =
      lineHighlightBackground != null &&
      lineHighlightBackground.trim() !== '' &&
      !colorUtils.isFullyTransparent(lineHighlightBackground);
    this.#setStyle(`:host {
      --diffs-editor-selection-bg: ${colors['editor.selectionBackground'] ?? 'var(--diffs-line-bg)'};
      --diffs-editor-line-highlight-border: ${colors['editor.lineHighlightBorder'] ?? (hasLineHighlightBackground ? 'transparent' : 'color-mix(in lab, var(--diffs-bg) 70%, var(--diffs-fg))')};
      --diffs-editor-active-line-source-mix: ${hasLineHighlightBackground ? '85%' : '100%'};
      --diffs-editor-match-bg: ${colors['editor.findMatchBackground'] ?? 'initial'};
      --diffs-editor-match-highlight-bg: ${colors['editor.findMatchHighlightBackground'] ?? 'initial'};
      --diffs-editor-bracket-match-bg: ${colors['editorBracketMatch.background'] ?? 'initial'};
      --diffs-editor-bracket-match-border: ${colors['editorBracketMatch.border'] ?? 'initial'};
      --diffs-editor-cursor-fg: ${colors['editorCursor.foreground'] ?? 'initial'};
      --diffs-editor-hint-fg: ${colors['editorHint.foreground'] ?? 'initial'};
      --diffs-editor-info-fg: ${colors['editorInfo.foreground'] ?? 'initial'};
      --diffs-editor-warning-fg: ${colors['editorWarning.foreground'] ?? 'initial'};
      --diffs-editor-error-fg: ${colors['editorError.foreground'] ?? 'initial'};
    }`);
    this.#themeName = themeName;
    this.#themeType = themeType ?? theme.type;
  }

  cleanUp(): void {
    this.#tokenizer.dispose();
    this.#disposes?.forEach((dispose) => dispose());
    this.#disposes = undefined;
  }

  tokenize(
    change: TextDocumentChange,
    renderRange?: RenderRange,
    hostRealignsRows = false
  ): Map<number, HighlightedToken[]> {
    return this.#tokenizer.tokenize(change, renderRange, hostRealignsRows);
  }

  getStringCommentRegexpRangesInLine(
    lineIndex: number
  ): [number, number][] | null {
    return this.#tokenizer.getStringCommentRegexpRangesInLine(lineIndex);
  }

  prebuildStateStack(renderRange?: RenderRange): void {
    this.#tokenizer.prebuildStateStack(renderRange);
  }

  stopBackgroundTokenize(): void {
    this.#tokenizer.stopBackgroundTokenize();
  }
  pauseBackgroundTokenize(): void {
    this.#tokenizer.pauseBackgroundTokenize();
  }
  resumeBackgroundTokenize(): void {
    this.#tokenizer.resumeBackgroundTokenize();
  }
}

export function renderLineTokens(
  tokens: Array<HighlightedToken>
): (HTMLElement | string)[] {
  return tokens.map(([char, fg, textContent]) => {
    if (char === 0 && fg === '') {
      return textContent === '' ? h('br') : textContent;
    }
    return h('span', {
      dataset: { char: char.toString() },
      style: `color:${fg};`,
      textContent,
    });
  });
}
