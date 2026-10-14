import type { FileDiffMetadata } from '../types';
import { getFiletypeFromFileName } from './getFiletypeFromFileName';

export function isDiffPlainText(diff: FileDiffMetadata): boolean {
  if (diff.lang != null) {
    return diff.lang === 'text';
  }
  return (
    getFiletypeFromFileName(diff.name) === 'text' &&
    (diff.prevName == null || getFiletypeFromFileName(diff.prevName) === 'text')
  );
}
