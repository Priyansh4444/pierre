import type { ElementContent, Element as HASTElement } from 'hast';

import { createHastElement } from './hast_utils';

const NO_TOKEN: unique symbol = Symbol('no-token');
const MULTIPLE_TOKENS: unique symbol = Symbol('multiple-tokens');

type TokenFragmentState = number | typeof NO_TOKEN | typeof MULTIPLE_TOKENS;

// Walk a rendered line and add a single outer token wrapper around all
// fragments that still belong to the same original syntax token.
export function wrapTokenFragments(container: HASTElement): TokenFragmentState {
  const ownTokenChar = container.properties['data-char'];
  if (typeof ownTokenChar === 'number') {
    return ownTokenChar;
  }

  let containerTokenState: TokenFragmentState = NO_TOKEN;
  const wrappedChildren: ElementContent[] = [];
  let currentTokenChildren: ElementContent[] = [];
  let currentTokenChar: number | undefined;

  const flushTokenChildren = () => {
    if (currentTokenChar != null) {
      if (currentTokenChildren.length === 1) {
        const child = currentTokenChildren[0];
        if (child.type === 'element') {
          child.properties['data-char'] = currentTokenChar;
          for (const grandChild of child.children) {
            stripTokenChar(grandChild);
          }
        }
        wrappedChildren.push(child);
      } else {
        for (const child of currentTokenChildren) {
          stripTokenChar(child);
        }
        wrappedChildren.push(
          createHastElement({
            tagName: 'span',
            properties: { 'data-char': currentTokenChar },
            children: currentTokenChildren,
          })
        );
      }
    }
    currentTokenChildren = [];
    currentTokenChar = undefined;
  };

  for (const child of container.children) {
    const childTokenState: TokenFragmentState =
      child.type === 'element' ? wrapTokenFragments(child) : NO_TOKEN;
    if (childTokenState !== NO_TOKEN) {
      containerTokenState =
        containerTokenState === NO_TOKEN ||
        containerTokenState === childTokenState
          ? childTokenState
          : MULTIPLE_TOKENS;
    }

    if (typeof childTokenState !== 'number') {
      flushTokenChildren();
      wrappedChildren.push(child);
      continue;
    }

    if (currentTokenChar != null && currentTokenChar !== childTokenState) {
      flushTokenChildren();
    }

    currentTokenChar ??= childTokenState;
    currentTokenChildren.push(child);
  }

  flushTokenChildren();
  container.children = wrappedChildren;
  return containerTokenState;
}

function stripTokenChar(node: ElementContent): void {
  if (node.type !== 'element') return;
  node.properties['data-char'] = undefined;
  for (const child of node.children) {
    stripTokenChar(child);
  }
}
