// Ícones SVG (desenho próprio, no estilo do Discord)

// Ícones SVG preenchidos (desenho próprio, no estilo do Discord). Os "-off" ganham um risco recortado.
const STROKE = 'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"';
const SPEAKER_BODY = '<path d="M11.4 3.2A1 1 0 0 1 13 4v16a1 1 0 0 1-1.6.8L6.7 17H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2.7l4.7-3.8Z"/>';
const WAVE_1 = '<path class="w1" d="M15.1 8.3a1 1 0 0 1 1.4 0 5 5 0 0 1 0 7.4 1 1 0 1 1-1.4-1.4 3 3 0 0 0 0-4.6 1 1 0 0 1 0-1.4Z"/>';
const WAVE_2 = '<path class="w2" d="M18 5.4a1 1 0 0 1 1.4 0 9 9 0 0 1 0 13.2 1 1 0 0 1-1.4-1.4 7 7 0 0 0 0-10.4 1 1 0 0 1 0-1.4Z"/>';
const MONITOR = 'M4 3a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3h7v2H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-2h7a3 3 0 0 0 3-3V6a3 3 0 0 0-3-3H4Z';
export const ICONS = {
  pause: '<rect x="6" y="4" width="4.5" height="16" rx="1.2"/><rect x="13.5" y="4" width="4.5" height="16" rx="1.2"/>',
  chat: '<path d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-4.4 3.5A1 1 0 0 1 3 20.7V5a2 2 0 0 1 1-2Zm4 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm4 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm4 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"/>',
  // Ondas sonoras (modo música: som puro, sem supressão de ruído)
  waveform: '<rect x="2" y="10" width="2.4" height="4" rx="1.2"/><rect x="6.2" y="6.5" width="2.4" height="11" rx="1.2"/><rect x="10.4" y="3" width="2.4" height="18" rx="1.2"/><rect x="14.6" y="7.5" width="2.4" height="9" rx="1.2"/><rect x="18.8" y="9.5" width="2.4" height="5" rx="1.2"/>',
  'arrow-right': `<g ${STROKE}><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></g>`,
  bell: '<path d="M12 2a7 7 0 0 0-7 7v3.6l-1.7 2.9A1 1 0 0 0 4.2 17h15.6a1 1 0 0 0 .9-1.5L19 12.6V9a7 7 0 0 0-7-7Z"/><path d="M9.5 19a2.5 2.5 0 0 0 5 0h-5Z"/>',
  trophy: '<path d="M7 2h10v2h3a1 1 0 0 1 1 1v2a5 5 0 0 1-4.6 5A5 5 0 0 1 13 14.9V18h3a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1h3v-3.1A5 5 0 0 1 7.6 12 5 5 0 0 1 3 7V5a1 1 0 0 1 1-1h3V2Zm0 4H5v1a3 3 0 0 0 2 2.8V6Zm10 0v3.8A3 3 0 0 0 19 7V6h-2Z"/>',
  mic: '<path class="mic-head" d="M12 1.5a4 4 0 0 0-4 4v5.5a4 4 0 0 0 8 0V5.5a4 4 0 0 0-4-4Z"/><path d="M5 10a1 1 0 0 1 1 1 6 6 0 0 0 12 0 1 1 0 1 1 2 0 8 8 0 0 1-7 7.94V21h2.5a1 1 0 1 1 0 2h-7a1 1 0 1 1 0-2H11v-2.06A8 8 0 0 1 4 11a1 1 0 0 1 1-1Z"/>',
  // Em três partes (arco e as duas conchas) para as conchas poderem "bater" uma na outra na animação
  headphones: '<path d="M12 3a9 9 0 0 0-9 9v3.5h2V12a7 7 0 0 1 14 0v3.5h2V12a9 9 0 0 0-9-9Z"/><rect class="hp-l" x="2.5" y="13" width="6.5" height="8.5" rx="2.2"/><rect class="hp-r" x="15" y="13" width="6.5" height="8.5" rx="2.2"/>',
  'phone-off': '<path d="M21.8 13.9c.3-.4.2-1-.1-1.3C19.2 10.2 15.8 9 12 9s-7.2 1.2-9.7 3.6c-.4.3-.4.9-.1 1.3l1.9 2.3c.3.4.9.5 1.3.2l2.4-1.6c.3-.2.5-.6.4-1l-.2-1.5c1.3-.5 2.6-.7 4-.7s2.7.2 4 .7l-.2 1.5c0 .4.1.8.4 1l2.4 1.6c.4.3 1 .2 1.3-.2l1.9-2.3Z"/>',
  'log-out': `<g ${STROKE}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><g class="arrow"><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></g></g>`,
  users: '<circle cx="9" cy="8" r="4"/><path d="M1 20a8 8 0 0 1 16 0 1 1 0 0 1-1 1H2a1 1 0 0 1-1-1Z"/><path d="M16.5 4.2a4 4 0 0 1 0 7.6 6 6 0 0 0 0-7.6Z"/><path d="M19 13.3A8 8 0 0 1 23 20a1 1 0 0 1-1 1h-3a3 3 0 0 0 .1-1 10 10 0 0 0-2.7-6.9 8 8 0 0 1 2.6.2Z"/>',
  menu: '<rect x="3" y="5" width="18" height="2.2" rx="1.1"/><rect x="3" y="11" width="18" height="2.2" rx="1.1"/><rect x="3" y="17" width="18" height="2.2" rx="1.1"/>',
  'music-note': '<path d="M20.2 2.2A1 1 0 0 1 21 3.2v12.3a3.5 3.5 0 1 1-2-3.16V7.4l-9 1.8v8.3a3.5 3.5 0 1 1-2-3.16V5.2a1 1 0 0 1 .8-1l11-2Z"/>',
  gif: '<rect x="2" y="5" width="20" height="14" rx="3.5" fill="none" stroke="currentColor" stroke-width="2"/><text x="12" y="15.3" text-anchor="middle" font-size="7.5" font-weight="800" font-family="Noto Sans, system-ui, sans-serif" fill="currentColor">GIF</text>',
  star: '<path d="M12 2.5a1 1 0 0 1 .9.56l2.6 5.27 5.82.85a1 1 0 0 1 .55 1.7l-4.2 4.1 1 5.8a1 1 0 0 1-1.46 1.05L12 19.1l-5.2 2.74a1 1 0 0 1-1.46-1.06l1-5.79-4.2-4.1a1 1 0 0 1 .55-1.7l5.82-.85 2.6-5.27A1 1 0 0 1 12 2.5Z"/>',
  'trending-up': `<g ${STROKE}><path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/></g>`,
  'arrow-left': `<g ${STROKE}><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></g>`,
  reply: `<g ${STROKE}><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></g>`,
  pin: '<path d="M15.2 2.3a1 1 0 0 1 1.4 0l5.1 5.1a1 1 0 0 1 0 1.4 3 3 0 0 1-3 .75l-3.1 3.1.35 3.5a1 1 0 0 1-.29.81l-1.4 1.4a1 1 0 0 1-1.42 0l-3.1-3.1-4.53 4.52a1 1 0 0 1-1.41-1.41l4.52-4.53-3.1-3.1a1 1 0 0 1 0-1.42l1.4-1.4a1 1 0 0 1 .81-.29l3.5.35 3.1-3.1a3 3 0 0 1 .75-3Z"/>',
  // Amigos: pessoa acenando (como no Discord)
  friends: '<circle cx="8" cy="7.5" r="4"/><path d="M1 20.2C1 16.2 4.1 13 8 13s7 3.2 7 7.2V21a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1v-.8Z"/><path d="M17.6 2.6a1.2 1.2 0 0 1 2.3.4l-.2 3.3.5-1.8a1.1 1.1 0 0 1 2.2.5l-1 4.6a4.6 4.6 0 0 1-3.8 3.6l-.6.1a1.1 1.1 0 0 1-1.3-1l-.2-2.3-1-1.4a1.1 1.1 0 0 1 1.8-1.3l.6.8.7-5.5Z"/>',
  // O "M" do Muvuca (logo): início do app, com mensagens diretas, amigos e jogos
  muvuca: '<path d="M3.5 20V4.6c0-.9.7-1.6 1.6-1.6h1.6c.6 0 1.1.3 1.4.8L12 10.4l3.9-6.6c.3-.5.8-.8 1.4-.8h1.6c.9 0 1.6.7 1.6 1.6V20a1 1 0 0 1-1 1h-2.4a1 1 0 0 1-1-1v-9.3l-2.8 4.8c-.3.5-.8.8-1.4.8h-.8c-.6 0-1.1-.3-1.4-.8L6.9 10.7V20a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1Z"/>',
  'dots-vertical': '<circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>',
  gamepad: '<path d="M7 6h10a5 5 0 0 1 4.9 4l.9 4.7a3 3 0 0 1-5.2 2.6L15.4 15H8.6l-2.2 2.3a3 3 0 0 1-5.2-2.6L2.1 10A5 5 0 0 1 7 6Zm0 3a1 1 0 0 0-1 1v1H5a1 1 0 1 0 0 2h1v1a1 1 0 1 0 2 0v-1h1a1 1 0 1 0 0-2H8v-1a1 1 0 0 0-1-1Zm9.5 1a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Zm2.5 2.2a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Z"/>',
  hash: '<path fill-rule="evenodd" d="M10.99 3.16A1 1 0 1 0 9 2.84L8.15 8H4a1 1 0 0 0 0 2h3.82l-.67 4H3a1 1 0 1 0 0 2h3.82l-.8 4.84a1 1 0 0 0 1.97.32L8.85 16h4.97l-.8 4.84a1 1 0 0 0 1.97.32l.86-5.16H20a1 1 0 1 0 0-2h-3.82l.67-4H21a1 1 0 1 0 0-2h-3.82l.8-4.84a1 1 0 1 0-1.97-.32L15.15 8h-4.97l.8-4.84ZM14.15 14l.67-4H9.85l-.67 4h4.97Z"/>',
  speaker: SPEAKER_BODY + WAVE_1 + WAVE_2,
  'volume-low': SPEAKER_BODY + WAVE_1,
  'volume-off': SPEAKER_BODY + `<g ${STROKE}><path d="m16.5 9.5 5 5"/><path d="m21.5 9.5-5 5"/></g>`,
  video: '<path d="M4 5a3 3 0 0 0-3 3v8a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-1.5l4.4 3.1A1 1 0 0 0 23 16.8V7.2a1 1 0 0 0-1.6-.8L17 9.5V8a3 3 0 0 0-3-3H4Z"/>',
  monitor: `<path d="${MONITOR}"/>`,
  // Virar câmera: corpo da câmera com duas setas girando
  'flip-camera': `<g ${STROKE}><path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z"/><path d="M8.5 12.5a3.5 3.5 0 0 1 6.3-2.1"/><path d="m15 8.5-.2 1.9-1.9-.2"/><path d="M15.5 13.5a3.5 3.5 0 0 1-6.3 2.1"/><path d="m9 17.5.2-1.9 1.9.2"/></g>`,
  'monitor-up': `<path fill-rule="evenodd" d="${MONITOR}M12 6.2 8.3 9.9l1.4 1.4L11 10v4.5h2V10l1.3 1.3 1.4-1.4L12 6.2Z"/>`,
  'bar-chart': '<rect x="3" y="13" width="4" height="8" rx="1.2"/><rect x="10" y="8" width="4" height="13" rx="1.2"/><rect x="17" y="3" width="4" height="18" rx="1.2"/>',
  maximize: `<g ${STROKE}><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></g>`,
  signal: '<path d="M4 3.5a1.2 1.2 0 0 0 0 2.4A14.1 14.1 0 0 1 18.1 20a1.2 1.2 0 1 0 2.4 0A16.5 16.5 0 0 0 4 3.5Z"/><path d="M4 9a1.2 1.2 0 0 0 0 2.4 8.6 8.6 0 0 1 8.6 8.6 1.2 1.2 0 1 0 2.4 0A11 11 0 0 0 4 9Z"/><circle cx="5.2" cy="18.8" r="2.2"/>',
  smile: '<path fill-rule="evenodd" d="M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22ZM8.5 10.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm7 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM7.2 14.1a1 1 0 0 1 1.4.1A4.5 4.5 0 0 0 12 16a4.5 4.5 0 0 0 3.4-1.8 1 1 0 1 1 1.5 1.3A6.5 6.5 0 0 1 12 18a6.5 6.5 0 0 1-4.9-2.5 1 1 0 0 1 .1-1.4Z"/>',
  'chevron-down': `<path ${STROKE} d="m6 9 6 6 6-6"/>`,
  'chevron-up': `<path ${STROKE} d="m18 15-6-6-6 6"/>`,
};
// Versões "desligado": o mesmo desenho com um risco diagonal recortado
for (const base of ['mic', 'headphones', 'video']) ICONS[`${base}-off`] = { base };

