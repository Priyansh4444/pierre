import type { Element as HASTElement } from 'hast';

import { DEFAULT_RENDER_RANGE, DEFAULT_THEMES } from '../constants';
import type {
  DiffLineAnnotation,
  FileDiffMetadata,
  MergeConflictMarkerRow,
  RenderRange,
} from '../types';
import { getMergeConflictActionSlotName } from '../utils/getMergeConflictActionSlotName';
import {
  createGutterGap,
  createHastElement,
  createTextNodeElement,
} from '../utils/hast_utils';
import {
  getMergeConflictActionAnchor,
  type MergeConflictDiffAction,
} from '../utils/parseMergeConflictDiffFromFile';
import type { WorkerPoolManager } from '../worker';
import {
  DiffHunksRenderer,
  type DiffHunksRendererOptions,
  type DiffHunksRendererOptionsWithDefaults,
  type HunksRenderResult,
  type InjectedRow,
  type LineDecoration,
  type RenderedLineContext,
  type SplitLineDecorationProps,
  type UnifiedInjectedRowPlacement,
  type UnifiedLineDecorationProps,
} from './DiffHunksRenderer';

interface MergeConflictActionRowData {
  hunkIndex: number;
  lineIndex: number;
  conflictIndex: number;
}

interface MergeConflictMarkerInjectedRow extends MergeConflictMarkerRow {
  type: Extract<
    MergeConflictMarkerRow['type'],
    'marker-start' | 'marker-base' | 'marker-separator' | 'marker-end'
  >;
  lineText: string;
  lineIndex: number;
}

// NOTE(amadeus): Don't love this, should probably rework into an
// interface/extender
type MergeConflictInjectedRowData =
  | ({ type: 'actions' } & MergeConflictActionRowData)
  | MergeConflictMarkerInjectedRow;

interface BaseUnresolvedOptionsWithDefaults extends DiffHunksRendererOptionsWithDefaults {
  mergeConflictActionsType: MergeConflictActionsType;
}

type MergeConflictActionsType = 'none' | 'default' | 'custom';

export interface UnresolvedFileHunksRendererOptions extends DiffHunksRendererOptions {
  mergeConflictActionsType?: MergeConflictActionsType;
}

export class UnresolvedFileHunksRenderer<
  LAnnotation = undefined,
