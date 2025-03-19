/**
 * Вкладка настроек плагина в интерфейсе Obsidian
 */
import { App, PluginSettingTab, Setting, TextComponent, ButtonComponent, Modal, Notice } from 'obsidian';
import { DeviceInfo, SyncMessage } from '../client/relay-client';
import RelaySyncPlugin from '../../main';
import { DeviceManager } from '../utils/device-id';

interface KeyInputModalProps {
    onSubmit: (key: string) => void;
    onClose: () => void;
}

/**
 * Модальное окно для ввода ключа приглашения
 */
class KeyInputModal extends Modal {
    private onSubmitCallback: (key: string) => void;
    private keyInput: TextComponent;
    private statusMessage: HTMLElement;

    constructor(app: App, props: KeyInputModalProps) {
        super(app);
        this.onSubmitCallback = props.onSubmit;
        this.onClose = props.onClose;
    }

    onOpen() {
        const { contentEl } = this;
        
        contentEl.empty();
        contentEl.addClass('relay-sync-modal-content');
        
        contentEl.createEl('h2', { text: 'Введите ключ приглашения' });
        
        contentEl.createEl('p', { 
            text: 'Введите ключ, полученный от другого пользователя, для подключения к его устройству.',
            cls: 'relay-sync-modal-description'
        });
        
        const inputContainer = contentEl.createDiv({
            cls: 'relay-sync-key-input-container'
        });
        
        this.keyInput = new TextComponent(inputContainer)
            .setPlaceholder('XXXXXXXX')
            .setValue('');
        
        this.keyInput.inputEl.style.textTransform = 'uppercase';
        
        // Подсказка о формате ключа
        const helpText = contentEl.createEl('p', {
            text: 'Ключ должен содержать только буквы и цифры, не менее 6 символов.',
            cls: 'relay-sync-key-help'
        });
        
        // Элемент для отображения статуса
        this.statusMessage = contentEl.createEl('div', {
            cls: 'relay-sync-status-message',
            text: ''
        });
        
        // Автоматически форматируем ввод как ключ (только буквы и цифры, uppercase)
        this.keyInput.inputEl.addEventListener('input', () => {
            const value = this.keyInput.getValue();
            const formatted = value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
            if (value !== formatted) {
                this.keyInput.setValue(formatted);
            }
            
            // Обновляем статус валидации
            if (formatted.length < 6) {
                this.statusMessage.setText('Ключ должен содержать не менее 6 символов');
                this.statusMessage.style.color = 'orange';
            } else {
                this.statusMessage.setText('Ключ валиден, готов к отправке');
                this.statusMessage.style.color = 'green';
            }
        });
        
        const buttonContainer = contentEl.createDiv({
            cls: 'relay-sync-modal-buttons'
        });
        
        new ButtonComponent(buttonContainer)
            .setButtonText('Отмена')
            .onClick(() => {
                this.close();
            });
        
        // Функция для отправки ключа
        const submitKey = () => {
            const key = this.keyInput.getValue().trim();
            if (key.length < 6) {
                this.statusMessage.setText('Ключ должен содержать не менее 6 символов');
                this.statusMessage.style.color = 'red';
                return;
            }
            
            this.statusMessage.setText('Отправка запроса синхронизации...');
            this.statusMessage.style.color = 'blue';
            
            // Сообщаем, что запрос отправляется
            new Notice('Отправка запроса синхронизации...');
            
            // Вызываем колбэк с ключом
            this.onSubmitCallback(key);
            
            // Закрываем модальное окно
            this.close();
        };
        
        // Добавляем слушатель для Enter
        this.keyInput.inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                submitKey();
            }
        });
        
        new ButtonComponent(buttonContainer)
            .setButtonText('Подключиться')
            .setCta()
            .onClick(submitKey);
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

/**
 * Модальное окно для подтверждения запроса синхронизации
 */
