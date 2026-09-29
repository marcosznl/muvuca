// Contas: cadastro e login (HTTP), com limite de tentativas por IP
import { ACCESS_PASSWORD, OWNER_USERNAME } from './config.js';
import { db, HOME_SERVER } from './store.js';
import { announceJoin } from './welcome.js';
import { pushServer } from './realtime.js';
import { HttpError, readBody, sameSecret, clean, clientIp, sleep, bearer } from './util.js';
import { sockets } from './realtime.js';
import { audit } from './audit.js';

// Limite de tentativas de login/cadastro por IP (evita adivinhar senhas)
const authFails = new Map(); // ip -> { count, until }

function checkAuthRate(ip) {
  const f = authFails.get(ip);
  if (f && f.until > Date.now()) throw new HttpError(429, 'Muitas tentativas. Espere um minuto e tente de novo.');
}

async function authFailed(ip, message) {
  const f = authFails.get(ip) ?? { count: 0, until: 0 };
  f.count++;
  if (f.count >= 5) { f.until = Date.now() + 60_000; f.count = 0; }
  authFails.set(ip, f);
  await sleep(800);
  throw new HttpError(401, message);
}

// Limite por conta (vale de qualquer IP): 10 erros seguidos = espera de 1 min, dobrando até 15 min.
// Assim ninguém fica tentando senhas de uma conta trocando de IP.
const accountFails = new Map(); // usuário -> { count, until, lockMs }
function checkAccountRate(username) {
  const f = accountFails.get(username);
  if (f && f.until > Date.now()) throw new HttpError(429, 'Muitas tentativas nessa conta. Espere alguns minutos e tente de novo.');
}
function accountFailed(username) {
  const f = accountFails.get(username) ?? { count: 0, until: 0, lockMs: 30_000 };
  f.count++;
  if (f.count >= 10) { f.lockMs = Math.min(f.lockMs * 2, 15 * 60_000); f.until = Date.now() + f.lockMs; f.count = 0; }
  accountFails.set(username, f);
}

export function cleanupAuthFails() {
  for (const [name, f] of accountFails) if (f.until < Date.now() - 3_600_000) accountFails.delete(name);
  for (const [ip, f] of authFails) if (f.until < Date.now() && f.count === 0) authFails.delete(ip);
}

// POST /api/register
export async function register(req) {
  const ip = clientIp(req);
  checkAuthRate(ip);
  const body = await readBody(req);
  const username = String(body.username ?? '').trim();
  const displayName = clean(body.name, 32) || username;
  const password = String(body.password ?? '');
  const invite = String(body.invite ?? '').trim();

  if (!/^[a-zA-Z0-9_.]{3,20}$/.test(username)) {
    throw new HttpError(400, 'O usuário deve ter de 3 a 20 caracteres: letras, números, ponto ou _.');
  }
  if (password.length < 6 || password.length > 200) throw new HttpError(400, 'A senha deve ter pelo menos 6 caracteres.');

  // Só entra quem tem o código de acesso ou um convite válido de algum servidor
  const inviteInfo = db.invite(invite);
  const viaAccessCode = sameSecret(invite, ACCESS_PASSWORD);
  if (!viaAccessCode && !inviteInfo) {
    audit('auth:register:fail', { userName: username, ip, ok: false });
    await authFailed(ip, 'Código de convite inválido.');
  }
  if (db.usernameTaken(username)) throw new HttpError(409, 'Esse nome de usuário já existe.');

  const user = await db.createUser({ username, displayName, password });
  const serverId = viaAccessCode ? HOME_SERVER : inviteInfo.serverId;
  db.addMember(serverId, user);
  if (inviteInfo) db.useInvite(inviteInfo.code);
  // Dono do servidor principal: o usuário de OWNER_USERNAME (no .env) ou, sem ele, o primeiro a se cadastrar
  if (!db.server(HOME_SERVER).owner_id && (!OWNER_USERNAME || OWNER_USERNAME.toLowerCase() === username.toLowerCase())) {
    db.addMember(HOME_SERVER, user);
    db.setOwner(HOME_SERVER, user);
  }
  audit('auth:register', { user, ip, serverId, detail: { via: viaAccessCode ? 'código de acesso' : `convite ${inviteInfo.code}` } });
  pushServer(serverId); // quem já está online vê o membro novo na hora
  announceJoin(serverId, user);
  return { token: db.createSession(user), serverId };
}

// POST /api/login
// POST /api/password (logado): { current, password } — confere a senha atual (com o mesmo limite de tentativas
// do login), grava a nova e desconecta todos os outros aparelhos da conta. Este aparelho continua conectado.
export async function changePassword(req) {
  const token = bearer(req);
  const user = db.userBySession(token);
  if (!user) throw new HttpError(401, 'Sessão expirada, entre de novo.');
  const ip = clientIp(req);
  checkAuthRate(ip);
  checkAccountRate(user.username);
  const body = await readBody(req);
  const current = String(body.current ?? '');
  const password = String(body.password ?? '');
  if (password.length < 6 || password.length > 200) throw new HttpError(400, 'A senha nova deve ter pelo menos 6 caracteres.');
  if (password === current) throw new HttpError(400, 'A senha nova precisa ser diferente da atual.');
  if (!(await db.checkPassword(user.id, current))) {
    accountFailed(user.username);
    audit('auth:password:fail', { user, ip, ok: false });
    await authFailed(ip, 'A senha atual está incorreta.');
  }
  await db.setPassword(user.id, password);
  const others = db.deleteOtherSessions(user.id, token);
  audit('auth:password', { user, ip, detail: { outrosAparelhosDesconectados: others } });
  // Abas e aparelhos que estavam conectados com outra sessão: saem agora (voltam para a tela de login)
  for (const ws of sockets.get(user.id) ?? []) {
    if (ws.sessionToken !== token) { try { ws.send(JSON.stringify({ t: 'error', code: 'auth', message: 'A senha foi trocada. Entre de novo.' })); } catch {} ws.close(); }
  }
  return { ok: true, others };
}

export async function login(req) {
  const ip = clientIp(req);
  checkAuthRate(ip);
  const body = await readBody(req);
  const username = String(body.username ?? '').trim().toLowerCase().slice(0, 64);
  checkAccountRate(username);
  const user = await db.checkLogin(username, String(body.password ?? ''));
  if (!user) {
    accountFailed(username);
    audit('auth:login:fail', { userName: username, ip, ok: false, detail: { contaExiste: db.usernameTaken(username) } });
    await authFailed(ip, 'Usuário ou senha incorretos.');
  }
  if (db.isBlocked(user.id)) {
    audit('auth:login:blocked', { user, ip, ok: false });
    throw new HttpError(403, 'Esta conta está bloqueada. Fale com o dono do servidor.');
  }
  audit('auth:login', { user, ip, detail: { aparelho: String(req.headers['user-agent'] ?? '').slice(0, 160) } });
  authFails.delete(ip);
  accountFails.delete(username);
  return { token: db.createSession(user) };
}
