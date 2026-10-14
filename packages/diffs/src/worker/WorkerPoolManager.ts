import LRUMapPkg from 'lru_map';
import type { LRUMap } from 'lru_map';

import { DEFAULT_THEMES } from '../constants';
import { resolveHighlighterType } from '../highlighter/highlighterType';
import { areLanguagesAttached } from '../highlighter/languages/areLanguagesAttached';
import { getResolvedLanguages } from '../highlighter/languages/getResolvedLanguages';
import { hasResolvedLanguages } from '../highlighter/languages/hasResolvedLanguages';
import { resolveLanguages } from '../highlighter/languages/resolveLanguages';
import {
  getHighlighterIfLoaded,
  getSharedHighlighter,
  HighlighterDisposedError,
} from '../highlighter/shared_highlighter';
import { getResolvedThemes } from '../highlighter/themes/getResolvedThemes';
import { hasResolvedThemes } from '../highlighter/themes/hasResolvedThemes';
import { resolveThemes } from '../highlighter/themes/resolveThemes';
import type {
  DiffsTheme,
  DiffsThemeNames,
  FileContents,
  FileDiffMetadata,
  HighlighterTypes,
  HunkExpansionRegion,
  RenderDiffOptions,
  RenderDiffResult,
  RenderFileOptions,
  RenderFileResult,
  SupportedLanguages,
  ThemedDiffResult,
  ThemedFileResult,
} from '../types';
import { areDiffRenderOptionsEqual } from '../utils/areDiffRenderOptionsEqual';
import { areDiffTargetsEqual } from '../utils/areDiffTargetsEqual';
import { areFileRenderOptionsEqual } from '../utils/areFileRenderOptionsEqual';
import { areFilesEqual } from '../utils/areFilesEqual';
import { areThemesEqual } from '../utils/areThemesEqual';
import {
  getCustomExtensionsMap,
  getCustomExtensionsVersion,
  getFiletypeFromFileName,
} from '../utils/getFiletypeFromFileName';
import { getThemes } from '../utils/getThemes';
import { isDiffPlainText } from '../utils/isDiffPlainText';
import { isFilePlainText } from '../utils/isFilePlainText';
import { renderDiffWithHighlighter } from '../utils/renderDiffWithHighlighter';
import { renderFileWithHighlighter } from '../utils/renderFileWithHighlighter';
import {
  isHandledWorkerPoolError,
  markWorkerErrorReported,
  WorkerPoolTaskCanceledError,
  WorkerPoolTerminatedError,
  WorkerPoolWorkerError,
} from './errors';
import { decodeHastLines } from './hastLinesTransport';
import type {
  AllWorkerTasks,
  DiffRendererInstance,
  FileRendererInstance,
  InitializeWorkerRequest,
  InitializeWorkerTask,
  RenderDiffRequest,
  RenderDiffSuccessResponse,
  RenderDiffTask,
  RenderFileRequest,
  RenderFileSuccessResponse,
  RenderFileTask,
  ResolvedLanguage,
  SetRenderOptionsWorkerTask,
  SubmitRequest,
  WorkerInitializationRenderOptions,
  WorkerPoolOptions,
  WorkerRenderingOptions,
  WorkerRequestId,
  WorkerStats,
} from './types';
import type {
  EncodedDiffSuccessResponse,
  EncodedFileSuccessResponse,
  InitializeWorkerWireRequest,
  WorkerWireResponse,
} from './workerMessage';

interface GetCachesResult {
  fileCache: LRUMap<string, RenderFileResult>;
  diffCache: LRUMap<string, RenderDiffResult>;
}

interface ManagedWorker {
  worker: Worker;
  requestId: string | undefined;
  pendingSetupRequestId: WorkerRequestId | undefined;
  initialized: boolean;
  langs: Set<SupportedLanguages>;
  customExtensionsVersion: number;
}

interface ThemeSubscriber {
  onThemeChange(): void;
}

type RenderTask = RenderFileTask | RenderDiffTask;

type RenderTaskInstance = FileRendererInstance | DiffRendererInstance;

export class WorkerPoolManager {
  private readonly preferredHighlighter: HighlighterTypes;
  private renderOptions: WorkerRenderingOptions;
  private renderOptionsRequestVersion = 0;
  private renderOptionsVersion = 0;
  private initialized: Promise<void> | boolean = false;
  private workers: ManagedWorker[] = [];
  // Tasks that are waiting to get processed by a worker
  private queuedTasks: RenderTask[] = [];
  private queuedTaskByInstance = new Map<RenderTaskInstance, RenderTask>();

  // Tasks that map to highlightKey are essentially singular, so we only
  // need one map to include queued and active
  private taskByHighlightKey = new Map<string, RenderTask>();

  // Tasks that have already been sent to a worker and are awaiting a response.
  private activeTaskById = new Map<WorkerRequestId, AllWorkerTasks>();
  private activeRequestByInstance = new Map<
    RenderTaskInstance,
    WorkerRequestId
  >();

  private nextRequestId = 0;
  private themeSubscribers = new Set<ThemeSubscriber>();
  private workersFailed = false;
  private statSubscribers = new Set<(stats: WorkerStats) => unknown>();
  private fileCache: LRUMap<string, RenderFileResult>;
  private diffCache: LRUMap<string, RenderDiffResult>;
  private _queuedBroadcast: number | undefined;
  // Incremented on terminate so async lifecycle work can identify stale results.
  private lifecycleGeneration = 0;

