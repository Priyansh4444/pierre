export function createGutterUtilityContentNode(): HTMLElement {
  const gutterUtilityContent = document.createElement('div');
  gutterUtilityContent.slot = 'gutter-utility-slot';
  const { style } = gutterUtilityContent;
  style.position = 'absolute';
  style.top = '0';
  style.bottom = '0';
  style.textAlign = 'center';
  style.whiteSpace = 'normal';
  style.touchAction = 'none';
  return gutterUtilityContent;
}
