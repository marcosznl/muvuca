// Ações do chat: histórico, enviar, editar, fixar e excluir mensagens
import { LIMITS, MSG_RATE } from '../config.js';
import { db } from '../store.js';
import { unum } from '../../db.js';
import { sendToServer, sendToUser } from '../realtime.js';
import { notify } from '../push.js';
import { linkPreview } from '../links.js';
import { requireServer, requirePerm } from '../guards.js';
import { claimAttachments, removeFiles } from '../attachments.js';
import { fail, underLimit } from '../util.js';
import { PERMS } from '../../public/js/permissions.js';

const MAX_PINS = 50;
const MAX_REACTION_KINDS = 20;
const CUSTOM_EMOJI = /^<a?:\w{2,32}:(e-[0-9a-f]{10})>$/;
const typingTimes = new Map(); // userId -> quando avisou que está digitando
const previewTimes = new Map(); // userId -> pedidos de prévia de link

// Texto curto para a notificação: menções viram @nome e emojis do servidor viram :nome:
function preview(text) {
  const plain = text.replace(/<@(u\d+)>/g, (_, id) => `@${db.userName(id)}`).replace(/<a?:(\w+):e-[0-9a-f]{10}>/g, ':$1:');
  return plain.length > 140 ? `${plain.slice(0, 139)}…` : plain || '📎 Anexo';
}

// Quem foi mencionado ou respondido recebe notificação no celular (se não estiver com o site aberto);
// na conversa privada, todo mundo da conversa recebe. Quem silenciou o canal/servidor não recebe.
function notifyMentions(msg, channel, ctx, user, original) {
  const dm = ctx.snap.kind === 'dm';
  const targets = new Set(dm ? ctx.snap.members.map((mem) => mem.id) : [...msg.text.matchAll(/<@(u\d+)>/g)].map((x) => x[1]));
  if (original?.user_id) targets.add(`u${original.user_id}`);
  targets.delete(user.id);
  for (const id of targets) {
    if (!ctx.snap.members.some((mem) => mem.id === id) || db.isMuted(id, channel.id, ctx.snap.id)) continue;
    notify(id, {
      title: dm ? (ctx.snap.members.length > 2 ? `${user.name} em ${ctx.snap.name}` : user.name) : `${user.name} em #${channel.name}`,
      body: preview(msg.text),
      url: `/?canal=${channel.id}`,
      tag: `canal-${channel.id}`,
    });
  }
}

// Canal com chat (texto ou música) de um servidor da pessoa
function requireChatChannel(user, channelId) {
  const channel = db.channel(channelId);
  if (!channel || channel.type === 'voice') fail('Canal não encontrado.');
  return { channel, ctx: requireServer(user, channel.server_id) };
}

// Mensagem (com o servidor dela) que a pessoa consegue ver
function requireMessage(user, id, { allowSystem = false } = {}) {
  const row = db.messageRow(id);
  if (!row || (row.system && !allowSystem)) fail('Mensagem não encontrada.');
  return { row, ctx: requireServer(user, row.server_id) };
}