class SyncRequestModal extends Modal {
    private request: SyncMessage;
    private onAccept: (requestId: string, trust: boolean) => void;
    private onDecline: (requestId: string) => void;

    constructor(app: App, request: SyncMessage, 
                onAccept: (requestId: string, trust: boolean) => void,
                onDecline: (requestId: string) => void) {
        super(app);
        this.request = request;
        this.onAccept = onAccept;
        this.onDecline = onDecline;
    }

    onOpen() {
        const { contentEl } = this;
        const { deviceName, requestId } = this.request;
        
        contentEl.empty();
        contentEl.addClass('relay-sync-modal-content');
        
        contentEl.createEl('h2', { text: 'Запрос на синхронизацию' });
        
        contentEl.createEl('p', { 
            text: `Устройство "${deviceName || 'Неизвестное'}" запрашивает доступ к синхронизации.`,
            cls: 'relay-sync-modal-description'
        });

        let trustPermanently = false;
        
        // Опция "Доверять постоянно"
        const trustSetting = new Setting(contentEl)
            .setName('Доверять постоянно')
            .setDesc('Добавить устройство в список доверенных для автоматической синхронизации')
            .addToggle(toggle => {
                toggle.setValue(false)
                    .onChange(value => {
                        trustPermanently = value;
                    });
            });
        
        const buttonContainer = contentEl.createDiv({
            cls: 'relay-sync-modal-buttons'
        });
        
        new ButtonComponent(buttonContainer)
            .setButtonText('Отклонить')
            .onClick(() => {
                if (requestId) {
                    this.onDecline(requestId);
                }
                this.close();
            });
        
        new ButtonComponent(buttonContainer)
            .setButtonText('Принять')
            .setCta()
            .onClick(() => {
                if (requestId) {
                    this.onAccept(requestId, trustPermanently);
                }
                this.close();
            });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

/**
 * Вкладка настроек плагина
 */
export class RelaySyncSettingsTab extends PluginSettingTab {
    private plugin: RelaySyncPlugin;

    constructor(app: App, plugin: RelaySyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        
        containerEl.empty();
        
        // Заголовок
        containerEl.createEl('h2', { text: 'Настройки Relay Sync' });
        
        // Секция подключения
        containerEl.createEl('h3', { text: 'Подключение' });
        
        // Выбор сервера
        const serverSetting = new Setting(containerEl)
            .setName('Сервер синхронизации')
            .setDesc('Выберите предварительно настроенный сервер или укажите свой');

        // Контейнер для радиокнопок
        const radioContainer = serverSetting.controlEl.createDiv({
            cls: 'relay-sync-server-selection'
        });

        // Создаем радиокнопку для сервера по умолчанию
        const defaultServerContainer = radioContainer.createDiv({
            cls: 'relay-sync-radio-option'
        });
        
        const defaultServerRadio = defaultServerContainer.createEl('input', {
            attr: {
                type: 'radio',
                name: 'server-type',
                id: 'default-server',
                value: 'default'
            }
        });
        
        defaultServerContainer.createEl('label', {
            text: 'Сервер по умолчанию (ws://176.53.161.220:8080/ws)',
            attr: {
                for: 'default-server'
            }
        });

        // Создаем радиокнопку для пользовательского сервера
        const customServerContainer = radioContainer.createDiv({
            cls: 'relay-sync-radio-option'
        });
        
        const customServerRadio = customServerContainer.createEl('input', {
            attr: {
                type: 'radio',
                name: 'server-type',
                id: 'custom-server',
                value: 'custom'
            }
        });
        
        customServerContainer.createEl('label', {
            text: 'Свой сервер',
            attr: {
                for: 'custom-server'
            }
        });

        // Поле ввода для URL пользовательского сервера
        const customUrlContainer = serverSetting.controlEl.createDiv({
            cls: 'relay-sync-custom-url-container'
        });
        
        const customUrlInput = new TextComponent(customUrlContainer)
            .setPlaceholder('wss://your-relay-server.com')
            .setValue(this.plugin.settings.serverUrl !== 'ws://176.53.161.220:8080/ws' 
                ? this.plugin.settings.serverUrl 
                : '');

        // Установим начальное состояние радиокнопок
        if (this.plugin.settings.serverUrl === 'ws://176.53.161.220:8080/ws' || !this.plugin.settings.serverUrl) {
            defaultServerRadio.checked = true;
            customUrlContainer.style.display = 'none';
        } else {
            customServerRadio.checked = true;
            customUrlContainer.style.display = 'block';
        }

        // Обработчики событий для радиокнопок
        defaultServerRadio.addEventListener('change', async () => {
            if (defaultServerRadio.checked) {
                customUrlContainer.style.display = 'none';
                this.plugin.settings.serverUrl = 'ws://176.53.161.220:8080/ws';
                await this.plugin.saveSettings();
            }
        });

        customServerRadio.addEventListener('change', async () => {
            if (customServerRadio.checked) {
                customUrlContainer.style.display = 'block';
                this.plugin.settings.serverUrl = customUrlInput.getValue() || '';
                await this.plugin.saveSettings();
            }
        });

        // Обработчик изменения URL пользовательского сервера
        customUrlInput.onChange(async (value) => {
            if (customServerRadio.checked) {
                this.plugin.settings.serverUrl = value;
                await this.plugin.saveSettings();
            }
        });
        
        // Пароль шифрования
        new Setting(containerEl)
            .setName('Пароль шифрования')
            .setDesc('Используется для шифрования данных. Должен быть одинаковым на всех устройствах.')
            .addText(text => text
                .setPlaceholder('Введите надежный пароль')
                .setValue(this.plugin.settings.encryptionPassword)
                .onChange(async (value) => {
                    this.plugin.settings.encryptionPassword = value;
                    await this.plugin.saveSettings();
                })
            );
        
        // Имя устройства
        new Setting(containerEl)
            .setName('Имя устройства')
            .setDesc('Имя этого устройства, которое будут видеть другие пользователи')
            .addText(text => text
                .setPlaceholder('Мой ноутбук')
                .setValue(DeviceManager.getDeviceName())
                .onChange(async (value) => {
                    DeviceManager.setDeviceName(value);
                })
            );
        
        // Интервал полной синхронизации
        new Setting(containerEl)
            .setName('Интервал полной синхронизации')
            .setDesc('Интервал в минутах между полными синхронизациями (0 для отключения)')
            .addText(text => text
                .setPlaceholder('30')
                .setValue(String(Math.floor(this.plugin.settings.fullSyncInterval / 60000) || 0))
                .onChange(async (value) => {
                    const minutes = parseInt(value) || 0;
                    this.plugin.settings.fullSyncInterval = minutes * 60000;
                    await this.plugin.saveSettings();
                    this.plugin.updateSyncOptions();
                })
            );
            
        // Автоматическое подключение при запуске
        new Setting(containerEl)
            .setName('Автоматическое подключение')
            .setDesc('Автоматически подключаться к серверу при запуске Obsidian')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoConnect)
                .onChange(async (value) => {
                    this.plugin.settings.autoConnect = value;
                    await this.plugin.saveSettings();
                    new Notice(`Автоподключение ${value ? 'включено' : 'выключено'}`);
                })
            );
        
        // Секция синхронизации
        containerEl.createEl('h3', { text: 'Синхронизация' });
        
        // Статус подключения
        const statusSetting = new Setting(containerEl)
            .setName('Статус')
            .setDesc('Статус подключения к серверу');
        
        const statusIndicator = statusSetting.controlEl.createDiv({ cls: 'relay-sync-status' });
        const statusDot = statusIndicator.createDiv({ cls: 'relay-sync-status-indicator' });
        const statusText = statusIndicator.createSpan();
        
        if (this.plugin.syncManager?.isConnected()) {
            statusDot.addClass('relay-sync-status-online');
            statusText.textContent = 'Подключено';
        } else {
            statusDot.addClass('relay-sync-status-offline');
            statusText.textContent = 'Отключено';
        }
        
        // Кнопка подключения/отключения
        const connectionSetting = new Setting(containerEl)
            .setName('Управление соединением')
            .setDesc('Подключиться или отключиться от сервера');
        
        const connectButton = new ButtonComponent(connectionSetting.controlEl)
            .setCta()
            .onClick(async () => {
                if (this.plugin.syncManager?.isConnected()) {
                    // Отключаемся
                    this.plugin.stopSync();
                    connectButton.setButtonText('Подключиться');
                    statusDot.removeClass('relay-sync-status-online');
                    statusDot.addClass('relay-sync-status-offline');
                    statusText.textContent = 'Отключено';
                } else {
                    // Подключаемся
                    await this.plugin.startSync();
                    connectButton.setButtonText('Отключиться');
                    statusDot.removeClass('relay-sync-status-offline');
                    statusDot.addClass('relay-sync-status-online');
                    statusText.textContent = 'Подключено';
                }
            });
        
        connectButton.setButtonText(
            this.plugin.syncManager?.isConnected() ? 'Отключиться' : 'Подключиться'
        );
        
        // Кнопка полной синхронизации
        new Setting(containerEl)
            .setName('Полная синхронизация')
            .setDesc('Принудительно синхронизировать все файлы')
            .addButton(button => button
                .setButtonText('Синхронизировать')
                .onClick(async () => {
                    if (!this.plugin.syncManager?.isConnected()) {
                        new Notice('Необходимо подключиться к серверу');
                        return;
                    }
                    
                    button.setButtonText('Синхронизация...');
                    button.setDisabled(true);
                    try {
                        new Notice('Начата полная синхронизация...');
                        await this.plugin.syncManager.forceFullSync();
                    } catch (error) {
                        console.error("Error during force sync:", error);
                        new Notice(`Ошибка синхронизации: ${error.message}`);
                    } finally {
                        button.setButtonText('Синхронизировать');
                        button.setDisabled(false);
                    }
                })
            );
        
        // Секция подключения новых устройств
        containerEl.createEl('h3', { text: 'Подключение устройств' });
        
        // Кнопка создания ключа приглашения
        const invitationKeySetting = new Setting(containerEl)
            .setName('Ключ приглашения')
            .setDesc('Создать ключ для подключения другого устройства');
        
        let keyElement: HTMLElement | null = null;
        
        invitationKeySetting.addButton(button => button
            .setButtonText('Создать ключ')
            .onClick(async () => {
                if (!this.plugin.syncManager?.isConnected()) {
                    new Notice('Необходимо подключиться к серверу');
                    return;
                }
                
                try {
                    // Удаляем предыдущий ключ, если он есть
                    if (keyElement) {
                        keyElement.remove();
                        keyElement = null;
                    }
                    
                    const key = await this.plugin.syncManager.generateInvitationKey();
                    
                    keyElement = containerEl.createDiv({ cls: 'relay-sync-key' });
                    keyElement.textContent = key;
                    
                    // Добавляем кнопку копирования
                    const copyButton = keyElement.createEl('button', {
                        text: 'Копировать',
                        cls: 'relay-sync-copy-button'
                    });
                    
                    copyButton.addEventListener('click', () => {
                        navigator.clipboard.writeText(key).then(() => {
                            new Notice('Ключ скопирован в буфер обмена');
                        });
                    });
                    
                    // Автоматически удаляем ключ через 10 минут
                    setTimeout(() => {
                        if (keyElement) {
                            keyElement.remove();
                            keyElement = null;
                        }
                    }, 10 * 60 * 1000);
                    
                    new Notice('Ключ приглашения создан (действителен 10 минут)');
                } catch (error) {
                    console.error('Error generating invitation key:', error);
                    new Notice('Ошибка при создании ключа: ' + error.message);
                }
            }));
        
        // Кнопка ввода ключа приглашения
        new Setting(containerEl)
            .setName('Подключиться к устройству')
            .setDesc('Ввести ключ приглашения от другого устройства')
            .addButton(button => button
                .setButtonText('Ввести ключ')
                .onClick(() => {
                    if (!this.plugin.syncManager?.isConnected()) {
                        new Notice('Необходимо подключиться к серверу');
                        return;
                    }
                    
                    new KeyInputModal(this.app, {
                        onSubmit: async (key) => {
                            try {
                                const success = await this.plugin.syncManager?.useInvitationKey(key);
                                if (success) {
                                    new Notice('Запрос на синхронизацию отправлен. Ожидайте подтверждения.');
                                } else {
                                    new Notice('Ошибка при подключении. Проверьте ключ и повторите попытку.');
                                }
                            } catch (error) {
                                console.error('Error using invitation key:', error);
                                new Notice('Ошибка при использовании ключа: ' + error.message);
                            }
                        },
                        onClose: () => {}
                    }).open();
                })
            );
        
        // Секция запросов на синхронизацию
        const pendingRequests = this.plugin.syncManager?.getPendingSyncRequests() || [];
        
        if (pendingRequests.length > 0) {
            containerEl.createEl('h3', { text: 'Ожидающие запросы' });
            
            for (const request of pendingRequests) {
                if (!request.requestId || !request.sourceDeviceId) continue;
                
                new Setting(containerEl)
                    .setName(`Запрос от ${request.deviceName || 'Неизвестного устройства'}`)
                    .setDesc('Запрос на синхронизацию')
                    .addButton(button => button
                        .setButtonText('Просмотреть')
                        .onClick(() => {
                            new SyncRequestModal(
                                this.app,
                                request,
                                async (requestId, trust) => {
                                    try {
                                        new Notice('Обработка запроса синхронизации...');
                                        
                                        const success = await this.plugin.syncManager?.respondToSyncRequest(
                                            requestId, true, trust
                                        );
                                        
                                        if (success) {
                                            new Notice('Запрос принят! Устройство добавлено в доверенные.');
                                            
                                            // Добавляем небольшую задержку перед обновлением интерфейса
                                            setTimeout(() => {
                                                this.display(); // Обновляем интерфейс
                                            }, 1000);
                                        } else {
                                            new Notice('Ошибка при принятии запроса');
                                        }
                                    } catch (error) {
                                        console.error('Error accepting sync request:', error);
                                        new Notice('Ошибка при принятии запроса: ' + error.message);
                                    }
                                },
                                async (requestId) => {
                                    try {
                                        new Notice('Отклонение запроса синхронизации...');
                                        
                                        const success = await this.plugin.syncManager?.respondToSyncRequest(
                                            requestId, false, false
                                        );
                                        
                                        if (success) {
                                            new Notice('Запрос успешно отклонен');
                                            
                                            // Добавляем небольшую задержку перед обновлением интерфейса
                                            setTimeout(() => {
                                                this.display(); // Обновляем интерфейс
                                            }, 1000);
                                        } else {
                                            new Notice('Ошибка при отклонении запроса');
                                        }
                                    } catch (error) {
                                        console.error('Error declining sync request:', error);
                                        new Notice('Ошибка при отклонении запроса: ' + error.message);
                                    }
                                }
                            ).open();
                        })
                    );
            }
        }
        
        // Секция доверенных устройств
        containerEl.createEl('h3', { text: 'Доверенные устройства' });
        
        const trustedDevices = this.plugin.syncManager?.getTrustedDevices() || [];
        
        if (trustedDevices.length === 0) {
            containerEl.createEl('p', {
                text: 'Нет доверенных устройств. Подключитесь к другому устройству или примите запрос на синхронизацию.',
                cls: 'relay-sync-empty-list'
            });
        } else {
            const deviceList = containerEl.createDiv({ cls: 'relay-sync-device-list' });
            
            for (const device of trustedDevices) {
                const deviceItem = deviceList.createDiv({ cls: 'relay-sync-device-item' });
                
                const deviceInfo = deviceItem.createDiv({ cls: 'relay-sync-device-info' });
                deviceInfo.createDiv({ text: device.name, cls: 'relay-sync-device-name' });
                deviceInfo.createDiv({ text: `ID: ${device.id}`, cls: 'relay-sync-device-id' });
                
                const actionButtons = deviceItem.createDiv({ cls: 'relay-sync-device-actions' });
                
                const revokeButton = actionButtons.createEl('button', {
                    text: 'Отозвать доверие',
                    cls: 'relay-sync-revoke-button'
                });
                
                revokeButton.addEventListener('click', async () => {
                    try {
                        const success = await this.plugin.syncManager?.revokeTrust(device.id);
                        
                        if (success) {
                            new Notice(`Доверие к устройству ${device.name} отозвано`);
                            this.display(); // Обновляем интерфейс
                        } else {
                            new Notice('Ошибка при отзыве доверия');
                        }
                    } catch (error) {
                        console.error('Error revoking trust:', error);
                        new Notice('Ошибка при отзыве доверия: ' + error.message);
                    }
                });
            }
        }
        
        // Секция обновлений
        containerEl.createEl('h3', { text: 'Обновления' });
        
        // Автоматическая проверка обновлений
        new Setting(containerEl)
            .setName('Автоматическая проверка обновлений')
            .setDesc('Периодически проверять наличие обновлений плагина')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoCheckForUpdates)
                .onChange(async (value) => {
                    this.plugin.settings.autoCheckForUpdates = value;
                    await this.plugin.saveSettings();
                })
            );
        
        // Интервал проверки обновлений
        new Setting(containerEl)
            .setName('Интервал проверки обновлений')
            .setDesc('Как часто проверять наличие обновлений (в днях)')
            .addText(text => text
                .setPlaceholder('1')
                .setValue(String(this.plugin.settings.updateCheckInterval || 1))
                .onChange(async (value) => {
                    const days = parseInt(value) || 1;
                    this.plugin.settings.updateCheckInterval = days;
                    await this.plugin.saveSettings();
                })
            );
        
        // Кнопка проверки обновлений
        new Setting(containerEl)
            .setName('Проверить обновления')
            .setDesc('Проверить наличие обновлений плагина')
            .addButton(button => button
                .setButtonText('Проверить')
                .onClick(async () => {
                    button.setButtonText('Проверка...');
                    button.setDisabled(true);
                    
                    try {
                        await this.plugin.checkForUpdates(true);
                    } catch (error) {
                        console.error('Error checking for updates:', error);
                    } finally {
                        button.setButtonText('Проверить');
                        button.setDisabled(false);
                    }
                })
            );
        
        // Секция исключений
        containerEl.createEl('h3', { text: 'Исключения' });
        
        // Игнорируемые пути
        const ignoredPathsSetting = new Setting(containerEl)
            .setName('Игнорируемые пути')
            .setDesc('Пути, которые будут исключены из синхронизации (по одному на строку)');
        
        const ignoredPathsField = ignoredPathsSetting.controlEl.createEl('textarea', {
            cls: 'relay-sync-ignored-paths',
            attr: {
                rows: '5'
            }
        });
        
        ignoredPathsField.value = (this.plugin.settings.ignoredPaths || []).join('\n');
        
        ignoredPathsField.addEventListener('change', async () => {
            const paths = ignoredPathsField.value
                .split('\n')
                .map(path => path.trim())
                .filter(path => path.length > 0);
            
            this.plugin.settings.ignoredPaths = paths;
            await this.plugin.saveSettings();
            this.plugin.updateSyncOptions();
        });
    }
}