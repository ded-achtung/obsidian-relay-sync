import { App, Plugin, PluginSettingTab, Setting, Notice } from 'obsidian';
import { RelaySyncSettingsTab } from './src/ui/settings-tab';
import { StatusBarItem, SyncStatus, SyncStats } from './src/ui/status-bar';
import { SyncManager, SyncOptions } from './src/client/sync-manager';
import { DeviceManager } from './src/utils/device-id';

interface RelaySyncSettings {
    serverUrl: string;
    encryptionPassword: string;
    ignoredPaths: string[];
    fullSyncInterval: number; // в миллисекундах
    autoConnect: boolean;
}

const DEFAULT_SETTINGS: RelaySyncSettings = {
    serverUrl: 'ws://176.53.161.220:8080/ws',
    encryptionPassword: '',
    ignoredPaths: [
        '.obsidian/',
        '.git/',
        '.sync/'
    ],
    fullSyncInterval: 30 * 60 * 1000, // 30 минут
    autoConnect: true // Изменено на true для автоматического подключения
};

export default class RelaySyncPlugin extends Plugin {
    settings: RelaySyncSettings;
    syncManager: SyncManager | null = null;
    statusBarItem: StatusBarItem | null = null;

    async onload() {
        console.log('Loading Relay Sync plugin');

        await this.loadSettings();

        // Проверка и коррекция автоподключения (для обратной совместимости)
        if (this.settings.autoConnect === undefined) {
            console.log('Автоподключение не настроено, устанавливаем значение по умолчанию: true');
            this.settings.autoConnect = true;
            await this.saveSettings();
        }

        // Добавляем вкладку настроек
        this.addSettingTab(new RelaySyncSettingsTab(this.app, this));

        // Добавляем элемент в статусную строку
        this.statusBarItem = new StatusBarItem(this.addStatusBarItem());

        // Регистрируем команды
        this.addCommands();

        // Если включено автоподключение, запускаем синхронизацию
        if (this.settings.autoConnect && this.settings.serverUrl && this.settings.encryptionPassword) {
            console.log('Автоподключение активировано, подключаемся к серверу...');
            // Используем небольшую задержку для инициализации 
            setTimeout(() => {
                this.startSync().catch(error => {
                    console.error('Error auto-connecting:', error);
                    new Notice('Ошибка автоподключения: ' + error.message);
                });
            }, 2000);
        } else {
            console.log('Автоподключение не активировано: autoConnect=' + this.settings.autoConnect);
        }
    }