  constructor(
    private options: WorkerPoolOptions,
    {
      langs,
      theme = DEFAULT_THEMES,
      useTokenTransformer = false,
      lineDiffType = 'word-alt',
      maxLineDiffLength = 1000,
      tokenizeMaxLineLength = 1000,
      preferredHighlighter,
    }: WorkerInitializationRenderOptions
  ) {
    this.preferredHighlighter = resolveHighlighterType(preferredHighlighter);
    this.renderOptions = {
      theme,
      useTokenTransformer,
      lineDiffType,
      maxLineDiffLength,
      tokenizeMaxLineLength,
    };
    this.fileCache = new LRUMapPkg.LRUMap(options.totalASTLRUCacheSize ?? 100);
    this.diffCache = new LRUMapPkg.LRUMap(options.totalASTLRUCacheSize ?? 100);
    this.queueInitialization(langs);
  }

  public isWorkingPool(): boolean {
    return !this.workersFailed;
  }

  public getFileResultCache(file: FileContents): RenderFileResult | undefined {
    return file.cacheKey != null
      ? this.fileCache.get(file.cacheKey)
      : undefined;
  }

  public getDiffResultCache(
    diff: FileDiffMetadata
  ): RenderDiffResult | undefined {
    return diff.cacheKey != null
      ? this.diffCache.get(diff.cacheKey)
      : undefined;
  }

  public inspectCaches(): GetCachesResult {
    const { fileCache, diffCache } = this;
    return { fileCache, diffCache };
  }

  public evictFileFromCache(cacheKey: string): boolean {
    try {
      return this.fileCache.delete(cacheKey) !== undefined;
    } finally {
      this.queueBroadcastStateChanges();
    }
  }

  public evictDiffFromCache(cacheKey: string): boolean {
    try {
      return this.diffCache.delete(cacheKey) !== undefined;
    } finally {
      this.queueBroadcastStateChanges();
    }
  }

  async setRenderOptions({
    theme = this.renderOptions.theme ?? DEFAULT_THEMES,
    useTokenTransformer = this.renderOptions.useTokenTransformer ?? false,
    lineDiffType = this.renderOptions.lineDiffType ?? 'word-alt',
    maxLineDiffLength = this.renderOptions.maxLineDiffLength ?? 1000,
    tokenizeMaxLineLength = this.renderOptions.tokenizeMaxLineLength ?? 1000,
  }: Partial<WorkerRenderingOptions>): Promise<void> {
    const { lifecycleGeneration } = this;
    const renderOptionsRequestVersion = ++this.renderOptionsRequestVersion;
    const isCurrentRequest = (): boolean =>
      this.isCurrentLifecycle(lifecycleGeneration) &&
      this.renderOptionsRequestVersion === renderOptionsRequestVersion;
    try {
      const newRenderOptions: WorkerRenderingOptions = {
        theme,
        useTokenTransformer,
        lineDiffType,
        maxLineDiffLength,
        tokenizeMaxLineLength,
      };
      if (!this.isInitialized()) {
        await this.initialize();
      }
      if (
        !isCurrentRequest() ||
        areDiffRenderOptionsEqual(newRenderOptions, this.renderOptions)
      ) {
        return;
      }

      const themeNames = getThemes(theme);
      let resolvedThemes: DiffsTheme[] = [];
      if (!areThemesEqual(newRenderOptions.theme, this.renderOptions.theme)) {
        resolvedThemes = hasResolvedThemes(
          themeNames,
          this.preferredHighlighter
        )
          ? getResolvedThemes(themeNames, this.preferredHighlighter)
          : await resolveThemes(themeNames, this.preferredHighlighter);
      }

      if (!isCurrentRequest()) {
        return;
      }

      // Warning: resolvedThemes use the workers' backend. The main-thread
      // highlighter can be another backend, so it loads its own copies.
      if (getHighlighterIfLoaded({ theme }) == null) {
        await this.loadSharedHighlighter(themeNames, ['text']);
        if (!isCurrentRequest()) {
          return;
        }
      }

      const workerSetup = this.setRenderOptionsOnWorkers(
        newRenderOptions,
        resolvedThemes
      );

      this.renderOptions = newRenderOptions;
      this.renderOptionsVersion++;
      this.diffCache.clear();
      this.fileCache.clear();
      // Drop render tasks queued or sent with the previous options.
      for (let index = this.queuedTasks.length - 1; index >= 0; index--) {
        const task = this.queuedTasks[index];
        if (!this.isCurrentRenderTask(task)) {
          this.removeQueuedTask(task);
        }
      }
      for (const task of Array.from(this.activeTaskById.values())) {
        if (isRenderTask(task) && !this.isCurrentRenderTask(task)) {
          this.removeActiveTask(task);
        }
      }

      for (const instance of this.themeSubscribers) {
        instance.onThemeChange();
      }

      await workerSetup;
    } catch (error) {
      if (error instanceof WorkerPoolTerminatedError || !isCurrentRequest()) {
        return;
      }
      throw error;
    }
  }

  public getPreferredHighlighter(): HighlighterTypes {
    return this.preferredHighlighter;
  }

