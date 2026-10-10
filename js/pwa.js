// Shared by flashcards.html and img-to-md.html. Needs js/version.js (APP_VERSION).

// ── Version footer ─────────────────────────────────────────────
document.querySelectorAll('.version').forEach(el => { el.textContent = 'v' + APP_VERSION; });

// ── Service worker registration and update banner ──────────────
// Not registered on localhost, so that file edits show at once during development.
// To test offline mode locally, open the page with "?sw" in the URL.
(function () {
  if (!('serviceWorker' in navigator)) return;
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (isLocal && !new URLSearchParams(location.search).has('sw')) return;

  // controllerchange also fires on the very first install (clients.claim in sw.js).
  // Reload only after the user clicked "Reload" in the banner.
  let reloadRequested = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadRequested) location.reload();
  });

  function showUpdateBanner(worker) {
    if (document.getElementById('update-banner')) return;
    const banner = document.createElement('div');
    banner.id        = 'update-banner';
    banner.className = 'update-banner';
    banner.setAttribute('role', 'status');
    banner.innerHTML = '<span>A new version is available.</span><button type="button">Reload</button>';
    banner.querySelector('button').addEventListener('click', () => {
      reloadRequested = true;
      worker.postMessage('SKIP_WAITING');
    });
    document.body.appendChild(banner);
  }

  navigator.serviceWorker.register('sw.js').then(reg => {
    // A new version installed during an earlier visit and is still waiting
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg.waiting);

    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker.addEventListener('statechange', () => {
        // No controller means this is the first install, not an update
        if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(worker);
      });
    });
  }).catch(err => console.error('Service worker registration failed:', err));
})();
