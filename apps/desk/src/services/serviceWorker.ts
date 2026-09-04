// Service worker registration helper for Hawa Desk PWA

export interface ServiceWorkerState {
  registered: boolean;
  controller: boolean;
  installed: boolean;
}

let swRegistration: ServiceWorkerRegistration | null = null;

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
    });

    swRegistration = registration;

    registration.addEventListener('updatefound', () => {
      const installingWorker = registration.installing;
      if (installingWorker) {
        installingWorker.addEventListener('statechange', () => {
          if (installingWorker.state === 'installed') {
            if (navigator.serviceWorker.controller) {
              console.log('[PWA] New content available; please refresh.');
            } else {
              console.log('[PWA] Content precached for offline use.');
            }
          }
        });
      }
    });

    return registration;
  } catch (error) {
    console.warn('[PWA] Service worker registration failed:', error);
    return null;
  }
}

export function getServiceWorkerRegistration(): ServiceWorkerRegistration | null {
  return swRegistration;
}

export async function clearPwaCaches(): Promise<void> {
  if (typeof window === 'undefined' || !('caches' in window)) return;
  const keys = await caches.keys();
  await Promise.all(
    keys.filter((k) => k.startsWith('hawa-')).map((k) => caches.delete(k))
  );
}
