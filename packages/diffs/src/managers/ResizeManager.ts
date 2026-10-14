import type { ObservedAnnotationNodes, ObservedGridNodes } from '../types';

interface CodeColumnUpdate {
  codeInlineSize?: number;
  numberInlineSize?: number;
}

export type ResizeManagerColumnVariableMode = 'apply' | 'measure';

export interface ResizeManagerSetupOptions {
  disableAnnotations: boolean;
  columnVariables?: ResizeManagerColumnVariableMode;
}

export class ResizeManager {
  // Shared static resizeObserver that all ResizeManagers use
  private static resizeObserver: ResizeObserver | undefined;
  private static managersByElement = new Map<Element, ResizeManager>();

  private static handleSharedResizeEntries(entries: ResizeObserverEntry[]) {
    // First we need to batch all elements by manager, so callbacks are
    // properly aligned with a per-instance ResizeManager
    const entriesByManager = new Map<ResizeManager, ResizeObserverEntry[]>();
    for (const entry of entries) {
      const manager = ResizeManager.managersByElement.get(entry.target);
      if (manager == null) {
        continue;
      }
      const managerEntries = entriesByManager.get(manager);
      if (managerEntries == null) {
        entriesByManager.set(manager, [entry]);
      } else {
        managerEntries.push(entry);
      }
    }

    for (const [manager, managerEntries] of entriesByManager) {
      manager.handleResizeEntries(managerEntries);
    }
  }

  private observedNodes = new Map<
    HTMLElement,
    ObservedAnnotationNodes | ObservedGridNodes
  >();

