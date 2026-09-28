// Envio de imagens e vídeos: "+", colar (⌘V) e arrastar; miniaturas com progresso acima do campo
import { $, h, showBanner } from './util.js';
import { icon } from './icons.js';
import { state, findChannel, canIn, PERMS } from './state.js';
import { sessionToken } from './net.js';

const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_VIDEO = 50 * 1024 * 1024;
const MAX_ITEMS = 10;
let pendingChannel = null;
let pending = []; // anexos escolhidos para a próxima mensagem: { kind, url, name, progress, error, xhr, done }

const fmtSize = (b) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.ceil(b / 1024)} KB`);

// Fotos grandes viram WebP de até 2560 px (uma foto de celular cai de ~5 MB para ~500 KB). GIF vai como está.
async function prepareImage(file) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return { file, width: null, height: null };
  let { width, height } = bitmap;
  if (file.type === 'image/gif' || (file.size < 1.5 * 1024 * 1024 && Math.max(width, height) <= 2560)) return { file, width, height };
  const scale = Math.min(1, 2560 / Math.max(width, height));
  width = Math.round(width * scale);
  height = Math.round(height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/webp', 0.85));
  const name = file.name.replace(/\.[^.]+$/, '') + '.webp';
  return { file: blob && blob.size < file.size ? new File([blob], name, { type: 'image/webp' }) : file, width, height };
}

// Tamanho do vídeo (para o chat reservar o espaço certo antes de carregar)
function videoSize(url) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => resolve({ width: v.videoWidth || null, height: v.videoHeight || null });
    v.onerror = () => resolve({ width: null, height: null });
    setTimeout(() => resolve({ width: null, height: null }), 4000);
    v.src = url;
  });
}

export function addFiles(files) {
  const { channel, server } = findChannel(state.view.channelId);
  if (!channel || channel.type === 'voice' || !canIn(server, PERMS.SEND_MESSAGES)) return;
  for (const original of files) {
    const kind = original.type.startsWith('video/') ? 'video' : original.type.startsWith('image/') ? 'image' : null;
    if (!kind) { showBanner(`"${original.name}" não é imagem nem vídeo.`, { timeout: 4000 }); continue; }
    if (pending.length >= MAX_ITEMS) { showBanner(`Até ${MAX_ITEMS} arquivos por mensagem.`, { timeout: 4000 }); break; }
    if (kind === 'video' && original.size > MAX_VIDEO) { showBanner(`"${original.name}" tem ${fmtSize(original.size)}: o limite de vídeo é 50 MB.`, { timeout: 5000 }); continue; }
    const item = { kind, url: URL.createObjectURL(original), name: original.name, progress: 0, error: null, xhr: null };
    item.done = (async () => {
      const prepared = kind === 'image' ? await prepareImage(original) : { file: original, ...(await videoSize(item.url)) };
      if (kind === 'image' && prepared.file.size > MAX_IMAGE) throw new Error(`"${original.name}" é maior que 10 MB.`);
      return upload(item, prepared, channel.id);
    })().catch((err) => {
      item.error = err.message;
      showBanner(err.message, { timeout: 5000 });
      renderTray();
      return null;
    });
    pending.push(item);
  }
  renderTray();
}

// Sobe o arquivo mostrando o progresso (fetch não informa progresso de envio; XHR sim)
function upload(item, { file, width, height }, channelId) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;
    const params = new URLSearchParams({ channel: channelId, name: item.name, ...(width ? { w: width, h: height } : {}) });
    xhr.open('POST', `/api/attach?${params}`);
    xhr.setRequestHeader('Authorization', `Bearer ${sessionToken()}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { item.progress = e.loaded / e.total; renderTray(); } };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 200) { item.progress = 1; renderTray(); resolve(data); } else reject(new Error(data.error || 'Falha ao enviar o arquivo.'));
    };
    xhr.onerror = () => reject(new Error('Falha de conexão ao enviar o arquivo.'));
    xhr.onabort = () => resolve(null);
    xhr.send(file);
  });
}

export const hasPending = () => pending.length > 0;

// Na hora de enviar a mensagem: entrega os ids dos anexos (espera os que ainda estão subindo)
export async function takePending() {
  const items = [...pending];
  clearPending({ keepUploads: true });
  const results = await Promise.all(items.map((p) => p.done));
  return results.filter(Boolean).map((r) => r.id);
}

function clearPending({ keepUploads = false } = {}) {
  for (const p of pending) {
    if (!keepUploads) p.xhr?.abort();
    setTimeout(() => URL.revokeObjectURL(p.url), 60_000);
  }
  pending = [];
  renderTray();
}

// Trocou de canal: os anexos escolhidos ficam para trás
export function attachmentsFollow(channelId) {
  if (pendingChannel !== channelId) { clearPending(); pendingChannel = channelId; }
}

function renderTray() {
  const tray = $('attach-tray');
  tray.hidden = !pending.length;
  tray.replaceChildren();
  for (const p of pending) {
    const card = h('div', p.error ? 'attach-card error' : 'attach-card');
    if (p.kind === 'image') {
      const img = h('img');
      img.src = p.url;
      card.append(img);
    } else {
      const v = h('video');
      v.src = p.url;
      v.muted = true;
      card.append(v, h('span', 'attach-badge', 'VÍDEO'));
    }
    const bar = h('div', 'attach-progress');
    bar.style.width = `${Math.round(p.progress * 100)}%`;
    if (p.progress < 1 && !p.error) card.append(bar);
    const rm = h('button', 'attach-remove');
    rm.type = 'button';
    rm.title = 'Remover';
    rm.append(icon('close', 14));
    rm.onclick = () => {
      p.xhr?.abort();
      pending = pending.filter((x) => x !== p);
      renderTray();
    };
    card.append(rm, h('div', 'attach-name', p.error ? 'Erro' : p.name));
    tray.append(card);
  }
}

// "+" abre o seletor; colar (⌘V) e arrastar para o chat também funcionam
$('btn-attach').onclick = () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = 'image/*,video/*';
  input.onchange = () => addFiles([...input.files]);
  input.click();
};
$('chat-input').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  addFiles(files);
});
{
  const view = $('text-view');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  view.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; depth++; $('drop-overlay').hidden = false; });
  view.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('drop-overlay').hidden = true; } });
  view.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  view.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    $('drop-overlay').hidden = true;
    addFiles([...e.dataTransfer.files]);
  });
}
