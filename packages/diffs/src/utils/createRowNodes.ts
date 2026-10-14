export function createRowNodes(line: number): {
  row: HTMLElement;
  content: HTMLElement;
} {
  const row = document.createElement('div');
  row.dataset.line = `${line}`;

  const lineColumn = document.createElement('div');
  lineColumn.dataset.columnNumber = '';
  lineColumn.textContent = `${line}`;

  const content = document.createElement('div');
  content.dataset.columnContent = '';

  row.append(lineColumn, content);
  return { row, content };
}
