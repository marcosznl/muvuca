// Chuva de confete por cima da tela (vitória nos jogos). Some sozinha em ~3 s.
const COLORS = ['#5865f2', '#eb459e', '#57f287', '#fee75c', '#ed4245', '#1abc9c', '#faa61a'];

export function confetti({ count = 160, duration = 3000 } = {}) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  const dpr = window.devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  document.body.append(canvas);
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  const bits = Array.from({ length: count }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * innerWidth * 0.3,
    y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 14,
    vy: -Math.random() * 14 - 4,
    size: 6 + Math.random() * 6,
    spin: Math.random() * Math.PI,
    turn: (Math.random() - 0.5) * 0.3,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
  }));
  const start = performance.now();
  const frame = (now) => {
    const t = now - start;
    g.clearRect(0, 0, innerWidth, innerHeight);
    g.globalAlpha = Math.max(0, 1 - Math.max(0, t - duration * 0.7) / (duration * 0.3));
    for (const b of bits) {
      b.vy += 0.35;
      b.vx *= 0.99;
      b.x += b.vx;
      b.y += b.vy;
      b.spin += b.turn;
      g.save();
      g.translate(b.x, b.y);
      g.rotate(b.spin);
      g.fillStyle = b.color;
      g.fillRect(-b.size / 2, -b.size / 4, b.size, b.size / 2);
      g.restore();
    }
    if (t < duration) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}
