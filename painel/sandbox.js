// Painel de teste (npm test): sobe com PAINEL_SANDBOX=1 e não pode mexer no Muvuca de verdade deste Mac
// (reiniciar, desligar, voz, backup, publicar), nem escrever na pasta logs/ do projeto.
export const SANDBOX = process.env.PAINEL_SANDBOX === '1';
export function realOnly() {
  if (SANDBOX) throw new Error('Painel de teste: não mexe no Muvuca de verdade.');
}