    /**
     * Регистрация команд плагина
     */
    private addCommands() {
        // Команда для подключения/отключения синхронизации
        this.addCommand({
            id: 'toggle-sync',
            name: 'Включить/выключить синхронизацию',
            callback: async () => {
                if (this.syncManager?.isConnected()) {
                    this.stopSync();
                } else {
                    await this.startSync();
                }
            }
        });

        // Команда для принудительной полной синхронизации
        this.addCommand({
            id: 'full-sync',
            name: 'Выполнить полную синхронизацию',
            callback: async () => {
                if (!this.syncManager?.isConnected()) {
                    new Notice('Сначала необходимо подключиться к серверу');
                    return;
                }

                // Обновляем индикатор статуса и показываем начало синхронизации
                const syncState = this.syncManager['syncState']; // Обращаемся к приватному полю
                const fileCount = Object.keys(syncState?.files || {}).length;
                
                this.statusBarItem?.setStatus(SyncStatus.SYNCING, {
                    syncProgress: 0,
                    filesTotal: fileCount,
                    filesChanged: 0
                });
                
                try {
                    // Запоминаем время начала для отслеживания прогресса
                    const startTime = Date.now();

                    // Отслеживаем прогресс синхронизации
                    const progressTracker = setInterval(() => {
                        if (!this.syncManager || !this.syncManager['isSyncing']) {
                            clearInterval(progressTracker);
                            return;
                        }
                        
                        // Имитируем прогресс (в идеале нужно получать реальный прогресс из SyncManager)
                        // Постепенно увеличиваем прогресс
                        const progressValue = Math.min(90, (Date.now() - startTime) / 500);
                        this.statusBarItem?.setStatus(SyncStatus.SYNCING, {
                            syncProgress: Math.floor(progressValue)
                        });
                    }, 1000);
                    
                    // Запускаем синхронизацию
                    await this.syncManager.performFullSync();
                    
                    // Останавливаем трекер прогресса
                    clearInterval(progressTracker);
                    
                    // Обновляем индикатор статуса
                    const updatedSyncState = this.syncManager['syncState'];
                    this.statusBarItem?.setStatus(SyncStatus.CONNECTED, {
                        lastSyncTime: updatedSyncState?.lastSyncTime || Date.now(),
                        filesTotal: Object.keys(updatedSyncState?.files || {}).length,
                        syncProgress: 100
                    });
                    
                    new Notice('Полная синхронизация завершена');
                } catch (error) {
                    console.error('Error during full sync:', error);
                    this.statusBarItem?.setStatus(SyncStatus.ERROR, {
                        errorMessage: error.message
                    });
                    new Notice('Ошибка при синхронизации: ' + error.message);
                }
            }
        });

        // Команда для создания ключа приглашения
        this.addCommand({
            id: 'generate-invitation-key',
            name: 'Создать ключ приглашения',
            callback: async () => {
                if (!this.syncManager?.isConnected()) {
                    new Notice('Сначала необходимо подключиться к серверу');
                    return;
                }

                try {
                    const key = await this.syncManager.generateInvitationKey();
                    navigator.clipboard.writeText(key).then(() => {
                        new Notice('Ключ скопирован в буфер обмена: ' + key);
                    });
                } catch (error) {
                    console.error('Error generating invitation key:', error);
                    new Notice('Ошибка при создании ключа: ' + error.message);
                }
            }
        });
    }

    /**
     * Запуск процесса синхронизации
     */
    async startSync(): Promise<void> {
        // Проверяем настройки
        if (!this.settings.serverUrl) {
            new Notice('Необходимо указать URL сервера синхронизации');
            return;
        }

        if (!this.settings.encryptionPassword) {
            new Notice('Необходимо указать пароль шифрования');
            return;
        }
        
        // Исправляем URL, если в нем есть двойной протокол
        let serverUrl = this.settings.serverUrl;
        if (serverUrl.startsWith('wss://https//') || serverUrl.startsWith('wss://http//')) {
            serverUrl = 'wss://' + serverUrl.substring(serverUrl.indexOf('//') + 2);
            // Обновляем настройки с исправленным URL
            this.settings.serverUrl = serverUrl;
            await this.saveSettings();
            new Notice('URL сервера был автоматически исправлен');
        }

        try {
            // Создаем и инициализируем менеджер синхронизации
            this.syncManager = new SyncManager(this.app, {
                serverUrl: serverUrl,
                encryptionPassword: this.settings.encryptionPassword,
                ignoredPaths: this.settings.ignoredPaths,
                fullSyncInterval: this.settings.fullSyncInterval
            });

            // Обновляем индикатор статуса
            this.statusBarItem?.setStatus(SyncStatus.SYNCING, {
                syncProgress: 0,
                filesChanged: 0
            });

            // Запускаем синхронизацию
            await this.syncManager.start();

            // Начинаем периодическое обновление статистики
            this.startStatusUpdates();

            // Обновляем индикатор статуса
            const trustedDevices = this.syncManager.getTrustedDevices();
            const syncState = this.syncManager['syncState']; // Обращаемся к приватному полю
            
            this.statusBarItem?.setStatus(SyncStatus.CONNECTED, {
                lastSyncTime: syncState?.lastSyncTime || Date.now(),
                filesTotal: Object.keys(syncState?.files || {}).length,
                trustedDevices: (trustedDevices?.length || 0)
            });
            
            new Notice('Подключено к серверу синхронизации');
        } catch (error) {
            console.error('Error starting sync:', error);
            this.statusBarItem?.setStatus(SyncStatus.ERROR, {
                errorMessage: error.message
            });
            new Notice('Ошибка при подключении: ' + error.message);
        }
    }
    