  setup(
    pre: HTMLPreElement,
    { disableAnnotations, columnVariables = 'apply' }: ResizeManagerSetupOptions
  ): void {
    const applyColumnVariables = columnVariables === 'apply';
    let columnCount = 0;
    const observedNodes = new Map(this.observedNodes);
    this.observedNodes.clear();

    for (const codeElement of pre.children) {
      if (columnCount === 2) {
        break;
      }
      if (
        !(codeElement instanceof HTMLElement) ||
        codeElement.tagName !== 'CODE'
      ) {
        continue;
      }
      columnCount++;
      let item = observedNodes.get(codeElement);
      if (item != null && item.type !== 'code') {
        throw new Error(
          'ResizeManager.setup: somehow a code node is being used for an annotation, should be impossible'
        );
      }

      let numberElement = codeElement.firstElementChild;
      if (!(numberElement instanceof HTMLElement)) {
        numberElement = null;
      }
      if (item != null) {
        this.observedNodes.set(codeElement, item);
        observedNodes.delete(codeElement);
        if (item.numberElement !== numberElement) {
          if (item.numberElement != null) {
            this.unobserve(item.numberElement);
            observedNodes.delete(item.numberElement);
          }
          if (numberElement != null) {
            this.observe(numberElement);
            observedNodes.delete(numberElement);
            this.observedNodes.set(numberElement, item);
          }
          item.numberElement = numberElement;
          item.numberWidth = 0;
        } else if (item.numberElement != null) {
          observedNodes.delete(item.numberElement);
          this.observedNodes.set(item.numberElement, item);
          // If there is a resize, let the resize handler handle it...
        } else {
          item.numberWidth = 0;
        }
        if (item.applyColumnVariables !== applyColumnVariables) {
          item.applyColumnVariables = applyColumnVariables;
          if (applyColumnVariables) {
            applyCodeColumnVariables(item, true, true);
          } else {
            removeCodeColumnVariables(item);
          }
        }
      } else {
        item = {
          type: 'code',
          codeElement,
          numberElement,
          codeWidth: 'auto',
          numberWidth: 0,
          applyColumnVariables,
        };
        this.observedNodes.set(codeElement, item);
        this.observe(codeElement);
        if (numberElement != null) {
          this.observedNodes.set(numberElement, item);
          this.observe(numberElement);
        }
      }
    }

    if (columnCount > 1 && !disableAnnotations) {
      const elementMap = new Map<string, HTMLElement[]>();
      // Iterate through all the matched elements and organize them into pairs
      // based on the data-line-annotation attribute
      for (const element of pre.querySelectorAll(
        '[data-line-annotation*=","]'
      )) {
        if (!(element instanceof HTMLElement)) {
          continue;
        }
        const lineAnnotation =
          element.getAttribute('data-line-annotation') ?? '';
        if (!/^-?\d+,-?\d+$/.test(lineAnnotation)) {
          console.error(
            'DiffFileRenderer.setupResizeObserver: Invalid element or annotation',
            { lineAnnotation, element }
          );
          continue;
        }
        let pairs = elementMap.get(lineAnnotation);
        if (pairs == null) {
          pairs = [];
          elementMap.set(lineAnnotation, pairs);
        }
        pairs.push(element);
      }

      // Measure all annotation heights first, then apply the paired min-height
      // styles after the read phase so setup does not bounce between layout
      // reads and writes for every annotation pair.
      const annotationUpdates: ObservedAnnotationNodes[] = [];
      for (const [key, pair] of elementMap) {
        if (pair.length !== 2) {
          console.error(
            'DiffFileRenderer.setupResizeObserver: Bad Pair',
            key,
            pair
          );
          continue;
        }
        const [container1, container2] = pair;
        const child1 = container1.firstElementChild;
        const child2 = container2.firstElementChild;
        if (
          !(child1 instanceof HTMLElement) ||
          !(child2 instanceof HTMLElement)
        ) {
          continue;
        }

        const item = observedNodes.get(child1);
        if (item != null) {
          this.observedNodes.set(child1, item);
          this.observedNodes.set(child2, item);
          observedNodes.delete(child1);
          observedNodes.delete(child2);
          continue;
        }

        annotationUpdates.push({
          type: 'annotations',
          column1: {
            container: container1,
            child: child1,
            childHeight: child1.getBoundingClientRect().height,
          },
          column2: {
            container: container2,
            child: child2,
            childHeight: child2.getBoundingClientRect().height,
          },
          currentHeight: 'auto',
        });
      }

      for (const item of annotationUpdates) {
        const { column1, column2 } = item;
        this.applyNewHeight(
          item,
          Math.max(column1.childHeight, column2.childHeight)
        );
        this.observedNodes.set(column1.child, item);
        this.observedNodes.set(column2.child, item);
        this.observe(column1.child);
        this.observe(column2.child);
      }
    }

    // Cleanup any old nodes that might still be observed
    for (const [element, item] of observedNodes) {
      this.unobserve(element);
      if (item.type === 'code') {
        if (item.codeElement.isConnected) {
          removeCodeColumnVariables(item);
        }
      } else {
        for (const { container } of [item.column1, item.column2]) {
          if (container.isConnected) {
            container.style.removeProperty('--diffs-annotation-min-height');
          }
        }
      }
    }
  }

  cleanUp(): void {
    for (const element of this.observedNodes.keys()) {
      this.unobserve(element);
    }
    this.observedNodes.clear();
  }

  private observe(element: HTMLElement): void {
    const { managersByElement } = ResizeManager;
    const owner = managersByElement.get(element);
    // Already registered
    if (owner === this) {
      return;
    }
    // If we've already somehow registered with another manager, we in for a
    // world of pain, so complain loudly
    if (owner != null) {
      throw new Error(
        'ResizeManager.observe: element is already owned by another ResizeManager'
      );
    }
    managersByElement.set(element, this);
    (ResizeManager.resizeObserver ??= new ResizeObserver(
      ResizeManager.handleSharedResizeEntries
    )).observe(element);
  }

  private unobserve(element: HTMLElement): void {
    const { managersByElement, resizeObserver } = ResizeManager;
    const owner = managersByElement.get(element);
    if (owner == null) {
      return;
    }
    if (owner !== this) {
      throw new Error(
        'ResizeManager.unobserve: element is owned by another ResizeManager'
      );
    }

    managersByElement.delete(element);
    resizeObserver?.unobserve(element);
    if (resizeObserver != null && managersByElement.size === 0) {
      resizeObserver.disconnect();
      ResizeManager.resizeObserver = undefined;
    }
  }