let iconSeq = 0;
function iconSvg(name, size) {
  const def = ICONS[name];
  const open = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">`;
  if (typeof def === 'string') return `${open}${def}</svg>`;
  const id = `ico-cut-${++iconSeq}`;
  return `${open}<defs><mask id="${id}"><rect width="24" height="24" fill="#fff"/>`
    + '<path d="M21.5 2.5 2.5 21.5" stroke="#000" stroke-width="5.5" stroke-linecap="round"/></mask></defs>'
    + `<g mask="url(#${id})">${ICONS[def.base]}</g>`
    + '<path d="M21.5 2.5 2.5 21.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
}

export function icon(name, size = 20) {
  const span = document.createElement('span');
  span.className = 'ico';
  span.dataset.i = name; // o CSS escolhe a animação de cada ícone por aqui
  span.innerHTML = iconSvg(name, size);
  return span;
}


Object.assign(ICONS, {
  plus: `<path ${STROKE} d="M12 5v14M5 12h14"/>`,
  settings: '<path fill-rule="evenodd" d="M10.6 1.5a1 1 0 0 0-1 .8l-.4 2.1a8 8 0 0 0-1.9 1.1l-2-.7a1 1 0 0 0-1.2.4L2.7 8.3a1 1 0 0 0 .2 1.3l1.6 1.4a8 8 0 0 0 0 2.2L2.9 14.6a1 1 0 0 0-.2 1.3l1.4 2.4a1 1 0 0 0 1.2.4l2-.7a8 8 0 0 0 1.9 1.1l.4 2.1a1 1 0 0 0 1 .8h2.8a1 1 0 0 0 1-.8l.4-2.1a8 8 0 0 0 1.9-1.1l2 .7a1 1 0 0 0 1.2-.4l1.4-2.4a1 1 0 0 0-.2-1.3l-1.6-1.4a8 8 0 0 0 0-2.2l1.6-1.4a1 1 0 0 0 .2-1.3l-1.4-2.4a1 1 0 0 0-1.2-.4l-2 .7a8 8 0 0 0-1.9-1.1l-.4-2.1a1 1 0 0 0-1-.8h-2.8ZM12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/>',
  'user-plus': '<circle cx="9" cy="8" r="4"/><path d="M1 20a8 8 0 0 1 16 0 1 1 0 0 1-1 1H2a1 1 0 0 1-1-1Z"/><path d="M19 7a1 1 0 0 1 1 1v2h2a1 1 0 1 1 0 2h-2v2a1 1 0 1 1-2 0v-2h-2a1 1 0 1 1 0-2h2V8a1 1 0 0 1 1-1Z"/>',
  trash: '<path d="M9 2a1 1 0 0 0-.9.6L7.4 4H4a1 1 0 0 0 0 2h16a1 1 0 1 0 0-2h-3.4l-.7-1.4A1 1 0 0 0 15 2H9Z"/><path fill-rule="evenodd" d="M5 8h14l-.9 12.1A2 2 0 0 1 16.1 22H7.9a2 2 0 0 1-2-1.9L5 8Zm5 3a1 1 0 0 0-1 1v6a1 1 0 1 0 2 0v-6a1 1 0 0 0-1-1Zm4 0a1 1 0 0 0-1 1v6a1 1 0 1 0 2 0v-6a1 1 0 0 0-1-1Z"/>',
  pencil: '<path d="M16.3 3.3a2.4 2.4 0 0 1 3.4 3.4L8.4 18l-4.6 1.2a.6.6 0 0 1-.7-.7L4.3 14 16.3 3.3Z"/>',
  'door-out': `<g ${STROKE}><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M9 16l-4-4 4-4"/><path d="M5 12h11"/></g>`,
  lock: '<path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 0 1 6 0v3H9Zm3 4a1.5 1.5 0 0 1 1 2.6V18a1 1 0 1 1-2 0v-1.4A1.5 1.5 0 0 1 12 14Z"/>',
  clock: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 5a1 1 0 1 0-2 0v5c0 .3.1.5.3.7l3 3a1 1 0 0 0 1.4-1.4L13 11.6V7Z"/>',
  calendar: '<path d="M8 2a1 1 0 0 1 1 1v1h6V3a1 1 0 1 1 2 0v1h1a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h1V3a1 1 0 0 1 1-1ZM5 10v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9H5Zm2 3h3v3H7v-3Z"/>',
  shield: '<path d="M12 2 4 5v6c0 5 3.4 9.3 8 11 4.6-1.7 8-6 8-11V5l-8-3Z"/>',
  close: `<path ${STROKE} d="M6 6l12 12M18 6 6 18"/>`,
  crown: '<path d="M3 7l4.5 4L12 4l4.5 7L21 7l-2 12H5L3 7Z"/>',
  link: `<g ${STROKE}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></g>`,
  compass: '<path fill-rule="evenodd" d="M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22Zm4.6-16.6-2.3 6.4a2 2 0 0 1-1.2 1.2l-6.4 2.3 2.3-6.4a2 2 0 0 1 1.2-1.2l6.4-2.3Z"/>',
  'arrow-up': `<path ${STROKE} d="M12 19V5M6 11l6-6 6 6"/>`,
  'arrow-down': `<path ${STROKE} d="M12 5v14M6 13l6 6 6-6"/>`,
  'thumb-up': '<path d="M2 10.5A1.5 1.5 0 0 1 3.5 9H6v12H3.5A1.5 1.5 0 0 1 2 19.5v-9Z"/><path d="M8 20.2V9.4l3.6-6.3a1.8 1.8 0 0 1 3.3 1.3L14 9h5.5a2.5 2.5 0 0 1 2.4 3.1l-1.8 7A2.5 2.5 0 0 1 17.7 21H9a1 1 0 0 1-1-.8Z"/>',
  'thumb-down': '<path d="M22 13.5a1.5 1.5 0 0 1-1.5 1.5H18V3h2.5A1.5 1.5 0 0 1 22 4.5v9Z"/><path d="M16 3.8v10.8l-3.6 6.3a1.8 1.8 0 0 1-3.3-1.3L10 15H4.5a2.5 2.5 0 0 1-2.4-3.1l1.8-7A2.5 2.5 0 0 1 6.3 3H15a1 1 0 0 1 1 .8Z"/>',
  heart: '<path d="M12 21s-7.5-4.6-9.6-9.2C.8 8.2 2.9 4 6.9 4c2.2 0 3.7 1.2 5.1 3 1.4-1.8 2.9-3 5.1-3 4 0 6.1 4.2 4.5 7.8C19.5 16.4 12 21 12 21Z"/>',
  skip: '<path d="M4 5.2a1 1 0 0 1 1.5-.9l10 6.8a1 1 0 0 1 0 1.8l-10 6.8A1 1 0 0 1 4 18.8V5.2Z"/><rect x="17" y="4" width="3" height="16" rx="1.2"/>',
  'player-play': '<path d="M7 4.5a1 1 0 0 1 1.5-.9l11 7.5a1 1 0 0 1 0 1.8l-11 7.5A1 1 0 0 1 7 19.5v-15Z"/>',
  search: `<g ${STROKE}><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></g>`,
  check: `<path ${STROKE} d="m5 12 5 5 9-10"/>`,
  phone: '<path d="M6.6 2.2a1.6 1.6 0 0 1 1.9.9l1.4 3.3a1.6 1.6 0 0 1-.4 1.8L7.8 9.7a13 13 0 0 0 6.5 6.5l1.5-1.7a1.6 1.6 0 0 1 1.8-.4l3.3 1.4a1.6 1.6 0 0 1 .9 1.9l-.7 2.6A2.2 2.2 0 0 1 19 21.6C9.8 21.2 2.8 14.2 2.4 5a2.2 2.2 0 0 1 1.6-2.1l2.6-.7Z"/>',
  grip: '<g><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></g>',
  file: '<path d="M6 2a3 3 0 0 0-3 3v14a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3V9.4a2 2 0 0 0-.6-1.4l-5.4-5.4A2 2 0 0 0 13.6 2H6Zm7 1.8V8a1 1 0 0 0 1 1h4.2L13 3.8Z"/>',
  download: `<path ${STROKE} d="M12 4v11m-5-5 5 5 5-5M5 20h14"/>`,
});

// Ícones fixos do HTML (<button data-icon="...">)
export function applyStaticIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el.dataset.iconDone) continue;
    el.prepend(icon(el.dataset.icon, Number(el.dataset.size) || 20));
    el.dataset.iconDone = '1';
  }
}

// Clique num botão: o ícone dele faz a animação (depois do clique, para pegar o ícone novo
// quando o botão troca de desenho, ex.: microfone -> microfone cortado)
document.addEventListener('click', (e) => {
  const btn = e.target.closest?.('button');
  if (!btn) return;
  setTimeout(() => {
    for (const ico of btn.querySelectorAll(':scope > .ico')) {
      ico.classList.remove('play');
      void ico.offsetWidth; // reinicia a animação
      ico.classList.add('play');
      clearTimeout(ico.playTimer);
      ico.playTimer = setTimeout(() => ico.classList.remove('play'), 1200);
    }
  }, 0);
});
