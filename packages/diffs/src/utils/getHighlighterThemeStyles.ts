import { normalizeThemeColors } from '@pierre/theming/color';

import { DEFAULT_THEMES } from '../constants';
import type {
  DiffsHighlighter,
  DiffsTheme,
  DiffsThemeNames,
  ThemesType,
} from '../types';
import { formatCSSVariablePrefix } from './formatCSSVariablePrefix';

interface GetHighlighterThemeStylesProps {
  theme?: DiffsThemeNames | ThemesType;
  highlighter: DiffsHighlighter;
  prefix?: string;
}

export function getHighlighterThemeStyles({
  theme = DEFAULT_THEMES,
  highlighter,
  prefix,
}: GetHighlighterThemeStylesProps): string {
  const globalPrefix = formatCSSVariablePrefix('global');
  if (typeof theme === 'string') {
    const themeData = highlighter.getTheme(theme);
    const { fg, bg } = getThemeColors(themeData, highlighter);
    return `color:${fg};background-color:${bg};${globalPrefix}fg:${fg};${globalPrefix}bg:${bg};${getGitVariables(themeData, prefix)}`;
  }
  let styles = '';
  for (const mode of ['dark', 'light'] as const) {
    const themeData = highlighter.getTheme(theme[mode]);
    const { fg, bg } = getThemeColors(themeData, highlighter);
    styles += `${globalPrefix}${mode}:${fg};${globalPrefix}${mode}-bg:${bg};${getGitVariables(themeData, mode)}`;
  }
  return styles;
}

// cssVariables: true must use the same prefix for backgrounds and tokens.
// Object palettes already include their configured prefix and defaults.
function getThemeColors(theme: DiffsTheme, highlighter: DiffsHighlighter) {
  if (highlighter.name === 'highlights' && theme.zed?.cssVariables === true) {
    const prefix = formatCSSVariablePrefix('token');
    return { fg: `var(${prefix}foreground)`, bg: `var(${prefix}background)` };
  }
  return normalizeThemeColors(theme);
}

// Keep the gitDecoration → terminal.ansi fallback; adding editorGutter colors
// here would change diff backgrounds for existing themes.
const GIT_COLOR_KEYS = [
  ['addition', 'gitDecoration.addedResourceForeground', 'terminal.ansiGreen'],
  ['deletion', 'gitDecoration.deletedResourceForeground', 'terminal.ansiRed'],
  ['modified', 'gitDecoration.modifiedResourceForeground', 'terminal.ansiBlue'],
] as const;

function getGitVariables(themeData: DiffsTheme, modePrefix?: string) {
  const variablePrefix = `${formatCSSVariablePrefix('global')}${modePrefix != null ? `${modePrefix}-` : ''}`;
  let styles = '';
  for (const [name, gitKey, ansiKey] of GIT_COLOR_KEYS) {
    const color = themeData.colors?.[gitKey] ?? themeData.colors?.[ansiKey];
    if (color != null) {
      styles += `${variablePrefix}${name}-color:${color};`;
    }
  }
  return styles;
}
