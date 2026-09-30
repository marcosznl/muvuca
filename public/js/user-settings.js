// Configurações (engrenagem lá embaixo, no lugar do antigo "sair"): tema, onde ficam os servidores,
// trocar senha e sair da conta
import { h, store } from './util.js';
import { openModal, button } from './dialogs.js';
import { THEMES, currentTheme, setTheme } from './theme.js';
import { openChangePassword } from './profile.js';

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

export function openUserSettings() {
  const content = h('div', 'screen-dialog user-settings');
  const THEME_HINT = { dark: 'Padrão', light: 'Fundo claro', auto: 'Segue o sistema' };
  content.append(
    group('Tema', choices(THEMES.map(([id, label]) => [id, label.replace(' (do sistema)', ''), THEME_HINT[id]]), currentTheme(), setTheme)),
    group('Servidores', choices(LAYOUTS, currentLayout(), setLayout)),
  );
  const account = h('div', 'user-settings-account');
  const password = button('Trocar senha', { kind: 'secondary' });
  const logoutBtn = button('Sair da conta', { kind: 'danger-outline' });
  account.append(password, logoutBtn);
  content.append(group('Conta', account));
  const modal = openModal({ title: 'Configurações', content });
  password.onclick = () => { modal.close(); openChangePassword(); };
  logoutBtn.onclick = async () => {
    modal.close();
    const { logout } = await import('./app.js');
    logout();
  };
}
