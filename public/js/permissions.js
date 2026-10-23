// Permissões dos cargos (compartilhado entre o servidor Node e o site)

export const PERMS = {
  ADMINISTRATOR: 1 << 0,   // tudo liberado
  MANAGE_SERVER: 1 << 1,   // nome/cor do servidor
  MANAGE_CHANNELS: 1 << 2, // criar, renomear e excluir canais
  MANAGE_ROLES: 1 << 3,    // criar/editar cargos e dar cargos a membros
  CREATE_INVITE: 1 << 4,
  KICK_MEMBERS: 1 << 5,
  SEND_MESSAGES: 1 << 6,
  CONNECT: 1 << 7,         // entrar nos canais de voz
  SPEAK: 1 << 8,           // usar o microfone
  VIDEO: 1 << 9,           // câmera e transmissão de tela
  // 1 << 10 e 1 << 11 eram "tocar como DJ" e "gerenciar música" (o Assistir Junto saiu): não reaproveitar
  MANAGE_EMOJIS: 1 << 12,  // enviar, renomear e excluir os emojis do servidor
  MANAGE_MESSAGES: 1 << 13, // apagar mensagens de outras pessoas
  PIN_MESSAGES: 1 << 14,    // fixar e desafixar mensagens
  MOVE_MEMBERS: 1 << 15,    // mover alguém de um canal de voz para outro
  MANAGE_NICKNAMES: 1 << 16, // mudar o apelido de membros dentro do servidor
  // 1 << 17 era "gerenciar eventos" (os eventos saíram): não reaproveitar, cargos antigos ainda têm o bit
  MENTION_EVERYONE: 1 << 18, // @todos e @cargo avisam as pessoas
};

export const ALL_PERMS = Object.values(PERMS).reduce((a, b) => a | b, 0);

// Padrão do cargo @everyone: conversar, falar, transmitir e convidar (sem gerenciar nada)
export const DEFAULT_PERMS = PERMS.CREATE_INVITE | PERMS.SEND_MESSAGES | PERMS.CONNECT | PERMS.SPEAK | PERMS.VIDEO | PERMS.PIN_MESSAGES;

// Textos da tela de cargos, na ordem em que aparecem
export const PERM_INFO = [
  ['ADMINISTRATOR', 'Administrador', 'Todas as permissões. Use com cuidado.'],
  ['MANAGE_SERVER', 'Gerenciar servidor', 'Mudar nome e cor do servidor.'],
  ['MANAGE_CHANNELS', 'Gerenciar canais', 'Criar, renomear e excluir canais de texto e voz.'],
  ['MANAGE_ROLES', 'Gerenciar cargos', 'Criar e editar cargos abaixo do seu e dar cargos aos membros.'],
  ['CREATE_INVITE', 'Criar convite', 'Gerar links de convite para o servidor.'],
  ['KICK_MEMBERS', 'Expulsar membros', 'Remover membros com cargo abaixo do seu.'],
  ['SEND_MESSAGES', 'Enviar mensagens', 'Escrever nos canais de texto.'],
  ['CONNECT', 'Conectar', 'Entrar nos canais de voz.'],
  ['SPEAK', 'Falar', 'Usar o microfone nos canais de voz.'],
  ['VIDEO', 'Vídeo', 'Ligar a câmera e transmitir a tela.'],
  ['MANAGE_EMOJIS', 'Gerenciar emojis', 'Enviar, renomear e excluir os emojis personalizados do servidor.'],
  ['MANAGE_MESSAGES', 'Gerenciar mensagens', 'Apagar mensagens de outras pessoas nos canais de texto.'],
  ['PIN_MESSAGES', 'Fixar mensagens', 'Fixar e desafixar mensagens no topo do canal.'],
  ['MOVE_MEMBERS', 'Mover membros', 'Levar alguém que está numa call para outro canal de voz do servidor.'],
  ['MANAGE_NICKNAMES', 'Gerenciar apelidos', 'Mudar o nome com que um membro (de cargo abaixo do seu) aparece neste servidor.'],
  ['MENTION_EVERYONE', 'Mencionar @todos e cargos', 'Usar @todos (avisa todo mundo do canal) e mencionar cargos (avisa quem tem o cargo).'],
];

// Permissões efetivas de um usuário num servidor (snapshot enviado pelo servidor)
export function computePerms(server, userId) {
  if (!server) return 0;
  if (server.ownerId === userId) return ALL_PERMS;
  const member = server.members.find((m) => m.id === userId);
  if (!member) return 0;
  let perms = 0;
  for (const role of server.roles) {
    if (role.isDefault || member.roles.includes(role.id)) perms |= role.permissions;
  }
  return perms & PERMS.ADMINISTRATOR ? ALL_PERMS : perms;
}

export const can = (perms, flag) => (perms & flag) === flag;

// Canal privado: só o dono, administradores e quem tem um dos cargos escolhidos enxergam (e entram).
export function canSeeChannel(server, userId, channel) {
  if (!channel?.private) return true;
  if (!server || server.ownerId === userId) return true;
  if (can(computePerms(server, userId), PERMS.ADMINISTRATOR)) return true;
  const member = server.members.find((m) => m.id === userId);
  return !!member && (channel.roles ?? []).some((r) => member.roles.includes(r));
}

// O servidor como aquela pessoa enxerga: sem os canais privados dela não ter acesso
export function serverViewFor(server, userId) {
  if (!server || !server.channels.some((c) => c.private)) return server;
  return { ...server, channels: server.channels.filter((c) => canSeeChannel(server, userId, c)) };
}

// Posição do cargo mais alto (o dono fica acima de todos)
export function topPosition(server, userId) {
  if (server.ownerId === userId) return Infinity;
  const member = server.members.find((m) => m.id === userId);
  if (!member) return -1;
  return Math.max(0, ...server.roles.filter((r) => member.roles.includes(r.id)).map((r) => r.position));
}

// Cargo mais alto que tem cor: define a cor do nome no chat e na lista de membros
export function nameColor(server, userId) {
  const member = server?.members.find((m) => m.id === userId);
  if (!member) return null;
  const colored = server.roles
    .filter((r) => !r.isDefault && r.color && member.roles.includes(r.id))
    .sort((a, b) => b.position - a.position);
  return colored[0]?.color ?? null;
}
