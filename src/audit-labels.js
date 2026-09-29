// Nomes das ações registradas na auditoria (usado pelo servidor e pelo painel administrativo).
// Só entram ações de conta, segurança e gerenciamento; conversa do dia a dia (mandar ou editar
// mensagem, mensagens diretas, ligações) não é registrada.
export const AUDIT_LABELS = {
  // Contas e acesso
  'auth:login': 'Entrou na conta',
  'auth:login:fail': 'Errou a senha',
  'auth:register': 'Criou a conta',
  'auth:register:fail': 'Cadastro recusado (convite inválido)',
  'auth:password': 'Trocou a senha',
  'auth:password:fail': 'Errou a senha atual ao trocar',
  'auth:logout': 'Saiu da conta',
  'voice:join': 'Entrou em canal de voz',
  // Servidores
  'server:create': 'Criou servidor',
  'server:update': 'Editou servidor',
  'server:delete': 'Apagou servidor',
  'server:leave': 'Saiu do servidor',
  'server:welcome': 'Mudou as boas-vindas',
  'server:icon:remove': 'Tirou o ícone do servidor',
  'invite:create': 'Criou convite',
  'invite:revoke': 'Revogou convite',
  'invite:accept': 'Entrou por convite',
  // Cargos e membros
  'role:create': 'Criou cargo',
  'role:update': 'Editou cargo',
  'role:delete': 'Apagou cargo',
  'role:move': 'Reordenou cargos',
  'role:reorder': 'Reordenou cargos',
  'member:roles': 'Mudou cargos de membro',
  'member:kick': 'Expulsou membro',
  // Canais
  'channel:create': 'Criou canal',
  'channel:rename': 'Renomeou canal',
  'channel:delete': 'Apagou canal',
  'channel:settings': 'Mudou ajustes do canal',
  'channel:topic': 'Mudou o tópico do canal',
  'channel:move': 'Moveu canal',
  'category:create': 'Criou categoria',
  'category:rename': 'Renomeou categoria',
  'category:delete': 'Apagou categoria',
  'category:move': 'Moveu categoria',
  // Conteúdo e moderação
  'msg:delete:other': 'Apagou mensagem de outra pessoa',
  'msg:pin': 'Fixou/desafixou mensagem',
  'emoji:rename': 'Renomeou emoji',
  'emoji:delete': 'Apagou emoji',
  'sound:delete': 'Apagou som',
  'music:kick': 'Tirou alguém da cabine de música',
  'game:word:add': 'Adicionou palavra no Desenha aí',
  'game:word:remove': 'Tirou palavra do Desenha aí',
  // Perfil
  'profile:update': 'Editou o perfil',
  'avatar:remove': 'Tirou a foto de perfil',
  'banner:remove': 'Tirou o banner',
  // Painel administrativo
  'painel:login': 'Entrou no painel',
  'painel:login:fail': 'Errou o login do painel',
  'painel:logout': 'Saiu do painel',
  'painel:restart': 'Reiniciou o servidor pelo painel',
  'painel:backup': 'Fez backup pelo painel',
  // Minecraft (pelo painel)
  'painel:mc:start': 'Ligou servidor de Minecraft',
  'painel:mc:stop': 'Desligou servidor de Minecraft',
  'painel:mc:restart': 'Reiniciou servidor de Minecraft',
  'painel:mc:autostop': 'Minecraft desligou sozinho (vazio)',
  'painel:mc:wake': 'Minecraft acordado por jogador',
  'painel:mc:backup': 'Backup de mundo do Minecraft',
  'painel:mc:cmd': 'Comando no console do Minecraft',
  'painel:mc:settings': 'Mudou configurações do Minecraft',
};

// Grupos para o filtro do painel
export const AUDIT_GROUPS = {
  seguranca: ['auth:login:fail', 'auth:register:fail', 'auth:password', 'auth:password:fail', 'painel:login', 'painel:login:fail', 'painel:logout'],
  contas: ['auth:login', 'auth:register', 'auth:logout', 'auth:password', 'voice:join'],
  moderacao: ['member:kick', 'member:roles', 'msg:delete:other', 'msg:pin', 'music:kick', 'emoji:delete', 'sound:delete', 'invite:revoke'],
  painel: ['painel:login', 'painel:login:fail', 'painel:logout', 'painel:restart', 'painel:backup'],
  minecraft: ['painel:mc:start', 'painel:mc:stop', 'painel:mc:restart', 'painel:mc:autostop', 'painel:mc:wake', 'painel:mc:backup', 'painel:mc:cmd', 'painel:mc:settings'],
};
