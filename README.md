# DeepSeek Harness — Desktop

Десктопная оболочка для агента [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
отдельное окно с native-рамкой, иконкой и установщиком вместо вкладки браузера.

Внутри оболочка запускает локальный `dsh web`, ждёт, пока тот начнёт принимать
соединения, и показывает его интерфейс в окне Electron.

```
┌───────────────────────────────────────────────┐
│  DeepSeek Harness                 [_] [□] [X] │
├───────────────────────────────────────────────┤
│                                               │
│   интерфейс dsh web (127.0.0.1, случайный     │
│   порт), обслуживается дочерним процессом     │
│                                               │
└───────────────────────────────────────────────┘
```

## Что нужно

- **Node.js ≥ 24.9** — на нём работает сам `dsh`
- **DSH, установленный глобально**:

  ```powershell
  npm i -g @deepseek-ai/dsh
  ```

  Оболочка находит его сама: рядом с `node`, в `%APPDATA%\npm\node_modules`,
  `/usr/local/lib/node_modules` и т.д. Если пакет лежит нестандартно — укажите
  путь явно: `set DSH_BIN=C:\path\to\dsh\lib\bin.js`.

## Запуск из исходников

```powershell
npm install
npm start
```

## Сборка

```powershell
npm run dist:win     # установщик NSIS            →  dist\
npm run dist:mac     # dmg + zip                   →  dist\
npm run dist:linux   # AppImage + deb              →  dist\
```

Кросс-компиляция не поддерживается: macOS-сборку нужно делать на macOS,
Linux — на Linux (или через GitHub Actions, см. `.github/workflows/build.yml`).
Windows-установщик собирается здесь же.

## Переменные окружения

| Переменная | Что делает |
|---|---|
| `DSH_BIN` | Путь к `@deepseek-ai/dsh/lib/bin.js`, если автопоиск не сработал |
| `DSH_NODE` | Путь к `node.exe`, если в `PATH` не тот Node |
| `DSH_HOME` | Каталог профилей DSH (по умолчанию `~/.dsh`) |
| `DSH_DESKTOP_DATA` | Portable-режим: держать настройки и логи оболочки в своём каталоге |
| `DSH_DESKTOP_GPU=0` | Выключить аппаратное ускорение при проблемах с драйверами |
| `DSH_DESKTOP_CHROMIUM_SANDBOX=1` | Не отключать sandbox Chromium (см. ниже) |
| `DSH_DESKTOP_SMOKE=1` | Служебный: загрузиться, записать результат в `smoke-result.json` и выйти |

## Важно про `--no-sandbox`

В части окружений (контейнеры, сессии с урезанными правами) Chromium не может
поднять собственную песочницу и процесс падает с `STATUS_BREAKPOINT`
(`0x80000003`) **до** выполнения кода приложения. Поэтому:

- ярлык **«DeepSeek Harness Desktop»** (Рабочий стол и меню «Пуск») запускает
  приложение с `--no-sandbox`;
- рядом с `DeepSeek Harness.exe` лежит `Launch DeepSeek Harness.cmd` — тот же
  запуск, но без зависимости от ярлыков (полезно, если ярлык не создался);
- при ручном запуске из консоли добавляйте флаг сами:

```powershell
"dist\win-unpacked\DeepSeek Harness.exe" --no-sandbox
```

Окно при этом загружает только локальный интерфейс на `127.0.0.1`, переходы по
внешним ссылкам уходят в системный браузер. Если ваша система нормально
поднимает sandbox Chromium, задайте `DSH_DESKTOP_CHROMIUM_SANDBOX=1` и
запускайте без флага.

## Устройство

- `electron/main.js` — резолвит `node`/`dsh`, поднимает `dsh web --port 0`,
  ждёт TCP-порт, открывает интерфейс; вывод агента пишется в
  `%APPDATA%\DeepSeek Harness\logs\agent-server.log` и стримится на splash;
  при падении показывает экран с логом и кнопкой «Перезапустить».
- `electron/splash.html` — экран запуска и ошибок.
- `electron/preload.js` — минимальный мост (contextIsolation включён,
  nodeIntegration выключен).

Порты: оболочка просит у ОС свободный порт, так что она не конфликтует с уже
запущенным `dsh web` на 3080.

## Что пока не сделано

- Подпись кода: Windows покажет SmartScreen, macOS — Gatekeeper
  (нужны сертификаты).
- Автообновление.
- Собственный UI: пока это оболочка вокруг существующего веб-интерфейса.
