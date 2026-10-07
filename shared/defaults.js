// Configuración por defecto, compartida por content scripts, popup y service worker.
globalThis.SBN_DEFAULTS = Object.freeze({
  enabled: true,
  engine: 'supertonic', // 'supertonic' = voz neural local | 'browser' = voces del sistema
  neuralVoice: 'F1', // estilos de Supertonic 3: F1–F5 (femeninas), M1–M5 (masculinas)
  neuralSteps: 0, // pasos de difusión; 0 = automático (8 con GPU, 3 con CPU)
  voiceURI: '', // voz del sistema; '' = elegir automáticamente la mejor para el idioma de la página
  rate: 1.1, // velocidad base
  maxRate: 1.8, // tope cuando se acelera para no quedarse atrás del video
  pitch: 1, // solo voces del sistema
  volume: 1,
  muteOriginal: true, // silenciar el audio original del video mientras se narra
  adaptiveRate: true, // ajustar la velocidad para que cada párrafo quepa en su tiempo
  onParagraphChange: 'queue', // 'queue' = terminar y continuar | 'interrupt' = cortar e ir al nuevo
  showOverlay: true,
});
