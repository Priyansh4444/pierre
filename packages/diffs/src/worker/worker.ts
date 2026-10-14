import { DEFAULT_THEMES } from '../constants';
import { attachResolvedLanguages } from '../highlighter/languages/attachResolvedLanguages';
import { createHighlighter } from '../highlighter/shared_highlighter';
import { attachResolvedThemes } from '../highlighter/themes/attachResolvedThemes';
import type { DiffsHighlighter } from '../types';
import { replaceCustomExtensions } from '../utils/getFiletypeFromFileName';
import { renderDiffWithHighlighter } from '../utils/renderDiffWithHighlighter';
import { renderFileWithHighlighter } from '../utils/renderFileWithHighlighter';
import { encodeHastLines } from './hastLinesTransport';
import type {
  InitializeSuccessResponse,
  RegisterThemeSuccessResponse,
  RenderErrorResponse,
  WorkerRenderingOptions,
  WorkerRequest,
} from './types';
import type { WorkerWireRequest } from './workerMessage';

let highlighter: Promise<DiffsHighlighter> | undefined;
let compactResults = false;
let renderOptions: WorkerRenderingOptions = {
  theme: DEFAULT_THEMES,
  useTokenTransformer: false,
  tokenizeMaxLineLength: 1000,
  lineDiffType: 'word-alt',
  maxLineDiffLength: 1000,
};

const EMPTY_REGEXP = /(?:)/;

self.addEventListener('error', (event) => {
  console.error('[Diffs Worker] Unhandled error:', event.error);
});

self.addEventListener('message', (event: MessageEvent<WorkerWireRequest>) => {
  void handleMessage(event.data);
});

async function handleMessage(request: WorkerWireRequest) {
  try {
    switch (request.type) {
      case 'set-render-options':
        attachResolvedThemes(
          request.resolvedThemes,
          await (highlighter ??= createHighlighter())
        );
        renderOptions = request.renderOptions;
        postMessage({
          type: 'success',
          id: request.id,
          requestType: 'set-render-options',
          sentAt: Date.now(),
        } satisfies RegisterThemeSuccessResponse);
        break;
      case 'initialize':
      case 'file':
      case 'diff': {
        const instance = await (highlighter ??= createHighlighter(
          request.type === 'initialize'
            ? request.preferredHighlighter
            : undefined
        ));
        const {
          id,
          customExtensionsVersion,
          customExtensionMap,
          resolvedLanguages,
        } = request;
        if (customExtensionsVersion != null || customExtensionMap != null) {
          if (customExtensionsVersion == null || customExtensionMap == null) {
            throw new Error(
              'Worker request must include both customExtensionsVersion and customExtensionMap'
            );
          }
          replaceCustomExtensions(customExtensionsVersion, customExtensionMap);
        }
        if (request.type === 'initialize') {
          attachResolvedThemes(request.resolvedThemes, instance);
        }
        if (resolvedLanguages != null) {
          attachResolvedLanguages(resolvedLanguages, instance);
        }
        if (request.type === 'initialize') {
          renderOptions = request.renderOptions;
          compactResults = request.resultFormat === 'hast-ops-v1';
          postMessage({
            type: 'success',
            id,
            requestType: 'initialize',
            sentAt: Date.now(),
          } satisfies InitializeSuccessResponse);
        } else if (request.type === 'file') {
          const options = {
            theme: renderOptions.theme,
            useTokenTransformer: renderOptions.useTokenTransformer,
            tokenizeMaxLineLength: renderOptions.tokenizeMaxLineLength,
          };
          const result = renderFileWithHighlighter(
            request.file,
            instance,
            options
          );
          const code = compactResults
            ? encodeHastLines(result.code)
            : undefined;
          postMessage(
            {
              type: 'success',
              requestType: 'file',
              id,
              result: code == null ? result : { ...result, code },
              options,
              sentAt: Date.now(),
            },
            code == null ? [] : [code.ops.buffer, code.offsets.buffer]
          );
        } else {
          const result = renderDiffWithHighlighter(
            request.diff,
            instance,
            renderOptions
          );
          const code = compactResults
            ? {
                deletionLines: encodeHastLines(result.code.deletionLines),
                additionLines: encodeHastLines(result.code.additionLines),
              }
            : undefined;
          postMessage(
            {
              type: 'success',
              requestType: 'diff',
              id,
              result: code == null ? result : { ...result, code },
              options: renderOptions,
              sentAt: Date.now(),
            },
            code == null
              ? []
              : [
                  code.deletionLines.ops.buffer,
                  code.deletionLines.offsets.buffer,
                  code.additionLines.ops.buffer,
                  code.additionLines.offsets.buffer,
                ]
          );
        }
        break;
      }
      default:
        throw new Error(
          `Unknown request type: ${(request as WorkerRequest).type}`
        );
    }
  } catch (error) {
    console.error('Worker error:', error);
    postMessage({
      type: 'error',
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    } satisfies RenderErrorResponse);
  } finally {
    // Reset legacy RegExp last-match state so it cannot keep a highlighted
    // source string alive after a highlight job completes.
    EMPTY_REGEXP.exec('');
  }
}
