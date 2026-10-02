// Novidades do Muvuca (patch notes), da mais nova para a mais antiga. Aparecem em Configurações → Novidades.
// Publicou algo que o pessoal vai notar? Acrescente no topo uma versão nova (ou itens na do dia).
// Texto simples, para quem usa: o que mudou para a pessoa, sem termos técnicos.
//   versao: identifica a versão (a data; se sair mais de uma no mesmo dia, "2026-10-02b")
//   data:   dia da publicação (AAAA-MM-DD)
//   titulo: resumo em poucas palavras (opcional)
//   itens:  o que mudou, um por linha
export const NOVIDADES = [
  {
    versao: '2026-10-02',
    data: '2026-10-02',
    titulo: 'Temas coloridos, chat ao lado da call e janela flutuante',
    itens: [
      'Recarregou a página no meio da call? Você volta sozinho para a mesma call, como no Discord. E se a voz cair (internet, reinício), ela reconecta sozinha.',
      'Temas novos em Configurações → Tema: claro, escuro, mais escuro, preto e 22 temas coloridos em degradê (Menta, Crepúsculo, Oceano, Aurora…). Cada pessoa escolhe o seu, e ele vale em todos os seus aparelhos.',
      'Live e câmera numa janelinha flutuante: em call, dá para ir para o chat, outro servidor ou os jogos e continuar vendo a transmissão no canto da tela. Dá para arrastar, trocar de pessoa nas setas, abrir a call com um toque ou soltar a janela por cima de outros programas.',
      'Live com câmeras por cima: quando alguém transmite a tela, escolha onde ficam os participantes (Embaixo, Sobre a tela ou Ocultar). "Sobre a tela" deixa a live grande e as câmeras ligadas em miniatura no canto.',
      'Chat ao lado da call: o botão de balão nos controles da call divide a tela entre a call e um canal de texto (dá para escolher qual e arrastar a divisória). No celular fica um embaixo do outro.',
      'Editar perfil: a foto e o banner novos só valem quando você clica em Salvar. Cancelou ou fechou, nada muda.',
      'App do computador 1.4.6: a lista de microfones e saídas de som volta a aparecer (antes só mostrava "Padrão do sistema"), e o app gasta menos bateria e processador quando fica escondido sem call. O app se atualiza sozinho.',
      'Nova aba Novidades (aqui!): tudo o que mudou em cada versão do Muvuca.',
      'Mensagens chegam mais rápido para todo mundo, com menos esforço do servidor.',
      'A voz continua funcionando em redes mais fechadas (4G, trabalho) mesmo depois de meses sem reiniciar o servidor.',
    ],
  },
  {
    versao: '2026-10-01',
    data: '2026-10-01',
    titulo: 'Passar a posse do servidor',
    itens: [
      'O dono de um servidor pode passar a posse para outra pessoa.',
      'App do computador: "Abrir original" da foto abre no navegador.',
    ],
  },
  {
    versao: '2026-09-30',
    data: '2026-09-30',
    titulo: 'Canais privados, eventos e @todos',
    itens: [
      'Canais privados: só os cargos escolhidos enxergam.',
      'Modo lento nos canais e filtro de palavras no servidor.',
      'Eventos agendados com lembrete e lista de quem vai.',
      'Menção @todos e menção de cargos (com permissão própria).',
      'Cada pessoa arruma a ordem dos próprios servidores na coluna, arrastando (vale em todos os aparelhos).',
      'Apelido por servidor.',
      'Configurações novas: tema, servidores na lateral ou no topo e conta.',
      'Avisos no celular (notificações) de menções, respostas, mensagens diretas e eventos.',
      'Banner do perfil maior (até 10 MB).',
      'Live com qualidade fixa e o site abrindo mais rápido.',
    ],
  },
  {
    versao: '2026-09-29',
    data: '2026-09-29',
    titulo: 'XP, perfil novo e call em 2 aparelhos',
    itens: [
      'XP da conta: barra de progresso e níveis, ganhando com mensagens, tempo em call e jogos.',
      'Cartão de perfil novo, mais compacto, com status e balão de pensamento.',
      'Dá para entrar na call com 2 aparelhos na mesma conta (o segundo só com câmera ou tela).',
      'Mover alguém para outra call (com permissão).',
      'Comando /limpar para apagar as últimas mensagens (moderação).',
      'Aviso quando o microfone está mudo e correção do microfone que ficava sem som.',
      'Mutar e desmutar não troca mais as pessoas de lugar na lista da call.',
      'Live limitada a 1080p e 30 FPS, mais estável.',
      'Agar: dividir, soltar massa, vírus, minimapa e modo equipes.',
      'Bomberman: robôs, mapas, morte súbita, itens novos e série de partidas.',
    ],
  },
];
