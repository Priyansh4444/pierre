import type { TextDocument } from './textDocument';
import type { EditorTokenizer } from './tokenizer';
import type { Position, Range } from './types';

const OPEN_BRACKETS = new Map([
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
]);

const CLOSE_BRACKETS = new Map(
  [...OPEN_BRACKETS].map(([open, close]) => [close, open])
);

const MAX_BRACKET_SCAN_LINES = 1_000;
const MAX_BRACKET_SCAN_CHARACTERS = 50_000;

interface BracketPosition extends Position {
  char: string;
}

export function findBracketMatchRanges(
  textDocument: TextDocument,
  tokenizer: EditorTokenizer,
  position: Position
): [open: Range, close: Range] | undefined {
  const { line, character } = textDocument.normalizePosition(position);
  // Prefer the bracket before the caret. Adjacency is line-local: column-zero
  // carets are not visually next to the previous line's last character.
  const bracket =
    (character > 0
      ? getBracketAt(textDocument, tokenizer, line, character - 1)
      : undefined) ?? getBracketAt(textDocument, tokenizer, line, character);
  if (bracket === undefined) {
    return undefined;
  }

  const closingBracket = OPEN_BRACKETS.get(bracket.char);
  const openingBracket = CLOSE_BRACKETS.get(bracket.char);
  if (closingBracket !== undefined) {
    return createBracketMatchRanges(
      bracket,
      findPartnerBracket(textDocument, tokenizer, bracket, closingBracket, 1)
    );
  }
  if (openingBracket !== undefined) {
    return createBracketMatchRanges(
      findPartnerBracket(textDocument, tokenizer, bracket, openingBracket, -1),
      bracket
    );
  }
  return undefined;
}

// Returns the bracket at a position unless it sits inside a string, comment, or
// regexp. Ignored ranges are only read once a bracket is found.
function getBracketAt(
  textDocument: TextDocument,
  tokenizer: EditorTokenizer,
  line: number,
  character: number
): BracketPosition | undefined {
  const char = textDocument.getLineText(line)[character];
  if (
    char === undefined ||
    (!OPEN_BRACKETS.has(char) && !CLOSE_BRACKETS.has(char))
  ) {
    return undefined;
  }
  const ranges = tokenizer.getStringCommentRegexpRangesInLine(line);
  if (ranges !== null) {
    for (const [start, end] of ranges) {
      if (character < start) {
        break;
      }
      if (character < end) {
        return undefined;
      }
    }
  }
  return { line, character, char };
}

// Scans from `bracket` in `step` direction for its partner, skipping strings,
// comments, and regexps. Gives up past the scan limits.
function findPartnerBracket(
  textDocument: TextDocument,
  tokenizer: EditorTokenizer,
  bracket: BracketPosition,
  partner: string,
  step: 1 | -1
): BracketPosition | undefined {
  let depth = 0;
  let scannedLines = 0;
  let scannedCharacters = 0;
  for (
    let line = bracket.line;
    line >= 0 && line < textDocument.lineCount;
    line += step
  ) {
    if (scannedLines >= MAX_BRACKET_SCAN_LINES) {
      return undefined;
    }
    scannedLines++;
    const lineText = textDocument.getLineText(line);
    // Ignored ranges are sorted, so one cursor walks them with the scan.
    const ignoredRanges = tokenizer.getStringCommentRegexpRangesInLine(line);
    let rangeIndex =
      step > 0 || ignoredRanges === null ? 0 : ignoredRanges.length - 1;
    let character = bracket.character;
    if (line !== bracket.line) {
      character = step > 0 ? 0 : lineText.length - 1;
    }
    for (; character >= 0 && character < lineText.length; character += step) {
      if (scannedCharacters >= MAX_BRACKET_SCAN_CHARACTERS) {
        return undefined;
      }
      scannedCharacters++;
      if (ignoredRanges !== null) {
        if (step > 0) {
          while (
            rangeIndex < ignoredRanges.length &&
            character >= ignoredRanges[rangeIndex][1]
          ) {
            rangeIndex++;
          }
        } else {
          while (rangeIndex >= 0 && character < ignoredRanges[rangeIndex][0]) {
            rangeIndex--;
          }
        }
        const range = ignoredRanges[rangeIndex];
        if (
          range !== undefined &&
          character >= range[0] &&
          character < range[1]
        ) {
          continue;
        }
      }
      const char = lineText[character];
      if (char === bracket.char) {
        depth++;
      } else if (char === partner) {
        depth--;
        if (depth === 0) {
          return { line, character, char };
        }
      }
    }
  }
  return undefined;
}

function createBracketMatchRanges(
  firstPosition: Position | undefined,
  secondPosition: Position | undefined
): [open: Range, close: Range] | undefined {
  if (firstPosition === undefined || secondPosition === undefined) {
    return;
  }
  return [
    createCharacterRange(firstPosition),
    createCharacterRange(secondPosition),
  ];
}

function createCharacterRange({ line, character }: Position): Range {
  return {
    start: { line, character },
    end: { line, character: character + 1 },
  };
}
