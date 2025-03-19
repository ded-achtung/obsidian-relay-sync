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
    autoCheckForUpdates: boolean;
    lastUpdateCheck: number;
    updateCheckInterval: number; // в днях
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
    autoConnect: true, // Изменено на true для автоматического подключения
    autoCheckForUpdates: true, // Автоматически проверять обновления
    lastUpdateCheck: 0, // Время последней проверки обновлений
    updateCheckInterval: 1 // Проверять обновления каждый день
};

export default class RelaySyncPlugin extends Plugin {
    settings: RelaySyncSettings;
    syncManager: SyncManager | null = null;
    statusBarItem: StatusBarItem | null = null;

    async onload() {
        console.log('Loading Relay Sync plugin');

        await this.loadSettings();

        // Проверка и коррекция настроек для обратной совместимости
        let needsSave = false;
        
        if (this.settings.autoConnect === undefined) {
            console.log('Автоподключение не настроено, устанавливаем значение по умолчанию: true');
            this.settings.autoConnect = true;
            needsSave = true;
        }
        
        if (this.settings.autoCheckForUpdates === undefined) {
            console.log('Автопроверка обновлений не настроена, устанавливаем значение по умолчанию: true');
            this.settings.autoCheckForUpdates = true;
            needsSave = true;
        }
        
        if (this.settings.updateCheckInterval === undefined) {
            this.settings.updateCheckInterval = 1; // Проверять раз в день по умолчанию
            needsSave = true;
        }
        
        if (needsSave) {
            await this.saveSettings();
        }

        // Добавляем вкладку настроек
        this.addSettingTab(new RelaySyncSettingsTab(this.app, this));

        // Добавляем элемент в статусную строку
        this.statusBarItem = new StatusBarItem(this.addStatusBarItem());

        // Регистрируем команды
        this.addCommands();

        // Проверяем наличие обновлений при запуске
        if (this.settings.autoCheckForUpdates) {
            this.checkForUpdates();
        }

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
        
        // Команда для проверки обновлений
        this.addCommand({
            id: 'check-for-updates',
            name: 'Проверить наличие обновлений',
            callback: async () => {
                new Notice('Проверка обновлений...');
                await this.checkForUpdates(true);
            }
        });
        
        // Команды для запуска тестов (только в режиме разработки)
        if (process.env.NODE_ENV === 'development' || true) { // Всегда включено для тестирования
            // Команда для запуска тестов оптимизации
            this.addCommand({
                id: 'run-optimizer-tests',
                name: 'Запустить тесты оптимизации',
                callback: async () => {
                    // Динамически загружаем тесты (чтобы не включать их в основную сборку)
                    const { runOptimizerTests } = await import('./src/tests/test-command');
                    await runOptimizerTests();
                }
            });
            
            // Команда для запуска всех тестов плагина
            this.addCommand({
                id: 'run-all-tests',
                name: 'Запустить все тесты плагина',
                callback: async () => {
                    // Динамически загружаем тесты
                    const { runAllTests } = await import('./src/tests/test-command');
                    await runAllTests();
                }
            });
            
            // Команда для запуска теста реальной синхронизации
            this.addCommand({
                id: 'run-real-sync-test',
                name: 'Запустить тест реальной синхронизации',
                callback: async () => {
                    // Динамически загружаем тесты
                    const { runRealSyncTests } = await import('./src/tests/test-command');
                    await runRealSyncTests();
                }
            });
            
            // Команда для запуска теста с моками
            this.addCommand({
                id: 'run-mock-sync-test',
                name: 'Запустить тест синхронизации с моками',
                callback: async () => {
                    // Динамически загружаем тесты
                    const { runMockSyncTests } = await import('./src/tests/test-command');
                    await runMockSyncTests();
                }
            });
        }
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

    /**
     * Проверка наличия обновлений
     */
    async checkForUpdates(manual = false): Promise<void> {
        try {
            // Импортируем здесь, чтобы избежать циклических зависимостей
            const { checkForUpdates } = await import('./src/utils/github-updater');
            
            // Проверяем нужно ли выполнять проверку обновлений
            const now = Date.now();
            const checkIntervalMs = this.settings.updateCheckInterval * 24 * 60 * 60 * 1000; // Дни в миллисекунды
            
            if (!manual && this.settings.lastUpdateCheck && now - this.settings.lastUpdateCheck < checkIntervalMs) {
                console.log('Пропуск проверки обновлений, последняя проверка была недавно');
                return;
            }
            
            // Обновляем время последней проверки
            this.settings.lastUpdateCheck = now;
            await this.saveSettings();
            
            console.log('Проверка обновлений...');
            const updateInfo = await checkForUpdates();
            
            if (updateInfo.available) {
                // Показываем уведомление о доступном обновлении
                const updateMessage = `Доступно обновление: ${updateInfo.latestVersion} (текущая: ${updateInfo.currentVersion})`;
                new Notice(updateMessage, 10000);
                
                // Открываем модальное окно с подробной информацией об обновлении, если это была ручная проверка
                if (manual) {
                    // Импортируем и открываем модальное окно с информацией об обновлении
                    import('./src/ui/update-modal').then(({ UpdateModal }) => {
                        new UpdateModal(this.app, updateInfo).open();
                    });
                }
            } else if (manual) {
                // Если это была ручная проверка, показываем уведомление о том, что обновлений нет
                new Notice('У вас установлена последняя версия плагина');
            }
        } catch (error) {
            console.error('Error checking for updates:', error);
            if (manual) {
                new Notice('Ошибка при проверке обновлений: ' + error.message);
            }
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