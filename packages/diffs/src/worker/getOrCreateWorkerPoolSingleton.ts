import type {
  WorkerInitializationRenderOptions,
  WorkerPoolOptions,
} from './types';
import { WorkerPoolManager } from './WorkerPoolManager';

let workerPoolSingleton: WorkerPoolManager | undefined;

export interface SetupWorkerPoolProps {
  poolOptions: WorkerPoolOptions;
  highlighterOptions: WorkerInitializationRenderOptions;
}

export function getOrCreateWorkerPoolSingleton({
  poolOptions,
  highlighterOptions,
}: SetupWorkerPoolProps): WorkerPoolManager {
  return (workerPoolSingleton ??= new WorkerPoolManager(
    poolOptions,
    highlighterOptions
  ));
}

export function terminateWorkerPoolSingleton(): void {
  workerPoolSingleton?.terminate();
  workerPoolSingleton = undefined;
}
