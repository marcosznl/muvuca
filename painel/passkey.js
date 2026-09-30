// Entrar no painel com Face ID / Touch ID / digital (passkey, padrão WebAuthn), sem biblioteca de fora.
// Cadastro: só com o painel já aberto (logado com a senha). A chave privada nunca sai do aparelho;
// aqui fica só a chave pública (data/painel-passkeys.json) para conferir a assinatura de cada entrada.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

let FILE;
let creds = []; // [{ id, jwk, alg, counter, name, created, lastUsed }]
const challenges = new Map(); // desafio -> { kind, until }
const CHALLENGE_MS = 2 * 60_000;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s ?? ''), 'base64url');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();

function save() {
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(creds), { mode: 0o600 });
  fs.renameSync(`${FILE}.tmp`, FILE);
}
export function startPasskeys(dataDir) {
  FILE = path.join(dataDir, 'painel-passkeys.json');
  try { creds = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { creds = []; }
  setInterval(() => { const now = Date.now(); for (const [c, v] of challenges) if (v.until < now) challenges.delete(c); }, 60_000).unref();
}
export const hasPasskeys = () => creds.length > 0;

// ---------- CBOR (só o necessário para ler o que o aparelho manda) ----------
function cborDecode(buf, pos = 0) {
  const first = buf[pos++];
  const major = first >> 5;
  let info = first & 31;
  let len = info;
  if (info === 24) len = buf[pos++];
  else if (info === 25) { len = buf.readUInt16BE(pos); pos += 2; } else if (info === 26) { len = buf.readUInt32BE(pos); pos += 4; } else if (info === 27) { len = Number(buf.readBigUInt64BE(pos)); pos += 8; } else if (info > 27) throw new Error('CBOR não suportado');
  switch (major) {
    case 0: return { value: len, pos };
    case 1: return { value: -1 - len, pos };
    case 2: return { value: buf.subarray(pos, pos + len), pos: pos + len };
    case 3: return { value: buf.subarray(pos, pos + len).toString('utf8'), pos: pos + len };
    case 4: { const arr = []; for (let i = 0; i < len; i++) { const r = cborDecode(buf, pos); arr.push(r.value); pos = r.pos; } return { value: arr, pos }; }
    case 5: { const map = new Map(); for (let i = 0; i < len; i++) { const k = cborDecode(buf, pos); const v = cborDecode(buf, k.pos); map.set(k.value, v.value); pos = v.pos; } return { value: map, pos }; }
    case 7: return { value: info === 20 ? false : info === 21 ? true : null, pos };
    default: throw new Error('CBOR não suportado');
  }
}

// Chave pública no formato COSE → JWK (o Node verifica assinatura com ela)
function coseToJwk(cose) {
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (kty === 2 && alg === -7) { // EC2 P-256 (Face ID, Touch ID, Android, chaves de segurança)
    return { alg, jwk: { kty: 'EC', crv: 'P-256', x: b64u(cose.get(-2)), y: b64u(cose.get(-3)) } };
  }
  if (kty === 3 && alg === -257) { // RSA (Windows Hello)
    return { alg, jwk: { kty: 'RSA', n: b64u(cose.get(-1)), e: b64u(cose.get(-2)) } };
  }
  throw new Error('Tipo de chave não suportado por este painel.');
}

// authenticatorData: hash do site (32) + flags (1) + contador (4) + [dados da credencial]
function parseAuthData(buf) {
  const out = { rpIdHash: buf.subarray(0, 32), flags: buf[32], counter: buf.readUInt32BE(33) };
  if (out.flags & 0x40) { // tem credencial nova (cadastro)
    const credLen = buf.readUInt16BE(53);
    out.credId = buf.subarray(55, 55 + credLen);
    out.cose = cborDecode(buf, 55 + credLen).value;
  }
  return out;
}

// O site certo: o nome do painel (sem porta) e a origem https dele
function site(req, allowedHosts) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const rpId = host.replace(/:\d+$/, '');
  if (!allowedHosts.includes(rpId)) throw new Error('Passkey só funciona pelo endereço do painel.');
  return { rpId, origin: `https://${host}` };
}

function newChallenge(kind) {
  const c = b64u(crypto.randomBytes(32));
  challenges.set(c, { kind, until: Date.now() + CHALLENGE_MS });
  return c;
}
function useChallenge(clientData, kind, origin) {
  const c = challenges.get(clientData.challenge);
  if (!c || c.kind !== kind || c.until < Date.now()) throw new Error('O pedido expirou. Tente de novo.');
  challenges.delete(clientData.challenge);
  if (clientData.origin !== origin && clientData.origin !== origin.replace(/:\d+$/, '')) throw new Error('Origem inválida.');
}

