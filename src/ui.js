const $ = (id) => document.getElementById(id);

/**
 * Populate and reveal the stats HUD.
 * @param {{ dist: string, gain: number, loss: number, hi: number, lo: number }} stats
 * @param {string} name
 */
export function showHUD(stats, name) {
  $('s-dist').textContent = stats.dist;
  $('s-gain').textContent = stats.gain.toLocaleString();
  $('s-loss').textContent = stats.loss.toLocaleString();
  $('s-hi').textContent   = stats.hi.toLocaleString();
  $('s-lo').textContent   = stats.lo.toLocaleString();

  $('track-name').textContent = name;
  $('track-name').classList.add('visible');
  $('hud').classList.add('visible');
  $('reset-btn').classList.add('visible');
}

/**
 * Update the numeric HUD values while preserving layout / labels.
 * @param {{ dist: string, gain: number, loss: number, hi?: number, lo?: number }} stats
 */
export function updateHUD(stats) {
  $('s-dist').textContent = stats.dist;
  $('s-gain').textContent = stats.gain.toLocaleString();
  $('s-loss').textContent = stats.loss.toLocaleString();
  if (typeof stats.hi === 'number') $('s-hi').textContent = stats.hi.toLocaleString();
  if (typeof stats.lo === 'number') $('s-lo').textContent = stats.lo.toLocaleString();
}

/** Show loading spinner. */
export function showLoader() {
  $('loader').classList.add('visible');
}

/** Hide loading spinner. */
export function hideLoader() {
  $('loader').classList.remove('visible');
}

/** Hide the drop overlay. */
export function hideDropOverlay() {
  const overlay = $('drop-overlay');
  overlay.classList.add('hidden');
  setTimeout(() => { overlay.style.display = 'none'; }, 450);
}
