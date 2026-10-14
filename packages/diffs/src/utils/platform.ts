let _isMacLike: boolean | undefined = undefined;
let _isSafari: boolean | undefined = undefined;
let _isFirefox: boolean | undefined = undefined;

// Clears the cached platform/browser detection. Detection is memoized on first
// call, so a test process that swaps `navigator` (e.g. to exercise Linux or
// Safari behavior) must reset it; otherwise the value cached by an earlier test
// leaks across tests and no longer matches the active navigator.
export function resetPlatformDetection(): void {
  _isMacLike = undefined;
  _isSafari = undefined;
  _isFirefox = undefined;
}

export function isMacLike(): boolean {
  if (_isMacLike == null) {
    const navigator = globalThis.navigator as Navigator & {
      userAgentData?: { platform?: string };
    };
    _isMacLike = /macOS|MacIntel|iPhone|iPad|iPod/i.test(
      navigator?.platform ?? navigator?.userAgentData?.platform ?? 'unknown'
    );
  }
  return _isMacLike;
}

export function isSafari(): boolean {
  return (_isSafari ??=
    // oxlint-disable-next-line typescript/no-explicit-any
    ('safari' in window && 'pushNotification' in (window as any).safari) ||
    /^((?!chrome|android).)*safari/i.test(navigator.userAgent));
}

// Gecko-based Firefox builds (desktop and Android). Firefox on iOS (FxiOS)
// renders with WebKit and is intentionally excluded.
export function isFirefox(): boolean {
  return (_isFirefox ??= /\bFirefox\//.test(navigator.userAgent));
}
