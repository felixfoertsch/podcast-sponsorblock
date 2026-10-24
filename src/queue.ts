import type { Job, Store } from "./store";

export type JobWorker = (job: Job, signal: AbortSignal) => Promise<void>;
export type Scheduler = (store: Store, signal: AbortSignal) => Promise<void>;

/** Starts the single durable worker; scheduler stays opt-in. */
export function startQueue(store: Store, worker: JobWorker): Promise<void> {
	return store.start(worker);
}

export function startScheduler(store: Store): void {
	store.startScheduler();
}

export function stopQueue(store: Store): void {
	store.stop();
}
