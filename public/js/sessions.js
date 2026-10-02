// "Aparelhos conectados" (Configurações → Conta): onde a conta está aberta, quando foi usada, e sair de um
// aparelho ou de todos os outros (sem precisar trocar a senha)
import { h, toast, showBanner } from './util.js';
import { openModal, button } from './dialogs.js';
import { request } from './net.js';

// "App do Muvuca 1.4.6 no Windows", "Chrome no Mac", "Muvuca instalado no iPhone"…
export function deviceName(s) {
  const ua = s.ua ?? '';
  const c = s.client ?? {};
  const os = c.platform || (/iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '');
  const on = os ? ` no ${os}` : '';
  if (c.app === 'desktop' || /Electron\//.test(ua)) return `App do Muvuca${c.version ? ` ${c.version}` : ''}${on}`;
  if (c.app === 'pwa') return `Muvuca instalado${on}`;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navegador';
  return `${browser}${on}`;
}

const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 90) return 'agora';
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return `há ${Math.round(s / 86400)} dias`;
};

export async function openSessions() {
  const list = h('div', 'sessions-list');
  const othersBtn = button('Sair de todos os outros aparelhos', { kind: 'danger-outline' });
  const paint = (sessions) => {
    list.replaceChildren(...sessions.map((s) => {
      const row = h('div', 'session-row');
      const info = h('div', 'session-info');
      const title = h('div', 'session-name', deviceName(s));
      if (s.current) title.append(h('span', 'session-here', 'este aparelho'));
      info.append(title, h('div', 'muted small', `${s.current ? 'Em uso agora' : `Último uso ${ago(s.lastSeen)}`}${s.ip ? ` · IP ${s.ip}` : ''} · entrou em ${new Date(s.createdAt).toLocaleDateString('pt-BR')}`));
      row.append(info);
      if (!s.current) {
        const out = button('Sair', { kind: 'secondary' });
        out.onclick = async () => {
          out.disabled = true;
          try { paint((await request({ t: 'sessions:end', id: s.id })).sessions); toast('Esse aparelho saiu da sua conta.'); } catch (err) { showBanner(err.message, { timeout: 4000 }); out.disabled = false; }
        };
        row.append(out);
      }
      return row;
    }));
    othersBtn.hidden = sessions.filter((s) => !s.current).length === 0;
  };
  othersBtn.onclick = async () => {
    if (!confirm('Sair de todos os outros aparelhos? Eles vão precisar entrar de novo com a senha.')) return;
    try {
      const r = await request({ t: 'sessions:end-others' });
      paint(r.sessions);
      toast(r.ended ? `${r.ended} ${r.ended === 1 ? 'aparelho saiu' : 'aparelhos saíram'} da sua conta.` : 'Nenhum outro aparelho conectado.');
    } catch (err) { showBanner(err.message, { timeout: 4000 }); }
  };
  const content = h('div', 'form');
  content.append(h('p', 'muted small', 'Onde sua conta está aberta. Não reconhece algum? Saia dele e troque a senha.'), list);
  openModal({ title: 'Aparelhos conectados', content, actions: [othersBtn] });
  try { paint((await request({ t: 'sessions:list' })).sessions); } catch (err) { list.replaceChildren(h('p', 'error', err.message)); }
}
