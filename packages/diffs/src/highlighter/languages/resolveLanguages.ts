import type { SupportedLanguages } from '../../types';
import type { ResolvedLanguage } from '../../worker';
import { getResolvedOrResolveLanguage } from './getResolvedOrResolveLanguage';

export async function resolveLanguages(
  languages: SupportedLanguages[]
): Promise<ResolvedLanguage[]> {
  const resolvedLanguages: ResolvedLanguage[] = [];
  const languagesToResolve: Promise<ResolvedLanguage>[] = [];
  for (const language of languages) {
    if (language === 'text' || language === 'ansi') continue;
    const maybeResolvedLanguage = getResolvedOrResolveLanguage(language);
    if ('then' in maybeResolvedLanguage) {
      languagesToResolve.push(maybeResolvedLanguage);
    } else {
      resolvedLanguages.push(maybeResolvedLanguage);
    }
  }
  if (languagesToResolve.length > 0) {
    resolvedLanguages.push(...(await Promise.all(languagesToResolve)));
  }
  return resolvedLanguages;
}