    /**
     * Запуск обновлений статуса
     */
    private statusUpdateInterval: NodeJS.Timeout | null = null;
    
    private startStatusUpdates(): void {
        // Останавливаем существующий интервал, если есть
        if (this.statusUpdateInterval) {
            clearInterval(this.statusUpdateInterval);
        }
        
        // Запускаем интервал обновления статуса
        this.statusUpdateInterval = setInterval(() => {
            if (!this.syncManager) return;
            
            try {
                const isConnected = this.syncManager.isConnected();
                const isSyncing = this.syncManager['isSyncing']; // Обращаемся к приватному полю
                const syncState = this.syncManager['syncState']; // Обращаемся к приватному полю
                const trustedDevices = this.syncManager.getTrustedDevices();
                
                const statsUpdate: SyncStats = {
                    lastSyncTime: syncState?.lastSyncTime || Date.now(),
                    filesTotal: Object.keys(syncState?.files || {}).length,
                    trustedDevices: (trustedDevices?.length || 0)
                };
                
                // Обновляем статус на основе текущего состояния
                if (!isConnected) {
                    this.statusBarItem?.setStatus(SyncStatus.DISCONNECTED);
                } else if (isSyncing) {
                    // Обновляем прогресс синхронизации (это примерная оценка)
                    this.statusBarItem?.setStatus(SyncStatus.SYNCING, statsUpdate);
                } else {
                    this.statusBarItem?.setStatus(SyncStatus.CONNECTED, statsUpdate);
                }
            } catch (error) {
                console.error('Error updating status:', error);
            }
        }, 5000); // Обновляем каждые 5 секунд
    }

    /**
     * Остановка процесса синхронизации
     */
    stopSync(): void {
        try {
            // Останавливаем интервал обновления статуса
            if (this.statusUpdateInterval) {
                clearInterval(this.statusUpdateInterval);
                this.statusUpdateInterval = null;
            }
            
            if (this.syncManager) {
                this.syncManager.stop();
                this.syncManager = null;
            }
            
            this.statusBarItem?.setStatus(SyncStatus.DISCONNECTED);
            new Notice('Отключено от сервера синхронизации');
        } catch (error) {
            console.error('Error stopping sync:', error);
            this.statusBarItem?.setStatus(SyncStatus.ERROR, {
                errorMessage: error.message
            });
            new Notice('Ошибка при отключении: ' + error.message);
        }
    }

    /**
     * Обновление настроек синхронизации
     */
    updateSyncOptions(): void {
        if (this.syncManager) {
            this.syncManager.updateOptions({
                serverUrl: this.settings.serverUrl,
                encryptionPassword: this.settings.encryptionPassword,
                ignoredPaths: this.settings.ignoredPaths,
                fullSyncInterval: this.settings.fullSyncInterval
            });
        }
    }

    async onunload() {
        console.log('Unloading Relay Sync plugin');
        
        // Останавливаем интервал обновления статуса
        if (this.statusUpdateInterval) {
            clearInterval(this.statusUpdateInterval);
            this.statusUpdateInterval = null;
        }
        
        // Останавливаем процесс синхронизации
        if (this.syncManager) {
            this.syncManager.stop();
            this.syncManager = null;
        }
    }

    async loadSettings() {
        // Загружаем настройки
        const savedData = await this.loadData();
        
        // Принудительно включаем автоподключение (можно будет отключить в настройках)
        if (savedData) {
            savedData.autoConnect = true;
        }
        
        // Объединяем настройки по умолчанию с сохраненными
        this.settings = Object.assign({}, DEFAULT_SETTINGS, savedData);
        
        // Убеждаемся, что autoConnect всегда true
        this.settings.autoConnect = true;
        
        // Сохраняем обновленные настройки
        await this.saveSettings();
        
        console.log('Настройки загружены, autoConnect =', this.settings.autoConnect);
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}