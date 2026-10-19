// App "Muvuca" do Discord: o próprio servidor responde aos comandos. No portal do Discord, o
// "Interactions Endpoint URL" da aplicação aponta para /discord/interacoes; sem conexão permanente
// com o Discord nem processo à parte. É um app (só comandos), não um bot: não entra como membro no servidor.
// O token do bot da aplicação só serve para cadastrar os comandos ao subir.
// Comando: /tela, que cria uma sala de tela (src/tela.js) e publica o link no canal.
import crypto from 'node:crypto';
import { DISCORD_API, DISCORD_CLIENT_ID, DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN } from './config.js';
import { criarSala } from './tela.js';
import { HttpError } from './util.js';

const COMANDOS = [{
  name: 'tela',
  description: 'Cria uma sala para compartilhar a tela pelo navegador',
  description_localizations: { 'en-US': 'Creates a room to share your screen from the browser', 'en-GB': 'Creates a room to share your screen from the browser' },
  type: 1,             // comando de barra
  contexts: [0],       // só dentro de servidores
  integration_types: [0],
}];

const EFEMERA = 1 << 6;
const COMPONENTES_V2 = 1 << 15;

// Chave pública da aplicação (hex no portal) no formato que o node:crypto entende
const chave = /^[0-9a-f]{64}$/i.test(DISCORD_PUBLIC_KEY)
  ? crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(DISCORD_PUBLIC_KEY, 'hex')]), format: 'der', type: 'spki' })
  : null;

function lerCorpo(req, limite = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let tamanho = 0;
    req.on('data', (parte) => {
      tamanho += parte.length;
      if (tamanho > limite) reject(new HttpError(413, 'Requisição grande demais'));
      else partes.push(parte);
    });
    req.on('end', () => resolve(Buffer.concat(partes)));
    req.on('error', reject);
  });
}

// Só o Discord assina com a chave da aplicação: qualquer outro pedido é recusado
function assinaturaValida(req, corpo) {
  const assinatura = String(req.headers['x-signature-ed25519'] ?? '');
  const quando = String(req.headers['x-signature-timestamp'] ?? '');
  if (!chave || !/^[0-9a-f]{128}$/i.test(assinatura) || !quando) return false;
  return crypto.verify(null, Buffer.concat([Buffer.from(quando), corpo]), chave, Buffer.from(assinatura, 'hex'));
}

const aviso = (texto) => ({ type: 4, data: { content: texto, flags: EFEMERA } });

async function comandoTela(i) {
  const user = i.member?.user;
  if (!i.guild_id || !user) return aviso('Use o /tela dentro de um servidor.');
  let sala;
  try {
    sala = criarSala({ guildId: i.guild_id, userId: user.id });
  } catch (err) {
    return aviso(err.message); // limite de salas
  }
  return {
    type: 4,
    data: {
      flags: COMPONENTES_V2,
      allowed_mentions: { parse: [] }, // menciona quem abriu sem notificar
      components: [{
        type: 17, // caixa
        accent_color: 0x5865f2,
        components: [
          {
            type: 10, // texto
            content: `## Sala de tela\n<@${user.id}> abriu uma sala para compartilhar a tela.\n`
              + 'Entre pelo navegador com a sua conta do Discord: dá para assistir, mostrar a sua tela e ligar a câmera. Só membros deste servidor entram.\n'
              + '-# A sala fecha sozinha depois de 5 minutos vazia.',
          },
          { type: 1, components: [{ type: 2, style: 5, label: 'Entrar na sala', url: sala.link }] },
        ],
      }],
    },
  };
}

// POST /discord/interacoes
export async function interacao(req) {
  const corpo = await lerCorpo(req);
  if (!assinaturaValida(req, corpo)) throw new HttpError(401, 'Assinatura inválida');
  let i;
  try { i = JSON.parse(corpo); } catch { throw new HttpError(400, 'Requisição inválida'); }
  if (i.type === 1) return { type: 1 }; // o Discord conferindo se o endereço responde
  if (i.type === 2 && i.data?.name === 'tela') return comandoTela(i);
  return aviso('Comando desconhecido.');
}

// Cadastra (ou atualiza) os comandos no Discord ao subir
export async function registrarComandos() {
  if (!DISCORD_BOT_TOKEN || !DISCORD_CLIENT_ID) return;
  try {
    const r = await fetch(`${DISCORD_API}/applications/${DISCORD_CLIENT_ID}/commands`, {
      method: 'PUT',
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(COMANDOS),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) console.error('Comandos do Discord:', r.status, await r.text());
  } catch (err) {
    console.error('Comandos do Discord:', err.message);
  }
}