  public getFileRenderOptions(): RenderFileOptions {
    const { tokenizeMaxLineLength, theme, useTokenTransformer } =
      this.renderOptions;
    return { theme, useTokenTransformer, tokenizeMaxLineLength };
  }

  public getDiffRenderOptions(): RenderDiffOptions {
    return { ...this.renderOptions };
  }

  // Callers have awaited initialization, so every worker is initialized.
  private async setRenderOptionsOnWorkers(
    renderOptions: WorkerRenderingOptions,
    resolvedThemes: DiffsTheme[]
  ): Promise<void> {
    const taskPromises: Promise<void>[] = [];
    for (const managedWorker of this.workers) {
      taskPromises.push(
        new Promise<void>((resolve, reject) => {
          const id = this.generateRequestId();
          const task: SetRenderOptionsWorkerTask = {
            type: 'set-render-options',
            id,
            request: {
              type: 'set-render-options',
              id,
              renderOptions,
              resolvedThemes,
            },
            resolve,
            reject,
            requestStart: Date.now(),
          };
          // Render-option updates are posted immediately, but the worker stays
          // unavailable for new render work until it acknowledges this message.
          this.activeTaskById.set(id, task);
          managedWorker.pendingSetupRequestId = id;
          managedWorker.worker.postMessage(task.request);
        })
      );
    }
    await Promise.all(taskPromises);
  }

  public subscribeToThemeChanges(instance: ThemeSubscriber): () => void {
    this.themeSubscribers.add(instance);
    this.queueBroadcastStateChanges();
    return () => this.unsubscribeToThemeChanges(instance);
  }

  public unsubscribeToThemeChanges(instance: ThemeSubscriber): void {
    this.themeSubscribers.delete(instance);
    this.queueBroadcastStateChanges();
  }

  public subscribeToStatChanges(
    callback: (stats: WorkerStats) => unknown
  ): () => void {
    this.statSubscribers.add(callback);
    callback(this.getStats());
    return () => {
      this.statSubscribers.delete(callback);
    };
  }

  private queueBroadcastStateChanges() {
    if (this._queuedBroadcast != null) return;
    this._queuedBroadcast = requestAnimationFrame(this._broadcastStateChanges);
  }

  private _broadcastStateChanges = () => {
    this._queuedBroadcast = undefined;
    const stats = this.getStats();
    for (const callback of this.statSubscribers) {
      callback(stats);
    }
  };

  public cleanUpTasks(instance: RenderTaskInstance): void {
    this.detachInstanceFromQueuedTasks(instance);
    const requestId = this.activeRequestByInstance.get(instance);
    if (requestId != null) {
      const task = this.activeTaskById.get(requestId);
      if (isRenderTask(task)) {
        (task.instances as Set<RenderTaskInstance>).delete(instance);
        if (!task.primeCache && task.instances.size === 0) {
          this.removeActiveTask(task);
        }
      } else {
        this.activeTaskById.delete(requestId);
      }
    }
    this.activeRequestByInstance.delete(instance);
    this.queueBroadcastStateChanges();
  }

  public isInitialized(): boolean {
    return this.initialized === true;
  }

  public async initialize(languages: SupportedLanguages[] = []): Promise<void> {
    if (this.initialized === true) {
      if (getHighlighterIfLoaded({ theme: this.renderOptions.theme }) == null) {
        await this.loadSharedHighlighter(getThemes(this.renderOptions.theme), [
          'text',
          ...languages,
        ]);
      }
      return;
    } else if (this.initialized === false) {
      const { lifecycleGeneration } = this;
      const initialization = (async () => {
        try {
          const themes = getThemes(this.renderOptions.theme);
          const resolvedThemes = hasResolvedThemes(
            themes,
            this.preferredHighlighter
          )
            ? getResolvedThemes(themes, this.preferredHighlighter)
            : await resolveThemes(themes, this.preferredHighlighter);
          if (!this.isCurrentLifecycle(lifecycleGeneration)) {
            return;
          }

          let resolvedLanguages: ResolvedLanguage[] = [];
          if (this.preferredHighlighter !== 'highlights') {
            resolvedLanguages = hasResolvedLanguages(languages)
              ? getResolvedLanguages(languages)
              : await resolveLanguages(languages);
          }
          if (!this.isCurrentLifecycle(lifecycleGeneration)) {
            return;
          }

          await Promise.all([
            this.loadSharedHighlighter(themes, ['text', ...languages]),
            this.initializeWorkers(resolvedThemes, resolvedLanguages),
          ]);

          if (!this.isCurrentLifecycle(lifecycleGeneration)) {
            this.terminateWorkers();
            return;
          }
          this.initialized = true;
          this.diffCache.clear();
          this.fileCache.clear();
          this.drainQueue();
          this.queueBroadcastStateChanges();
        } catch (e) {
          if (
            e instanceof WorkerPoolTerminatedError ||
            !this.isCurrentLifecycle(lifecycleGeneration)
          ) {
            return;
          }
          this.initialized = false;
          this.workersFailed = true;
          // A partial pool is not supported, so stop every worker before
          // consumers rerender through the main-thread fallback.
          this.cancelActiveWorkerTasks();
          this.terminateWorkers();
          this.activeTaskById.clear();
          for (const task of this.queuedTasks) {
            this.rejectRenderTaskCallbacks(task, normalizeWorkerError(e));
          }
          this.queueBroadcastStateChanges();
          throw e;
        }
      })();
      this.initialized = initialization;
      this.queueBroadcastStateChanges();
      // Return the startup promise so callers can await initialization and the
      // constructor's error handler can catch startup failures.
      return initialization;
    } else {
      return this.initialized;
    }
  }

