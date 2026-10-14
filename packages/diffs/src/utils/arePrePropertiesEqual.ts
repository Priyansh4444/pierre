import type { CustomPreProperties, PrePropertiesConfig } from '../types';

const EMPTY_CUSTOM_PROPERTIES: CustomPreProperties = {};

export function arePrePropertiesEqual(
  propsA: PrePropertiesConfig | undefined,
  propsB: PrePropertiesConfig | undefined
): boolean {
  if (propsA == null || propsB == null) {
    return propsA === propsB;
  }
  const { customProperties: customA = EMPTY_CUSTOM_PROPERTIES } = propsA;
  const { customProperties: customB = EMPTY_CUSTOM_PROPERTIES } = propsB;
  if (customA !== customB) {
    const keysA = Object.keys(customA);
    if (
      keysA.length !== Object.keys(customB).length ||
      keysA.some((key) => customA[key] !== customB[key])
    ) {
      return false;
    }
  }
  return (
    propsA.type === propsB.type &&
    propsA.diffIndicators === propsB.diffIndicators &&
    propsA.disableBackground === propsB.disableBackground &&
    propsA.disableLineNumbers === propsB.disableLineNumbers &&
    propsA.overflow === propsB.overflow &&
    propsA.split === propsB.split &&
    propsA.totalLines === propsB.totalLines
  );
}
