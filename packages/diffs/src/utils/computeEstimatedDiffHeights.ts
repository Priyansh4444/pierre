import type {
  FileDiffMetadata,
  HunkExpansionRegion,
  HunkSeparators,
  VirtualFileMetrics,
} from '../types';
import {
  getVirtualFileHeaderRegion,
  getVirtualFilePaddingBottom,
} from './computeVirtualFileMetrics';
import {
  getExpandedRegion,
  getLeadingHunkSeparatorLayout,
  getTrailingExpandedRegion,
  getTrailingHunkSeparatorLayout,
} from './virtualDiffLayout';

export interface ComputeEstimatedDiffHeightsOptions {
  fileDiff: FileDiffMetadata;
  metrics: VirtualFileMetrics;
  disableFileHeader: boolean;
  hunkSeparators: HunkSeparators;
  expandUnchanged: boolean;
  expandedHunks: Map<number, HunkExpansionRegion> | true | undefined;
  collapsedContextThreshold: number;
  canHydratePartialDiff: boolean;
}

export interface EstimatedDiffHeights {
  splitHeight: number;
  unifiedHeight: number;
}

// Computes both split and unified baseline heights from hunk-level metadata so
// callers can avoid replaying the detailed rendered-line iterator.
export function computeEstimatedDiffHeights({
  fileDiff,
  metrics,
  disableFileHeader,
  hunkSeparators,
  expandUnchanged,
  expandedHunks: configuredExpandedHunks,
  collapsedContextThreshold,
  canHydratePartialDiff,
}: ComputeEstimatedDiffHeightsOptions): EstimatedDiffHeights {
  let splitHeight = getVirtualFileHeaderRegion(metrics, disableFileHeader);
  let unifiedHeight = splitHeight;
  const expandedHunks = expandUnchanged ? true : configuredExpandedHunks;
  const { lineHeight } = metrics;

  for (let hunkIndex = 0; hunkIndex < fileDiff.hunks.length; hunkIndex++) {
    const hunk = fileDiff.hunks[hunkIndex];
    const leadingRegion = getExpandedRegion({
      isPartial: fileDiff.isPartial,
      rangeSize: hunk.collapsedBefore,
      expandedHunks,
      hunkIndex,
      collapsedContextThreshold,
    });
    const leadingExpandedHeight =
      (leadingRegion.fromStart + leadingRegion.fromEnd) * lineHeight;
    splitHeight += leadingExpandedHeight;
    unifiedHeight += leadingExpandedHeight;

    if (leadingRegion.collapsedLines > 0) {
      const separatorHeight =
        getLeadingHunkSeparatorLayout({
          type: hunkSeparators,
          metrics,
          hunkIndex,
          hunkSpecs: hunk.hunkSpecs,
        })?.totalHeight ?? 0;
      splitHeight += separatorHeight;
      unifiedHeight += separatorHeight;
    }

    splitHeight += hunk.splitLineCount * lineHeight;
    unifiedHeight += hunk.unifiedLineCount * lineHeight;

    // "No newline at end of file" metadata rows after the hunk's last content.
    if (hunk.noEOFCRAdditions || hunk.noEOFCRDeletions) {
      const lastContent = hunk.hunkContent.at(-1);
      if (lastContent?.type === 'context') {
        const metadataRows = lastContent.lines > 0 ? 1 : 0;
        splitHeight += metadataRows * lineHeight;
        unifiedHeight += metadataRows * lineHeight;
      } else if (lastContent != null) {
        const hasDeletionMetadata =
          lastContent.deletions > 0 && hunk.noEOFCRDeletions;
        const hasAdditionMetadata =
          lastContent.additions > 0 && hunk.noEOFCRAdditions;
        splitHeight +=
          (hasDeletionMetadata || hasAdditionMetadata ? 1 : 0) * lineHeight;
        unifiedHeight +=
          ((hasDeletionMetadata ? 1 : 0) + (hasAdditionMetadata ? 1 : 0)) *
          lineHeight;
      }
    }
  }

  const finalHunkIndex = fileDiff.hunks.length - 1;
  if (finalHunkIndex >= 0) {
    const trailingRegion = getTrailingExpandedRegion({
      fileDiff,
      hunkIndex: finalHunkIndex,
      expandedHunks,
      collapsedContextThreshold,
      errorPrefix: 'computeEstimatedDiffHeights',
    });
    if (trailingRegion != null) {
      const trailingExpandedHeight =
        (trailingRegion.fromStart + trailingRegion.fromEnd) * lineHeight;
      splitHeight += trailingExpandedHeight;
      unifiedHeight += trailingExpandedHeight;
    }
    if (
      trailingRegion != null
        ? trailingRegion.collapsedLines > 0
        : fileDiff.isPartial && canHydratePartialDiff
    ) {
      const separatorHeight =
        getTrailingHunkSeparatorLayout({ type: hunkSeparators, metrics })
          ?.totalHeight ?? 0;
      splitHeight += separatorHeight;
      unifiedHeight += separatorHeight;
    }

    const paddingBottom = getVirtualFilePaddingBottom(metrics);
    splitHeight += paddingBottom;
    unifiedHeight += paddingBottom;
  }

  return { splitHeight, unifiedHeight };
}
