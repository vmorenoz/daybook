# Daybook

Daybook guarda el contexto de proyectos y tareas para que un agente de IA pueda retomarlos entre sesiones. Funciona localmente con SQLite y se conecta al agente mediante MCP. No necesita una interfaz gráfica ni depende de un cliente concreto.

Permite organizar planes, fases y tareas, registrar avances y decisiones, consultar el trabajo pendiente y conservar el historial. Los documentos permanecen en el proyecto; Daybook guarda sus rutas, no su contenido.

## Instalación

Necesitas **Node.js 24 o posterior**, npm y acceso al registro de npm para descargar dependencias. Descarga el archivo `vmorenoz-daybook-<versión>.tgz` de la versión que quieras desde la [página de releases](https://github.com/vmorenoz/daybook/releases), no los archivos de código fuente que GitHub genera automáticamente. En una terminal, indica la ruta al archivo descargado e instálalo:

```sh
PAQUETE="$HOME/Downloads/vmorenoz-daybook-<versión>.tgz"
npm install -g "$PAQUETE" --foreground-scripts
```

Sustituye la ruta de ejemplo por la ruta y el nombre reales del archivo descargado; la variable `PAQUETE` se usa también en el ejemplo sin terminal interactiva. No ejecutes la instalación con `sudo`.

Durante la instalación, selecciona con las flechas y la barra espaciadora los clientes que quieras conectar: **OpenCode, Codex, Antigravity o Claude Code**. Pulsa Enter para confirmar; sin selección se cancela la configuración. El instalador registra el servidor MCP y una instrucción global para los clientes seleccionados. No instala un comando global ni una skill. Los clientes arrancan el servidor automáticamente y pueden pedir permisos o confirmación.

El instalador conserva los ajustes ajenos, pero **no crea copias de seguridad de los archivos de configuración**. Rechaza archivos inválidos y enlaces simbólicos directos. Si falla o se interrumpe después de escribir algún archivo, no revierte los cambios; informa de los archivos ya modificados.

Estos son los archivos que puede modificar para los clientes seleccionados:

| Cliente | Configuración MCP | Instrucción global |
|---|---|---|
| OpenCode | `~/.config/opencode/opencode.json` o `opencode.jsonc`; si existen ambos, modifica ambos | `~/.config/opencode/instructions/daybook.md` |
| Codex | `~/.codex/config.toml` | `~/.codex/AGENTS.override.md` si no está vacío; en otro caso, `~/.codex/AGENTS.md` |
| Antigravity | `~/.gemini/config/mcp_config.json` | `~/.gemini/GEMINI.md` |
| Claude Code | `~/.claude.json` | `~/.claude/CLAUDE.md` |

Si están definidas, `XDG_CONFIG_HOME` sustituye a `~/.config` para OpenCode; `CODEX_HOME` sustituye a `~/.codex` para Codex; y `CLAUDE_CONFIG_DIR` contiene tanto `.claude.json` como `CLAUDE.md` para Claude Code.

Sin terminal interactiva, el instalador no cambia la configuración salvo que se indiquen clientes y confirmación explícitos:

```sh
DAYBOOK_INSTALL_CLIENTS=opencode,codex DAYBOOK_INSTALL_CONFIRM=1 npm install -g "$PAQUETE" --foreground-scripts
```

También se admiten `antigravity` y `claude-code` en la lista. Usa `DAYBOOK_SKIP_SETUP=1` para instalar sin configurar clientes. Si se omite la configuración, habrá que reinstalar con ella habilitada o configurar el cliente manualmente.

### Crear el paquete desde el código fuente

Como alternativa a la descarga, puedes generar el paquete localmente:

```sh
git clone https://github.com/vmorenoz/daybook.git
cd daybook
npm ci --ignore-scripts
npm run pack
```

Después, asigna a `PAQUETE` la ruta del archivo `vmorenoz-daybook-<versión>.tgz` generado en `releases/` e instálalo como se indica arriba.

### Actualización desde un paquete anterior

El paquete `@vmorenoz/daybook` no sustituye automáticamente a `alba-daybook` ni a `@vicodev/daybook`. Instala el nuevo paquete con la configuración habilitada, selecciona los mismos clientes y usa la misma ubicación de datos. Comprueba que las conexiones funcionan **antes** de desinstalar el paquete anterior: de lo contrario, los clientes podrían seguir apuntando a sus archivos. Si usas la biblioteca directamente, actualiza también sus importaciones.

## Uso

Una vez conectado, pide a tu agente que use Daybook para registrar o retomar el trabajo. La [instrucción global](instructions/global.md) describe cómo vincular un proyecto, guardar avances y consultar el historial. Se añade a los clientes seleccionados sin reemplazar sus instrucciones existentes.

Daybook guarda por defecto su base de datos en `~/.local/share/bitacora`, fuera de los repositorios. Puedes establecer `DAYBOOK_HOME` en una ruta absoluta para cambiar la ubicación; `BITACORA_HOME` sigue siendo una alternativa compatible. El instalador fija esa ruta en la configuración MCP de cada cliente: para cambiarla después, actualiza dicha configuración o reinstala con la nueva ubicación. Esto no mueve los datos existentes. Crear un proyecto no modifica su repositorio. La instrucción del agente propone guardar el identificador en `AGENTS.md` y acordar si los documentos de `.work/` se incluyen en Git.

Completar o cancelar un elemento conserva su historial; se puede reabrir. El borrado es permanente, pero no elimina documentos ni otros archivos. Las copias creadas con `create_backup` incluyen la base de datos y archivos regulares bajo `projects/`, no los documentos externos: haz copias de estos por separado. La copia omite enlaces simbólicos y archivos no regulares; revisa las rutas omitidas y externas en el resultado o en `manifest.json`. Si `projects/` es un enlace simbólico, la copia falla. Durante una copia, pausa las ediciones directas de documentos y comprueba que la operación terminó correctamente y contiene `manifest.json`. Al restaurar, conserva las rutas absolutas de los documentos referenciados o actualízalas explícitamente.

## Desarrollo y configuración manual

Para ejecutar el servidor desde el código:

```sh
npm ci --ignore-scripts
npm run build
npm start
```

El proceso espera conexiones MCP por entrada y salida estándar; no es una consola interactiva. Para configurarlo manualmente en un cliente compatible, indica la ruta absoluta al ejecutable de Node.js 24 o posterior y el argumento `/ruta/absoluta/a/daybook/dist/mcp.js`. Opcionalmente, configura `DAYBOOK_HOME` con una ruta absoluta. Incorpora también el contenido de [`instructions/global.md`](instructions/global.md) a las instrucciones del cliente, siguiendo su mecanismo de configuración. Esta ejecución no registra el servidor ni las instrucciones automáticamente.

`npm test` ejecuta las pruebas. Los esquemas MCP describen los parámetros de las herramientas disponibles; la API directa también exporta `Daybook` desde el paquete.

## Licencia

[MIT](LICENSE)
