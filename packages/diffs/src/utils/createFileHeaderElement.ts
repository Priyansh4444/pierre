import type { ElementContent, Element as HASTElement, Properties } from 'hast';

import {
  CUSTOM_HEADER_SLOT_ID,
  HEADER_FILENAME_SUFFIX_SLOT_ID,
  HEADER_METADATA_SLOT_ID,
  HEADER_PREFIX_SLOT_ID,
} from '../constants';
import type {
  FileContents,
  FileDiffMetadata,
  FileHeaderRenderMode,
} from '../types';
import { getIconForType } from './getIconForType';
import {
  createHastElement,
  createIconElement,
  createTextNodeElement,
} from './hast_utils';

export interface CreateFileHeaderElementProps {
  fileOrDiff: FileDiffMetadata | FileContents;
  mode: FileHeaderRenderMode;
  stickyHeader: boolean;
}

export function createFileHeaderElement({
  fileOrDiff,
  mode,
  stickyHeader,
}: CreateFileHeaderElementProps): HASTElement {
  const fileDiff = 'type' in fileOrDiff ? fileOrDiff : undefined;
  const properties: Properties = {
    'data-diffs-header': mode,
    'data-change-type': fileDiff?.type,
    'data-sticky': stickyHeader ? '' : undefined,
  };
  if (mode === 'custom') {
    return createHastElement({
      tagName: 'div',
      children: [
        createHastElement({
          tagName: 'slot',
          properties: { name: CUSTOM_HEADER_SLOT_ID },
        }),
      ],
      properties,
    });
  }

  const createNameElement = (name: string, attribute: string) =>
    createHastElement({
      tagName: 'div',
      children: [
        createHastElement({
          tagName: 'bdi',
          children: [createTextNodeElement(name)],
        }),
      ],
      properties: { [attribute]: '' },
    });
  const iconType = fileDiff?.type ?? 'file';
  const prevName = 'prevName' in fileOrDiff ? fileOrDiff.prevName : undefined;
  const headerChildren: ElementContent[] = [
    createHastElement({
      tagName: 'slot',
      properties: { name: HEADER_PREFIX_SLOT_ID },
    }),
    createIconElement({
      name: getIconForType(iconType),
      properties: { 'data-change-icon': iconType },
    }),
  ];
  if (prevName != null) {
    headerChildren.push(
      createNameElement(prevName, 'data-prev-name'),
      createIconElement({
        name: 'diffs-icon-arrow-right-short',
        properties: { 'data-rename-icon': '' },
      })
    );
  }
  headerChildren.push(
    createNameElement(fileOrDiff.name, 'data-title'),
    createHastElement({
      tagName: 'slot',
      properties: { name: HEADER_FILENAME_SUFFIX_SLOT_ID },
    })
  );

  const metadataChildren: ElementContent[] = [];
  if (fileDiff != null) {
    let additions = 0;
    let deletions = 0;
    for (const hunk of fileDiff.hunks) {
      additions += hunk.additionLines;
      deletions += hunk.deletionLines;
    }
    if (deletions > 0 || additions === 0) {
      metadataChildren.push(
        createHastElement({
          tagName: 'span',
          children: [createTextNodeElement(`-${deletions}`)],
          properties: { 'data-deletions-count': '' },
        })
      );
    }
    if (additions > 0 || deletions === 0) {
      metadataChildren.push(
        createHastElement({
          tagName: 'span',
          children: [createTextNodeElement(`+${additions}`)],
          properties: { 'data-additions-count': '' },
        })
      );
    }
  }
  metadataChildren.push(
    createHastElement({
      tagName: 'slot',
      properties: { name: HEADER_METADATA_SLOT_ID },
    })
  );

  return createHastElement({
    tagName: 'div',
    children: [
      createHastElement({
        tagName: 'div',
        children: headerChildren,
        properties: { 'data-header-content': '' },
      }),
      createHastElement({
        tagName: 'div',
        children: metadataChildren,
        properties: { 'data-metadata': '' },
      }),
    ],
    properties,
  });
}