  // Warning: workers never use the main-thread highlighter. If
  // disposeHighlighter() runs during this load, pool work must not fail; the
  // next plain render loads the highlighter again.
  private async loadSharedHighlighter(
    themes: DiffsThemeNames[],
    langs: SupportedLanguages[]
  ): Promise<void> {
    try {
      await getSharedHighlighter({
        themes,
        langs,
        preferredHighlighter: this.preferredHighlighter,
      });
    } catch (error) {
      if (!(error instanceof HighlighterDisposedError)) {
        throw error;
      }
    }
  }

  private async initializeWorkers(
    resolvedThemes: DiffsTheme[],
    resolvedLanguages: ResolvedLanguage[]
  ): Promise<void> {
    this.workersFailed = false;
    const initPromises: Promise<unknown>[] = [];
    const customExtensionVersion = getCustomExtensionsVersion();
    const customExtensionMap =
      customExtensionVersion > 0 ? getCustomExtensionsMap() : undefined;
    this.terminateWorkers();
    for (let i = 0; i < (this.options.poolSize ?? 8); i++) {
      const worker = this.options.workerFactory();
      const managedWorker: ManagedWorker = {
        worker,
        requestId: undefined,
        pendingSetupRequestId: undefined,
        initialized: false,
        langs: new Set(['text', ...resolvedLanguages.map(({ name }) => name)]),
        customExtensionsVersion: 0,
      };
      worker.addEventListener(
        'message',
        (event: MessageEvent<WorkerWireResponse>) => {
          this.handleWorkerMessage(managedWorker, event.data);
        }
      );
      worker.addEventListener('error', (error) =>
        this.handleWorkerError(managedWorker, error)
      );
      this.workers.push(managedWorker);
      initPromises.push(
        new Promise<void>((resolve, reject) => {
          const id = this.generateRequestId();
          const request: InitializeWorkerWireRequest = {
            type: 'initialize',
            resultFormat: 'hast-ops-v1',
            id,
            renderOptions: this.renderOptions,
            preferredHighlighter: this.preferredHighlighter,
            resolvedThemes,
            resolvedLanguages,
            customExtensionsVersion:
              customExtensionMap != null ? customExtensionVersion : undefined,
            customExtensionMap,
          };
          const task: InitializeWorkerTask = {
            type: 'initialize',
            id,
            request,
            resolve() {
              managedWorker.initialized = true;
              resolve();
            },
            reject,
            requestStart: Date.now(),
          };
          managedWorker.pendingSetupRequestId = id;
          this.activeTaskById.set(id, task);
          this.executeTask(managedWorker, task);
        })
      );
    }
    const timeoutMs = this.options.workerInitializationTimeout ?? 10_000;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(initPromises),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(
              new Error(
                `WorkerPoolManager: worker initialization timed out after ${timeoutMs}ms`
              )
            );
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Pass worker errors to onWorkerError, or log them if no callback is set.
  // A startup error rejects initialization so components can highlight on the
  // main thread. Other requests wait for their own responses: worker.ts catches
  // request errors, so this event may be unrelated to the current request.
  // A worker that stops responding remains busy and receives no further work.
  private handleWorkerError(
    managedWorker: ManagedWorker,
    event: ErrorEvent | Event
  ): void {
    const { onWorkerError } = this.options;
    if (onWorkerError != null) {
      try {
        onWorkerError(event, managedWorker.worker);
      } catch (hookError) {
        console.error('WorkerPoolManager: onWorkerError threw:', hookError);
      }
    } else {
      console.error('Worker error:', event, managedWorker);
    }
    const { pendingSetupRequestId } = managedWorker;
    if (pendingSetupRequestId == null) {
      return;
    }
    const task = this.activeTaskById.get(pendingSetupRequestId);
    if (task?.type !== 'initialize') {
      return;
    }
    // Script load failures can provide a plain Event without an error or
    // message, so use a default message when no details are available.
    const cause: unknown = 'error' in event ? event.error : undefined;
    const message =
      'message' in event &&
      typeof event.message === 'string' &&
      event.message !== ''
        ? event.message
        : cause instanceof Error
          ? cause.message
          : 'the worker script failed to load (the error event carries no message)';
    const error = new WorkerPoolWorkerError(
      `WorkerPoolManager: worker failed: ${message}`,
      cause instanceof Error ? { cause } : undefined
    );
    if (onWorkerError != null) {
      markWorkerErrorReported(error);
    }
    task.reject(error);
    this.cleanWorkerAndTask(managedWorker, task);
  }

  private drainQueue = () => {
    this._queuedDrain = undefined;
    // If we are initializing or things got cancelled while initializing, we
    // should not attempt to drain the queue
    if (this.initialized !== true || this.queuedTasks.length === 0) {
      return;
    }
    for (let i = 0; i < this.queuedTasks.length; ) {
      const task = this.queuedTasks[i];
      // If any instance has a request in progress, we should wait for it to
      // finish before starting work that would notify that instance.
      if (this.hasActiveRequest(task)) {
        i++;
        continue;
      }
      const langSet = new Set<SupportedLanguages>();
      if (task.type === 'file') {
        const { lang, name } = task.request.file;
        langSet.add(lang ?? getFiletypeFromFileName(name));
      } else {
        const { lang, name, prevName } = task.request.diff;
        langSet.add(lang ?? getFiletypeFromFileName(name));
        langSet.add(lang ?? getFiletypeFromFileName(prevName ?? '-'));
      }
      langSet.delete('text');
      const langs = Array.from(langSet);
      // Prefer an idle worker that already has every language.
      let availableWorker: ManagedWorker | undefined;
      for (const managedWorker of this.workers) {
        if (
          managedWorker.requestId != null ||
          managedWorker.pendingSetupRequestId != null ||
          !managedWorker.initialized
        ) {
          continue;
        }
        availableWorker = managedWorker;
        if (langs.every((lang) => managedWorker.langs.has(lang))) {
          break;
        }
      }
      if (availableWorker == null) {
        break;
      }
      this.queuedTasks.splice(i, 1);
      availableWorker.requestId = task.id;
      this.clearQueuedInstanceRequests(task);
      for (const instance of task.instances) {
        this.activeRequestByInstance.set(instance, task.id);
      }
      this.activeTaskById.set(task.id, task);
      void this.resolveLanguagesAndExecuteTask(availableWorker, task, langs);
    }
    this.queueBroadcastStateChanges();
  };

  public highlightFileAST(
    instance: FileRendererInstance,
    file: FileContents
  ): void {
    // If we've already highlighted the file or it's plain text, we should not
    // attempt to highlight. This should be mostly never hit, but it's just an
    // extra level of safety
    if (this.isFileHighlighted(file)) {
      return;
    }
    for (const task of this.iterateRenderTasks()) {
      if (
        task.type === 'file' &&
        this.isCurrentRenderTask(task) &&
        task.instances.has(instance) &&
        areFilesEqual(file, task.request.file)
      ) {
        return;
      }
    }
    this.submitTask({ type: 'file', file }, instance);
  }

  public primeFileHighlightCache(file: FileContents): Promise<void> {
    if (!this.isWorkingPool()) {
      return Promise.reject(
        new Error(
          'WorkerPoolManager.primeFileHighlightCache: worker pool is not working'
        )
      );
    }
    if (file.cacheKey == null) {
      console.warn(
        `WorkerPoolManager.primeFileHighlightCache: priming highlight cache requires file.cacheKey; skipping "${file.name}".`
      );
      return Promise.resolve();
    }
    return this.isFileHighlighted(file)
      ? Promise.resolve()
      : this.primeHighlightCache({ type: 'file', file });
  }

  public getPlainFileAST(
    file: FileContents,
    startingLine: number,
    totalLines: number,
    lines?: string[]
  ): ThemedFileResult | undefined {
    const highlighter = getHighlighterIfLoaded({
      theme: this.renderOptions.theme,
    });
    if (highlighter == null) {
      this.queueInitialization();
      return undefined;
    }
    return renderFileWithHighlighter(file, highlighter, this.renderOptions, {
      forcePlainText: true,
      startingLine,
      totalLines,
      lines,
    });
  }

  public highlightDiffAST(
    instance: DiffRendererInstance,
    diff: FileDiffMetadata
  ): void {
    // If we've already highlighted the diff or it's plain text, we should not
    // attempt to highlight. This should be mostly never hit, but it's just an
    // extra level of safety
    if (this.isDiffHighlighted(diff)) {
      return;
    }
    for (const task of this.iterateRenderTasks()) {
      if (
        task.type === 'diff' &&
        this.isCurrentRenderTask(task) &&
        task.instances.has(instance) &&
        areDiffTargetsEqual(task.request.diff, diff)
      ) {
        return;
      }
    }
    this.submitTask({ type: 'diff', diff }, instance);
  }

  public primeDiffHighlightCache(diff: FileDiffMetadata): Promise<void> {
    if (!this.isWorkingPool()) {
      return Promise.reject(
        new Error(
          'WorkerPoolManager.primeDiffHighlightCache: worker pool is not working'
        )
      );
    }
    if (diff.cacheKey == null) {
      console.warn(
        `WorkerPoolManager.primeDiffHighlightCache: priming highlight cache requires diff.cacheKey; skipping "${diff.prevName ?? diff.name}" -> "${diff.name}".`
      );
      return Promise.resolve();
    }
    return this.isDiffHighlighted(diff)
      ? Promise.resolve()
      : this.primeHighlightCache({ type: 'diff', diff });
  }

  public getPlainDiffAST(
    diff: FileDiffMetadata,
    startingLine: number,
    totalLines: number,
    expandedHunks?: Map<number, HunkExpansionRegion> | true,
    collapsedContextThreshold?: number
  ): ThemedDiffResult | undefined {
    const highlighter = getHighlighterIfLoaded({
      theme: this.renderOptions.theme,
    });
    if (highlighter == null) {
      this.queueInitialization();
      return undefined;
    }
    return renderDiffWithHighlighter(diff, highlighter, this.renderOptions, {
      forcePlainText: true,
      startingLine,
      totalLines,
      expandedHunks,
      collapsedContextThreshold,
    });
  }

  public terminate(): void {
    this.lifecycleGeneration++;
    this.cancelActiveWorkerTasks();
    this.terminateWorkers();
    const error = new WorkerPoolTerminatedError();
    for (const task of this.queuedTasks) {
      this.rejectRenderTaskCallbacks(task, error);
    }
    this.fileCache.clear();
    this.diffCache.clear();
    this.activeRequestByInstance.clear();
    this.queuedTasks.length = 0;
    this.queuedTaskByInstance.clear();
    this.taskByHighlightKey.clear();
    this.activeTaskById.clear();
    this.initialized = false;
    this.workersFailed = false;
    this.queueBroadcastStateChanges();
  }

  private isCurrentLifecycle(lifecycleGeneration: number): boolean {
    return this.lifecycleGeneration === lifecycleGeneration;
  }

  private queueInitialization(languages?: SupportedLanguages[]): void {
    void this.initialize(languages).catch((error) => {
      // Skip cancellations and worker errors already passed to onWorkerError.
      if (isHandledWorkerPoolError(error)) {
        return;
      }
      console.error(error);
    });
  }

  private cancelActiveWorkerTasks(): void {
    const error = new WorkerPoolTerminatedError();
    for (const task of this.activeTaskById.values()) {
      if ('reject' in task) {
        task.reject(error);
      } else {
        this.rejectRenderTaskCallbacks(task, error);
      }
    }
  }

  private terminateWorkers() {
    for (const managedWorker of this.workers) {
      managedWorker.worker.terminate();
    }
    this.workers.length = 0;
  }

  public getStats(): WorkerStats {
    return {
      managerState:
        this.initialized === true
          ? 'initialized'
          : this.initialized === false
            ? 'waiting'
            : 'initializing',
      totalWorkers: this.workers.length,
      workersFailed: this.workersFailed,
      busyWorkers: this.workers.filter(
        (w) => w.requestId != null || w.pendingSetupRequestId != null
      ).length,
      queuedTasks: this.queuedTasks.length,
      activeTasks: this.activeTaskById.size,
      themeSubscribers: this.themeSubscribers.size,
      fileCacheSize: this.fileCache.size,
      diffCacheSize: this.diffCache.size,
    };
  }

  // Plain text needs no worker, and a cached result rendered with the current
  // options can be reused.
  private isFileHighlighted(file: FileContents): boolean {
    const cachedResult = this.getFileResultCache(file);
    return (
      isFilePlainText(file) ||
      (cachedResult != null &&
        areFileRenderOptionsEqual(
          cachedResult.options,
          this.getFileRenderOptions()
        ))
    );
  }

  private isDiffHighlighted(diff: FileDiffMetadata): boolean {
    const cachedResult = this.getDiffResultCache(diff);
    return (
      isDiffPlainText(diff) ||
      (cachedResult != null &&
        areDiffRenderOptionsEqual(
          cachedResult.options,
          this.getDiffRenderOptions()
        ))
    );
  }

  private primeHighlightCache(request: SubmitRequest): Promise<void> {
    const task = this.submitTask(request);
    return new Promise((resolve, reject) => {
      task.callbacks.add({ resolve, reject });
    });
  }

  // Join the current task for the same target, or queue a new one. Tasks
  // submitted without an instance only prime the cache.
  private submitTask(
    request: SubmitRequest,
    instance?: RenderTaskInstance
  ): RenderTask {
    if (this.initialized === false) {
      this.queueInitialization();
    }
    const { cacheKey } = request.type === 'file' ? request.file : request.diff;
    const highlightKey =
      cacheKey != null
        ? `${request.type}:${cacheKey}:${this.renderOptionsVersion}`
        : undefined;
    let task =
      highlightKey != null
        ? this.taskByHighlightKey.get(highlightKey)
        : undefined;
    if (task != null && !this.isCurrentRenderTask(task)) {
      task = undefined;
    }
    if (instance != null) {
      this.detachInstanceFromQueuedTasks(instance, task);
    }
    if (task == null) {
      const id = this.generateRequestId();
      task = {
        type: request.type,
        id,
        request: { ...request, id },
        instances: new Set(),
        primeCache: instance == null,
        highlightKey,
        callbacks: new Set(),
        renderOptionsVersion: this.renderOptionsVersion,
        requestStart: Date.now(),
      } as RenderTask;
      this.queuedTasks.push(task);
      if (highlightKey != null) {
        this.taskByHighlightKey.set(highlightKey, task);
      }
      this.queueDrain();
    } else if (instance == null) {
      task.primeCache = true;
    } else {
      this.queueBroadcastStateChanges();
    }
    if (instance != null) {
      (task.instances as Set<RenderTaskInstance>).add(instance);
      if (this.activeTaskById.has(task.id)) {
        this.activeRequestByInstance.set(instance, task.id);
      } else {
        this.queuedTaskByInstance.set(instance, task);
      }
    }
    return task;
  }

  private async resolveLanguagesAndExecuteTask(
    availableWorker: ManagedWorker,
    task: RenderTask,
    langs: SupportedLanguages[]
  ): Promise<void> {
    try {
      // Preload the same languages on the main thread for editing.
      const highlighter = getHighlighterIfLoaded();
      const mainThreadLangs = langs.filter(
        (lang) =>
          highlighter == null || !areLanguagesAttached(lang, highlighter)
      );
      if (mainThreadLangs.length > 0) {
        void this.loadSharedHighlighter(getThemes(this.renderOptions.theme), [
          'text',
          ...mainThreadLangs,
        ]).catch((error: unknown) => {
          console.error(error);
        });
      }
      // Add resolved languages if required
      const workerMissingLangs =
        this.preferredHighlighter === 'highlights'
          ? []
          : langs.filter((lang) => !availableWorker.langs.has(lang));

      if (workerMissingLangs.length > 0) {
        task.request.resolvedLanguages = hasResolvedLanguages(
          workerMissingLangs
        )
          ? getResolvedLanguages(workerMissingLangs)
          : await resolveLanguages(workerMissingLangs);
      }
      // If the task has been cleaned up after awaiting language resolving,
      // lets fully clean it up
      if (!this.activeTaskById.has(task.id)) {
        if (availableWorker.requestId === task.id) {
          this.cleanWorkerAndTask(availableWorker, task);
          this.queueBroadcastStateChanges();
          this.queueDrain();
        }
        return;
      }
      this.executeTask(availableWorker, task);
    } catch (error) {
      this.rejectRenderTaskCallbacks(task, normalizeWorkerError(error));
      this.cleanWorkerAndTask(availableWorker, task);
      this.queueBroadcastStateChanges();
      this.queueDrain();
    }
  }

  private handleWorkerMessage(
    managedWorker: ManagedWorker,
    response: WorkerWireResponse
  ): void {
    const task = this.activeTaskById.get(response.id);
    // A missing task usually means its component unmounted, so the response
    // is ignored.
    if (task != null) {
      try {
        if (response.type === 'error') {
          const error = new Error(response.error);
          if (response.stack) {
            error.stack = response.stack;
          }
          if ('reject' in task) {
            task.reject(error);
          } else {
            this.notifyHighlightError(task, error);
            this.rejectRenderTaskCallbacks(task, error);
          }
          console.error(error, task, response);
        } else {
          // A failed request may not have attached its languages. Only remember
          // them after success so later tasks resend grammars that were rejected.
          if (isRenderTask(task)) {
            for (const { name } of task.request.resolvedLanguages ?? []) {
              managedWorker.langs.add(name);
            }
          }
          if (task.type !== response.requestType) {
            throw new Error('handleWorkerMessage: task/response dont match');
          }
          if (task.type === 'file') {
            const { options, result } = response as
              | RenderFileSuccessResponse
              | EncodedFileSuccessResponse;
            if (
              this.isCurrentRenderTask(task) &&
              areFileRenderOptionsEqual(options, this.getFileRenderOptions())
            ) {
              const decoded: ThemedFileResult = {
                ...result,
                code: decodeHastLines(result.code),
              };
              this.syncCustomExtensionVersion(managedWorker, task.request);
              if (task.cacheKeyAtDispatch != null) {
                this.fileCache.set(task.cacheKeyAtDispatch, {
                  result: decoded,
                  options,
                });
              }
              this.resolveRenderTaskCallbacks(task);
              for (const instance of task.instances) {
                if (this.activeRequestByInstance.get(instance) === task.id) {
                  instance.onHighlightSuccess(
                    task.request.file,
                    decoded,
                    options
                  );
                }
              }
            }
          } else if (task.type === 'diff') {
            const { options, result } = response as
              | RenderDiffSuccessResponse
              | EncodedDiffSuccessResponse;
            if (
              this.isCurrentRenderTask(task) &&
              areDiffRenderOptionsEqual(options, this.getDiffRenderOptions())
            ) {
              const decoded: ThemedDiffResult = {
                ...result,
                code: {
                  deletionLines: decodeHastLines(result.code.deletionLines),
                  additionLines: decodeHastLines(result.code.additionLines),
                },
              };
              this.syncCustomExtensionVersion(managedWorker, task.request);
              if (task.cacheKeyAtDispatch != null) {
                this.diffCache.set(task.cacheKeyAtDispatch, {
                  result: decoded,
                  options,
                });
              }
              this.resolveRenderTaskCallbacks(task);
              for (const instance of task.instances) {
                if (this.activeRequestByInstance.get(instance) === task.id) {
                  instance.onHighlightSuccess(
                    task.request.diff,
                    decoded,
                    options
                  );
                }
              }
            }
          } else {
            if (task.type === 'initialize') {
              this.syncCustomExtensionVersion(managedWorker, task.request);
            }
            task.resolve();
          }
        }
      } catch (error) {
        console.error(error, task, response);
      }
    }

    this.cleanWorkerAndTask(managedWorker, task, response.id);
    this.queueBroadcastStateChanges();
    // We queue drain so that potentially multiple workers can free up
    // allowing for better language matches if possible
    this.queueDrain();
  }

  private _queuedDrain: Promise<void> | undefined;
  private queueDrain() {
    if (this._queuedDrain != null || this.queuedTasks.length === 0) return;
    this._queuedDrain = Promise.resolve().then(this.drainQueue);
    this.queueBroadcastStateChanges();
  }

  private cleanWorkerAndTask(
    managedWorker: ManagedWorker,
    task?: AllWorkerTasks,
    requestId: WorkerRequestId | undefined = task?.id
  ) {
    if (managedWorker.requestId === requestId) {
      managedWorker.requestId = undefined;
    }
    if (managedWorker.pendingSetupRequestId === requestId) {
      managedWorker.pendingSetupRequestId = undefined;
    }
    if (isRenderTask(task)) {
      this.removeActiveTask(task);
    } else if (task != null) {
      this.activeTaskById.delete(task.id);
    }
  }

  private executeTask(
    managedWorker: ManagedWorker,
    task: InitializeWorkerTask | RenderTask
  ): void {
    const { request } = task;
    if (request.customExtensionsVersion == null) {
      const version = getCustomExtensionsVersion();
      if (managedWorker.customExtensionsVersion < version) {
        request.customExtensionsVersion = version;
        request.customExtensionMap = getCustomExtensionsMap();
      }
    }
    try {
      // postMessage clones the request now, so keep the matching cache key on
      // the task instead of reading the caller's mutable target on response.
      if (task.type === 'file') {
        task.cacheKeyAtDispatch = task.request.file.cacheKey;
      } else if (task.type === 'diff') {
        task.cacheKeyAtDispatch = task.request.diff.cacheKey;
      }
      managedWorker.worker.postMessage(request);
    } catch (error) {
      console.error('Failed to post message to worker:', error);
      if (isRenderTask(task)) {
        this.notifyHighlightError(task, error);
        this.rejectRenderTaskCallbacks(task, normalizeWorkerError(error));
      } else {
        task.reject(error as Error);
      }
      this.cleanWorkerAndTask(managedWorker, task);
      this.queueDrain();
    }
    this.queueBroadcastStateChanges();
  }

  private syncCustomExtensionVersion(
    managedWorker: ManagedWorker,
    request: InitializeWorkerRequest | RenderFileRequest | RenderDiffRequest
  ): void {
    if (request.customExtensionsVersion != null) {
      managedWorker.customExtensionsVersion = request.customExtensionsVersion;
    }
  }

  private hasActiveRequest(task: RenderTask): boolean {
    for (const instance of task.instances) {
      if (this.activeRequestByInstance.has(instance)) {
        return true;
      }
    }
    return false;
  }

  private detachInstanceFromQueuedTasks(
    instance: RenderTaskInstance,
    exceptTask?: RenderTask
  ): void {
    const task = this.queuedTaskByInstance.get(instance);
    if (task == null || task === exceptTask) {
      return;
    }
    this.queuedTaskByInstance.delete(instance);
    (task.instances as Set<RenderTaskInstance>).delete(instance);
    if (!task.primeCache && task.instances.size === 0) {
      this.removeQueuedTask(task);
    }
  }

  private removeQueuedTask(task: RenderTask): void {
    const index = this.queuedTasks.indexOf(task);
    if (index !== -1) {
      this.queuedTasks.splice(index, 1);
    }
    this.rejectRenderTaskCallbacks(task, new WorkerPoolTaskCanceledError());
    this.clearQueuedInstanceRequests(task);
    this.clearHighlightKey(task);
  }

  private removeActiveTask(task: RenderTask): void {
    this.rejectRenderTaskCallbacks(task, new WorkerPoolTaskCanceledError());
    for (const instance of task.instances) {
      if (this.activeRequestByInstance.get(instance) === task.id) {
        this.activeRequestByInstance.delete(instance);
      }
    }
    this.clearHighlightKey(task);
    this.activeTaskById.delete(task.id);
  }

  private resolveRenderTaskCallbacks(task: RenderTask): void {
    for (const callbacks of task.callbacks) {
      callbacks.resolve();
    }
    task.callbacks.clear();
  }

  private rejectRenderTaskCallbacks(task: RenderTask, error: Error): void {
    for (const callbacks of task.callbacks) {
      callbacks.reject(error);
    }
    task.callbacks.clear();
  }

  private clearQueuedInstanceRequests(task: RenderTask): void {
    for (const instance of task.instances) {
      if (this.queuedTaskByInstance.get(instance) === task) {
        this.queuedTaskByInstance.delete(instance);
      }
    }
  }

  private clearHighlightKey(task: RenderTask): void {
    if (
      task.highlightKey != null &&
      this.taskByHighlightKey.get(task.highlightKey) === task
    ) {
      this.taskByHighlightKey.delete(task.highlightKey);
    }
  }

  private notifyHighlightError(task: RenderTask, error: unknown): void {
    for (const instance of task.instances) {
      if (this.activeRequestByInstance.get(instance) === task.id) {
        instance.onHighlightError(error);
      }
    }
  }

  private isCurrentRenderTask(task: RenderTask): boolean {
    return task.renderOptionsVersion === this.renderOptionsVersion;
  }

  private *iterateRenderTasks(): Generator<RenderTask> {
    for (const task of this.queuedTasks) {
      yield task;
    }
    for (const task of this.activeTaskById.values()) {
      if (isRenderTask(task)) {
        yield task;
      }
    }
  }

  private generateRequestId(): WorkerRequestId {
    return `req_${++this.nextRequestId}`;
  }
}

function isRenderTask(task: AllWorkerTasks | undefined): task is RenderTask {
  return task?.type === 'file' || task?.type === 'diff';
}

function normalizeWorkerError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  if (error != null && typeof error === 'object') {
    if ('error' in error && error.error instanceof Error) {
      return error.error;
    }
    if ('message' in error && typeof error.message === 'string') {
      return new Error(error.message);
    }
  }
  return new Error(String(error));
}
