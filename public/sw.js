const CACHE = 'journal-analyzer-v8'
const SHELL = ['./', './index.html', './manifest.webmanifest', './favicon.svg', './favicon.ico', './icons/icon-192.png', './icons/icon-512.png']

async function cacheCoreAssets(cache, entryAssets) {
  const coreAssets = new Set()
  const pending = entryAssets.filter((url) => url.endsWith('.js'))
  while (pending.length) {
    const asset = pending.pop()
    let response = await cache.match(asset, { ignoreVary: true })
    if (!response) {
      await cache.add(asset)
      response = await cache.match(asset, { ignoreVary: true })
    }
    if (!response) continue
    const js = await response.text()
    const dependencies = js.matchAll(
      /["']([^"']*(?:journalWorker|journal_core_bg|7zz(?:\.es6)?)-[A-Za-z0-9_-]+\.(?:js|wasm))["']/g,
    )
    for (const match of dependencies) {
      const url = new URL(match[1], asset)
      if (url.origin !== self.location.origin || coreAssets.has(url.href)) continue
      coreAssets.add(url.href)
      if (url.href.endsWith('.js')) pending.push(url.href)
    }
  }
  await cache.addAll([...coreAssets])
}

async function cacheEntryAssets(cache) {
  const index = await cache.match('./index.html')
  if (!index) throw new Error('Cached index.html is missing')
  const html = await index.text()
  const assets = [...html.matchAll(/(?:src|href)="([^"]*assets\/[^"]+)"/g)]
    .map((match) => new URL(match[1], self.registration.scope).href)
  await cache.addAll(assets)
  await cacheCoreAssets(cache, assets)
  const fontUrls = new Set()
  for (const asset of assets.filter((url) => url.endsWith('.css'))) {
    const response = await cache.match(asset)
    if (!response) continue
    const css = await response.text()
    for (const match of css.matchAll(/url\((?:['"]?)([^)'"]+)(?:['"]?)\)/g)) {
      const url = new URL(match[1], asset)
      if (url.origin === self.location.origin) fontUrls.add(url.href)
    }
  }
  await cache.addAll([...fontUrls])
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    await cache.addAll(SHELL)
    await cacheEntryAssets(cache)
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    // HTML is always network-first so a deployed update cannot be trapped by an old shell.
    event.respondWith((async () => {
      try {
        const response = await fetch(request)
        if (response.ok) {
          const cache = await caches.open(CACHE)
          await cache.put('./index.html', response.clone())
        }
        return response
      } catch {
        return (await caches.match('./index.html')) || caches.match('./')
      }
    })())
    return
  }

  // Hashed JS/CSS/WASM/font assets are immutable; journal files never enter this path.
  event.respondWith((async () => {
    // Vite/static hosts may send Vary: Origin; module requests carry Origin while
    // precache requests do not. These same-origin hashed assets have no variants.
    const cached = await caches.match(request, { ignoreVary: true })
    if (cached) return cached
    const response = await fetch(request)
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(CACHE)
      await cache.put(request, response.clone())
    }
    return response
  })())
})
