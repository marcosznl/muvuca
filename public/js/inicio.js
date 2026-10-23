// Página inicial: quem abre o endereço do Muvuca sem estar logado vê um resumo do que é, com os caminhos
// para entrar pelo navegador e para baixar o app. Quem já tem conta, o app do computador e o Muvuca
// instalado na tela de início vão direto para a tela de entrada.
import { $, h } from './util.js';
import { showAuth, pendingInvite } from './auth.js';

const instalado = () => !!window.muvucaDesktop || matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// Mostra a página inicial? Só para quem chegou pelo navegador, sem convite no link
export const usaInicio = () => !instalado() && !pendingInvite();

const RECURSOS = [
  ['💬', 'Chat', 'Servidores com canais, respostas, reações, emojis, GIFs, anexos, enquetes e mensagens de voz. Conversas privadas e em grupo.'],
  ['🎙️', 'Calls', 'Voz com redução de ruído, câmera e transmissão de tela, com chat ao lado. Se a internet piscar, a call volta sozinha.'],
  ['🎮', 'Jogos', 'Stop, Desenha aí e Bomberman direto no navegador, com placar da semana.'],
  ['🏠', 'Num computador seu', 'Roda num Mac da turma: as conversas, fotos e contas ficam com vocês, sem anúncios.'],
];

export function showInicio({ onLoggedIn } = {}) {
  $('app').hidden = true;
  const root = $('auth');
  root.hidden = false;
  root.classList.add('inicio');
  root.replaceChildren();

  const entrar = (modo) => { root.classList.remove('inicio'); showAuth({ onLoggedIn, modo, voltar: () => showInicio({ onLoggedIn }) }); };

  const topo = h('header', 'inicio-topo');
  const marca = h('div', 'auth-brand');
  marca.append(h('span', 'auth-logo', 'M'), 'Muvuca');
  const jaTenho = h('button', 'btn inicio-entrar', 'Entrar');
  jaTenho.onclick = () => entrar('login');
  topo.append(marca, jaTenho);

  const hero = h('section', 'inicio-hero');
  const texto = h('div', 'inicio-texto');
  texto.append(
    h('h1', '', 'O lugar da turma conversar, entrar em call e jogar junto.'),
    h('p', '', 'Do jeito do Discord, em português, rodando num computador nosso.'),
  );
  const botoes = h('div', 'inicio-botoes');
  const web = h('button', 'btn primary inicio-btn', 'Abrir no navegador');
  web.onclick = () => entrar('login');
  const baixar = h('a', 'btn inicio-btn inicio-baixar', 'Baixar o app');
  baixar.href = '/baixar';
  botoes.append(web, baixar);
  const conta = h('p', 'inicio-conta');
  const criar = h('button', 'link', 'Criar uma conta');
  criar.onclick = () => entrar('register');
  conta.append('Ainda não tem conta? ', criar, ' com o código que a turma te passou.');
  texto.append(botoes, h('p', 'inicio-app', 'App para Mac e Windows, com notificações e "apertar para falar". No celular, abra no navegador e adicione à tela de início.'), conta);
  const print = h('img', 'inicio-print');
  print.src = '/inicio-chat.png';
  print.alt = 'O chat do Muvuca';
  print.loading = 'lazy';
  hero.append(texto, print);

  const lista = h('section', 'inicio-recursos');
  for (const [emoji, titulo, desc] of RECURSOS) {
    const card = h('div', 'inicio-recurso');
    card.append(h('div', 'inicio-emoji', emoji), h('h2', '', titulo), h('p', '', desc));
    lista.append(card);
  }

  const rodape = h('footer', 'inicio-rodape');
  const codigo = h('a', '', 'Código aberto no GitHub');
  codigo.href = 'https://github.com/marcosznl/muvuca';
  codigo.target = '_blank';
  codigo.rel = 'noopener';
  rodape.append(codigo, ' · quer um Muvuca para a sua turma? O passo a passo está lá.');

  const pagina = h('div', 'inicio-pagina');
  pagina.append(topo, hero, lista, rodape);
  root.append(pagina);
  web.focus();
}
