# Obsidian Relay Sync

A plugin for Obsidian that provides reliable and secure synchronization between devices through a relay server.

[По-русски](#русская-версия)

## Features

- 🔐 **Security**: End-to-end encryption, the server has no access to content
- 🔄 **Reliability**: Works through a relay server, bypassing P2P connection limitations
- 📱 **Cross-platform**: Full functionality on desktop and mobile devices
- 🗝️ **Trusted device system**: Key management and sync confirmations
- ⏱️ **Flexible settings**: Temporary keys, automatic disconnect, trusted device management

## Installation

### From Obsidian Community Plugins

1. Open Obsidian Settings
2. Go to Community Plugins
3. Turn off Restricted Mode
4. Click "Browse" and search for "Relay Sync"
5. Install the plugin and enable it

### Manual installation

1. Download the latest release
2. Extract the files to your Obsidian plugins folder: `{vault}/.obsidian/plugins/obsidian-relay-sync`
3. Restart Obsidian
4. Enable the plugin in Settings → Community Plugins

## Usage

1. Open plugin settings and enter your relay server URL
2. Set an encryption password (same on all devices)
3. Click "Connect" to start syncing
4. On other devices, use the invitation key system to establish trusted connections

## Self-hosting

The relay server is open-source and can be self-hosted. See the [server repository](https://github.com/YOUR_GITHUB_USERNAME/chrysaline-relay-server) for instructions.

---

## Русская версия

Плагин для Obsidian, обеспечивающий надежную и безопасную синхронизацию между устройствами через сервер-маршрутизатор.

## Особенности

- 🔐 **Безопасность**: Сквозное шифрование данных, сервер не имеет доступа к содержимому
- 🔄 **Надежность**: Работает через маршрутизатор, обходя ограничения прямых P2P-соединений
- 📱 **Кроссплатформенность**: Полноценная работа на настольных и мобильных устройствах
- 🗝️ **Система доверенных устройств**: Управление ключами и подтверждениями для синхронизации
- ⏱️ **Гибкие настройки**: Временные ключи, автоматическое отключение, управление доверенными устройствами

## План разработки

### Фаза 1: Базовая структура проекта и серверная часть

1. ✅ Создание базовой структуры плагина
2. Создание основных файлов плагина (main.ts, manifest.json, styles.css)
3. Разработка серверной части (Node.js + WebSocket)
   - Система регистрации устройств
   - Маршрутизация сообщений
   - Управление ключами приглашений
   - Список доверенных устройств

### Фаза 2: Клиентская часть и основные функции

1. Реализация WebSocket-клиента для взаимодействия с сервером
2. Система шифрования и дешифрования данных
3. Механизм отслеживания изменений файлов в Vault
4. Система разрешения конфликтов на основе CRDT
5. Интерфейс настроек плагина

### Фаза 3: Система безопасности и управления доступом

1. Реализация временных ключей для подключения
2. Механизм запросов и подтверждений синхронизации
3. Управление списком доверенных устройств
4. Настройки времени автоматического отключения
5. Ротация ключей безопасности

### Фаза 4: Пользовательский интерфейс и улучшения

1. Детальный UI для настроек и управления
2. Визуализация статуса синхронизации в статусной строке
3. Интерфейс для генерации и ввода ключей
4. Управление доверенными устройствами
5. Оптимизация производительности и использования батареи
