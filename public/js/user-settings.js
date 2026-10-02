// Configurações (engrenagem lá embaixo, no lugar do antigo "sair"): tema, onde ficam os servidores,
// trocar senha e sair da conta
import { h, store } from './util.js';
import { openModal, button } from './dialogs.js';
import { BASE_THEMES, COLOR_THEMES, currentTheme, setTheme, gradientOf } from './theme.js';
import { openChangePassword } from './profile.js';
import { enablePush, disablePush, pushEnabled } from './push.js';
import { openNovidades, temNovidade } from './novidades.js';

// ---------- Layout: servidores na coluna da esquerda (padrão) ou em abas no topo ----------
export const LAYOUTS = [['side', 'Na lateral', 'Coluna de ícones à esquerda'], ['top', 'No topo', 'Abas com o nome do servidor']];
export const currentLayout = () => store.get('layout') || 'side';

export function applyLayout() {
  document.getElementById('app')?.classList.toggle('layout-top', currentLayout() === 'top');
}

export async function setLayout(layout) {
  store.set('layout', layout === 'side' ? null : layout);
  applyLayout();
  const { renderRail } = await import('./sidebar.js');
  renderRail(); // no topo os servidores mostram o nome
}

applyLayout();

// Grupo de botões lado a lado (um escolhido)
function choices(options, current, onPick) {
  const seg = h('div', 'seg');
  const paint = (value) => { for (const b of seg.children) b.classList.toggle('selected', b.dataset.value === value); };
  for (const [value, label, hint] of options) {
    const b = h('button', 'seg-btn');
    b.type = 'button';
    b.dataset.value = value;
    b.append(h('strong', '', label));
    if (hint) b.append(h('span', '', hint));
    b.onclick = () => { onPick(value); paint(value); };
    seg.append(b);
  }
  paint(current);
  return seg;
}

const group = (title, ...content) => {
  const g = h('div', 'seg-group');
  g.append(h('span', 'field-label', title), ...content);
  return g;
};

// Escolha do tema (como no Discord): "mesmo do aparelho", temas padrão e temas coloridos em degradê.
// Muda na hora (dá para ver o resultado com a janela aberta) e vale em todos os seus aparelhos.
function themePicker() {
  const box = h('div', 'theme-picker');
  const auto = h('input');
  auto.type = 'checkbox';
  auto.className = 'switch';
  const autoRow = h('label', 'theme-auto');
  const autoText = h('div');
  autoText.append(h('div', 'perm-label', 'Mesmo tema do aparelho'), h('div', 'muted small', 'Claro ou escuro, igual ao do seu celular ou computador.'));
  autoRow.append(autoText, auto);
  const baseRow = h('div', 'theme-swatches');
  const colorRow = h('div', 'theme-swatches colors');
  const swatch = (id, name, paint) => {
    const b = h('button', 'theme-swatch');
    b.type = 'button';
    b.title = name;
    b.setAttribute('aria-label', `Tema ${name}`);
    b.dataset.theme = id;
    paint(b);
    b.onclick = () => { setTheme(id); refresh(); };
    return b;
  };
  for (const t of BASE_THEMES) baseRow.append(swatch(t.id, t.name, (b) => { b.style.background = t.swatch; }));
  for (const t of COLOR_THEMES) colorRow.append(swatch(`color:${t.id}`, t.name, (b) => { b.style.background = gradientOf(t.colors); }));
  const chosen = h('div', 'muted small theme-chosen');
  const refresh = () => {
    const cur = currentTheme();
    auto.checked = cur === 'auto';
    for (const b of box.querySelectorAll('.theme-swatch')) {
      b.classList.toggle('selected', b.dataset.theme === cur);
      b.setAttribute('aria-pressed', String(b.dataset.theme === cur));
    }
    const name = cur === 'auto' ? 'Mesmo do aparelho' : [...box.querySelectorAll('.theme-swatch')].find((b) => b.dataset.theme === cur)?.title;
    chosen.textContent = `Tema: ${name ?? 'Escuro'} · vale em todos os seus aparelhos`;
  };
  auto.onchange = () => {
    setTheme(auto.checked ? 'auto' : (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
    refresh();
  };
  box.append(autoRow, h('span', 'field-label', 'Temas padrão'), baseRow, h('span', 'field-label', 'Temas coloridos'), colorRow, chosen);
  refresh();
  return box;
}

let modalRef = null;
export function openUserSettings() {
  const content = h('div', 'screen-dialog user-settings');
  content.append(
    group('Tema', themePicker()),
    group('Servidores', choices(LAYOUTS, currentLayout(), setLayout)),
  );
  // Notificações deste aparelho (no app do computador elas já são as do próprio sistema)
  if (!window.muvucaDesktop) {
    const row = h('div', 'user-settings-account');
    const on = pushEnabled();
    const status = h('span', 'muted small', on ? 'Ativadas: menções, respostas, mensagens diretas e eventos.' : 'Desativadas neste aparelho.');
    const toggle = button(on ? 'Desativar' : 'Ativar notificações', { kind: on ? 'secondary' : 'primary' });
    toggle.onclick = async () => { await (on ? disablePush() : enablePush()); modalRef?.close(); };
    row.append(toggle, status);
    content.append(group('Notificações neste aparelho', row));
  }
  // Novidades: o que mudou em cada versão
  const news = h('div', 'user-settings-account');
  const newsBtn = button('Ver novidades', { kind: temNovidade() ? 'primary' : 'secondary' });
  news.append(newsBtn, h('span', 'muted small', temNovidade() ? 'Tem novidade que você ainda não viu.' : 'O que mudou em cada versão do Muvuca.'));
  content.append(group('Novidades', news));
  const account = h('div', 'user-settings-account');
  const password = button('Trocar senha', { kind: 'secondary' });
  const logoutBtn = button('Sair da conta', { kind: 'danger-outline' });
  account.append(password, logoutBtn);
  content.append(group('Conta', account));
  const modal = openModal({ title: 'Configurações', content });
  modalRef = modal;
  newsBtn.onclick = () => { modal.close(); openNovidades(); };
  password.onclick = () => { modal.close(); openChangePassword(); };
  logoutBtn.onclick = async () => {
    modal.close();
    const { logout } = await import('./app.js');
    logout();
  };
}
