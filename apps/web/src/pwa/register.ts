import { useSyncExternalStore } from 'react';
import { Workbox } from 'workbox-window';

// installable-pwa D2: a new version waits until the user asks for it or every window of the
// app has closed; the app never reloads a page by itself (invariant 5).

const HOURLY = 60 * 60 * 1000;
let workbox: Workbox | undefined;
let registration: Promise<ServiceWorkerRegistration | undefined> = Promise.resolve(undefined);
let waiting = false;
const watchers = new Set<() => void>();

/** Registers the built worker; production only, so the dev server has none (invariant 9). */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  workbox = new Workbox('/sw.js');
  workbox.addEventListener('waiting', () => {
    waiting = true;
    for (const watcher of watchers) watcher();
  });
  // Without a worker the app works online as before and cannot open offline.
  registration = workbox.register().catch(() => undefined);
  // A home-screen app may stay open for days, so it looks again on coming back and hourly.
  const look = () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  };
  document.addEventListener('visibilitychange', look);
  setInterval(look, HOURLY);
}

/** Asks the server for a newer worker now; a found one shows the update bar once it waits. */
export function checkForUpdate() {
  void workbox?.update().catch(() => undefined);
}

/**
 * Lets the waiting version take over and reloads this window only once it controls the page,
 * so the reload gets the new files; other windows keep the bar. Once another window has let it
 * in there is nothing waiting, and a reload is enough.
 */
export async function applyUpdate() {
  const waitingWorker = (await registration)?.waiting;
  if (!waitingWorker || !workbox) return window.location.reload();
  navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), {
    once: true,
  });
  workbox.messageSkipWaiting();
}

const watch = (watcher: () => void) => {
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
};

/** Whether a new version waits; it stays true until this window reloads. */
export const useUpdateWaiting = () => useSyncExternalStore(watch, () => waiting);
