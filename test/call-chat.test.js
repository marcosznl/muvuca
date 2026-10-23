// Chat ao lado da call: qual canal o chat mostra (o aberto na tela ou, na call, o canal de texto escolhido)
import { test } from 'node:test';
import assert from 'node:assert/strict';

// O state.js do site usa o localStorage do navegador: aqui, um de mentira
globalThis.localStorage = { data: {}, getItem(k) { return this.data[k] ?? null; }, setItem(k, v) { this.data[k] = String(v); }, removeItem(k) { delete this.data[k]; } };
const { state, chatChannelId, callChatChannel } = await import('../public/js/state.js');

const server = { id: 's1', channels: [
  { id: 't-geral', type: 'text', name: 'geral' }, { id: 't-jogos', type: 'text', name: 'jogos' },
  { id: 'v-sala', type: 'voice', name: 'Sala 1' },
] };
state.servers = [server];
const k = (key) => `calldireta:${key}`;

test('canal de texto: o chat é o próprio canal', () => {
  state.view = { serverId: 's1', channelId: 't-jogos' };
  assert.equal(chatChannelId(), 't-jogos');
});

test('call sem o chat ao lado: nenhum chat à vista', () => {
  delete localStorage.data[k('callSplit')];
  state.view = { serverId: 's1', channelId: 'v-sala' };
  assert.equal(chatChannelId(), null);
});

test('call com o chat ao lado: último canal de texto usado, ou o escolhido', () => {
  localStorage.setItem(k('callSplit'), '1');
  state.view = { serverId: 's1', channelId: 'v-sala' };
  assert.equal(chatChannelId(), 't-geral'); // sem escolha: o primeiro canal de texto
  localStorage.setItem(k('lastChannels'), JSON.stringify({ s1: 't-jogos' }));
  assert.equal(chatChannelId(), 't-jogos'); // o último que a pessoa usou
  localStorage.setItem(k('callChat:s1'), 't-geral');
  assert.equal(chatChannelId(), 't-geral'); // o escolhido na lista
  localStorage.setItem(k('callChat:s1'), 'v-sala');
  assert.equal(callChatChannel(server).type, 'text'); // escolha inválida (não é texto): volta ao padrão
});
