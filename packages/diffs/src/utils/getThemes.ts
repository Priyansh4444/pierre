import { DEFAULT_THEMES } from '../constants';
import type { DiffsThemeNames, ThemesType } from '../types';

export function getThemes(
  theme: DiffsThemeNames | ThemesType = DEFAULT_THEMES
): DiffsThemeNames[] {
  return typeof theme === 'string' ? [theme] : [theme.dark, theme.light];
}
