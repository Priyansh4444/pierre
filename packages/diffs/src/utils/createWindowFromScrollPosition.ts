import type { VirtualWindowSpecs } from '../types';

interface WindowFromScrollPositionProps {
  scrollTop: number;
  height: number;
  scrollHeight: number;
  fitPerfectly?: boolean;
  fitPerfectlyOverscroll?: number;
  overscrollSize: number;
}

export function createWindowFromScrollPosition({
  scrollTop,
  scrollHeight,
  height,
  fitPerfectly = false,
  fitPerfectlyOverscroll = 0,
  overscrollSize,
}: WindowFromScrollPositionProps): VirtualWindowSpecs {
  const windowHeight = height + overscrollSize * 2;
  const effectiveHeight = fitPerfectly
    ? height + fitPerfectlyOverscroll * 2
    : windowHeight;
  scrollHeight = Math.max(scrollHeight, effectiveHeight);

  if (windowHeight >= scrollHeight || fitPerfectly) {
    const top = Math.max(scrollTop - fitPerfectlyOverscroll, 0);
    const bottom = Math.min(scrollTop + effectiveHeight, scrollHeight);
    return {
      top,
      bottom: Math.max(bottom, top),
    };
  }

  const centeredTop = scrollTop + height / 2 - windowHeight / 2;
  const top = Math.floor(Math.max(centeredTop, 0));
  return {
    top,
    bottom: Math.ceil(
      Math.max(Math.min(centeredTop + windowHeight, scrollHeight), top)
    ),
  };
}
