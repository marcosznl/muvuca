// Conferências de acesso: é membro? tem a permissão? o cargo está abaixo do seu?
import { db } from './store.js';
import { HttpError, fail, bearer } from './util.js';
import { computePerms, can, topPosition, canSeeChannel } from '../public/js/permissions.js';

export function requireServer(user, serverId) {
  const snap = db.snapshot(serverId);
  if (!snap || !snap.members.some((m) => m.id === user.id)) fail('Servidor não encontrado.');
  return { snap, perms: computePerms(snap, user.id), top: topPosition(snap, user.id) };
}

// Canal privado: quem não tem acesso é tratado como se o canal não existisse
export function requireChannelView(ctx, userId, channelId, message = 'Canal não encontrado.') {
  const channel = ctx.snap.channels.find((c) => c.id === channelId);
  if (!channel || !canSeeChannel(ctx.snap, userId, channel)) fail(message);
  return channel;
}

export function requireCategory(ctx, categoryId) {
  const cat = db.category(categoryId);
  if (!cat || cat.server_id !== ctx.snap.id) fail('Categoria não encontrada.');
  return cat;
}

export function requirePerm(ctx, flag, message = 'Você não tem permissão para isso.') {
  if (!can(ctx.perms, flag)) fail(message);
}

// Cargo abaixo do seu (o dono pode tudo)
export function requireBelow(ctx, position, message = 'Esse cargo está acima (ou no mesmo nível) do seu.') {
  if (!(position < ctx.top)) fail(message);
}

// Rotas HTTP: quem está logado (pelo token no cabeçalho)
export function requireUser(req) {
  const user = db.userBySession(bearer(req));
  if (!user) throw new HttpError(401, 'Sessão expirada, entre de novo.');
  return user;
}
