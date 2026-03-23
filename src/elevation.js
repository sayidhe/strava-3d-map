/** Shared drawing state (set once, reused by updatePlayhead). */
let _state = null;

/** Internal: draw the static elevation profile onto ctx. */
function _drawBase(ctx, { W, H, eles, minE, range }) {
  ctx.clearRect(0, 0, W, H);

  const xOf = (i) => (i / (eles.length - 1)) * W;
  const yOf = (e) => H - ((e - minE) / range) * (H - 8);

  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, '#fc4c02');
  grad.addColorStop(0.5, '#f5a623');
  grad.addColorStop(1, '#fc4c02');

  ctx.beginPath();
  ctx.moveTo(0, H);
  eles.forEach((e, i) => ctx.lineTo(xOf(i), yOf(e)));
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.globalAlpha = 0.55;
  ctx.fill();

  ctx.globalAlpha = 1;
  ctx.beginPath();
  eles.forEach((e, i) => {
    i === 0 ? ctx.moveTo(xOf(i), yOf(e)) : ctx.lineTo(xOf(i), yOf(e));
  });
  ctx.strokeStyle = '#fc4c02';
  ctx.lineWidth = 2;
  ctx.stroke();
}

/**
 * Draw an elevation profile onto a fixed canvas overlay.
 * Creates the canvas on demand and appends it to document.body.
 * @param {[number, number, number][]} coords
 */
export function drawElevation(coords) {
  let cvs = /** @type {HTMLCanvasElement|null} */ (
    document.getElementById('elevation-canvas')
  );
  if (!cvs) {
    cvs = document.createElement('canvas');
    cvs.id = 'elevation-canvas';
    document.body.appendChild(cvs);
  }

  const W = 680, H = 64;
  cvs.width = W;
  cvs.height = H;

  const eles  = coords.map((c) => c[2]);
  const minE  = Math.min(...eles);
  const range = (Math.max(...eles) - minE) || 1;

  _state = { cvs, eles, minE, range, W, H };
  _drawBase(cvs.getContext('2d'), _state);

  requestAnimationFrame(() => cvs.classList.add('visible'));
}

/**
 * Overlay a playhead at the given progress (0–1) on the elevation canvas.
 * Redraws the base chart first so the playhead is always on top.
 * @param {number} progress
 */
export function updatePlayhead(progress) {
  if (!_state) return;
  const { cvs, W, H } = _state;
  const ctx = /** @type {CanvasRenderingContext2D} */ (cvs.getContext('2d'));

  _drawBase(ctx, _state);

  const x = Math.round(progress * W);

  // Dim the "not yet reached" area
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = '#000';
  ctx.fillRect(x, 0, W - x, H);
  ctx.globalAlpha = 1;

  // Orange progress fill overlay
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = '#fc4c02';
  ctx.fillRect(0, 0, x, H);
  ctx.globalAlpha = 1;

  // Vertical playhead line
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, H);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.9;
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Small circle knob at top
  ctx.beginPath();
  ctx.arc(x, 5, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = '#fc4c02';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}
