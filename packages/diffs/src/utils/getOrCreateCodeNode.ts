interface CreateCodeNodeProps {
  pre?: HTMLPreElement;
  code?: HTMLElement;
  columnType?: 'additions' | 'deletions' | 'unified';
  rowSpan?: number;
  containerSize?: boolean;
}

export function getOrCreateCodeNode({
  code,
  pre,
  columnType,
  rowSpan,
  containerSize = false,
}: CreateCodeNodeProps = {}): HTMLElement {
  if (code == null) {
    code = document.createElement('code');
    code.setAttribute('data-code', '');
    if (columnType != null) {
      code.setAttribute(`data-${columnType}`, '');
    }
    pre?.appendChild(code);
  }
  if (rowSpan != null) {
    code.style.setProperty('grid-row', `span ${rowSpan}`);
  } else {
    code.style.removeProperty('grid-row');
  }
  code.toggleAttribute('data-container-size', containerSize);
  return code;
}
