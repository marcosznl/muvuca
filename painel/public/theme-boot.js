// Tema do painel (automático, claro ou escuro), aplicado antes de desenhar a página para não piscar.
// Carregado sem "defer" no <head>; a escolha fica neste aparelho (pé da lateral do painel).
(function () {
  var t = null;
  try { t = localStorage.getItem('painel-tema'); } catch (e) { /* sem armazenamento */ }
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
})();
