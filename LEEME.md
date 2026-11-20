# TV PRO 2.1.0

Reproductor IPTV web pensado para usar con el mando del televisor. Conserva siete canales fijos y completa el catálogo con las fuentes activas. La instalación inicial incluye dos directorios públicos de IPTV-org, uno de República Dominicana y otro de canales en español. Puedes sustituirlos o añadir fuentes autorizadas en **Configuración → Fuentes IPTV**.

## Puesta en marcha

1. Extrae el ZIP y abre una terminal en la carpeta `tv-pro`.
2. Con Node.js 20 o posterior, ejecuta `node servir.mjs`. No hace falta instalar paquetes ni compilar.
3. Abre [TV PRO en localhost](http://127.0.0.1:8080/). Pulsa OK en «Presiona OK para comenzar». La aplicación solicita pantalla completa e inicia el último canal del perfil si la reanudación está activada. En los demás casos inicia con el canal 0. Si el navegador bloquea la pantalla completa, TV PRO ocupa el área disponible. Si el puerto está ocupado, ejecuta `node servir.mjs --port 8090`.

`index.html` debe servirse por HTTP o HTTPS para que el navegador cargue los módulos. Para una prueba en tu propia red local, ejecuta `node servir.mjs --host 0.0.0.0` y abre desde el televisor `http://IP-DE-TU-EQUIPO:8080/`. El equipo debe permanecer encendido y el cortafuegos debe permitir el acceso desde esa red. Para instalarlo de forma habitual, sirve `index.html`, `styles.css`, `js/` y `vendor/` en un alojamiento estático HTTPS. El PIN necesita HTTPS o localhost. Un televisor que abra una página HTTPS puede bloquear señales HTTP por contenido mixto.

## Controles

Marca **1111** para abrir la lista. Recorre sus canales con **CH+ / CH−**, pulsa **OK** para sintonizar el seleccionado o marca **1111** otra vez para salir con la señal actual. Las flechas de arriba y abajo también recorren la lista en los televisores cuyo navegador reserva CH+ y CH− para la sintonización del propio equipo. [Teclas en Samsung](https://developer.samsung.com/smarttv/develop/guides/user-interaction/remote-control.html) · [Teclas en LG](https://webostv.developer.lge.com/develop/guides/magic-remote)

| Mando o teclado | En reproducción | En paneles |
| --- | --- | --- |
| ↑ / ↓ | Siguiente / anterior en el orden del perfil | Mover el foco o recorrer canales |
| ← / → | Bajar / subir volumen si el dispositivo lo admite | Mover el foco o cambiar una opción. → desde un canal abre sus opciones |
| OK / Enter | Mostrar la información o confirmar un número marcado | Confirmar selección |
| Back / Escape | Cancelar la marcación u ocultar la información | Volver o cerrar |
| 0–9 | Marcar un número. También se confirma tras una pausa breve | Escribir cuando el foco está en un campo de texto |
| CH+ / CH− | Cambiar de canal | Moverse por la lista |
| 1111 | Abrir la lista | Salir de la lista |
| Menú / Lista / rojo / C | Abrir canales | — |
| Verde / F | Abrir favoritos | — |
| Info / I | Mostrar información del canal | — |
| Guía / amarillo / G | Abrir la guía del canal | — |
| Azul / S | Abrir configuración | — |
| Canal previo / R | Volver al último canal distinto | — |
| Mute / M | Silenciar o activar sonido | — |

Las flechas conservan su función de reproducción aunque se vea la información del canal. **0** sintoniza La Voz de María. Si necesitas un canal cuyo número empieza por `1111`, busca `111` en la lista y selecciónalo con CH+ / CH−. **Filtros** contiene las categorías, países e idiomas. **Más opciones** reúne la guía, el audio, la calidad y la configuración.

El video llena la pantalla conservando sus proporciones. Puede recortar parte de la imagen cuando las proporciones del video y el televisor difieren. Elige **Mostrar la imagen completa** en **Configuración → Apariencia** si prefieres verla entera.

## Orden del catálogo

1. **Canales fijos**. 0 La Voz de María, 1 Jarabacoa TV, 2 La Voz de Jesús, 3 Telever, 4 Teleantillas, 5 Telesistema 11 y 6 Color Visión.
2. **Principales de RD**. Incluye señales nacionales como Telemicro, Antena 7, Digital 15, Telecentro y CDN cuando aparecen en las fuentes. [Listado de frecuencias de INDOTEL](https://indotel.gob.do/wp-content/uploads/2025/09/TABLA-REORDENAMIENTO-DE-FRECUENCIAS-TTD-LISTADO-DEFINITIVO-1-1.pdf)
3. **Cable**. Prioriza Disney y Warner, e incluye otros canales reconocidos o marcados como cable por las listas. La presencia en el directorio es independiente de que la señal se pueda reproducir desde tu red.
4. Resto de canales dominicanos y demás canales.

Al actualizar desde una versión anterior, las posiciones 0–6 quedan reservadas para los canales fijos. Si otro canal ocupaba una de esas posiciones, recibe un número libre. Puedes guardar cualquier canal en favoritos. **Opciones del canal** permite ocultar y reordenar los demás canales dentro de su grupo. **Recientes** guarda los últimos 20 canales que empezaron a reproducirse.

## Fuentes, guía y perfiles

- Añade una URL M3U/M3U8 o importa un archivo. En listas remotas se resuelven las rutas relativas con la URL final de la lista. Los archivos importados desde el dispositivo deben contener URLs de señal absolutas. Las señales se agrupan por identificador, nombre normalizado y URL. Si cambian a la vez las tres referencias de un canal, se asigna una identidad nueva.
- La guía admite XMLTV y, cuando el navegador lo permite, archivos `.xml.gz`. Su URL puede venir declarada en la lista o añadirse al configurar la fuente. Los identificadores `tvg-id` deben coincidir con los de la guía. Solo se muestra programación vigente o próxima que tenga un horario válido. La guía se consulta al abrirla.
- Las preferencias viven en `localStorage` y las copias de las listas en IndexedDB. Cada perfil conserva su orden, favoritos, categorías preferidas, ocultos, historial, idioma, último canal y ajustes de reproducción y presentación. El respaldo JSON contiene perfiles, numeración y configuración de fuentes. Guarda por separado tus archivos M3U originales, sobre todo para trasladar la instalación a otro navegador. Si una URL contiene un token de acceso, el respaldo también puede contenerlo.
- El PIN se deriva con PBKDF2 y sal aleatoria y sirve para limitar categorías y proteger cambios del perfil desde la interfaz. Quien controle el almacenamiento del navegador puede modificar ese perfil. El proyecto no requiere registro ni usa un backend. Una futura sincronización puede sustituir la capa de preferencias por un servicio autenticado.
- **Actualizar listas** descarga las fuentes remotas y conserva la última copia de una fuente que falla. La actualización automática se ejecuta mientras la aplicación permanece abierta. Los cambios del catálogo no reinician el canal en pantalla. Borra una fuente desde **Fuentes IPTV** para retirarla del catálogo.

## Auditoría y arquitectura

| Código original | Implementación |
| --- | --- |
| Señales fijas, enlaces temporales y listas dependientes de una consulta de idiomas | Fuentes reemplazables, caché por fuente y filtros a partir de metadatos. Las fuentes incompletas pueden seguir aportando canales |
| Comprobaciones secuenciales y descarte por errores temporales | Cola acotada con caché temporal y muestreo de señales visibles y favoritas. Una respuesta HTTP 200 no acredita reproducción |
| Duplicados por URL y número igual al índice | Alternativas por canal, números guardados y orden independiente por perfil |
| «En vivo» al analizar el manifiesto y un manejador de teclado que activaba sonido en cualquier contexto | Estado ligado a los eventos del video, controles según el foco, manejo de autoplay y cancelación de intentos obsoletos |
| Una página con CSS sobrescrito y sin preferencias | HTML/CSS separados y módulos pequeños para catálogo, reproductor, mando, guía, fuentes, perfiles y formularios |

`lineup.js` define los siete originales. `catalog.js` cruza sus identificadores con las listas, agrupa las alternativas, reserva los números y comprueba las señales. El análisis y la agrupación de listas grandes usan un Worker cuando está disponible. `player.js` controla el único elemento de video, selecciona HLS nativo o HLS.js y limita la reconexión y el cambio a alternativas. `source-storage.js` conserva las últimas listas válidas. `preferences.js` centraliza la persistencia y el PIN. `remote.js`, `settings.js`, `guide.js` y `app.js` coordinan entrada, interfaz y guía. El paquete incluye HLS.js 1.7.4 y su licencia.

El modo de ahorro suspende la comprobación en segundo plano y la carga de logotipos del listado. HLS.js aplica sus límites de búfer desde la siguiente sintonización. [HLS.js 1.7.4](https://github.com/video-dev/hls.js/releases/tag/v1.7.4) · [Directorios públicos de IPTV-org](https://github.com/iptv-org/iptv/blob/master/PLAYLISTS.md)

La disponibilidad se comprueba sobre una muestra del recurso y su formato. «Reproduciendo» se reserva para una señal que ha empezado en el reproductor. Si el navegador no expone el error de una petición externa, se muestra «Red o CORS». Un servidor puede devolver una señal válida con un aviso geográfico dentro del video. Eso no se puede identificar con fiabilidad desde el manifiesto. TV PRO usa las solicitudes normales del navegador y respeta CORS y las restricciones de acceso.

## Pruebas

Ejecuta `node --test` desde la carpeta del proyecto. Las pruebas cubren el analizador M3U, agrupación, persistencia de números, cancelaciones, cola de disponibilidad, recuperación del reproductor, selección de pistas y políticas de audio y arranque. Las pruebas del módulo del reproductor usan un elemento multimedia simulado.

La prueba de integración de esta versión se ejecutó en Microsoft Edge contra el servidor local con segmentos HLS de prueba. Se verificaron el arranque con OK, la pantalla completa, el llenado del área de video, la numeración de los originales, los grupos de canales, la migración, los favoritos, la marcación directa, el aviso «1111 para salir» y el desplazamiento con eventos de CH+ y CH−.

Verifica en tu televisor las teclas adicionales del mando, el teclado virtual, el volumen, el audio alternativo y la decodificación de tus señales. Con HLS nativo la calidad adaptativa la controla el navegador y el menú de audio depende de que exponga sus pistas. La disponibilidad de las señales y los códecs admitidos varían según el proveedor, la región, el navegador y el modelo. La entrega es una aplicación web, sin empaquetado nativo para las tiendas de Samsung o LG.
