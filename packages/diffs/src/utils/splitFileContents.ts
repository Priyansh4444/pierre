import { SPLIT_WITH_NEWLINES } from '../constants';

// Splits file contents into lines using the same logic as diff parsing,
// keeping the trailing newline on each line.
export function splitFileContents(contents: string): string[] {
  return contents !== '' ? contents.split(SPLIT_WITH_NEWLINES) : [];
}
