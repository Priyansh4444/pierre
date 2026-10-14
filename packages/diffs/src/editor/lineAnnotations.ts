import { getLineAnnotationName } from '../utils/getLineAnnotationName';
import {
  getLineAnnotationSource,
  type LineAnnotationPosition,
  recordLineAnnotationSource,
} from '../utils/lineAnnotationIdentity';
import type { TextDocumentChange } from './textDocument';
import { getLineNumberAttr, h } from './utils';

interface LineAnnotationChange {
  readonly startLine: number;
  readonly startCharacter: number;
  readonly endLine: number;
  readonly deletesEndLine: boolean;
  readonly insertedLineBreaks: number;
  readonly lineDelta: number;
}

export function applyDocumentChangeToLineAnnotations<
  TLineAnnotation extends LineAnnotationPosition,
>(
  change: TextDocumentChange,
  lineAnnotations: TLineAnnotation[]
): TLineAnnotation[] | undefined {
  const annotationChanges = getLineAnnotationChanges(change);
  if (annotationChanges.length === 0) {
    return undefined;
  }

  const nextLineAnnotations: TLineAnnotation[] = [];
  let changed = false;
  for (const annotation of lineAnnotations) {
    if (
      ('side' in annotation && annotation.side === 'deletions') ||
      annotation.lineNumber <= 0
    ) {
      // Annotations that should not be repositioned
      nextLineAnnotations.push(annotation);
      continue;
    }

    let line: number | undefined = annotation.lineNumber - 1;
    let lineCount = change.previousLineCount;
    for (const {
      startLine,
      startCharacter,
      endLine,
      deletesEndLine,
      insertedLineBreaks,
      lineDelta,
    } of annotationChanges) {
      lineCount = Math.max(1, lineCount + lineDelta);
      if (line < startLine) {
        continue;
      }
      // Every line change has a non-zero lineDelta, so a change at or above
      // the annotation always moves or touches it.
      changed = true;
      if (
        line > endLine ||
        (endLine > startLine && line === endLine && !deletesEndLine)
      ) {
        line += lineDelta;
      } else if (startLine === endLine) {
        if (startCharacter === 0) {
          line += insertedLineBreaks;
        }
      } else if (lineDelta < 0 && (line !== startLine || startCharacter <= 0)) {
        // The annotation's line was deleted.
        line = undefined;
        break;
      } else {
        line = Math.min(
          startLine + Math.min(line - startLine, insertedLineBreaks),
          lineCount - 1
        );
      }
    }

    if (line === undefined) {
      continue;
    }
    const lineNumber = line + 1;
    if (lineNumber === annotation.lineNumber) {
      nextLineAnnotations.push(annotation);
    } else {
      const moved = { ...annotation, lineNumber };
      recordLineAnnotationSource(moved, getLineAnnotationSource(annotation));
      nextLineAnnotations.push(moved);
    }
  }

  return changed ? nextLineAnnotations : undefined;
}

function getLineAnnotationChanges(
  change: TextDocumentChange
): readonly LineAnnotationChange[] {
  if (change.changedLineChanges !== undefined) {
    return change.changedLineChanges.flatMap(
      ([
        startLine,
        changedEndLine,
        lineDelta,
        startCharacter = 0,
        _endCharacter,
        endedAtDocumentEnd = false,
      ]) => {
        if (lineDelta === 0) {
          return [];
        }
        const insertedLineBreaks = Math.max(0, changedEndLine - startLine);
        const removedLineCount = Math.max(0, insertedLineBreaks - lineDelta);
        return [
          {
            startLine,
            startCharacter,
            endLine: startLine + removedLineCount,
            deletesEndLine: lineDelta < 0 && endedAtDocumentEnd,
            insertedLineBreaks,
            lineDelta,
          },
        ];
      }
    );
  }

  if (change.lineDelta === 0) {
    return change.changedLineRanges.flatMap(([startLine, endLine]) => {
      const insertedLineBreaks = endLine - startLine;
      if (insertedLineBreaks <= 0) {
        return [];
      }
      return [
        {
          startLine,
          startCharacter: 0,
          endLine: startLine,
          deletesEndLine: false,
          insertedLineBreaks,
          lineDelta: insertedLineBreaks,
        },
      ];
    });
  }
  const removedLineCount = Math.max(0, -change.lineDelta);
  const deletedToDocumentEnd =
    change.endedAtDocumentEnd &&
    change.startLine + removedLineCount === change.previousLineCount - 1;
  return [
    {
      startLine: change.startLine,
      startCharacter: change.startCharacter,
      endLine: change.startLine + removedLineCount,
      deletesEndLine: deletedToDocumentEnd,
      insertedLineBreaks: Math.max(0, change.lineDelta),
      lineDelta: change.lineDelta,
    },
  ];
}

export function renderLineAnnotations<
  TLineAnnotation extends LineAnnotationPosition,
