// Ações de cargos e membros: criar, editar, reorganizar, dar cargos e expulsar
import { LIMITS } from '../config.js';
import { announceLeave } from '../welcome.js';
import { db } from '../store.js';
import { sendToUser, pushServer } from '../realtime.js';
import { requireServer, requirePerm, requireBelow } from '../guards.js';
import { syncVoicePermissions } from '../voice.js';
import { fail, clean, validColor } from '../util.js';
import { PERMS, ALL_PERMS, can, topPosition } from '../../public/js/permissions.js';

const NO_PERM = 'Você não tem permissão para gerenciar cargos.';

// Cargo (que não seja o @everyone, se `movable`) de um servidor da pessoa, com "Gerenciar cargos"
function manageRole(user, roleId, { movable = false, message = 'Cargo não encontrado.' } = {}) {
  const role = db.role(roleId);
  if (!role || (movable && role.is_default)) fail(message);
  const ctx = requireServer(user, role.server_id);
  requirePerm(ctx, PERMS.MANAGE_ROLES, NO_PERM);
  return { role, ctx };
}

// Cargos (sem o @everyone) do mais baixo para o mais alto
const rolesUpward = (ctx) => ctx.snap.roles.filter((r) => !r.isDefault).sort((a, b) => a.position - b.position);

// A pessoa-alvo tem cargo abaixo do seu?
const isBelow = (ctx, targetId) => topPosition(ctx.snap, targetId) < ctx.top;

async function changed(ctx) {
  pushServer(ctx.snap.id);
  await syncVoicePermissions(ctx.snap.id); // quem está na voz ganha/perde microfone e vídeo na hora
}

