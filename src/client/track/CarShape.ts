// Shared 2D-canvas car silhouette — a small triangular wedge with a
// windshield highlight, oriented by direction vector. Used anywhere a mini
// version of the game's car needs to be drawn on a plain CanvasRenderingContext2D
// (not a Phaser texture): splash-screen ghost trails, the in-game minimap.
export function drawMiniCar(
  ctx:   CanvasRenderingContext2D,
  x:     number,
  y:     number,
  dirX:  number,
  dirY:  number,
  color: string,
  alpha: number,
  size:  number,
): void {
  const mag = Math.hypot(dirX, dirY) || 1;
  const angle = Math.atan2(dirX / mag, -dirY / mag); // canvas-rotate angle for nose-up local shape
  const HW = size * 0.5, HH = size * 0.85;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.globalAlpha = alpha;

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, -HH);
  ctx.lineTo(HW, HH);
  ctx.lineTo(0, HH * 0.35);
  ctx.lineTo(-HW, HH);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.beginPath();
  ctx.moveTo(0, -HH + size * 0.06);
  ctx.lineTo(HW * 0.45, HH * 0.2);
  ctx.lineTo(0, HH * 0.1);
  ctx.lineTo(-HW * 0.45, HH * 0.2);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}