export default {
  history(user, m) {
    const { channel } = requireChatChannel(user, m.channel);
    const page = db.messages(channel.id, Number(m.before) || undefined);
    return { t: 'history', channel: channel.id, ...page, older: !!m.before };
  },

  msg(user, m) {
    const { channel, ctx } = requireChatChannel(user, m.channel);
    requirePerm(ctx, PERMS.SEND_MESSAGES, 'Você não tem permissão para enviar mensagens aqui.');
    const text = String(m.text ?? '').trim().slice(0, LIMITS.msgLength);
    // Anexos já enviados por esta pessoa, para este canal, ainda sem mensagem
    const files = claimAttachments(m.attachments, user, channel.id);
    if (!text && !files.length) return;
    const now = Date.now();
    user.sent = (user.sent ?? []).filter((ts) => now - ts < MSG_RATE.windowMs);
    if (user.sent.length >= MSG_RATE.count) fail('Calma! Você está mandando mensagens rápido demais.');
    user.sent.push(now);
    // Responder: só a uma mensagem do mesmo canal
    const original = m.replyTo ? db.messageRow(m.replyTo) : null;
    const replyTo = original && original.channel_id === channel.id && !original.system ? original.id : null;
    const msg = db.addMessage({ channelId: channel.id, user, text, replyTo, files });
    db.markRead(user.id, channel.id, msg.id); // quem manda já leu tudo até aqui
    sendToServer(channel.server_id, { t: 'msg', msg });
    notifyMentions(msg, channel, ctx, user, replyTo ? original : null);
  },

  // Reação com emoji (liga ou desliga a sua)
  'msg:react'(user, m) {
    const { row, ctx } = requireMessage(user, m.id, { allowSystem: true });
    requirePerm(ctx, PERMS.SEND_MESSAGES, 'Você não tem permissão para reagir aqui.');
    const emoji = String(m.emoji ?? '');
    const custom = emoji.match(CUSTOM_EMOJI);
    if (custom ? !db.emoji(custom[1]) : !/^[^\sA-Za-z<>]{1,16}$/u.test(emoji)) fail('Emoji inválido.');
    const reactions = db.react(row.id, user.id, emoji, m.on !== false, MAX_REACTION_KINDS);
    if (!reactions) fail(`Essa mensagem já tem ${MAX_REACTION_KINDS} emojis diferentes.`);
    sendToServer(row.server_id, { t: 'msg:reactions', channel: row.channel_id, id: row.id, reactions });
  },

  // Enquete: pergunta, de 2 a 10 opções, escolha única ou múltipla
  'poll:create'(user, m) {
    const { channel, ctx } = requireChatChannel(user, m.channel);
    requirePerm(ctx, PERMS.SEND_MESSAGES, 'Você não tem permissão para enviar mensagens aqui.');
    const tidy = (t, n) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
    const question = tidy(m.question, 200);
    const options = (Array.isArray(m.options) ? m.options : []).map((o) => tidy(o, 80)).filter(Boolean).slice(0, 10);
    if (!question) fail('Escreva a pergunta.');
    if (options.length < 2) fail('Coloque pelo menos 2 opções.');
    const msg = db.addPoll({ channelId: channel.id, user, question, options, multi: !!m.multi });
    db.markRead(user.id, channel.id, msg.id);
    sendToServer(channel.server_id, { t: 'msg', msg });
  },

  'poll:vote'(user, m) {
    const { row, ctx } = requireMessage(user, m.id);
    requirePerm(ctx, PERMS.SEND_MESSAGES, 'Você não tem permissão para votar aqui.');
    const poll = row.meta ? JSON.parse(row.meta).poll : null;
    if (!poll) fail('Isso não é uma enquete.');
    if (poll.closed) fail('Essa enquete já foi encerrada.');
    const option = Number(m.option);
    if (!Number.isInteger(option) || option < 0 || option >= poll.options.length) fail('Opção inválida.');
    sendToServer(row.server_id, { t: 'msg:poll', channel: row.channel_id, id: row.id, votes: db.vote(row.id, user.id, option, poll.multi) });
  },

  // Encerrar: quem criou, ou quem gerencia mensagens
  'poll:close'(user, m) {
    const { row, ctx } = requireMessage(user, m.id);
    if (row.user_id !== unum(user.id)) requirePerm(ctx, PERMS.MANAGE_MESSAGES, 'Só quem criou pode encerrar a enquete.');
    const meta = row.meta ? JSON.parse(row.meta) : null;
    if (!meta?.poll) fail('Isso não é uma enquete.');
    meta.poll.closed = true;
    sendToServer(row.server_id, { t: 'msg:edit', msg: db.setMessageMeta(row.id, meta) });
  },

  // Leu até a mensagem `id` (as outras abas da pessoa também zeram o contador)
  read(user, m) {
    const { channel } = requireChatChannel(user, m.channel);
    const id = Number(m.id) || 0;
    db.markRead(user.id, channel.id, id);
    sendToUser(user.id, { t: 'read', channel: channel.id, id });
  },

  // "Fulano está digitando…" (o site manda no máximo a cada 3 s enquanto a pessoa digita)
  typing(user, m) {
    if (!underLimit(typingTimes, user.id, 1, 2000)) return;
    const { channel, ctx } = requireChatChannel(user, m.channel);
    requirePerm(ctx, PERMS.SEND_MESSAGES);
    for (const mem of ctx.snap.members) if (mem.id !== user.id) sendToUser(mem.id, { t: 'typing', channel: channel.id, userId: user.id });
  },

  // Prévia de um link (título, descrição e imagem da página)
  async 'link:preview'(user, m) {
    const url = String(m.url ?? '').slice(0, 500);
    if (!/^https?:\/\/[^\s]+$/i.test(url)) fail('Link inválido.');
    if (!underLimit(previewTimes, user.id, 30, 60_000)) fail('Muitas prévias de uma vez.');
    return { t: 'link', url, preview: await linkPreview(url) };
  },

  // Busca nas mensagens do servidor (de: alguém, em: um canal)
  search(user, m) {
    const ctx = requireServer(user, m.serverId);
    const text = String(m.text ?? '').trim().slice(0, 100);
    if (text.length < 2 && !m.from) fail('Digite pelo menos 2 letras.');
    const from = ctx.snap.members.some((x) => x.id === m.from) ? m.from : null;
    const channel = ctx.snap.channels.find((c) => c.id === m.channel && c.type !== 'voice');
    return { t: 'search', results: db.search(ctx.snap.id, { text, userId: from, channelId: channel?.id ?? null }) };
  },

  // Editar a própria mensagem
  'msg:edit'(user, m) {
    const { row, ctx } = requireMessage(user, m.id);
    if (row.user_id !== unum(user.id)) fail('Você só pode editar as suas mensagens.');
    if (row.meta && JSON.parse(row.meta).poll) fail('Enquete não dá para editar.');
    requirePerm(ctx, PERMS.SEND_MESSAGES, 'Você não tem permissão para enviar mensagens aqui.');
    const text = String(m.text ?? '').trim().slice(0, LIMITS.msgLength);
    if (!text) fail('A mensagem não pode ficar vazia (para apagar, use Excluir).');
    if (text === row.text) return;
    sendToServer(row.server_id, { t: 'msg:edit', msg: db.editMessage(row.id, text) });
  },

  // Fixar/desafixar (aparece na lista do pininho no topo do canal)
  'msg:pin'(user, m) {
    const { row, ctx } = requireMessage(user, m.id);
    requirePerm(ctx, PERMS.PIN_MESSAGES, 'Você não tem permissão para fixar mensagens.');
    const pin = !!m.pinned;
    if (pin === !!row.pinned_at) return;
    if (pin && db.countPins(row.channel_id) >= MAX_PINS) fail(`Este canal já tem ${MAX_PINS} mensagens fixadas. Desafixe alguma antes.`);
    sendToServer(row.server_id, { t: 'msg:edit', msg: db.pinMessage(row.id, pin) });
  },

  pins(user, m) {
    const { channel } = requireChatChannel(user, m.channel);
    return { t: 'pins', channel: channel.id, messages: db.pinnedMessages(channel.id) };
  },

  // Apagar: a própria mensagem, ou a de outros com "Gerenciar mensagens" (os anexos vão junto)
  'msg:delete'(user, m) {
    const { row, ctx } = requireMessage(user, m.id, { allowSystem: true });
    if (row.user_id !== unum(user.id)) requirePerm(ctx, PERMS.MANAGE_MESSAGES, 'Você não tem permissão para apagar mensagens de outras pessoas.');
    const files = db.filesOfMessage(row.id);
    db.deleteMessage(row.id);
    removeFiles(files).catch(() => {});
    sendToServer(row.server_id, { t: 'msg:delete', channel: row.channel_id, id: row.id });
  },
};