export default {
  'role:create'(user, m) {
    const ctx = requireServer(user, m.serverId);
    requirePerm(ctx, PERMS.MANAGE_ROLES, NO_PERM);
    if (db.roleCount(ctx.snap.id) >= LIMITS.roles) fail(`Limite de ${LIMITS.roles} cargos.`);
    const id = db.createRole(ctx.snap.id, { name: clean(m.name, LIMITS.roleName) || 'novo cargo' });
    pushServer(ctx.snap.id);
    return { t: 'role:created', serverId: ctx.snap.id, roleId: id };
  },

  async 'role:update'(user, m) {
    const { role, ctx } = manageRole(user, m.roleId);
    if (!role.is_default) requireBelow(ctx, role.position);
    // Ninguém dá permissões que não tem (a não ser administradores)
    const permissions = Number(m.permissions) & ALL_PERMS;
    if (!can(ctx.perms, PERMS.ADMINISTRATOR)) {
      const diff = permissions ^ role.permissions;
      if (diff & ~ctx.perms) fail('Você não pode dar ou tirar permissões que você mesmo não tem.');
    }
    const name = role.is_default ? '@everyone' : clean(m.name, LIMITS.roleName) || role.name;
    const color = role.is_default ? null : validColor(m.color) === undefined ? role.color : validColor(m.color);
    db.updateRole(role.id, { name, color, permissions });
    await changed(ctx);
  },

  async 'role:delete'(user, m) {
    const { role, ctx } = manageRole(user, m.roleId, { movable: true, message: 'Esse cargo não pode ser excluído.' });
    requireBelow(ctx, role.position);
    db.deleteRole(role.id);
    await changed(ctx);
  },

  // Setas: troca de lugar com o vizinho de cima/baixo
  'role:move'(user, m) {
    const { role, ctx } = manageRole(user, m.roleId, { movable: true, message: 'Esse cargo não pode ser movido.' });
    const sorted = rolesUpward(ctx);
    const i = sorted.findIndex((r) => r.id === role.id);
    const other = sorted[m.dir === 'up' ? i + 1 : i - 1];
    if (!other) return;
    requireBelow(ctx, Math.max(role.position, other.position));
    db.swapRoles(role, other);
    pushServer(ctx.snap.id);
  },

  // Arrastar um cargo na lista: `position` é o lugar novo (1 = logo acima do @everyone)
  'role:reorder'(user, m) {
    const { role, ctx } = manageRole(user, m.roleId, { movable: true, message: 'Esse cargo não pode ser movido.' });
    const sorted = rolesUpward(ctx);
    const target = Math.max(1, Math.min(sorted.length, Math.round(Number(m.position)) || 1));
    // Só mexe em cargos abaixo do seu, e não pode levar um cargo até o seu nível (ou acima)
    requireBelow(ctx, role.position);
    // Seu cargo mais alto, contado na mesma escala (1..n) do lugar novo (as posições podem ter buracos)
    const myIndex = ctx.top === Infinity ? Infinity : sorted.filter((r) => r.position <= ctx.top).length;
    if (!(target < myIndex)) fail('Você não pode colocar um cargo no nível do seu (ou acima).');
    const ids = sorted.map((r) => r.id).filter((id) => id !== role.id);
    ids.splice(target - 1, 0, role.id);
    db.setRoleOrder(ids);
    changed(ctx).catch(() => {});
  },

  async 'member:roles'(user, m) {
    const ctx = requireServer(user, m.serverId);
    requirePerm(ctx, PERMS.MANAGE_ROLES, 'Você não tem permissão para dar cargos.');
    const target = ctx.snap.members.find((x) => x.id === m.userId);
    if (!target) fail('Membro não encontrado.');
    if (target.id !== user.id && !isBelow(ctx, target.id)) fail('Esse membro tem cargo igual ou acima do seu.');
    const valid = new Map(ctx.snap.roles.filter((r) => !r.isDefault).map((r) => [r.id, r]));
    const wanted = [...new Set((m.roleIds ?? []).map(String))].filter((id) => valid.has(id));
    const diff = [...wanted.filter((id) => !target.roles.includes(id)), ...target.roles.filter((id) => !wanted.includes(id))];
    for (const id of diff) requireBelow(ctx, valid.get(id).position, `O cargo "${valid.get(id).name}" está acima do seu.`);
    db.setMemberRoles(ctx.snap.id, target.id, wanted);
    await changed(ctx);
  },

  // Apelido no servidor (moderação): só quem gerencia apelidos, em quem tem cargo abaixo do seu.
  // Vazio tira o apelido (volta o nome da conta). O dono pode mudar o próprio.
  'member:nick'(user, m) {
    const ctx = requireServer(user, m.serverId);
    if (ctx.snap.kind === 'dm') fail('Conversa privada não tem apelido.');
    requirePerm(ctx, PERMS.MANAGE_NICKNAMES, 'Você não tem permissão para mudar apelidos.');
    const target = ctx.snap.members.find((x) => x.id === m.userId);
    if (!target) fail('Membro não encontrado.');
    if (target.id !== user.id) {
      if (target.id === ctx.snap.ownerId) fail('O apelido do dono só ele pode mudar.');
      if (!isBelow(ctx, target.id)) fail('Esse membro tem cargo igual ou acima do seu.');
    }
    const nick = clean(m.nick ?? '', 32);
    if ((nick || null) === (target.nick || null)) return;
    db.setNick(ctx.snap.id, target.id, nick === target.globalName ? '' : nick);
    pushServer(ctx.snap.id);
  },

  async 'member:kick'(user, m) {
    const ctx = requireServer(user, m.serverId);
    requirePerm(ctx, PERMS.KICK_MEMBERS, 'Você não tem permissão para expulsar membros.');
    const target = ctx.snap.members.find((x) => x.id === m.userId);
    if (!target || target.id === user.id) fail('Membro não encontrado.');
    if (target.id === ctx.snap.ownerId) fail('O dono não pode ser expulso.');
    if (!isBelow(ctx, target.id)) fail('Esse membro tem cargo igual ou acima do seu.');
    db.removeMember(ctx.snap.id, target.id);
    sendToUser(target.id, { t: 'server:removed', serverId: ctx.snap.id, reason: `Você foi removido do servidor ${ctx.snap.name}.` });
    await changed(ctx);
    announceLeave(ctx.snap.id, target);
  },
};
