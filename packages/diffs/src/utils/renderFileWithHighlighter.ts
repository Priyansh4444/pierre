import type {
  DiffsHighlighter,
  FileContents,
  ForceFilePlainTextOptions,
  RenderFileOptions,
  SharedRenderState,
  ThemedFileResult,
} from '../types';
import { appendItems } from './appendItems';
import { linesFromFileContents } from './computeFileOffsets';
import { getFiletypeFromFileName } from './getFiletypeFromFileName';
import { getHighlighterThemeStyles } from './getHighlighterThemeStyles';
import { getTokenOptions } from './getTokenOptions';
import { renderTokenLines } from './renderTokenLines';

export function renderFileWithHighlighter(
  file: FileContents,
  highlighter: DiffsHighlighter,
  { theme, tokenizeMaxLineLength, useTokenTransformer }: RenderFileOptions,
  {
    forcePlainText,
    lazyLineAST = false,
    startingLine,
    totalLines,
    lines,
  }: ForceFilePlainTextOptions = { forcePlainText: false }
): ThemedFileResult {
  if (forcePlainText) {
    startingLine ??= 0;
    totalLines ??= Infinity;
  } else {
    // Tokenization must include preceding lines to preserve lexical state.
    startingLine = 0;
    totalLines = Infinity;
  }
  const isWindowedHighlight = startingLine > 0 || totalLines < Infinity;
  const lang = forcePlainText
    ? 'text'
    : (file.lang ?? getFiletypeFromFileName(file.name));
  const baseThemeType =
    typeof theme === 'string' ? highlighter.getTheme(theme).type : undefined;
  const themeStyles = getHighlighterThemeStyles({
    theme,
    highlighter,
  });
  const state: SharedRenderState = {
    lineInfo: (shikiLineNumber: number) => ({
      type: 'context',
      lineIndex: shikiLineNumber - 1 + startingLine,
      lineNumber: shikiLineNumber + startingLine,
    }),
  };
  // Shiki does not treat a lone carriage return as a line break. Normalize only
  // the text sent to the highlighter so its output stays aligned with the file
  // model while the original document retains its line endings.
  const source = (
    isWindowedHighlight
      ? (lines ?? linesFromFileContents(file.contents))
          .slice(startingLine, startingLine + totalLines)
          .join('')
      : file.contents
  ).replace(/\r(?!\n)/g, '\n');
  const highlightedLines = renderTokenLines(
    highlighter.codeToTokens(
      source,
      getTokenOptions(lang, theme, tokenizeMaxLineLength)
    ).tokens,
    {
      state,
      useTokenTransformer,
      lazyLineAST: lazyLineAST && !forcePlainText && !useTokenTransformer,
      cacheHtmlStyles: highlighter.name === 'highlights',
    }
  );

  // Create sparse array for windowed rendering
  const code = isWindowedHighlight ? new Array(startingLine) : highlightedLines;
  if (isWindowedHighlight) {
    appendItems(code, highlightedLines);
  }

  return { code, themeStyles, baseThemeType };
}
