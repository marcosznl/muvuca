// Menus rápidos das setinhas ao lado do microfone e do fone (como no Discord):
// dispositivo de entrada/saída, perfil de entrada (IA ou padrão), volumes e atalho para as configurações de voz.
import { $, h, showBanner } from './util.js';
import { icon } from './icons.js';
import {
  micDevice, speakerDevice, inputVolume, outputVolume, listDevices, unlockDeviceNames, canPickSpeaker,
  setMicDevice, setSpeakerDevice, setInputVolume, setOutputVolume, setNoiseAi, noiseAiOn, openVoiceSettings,
} from './voice.js';

let open = null;
function close() {
  open?.menu.remove();
  open?.btn.classList.remove('on');
  open = null;
  document.removeEventListener('mousedown', outside, true);
  document.removeEventListener('keydown', onKey, true);
}
function outside(e) { if (open && !open.menu.contains(e.target) && !open.btn.contains(e.target)) close(); }
function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }

const deviceName = (d) => (d.deviceId === 'default' ? 'Padrão do sistema' : d.label.replace(/^(Padrão|Default) - /, '').replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, '') || 'Dispositivo sem nome');

// Linha que abre uma lista de escolhas logo abaixo (título + valor atual + seta)
function expander(title, current, fillList) {
  const wrap = h('div', 'am-group');
  const head = h('button', 'am-row');
  head.type = 'button';
  const text = h('span', 'am-text');
  const value = h('span', 'am-value', current);
  text.append(h('span', 'am-title', title), value);
  const arrow = icon('chevron-down', 18);
  head.append(text, arrow);
  const list = h('div', 'am-list');
  list.hidden = true;
  head.onclick = async () => {
    list.hidden = !list.hidden;
    head.classList.toggle('open', !list.hidden);
    if (!list.hidden) await fillList(list, (label) => { value.textContent = label; });
  };
  wrap.append(head, list);
  return wrap;
}

function option(label, selected, onPick) {
  const b = h('button', `am-option${selected ? ' on' : ''}`);
  b.type = 'button';
  b.append(h('span', 'am-radio'), h('span', '', label));
  b.onclick = onPick;
  return b;
}

function deviceExpander(kind, title, current, set) {
  return expander(title, '…', async (list, setValue) => {
    list.replaceChildren(h('div', 'am-hint', 'Carregando…'));
    let devices = await listDevices(kind);
    const paint = () => {
      list.replaceChildren();
      if (!devices.some((d) => d.label)) {
        const unlock = h('button', 'am-option', 'Permitir o microfone para ver os nomes');
        unlock.type = 'button';
        unlock.onclick = async () => {
          try {
            await unlockDeviceNames();
            devices = await listDevices(kind);
            paint();
            // App do computador até a 1.4.5: negava a consulta de permissão e os nomes nunca apareciam
            if (window.muvucaDesktop && !devices.some((d) => d.label)) {
              showBanner('Para escolher outro microfone, atualize o app do Muvuca (ele avisa quando a versão nova estiver pronta; se não avisar, feche e abra o app de novo).', { kind: 'info', timeout: 10000 });
            }
          } catch { showBanner('O navegador não deixou usar o microfone.', { timeout: 4000 }); }
        };
        list.append(unlock);
      }
      const choices = devices.some((d) => d.deviceId === 'default') ? devices : [{ deviceId: 'default', label: '' }, ...devices];
      for (const d of choices) {
        list.append(option(deviceName(d), d.deviceId === current(), async () => {
          await set(d.deviceId);
          setValue(deviceName(d));
          paint();
        }));
      }
    };
    paint();
  });
}

// Valor atual (nome do dispositivo) aparece assim que a lista de dispositivos chega
async function fillCurrent(group, kind, current) {
  const d = (await listDevices(kind)).find((x) => x.deviceId === current());
  group.querySelector('.am-value').textContent = d?.label ? deviceName(d) : 'Padrão do sistema';
}

function slider(title, value, max, onInput) {
  const box = h('div', 'am-slider');
  const label = h('div', 'am-slider-head');
  const num = h('span', 'am-slider-num', `${value}%`);
  label.append(h('span', 'am-title', title), num);
  const range = h('input');
  Object.assign(range, { type: 'range', min: 0, max, step: 1, value });
  const paint = () => { range.style.setProperty('--fill', `${(range.value / max) * 100}%`); num.textContent = `${range.value}%`; };
  range.oninput = () => { paint(); onInput(Number(range.value)); };
  paint();
  box.append(label, range);
  return box;
}

function settingsRow() {
  const b = h('button', 'am-row am-settings');
  b.type = 'button';
  b.append(icon('settings', 20), h('span', 'am-title', 'Configurações de voz'));
  b.onclick = () => { close(); openVoiceSettings(); };
  return b;
}

function micMenu() {
  const menu = h('div', 'audio-menu');
  const input = deviceExpander('audioinput', 'Dispositivo de entrada', micDevice, setMicDevice);
  fillCurrent(input, 'audioinput', micDevice);
  const profile = expander('Perfil de entrada', noiseAiOn() ? 'Isolamento de voz (IA)' : 'Padrão', (list, setValue) => {
    const paint = () => {
      list.replaceChildren(
        option('Isolamento de voz (IA)', noiseAiOn(), () => { setNoiseAi(true); setValue('Isolamento de voz (IA)'); paint(); }),
        option('Padrão', !noiseAiOn(), () => { setNoiseAi(false); setValue('Padrão'); paint(); }),
        h('div', 'am-hint', 'O isolamento tira ventilador, teclado e barulho de fundo.'));
    };
    paint();
  });
  menu.append(input, profile, h('div', 'am-sep'), slider('Volume de entrada', inputVolume(), 200, setInputVolume), h('div', 'am-sep'), settingsRow());
  return menu;
}

function speakerMenu() {
  const menu = h('div', 'audio-menu');
  if (canPickSpeaker()) {
    const out = deviceExpander('audiooutput', 'Dispositivo de saída', speakerDevice, setSpeakerDevice);
    fillCurrent(out, 'audiooutput', speakerDevice);
    menu.append(out, h('div', 'am-sep'));
  }
  menu.append(slider('Volume de saída', outputVolume(), 100, setOutputVolume), h('div', 'am-sep'), settingsRow());
  return menu;
}

function toggle(btn, build) {
  if (open?.btn === btn) return close();
  close();
  const menu = build();
  document.body.append(menu);
  const r = btn.getBoundingClientRect();
  const w = menu.offsetWidth;
  menu.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
  menu.style.bottom = `${innerHeight - r.top + 8}px`;
  btn.classList.add('on');
  open = { menu, btn };
  setTimeout(() => {
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
}

$('btn-mic-menu').onclick = (e) => { e.stopPropagation(); toggle($('btn-mic-menu'), micMenu); };
$('btn-deaf-menu').onclick = (e) => { e.stopPropagation(); toggle($('btn-deaf-menu'), speakerMenu); };