  private handleResizeEntries(entries: ResizeObserverEntry[]) {
    const codeUpdates = new Map<ObservedGridNodes, CodeColumnUpdate>();
    const annotationUpdates = new Set<ObservedAnnotationNodes>();
    for (const entry of entries) {
      const { target } = entry;
      if (!(target instanceof HTMLElement)) {
        console.error(
          'ResizeManager.handleResizeEntries: Invalid element for ResizeObserver',
          entry
        );
        continue;
      }
      const item = this.observedNodes.get(target);
      if (item == null) {
        console.error(
          'ResizeManager.handleResizeEntries: Not a valid observed node',
          entry
        );
        continue;
      }
      if (item.type === 'annotations') {
        const column =
          target === item.column1.child
            ? item.column1
            : target === item.column2.child
              ? item.column2
              : undefined;
        if (column == null) {
          console.error(
            `ResizeManager.handleResizeEntries: Couldn't find a column for`,
            { item, target }
          );
          continue;
        }
        column.childHeight = entry.borderBoxSize[0].blockSize;
        annotationUpdates.add(item);
      } else {
        const update = codeUpdates.get(item) ?? {};
        const { inlineSize } = entry.contentBoxSize[0];
        if (target === item.codeElement) {
          update.codeInlineSize = inlineSize;
        } else if (target === item.numberElement) {
          update.numberInlineSize = inlineSize;
        }
        codeUpdates.set(item, update);
      }
    }
    for (const item of annotationUpdates) {
      this.applyNewHeight(
        item,
        Math.max(item.column1.childHeight, item.column2.childHeight)
      );
    }
    for (const [item, { codeInlineSize, numberInlineSize }] of codeUpdates) {
      let codeWidth = item.codeWidth;
      if (codeInlineSize != null) {
        const width = Math.max(Math.floor(codeInlineSize), 0);
        codeWidth = width === 0 ? 'auto' : width;
      }
      const numberWidth =
        numberInlineSize != null
          ? Math.max(Math.ceil(numberInlineSize), 0)
          : item.numberWidth;
      const codeWidthChanged = codeWidth !== item.codeWidth;
      const numberWidthChanged = numberWidth !== item.numberWidth;
      if (!codeWidthChanged && !numberWidthChanged) {
        continue;
      }
      item.codeWidth = codeWidth;
      item.numberWidth = numberWidth;
      if (item.applyColumnVariables) {
        applyCodeColumnVariables(item, codeWidthChanged, numberWidthChanged);
      }
    }
  }

  private applyNewHeight(item: ObservedAnnotationNodes, newHeight: number) {
    if (newHeight !== item.currentHeight) {
      item.currentHeight = Math.max(newHeight, 0);
      item.column1.container.style.setProperty(
        '--diffs-annotation-min-height',
        `${item.currentHeight}px`
      );
      item.column2.container.style.setProperty(
        '--diffs-annotation-min-height',
        `${item.currentHeight}px`
      );
    }
  }
}

function applyCodeColumnVariables(
  item: ObservedGridNodes,
  codeWidthChanged: boolean,
  numberWidthChanged: boolean
): void {
  const { codeElement, codeWidth, numberWidth } = item;
  if (codeWidthChanged) {
    codeElement.style.setProperty(
      '--diffs-column-width',
      typeof codeWidth === 'number' ? `${codeWidth}px` : 'auto'
    );
  }

  if (numberWidthChanged) {
    codeElement.style.setProperty(
      '--diffs-column-number-width',
      numberWidth === 0 ? 'auto' : `${numberWidth}px`
    );
  }

  if (codeWidthChanged || (numberWidthChanged && codeWidth !== 'auto')) {
    const targetWidth =
      typeof codeWidth === 'number' ? Math.max(codeWidth - numberWidth, 0) : 0;
    codeElement.style.setProperty(
      '--diffs-column-content-width',
      targetWidth > 0 ? `${targetWidth}px` : 'auto'
    );
  }
}

function removeCodeColumnVariables(item: ObservedGridNodes): void {
  item.codeElement.style.removeProperty('--diffs-column-content-width');
  item.codeElement.style.removeProperty('--diffs-column-number-width');
  item.codeElement.style.removeProperty('--diffs-column-width');
}
