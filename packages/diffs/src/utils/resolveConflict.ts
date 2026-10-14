import type {
  ConflictResolverTypes,
  FileDiffMetadata,
  ProcessFileConflictData,
} from '../types';
import { normalizeDiffResolution } from './normalizeDiffResolution';
import { resolveRegion } from './resolveRegion';

export function resolveConflict(
  diff: FileDiffMetadata,
  conflict: ProcessFileConflictData,
  type: ConflictResolverTypes
): FileDiffMetadata {
  const resolution = normalizeDiffResolution(type);
  const indexesToDelete = new Set<number>();
  if (conflict.baseContentIndex != null) {
    indexesToDelete.add(conflict.baseContentIndex);
  }
  if (conflict.endMarkerContentIndex !== conflict.endContentIndex) {
    indexesToDelete.add(conflict.endMarkerContentIndex);
  }
  return resolveRegion(diff, {
    resolution,
    hunkIndex: conflict.hunkIndex,
    startContentIndex: conflict.startContentIndex,
    endContentIndex: conflict.endContentIndex,
    indexesToDelete,
  });
}