>(
  lineAnnotations: TLineAnnotation[],
  contentEl: HTMLElement,
  gutterEl?: HTMLElement,
  getName: (annotation: TLineAnnotation) => string = getLineAnnotationName
): void {
  const additionAnnotations = new Map<number, string[]>();
  const deletionAnnotations = new Map<number, string[]>();
  for (const annotation of lineAnnotations) {
    const lineNumber = annotation.lineNumber;
    if (!additionAnnotations.has(lineNumber)) {
      additionAnnotations.set(lineNumber, []);
    }
    if (!deletionAnnotations.has(lineNumber)) {
      deletionAnnotations.set(lineNumber, []);
    }
    const map =
      'side' in annotation && annotation.side === 'deletions'
        ? deletionAnnotations
        : additionAnnotations;
    map.get(lineNumber)!.push(getName(annotation));
  }

  const leftCodeElement = contentEl.parentElement?.previousElementSibling;
  let leftGutterElement: HTMLElement | undefined;
  let leftContentElement: HTMLElement | undefined;
  if (
    leftCodeElement instanceof HTMLElement &&
    leftCodeElement.dataset.deletions !== undefined
  ) {
    for (const child of leftCodeElement.children) {
      const el = child as HTMLElement;
      const { gutter, content } = el.dataset;
      if (gutter !== undefined) {
        leftGutterElement = el;
      } else if (content !== undefined) {
        leftContentElement = el;
      }
    }
  }

  cleanLineAnnotationElements(contentEl, gutterEl);
  if (leftContentElement !== undefined) {
    cleanLineAnnotationElements(leftContentElement, leftGutterElement);
  }

  const additionsAnnotationElements = createLineAnnotationElements(
    additionAnnotations,
    contentEl,
    gutterEl
  );
  if (leftContentElement === undefined) {
    return;
  }

  const deletionsAnnotationElements = createLineAnnotationElements(
    deletionAnnotations,
    leftContentElement,
    leftGutterElement
  );

  requestAnimationFrame(() => {
    // An empty side takes the content height of its paired annotation on the
    // other side so both rows stay aligned.
    const offsetHeights = new Map<number, number>();
    for (const [annotations, pairedElements] of [
      [additionAnnotations, deletionsAnnotationElements],
      [deletionAnnotations, additionsAnnotationElements],
    ] as const) {
      for (const [lineNumber, names] of annotations) {
        if (names.length > 0) {
          continue;
        }
        const content = pairedElements.get(lineNumber)?.firstElementChild;
        const height =
          content instanceof HTMLElement
            ? content.getBoundingClientRect().height
            : 0;
        if (height > 0) {
          offsetHeights.set(lineNumber, height);
        }
      }
    }
    applyLineAnnotationMinHeights(
      additionAnnotations,
      additionsAnnotationElements,
      offsetHeights
    );
    applyLineAnnotationMinHeights(
      deletionAnnotations,
      deletionsAnnotationElements,
      offsetHeights
    );
  });
}

function cleanLineAnnotationElements(
  contentEl: HTMLElement,
  gutterEl?: HTMLElement
): void {
  const staleElements: HTMLElement[] = [];
  for (let i = 1; i < contentEl.childElementCount; i++) {
    const el = contentEl.children[i] as HTMLElement;
    if (el.dataset.lineAnnotation !== undefined) {
      staleElements.push(el);
      if (gutterEl !== undefined) {
        staleElements.push(gutterEl.children[i] as HTMLElement);
      }
    }
  }
  for (const el of staleElements) {
    el.remove();
  }
}

function createLineAnnotationElements(
  lineAnnotations: Map<number, string[]>,
  contentEl: HTMLElement,
  gutterEl?: HTMLElement
): Map<number, HTMLElement> {
  const annotationElements = new Map<number, HTMLElement>();
  for (const el of contentEl.children) {
    const lineNumber = getLineNumberAttr(el as HTMLElement);
    if (lineNumber !== undefined) {
      const annotations = lineAnnotations.get(lineNumber);
      if (annotations !== undefined) {
        const annotationElement = h('div', {
          dataset: { lineAnnotation: '0,' + (lineNumber - 1) },
          children: [
            h('div', {
              dataset: 'annotationContent',
              children: annotations.map((name) => h('slot', { name })),
            }),
          ],
        });
        el.after(annotationElement);
        annotationElements.set(lineNumber, annotationElement);
      }
    }
  }

  if (gutterEl !== undefined) {
    for (const el of gutterEl.children) {
      const lineNumber = getLineNumberAttr(el as HTMLElement, 'columnNumber');
      if (lineNumber !== undefined && lineAnnotations.has(lineNumber)) {
        el.after(
          h('div', {
            dataset: { gutterBuffer: 'annotation', bufferSize: '1' },
            style: { gridRow: 'span 1' },
          })
        );
      }
    }
  }

  return annotationElements;
}

function applyLineAnnotationMinHeights(
  lineAnnotations: Map<number, string[]>,
  annotationElements: Map<number, HTMLElement>,
  offsetHeights: Map<number, number>
): void {
  for (const [lineNumber, annotationElement] of annotationElements) {
    const annotations = lineAnnotations.get(lineNumber);
    const offsetHeight = offsetHeights.get(lineNumber);
    if (annotations?.length === 0 && offsetHeight !== undefined) {
      annotationElement.style.setProperty(
        '--diffs-annotation-min-height',
        `${offsetHeight}px`
      );
    }
  }
}
