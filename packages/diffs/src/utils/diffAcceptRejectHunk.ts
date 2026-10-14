import type {
  DiffAcceptRejectHunkConfig,
  DiffAcceptRejectHunkType,
  FileDiffMetadata,
} from '../types';
import { normalizeDiffResolution } from './normalizeDiffResolution';
import { resolveRegion } from './resolveRegion';

type DiffAcceptRejectHunkOptions =
  | DiffAcceptRejectHunkType
  | DiffAcceptRejectHunkConfig;

export function diffAcceptRejectHunk(
  diff: FileDiffMetadata,
  hunkIndex: number,
  options: DiffAcceptRejectHunkOptions
): FileDiffMetadata {
  const hunk = diff.hunks[hunkIndex];
  if (hunk == null) {
    console.error({ hunkIndex, diff });
    throw new Error('diffAcceptRejectHunk: Invalid hunk index');
  }

  const isConfig = typeof options === 'object';
  return resolveRegion(diff, {
    resolution: normalizeDiffResolution(options),
    hunkIndex,
    startContentIndex: isConfig ? options.changeIndex : 0,
    endContentIndex: isConfig
      ? options.changeIndex
      : Math.max(0, hunk.hunkContent.length - 1),
  });
}
