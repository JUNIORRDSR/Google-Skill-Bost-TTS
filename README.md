# Skills Narrador

Extensión para Chrome y Edge que lee en voz alta la transcripción de los videos de Google Skills (antes Cloud Skills Boost). Cada párrafo se lee justo cuando la transcripción lo resalta, así que suena como si fuera el audio del video, pero en el idioma de la transcripción.

Por defecto usa una **voz neural local**, [Supertonic 3](https://github.com/supertone-inc/supertonic), que se genera en tu propio equipo. Si la prefieres, también puedes usar las voces del sistema.

## Instalación

1. Abre `chrome://extensions` (en Edge, `edge://extensions`).
2. Activa el **Modo de desarrollador**.
3. Pulsa **Cargar descomprimida** y elige esta carpeta (la que contiene `manifest.json`).
4. **Recarga** la pestaña de Google Skills si ya la tenías abierta.

La primera vez que abras un video se descarga el modelo de voz (≈380 MB, desde Hugging Face). Queda guardado en el navegador y no se vuelve a descargar. Mientras tanto se lee con la voz del sistema, y el panel muestra el progreso.

## Uso

Abre un video de un curso con la transcripción visible y dale a reproducir. Abajo a la derecha aparece el panel **Narrador**:

- **Interruptor:** activa o desactiva la lectura. También funciona con `Alt+Shift+N`.
- **Video silenciado / Audio del video:** quita o devuelve el audio original (en inglés) mientras se narra.
- **Repetir:** vuelve a leer el párrafo actual.
- **Flecha:** minimiza el panel a un botón.

Al pausar el video la voz también se pausa, y al reanudarlo repite la frase que estaba leyendo. Si saltas a otro punto del video, empieza a leer desde el párrafo de ese momento.

En el icono de la extensión puedes elegir la voz, la velocidad, el tono y el volumen, y decidir qué pasa cuando llega el siguiente párrafo y la voz todavía no terminó:

- **Terminar la frase y continuar** (por defecto): no se pierde texto. Si la voz va atrasada, acelera hasta la *velocidad máxima*.
- **Cortar y leer el nuevo párrafo:** la voz va siempre pegada al video, aunque corte frases.

## Cómo se sincroniza

1. **Con el reloj del video (lo normal).** Un script pequeño dentro del reproductor de YouTube incrustado informa a la página del minuto exacto, de las pausas y de la velocidad de reproducción. Con eso se calcula qué párrafo corresponde, a partir de las marcas `00:07`, `00:12`, etc.
2. **Siguiendo el resaltado (plan B).** Si no llega información del video, la extensión observa qué fila de la transcripción está resaltada y lee cada párrafo nuevo. En este modo el primer párrafo se omite, porque no se puede saber si el video ya empezó.

La velocidad se adapta sola: cada párrafo se lee a la velocidad necesaria para terminar antes de que empiece el siguiente, nunca por debajo de tu velocidad base. Con el uso, la extensión aprende lo rápido que habla cada voz.

## Voz neural (Supertonic 3)

En el popup, **Voz → Neural** tiene:

- **10 voces:** Femenina 1–5 y Masculina 1–5. En [`muestras-voz/`](muestras-voz) hay una muestra de cada una leyendo un párrafo del curso, para elegir de oído. Esa carpeta puedes borrarla, la extensión no la usa.
- **Calidad:** número de pasos de generación. *Automática* usa 8 pasos con GPU y 3 sin GPU. Con más pasos la voz sale más limpia, pero tarda más en generarse.
- **Probar:** lee una frase de ejemplo con la voz y la velocidad elegidas.

Cómo funciona:

- El modelo corre con [ONNX Runtime Web](https://onnxruntime.ai/), en la **GPU** (WebGPU) si está disponible y si no en la **CPU**, con varios hilos.
- Mientras miras un párrafo, ya se van generando el siguiente y el de después. Así, cuando llega su turno, el audio suena al instante.
- Si hay que acelerar para no atrasarse respecto al video, se ajusta la velocidad sin cambiar el tono.
- Supertonic no tiene control de tono, por eso ese ajuste solo aparece con las voces del sistema.

Velocidad medida en un equipo con GPU AMD (8,3 s de audio):

| Motor | Pasos | Tiempo de generación |
| --- | --- | --- |
| GPU (WebGPU) | 8 | ≈4 s |
| CPU (4 hilos) | 3 | ≈4,7 s |

## Voces del sistema

Con **Voz → Sistema** se usan las voces del navegador:

- **Edge:** las voces "Microsoft … Online (Natural)" en español son muy naturales.
- **Chrome:** "Google español" o "Google español de Estados Unidos".
- **Windows:** puedes añadir voces en *Configuración → Hora e idioma → Voz*.

## Solución de problemas

| Problema | Qué hacer |
| --- | --- |
| No aparece el panel | Recarga la página después de instalar o actualizar la extensión. Comprueba que la transcripción se vea en la página. |
| "Haz clic en la página para permitir la voz" | Chrome no deja hablar a una página hasta que interactúas con ella. Haz clic en cualquier parte. |
| El panel dice "siguiendo el resaltado" | No llega el tiempo del video (por ejemplo, el reproductor no es de YouTube). Funciona igual, con menos precisión. |
| La voz se adelanta o se atrasa en segundo plano | Chrome ralentiza los temporizadores de las pestañas ocultas. Mantén la pestaña visible. |
| No hay voces en español | Activa "Mostrar voces de todos los idiomas" en el popup o instala una voz en el sistema. |
| La voz neural no termina de cargar | Mira el estado en el popup. Si hay un error, pulsa **Reintentar**. Sin GPU usa la CPU, que es más lenta: elige calidad *Rápida*. |
| La voz neural suena muy acelerada | Supertonic habla algo más pausado que el video original. Baja la *velocidad máxima* o elige *Cortar y leer el nuevo párrafo*. |

## Privacidad

No se envía nada a ningún servidor propio. La extensión solo guarda tus ajustes en el almacenamiento de Chrome.

- **Voz neural:** el texto nunca sale de tu equipo. Solo se descarga el modelo una vez desde Hugging Face.
- **Voces del sistema:** las voces "en línea" (Google, Microsoft Online) mandan el texto a ese proveedor para sintetizarlo.

## Licencias

- Código de la extensión y el port del pipeline de Supertonic (`offscreen/supertonic.js`, basado en `web/helper.js` del repo oficial): MIT.
- Modelo Supertonic 3 (Supertone Inc.): [OpenRAIL-M](https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE). No se incluye en la extensión, se descarga al usarla.
- ONNX Runtime Web 1.30 (`vendor/ort/`): MIT, Microsoft.

## Estructura

```
manifest.json
background/service-worker.js   atajo de teclado, distintivo OFF y ajustes iniciales
content/transcript.js          detecta la transcripción (incluido Shadow DOM)
content/narrator.js            cola, troceado, velocidad adaptativa; elige voz neural o del sistema
content/neural-engine.js       cliente de la voz neural (Port hacia el documento offscreen)
content/overlay.js             panel flotante
content/main.js                sincroniza reloj del video, transcripción y voz
content/youtube-bridge.js      dentro del iframe de YouTube: tiempo y silencio
offscreen/neural.js            documento offscreen: cola de síntesis, caché de audio, reproducción
offscreen/supertonic.js        Supertonic 3 sobre ONNX Runtime Web (WebGPU o CPU)
vendor/ort/                    ONNX Runtime Web 1.30
popup/                         ajustes
shared/                        valores por defecto y elección de voz
muestras-voz/                  muestras de las 10 voces neurales (opcional)
```