export function passkeyRoutes({ json, readBody, audit, clientIp, allowedHosts, startSession, userName }) {
  const guard = (fn) => async (req, res, s, url) => {
    try { return await fn(req, res, s, url); } catch (err) { return json(res, 400, { error: err.message }); }
  };
  return {
    // Públicas (tela de login)
    public: {
      'GET /api/passkey/available': (req, res) => json(res, 200, { available: hasPasskeys() }),
      'POST /api/passkey/login-options': guard(async (req, res) => {
        const { rpId } = site(req, allowedHosts);
        json(res, 200, { challenge: newChallenge('login'), rpId, timeout: CHALLENGE_MS, userVerification: 'required' });
      }),
      'POST /api/passkey/login': guard(async (req, res) => {
        const { rpId, origin } = site(req, allowedHosts);
        const b = await readBody(req, 20_000);
        const cred = creds.find((c) => c.id === String(b.id ?? ''));
        const clientDataJSON = fromB64u(b.clientDataJSON);
        const clientData = JSON.parse(clientDataJSON.toString('utf8'));
        if (clientData.type !== 'webauthn.get') throw new Error('Pedido inválido.');
        useChallenge(clientData, 'login', origin);
        if (!cred) {
          audit('painel:login:fail', { ip: clientIp(req), ok: false, detail: { via: 'passkey desconhecida' } });
          return json(res, 401, { error: 'Essa passkey não está cadastrada neste painel.' });
        }
        const authData = fromB64u(b.authenticatorData);
        const ad = parseAuthData(authData);
        if (!ad.rpIdHash.equals(sha256(Buffer.from(rpId)))) throw new Error('Site inválido.');
        if (!(ad.flags & 0x01) || !(ad.flags & 0x04)) throw new Error('Confirme com Face ID, Touch ID ou a senha do aparelho.');
        const key = crypto.createPublicKey({ key: cred.jwk, format: 'jwk' });
        const data = Buffer.concat([authData, sha256(clientDataJSON)]);
        const sig = fromB64u(b.signature);
        const ok = cred.alg === -7
          ? crypto.verify('sha256', data, { key, dsaEncoding: 'der' }, sig)
          : crypto.verify('sha256', data, { key, padding: crypto.constants.RSA_PKCS1_PADDING }, sig);
        if (!ok) {
          audit('painel:login:fail', { ip: clientIp(req), ok: false, detail: { via: 'passkey', aparelho: cred.name } });
          return json(res, 401, { error: 'Não deu para confirmar. Tente de novo.' });
        }
        // Contador: se o aparelho manda contador e ele voltou para trás, a chave pode ter sido copiada
        if (ad.counter && cred.counter && ad.counter <= cred.counter) throw new Error('Passkey recusada (contador inválido).');
        cred.counter = ad.counter;
        cred.lastUsed = Date.now();
        save();
        startSession(req, res, { via: `passkey (${cred.name})` });
      }),
    },
    // Com o painel aberto
    'GET /api/passkeys': (req, res) => json(res, 200, creds.map((c) => ({ id: c.id, name: c.name, created: c.created, lastUsed: c.lastUsed ?? null }))),
    'POST /api/passkey/register-options': guard(async (req, res) => {
      const { rpId } = site(req, allowedHosts);
      json(res, 200, {
        challenge: newChallenge('register'), rp: { id: rpId, name: 'Painel do Muvuca' },
        user: { id: b64u(Buffer.from('painel-admin')), name: userName(), displayName: `Painel (${userName()})` },
        excludeCredentials: creds.map((c) => ({ type: 'public-key', id: c.id })),
        timeout: CHALLENGE_MS,
      });
    }),
    'POST /api/passkey/register': guard(async (req, res) => {
      const { rpId, origin } = site(req, allowedHosts);
      const b = await readBody(req, 20_000);
      const clientDataJSON = fromB64u(b.clientDataJSON);
      const clientData = JSON.parse(clientDataJSON.toString('utf8'));
      if (clientData.type !== 'webauthn.create') throw new Error('Pedido inválido.');
      useChallenge(clientData, 'register', origin);
      const att = cborDecode(fromB64u(b.attestationObject)).value;
      const ad = parseAuthData(att.get('authData'));
      if (!ad.rpIdHash.equals(sha256(Buffer.from(rpId)))) throw new Error('Site inválido.');
      if (!(ad.flags & 0x01) || !(ad.flags & 0x04)) throw new Error('Confirme com Face ID, Touch ID ou a senha do aparelho.');
      if (!ad.credId) throw new Error('O aparelho não mandou a chave.');
      const { jwk, alg } = coseToJwk(ad.cose);
      crypto.createPublicKey({ key: jwk, format: 'jwk' }); // confere que a chave é válida
      const id = b64u(ad.credId);
      if (creds.some((c) => c.id === id)) throw new Error('Esta passkey já está cadastrada.');
      if (creds.length >= 10) throw new Error('Limite de 10 passkeys. Apague alguma antes.');
      const name = String(b.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Aparelho';
      creds.push({ id, jwk, alg, counter: ad.counter, name, created: Date.now() });
      save();
      audit('painel:passkey:add', { ip: clientIp(req), detail: { aparelho: name } });
      json(res, 200, { ok: true, message: `Passkey "${name}" cadastrada. Na próxima vez, é só tocar em "Entrar com Face ID / Touch ID".` });
    }),
    'POST /api/passkey/delete': guard(async (req, res) => {
      const b = await readBody(req);
      const c = creds.find((x) => x.id === String(b.id ?? ''));
      if (!c) throw new Error('Passkey não encontrada.');
      creds = creds.filter((x) => x.id !== c.id);
      save();
      audit('painel:passkey:remove', { ip: clientIp(req), detail: { aparelho: c.name } });
      json(res, 200, { ok: true, message: `Passkey "${c.name}" apagada.` });
    }),
  };
}
