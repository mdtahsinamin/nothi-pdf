// Offline support. App files are network-first (so a new version shows up on the next visit)
// with the cache as fallback; versioned CDN libraries and OCR language data never change, so
// they're cache-first. Nothing the user opens is ever cached here -- PDFs live only in the page.
"use strict";
const VERSION = "nothi-v3";
const APP_SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "assets/css/styles.css",
  "assets/js/core.js",
  "assets/js/editor.js",
  "assets/js/pdf-text-remove.js",
  "assets/js/tools-pdf.js",
  "assets/js/tools-image.js",
  "assets/js/fonts-data.js",
  "assets/img/icon.svg",
  "assets/img/icon-192.png",
  "assets/img/icon-512.png",
];
const CDN_LIBS = [
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js",
  "https://cdn.jsdelivr.net/npm/regenerator-runtime@0.14.1/runtime.js",
  "https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js",
];
const IMMUTABLE_HOSTS = ["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "tessdata.projectnaptha.com"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(APP_SHELL);
    // CDN files one by one: one unreachable CDN shouldn't block installing the rest
    await Promise.all(CDN_LIBS.map((u) => cache.add(new Request(u, { mode: "cors" })).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  if (IMMUTABLE_HOSTS.includes(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === "opaque") cache.put(req, res.clone()).catch(() => {});
      return res;
    })());
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone()).catch(() => {});
        return res;
      } catch (err) {
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
        if (req.mode === "navigate") {
          const shell = await cache.match("index.html");
          if (shell) return shell;
        }
        throw err;
      }
    })());
  }
});
