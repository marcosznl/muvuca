// Minutos em call, para o painel administrativo (uso de cada pessoa e resumo da semana): a cada minuto,
// quem está numa call com pelo menos mais uma pessoa ganha uma linha em call_minutes.
import { db } from './store.js';
import { voiceAll } from './voice.js';

function tick() {
  for (const people of Object.values(voiceAll())) {
    if (people.length < 2) continue;
    for (const p of people) db.addCallMinute(p.id);
  }
}
setInterval(tick, 60_000).unref();
