import type { ElementContent, Root, RootContent } from 'hast';

export function getLineNodes(nodes: Root): ElementContent[] {
  let firstChild: RootContent | Element | Root | null = nodes.children[0];
  while (firstChild != null) {
    if (firstChild.type === 'element' && firstChild.tagName === 'code') {
      return firstChild.children;
    }
    firstChild = 'children' in firstChild ? firstChild.children[0] : null;
  }
  console.error(nodes);
  throw new Error('getLineNodes: Unable to find children');
}
