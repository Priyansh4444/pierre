import {
  MERGE_CONFLICT_BASE_MARKER_REGEX,
  MERGE_CONFLICT_END_MARKER_REGEX,
  MERGE_CONFLICT_SEPARATOR_MARKER_REGEX,
  MERGE_CONFLICT_START_MARKER_REGEX,
} from '../constants';

export type MergeConflictLineType =
  | 'none'
  | 'marker-start'
  | 'marker-base'
  | 'marker-separator'
  | 'marker-end'
  | 'current'
  | 'base'
  | 'incoming';

// Classifies every line of a file with conflict markers. Open conflicts are
// kept on a stack so nested markers resolve against the innermost conflict.
export function getMergeConflictLineTypes(
  lines: string[]
): MergeConflictLineType[] {
  const lineTypes = new Array<MergeConflictLineType>(lines.length);
  const stages: Array<'current' | 'base' | 'incoming'> = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/(?:\r\n|\n|\r)$/, '');
    const depth = stages.length - 1;
    if (MERGE_CONFLICT_START_MARKER_REGEX.test(line)) {
      stages.push('current');
      lineTypes[index] = 'marker-start';
    } else if (depth < 0) {
      lineTypes[index] = 'none';
    } else if (MERGE_CONFLICT_BASE_MARKER_REGEX.test(line)) {
      stages[depth] = 'base';
      lineTypes[index] = 'marker-base';
    } else if (MERGE_CONFLICT_SEPARATOR_MARKER_REGEX.test(line)) {
      stages[depth] = 'incoming';
      lineTypes[index] = 'marker-separator';
    } else if (MERGE_CONFLICT_END_MARKER_REGEX.test(line)) {
      stages.pop();
      lineTypes[index] = 'marker-end';
    } else {
      lineTypes[index] = stages[depth];
    }
  }
  return lineTypes;
}
