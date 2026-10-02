// Novidades (patch notes): o que mudou em cada versão do Muvuca. A lista fica em novidades-lista.js.
// Saiu versão nova que a pessoa ainda não viu: aviso no topo e uma bolinha na engrenagem.
import { h, store, showBanner } from './util.js';
import { openModal } from './dialogs.js';
import { NOVIDADES } from './novidades-lista.js';

const ultima = () => NOVIDADES[0]?.versao ?? null;
export const temNovidade = () => !!ultima() && store.get('novidadesVistas') !== ultima();

function marcarVistas() {
  store.set('novidadesVistas', ultima());
  document.getElementById('btn-settings')?.classList.remove('has-news');
}

const dataLonga = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });

export function openNovidades() {
  const vistas = store.get('novidadesVistas');
  const content = h('div', 'novidades');
  let antigas = false; // daqui para baixo, a pessoa já tinha visto
  for (const v of NOVIDADES) {
    if (v.versao === vistas) antigas = true;
    const bloco = h('section', 'novidade');
    const topo = h('div', 'novidade-topo');
    topo.append(h('h3', '', v.titulo || dataLonga(v.data)));
    if (vistas && !antigas) topo.append(h('span', 'novidade-nova', 'Nova'));
    if (v.titulo) topo.append(h('span', 'muted small', dataLonga(v.data)));
    const lista = h('ul');
    for (const item of v.itens) lista.append(h('li', '', item));
    bloco.append(topo, lista);
    content.append(bloco);
  }
  if (!NOVIDADES.length) content.append(h('p', 'muted', 'Nenhuma novidade por enquanto.'));
  openModal({ title: 'Novidades', subtitle: 'O que mudou em cada versão do Muvuca', content, wide: true });
  marcarVistas();
}

// Ao entrar: avisa uma vez por versão nova (quem nunca abriu as novidades também é avisado)
let avisado = false;
export function avisarNovidades() {
  if (!temNovidade()) return;
  document.getElementById('btn-settings')?.classList.add('has-news');
  if (avisado) return;
  avisado = true;
  showBanner(`O Muvuca foi atualizado: ${NOVIDADES[0].titulo || 'veja o que mudou'}. Toque aqui para ver as novidades.`,
    { kind: 'info', timeout: 12000, onClick: openNovidades });
}
