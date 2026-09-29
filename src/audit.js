// Auditoria: registra ações de conta, segurança e gerenciamento (ver audit-labels.js) para o painel.
// Os nomes (servidor, canal, pessoa, cargo) são gravados na hora: continuam legíveis mesmo se a
// coisa for apagada depois.
import { db } from './store.js';
import { AUDIT_LABELS } from './audit-labels.js';

const KEEP_DAYS = 180;
const TEXT_KEYS = ['count', 'name', 'topic', 'word', 'code', 'expiresIn', 'maxUses', 'color', 'type', 'bitrate', 'userLimit', 'pinned', 'on'];

const short = (v, n = 80) => (typeof v === 'string' ? (v.length > n ? `${v.slice(0, n)}…` : v) : v);

// Monta o "o quê" antes da ação rodar (depois de apagar, não daria mais para saber o nome)
function describe(user, m) {
  const d = {};
  let serverId = m.serverId ?? null;
  // Ações sobre uma mensagem (ex.: fixar) só trazem o id dela: o canal e o servidor vêm da mensagem
  const msgRow = m.t?.startsWith('msg:') && m.id !== undefined && m.t !== 'msg:purge' ? db.messageRow(m.id) : null;
  const channelId = m.channelId ?? (m.t === 'msg:purge' ? m.channel : null);
  const channel = channelId ? db.channel(channelId) : msgRow ? db.channel(msgRow.channel_id) : null;
  if (msgRow) { d.autor = msgRow.author_name; d.pinned = !!m.pinned; }
  if (channel) { d.canal = channel.name; serverId ??= channel.server_id; }
  if (m.roleId) { const r = db.role(m.roleId); if (r) { d.cargo = r.name; serverId ??= r.server_id; } }
  if (m.categoryId) { const c = db.category(m.categoryId); if (c) { d.categoria = c.name; serverId ??= c.server_id; } }
  if (m.emojiId) { const e = db.emoji(m.emojiId); if (e) { d.emoji = e.name; serverId ??= e.server_id; } }
  if (m.soundId) { const s = db.sound(m.soundId); if (s) { d.som = s.name; serverId ??= s.server_id; } }
  if (m.userId) { const u = db.userById(m.userId); if (u) d.pessoa = u.username; }
  if (Array.isArray(m.roleIds)) d.cargos = m.roleIds.map((id) => db.role(id)?.name ?? id).slice(0, 20);
  for (const k of TEXT_KEYS) if (m[k] !== undefined && typeof m[k] !== 'object') d[k] = short(m[k]);
  if (m.bio !== undefined) d.bio = short(m.bio, 60);
  const server = serverId ? db.server(serverId) : null;
  if (server) d.servidor = server.kind === 'dm' ? 'mensagem direta' : server.name;
  return { serverId: server?.id ?? serverId, detail: d, dm: server?.kind === 'dm' };
}

// Ações do WebSocket: devolve a função que grava depois (só se a ação deu certo)
export function auditAction(user, m, ip) {
  let action = m.t;
  if (action === 'msg:delete') {
    // Só interessa quando alguém apaga mensagem de OUTRA pessoa (moderação), e nunca em conversa privada
    const row = db.messageRow(m.id);
    if (!row || String(row.user_id) === String(user.id).slice(1)) return null;
    const server = db.server(row.server_id);
    if (!server || server.kind === 'dm') return null;
    const channel = db.channel(row.channel_id);
    const detail = { servidor: server.name, canal: channel?.name, autor: row.author_name, texto: short(row.text, 120) };
    return () => db.audit({ userId: user.id, userName: user.username, action: 'msg:delete:other', serverId: server.id, detail, ip });
  }
  if (!AUDIT_LABELS[action] || action.startsWith('auth:') || action.startsWith('painel:')) return null;
  const { serverId, detail, dm } = describe(user, m);
  if (dm && action !== 'server:leave') return null; // conversa privada: fora da auditoria
  if (action.startsWith('msg:') && !serverId) return null; // sem saber onde foi: na dúvida, não registra
  return () => db.audit({ userId: user.id, userName: user.username, action, serverId, detail, ip });
}

// Eventos de fora do WebSocket (login, cadastro, senha, voz)
export function audit(action, { user = null, userName = null, detail = null, ip = null, ok = true, serverId = null } = {}) {
  try {
    db.audit({ userId: user?.id ?? null, userName: user?.username ?? userName, action, serverId, detail, ip, ok });
  } catch (err) {
    console.error('auditoria:', err.message); // nunca derruba a ação por causa do registro
  }
}

export const purgeAudit = () => db.purgeAudit(Date.now() - KEEP_DAYS * 86_400_000);