> extends DiffHunksRenderer<LAnnotation> {
  private pendingConflictActions: (MergeConflictDiffAction | undefined)[] = [];
  private pendingMarkerRows: MergeConflictMarkerRow[] = [];
  private injectedRows = new Map<string, MergeConflictInjectedRowData[]>();
  public override options: UnresolvedFileHunksRendererOptions;

  constructor(
    options: UnresolvedFileHunksRendererOptions = {
      theme: DEFAULT_THEMES,
    },
    annotationSlotName?: (
      annotation: DiffLineAnnotation<LAnnotation>
    ) => string,
    onRenderUpdate?: () => unknown,
    workerManager?: WorkerPoolManager | undefined
  ) {
    super(undefined, annotationSlotName, onRenderUpdate, workerManager);
    this.options = options;
  }

  // SELF_REVIEW: I don't love how this is hooked up with `renderDiff` right
  // now, so we definitely need to figure out what the fuck we are gonna do
  // about it...
  // I think at the very least we should keep it like annotations, and just
  // sorta assume there's a disconnect there
  public setConflictState(
    conflictActions: (MergeConflictDiffAction | undefined)[],
    markerRows: MergeConflictMarkerRow[],
    diff: FileDiffMetadata
  ): void {
    this.pendingConflictActions = conflictActions;
    this.pendingMarkerRows = markerRows;
    this.syncInjectedRows(diff);
  }

  private syncInjectedRows(diff: FileDiffMetadata): void {
    this.injectedRows.clear();
    for (const action of this.pendingConflictActions) {
      const anchor =
        action != null ? getMergeConflictActionAnchor(action, diff) : undefined;
      if (action != null && anchor != null) {
        this.addInjectedRow({
          type: 'actions',
          hunkIndex: anchor.hunkIndex,
          lineIndex: anchor.lineIndex,
          conflictIndex: action.conflictIndex,
        });
      }
    }

    for (const row of this.pendingMarkerRows) {
      this.addInjectedRow(row);
    }
  }

  private addInjectedRow(row: MergeConflictInjectedRowData): void {
    const key = `${row.hunkIndex}:${row.lineIndex}`;
    const rows = this.injectedRows.get(key);
    if (rows == null) {
      this.injectedRows.set(key, [row]);
    } else {
      rows.push(row);
    }
  }

  public override renderDiff(
    diff?: FileDiffMetadata | undefined,
    renderRange: RenderRange = DEFAULT_RENDER_RANGE
  ): HunksRenderResult | undefined {
    if (diff != null) {
      this.syncInjectedRows(diff);
    }
    return super.renderDiff(diff, renderRange);
  }

  public override async asyncRender(
    diff: FileDiffMetadata,
    renderRange: RenderRange = DEFAULT_RENDER_RANGE
  ): Promise<HunksRenderResult> {
    this.syncInjectedRows(diff);
    return super.asyncRender(diff, renderRange);
  }

  protected override createPreElement(
    split: boolean,
    totalLines: number
  ): HASTElement {
    return super.createPreElement(split, totalLines, {
      'data-has-merge-conflict': '',
    });
  }

  protected override getUnifiedLineDecoration({
    type,
    lineType,
  }: UnifiedLineDecorationProps): LineDecoration {
    return type === 'change'
      ? getMergeConflictChangeDecoration(
          lineType === 'change-deletion' ? 'current' : 'incoming'
        )
      : { gutterLineType: lineType };
  }

  protected override getSplitLineDecoration({
    side,
    type,
  }: SplitLineDecorationProps): LineDecoration {
    return type === 'change'
      ? getMergeConflictChangeDecoration(
          side === 'deletions' ? 'current' : 'incoming'
        )
      : { gutterLineType: type };
  }

  protected override getUnifiedInjectedRowsForLine = (
    ctx: RenderedLineContext
  ): UnifiedInjectedRowPlacement | undefined => {
    const rows = this.injectedRows.get(`${ctx.hunkIndex}:${ctx.lineIndex}`);
    if (rows == null) {
      return undefined;
    }
    const { mergeConflictActionsType } = this.getOptionsWithDefaults();
    const before: InjectedRow[] = [];
    const after: InjectedRow[] = [];
    for (const row of rows) {
      if (row.type === 'actions') {
        const actions: HASTElement[] = [];
        if (mergeConflictActionsType === 'default') {
          for (const [resolution, label] of MERGE_CONFLICT_ACTIONS) {
            if (actions.length > 0) {
              actions.push(
                createHastElement({
                  tagName: 'span',
                  properties: { 'data-merge-conflict-action-separator': '' },
                  children: [createTextNodeElement('|')],
                })
              );
            }
            actions.push(
              createHastElement({
                tagName: 'button',
                properties: {
                  type: 'button',
                  'data-merge-conflict-action': resolution,
                  'data-merge-conflict-conflict-index': `${row.conflictIndex}`,
                },
                children: [createTextNodeElement(label)],
              })
            );
          }
        }
        actions.push(
          createHastElement({
            tagName: 'slot',
            properties: {
              name: getMergeConflictActionSlotName(row),
              'data-merge-conflict-action-slot': '',
            },
          })
        );
        before.push({
          content: createHastElement({
            tagName: 'div',
            properties: { 'data-merge-conflict-actions': '' },
            children: [
              createHastElement({
                tagName: 'div',
                properties: { 'data-merge-conflict-actions-content': '' },
                children: actions,
              }),
            ],
          }),
          gutter: createMergeConflictGutterGap('action'),
        });
        continue;
      }
      (row.type === 'marker-end' ? after : before).push({
        content: createHastElement({
          tagName: 'div',
          properties: {
            'data-merge-conflict': row.type,
            'data-merge-conflict-marker-row': '',
          },
          children: [
            createTextNodeElement(row.lineText.replace(/(?:\r\n|\n|\r)$/, '')),
          ],
        }),
        gutter: createMergeConflictGutterGap(row.type),
      });
    }
    return {
      before: before.length > 0 ? before : undefined,
      after: after.length > 0 ? after : undefined,
    };
  };

  protected override getOptionsWithDefaults(): BaseUnresolvedOptionsWithDefaults {
    const options = super.getOptionsWithDefaults();
    options.diffStyle = 'unified';
    options.lineDiffType = 'none';
    // NOTE(amadeus): Aint nobody got time for a spread
    (options as BaseUnresolvedOptionsWithDefaults).mergeConflictActionsType =
      this.options.mergeConflictActionsType ?? 'default';
    return options as BaseUnresolvedOptionsWithDefaults;
  }
}

const MERGE_CONFLICT_ACTIONS = [
  ['current', 'Accept current change'],
  ['incoming', 'Accept incoming change'],
  ['both', 'Accept both'],
] as const;

// Conflict sides render as context lines tagged with the side they came from.
function getMergeConflictChangeDecoration(
  mergeConflict: 'current' | 'incoming'
): LineDecoration {
  return {
    gutterLineType: 'context',
    gutterProperties: { 'data-merge-conflict': mergeConflict },
    contentProperties: {
      'data-line-type': 'context',
      'data-merge-conflict': mergeConflict,
    },
  };
}

function createMergeConflictGutterGap(kind: string): HASTElement {
  const gap = createGutterGap(undefined, 'annotation', 1);
  gap.properties['data-gutter-buffer'] = `merge-conflict-${kind}`;
  return gap;
}
