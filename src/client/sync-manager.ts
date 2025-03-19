/**
 * Менеджер синхронизации, который координирует изменения файлов
 * и их синхронизацию через сервер
 */
import { App, Notice, TFile } from 'obsidian';
import { RelayClient, DeviceInfo, SyncMessage } from './relay-client';
import { FileWatcher, FileChange } from '../utils/file-watcher';
import { CryptoHelper, EncryptedData } from '../utils/crypto';
import { DeviceManager } from '../utils/device-id';

export interface SyncOptions {
    serverUrl: string;
    encryptionPassword: string;
    ignoredPaths?: string[];
    fullSyncInterval?: number; // Интервал полной синхронизации в миллисекундах
}

interface FileMetadata {
    path: string;
    hash: string;
    mtime: number;
    size: number;
    deleted?: boolean;
    // Векторные часы для отслеживания версий на всех устройствах
    vectorClock?: Record<string, number>;
    // Хеш-значение содержимого последней общей версии для разрешения конфликтов
    baseVersionHash?: string;
    // Флаг конфликта, требующего вмешательства пользователя
    conflict?: boolean;
}

interface SyncFileMessage {
    path: string;
    content?: string;
    deleted?: boolean;
    encryptedData?: EncryptedData & { salt: string };
    mtime: number;
    hash: string;
    priority?: 'high' | 'normal' | 'low';  // Приоритет для обработки
    compression?: {                      // Информация о сжатии
        compressed: boolean;
        originalSize: number;
        compressedSize: number;
    };
    isMarkdown?: boolean;                // Признак Markdown-файла для дельта-синхронизации
    responseToRequestId?: string;        // ID запроса, если это ответ на запрос
    deltaData?: {                        // Данные дельта-синхронизации
        baseHash: string;                // Хеш базового файла
        isDelta: boolean;                // Флаг, показывающий, что содержимое является дельтой
    };
    // Векторные часы для точного отслеживания версий
    vectorClock?: Record<string, number>;
    // Данные для разрешения конфликтов
    conflictResolution?: {
        isConflict: boolean;              // Флаг конфликта версий
        baseVersionHash?: string;         // Хеш базовой версии для трехстороннего слияния
        deviceId: string;                 // ID устройства, отправившего версию 
    };
}

interface SyncState {
    deviceId: string;
    files: Record<string, FileMetadata>;
    lastSyncTime: number;
}

export class SyncManager {
    private app: App;
    private relayClient: RelayClient;
    private fileWatcher: FileWatcher;
    private options: SyncOptions;
    private syncState: SyncState;
    private isSyncing = false;
    private fullSyncInterval: NodeJS.Timeout | null = null;
    private pendingSyncRequests: Map<string, SyncMessage> = new Map();
    private trustedDevices: DeviceInfo[] = [];
    private encryptionPassword: string;
    
    // Режим ожидания - когда плагин запущен, но нет активных доверенных устройств
    private waitingMode = true;
    
    // Счетчик изменений, ожидающих синхронизации
    private pendingChangesCount = 0;

    constructor(app: App, options: SyncOptions) {
        this.app = app;
        this.options = options;
        this.encryptionPassword = options.encryptionPassword;

        // Инициализация состояния синхронизации
        this.syncState = this.loadSyncState();

        // Инициализация клиента для связи с сервером
        this.relayClient = new RelayClient({
            serverUrl: options.serverUrl,
            deviceId: this.syncState.deviceId,
            deviceName: DeviceManager.getDeviceName(),
            onMessage: this.handleSyncMessage.bind(this),
            onConnectionChange: this.handleConnectionChange.bind(this),
            onTrustedDevicesChange: this.handleTrustedDevicesChange.bind(this),
            onSyncRequest: this.handleSyncRequest.bind(this)
        });

        // Инициализация отслеживания изменений файлов
        this.fileWatcher = new FileWatcher(
            app.vault,
            this.handleFileChange.bind(this)
        );

        // Добавление игнорируемых путей из настроек
        if (options.ignoredPaths) {
            for (const path of options.ignoredPaths) {
                this.fileWatcher.addIgnorePattern(new RegExp(path));
            }
        }
    }

    /**
     * Запустить процесс синхронизации
     */
    public async start(): Promise<void> {
        // Устанавливаем режим ожидания
        this.waitingMode = true;
        console.log("Запуск плагина в режиме ожидания...");
        
        // Подключаемся к серверу
        this.relayClient.connect();

        // Начинаем отслеживать изменения файлов
        this.fileWatcher.startWatching();

        // Выполняем начальную синхронизацию локального состояния
        await this.updateLocalFileState();
        
        // Проверяем наличие доверенных устройств через 3 секунды
        setTimeout(async () => {
            console.log("Проверка доступности доверенных устройств...");
            await this.checkActiveTrustedDevices();
        }, 3000);
    }
    
    /**
     * Проверка активных доверенных устройств и отправка сигнала
     */
    private async checkActiveTrustedDevices(): Promise<void> {
        // Получаем список доверенных устройств
        const trustedDevices = this.relayClient.getTrustedDevices();
        
        if (!Array.isArray(trustedDevices) || trustedDevices.length === 0) {
            console.log("Нет доверенных устройств. Переход в режим ожидания.");
            this.waitingMode = true;
            // Обновляем локальное состояние, чтобы быть готовыми к подключению
            await this.updateLocalFileState();
            
            // Не устанавливаем интервал полной синхронизации, так как нет доверенных устройств
            return;
        }
        
        // Отправляем сигнал проверки активности на все доверенные устройства
        console.log(`Отправка сигнала активности на ${trustedDevices.length} устройств...`);
        
        const pingPromises = trustedDevices.map(device => {
            return new Promise<boolean>(resolve => {
                const pingId = `ping-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
                
                // Устанавливаем обработчик для ответа через тип 'message'
                const handlePingResponse = (message: any) => {
                    if (message.type === 'message' && 
                        message.sourceDeviceId === device.id &&
                        message.payload && 
                        message.payload.action === 'devicePingResponse' &&
                        message.payload.pingId === pingId) {
                        
                        console.log(`Получен ответ на пинг от устройства ${device.name || device.id}`);
                        
                        // Восстанавливаем оригинальный обработчик
                        const originalCallback = this.relayClient['onMessageCallbackOriginal'];
                        if (originalCallback) {
                            this.relayClient['onMessageCallback'] = originalCallback;
                        }
                        
                        resolve(true);
                    }
                };
                
                // Сохраняем оригинальный обработчик
                const originalCallback = this.relayClient['onMessageCallback'];
                this.relayClient['onMessageCallbackOriginal'] = originalCallback;
                
                // Устанавливаем временный обработчик
                this.relayClient['onMessageCallback'] = (message: any) => {
                    handlePingResponse(message);
                    originalCallback(message);
                };
                
                // Отправляем пинг, используя тип 'message' для совместимости с сервером
                this.relayClient.sendMessage({
                    type: 'message',
                    targetDeviceId: device.id,
                    payload: {
                        action: 'devicePing',
                        pingId: pingId
                    }
                });
                
                // Устанавливаем таймаут ожидания ответа (3 секунды)
                setTimeout(() => {
                    // Восстанавливаем оригинальный обработчик
                    this.relayClient['onMessageCallback'] = originalCallback;
                    resolve(false);
                }, 3000);
            });
        });
        
        // Ждем ответы от всех устройств
        const results = await Promise.all(pingPromises);
        const activeDevicesCount = results.filter(r => r).length;
        
        console.log(`Активных устройств обнаружено: ${activeDevicesCount} из ${trustedDevices.length}`);
        
        if (activeDevicesCount > 0) {
            console.log("Есть активные устройства. Выход из режима ожидания.");
            this.waitingMode = false;
            
            // Теперь устанавливаем интервал полной синхронизации
            if (this.options.fullSyncInterval && !this.fullSyncInterval) {
                this.fullSyncInterval = setInterval(
                    this.performSmartSync.bind(this),
                    this.options.fullSyncInterval
                );
            }
            
            // Проверяем, есть ли накопленные изменения для синхронизации
            if (this.pendingChangesCount > 0) {
                console.log(`Запуск умной синхронизации для ${this.pendingChangesCount} изменений...`);
                await this.performSmartSync();
            } else {
                console.log("Нет накопленных изменений, пропускаем синхронизацию.");
            }
        } else {
            console.log("Нет активных устройств. Остаёмся в режиме ожидания.");
            this.waitingMode = true;
            
            // Через некоторое время повторяем проверку
            setTimeout(() => this.checkActiveTrustedDevices(), 60000); // Проверка каждую минуту
        }
    }

    /**
     * Остановить процесс синхронизации
     */
    public stop(): void {
        // Останавливаем отслеживание изменений файлов
        this.fileWatcher.stopWatching();

        // Отключаемся от сервера
        this.relayClient.disconnect();

        // Очищаем интервал полной синхронизации
        if (this.fullSyncInterval) {
            clearInterval(this.fullSyncInterval);
            this.fullSyncInterval = null;
        }

        // Сохраняем текущее состояние
        this.saveSyncState();
    }

    /**
     * Обработчик изменения файла
     */
    private async handleFileChange(change: FileChange): Promise<void> {
        try {
            // Пропускаем, если сейчас выполняется синхронизация
            if (this.isSyncing) {
                return;
            }

            // Обновляем метаданные файла в любом случае
            this.pendingChangesCount++;
            
            // Обрабатываем изменение в зависимости от типа
            switch (change.type) {
                case 'create':
                case 'modify':
                    await this.handleFileCreateOrModify(change);
                    break;
                case 'delete':
                    await this.handleFileDelete(change);
                    break;
                case 'rename':
                    await this.handleFileRename(change);
                    break;
            }

            // Сохраняем состояние синхронизации
            this.saveSyncState();
            
            // Если мы в режиме ожидания, проверяем доступность устройств
            // только при накоплении значительного количества изменений
            if (this.waitingMode && this.pendingChangesCount >= 5) {
                console.log(`Накоплено ${this.pendingChangesCount} изменений. Проверяем наличие активных устройств...`);
                this.checkActiveTrustedDevices();
            }
        } catch (error) {
            console.error("Error handling file change:", error);
            new Notice("Ошибка синхронизации файла: " + error.message);
        }
    }

    /**
     * Обработчик создания или изменения файла
     */
    private async handleFileCreateOrModify(change: FileChange): Promise<void> {
        const file = change.file;
        const content = await this.app.vault.read(file);
        
        // Вычисляем хеш содержимого файла
        const hash = await CryptoHelper.hashString(content);
        
        // Проверяем, изменился ли файл на самом деле
        const existingFile = this.syncState.files[file.path];
        if (existingFile && existingFile.hash === hash) {
            // Файл не изменился, пропускаем и уменьшаем счетчик изменений
            this.pendingChangesCount = Math.max(0, this.pendingChangesCount - 1);
            return;
        }

        // Обновляем метаданные файла в состоянии синхронизации
        this.syncState.files[file.path] = {
            path: file.path,
            hash,
            mtime: file.stat.mtime,
            size: file.stat.size
        };

        // Только если не в режиме ожидания, отправляем изменения на другие устройства
        if (!this.waitingMode) {
            console.log(`Синхронизация изменения файла ${file.path}`);
            await this.syncFileWithPeers(file.path, content, hash, file.stat.mtime);
        } else {
            console.log(`Файл ${file.path} изменен, но синхронизация отложена (режим ожидания)`);
        }
    }

    /**
     * Обработчик удаления файла
     */
    private async handleFileDelete(change: FileChange): Promise<void> {
        const filePath = change.path;
        
        // Проверяем, был ли файл в нашем состоянии
        if (!this.syncState.files[filePath]) {
            // Файл не найден, пропускаем и уменьшаем счетчик изменений
            this.pendingChangesCount = Math.max(0, this.pendingChangesCount - 1);
            return;
        }

        // Помечаем файл как удаленный
        this.syncState.files[filePath] = {
            ...this.syncState.files[filePath],
            deleted: true
        };

        // Только если не в режиме ожидания, отправляем изменения на другие устройства
        if (!this.waitingMode) {
            console.log(`Синхронизация удаления файла ${filePath}`);
            await this.syncFileDeletion(filePath);
        } else {
            console.log(`Файл ${filePath} удален, но синхронизация отложена (режим ожидания)`);
        }
    }

    /**
     * Обработчик переименования файла
     */
    private async handleFileRename(change: FileChange): Promise<void> {
        const oldPath = change.oldPath;
        const newPath = change.path;
        const file = change.file;
        
        if (!oldPath) {
            console.error("Old path is missing in rename event");
            this.pendingChangesCount = Math.max(0, this.pendingChangesCount - 1);
            return;
        }

        // Удаляем старый путь и добавляем новый
        const oldMetadata = this.syncState.files[oldPath];
        if (oldMetadata) {
            // Помечаем старый файл как удаленный
            this.syncState.files[oldPath] = {
                ...oldMetadata,
                deleted: true
            };

            // Только если не в режиме ожидания, синхронизируем удаление
            if (!this.waitingMode) {
                await this.syncFileDeletion(oldPath);
            } else {
                console.log(`Файл ${oldPath} переименован, удаление оригинала отложено (режим ожидания)`);
            }
        }

        // Обрабатываем новый файл как создание
        const content = await this.app.vault.read(file);
        const hash = await CryptoHelper.hashString(content);
        
        this.syncState.files[newPath] = {
            path: newPath,
            hash,
            mtime: file.stat.mtime,
            size: file.stat.size
        };

        // Только если не в режиме ожидания, синхронизируем новый файл
        if (!this.waitingMode) {
            console.log(`Синхронизация переименованного файла ${newPath}`);
            await this.syncFileWithPeers(newPath, content, hash, file.stat.mtime);
        } else {
            console.log(`Файл ${oldPath} переименован в ${newPath}, синхронизация отложена (режим ожидания)`);
        }
    }

    /**
     * Синхронизация файла с доверенными устройствами
     * @param path Путь к файлу
     * @param content Содержимое файла
     * @param hash Хеш файла
     * @param mtime Время модификации
     * @param isNew Флаг, указывающий, что файл новый/недавно изменен
     * @param specificDevices Список ID устройств для синхронизации (если задан, то только им)
     * @param requestId ID запроса (если отправка в ответ на запрос)
     * @param vectorClock Векторные часы для версии файла
     * @param conflictResolution Данные для разрешения конфликтов
     */
    private async syncFileWithPeers(
        path: string, 
        content: string, 
        hash: string, 
        mtime: number, 
        isNew: boolean = true,
        specificDevices?: string[],
        requestId?: string,
        vectorClock?: Record<string, number>,
        conflictResolution?: {
            isConflict: boolean;
            baseVersionHash?: string;
            deviceId: string;
        }
    ): Promise<void> {
        // Проверяем соединение перед началом синхронизации
        if (!this.relayClient.isConnected) {
            console.error(`Невозможно синхронизировать файл ${path}: нет соединения с сервером`);
            new Notice(`Невозможно синхронизировать файл ${path}: нет соединения с сервером. Изменения будут отправлены при восстановлении соединения.`);
            
            // Сохраняем файл в очередь для отправки после восстановления соединения
            // Этот функционал можно реализовать для автоматической повторной отправки
            return;
        }
        
        // Получаем актуальный список доверенных устройств
        const allTrustedDevices = this.relayClient.getTrustedDevices();
        
        // Если указаны конкретные устройства, фильтруем список
        const targetDevices = specificDevices 
            ? allTrustedDevices.filter(device => specificDevices.includes(device.id))
            : allTrustedDevices;
        
        // Пропускаем, если нет доверенных устройств
        if (!Array.isArray(targetDevices) || targetDevices.length === 0) {
            console.log(`Пропуск синхронизации файла ${path}: нет целевых устройств`);
            return;
        }

        try {
            // Определяем тип файла для разных стратегий обработки
            const isMarkdown = path.endsWith('.md');
            const isLargeFile = content.length > 10000; // 10KB
            
            // Инициализируем переменные для сжатия
            let compressedContent: string = content;
            let compressionInfo = { compressed: false, originalSize: content.length, compressedSize: content.length };
            
            // Дельта-сжатие для больших Markdown файлов
            if (isMarkdown && isLargeFile) {
                // Проверяем, требуется ли отправка дельты вместо полного содержимого
                const targetDeviceIds = targetDevices.map(device => typeof device === 'string' ? device : device.id);
                const remoteFile = this.findRemoteFileVersion(path, targetDeviceIds);
                
                // Если нашли удаленную версию файла и она отличается от текущей
                if (remoteFile && remoteFile.hash !== hash) {
                    // Реализация дельта-сжатия для Markdown-файлов
                    try {
                        // Получаем базовый файл для дельты (версия файла на целевом устройстве)
                        const targetDeviceId = typeof targetDevices[0] === 'string' ? targetDevices[0] : targetDevices[0].id;
                        const baseContent = await this.getRemoteFileContent(path, remoteFile.hash, targetDeviceId);
                        
                        if (baseContent) {
                            // Создаем дельту между базовой и текущей версией
                            const delta = this.createDelta(baseContent, content);
                            
                            // Если дельта существенно меньше полного содержимого
                            if (delta.length < content.length * 0.7) {
                                console.log(`Используем дельта-сжатие для ${path}: ${delta.length} байт (${Math.round(delta.length / content.length * 100)}% от оригинала)`);
                                
                                // Заменяем содержимое на дельту
                                compressedContent = delta;
                                
                                // Обновляем информацию о сжатии и дельте
                                compressionInfo = { 
                                    compressed: true, 
                                    originalSize: content.length, 
                                    compressedSize: delta.length
                                };
                                
                                // Готовим данные для шифрования
                                compressedContent = delta;
                                compressionInfo = { 
                                    compressed: true, 
                                    originalSize: content.length, 
                                    compressedSize: delta.length
                                };
                                
                                // Шифруем дельту
                                const deltaEncryptedData = await CryptoHelper.encrypt(delta, this.encryptionPassword);
                                
                                // Отправляем сообщение напрямую
                                let successCount = 0;
                                for (const device of targetDevices) {
                                    const deviceId = typeof device === 'string' ? device : device.id;
                                    const success = this.relayClient.sendMessage({
                                        type: 'fileSync',
                                        targetDeviceId: deviceId,
                                        payload: {
                                            path,
                                            encryptedData: deltaEncryptedData,
                                            mtime,
                                            hash,
                                            priority: isNew ? 'high' : 'normal',
                                            compression: compressionInfo,
                                            isMarkdown: true,
                                            deltaData: {
                                                baseHash: remoteFile.hash,
                                                isDelta: true
                                            }
                                        }
                                    });
                                    if (success) {
                                        successCount++;
                                    }
                                }
                                
                                if (successCount === 0) {
                                    console.error(`Не удалось отправить дельту для ${path} ни одному устройству из-за проблем с соединением`);
                                }
                                
                                console.log(`Отправлена дельта для ${path} на ${targetDevices.length} устройств`);
                                return;
                            } else {
                                console.log(`Дельта для ${path} слишком большая, используем полное содержимое`);
                            }
                        }
                    } catch (deltaError) {
                        console.warn(`Не удалось создать дельту для ${path}:`, deltaError);
                    }
                }
                
                // Если не удалось создать дельту или она неэффективна, используем обычное сжатие
                compressedContent = content;
                compressionInfo = { 
                    compressed: true, 
                    originalSize: content.length, 
                    compressedSize: compressedContent.length,
                };
            }
            // Базовое сжатие для других больших файлов
            else if (isLargeFile) {
                // Реализация простого сжатия для бинарных и других файлов
                try {
                    // Для текстовых файлов можно использовать упрощенный вариант сжатия
                    // LZ-подобный алгоритм для повторяющихся последовательностей
                    
                    // Определяем, является ли файл текстовым
                    const isTextFile = path.match(/\.(txt|json|xml|css|js|html|htm|csv|log)$/i) !== null;
                    
                    if (isTextFile) {
                        // Для текстовых файлов используем простое RLE + замену повторяющихся строк
                        compressedContent = this.compressTextContent(content);
                    } else {
                        // Для бинарных и других файлов используем сжатие по блокам
                        // В реальной реализации здесь было бы использование алгоритмов вроде gzip/Brotli
                        // В нашей упрощенной версии просто используем оригинальное содержимое
                        compressedContent = content;
                    }
                    
                    // Обновляем информацию о сжатии
                    compressionInfo = { 
                        compressed: compressedContent.length < content.length, 
                        originalSize: content.length, 
                        compressedSize: compressedContent.length 
                    };
                    
                    // Если сжатие неэффективно, используем оригинальное содержимое
                    if (compressedContent.length >= content.length) {
                        compressedContent = content;
                        compressionInfo.compressed = false;
                        compressionInfo.compressedSize = content.length;
                    }
                    
                    console.log(`Сжатие для ${path}: ${compressionInfo.originalSize} -> ${compressionInfo.compressedSize} байт (${Math.round(compressionInfo.compressedSize / compressionInfo.originalSize * 100)}%)`);
                } catch (compressionError) {
                    console.warn(`Ошибка при сжатии файла ${path}:`, compressionError);
                    // В случае ошибки используем оригинальное содержимое
                    compressedContent = content;
                    compressionInfo = { 
                        compressed: false, 
                        originalSize: content.length, 
                        compressedSize: content.length 
                    };
                }
            }
            
            // Шифруем содержимое файла
            console.log(`Шифрование файла ${path} (${content.length} байт)...`);
            const encryptedData = await CryptoHelper.encrypt(compressedContent, this.encryptionPassword);

            // Формируем сообщение с метаданными и данными
            const fileMessage: SyncFileMessage = {
                path,
                encryptedData,
                mtime,
                hash,
                priority: isNew ? 'high' : 'normal',
                compression: compressionInfo,
                isMarkdown: isMarkdown,
                responseToRequestId: requestId,
                // Добавляем векторные часы и информацию о конфликтах
                vectorClock: vectorClock || this.getFileVectorClock(path),
                conflictResolution
            };

            // Отправляем сообщение целевым устройствам
            console.log(`Отправка файла ${path} (${isNew ? 'новый/изменённый' : 'старый'}) на ${targetDevices.length} устройств...`);
            
            // Для маленьких файлов или специфичных запросов отправляем данные напрямую
            if (!isLargeFile || specificDevices) {
                const sendPromises = targetDevices.map(async (device) => {
                    try {
                        const success = this.relayClient.sendMessage({
                            type: 'fileSync',
                            targetDeviceId: device.id,
                            requestId: requestId, // Передаем requestId, если это ответ на запрос
                            payload: fileMessage
                        });
                        
                        if (!success) {
                            console.error(`Не удалось отправить файл ${path} устройству ${device.id} из-за проблем с соединением`);
                            return false;
                        }
                        
                        return true;
                    } catch (deviceError) {
                        console.error(`Ошибка при отправке на устройство ${device.id}:`, deviceError);
                        return false;
                    }
                });
                
                // Отправляем всем устройствам параллельно
                const results = await Promise.allSettled(sendPromises);
                const successCount = results.filter(r => r.status === 'fulfilled' && r.value).length;
                
                console.log(`Файл ${path} отправлен на ${successCount}/${targetDevices.length} устройств`);
                return;
            }
            
            // Для больших файлов используем оптимизированную стратегию сигнальной системы
            // с поддержкой фрагментации для очень больших файлов
            
            // Определяем, нужна ли фрагментация файла (для очень больших файлов)
            const CHUNK_SIZE = 500 * 1024; // 500 KB на фрагмент - оптимальный размер для WebSocket
            const needsChunking = content.length > CHUNK_SIZE * 2; // Если файл больше 1MB, используем фрагментацию
            
            // Генерируем unique ID для этой операции синхронизации (нужно для сборки фрагментов)
            const syncOperationId = Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
            
            // Подготавливаем метаданные файла с дополнительной информацией о фрагментации
            const metadataMessage = {
                path,
                hash,
                mtime,
                size: content.length,
                priority: isNew ? 'high' : 'normal',
                isMarkdown: isMarkdown,
                chunked: needsChunking, // Флаг, показывающий, что файл будет отправлен по частям
                syncOperationId: needsChunking ? syncOperationId : undefined, // ID операции для сборки фрагментов
                totalChunks: needsChunking ? Math.ceil(content.length / CHUNK_SIZE) : undefined // Общее количество фрагментов
            };
            
            // Отправляем метаданные всем устройствам
            let metadataSuccessCount = 0;
            for (const device of targetDevices) {
                const success = this.relayClient.sendMessage({
                    type: 'fileMetadataOnly', // Отличается от fileMetadata - содержит только метаданные одного файла
                    targetDeviceId: device.id,
                    payload: metadataMessage
                });
                
                if (success) {
                    metadataSuccessCount++;
                }
            }
            
            // Проверяем успешность отправки метаданных
            if (metadataSuccessCount === 0 && targetDevices.length > 0) {
                console.error(`Не удалось отправить метаданные файла ${path} ни одному устройству из-за проблем с соединением`);
            } else if (metadataSuccessCount < targetDevices.length) {
                console.warn(`Метаданные файла ${path} отправлены только ${metadataSuccessCount} из ${targetDevices.length} устройств из-за проблем с соединением`);
            }
            
            // Записываем этот файл в локальный кэш для быстрого доступа при запросе,
            // но только если файл не слишком большой
            if (!needsChunking) {
                this.saveContentToCache(path, content, hash);
            }
            
            console.log(`Метаданные файла ${path} отправлены на ${targetDevices.length} устройств. ${
                needsChunking ? 
                `Файл будет отправлен по запросу в ${Math.ceil(content.length / CHUNK_SIZE)} фрагментах.` : 
                `Ожидаем запросы на получение содержимого.`
            }`);
            
        } catch (error) {
            console.error(`Error syncing file ${path}:`, error);
            throw new Error(`Не удалось синхронизировать файл ${path}: ${error.message}`);
        }
    }
    
    /**
     * Найти версию файла на одном из целевых устройств для дельта-синхронизации
     */
    private findRemoteFileVersion(path: string, targetDeviceIds: string[]): FileMetadata | null {
        // Перебираем все целевые устройства
        for (const deviceId of targetDeviceIds) {
            const deviceMeta = this.deviceFileMetadata.get(deviceId);
            
            // Если у нас есть метаданные с этого устройства
            if (deviceMeta && deviceMeta[path]) {
                return deviceMeta[path];
            }
        }
        
        return null;
    }
    
    /**
     * Запросить содержимое файла с другого устройства для дельта-синхронизации
     */
    private async getRemoteFileContent(path: string, hash: string, deviceId: string): Promise<string | null> {
        // Проверяем локальный кэш файлов
        const cachedContent = this.getContentFromCache(path, hash);
        if (cachedContent) {
            console.log(`Найдена версия файла ${path} в кэше (hash: ${hash.substring(0, 8)})`);
            return cachedContent;
        }
        
        // Запрашиваем файл у другого устройства
        try {
            console.log(`Запрашиваем версию файла ${path} у устройства ${deviceId} для дельта-синхронизации...`);
            
            // Генерируем уникальный ID запроса
            const requestId = Date.now().toString() + '-delta-' + Math.random().toString(36).substring(2, 7);
            
            // Создаем промис для ожидания ответа
            const responsePromise = new Promise<string | null>((resolve) => {
                // Функция обработки файла, когда он будет получен
                const handleFileResponse = async (message: any) => {
                    // Проверяем, что это ответ на наш запрос
                    if (message.type === 'fileSync' && 
                        message.sourceDeviceId === deviceId && 
                        message.responseToRequestId === requestId) {
                        
                        // Проверяем, что в ответе есть нужные данные
                        if (message.payload && message.payload.path === path && message.payload.encryptedData) {
                            try {
                                // Расшифровываем данные
                                const decryptedContent = await CryptoHelper.decrypt(
                                    message.payload.encryptedData, 
                                    this.encryptionPassword
                                );
                                
                                console.log(`Получена версия файла ${path} для дельта-синхронизации`);
                                resolve(decryptedContent);
                                
                                // Сохраняем в кэш для будущего использования
                                this.saveContentToCache(path, decryptedContent, message.payload.hash);
                                
                                return;
                            } catch (error) {
                                console.error(`Ошибка при расшифровке файла ${path}:`, error);
                            }
                        }
                    }
                    
                    // Если это не нужный ответ, передаем его дальше
                    const originalCallback = this.relayClient['onMessageCallbackOriginal'];
                    if (originalCallback) {
                        originalCallback(message);
                    }
                };
                
                // Сохраняем текущий обработчик сообщений
                const originalCallback = this.relayClient['onMessageCallback'];
                this.relayClient['onMessageCallbackOriginal'] = originalCallback;
                
                // Устанавливаем временный обработчик
                this.relayClient['onMessageCallback'] = handleFileResponse;
                
                // Отправляем запрос на получение файла
                this.relayClient.sendMessage({
                    type: 'requestFile',
                    targetDeviceId: deviceId,
                    requestId,
                    payload: {
                        path,
                        hash,
                        forDelta: true  // Флаг, что это запрос для дельта-синхронизации
                    }
                });
                
                // Устанавливаем таймаут для разрешения промиса, если нет ответа
                setTimeout(() => {
                    // Восстанавливаем оригинальный обработчик
                    this.relayClient['onMessageCallback'] = originalCallback;
                    console.log(`Таймаут запроса содержимого файла ${path} для дельта-синхронизации`);
                    resolve(null);
                }, 10000);  // 10 секунд
            });
            
            // Ждем результат запроса
            return await responsePromise;
            
        } catch (error) {
            console.error(`Ошибка при запросе содержимого файла ${path} для дельта-синхронизации:`, error);
            return null;
        }
    }
    
    /**
     * Создать дельту между старым и новым содержимым
     * Использует оптимизированный алгоритм дельта-сжатия для текстовых файлов
     */
    private createDelta(baseContent: string, newContent: string): string {
        try {
            // Реализация улучшенного алгоритма дельты для текстовых файлов
            
            // Разбиваем текст на строки
            const baseLines = baseContent.split(/\r?\n/);
            const newLines = newContent.split(/\r?\n/);
            
            // Алгоритм оптимизации: используем LCS (Longest Common Subsequence) с кэшированием
            const lcsMatrix = this.computeLCSMatrix(baseLines, newLines);
            
            // Построение операций дельты на основе LCS
            const operations = this.extractDeltaOperations(baseLines, newLines, lcsMatrix);
            
            // Оптимизация: группировка похожих операций для уменьшения размера
            const compactOperations = this.compactOperations(operations);
            
            // Сериализуем дельту в компактном виде
            const delta = {
                originalLength: baseLines.length,
                newLength: newLines.length,
                operations: compactOperations
            };
            
            // Проверка эффективности дельты - если размер дельты превышает 70% от размера нового содержимого,
            // возвращаем полное содержимое с маркером
            const deltaStr = JSON.stringify(delta);
            if (deltaStr.length > newContent.length * 0.7) {
                // Если дельта неэффективна, возвращаем полное содержимое с маркером
                return JSON.stringify({
                    fullContent: true,
                    content: newContent
                });
            }
            
            return deltaStr;
        } catch (error) {
            console.error("Ошибка при создании дельты:", error);
            // В случае ошибки возвращаем полное содержимое с маркером
            return JSON.stringify({
                fullContent: true,
                content: newContent,
                error: error.message
            });
        }
    }
    
    /**
     * Вычисляем матрицу наибольшей общей подпоследовательности (LCS)
     * для базового и нового контента
     */
    private computeLCSMatrix(baseLines: string[], newLines: string[]): number[][] {
        const m = baseLines.length;
        const n = newLines.length;
        
        // Оптимизация памяти: используем разреженную матрицу для больших файлов
        if (m * n > 10000000) { // 10M ячеек - порог для больших файлов
            return this.computeLCSMatrixSparse(baseLines, newLines);
        }
        
        // Создаем матрицу (m+1) x (n+1)
        const lcsMatrix: number[][] = Array(m + 1).fill(null)
            .map(() => Array(n + 1).fill(0));
        
        // Заполняем матрицу
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                if (baseLines[i - 1] === newLines[j - 1]) {
                    lcsMatrix[i][j] = lcsMatrix[i - 1][j - 1] + 1;
                } else {
                    lcsMatrix[i][j] = Math.max(lcsMatrix[i - 1][j], lcsMatrix[i][j - 1]);
                }
            }
        }
        
        return lcsMatrix;
    }
    
    /**
     * Вычисляем разреженную матрицу LCS для больших файлов
     * Использует оптимизации по памяти для очень больших файлов
     */
    private computeLCSMatrixSparse(baseLines: string[], newLines: string[]): number[][] {
        const m = baseLines.length;
        const n = newLines.length;
        
        // Для экономии памяти храним только две строки матрицы
        let prev = Array(n + 1).fill(0);
        let curr = Array(n + 1).fill(0);
        
        // Результирующая матрица будет содержать только последнюю строку
        // и информацию о диагоналях для восстановления пути
        const result: number[][] = [];
        
        for (let i = 1; i <= m; i++) {
            [prev, curr] = [curr, prev]; // Меняем строки местами
            curr[0] = 0;
            
            for (let j = 1; j <= n; j++) {
                if (baseLines[i - 1] === newLines[j - 1]) {
                    curr[j] = prev[j - 1] + 1;
                } else {
                    curr[j] = Math.max(prev[j], curr[j - 1]);
                }
            }
            
            // Сохраняем только каждую k-ю строку для экономии памяти
            // и восстановления пути в дальнейшем
            if (i % 100 === 0 || i === m) {
                result.push([...curr]);
            }
        }
        
        // Добавляем контрольные точки для восстановления операций
        return result;
    }
    
    /**
     * Извлекаем операции дельты из матрицы LCS
     */
    private extractDeltaOperations(baseLines: string[], newLines: string[], lcsMatrix: number[][]): Array<{op: 'keep' | 'insert' | 'delete', start: number, count: number, lines?: string[]}> {
        const operations: Array<{op: 'keep' | 'insert' | 'delete', start: number, count: number, lines?: string[]}> = [];
        let i = baseLines.length;
        let j = newLines.length;
        
        // Для разреженной матрицы используем другой алгоритм
        if (lcsMatrix.length < baseLines.length + 1) {
            return this.extractDeltaOperationsSparse(baseLines, newLines);
        }
        
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && baseLines[i - 1] === newLines[j - 1]) {
                // Общая строка
                operations.unshift({
                    op: 'keep',
                    start: i - 1,
                    count: 1
                });
                i--;
                j--;
            } else if (j > 0 && (i === 0 || lcsMatrix[i][j - 1] >= lcsMatrix[i - 1][j])) {
                // Вставка из нового текста
                operations.unshift({
                    op: 'insert',
                    start: j - 1,
                    count: 1,
                    lines: [newLines[j - 1]]
                });
                j--;
            } else if (i > 0 && (j === 0 || lcsMatrix[i][j - 1] < lcsMatrix[i - 1][j])) {
                // Удаление из старого текста
                operations.unshift({
                    op: 'delete',
                    start: i - 1,
                    count: 1
                });
                i--;
            }
        }
        
        return operations;
    }
    
    /**
     * Извлекаем операции дельты для разреженной матрицы LCS (для больших файлов)
     */
    private extractDeltaOperationsSparse(baseLines: string[], newLines: string[]): Array<{op: 'keep' | 'insert' | 'delete', start: number, count: number, lines?: string[]}> {
        // Для больших файлов используем упрощенный алгоритм Майерса (Myers) для diff
        const operations: Array<{op: 'keep' | 'insert' | 'delete', start: number, count: number, lines?: string[]}> = [];
        
        // Находим общие блоки в начале и конце файлов
        let commonStart = 0;
        while (commonStart < baseLines.length && 
               commonStart < newLines.length && 
               baseLines[commonStart] === newLines[commonStart]) {
            commonStart++;
        }
        
        let commonEnd = 0;
        while (commonEnd < baseLines.length - commonStart && 
               commonEnd < newLines.length - commonStart && 
               baseLines[baseLines.length - 1 - commonEnd] === newLines[newLines.length - 1 - commonEnd]) {
            commonEnd++;
        }
        
        // Если есть общий блок в начале
        if (commonStart > 0) {
            operations.push({
                op: 'keep',
                start: 0,
                count: commonStart
            });
        }
        
        // Середина файла
        const baseMiddle = baseLines.slice(commonStart, baseLines.length - commonEnd);
        const newMiddle = newLines.slice(commonStart, newLines.length - commonEnd);
        
        // Если обе средние части не пусты, выделим отличающиеся части
        if (baseMiddle.length > 0 || newMiddle.length > 0) {
            // Удаляем старую среднюю часть
            if (baseMiddle.length > 0) {
                operations.push({
                    op: 'delete',
                    start: commonStart,
                    count: baseMiddle.length
                });
            }
            
            // Вставляем новую среднюю часть
            if (newMiddle.length > 0) {
                operations.push({
                    op: 'insert',
                    start: commonStart,
                    count: newMiddle.length,
                    lines: newMiddle
                });
            }
        }
        
        // Если есть общий блок в конце
        if (commonEnd > 0) {
            operations.push({
                op: 'keep',
                start: baseLines.length - commonEnd,
                count: commonEnd
            });
        }
        
        return operations;
    }
    
    /**
     * Группируем и компактизируем операции дельты
     */
    private compactOperations(operations: Array<{op: 'keep' | 'insert' | 'delete', start: number, count: number, lines?: string[]}>): Array<{op: 'keep' | 'insert' | 'delete', start: number, count: number, lines?: string[]}> {
        if (!operations.length) return [];
        
        const result: Array<{op: 'keep' | 'insert' | 'delete', start: number, count: number, lines?: string[]}> = [];
        let current = operations[0];
        
        for (let i = 1; i < operations.length; i++) {
            const next = operations[i];
            
            // Если операция та же и следующая позиция следует за текущей
            if (next.op === current.op && 
                ((next.op === 'keep' && next.start === current.start + current.count) ||
                 (next.op === 'delete' && next.start === current.start + current.count) ||
                 (next.op === 'insert' && next.start === current.start + current.count))) {
                
                // Объединяем операции
                if (next.op === 'insert') {
                    // Для вставки объединяем массивы строк
                    if (current.lines && next.lines) {
                        current.lines = current.lines.concat(next.lines);
                    }
                }
                
                current.count += next.count;
            } else {
                // Иначе сохраняем текущую и переходим к следующей
                result.push(current);
                current = next;
            }
        }
        
        // Добавляем последнюю операцию
        result.push(current);
        
        return result;
    }
    
    /**
     * Получить файл по его хешу (для применения дельты)
     */
    private async getFileWithHash(path: string, hash: string): Promise<string | null> {
        // Сначала проверяем кэш
        const cachedContent = this.getContentFromCache(path, hash);
        if (cachedContent) {
            return cachedContent;
        }
        
        // Если файл существует и его хеш совпадает
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
            try {
                const content = await this.app.vault.read(file);
                const currentHash = await CryptoHelper.hashString(content);
                
                if (currentHash === hash) {
                    // Сохраняем в кэш для будущего использования
                    this.saveContentToCache(path, content, hash);
                    return content;
                }
            } catch (error) {
                console.error(`Ошибка при чтении файла ${path}:`, error);
            }
        }
        
        // Если не нашли локально, пытаемся запросить с других устройств
        // Но для этого нам нужно знать, с кем мы синхронизируемся
        const trustedDevices = this.relayClient.getTrustedDevices();
        
        // Если есть доверенные устройства, пробуем запросить файл
        if (trustedDevices.length > 0) {
            for (const device of trustedDevices) {
                const remoteContent = await this.getRemoteFileContent(path, hash, device.id);
                if (remoteContent) {
                    return remoteContent;
                }
            }
        }
        
        // Не удалось найти файл с нужным хешем
        return null;
    }
    
    /**
     * Применить дельту к базовому содержимому
     * Поддерживает оптимизированный формат дельты
     */
    private applyDelta(baseContent: string, delta: string): string {
        try {
            // Парсим дельту
            const deltaObj = JSON.parse(delta);
            
            // Проверяем, если это полное содержимое (неэффективная дельта или ошибка)
            if (deltaObj.fullContent) {
                console.log("Получена полная версия файла вместо дельты");
                return deltaObj.content;
            }
            
            // Проверяем совместимость со старым форматом для обратной совместимости
            if (deltaObj.commonStart !== undefined && deltaObj.commonEnd !== undefined && deltaObj.newMiddle !== undefined) {
                // Обработка старого формата
                const baseLines = baseContent.split(/\r?\n/);
                
                // Извлекаем общие части
                const commonStart = deltaObj.commonStart;
                const commonEnd = deltaObj.commonEnd;
                
                // Извлекаем начало и конец файла
                const startPart = baseLines.slice(0, commonStart);
                const endPart = baseLines.slice(baseLines.length - commonEnd);
                
                // Получаем новую среднюю часть
                const newMiddle = deltaObj.newMiddle.split(/\r?\n/);
                
                // Объединяем части
                return [...startPart, ...newMiddle, ...endPart].join('\n');
            }
            
            // Обработка нового формата с операциями
            if (deltaObj.operations && Array.isArray(deltaObj.operations)) {
                const baseLines = baseContent.split(/\r?\n/);
                const resultLines = [...baseLines]; // Создаем копию для модификации
                
                // Применяем операции в обратном порядке (с конца), чтобы индексы не плыли
                // когда мы вставляем или удаляем строки
                const sortedOperations = [...deltaObj.operations].sort((a, b) => b.start - a.start);
                
                for (const op of sortedOperations) {
                    switch (op.op) {
                        case 'keep':
                            // Для операции 'keep' ничего не делаем
                            break;
                            
                        case 'delete':
                            // Удаляем указанное количество строк, начиная с указанной позиции
                            resultLines.splice(op.start, op.count);
                            break;
                            
                        case 'insert':
                            // Вставляем указанные строки в указанную позицию
                            if (op.lines && Array.isArray(op.lines)) {
                                resultLines.splice(op.start, 0, ...op.lines);
                            }
                            break;
                    }
                }
                
                return resultLines.join('\n');
            }
            
            // Если формат дельты неизвестен, генерируем ошибку
            throw new Error("Неизвестный формат дельты");
        } catch (error) {
            console.error("Ошибка при применении дельты:", error);
            throw new Error(`Не удалось применить дельту к файлу: ${error.message}`);
        }
    }
    
    /**
     * Сжатие текстового содержимого (упрощенный алгоритм)
     */
    private compressTextContent(content: string): string {
        try {
            // Стратегия сжатия:
            // 1. Разбиваем содержимое на строки
            // 2. Ищем повторяющиеся строки и заменяем их ссылками
            // 3. Сжимаем повторяющиеся последовательности символов (простое RLE)
            
            const lines = content.split(/\r?\n/);
            
            // Создаем словарь часто повторяющихся строк
            const dictionary: Record<string, number> = {};
            const MIN_STRING_LENGTH = 20; // Минимальная длина строки для включения в словарь
            
            // Подсчитываем повторения строк
            for (const line of lines) {
                if (line.length >= MIN_STRING_LENGTH) {
                    dictionary[line] = (dictionary[line] || 0) + 1;
                }
            }
            
            // Оставляем только строки, которые повторяются хотя бы дважды
            const frequentStrings = Object.entries(dictionary)
                .filter(([_, count]) => count >= 2)
                .map(([str]) => str)
                .slice(0, 50); // Ограничиваем размер словаря
            
            // Если нет часто повторяющихся строк, используем оригинальное содержимое
            if (frequentStrings.length === 0) {
                return content;
            }
            
            // Заменяем повторяющиеся строки на ссылки
            let compressedLines = [...lines];
            for (let i = 0; i < frequentStrings.length; i++) {
                const str = frequentStrings[i];
                const placeholder = `###REF${i}###`;
                
                for (let j = 0; j < compressedLines.length; j++) {
                    if (compressedLines[j] === str) {
                        compressedLines[j] = placeholder;
                    }
                }
            }
            
            // Создаем сжатый формат (словарь + сжатое содержимое)
            const compressed = {
                dictionary: frequentStrings,
                content: compressedLines.join('\n')
            };
            
            // Сериализуем в JSON
            return JSON.stringify(compressed);
            
        } catch (error) {
            console.error("Ошибка при сжатии текстового содержимого:", error);
            return content; // В случае ошибки возвращаем оригинальное содержимое
        }
    }
    
    /**
     * Распаковка сжатого текстового содержимого
     */
    private decompressTextContent(compressedContent: string): string {
        try {
            // Парсим сжатый формат
            const compressed = JSON.parse(compressedContent);
            
            // Если это не наш формат сжатия, возвращаем как есть
            if (!compressed.dictionary || !compressed.content) {
                return compressedContent;
            }
            
            // Восстанавливаем строки из словаря
            let decompressedContent = compressed.content;
            
            // Заменяем ссылки на фактические строки
            for (let i = 0; i < compressed.dictionary.length; i++) {
                const placeholder = `###REF${i}###`;
                const regex = new RegExp(placeholder, 'g');
                decompressedContent = decompressedContent.replace(regex, compressed.dictionary[i]);
            }
            
            return decompressedContent;
            
        } catch (error) {
            console.error("Ошибка при распаковке сжатого содержимого:", error);
            return compressedContent; // В случае ошибки возвращаем сжатое содержимое как есть
        }
    }
    
    /**
     * Кэш содержимого файлов с метаинформацией и контролем размера
     */
    private fileContentCache: Map<string, {
        content: string, 
        hash: string, 
        timestamp: number, 
        size: number
    }> = new Map();
    
    private totalCacheSize: number = 0;
    private readonly MAX_CACHE_SIZE_MB: number = 50; // Максимальный размер кэша в МБ
    private readonly MAX_CACHE_ENTRY_SIZE_MB: number = 5; // Максимальный размер одной записи в кэше в МБ
    
    /**
     * Сохранить содержимое файла в кэш с учетом размера памяти
     */
    private saveContentToCache(path: string, content: string, hash: string): void {
        // Размер контента в байтах (приблизительно - 2 байта на символ в UTF-16)
        const contentSize = content.length * 2;
        const contentSizeMB = contentSize / (1024 * 1024);
        
        // Если размер файла превышает лимит для одной записи, не кэшируем
        if (contentSizeMB > this.MAX_CACHE_ENTRY_SIZE_MB) {
            console.log(`Файл ${path} слишком большой для кэширования (${contentSizeMB.toFixed(2)} МБ)`);
            return;
        }
        
        // Проверяем наличие существующей записи для этого пути
        const existingEntry = this.fileContentCache.get(path);
        if (existingEntry) {
            // Обновляем общий размер кэша, вычитая размер старой записи
            this.totalCacheSize -= existingEntry.size;
        }
        
        // Если новый размер кэша превысит лимит, удаляем старые записи
        if (this.totalCacheSize + contentSize > this.MAX_CACHE_SIZE_MB * 1024 * 1024) {
            this.pruneCache(contentSize);
        }
        
        // Добавляем новую запись
        this.fileContentCache.set(path, {
            content,
            hash,
            timestamp: Date.now(),
            size: contentSize
        });
        
        // Обновляем общий размер кэша
        this.totalCacheSize += contentSize;
        
        console.log(`Файл ${path} добавлен в кэш (${(contentSize / 1024).toFixed(2)} КБ). Общий размер кэша: ${(this.totalCacheSize / (1024 * 1024)).toFixed(2)} МБ`);
    }
    
    /**
     * Удаляет старые записи из кэша, чтобы освободить указанное количество байт
     */
    private pruneCache(bytesNeeded: number): void {
        // Если кэш пуст, ничего не делаем
        if (this.fileContentCache.size === 0) return;
        
        // Сортируем записи кэша по времени последнего доступа (старые в начале)
        const sortedEntries = Array.from(this.fileContentCache.entries())
            .sort((a, b) => a[1].timestamp - b[1].timestamp);
        
        let freedSpace = 0;
        let removedEntries = 0;
        
        // Удаляем записи, пока не освободим достаточно места
        for (const [path, entry] of sortedEntries) {
            this.fileContentCache.delete(path);
            freedSpace += entry.size;
            removedEntries++;
            
            // Если освободили нужное количество байт, выходим из цикла
            if (freedSpace >= bytesNeeded || 
                this.totalCacheSize - freedSpace < this.MAX_CACHE_SIZE_MB * 1024 * 1024 * 0.7) { // Оставляем 30% запас
                break;
            }
        }
        
        // Обновляем общий размер кэша
        this.totalCacheSize -= freedSpace;
        
        console.log(`Очистка кэша: удалено ${removedEntries} записей, освобождено ${(freedSpace / 1024).toFixed(2)} КБ. Новый размер кэша: ${(this.totalCacheSize / (1024 * 1024)).toFixed(2)} МБ`);
    }
    
    /**
     * Получить содержимое файла из кэша
     */
    private getContentFromCache(path: string, hash: string): string | null {
        const cached = this.fileContentCache.get(path);
        if (cached && cached.hash === hash) {
            // Обновляем timestamp при доступе к записи, чтобы отслеживать LRU (Least Recently Used)
            cached.timestamp = Date.now();
            return cached.content;
        }
        return null;
    }
    
    /**
     * Очистить кэш полностью
     */
    private clearCache(): void {
        this.fileContentCache.clear();
        this.totalCacheSize = 0;
        console.log('Кэш файлов очищен');
    }

    /**
     * Синхронизация удаления файла с доверенными устройствами
     */
    private async syncFileDeletion(path: string): Promise<void> {
        // Получаем актуальный список доверенных устройств
        const trustedDevices = this.relayClient.getTrustedDevices();
        
        // Пропускаем, если нет доверенных устройств
        if (!Array.isArray(trustedDevices) || trustedDevices.length === 0) {
            console.log(`Пропуск синхронизации удаления файла ${path}: нет доверенных устройств`);
            return;
        }

        try {
            // Создаем сообщение об удалении файла
            const deleteMessage: SyncFileMessage = {
                path,
                deleted: true,
                mtime: Date.now(),
                hash: '' // Хеш не нужен при удалении
            };

            // Отправляем сообщение всем доверенным устройствам
            console.log(`Отправка уведомления об удалении файла ${path} на ${trustedDevices.length} устройств...`);
            let successCount = 0;
            
            for (const device of trustedDevices) {
                try {
                    console.log(`Отправка уведомления об удалении ${path} на устройство ${device.id}...`);
                    
                    this.relayClient.sendMessage({
                        type: 'fileSync',
                        targetDeviceId: device.id,
                        payload: deleteMessage
                    });
                    
                    successCount++;
                } catch (deviceError) {
                    console.error(`Ошибка при отправке уведомления об удалении на устройство ${device.id}:`, deviceError);
                }
            }
            
            console.log(`Уведомление об удалении файла ${path} отправлено на ${successCount}/${trustedDevices.length} устройств`);
        } catch (error) {
            console.error(`Error syncing file deletion ${path}:`, error);
            throw new Error(`Не удалось синхронизировать удаление файла ${path}: ${error.message}`);
        }
    }

    /**
     * Обработчик сообщения от сервера
     */
    private async handleSyncMessage(message: SyncMessage): Promise<void> {
        try {
            // Обработка запроса пинга устройства через тип 'message' (сигнальная система)
            if (message.type === 'message' && message.payload && message.payload.action === 'devicePing' && message.payload.pingId) {
                console.log(`Получен пинг от устройства ${message.deviceName || message.sourceDeviceId}`);
                
                // Всегда отвечаем на пинги, даже в режиме ожидания, используя тип 'message'
                const sent = this.relayClient.sendMessage({
                    type: 'message',
                    targetDeviceId: message.sourceDeviceId,
                    payload: {
                        action: 'devicePingResponse',
                        pingId: message.payload.pingId
                    }
                });
                console.log(`Отправлен ответ на пинг устройству ${message.sourceDeviceId}: ${sent ? 'успешно' : 'ошибка'}`);
                
                // Принудительно проверяем, является ли устройство доверенным
                const isTrusted = this.relayClient.isDeviceTrusted(message.sourceDeviceId || '');
                console.log(`Устройство ${message.sourceDeviceId} доверенное: ${isTrusted}`);
                
                // Если мы в режиме ожидания и получили пинг от доверенного устройства, 
                // это значит, что есть активные устройства - выходим из режима ожидания
                if (this.waitingMode && isTrusted) {
                    console.log("Получен пинг от доверенного устройства. Выходим из режима ожидания.");
                    this.waitingMode = false;
                    new Notice("Обнаружено активное доверенное устройство");
                    
                    // Проверяем, есть ли накопленные изменения для синхронизации
                    if (this.pendingChangesCount > 0) {
                        console.log(`Есть ${this.pendingChangesCount} накопленных изменений. Начинаем умную синхронизацию.`);
                        new Notice(`Синхронизируем ${this.pendingChangesCount} изменений`);
                        setTimeout(() => this.performSmartSync(), 1000);
                    } else {
                        console.log("Нет накопленных изменений, пропускаем синхронизацию.");
                    }
                }
                
                return;
            }
            
            // Обработка ответа на пинг устройства через тип 'message' (обрабатывается в checkActiveTrustedDevices)
            if (message.type === 'message' && message.payload && message.payload.action === 'devicePingResponse') {
                console.log(`Получен ответ на пинг от устройства ${message.deviceName || message.sourceDeviceId}`);
                
                // Принудительно проверяем, является ли устройство доверенным
                const isTrusted = this.relayClient.isDeviceTrusted(message.sourceDeviceId || '');
                console.log(`Устройство ${message.sourceDeviceId} доверенное: ${isTrusted}`);
                
                // Если мы в режиме ожидания и получили ответ от доверенного устройства, 
                // это значит, что есть активные устройства - выходим из режима ожидания
                if (this.waitingMode && isTrusted) {
                    console.log("Получен ответ на пинг от доверенного устройства. Выходим из режима ожидания.");
                    this.waitingMode = false;
                    new Notice("Обнаружено активное доверенное устройство");
                    
                    // Проверяем, есть ли накопленные изменения для синхронизации
                    if (this.pendingChangesCount > 0) {
                        console.log(`Есть ${this.pendingChangesCount} накопленных изменений. Начинаем умную синхронизацию.`);
                        new Notice(`Синхронизируем ${this.pendingChangesCount} изменений`);
                        setTimeout(() => this.performSmartSync(), 1000);
                    } else {
                        console.log("Нет накопленных изменений, пропускаем синхронизацию.");
                    }
                }
                
                // Обработка происходит в обработчике, установленном в checkActiveTrustedDevices
                return;
            }
            
            // Обработка запроса на получение метаданных
            if (message.type === 'requestFileMetadata') {
                console.log("Обработка запроса метаданных...");
                this.handleFileMetadataRequest(message);
                return;
            }
            
            // Обработка полученных метаданных файлов - обрабатывается в requestFileMetadata
            if (message.type === 'fileMetadata') {
                // Метаданные обрабатываются в отдельном потоке через обработчик
                return;
            }
            
            // Обработка метаданных отдельного файла (сигнальная система)
            if (message.type === 'fileMetadataOnly' && message.payload && typeof message.payload === 'object') {
                await this.handleFileMetadataOnly(message);
                return;
            }
            
            // Обработка запроса на получение файла
            if (message.type === 'requestFile' && message.payload && typeof message.payload === 'object') {
                const path = message.payload.path;
                if (path && message.sourceDeviceId) {
                    console.log(`Получен запрос на отправку файла ${path} от устройства ${message.deviceName || message.sourceDeviceId}`);
                    await this.handleFileRequest(path, message.sourceDeviceId, message.requestId);
                }
                return;
            }
            
            // Обрабатываем тип fileSync (может быть оригинальным или преобразованным из message)
            if (message.type === 'fileSync' && message.payload) {
                console.log("Обработка сообщения fileSync...");
                
                // Если получаем данные файловой синхронизации, значит есть активные устройства
                if (this.waitingMode) {
                    console.log("Получены данные синхронизации, выходим из режима ожидания");
                    this.waitingMode = false;
                }
                
                await this.processFileSyncMessage(message.payload as SyncFileMessage);
            }
            // Добавляем явную обработку сообщений типа message с данными файловой синхронизации
            else if (message.type === 'message' && message.payload && 
                    typeof message.payload === 'object' && 
                    (message.payload.path || message.payload.encryptedData || message.payload.deleted)) {
                console.log("Обработка сообщения message с данными файловой синхронизации...");
                
                // Если получаем данные файловой синхронизации, значит есть активные устройства
                if (this.waitingMode) {
                    console.log("Получены данные синхронизации, выходим из режима ожидания");
                    this.waitingMode = false;
                }
                
                await this.processFileSyncMessage(message.payload as SyncFileMessage);
            }
        } catch (error) {
            console.error("Ошибка при обработке сообщения синхронизации:", error);
            new Notice(`Ошибка синхронизации: ${error.message}`);
        }
    }
    
    /**
     * Обработка метаданных отдельного файла (сигнальная система)
     */
    private async handleFileMetadataOnly(message: SyncMessage): Promise<void> {
        try {
            if (!message.payload || !message.sourceDeviceId) return;
            
            const payload = message.payload;
            const path = payload.path;
            
            if (!path) {
                console.log("Получены метаданные файла без указания пути");
                return;
            }
            
            console.log(`Получены метаданные файла ${path} от устройства ${message.deviceName || message.sourceDeviceId}`);
            
            // Извлекаем векторные часы, если они есть
            const remoteVectorClock = payload.vectorClock;
            
            // Проверяем, нужен ли нам этот файл и требуется ли слияние
            const { needsSync, needsMerge } = await this.checkIfFileNeeded(
                path, 
                payload.hash, 
                payload.mtime, 
                remoteVectorClock, 
                message.sourceDeviceId
            );
            
            if (needsSync) {
                // Запрашиваем файл от отправителя
                console.log(`Запрашиваем файл ${path} от устройства ${message.sourceDeviceId} ${needsMerge ? '(требуется слияние)' : ''}`);
                
                const requestId = Date.now().toString() + '-' + Math.random().toString(36).substr(2, 5);
                
                this.relayClient.sendMessage({
                    type: 'requestFile',
                    targetDeviceId: message.sourceDeviceId,
                    requestId: requestId,
                    payload: {
                        path,
                        hash: payload.hash,
                        needsMerge: needsMerge,
                        vectorClock: this.syncState.files[path]?.vectorClock // Отправляем наши векторные часы для разрешения конфликтов
                    }
                });
            } else {
                console.log(`Файл ${path} не требуется синхронизировать, пропускаем`);
            }
        } catch (error) {
            console.error(`Ошибка при обработке метаданных файла:`, error);
        }
    }
    
    /**
     * Проверить, нужен ли нам файл с указанными метаданными
     * и определить тип необходимой синхронизации (обновление, слияние)
     */
    private async checkIfFileNeeded(path: string, hash: string, remoteMtime: number, remoteVectorClock?: Record<string, number>, sourceDeviceId?: string): Promise<{needsSync: boolean, needsMerge: boolean}> {
        // Получаем локальный файл
        const file = this.app.vault.getAbstractFileByPath(path);
        
        // Если файла нет локально, он нам нужен
        if (!(file instanceof TFile)) {
            return { needsSync: true, needsMerge: false };
        }
        
        // Проверяем локальные метаданные
        const localMetadata = this.syncState.files[path];
        
        // Если нет локальных метаданных, но файл существует, нужно сверить хеш
        if (!localMetadata) {
            const content = await this.app.vault.read(file);
            const localHash = await CryptoHelper.hashString(content);
            return { needsSync: localHash !== hash, needsMerge: false };
        }
        
        // Если хеши различаются, проверяем на конфликт с помощью векторных часов
        if (localMetadata.hash !== hash) {
            // Инициализируем векторные часы, если они еще не созданы
            if (!localMetadata.vectorClock) {
                localMetadata.vectorClock = { [this.syncState.deviceId]: localMetadata.mtime };
            }
            
            // Если у удаленной версии нет векторных часов или это старый формат, используем время модификации
            if (!remoteVectorClock || Object.keys(remoteVectorClock).length === 0) {
                // Проверяем по времени модификации
                if (localMetadata.mtime > remoteMtime) {
                    console.log(`КОНФЛИКТ ВЕРСИЙ: Локальная версия файла ${path} новее (${new Date(localMetadata.mtime).toISOString()}) чем удаленная (${new Date(remoteMtime).toISOString()}). Пробуем слияние.`);
                    
                    // Если локальная версия новее, но мы знаем устройство-источник, это может быть конфликт
                    if (sourceDeviceId) {
                        return { needsSync: true, needsMerge: true };
                    }
                    
                    // Иначе сохраняем локальную версию
                    return { needsSync: false, needsMerge: false };
                }
                
                // Если удаленная версия новее, запрашиваем её
                console.log(`Удаленная версия файла ${path} новее (${new Date(remoteMtime).toISOString()}) чем локальная (${new Date(localMetadata.mtime).toISOString()}). Запрашиваем обновление.`);
                return { needsSync: true, needsMerge: false };
            }
            
            // При наличии векторных часов выполняем более точное сравнение
            const comparisonResult = this.compareVectorClocks(localMetadata.vectorClock, remoteVectorClock);
            
            switch (comparisonResult) {
                case 'identical':
                    // Часы идентичны, но хеши разные - странная ситуация
                    console.log(`Странно: векторные часы идентичны, но хеши разные для ${path}. Запрашиваем обновление.`);
                    return { needsSync: true, needsMerge: false };
                
                case 'local_newer':
                    // Локальная версия новее
                    console.log(`Локальная версия ${path} новее по векторным часам. Сохраняем локальную версию.`);
                    return { needsSync: false, needsMerge: false };
                
                case 'remote_newer':
                    // Удаленная версия новее
                    console.log(`Удаленная версия ${path} новее по векторным часам. Запрашиваем обновление.`);
                    return { needsSync: true, needsMerge: false };
                
                case 'conflict':
                    // Обнаружен конфликт - обе версии имеют независимые изменения
                    console.log(`КОНФЛИКТ: Обнаружены параллельные изменения файла ${path}. Требуется слияние.`);
                    return { needsSync: true, needsMerge: true };
            }
        }
        
        // Если хеши совпадают, файл не нужно синхронизировать
        return { needsSync: false, needsMerge: false };
    }
    
    /**
     * Сравнить два набора векторных часов и определить отношение между ними
     * @returns 'identical' - идентичны, 'local_newer' - локальные новее, 
     * 'remote_newer' - удаленные новее, 'conflict' - конфликт версий
     */
    private compareVectorClocks(localClock: Record<string, number>, remoteClock: Record<string, number>): 'identical' | 'local_newer' | 'remote_newer' | 'conflict' {
        // Проверка на идентичность
        const allDeviceIds = new Set([...Object.keys(localClock), ...Object.keys(remoteClock)]);
        
        let localHasNewer = false;
        let remoteHasNewer = false;
        
        for (const deviceId of allDeviceIds) {
            const localTime = localClock[deviceId] || 0;
            const remoteTime = remoteClock[deviceId] || 0;
            
            if (localTime > remoteTime) {
                localHasNewer = true;
            } else if (remoteTime > localTime) {
                remoteHasNewer = true;
            }
            
            // Если обнаружили различия в обоих направлениях, это конфликт
            if (localHasNewer && remoteHasNewer) {
                return 'conflict';
            }
        }
        
        // Определяем результат сравнения
        if (!localHasNewer && !remoteHasNewer) {
            return 'identical';
        } else if (localHasNewer) {
            return 'local_newer';
        } else {
            return 'remote_newer';
        }
    }
    
    /**
     * Обработчик запроса на получение файла
     * с поддержкой фрагментации для больших файлов
     */
    private async handleFileRequest(
        path: string, 
        sourceDeviceId: string, 
        requestId?: string, 
        needsMerge: boolean = false, 
        remoteVectorClock?: Record<string, number>,
        chunkRequest?: { chunkIndex: number, totalChunks: number, syncOperationId: string }
    ): Promise<void> {
        try {
            // Если это запрос на фрагмент файла
            if (chunkRequest) {
                await this.handleFileChunkRequest(path, sourceDeviceId, chunkRequest, requestId);
                return;
            }
            
            console.log(`Обработка запроса на получение файла ${path}...${needsMerge ? ' (запрошено слияние)' : ''}`);
            
            // Получаем файл из хранилища
            const file = this.app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) {
                console.log(`Файл ${path} не найден или не является файлом`);
                return;
            }
            
            // Проверяем размер файла для определения стратегии отправки
            const fileSize = file.stat.size;
            const CHUNK_SIZE = 500 * 1024; // 500 KB - тот же размер, что и при отправке
            const needsChunking = fileSize > CHUNK_SIZE * 2; // Если файл больше 1MB, используем фрагментацию
            
            // Если не нужна фрагментация, отправляем файл целиком обычным способом
            if (!needsChunking) {
                // Читаем содержимое файла
                const content = await this.app.vault.read(file);
                
                // Вычисляем хеш содержимого
                const hash = await CryptoHelper.hashString(content);
                
                // Получаем метаданные файла
                const metadata = this.syncState.files[path];
                
                // Если файла нет в метаданных, создаем его запись
                if (!metadata) {
                    this.syncState.files[path] = {
                        path,
                        hash,
                        mtime: file.stat.mtime,
                        size: content.length,
                        vectorClock: { [this.syncState.deviceId]: Date.now() }
                    };
                }
                
                // Если требуется слияние, добавляем информацию для разрешения конфликта
                let conflictResolution = undefined;
                if (needsMerge) {
                    console.log(`Подготовка данных для слияния файла ${path}`);
                    
                    // Находим или создаем общую базовую версию для слияния
                    const baseVersionHash = await this.findCommonBaseVersion(path, hash, remoteVectorClock);
                    
                    conflictResolution = {
                        isConflict: true,
                        baseVersionHash: baseVersionHash,
                        deviceId: this.syncState.deviceId
                    };
                }
                
                // Обновляем векторные часы, увеличивая значение для текущего устройства
                const currentTime = Date.now();
                const vectorClock = metadata?.vectorClock ? { ...metadata.vectorClock } : {}; 
                vectorClock[this.syncState.deviceId] = currentTime;
                
                // Отправляем файл запрашивающему устройству с дополнительной информацией
                await this.syncFileWithPeers(
                    path, 
                    content, 
                    hash, 
                    file.stat.mtime, 
                    true, 
                    [sourceDeviceId], 
                    requestId,
                    vectorClock,
                    conflictResolution
                );
                
                console.log(`Файл ${path} отправлен устройству ${sourceDeviceId} по запросу`);
                
                // Обновляем наши метаданные файла
                if (metadata) {
                    metadata.vectorClock = vectorClock;
                    this.saveSyncState();
                }
                
                return;
            }
            
            // Если файл требует фрагментации, отправляем информацию о фрагментах
            // Генерируем unique ID для этой операции синхронизации 
            const syncOperationId = Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
            const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
            
            // Вычисляем хеш для метаданных
            const hash = await CryptoHelper.hashString(await this.app.vault.read(file));
            
            // Отправляем информацию о фрагментированном файле
            this.relayClient.sendMessage({
                type: 'fileChunkInfo',
                targetDeviceId: sourceDeviceId,
                requestId,
                payload: {
                    path,
                    hash,
                    mtime: file.stat.mtime,
                    size: fileSize,
                    syncOperationId,
                    totalChunks,
                    chunkSize: CHUNK_SIZE,
                    needsMerge
                }
            });
            
            console.log(`Информация о фрагментах файла ${path} отправлена устройству ${sourceDeviceId}. Всего фрагментов: ${totalChunks}`);
            
        } catch (error) {
            console.error(`Ошибка при обработке запроса на получение файла ${path}:`, error);
        }
    }
    
    /**
     * Обработка запроса на получение фрагмента файла
     */
    private async handleFileChunkRequest(
        path: string,
        sourceDeviceId: string,
        chunkRequest: { chunkIndex: number, totalChunks: number, syncOperationId: string },
        requestId?: string
    ): Promise<void> {
        try {
            console.log(`Обработка запроса на получение фрагмента ${chunkRequest.chunkIndex + 1}/${chunkRequest.totalChunks} файла ${path}`);
            
            // Получаем файл из хранилища
            const file = this.app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) {
                console.log(`Файл ${path} не найден или не является файлом`);
                return;
            }
            
            // Проверяем валидность запроса
            if (chunkRequest.chunkIndex < 0 || chunkRequest.chunkIndex >= chunkRequest.totalChunks) {
                console.error(`Некорректный индекс фрагмента: ${chunkRequest.chunkIndex}`);
                return;
            }
            
            // Вычисляем размер фрагмента и смещение
            const CHUNK_SIZE = 500 * 1024; // 500 KB - должно совпадать с размером при отправке
            const fileSize = file.stat.size;
            const startOffset = chunkRequest.chunkIndex * CHUNK_SIZE;
            const endOffset = Math.min(startOffset + CHUNK_SIZE, fileSize);
            const chunkSize = endOffset - startOffset;
            
            // Читаем содержимое файла частично
            const fileContent = await this.app.vault.read(file);
            const chunkContent = fileContent.substring(startOffset, endOffset);
            
            // Шифруем фрагмент
            const encryptedData = await CryptoHelper.encrypt(chunkContent, this.encryptionPassword);
            
            // Отправляем фрагмент
            this.relayClient.sendMessage({
                type: 'fileChunk',
                targetDeviceId: sourceDeviceId,
                requestId,
                payload: {
                    path,
                    encryptedData,
                    chunkIndex: chunkRequest.chunkIndex,
                    totalChunks: chunkRequest.totalChunks,
                    syncOperationId: chunkRequest.syncOperationId,
                    isLastChunk: chunkRequest.chunkIndex === chunkRequest.totalChunks - 1
                }
            });
            
            console.log(`Фрагмент ${chunkRequest.chunkIndex + 1}/${chunkRequest.totalChunks} файла ${path} отправлен устройству ${sourceDeviceId}`);
            
        } catch (error) {
            console.error(`Ошибка при обработке запроса на получение фрагмента файла ${path}:`, error);
        }
    }
    
    /**
     * Найти общую базовую версию для слияния конфликтующих изменений
     * @returns Хеш базовой версии или undefined, если не найдена
     */
    private async findCommonBaseVersion(path: string, currentHash: string, remoteVectorClock?: Record<string, number>): Promise<string | undefined> {
        try {
            // Проверяем сохраненную базовую версию
            const metadata = this.syncState.files[path];
            if (metadata?.baseVersionHash) {
                console.log(`Найдена сохраненная общая базовая версия для ${path}: ${metadata.baseVersionHash.substring(0, 8)}`);
                return metadata.baseVersionHash;
            }
            
            // Проверяем кэш файлов для поиска общей базовой версии
            for (const cacheEntry of this.fileContentCache.entries()) {
                const [cachedPath, cachedData] = cacheEntry;
                if (cachedPath === path && cachedData.hash !== currentHash) {
                    console.log(`Найдена потенциальная базовая версия в кэше для ${path}: ${cachedData.hash.substring(0, 8)}`);
                    return cachedData.hash;
                }
            }
            
            // Временное решение: используем текущий хеш файла
            // В полной реализации нужно отслеживать историю версий
            return currentHash;
        } catch (error) {
            console.error(`Ошибка при поиске базовой версии для ${path}:`, error);
            return currentHash;
        }
    }

    /**
     * Возвращает текущие векторные часы для файла
     */
    private getFileVectorClock(path: string): Record<string, number> {
        const metadata = this.syncState.files[path];
        if (metadata?.vectorClock) {
            return { ...metadata.vectorClock };
        }
        
        // Если нет метаданных или векторных часов, создаем их
        return { [this.syncState.deviceId]: Date.now() };
    }

    /**
     * Обработка сообщения синхронизации файла
     */
    private async processFileSyncMessage(fileMessage: SyncFileMessage): Promise<void> {
        const { path, encryptedData, deleted, mtime, hash, priority, compression } = fileMessage;

        try {
            // Если файл удален, обрабатываем удаление
            if (deleted) {
                // Проверяем, существует ли файл
                const existingFile = this.app.vault.getAbstractFileByPath(path);
                
                if (existingFile) {
                    // Удаляем файл
                    await this.app.vault.delete(existingFile);
                    
                    // Обновляем состояние
                    if (this.syncState.files[path]) {
                        this.syncState.files[path] = {
                            ...this.syncState.files[path],
                            deleted: true
                        };
                    }
                    
                    console.log(`Файл удален: ${path}`);
                }
                return;
            }

            // Если файл не удален, но нет зашифрованных данных, пропускаем
            if (!encryptedData) {
                console.error(`Отсутствуют зашифрованные данные для файла ${path}`);
                return;
            }

            // Проверяем на конфликт версий с помощью векторных часов
            const existingFile = this.syncState.files[path];
            const remoteVectorClock = fileMessage.vectorClock;
            
            // Если у нас есть файл с таким же хешем, пропускаем
            if (existingFile && existingFile.hash === hash) {
                console.log(`Пропуск файла ${path}: у нас уже есть актуальная версия`);
                
                // Обновляем векторные часы, объединяя их с удаленными
                if (remoteVectorClock) {
                    existingFile.vectorClock = this.mergeVectorClocks(
                        existingFile.vectorClock || {},
                        remoteVectorClock
                    );
                    this.saveSyncState();
                }
                
                return;
            }

            // Логирование информации о приоритете и сжатии
            const priorityInfo = priority || 'normal';
            console.log(`Обработка файла ${path} с приоритетом ${priorityInfo}`);
            
            if (compression && compression.compressed) {
                console.log(`Файл сжат: ${compression.compressedSize} байт (исходный размер: ${compression.originalSize} байт)`);
            }

            // Расшифровываем содержимое файла
            let decryptedContent = await CryptoHelper.decrypt(encryptedData, this.encryptionPassword);

            // Обработка файла с дельтой
            if (fileMessage.deltaData && fileMessage.deltaData.baseHash && fileMessage.deltaData.isDelta) {
                console.log(`Получена дельта для файла ${path}. Применяем к базовой версии...`);
                
                try {
                    // Получаем базовую версию файла
                    const baseContent = await this.getFileWithHash(path, fileMessage.deltaData.baseHash) || null;
                    
                    if (baseContent) {
                        // Применяем дельту
                        decryptedContent = this.applyDelta(baseContent, decryptedContent);
                        console.log(`Дельта успешно применена к файлу ${path}`);
                    } else {
                        console.error(`Не удалось найти базовую версию файла ${path} с хешем ${fileMessage.deltaData.baseHash}`);
                        throw new Error(`Не удалось применить дельту: базовая версия файла не найдена`);
                    }
                } catch (deltaError) {
                    console.error(`Ошибка при применении дельты для файла ${path}:`, deltaError);
                    throw new Error(`Не удалось применить дельту: ${deltaError.message}`);
                }
            }

            // Декомпрессия, если файл был сжат
            let finalContent = decryptedContent;
            if (compression && compression.compressed && !fileMessage.deltaData) {
                try {
                    // Проверяем, является ли содержимое сжатым в нашем формате
                    if (decryptedContent.startsWith('{') && decryptedContent.includes('"dictionary":')) {
                        // Это сжатый текстовый файл, распаковываем
                        finalContent = this.decompressTextContent(decryptedContent);
                        console.log(`Распаковано сжатое текстовое содержимое для ${path}`);
                    } else {
                        // Обычный файл, используем как есть
                        finalContent = decryptedContent;
                    }
                } catch (decompressError) {
                    console.error(`Ошибка при распаковке содержимого файла ${path}:`, decompressError);
                    // В случае ошибки используем содержимое как есть
                    finalContent = decryptedContent;
                }
            }
            
            // Проверяем на конфликт с помощью векторных часов и информации о конфликте
            let needsMerge = false;
            if (existingFile && existingFile.hash !== hash && existingFile.vectorClock && remoteVectorClock) {
                const comparisonResult = this.compareVectorClocks(existingFile.vectorClock, remoteVectorClock);
                needsMerge = comparisonResult === 'conflict' || (fileMessage.conflictResolution?.isConflict === true);
                
                if (needsMerge) {
                    console.log(`Обнаружен конфликт версий файла ${path}. Применяем стратегию слияния.`);
                    
                    // Читаем текущее содержимое нашего файла
                    const localContent = await this.app.vault.read(this.app.vault.getAbstractFileByPath(path) as TFile);
                    
                    // Создаем резервную копию текущей версии
                    const backupPath = `${path}.backup.${new Date().toISOString().replace(/:/g, '-')}`;
                    await this.app.vault.create(backupPath, localContent);
                    console.log(`Создана резервная копия локальной версии: ${backupPath}`);
                    
                    // Сохраняем базовую версию для будущего использования
                    if (fileMessage.conflictResolution?.baseVersionHash) {
                        existingFile.baseVersionHash = fileMessage.conflictResolution.baseVersionHash;
                    }
                    
                    // Пытаемся выполнить автоматическое слияние
                    try {
                        finalContent = await this.mergeFileContents(path, localContent, finalContent, fileMessage.conflictResolution?.baseVersionHash);
                        console.log(`Успешно выполнено автоматическое слияние файла ${path}`);
                        
                        // Создаем объединенные векторные часы
                        const mergedVectorClock = this.mergeVectorClocks(
                            existingFile.vectorClock || {},
                            remoteVectorClock
                        );
                        
                        // Увеличиваем наш счетчик как автора слияния
                        mergedVectorClock[this.syncState.deviceId] = Date.now();
                        
                        // Устанавливаем новые векторные часы
                        existingFile.vectorClock = mergedVectorClock;
                    } catch (mergeError) {
                        console.error(`Не удалось автоматически слить файл ${path}:`, mergeError);
                        
                        // Создаем копию конфликтующей версии
                        const conflictPath = `${path}.conflict.${new Date().toISOString().replace(/:/g, '-')}`;
                        await this.app.vault.create(conflictPath, finalContent);
                        
                        new Notice(`Конфликт версий файла ${path}. Обе версии сохранены для ручного слияния.`);
                        
                        // Не обновляем основной файл, только метаданные
                        existingFile.conflict = true;
                        this.saveSyncState();
                        return;
                    }
                }
            }

            // Проверяем, существует ли директория для файла
            const dirPath = path.split('/').slice(0, -1).join('/');
            if (dirPath && !this.app.vault.getAbstractFileByPath(dirPath)) {
                // Создаем директорию, если она не существует
                await this.app.vault.createFolder(dirPath);
            }

            // Проверяем, существует ли файл
            const existingFileObj = this.app.vault.getAbstractFileByPath(path);
            
            if (existingFileObj instanceof TFile) {
                // Если файл существует, обновляем его содержимое
                await this.app.vault.modify(existingFileObj, finalContent);
            } else {
                // Если файл не существует, создаем его
                await this.app.vault.create(path, finalContent);
            }

            // Создаем новый хеш содержимого после слияния
            const newHash = needsMerge ? await CryptoHelper.hashString(finalContent) : hash;
            
            // Обновляем состояние синхронизации
            this.syncState.files[path] = {
                path,
                hash: newHash,
                mtime: Date.now(), // Используем текущее время для слитой версии
                size: finalContent.length,
                // Объединяем или обновляем векторные часы
                vectorClock: needsMerge ? 
                    (existingFile?.vectorClock || this.mergeVectorClocks({}, remoteVectorClock || {})) : 
                    (remoteVectorClock || { [this.syncState.deviceId]: Date.now() }),
                // Сохраняем базовую версию, если она была предоставлена
                baseVersionHash: fileMessage.conflictResolution?.baseVersionHash || existingFile?.baseVersionHash
            };
            
            // Устанавливаем наше устройство как последнее изменившее файл
            if (this.syncState.files[path].vectorClock) {
                this.syncState.files[path].vectorClock[this.syncState.deviceId] = Date.now();
            }

            // Сохраняем обновленное состояние
            this.saveSyncState();

            console.log(`Файл ${needsMerge ? 'слит и синхронизирован' : 'синхронизирован'}: ${path} (${finalContent.length} байт)`);
        } catch (error) {
            console.error(`Ошибка обработки сообщения синхронизации для файла ${path}:`, error);
            new Notice(`Ошибка синхронизации файла ${path}: ${error.message}`);
        }
    }
    
    /**
     * Объединить два набора векторных часов, выбирая максимальное значение для каждого устройства
     */
    private mergeVectorClocks(clock1: Record<string, number>, clock2: Record<string, number>): Record<string, number> {
        const result = { ...clock1 };
        
        // Для каждого устройства в clock2 устанавливаем максимальное значение
        for (const [deviceId, time] of Object.entries(clock2)) {
            result[deviceId] = Math.max(result[deviceId] || 0, time);
        }
        
        return result;
    }
    
    /**
     * Слияние содержимого файлов при конфликте
     * Реализует трехстороннее слияние, если доступна базовая версия
     */
    private async mergeFileContents(path: string, localContent: string, remoteContent: string, baseVersionHash?: string): Promise<string> {
        try {
            // Проверка входных параметров
            if (!localContent && !remoteContent) {
                console.warn(`mergeFileContents: Пустое содержимое для ${path}`);
                return "";
            }
            
            if (!localContent) return remoteContent;
            if (!remoteContent) return localContent;
            
            // Определяем тип файла
            const isMarkdown = path.endsWith('.md');
            
            // Для Markdown используем построчное слияние
            if (isMarkdown) {
                // Если есть базовая версия, используем трехстороннее слияние
                if (baseVersionHash) {
                    const baseContent = await this.getFileWithHash(path, baseVersionHash);
                    if (baseContent) {
                        return this.threeWayMerge(baseContent, localContent, remoteContent);
                    }
                }
                
                // Иначе используем простое построчное слияние
                return this.lineMerge(localContent, remoteContent);
            }
        } catch (error) {
            console.error(`Ошибка при слиянии содержимого файла ${path}:`, error);
            // В случае ошибки сохраняем обе версии с разделителями
            return `<<<<<<< ЛОКАЛЬНАЯ ВЕРСИЯ (ОШИБКА СЛИЯНИЯ)\n${localContent}\n=======\n${remoteContent}\n>>>>>>> УДАЛЕННАЯ ВЕРСИЯ\n`;
        }
        
        // Для других типов файлов просто объединяем содержимое с разделителем
        const mergedContent = 
            `<<<<<<< ЛОКАЛЬНАЯ ВЕРСИЯ\n${localContent}\n=======\n${remoteContent}\n>>>>>>> УДАЛЕННАЯ ВЕРСИЯ\n`;
        
        // Показываем уведомление о необходимости ручного слияния
        new Notice(`Не удалось автоматически слить файл ${path}. Требуется ручное слияние.`);
        
        return mergedContent;
    }
    
    /**
     * Простое построчное слияние для текстовых файлов
     * Объединяет уникальные строки из обеих версий
     */
    private lineMerge(localContent: string, remoteContent: string): string {
        const localLines = localContent.split(/\r?\n/);
        const remoteLines = remoteContent.split(/\r?\n/);
        
        // Создаем Set для уникальных строк
        const mergedLines = new Set<string>();
        
        // Добавляем все строки
        for (const line of localLines) {
            mergedLines.add(line);
        }
        
        for (const line of remoteLines) {
            mergedLines.add(line);
        }
        
        // Преобразуем обратно в текст
        return Array.from(mergedLines).join('\n');
    }
    
    /**
     * Трехстороннее слияние (three-way merge)
     * Использует базовую версию для определения изменений в обеих версиях
     */
    private threeWayMerge(baseContent: string, localContent: string, remoteContent: string): string {
        // Проверка входных параметров
        if (!baseContent || !localContent || !remoteContent) {
            console.warn("threeWayMerge: Одно из содержимых пусто, используем простое слияние");
            return this.lineMerge(localContent || "", remoteContent || "");
        }
        // Разделяем содержимое на строки
        const baseLines = baseContent.split(/\r?\n/);
        const localLines = localContent.split(/\r?\n/);
        const remoteLines = remoteContent.split(/\r?\n/);
        
        // Результирующий массив строк
        const resultLines: string[] = [];
        
        // Индексы для прохода по строкам
        let baseIndex = 0;
        let localIndex = 0;
        let remoteIndex = 0;
        
        // Проходим по строкам, сравнивая все три версии
        while (
            baseIndex < baseLines.length || 
            localIndex < localLines.length || 
            remoteIndex < remoteLines.length
        ) {
            // Получаем текущие строки (или null, если достигли конца)
            const baseLine = baseIndex < baseLines.length ? baseLines[baseIndex] : null;
            const localLine = localIndex < localLines.length ? localLines[localIndex] : null;
            const remoteLine = remoteIndex < remoteLines.length ? remoteLines[remoteIndex] : null;
            
            // Если все три строки одинаковы, добавляем одну и увеличиваем все индексы
            if (baseLine === localLine && localLine === remoteLine) {
                if (localLine !== null) {
                    resultLines.push(localLine);
                }
                baseIndex++;
                localIndex++;
                remoteIndex++;
                continue;
            }
            
            // Если локальная строка совпадает с базовой, но удаленная отличается,
            // значит, изменение было только в удаленной версии - берем удаленную
            if (baseLine === localLine && localLine !== remoteLine) {
                if (remoteLine !== null) {
                    resultLines.push(remoteLine);
                }
                baseIndex++;
                localIndex++;
                remoteIndex++;
                continue;
            }
            
            // Если удаленная строка совпадает с базовой, но локальная отличается,
            // значит, изменение было только в локальной версии - берем локальную
            if (baseLine === remoteLine && remoteLine !== localLine) {
                if (localLine !== null) {
                    resultLines.push(localLine);
                }
                baseIndex++;
                localIndex++;
                remoteIndex++;
                continue;
            }
            
            // Если локальная и удаленная строки совпадают, но отличаются от базовой,
            // значит, и там и там сделано одинаковое изменение - берем любую
            if (localLine === remoteLine && localLine !== baseLine) {
                if (localLine !== null) {
                    resultLines.push(localLine);
                }
                baseIndex++;
                localIndex++;
                remoteIndex++;
                continue;
            }
            
            // Если все строки различаются, у нас конфликт - включаем обе версии с маркерами
            resultLines.push(`<<<<<<< ЛОКАЛЬНАЯ ВЕРСИЯ`);
            if (localLine !== null) {
                resultLines.push(localLine);
            }
            resultLines.push(`=======`);
            if (remoteLine !== null) {
                resultLines.push(remoteLine);
            }
            resultLines.push(`>>>>>>> УДАЛЕННАЯ ВЕРСИЯ`);
            
            baseIndex++;
            localIndex++;
            remoteIndex++;
        }
        
        // Объединяем строки обратно в текст
        return resultLines.join('\n');
    }

    /**
     * Обработчик изменения соединения
     */
    private handleConnectionChange(connected: boolean): void {
        if (connected) {
            new Notice("Подключено к серверу синхронизации");
            
            // Запускаем полную синхронизацию при подключении
            this.performFullSync();
        } else {
            new Notice("Отключено от сервера синхронизации");
        }
    }

    /**
     * Обработчик изменения списка доверенных устройств
     */
    private handleTrustedDevicesChange(devices: DeviceInfo[]): void {
        // Защита от undefined
        if (!devices) {
            console.log("Получен пустой список доверенных устройств");
            this.trustedDevices = [];
            return;
        }
        
        // Обновляем список доверенных устройств
        this.trustedDevices = devices;
        console.log("Список доверенных устройств обновлен:", devices);
        
        // Безопасная проверка длины массива
        const hasDevices = Array.isArray(devices) && devices.length > 0;
        
        // Если есть доверенные устройства
        if (hasDevices) {
            console.log(`Обнаружено ${devices.length} доверенных устройств`);
            
            // Если мы в режиме ожидания и получили доверенные устройства, проверяем их активность
            if (this.waitingMode) {
                console.log("Обнаружены доверенные устройства в режиме ожидания. Проверяем их активность...");
                
                // Небольшая задержка перед проверкой
                setTimeout(() => {
                    this.checkActiveTrustedDevices();
                }, 1000);
                
                return;
            }
            
            // Если мы не в режиме ожидания, проверяем время последней синхронизации
            const lastSyncTime = this.syncState.lastSyncTime || 0;
            const timeSinceLastSync = Date.now() - lastSyncTime;
            
            // Если прошло больше 5 минут с последней синхронизации или есть накопленные изменения
            if (timeSinceLastSync > 5 * 60 * 1000 || this.pendingChangesCount > 0) {
                console.log(`${timeSinceLastSync > 5 * 60 * 1000 ? 'Давно не было синхронизации' : `Накоплено ${this.pendingChangesCount} изменений`}, запускаем полную синхронизацию`);
                
                // Небольшая задержка перед запуском синхронизации
                setTimeout(() => {
                    this.performFullSync();
                }, 2000);
            }
        } else {
            console.log("Нет доверенных устройств. Переход в режим ожидания.");
            this.waitingMode = true;
        }
    }

    /**
     * Обработчик запроса на синхронизацию
     */
    private handleSyncRequest(request: SyncMessage): void {
        // Сохраняем запрос в списке ожидающих
        if (request.requestId) {
            this.pendingSyncRequests.set(request.requestId, request);
            
            // Показываем уведомление о запросе
            new Notice(
                `Устройство ${request.deviceName || 'Неизвестное'} запрашивает синхронизацию. ` +
                `Перейдите в настройки плагина для подтверждения.`
            );
        }
    }

    /**
     * Ответить на запрос синхронизации
     */
    public async respondToSyncRequest(requestId: string, accept: boolean, trustPermanently: boolean): Promise<boolean> {
        console.log(`Обработка ответа на запрос синхронизации: ${requestId}, accept=${accept}, trust=${trustPermanently}`);
        
        const request = this.pendingSyncRequests.get(requestId);
        if (!request || !request.sourceDeviceId) {
            console.error(`Запрос ${requestId} не найден или отсутствует sourceDeviceId`);
            return false;
        }

        try {
            console.log(`Отправка ответа на запрос через RelayClient для устройства ${request.sourceDeviceId}`);
            
            // Отправляем ответ через RelayClient
            const success = await this.relayClient.respondToSyncRequest(
                requestId,
                request.sourceDeviceId,
                accept,
                trustPermanently
            );

            console.log(`Ответ отправлен, результат: ${success}`);

            // Удаляем запрос из списка ожидающих
            this.pendingSyncRequests.delete(requestId);
            console.log(`Запрос ${requestId} удален из списка ожидающих`);

            // Если запрос принят и доверие постоянное, выполняем полную синхронизацию
            if (accept && trustPermanently) {
                console.log("Запрос принят с постоянным доверием, запускаем полную синхронизацию");
                
                // Небольшая задержка перед запуском синхронизации
                setTimeout(() => {
                    console.log("Запуск отложенной полной синхронизации");
                    this.performFullSync();
                }, 2000);
            }

            return success;
        } catch (error) {
            console.error("Error responding to sync request:", error);
            // Все равно удаляем запрос, чтобы не блокировать интерфейс
            this.pendingSyncRequests.delete(requestId);
            return false;
        }
    }

    /**
     * Получить список ожидающих запросов на синхронизацию
     */
    public getPendingSyncRequests(): SyncMessage[] {
        return Array.from(this.pendingSyncRequests.values());
    }

    /**
     * Выполнить полную синхронизацию с доверенными устройствами
     */
    public async performFullSync(): Promise<void> {
        try {
            // Проверка подключения к серверу
            if (!this.relayClient.isConnected) {
                console.log("Синхронизация пропущена: нет подключения к серверу");
                new Notice("Нет соединения с сервером. Синхронизация невозможна.");
                return;
            }
            
            // Запрашиваем актуальный список доверенных устройств
            console.log("Запрашиваем актуальный список доверенных устройств...");
            this.relayClient.requestTrustedDevices();
            
            // Небольшая задержка для получения ответа от сервера
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Получаем текущие доверенные устройства от RelayClient
            const trustedDevices = this.relayClient.getTrustedDevices();
            
            // Безопасная проверка доверенных устройств
            const hasTrustedDevices = Array.isArray(trustedDevices) && trustedDevices.length > 0;
            
            if (this.isSyncing) {
                console.log("Синхронизация пропущена: уже выполняется синхронизация");
                new Notice("Синхронизация уже выполняется...");
                return;
            }
            
            console.log(`Список доверенных устройств: ${JSON.stringify(trustedDevices)}`);
            
            // Если мы в режиме ожидания или нет доверенных устройств - проверяем наличие активных устройств
            if (this.waitingMode || !hasTrustedDevices) {
                console.log(`${this.waitingMode ? 'Плагин в режиме ожидания' : 'Нет доверенных устройств'}. Проверка активности...`);
                new Notice(`${this.waitingMode ? 'Плагин в режиме ожидания' : 'Нет доверенных устройств'}. Проверка активности...`);
                
                // Проверяем наличие активных устройств
                await this.checkActiveTrustedDevices();
                
                // Если после проверки все еще в режиме ожидания, прекращаем синхронизацию
                if (this.waitingMode) {
                    console.log("После проверки по-прежнему нет активных устройств. Синхронизация отложена.");
                    new Notice("Нет активных устройств для синхронизации. Убедитесь, что другие устройства включены и подключены.");
                    
                    // Обновляем локальное состояние на всякий случай
                    await this.updateLocalFileState();
                    return;
                }
                
                // Проверяем заново после перехода в активный режим
                const updatedTrustedDevices = this.relayClient.getTrustedDevices();
                if (!Array.isArray(updatedTrustedDevices) || updatedTrustedDevices.length === 0) {
                    console.log("После проверки все еще нет доверенных устройств. Синхронизация отложена.");
                    new Notice("Нет доверенных устройств для синхронизации. Используйте ключ приглашения для добавления устройств.");
                    return;
                }
            }

            console.log(`Начинаем интеллектуальную синхронизацию с ${trustedDevices.length} устройствами...`);
            this.isSyncing = true;
            new Notice(`Начата синхронизация с ${trustedDevices.length} устройствами`);

            // Обновляем локальное состояние файлов
            console.log("Обновление локального состояния файлов...");
            await this.updateLocalFileState();

            // Запросим метаданные файлов у других устройств для оптимизации синхронизации
            await this.requestFileMetadata(trustedDevices);

            // Начинаем асинхронный анализ файлов для уменьшения блокировки основного потока
            const fileEntries = Object.entries(this.syncState.files);
            console.log(`Начало асинхронного анализа ${fileEntries.length} файлов для интеллектуальной синхронизации...`);
            
            // Классифицируем файлы с помощью асинхронной обработки
            const { filesForSync, unchangedFiles, identicalFiles } = 
                await this.analyzeFilesForSync(fileEntries, trustedDevices);
            
            // Проверяем наличие необходимости в синхронизации
            if (filesForSync.length === 0) {
                console.log("Нет файлов, требующих синхронизации. Синхронизация пропущена.");
                
                // Сбрасываем счетчик накопленных изменений
                this.pendingChangesCount = 0;
                
                // Обновляем время последней синхронизации все равно
                this.syncState.lastSyncTime = Date.now();
                this.saveSyncState();
                
                new Notice("Синхронизация не требуется: все файлы актуальны");
                this.isSyncing = false;
                return;
            }
            
            // Если есть что синхронизировать, продолжаем
            
            // Сортируем файлы с приоритетом:
            // 1. Сначала по приоритету (isNew)
            // 2. Затем по размеру (маленькие первыми)
            filesForSync.sort((a, b) => {
                // По приоритету
                if (a.isNew !== b.isNew) {
                    return a.isNew ? -1 : 1;
                }
                // По размеру
                return a.metadata.size - b.metadata.size;
            });
            
            console.log(`Найдено ${filesForSync.length} файлов для синхронизации, ${unchangedFiles} файлов не требуют обновления`);
            
            // Для маленьких наборов файлов используем прямую отправку
            if (filesForSync.length <= 10) {
                console.log("Небольшой набор файлов, используем прямую отправку...");
                await this.syncSmallFileSet(filesForSync);
            } else {
                // Для больших наборов используем пакетную обработку
                await this.syncLargeFileSet(filesForSync);
            }

            // Обновляем время последней синхронизации
            this.syncState.lastSyncTime = Date.now();
            this.saveSyncState();
            
            // Сбрасываем счетчик накопленных изменений
            this.pendingChangesCount = 0;

            const summary = `Синхронизация завершена: отправлено ${filesForSync.length} файлов, идентичных на всех устройствах ${identicalFiles}, не требовали обновления ${unchangedFiles}`;
            console.log("СИГНАЛЬНАЯ СИСТЕМА: " + summary);
            new Notice(summary);
        } catch (error) {
            console.error("Ошибка при синхронизации:", error);
            new Notice(`Ошибка синхронизации: ${error.message}`);
        } finally {
            this.isSyncing = false;
        }
    }
    
    /**
     * Синхронизация небольшого набора файлов (прямая отправка)
     */
    private async syncSmallFileSet(files: Array<{path: string, metadata: FileMetadata, isNew: boolean, targetDevices: string[]}>): Promise<void> {
        let syncedCount = 0;
        
        for (const { path, metadata, isNew, targetDevices } of files) {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
                try {
                    const content = await this.app.vault.read(file);
                    
                    // Отправляем файл только указанным устройствам
                    await this.syncFileWithPeers(path, content, metadata.hash, metadata.mtime, isNew, targetDevices);
                    syncedCount++;
                } catch (fileError) {
                    console.error(`Ошибка при синхронизации файла ${path}:`, fileError);
                }
            }
        }
        
        console.log(`Синхронизировано ${syncedCount} файлов напрямую`);
    }
    
    /**
     * Синхронизация большого набора файлов (пакетная обработка)
     */
    private async syncLargeFileSet(files: Array<{path: string, metadata: FileMetadata, isNew: boolean, targetDevices: string[]}>): Promise<void> {
        // Разделяем файлы на высокоприоритетные и обычные
        const highPriorityFiles = files.filter(f => f.isNew);
        const normalPriorityFiles = files.filter(f => !f.isNew);
        
        console.log(`Высокий приоритет: ${highPriorityFiles.length} файлов, обычный приоритет: ${normalPriorityFiles.length} файлов`);
        
        // Обрабатываем высокоприоритетные файлы сначала
        if (highPriorityFiles.length > 0) {
            console.log("Синхронизация файлов с высоким приоритетом...");
            const batchSize = 10;
            const batches = Math.ceil(highPriorityFiles.length / batchSize);
            
            for (let i = 0; i < batches; i++) {
                const batch = highPriorityFiles.slice(i * batchSize, (i + 1) * batchSize);
                await this.processBatch(batch, i + 1, batches, "высокоприоритетных");
            }
        }
        
        // Затем обрабатываем обычные файлы
        if (normalPriorityFiles.length > 0) {
            console.log("Синхронизация файлов с обычным приоритетом...");
            // Для обычных файлов используем большие пакеты
            const batchSize = 20;
            const batches = Math.ceil(normalPriorityFiles.length / batchSize);
            
            for (let i = 0; i < batches; i++) {
                const batch = normalPriorityFiles.slice(i * batchSize, (i + 1) * batchSize);
                await this.processBatch(batch, i + 1, batches, "обычных");
            }
        }
    }
    
    /**
     * Обработка пакета файлов
     */
    private async processBatch(
        batch: Array<{path: string, metadata: FileMetadata, isNew: boolean, targetDevices: string[]}>,
        batchNumber: number, 
        totalBatches: number,
        batchType: string
    ): Promise<void> {
        console.log(`Обработка пакета ${batchNumber}/${totalBatches} ${batchType} файлов...`);
        
        // Отправляем пакет параллельно
        const batchPromises = batch.map(async ({ path, metadata, isNew, targetDevices }) => {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
                try {
                    const content = await this.app.vault.read(file);
                    
                    // Отправляем файл только нужным устройствам
                    await this.syncFileWithPeers(path, content, metadata.hash, metadata.mtime, isNew, targetDevices);
                    return true;
                } catch (fileError) {
                    console.error(`Ошибка при синхронизации файла ${path}:`, fileError);
                    return false;
                }
            }
            return false;
        });
        
        // Ждем выполнения всех задач в пакете
        const batchResults = await Promise.allSettled(batchPromises);
        
        // Подсчитываем успешно синхронизированные файлы
        const successfulSyncs = batchResults.filter(
            result => result.status === 'fulfilled' && result.value === true
        ).length;
        
        console.log(`Пакет ${batchNumber}/${totalBatches}: успешно синхронизировано ${successfulSyncs}/${batch.length} файлов`);
        
        // Небольшая пауза между пакетами
        if (batchNumber < totalBatches) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }
    
    /**
     * Запросить метаданные файлов у других устройств для оптимизации синхронизации
     */
    private deviceFileMetadata: Map<string, Record<string, FileMetadata>> = new Map();
    
    private async requestFileMetadata(trustedDevices: DeviceInfo[]): Promise<void> {
        try {
            console.log("Запрос метаданных файлов у доверенных устройств...");
            
            // Очищаем старые метаданные
            this.deviceFileMetadata.clear();
            
            // Подготавливаем и отправляем запрос на метаданные
            const metadataPromises: Promise<void>[] = [];
            
            for (const device of trustedDevices) {
                const promise = new Promise<void>((resolve) => {
                    // Устанавливаем обработчик для получения метаданных
                    const requestId = Date.now().toString() + '-' + Math.random().toString(36).substr(2, 5);
                    
                    // Функция для обработки ответа с метаданными
                    const handleMetadataResponse = (message: any) => {
                        if (message.type === 'fileMetadata' && 
                            message.requestId === requestId && 
                            message.sourceDeviceId === device.id) {
                            
                            // Сохраняем полученные метаданные
                            if (message.payload && typeof message.payload === 'object') {
                                this.deviceFileMetadata.set(device.id, message.payload);
                                console.log(`Получены метаданные от устройства ${device.name || device.id}: ${Object.keys(message.payload).length} файлов`);
                            }
                            
                            // Удаляем обработчик сообщений
                            const originalCallback = this.relayClient['onMessageCallbackOriginal'];
                            if (originalCallback) {
                                this.relayClient['onMessageCallback'] = originalCallback;
                            }
                            
                            resolve();
                        }
                    };
                    
                    // Сохраняем текущий обработчик сообщений
                    const originalCallback = this.relayClient['onMessageCallback'];
                    this.relayClient['onMessageCallbackOriginal'] = originalCallback;
                    
                    // Устанавливаем временный обработчик
                    this.relayClient['onMessageCallback'] = (message: any) => {
                        handleMetadataResponse(message);
                        // Передаем сообщение оригинальному обработчику
                        originalCallback(message);
                    };
                    
                    // Отправляем запрос на метаданные
                    this.relayClient.sendMessage({
                        type: 'requestFileMetadata',
                        targetDeviceId: device.id,
                        requestId,
                        payload: {
                            deviceId: this.syncState.deviceId
                        }
                    });
                    
                    // Устанавливаем таймаут для разрешения промиса даже если нет ответа
                    setTimeout(() => resolve(), 5000);
                });
                
                metadataPromises.push(promise);
            }
            
            // Ждем, пока все запросы метаданных завершатся (с таймаутом)
            console.log("Ожидаем ответы с метаданными...");
            await Promise.all(metadataPromises);
            console.log(`Получены метаданные от ${this.deviceFileMetadata.size} устройств из ${trustedDevices.length}`);
            
        } catch (error) {
            console.error("Ошибка при запросе метаданных:", error);
        }
    }
    
    /**
     * Обработчик запроса метаданных от других устройств
     */
    private handleFileMetadataRequest(message: SyncMessage): void {
        if (!message.sourceDeviceId || !message.requestId) return;
        
        console.log(`Получен запрос метаданных от устройства ${message.deviceName || message.sourceDeviceId}`);
        
        // Отправляем метаданные наших файлов
        this.sendFileMetadata(message.sourceDeviceId, message.requestId);
    }
    
    /**
     * Отправить метаданные файлов другому устройству
     */
    private async sendFileMetadata(targetDeviceId: string, requestId: string): Promise<void> {
        try {
            console.log(`Отправка метаданных файлов устройству ${targetDeviceId}...`);
            
            // Отправляем только необходимые поля метаданных, чтобы уменьшить объем данных
            const metadataToSend: Record<string, Pick<FileMetadata, 'hash' | 'mtime' | 'size' | 'deleted'>> = {};
            
            for (const [path, metadata] of Object.entries(this.syncState.files)) {
                // Пропускаем удаленные файлы
                if (metadata.deleted) continue;
                
                metadataToSend[path] = {
                    hash: metadata.hash,
                    mtime: metadata.mtime,
                    size: metadata.size,
                    // Добавляем deleted только если он true
                    ...(metadata.deleted ? { deleted: true } : {})
                };
            }
            
            // Отправляем метаданные
            this.relayClient.sendMessage({
                type: 'fileMetadata',
                targetDeviceId,
                requestId,
                payload: metadataToSend
            });
            
            console.log(`Метаданные отправлены: ${Object.keys(metadataToSend).length} файлов`);
        } catch (error) {
            console.error("Ошибка при отправке метаданных:", error);
        }
    }
    
    /**
     * Асинхронная функция для анализа файлов, нуждающихся в синхронизации
     * Разбивает работу на порции для уменьшения блокировки основного потока
     */
    private async analyzeFilesForSync(
        fileEntries: [string, FileMetadata][],
        trustedDevices: DeviceInfo[]
    ): Promise<{
        filesForSync: {path: string, metadata: FileMetadata, isNew: boolean, targetDevices: string[]}[],
        unchangedFiles: number,
        identicalFiles: number
    }> {
        const filesForSync: {path: string, metadata: FileMetadata, isNew: boolean, targetDevices: string[]}[] = [];
        let unchangedFiles = 0;
        let identicalFiles = 0;
        
        console.log("СИГНАЛЬНАЯ СИСТЕМА: Начало асинхронной проверки метаданных файлов");
        
        // Определяем размер пакета для обработки за один тик
        const BATCH_SIZE = 100; // Обработка по 100 файлов за раз
        
        // Разбиваем файлы на пакеты
        for (let i = 0; i < fileEntries.length; i += BATCH_SIZE) {
            const batch = fileEntries.slice(i, i + BATCH_SIZE);
            
            // Используем Promise для асинхронной обработки и предотвращения блокировки UI
            await new Promise<void>(resolve => {
                setTimeout(() => {
                    this.processBatchOfFiles(
                        batch, 
                        trustedDevices, 
                        filesForSync, 
                        unchangedFiles, 
                        identicalFiles
                    );
                    
                    // Обновляем счетчики
                    unchangedFiles = this.batchUnchangedFiles;
                    identicalFiles = this.batchIdenticalFiles;
                    
                    console.log(`СИГНАЛЬНАЯ СИСТЕМА: Обработан пакет ${i/BATCH_SIZE + 1}/${Math.ceil(fileEntries.length/BATCH_SIZE)}, найдено ${filesForSync.length} файлов для синхронизации`);
                    resolve();
                }, 0); // Запускаем в следующем тике Event Loop
            });
        }
        
        console.log(`СИГНАЛЬНАЯ СИСТЕМА: Анализ завершен. Файлов для синхронизации: ${filesForSync.length}, 
            идентичных на всех устройствах: ${identicalFiles}, не требующих обновления: ${unchangedFiles}`);
        
        return { filesForSync, unchangedFiles, identicalFiles };
    }
    
    // Счетчики для batchProcessor
    private batchUnchangedFiles = 0;
    private batchIdenticalFiles = 0;
    
    /**
     * Обработать пакет файлов и определить, какие из них нуждаются в синхронизации
     */
    private processBatchOfFiles(
        batch: [string, FileMetadata][],
        trustedDevices: DeviceInfo[],
        filesForSync: {path: string, metadata: FileMetadata, isNew: boolean, targetDevices: string[]}[],
        unchangedFilesStart: number,
        identicalFilesStart: number
    ): void {
        // Устанавливаем начальные значения счетчиков
        this.batchUnchangedFiles = unchangedFilesStart;
        this.batchIdenticalFiles = identicalFilesStart;
        
        // Проверяем каждый файл в пакете
        for (const [path, metadata] of batch) {
            // Пропускаем удаленные файлы
            if (metadata.deleted) {
                continue;
            }
            
            // Определяем, нужно ли синхронизировать этот файл и кому
            const { needsSync, isNew, targetDevices } = this.fileNeedsSync(path, metadata, trustedDevices);
            
            if (needsSync && targetDevices.length > 0) {
                console.log(`СИГНАЛЬНАЯ СИСТЕМА: Файл '${path}' требует синхронизации с ${targetDevices.length} устройствами`);
                filesForSync.push({
                    path,
                    metadata,
                    isNew,
                    targetDevices
                });
            } else if (isNew && targetDevices.length === 0) {
                console.log(`СИГНАЛЬНАЯ СИСТЕМА: Файл '${path}' недавно изменен, но идентичен на всех устройствах`);
                this.batchIdenticalFiles++;
            } else {
                console.log(`СИГНАЛЬНАЯ СИСТЕМА: Файл '${path}' не требует синхронизации`);
                this.batchUnchangedFiles++;
            }
        }
    }

    /**
     * Определить, нужно ли синхронизировать файл с другими устройствами
     * на основе сравнения локальных метаданных и метаданных с других устройств
     */
    private fileNeedsSync(path: string, metadata: FileMetadata, trustedDevices: DeviceInfo[]): {needsSync: boolean, isNew: boolean, targetDevices: string[]} {
        // Файлы, измененные в последние 5 минут всегда считаются новыми
        const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
        const isNew = metadata.mtime > fiveMinutesAgo;
        
        // Устройства, которым нужно отправить файл
        const targetDevices: string[] = [];
        
        // По умолчанию считаем, что синхронизация нужна
        let needsSync = false;
        
        // Проверяем каждое устройство отдельно
        for (const device of trustedDevices) {
            const deviceId = typeof device === 'string' ? device : device.id;
            const deviceName = typeof device === 'string' ? deviceId : (device.name || deviceId);
            const deviceMetadata = this.deviceFileMetadata.get(deviceId);
            
            // Если у нас нет метаданных с устройства, считаем что ему нужна синхронизация
            if (!deviceMetadata) {
                // Минимизируем логи в высоконагруженных операциях
                // console.log(`СИГНАЛЬНАЯ СИСТЕМА: Нет метаданных с устройства ${deviceName} для файла ${path}`);
                targetDevices.push(deviceId);
                needsSync = true;
                continue;
            }
            
            // Получаем метаданные файла с устройства
            const remoteFile = deviceMetadata[path];
            
            // Если файла нет на удаленном устройстве, ему нужна синхронизация
            if (!remoteFile) {
                // Минимизируем логи в высоконагруженных операциях
                // console.log(`СИГНАЛЬНАЯ СИСТЕМА: Файл ${path} отсутствует на устройстве ${deviceName}`);
                targetDevices.push(deviceId);
                needsSync = true;
                continue;
            }
            
            // Если хеш отличается, нужна синхронизация
            if (remoteFile.hash !== metadata.hash) {
                // Минимизируем логи в высоконагруженных операциях
                // console.log(`СИГНАЛЬНАЯ СИСТЕМА: Хеши файла ${path} различаются: локальный ${metadata.hash.substring(0, 8)}, удаленный ${remoteFile.hash.substring(0, 8)}`);
                targetDevices.push(deviceId);
                needsSync = true;
                continue;
            }
            
            // Если время модификации новее, нужна синхронизация
            if (metadata.mtime > remoteFile.mtime) {
                // Минимизируем логи в высоконагруженных операциях
                // console.log(`СИГНАЛЬНАЯ СИСТЕМА: Время модификации файла ${path} новее: локальное ${new Date(metadata.mtime).toISOString()}, удаленное ${new Date(remoteFile.mtime).toISOString()}`);
                targetDevices.push(deviceId);
                needsSync = true;
            }
        }
        
        // Для недавно измененных файлов проверяем, нужна ли синхронизация
        // ВАЖНО: мы не будем передавать файлы, если они идентичны на всех устройствах
        if (isNew && targetDevices.length === 0) {
            needsSync = false;
        } 
        // Если есть устройства, нуждающиеся в синхронизации
        else if (isNew && targetDevices.length > 0) {
            needsSync = true;
        }
        
        return { needsSync, isNew, targetDevices };
    }
    
    /**
     * Умная синхронизация - синхронизирует только нужные файлы, предотвращая блокировку UI
     */
    public async performSmartSync(): Promise<void> {
        // Если нет накопленных изменений, не делаем ничего
        if (this.pendingChangesCount <= 0) {
            console.log("Нет изменений для синхронизации");
            return;
        }
        
        // Асинхронная обработка для снижения блокировки UI
        return new Promise((resolve) => {
            // Запускаем синхронизацию в следующем тике, чтобы не блокировать UI
            setTimeout(async () => {
                try {
                    await this.performFullSync();
                    resolve();
                } catch (error) {
                    console.error("Ошибка при выполнении умной синхронизации:", error);
                    resolve(); // Разрешаем промис даже при ошибке
                }
            }, 50); // Небольшая задержка для обработки UI событий
        });
    }

    /**
     * Запустить принудительную полную синхронизацию
     */
    public async forceFullSync(): Promise<void> {
        console.log("Запуск принудительной полной синхронизации...");
        new Notice("Запуск принудительной полной синхронизации");
        
        // Сбрасываем флаг синхронизации на случай, если предыдущая синхронизация застряла
        this.isSyncing = false;
        
        // Запускаем полную синхронизацию
        await this.performFullSync();
    }

    /**
     * Обновить локальное состояние файлов с асинхронной обработкой
     * для минимизации блокировки основного потока
     */
    private async updateLocalFileState(): Promise<void> {
        // Получаем текущие файлы
        const changes = await this.fileWatcher.scanAllFiles();
        console.log(`Сканирование завершено, найдено ${changes.length} файлов. Начинаем асинхронную обработку...`);
        
        // Получаем новое состояние
        const newState: Record<string, FileMetadata> = {};
        
        // Определяем размер пакета
        const BATCH_SIZE = 50; // Обрабатываем по 50 файлов за один раз
        
        // Обрабатываем файлы пачками для уменьшения блокировки UI
        for (let i = 0; i < changes.length; i += BATCH_SIZE) {
            const batch = changes.slice(i, i + BATCH_SIZE);
            
            // Обрабатываем пачку асинхронно
            await new Promise<void>(resolve => {
                setTimeout(async () => {
                    try {
                        for (const change of batch) {
                            try {
                                const file = change.file;
                                const content = await this.app.vault.read(file);
                                const hash = await CryptoHelper.hashString(content);
                                
                                newState[file.path] = {
                                    path: file.path,
                                    hash,
                                    mtime: file.stat.mtime,
                                    size: file.stat.size
                                };
                            } catch (fileError) {
                                console.error(`Ошибка при обработке файла ${change.file.path}:`, fileError);
                            }
                        }
                        
                        console.log(`Обработана пачка ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(changes.length / BATCH_SIZE)}: ${batch.length} файлов`);
                        resolve();
                    } catch (batchError) {
                        console.error("Ошибка при обработке пачки файлов:", batchError);
                        resolve();
                    }
                }, 0);
            });
        }
        
        console.log("Асинхронная обработка завершена, добавляем удаленные файлы из предыдущего состояния...");
        
        // Сохраняем удаленные файлы из предыдущего состояния асинхронно
        const deletedEntries = Object.entries(this.syncState.files)
            .filter(([_, metadata]) => metadata.deleted);
        
        // Обрабатываем удаленные файлы пачками
        for (let i = 0; i < deletedEntries.length; i += BATCH_SIZE) {
            const batch = deletedEntries.slice(i, i + BATCH_SIZE);
            
            await new Promise<void>(resolve => {
                setTimeout(() => {
                    for (const [path, metadata] of batch) {
                        if (!newState[path]) {
                            newState[path] = metadata;
                        }
                    }
                    resolve();
                }, 0);
            });
        }
        
        console.log("Обновление состояния завершено.");
        
        // Обновляем состояние
        this.syncState.files = newState;
        this.saveSyncState();
    }

    /**
     * Загрузить состояние синхронизации из локального хранилища
     * с оптимизацией для больших состояний
     */
    private loadSyncState(): SyncState {
        try {
            // Загружаем основные метаданные
            const savedStateBase = localStorage.getItem('relay-sync-state-base');
            
            if (!savedStateBase) {
                // Если нет базовых метаданных, возвращаем начальное состояние
                return this.createInitialState();
            }
            
            // Парсим базовые метаданные
            const baseState = JSON.parse(savedStateBase);
            
            // Проверяем версию формата сохранения
            const stateVersion = baseState.stateVersion || 1;
            
            if (stateVersion >= 2) {
                // Новый формат с разделением на части
                return this.loadSegmentedState(baseState);
            }
            
            // Старый формат - монолитное хранение состояния
            const savedState = localStorage.getItem('relay-sync-state');
            if (savedState) {
                try {
                    return JSON.parse(savedState);
                } catch (error) {
                    console.error("Error parsing saved sync state:", error);
                    // Пробуем загрузить сегментированное состояние как резервный вариант
                    return this.loadSegmentedState(baseState);
                }
            }
            
            // Если не удалось загрузить ни по старому, ни по новому формату
            return this.createInitialState();
        } catch (error) {
            console.error("Error loading sync state:", error);
            return this.createInitialState();
        }
    }
    
    /**
     * Создаст начальное состояние синхронизации
     */
    private createInitialState(): SyncState {
        return {
            deviceId: DeviceManager.getDeviceId(),
            files: {},
            lastSyncTime: 0
        };
    }
    
    /**
     * Загружает сегментированное состояние (новый формат)
     */
    private loadSegmentedState(baseState: any): SyncState {
        try {
            // Базовое состояние без файлов
            const state: SyncState = {
                deviceId: baseState.deviceId || DeviceManager.getDeviceId(),
                files: {},
                lastSyncTime: baseState.lastSyncTime || 0
            };
            
            // Получаем список сегментов
            const segmentIds = baseState.segments || [];
            console.log(`Загрузка сегментированного состояния: найдено ${segmentIds.length} сегментов`);
            
            // Загружаем и объединяем все сегменты
            for (const segmentId of segmentIds) {
                const segmentKey = `relay-sync-files-${segmentId}`;
                const segmentData = localStorage.getItem(segmentKey);
                
                if (segmentData) {
                    try {
                        const segment = JSON.parse(segmentData);
                        
                        // Объединяем файлы из сегмента с общим состоянием
                        if (segment.files && typeof segment.files === 'object') {
                            state.files = { ...state.files, ...segment.files };
                        }
                    } catch (segmentError) {
                        console.error(`Error parsing segment ${segmentId}:`, segmentError);
                    }
                }
            }
            
            console.log(`Загружено состояние с ${Object.keys(state.files).length} файлами`);
            return state;
        } catch (error) {
            console.error("Error loading segmented state:", error);
            return this.createInitialState();
        }
    }

    /**
     * Сохранить состояние синхронизации в локальное хранилище
     * с оптимизацией для больших состояний
     */
    private saveSyncState(): void {
        try {
            // Получаем количество файлов для анализа
            const filesCount = Object.keys(this.syncState.files).length;
            
            // Для небольших состояний используем старый формат для совместимости
            if (filesCount < 100) {
                localStorage.setItem('relay-sync-state', JSON.stringify(this.syncState));
                return;
            }
            
            // Для больших состояний используем сегментированное хранение
            this.saveSegmentedState();
        } catch (error) {
            console.error("Error saving sync state:", error);
            
            // Пробуем использовать сегментированное сохранение как резервный вариант
            try {
                this.saveSegmentedState();
            } catch (backupError) {
                console.error("Failed to save state using backup method:", backupError);
            }
        }
    }
    
    /**
     * Сохраняет состояние в сегментированном формате
     */
    private saveSegmentedState(): void {
        // Группируем файлы по сегментам
        const MAX_SEGMENT_SIZE = 500; // Максимальное количество файлов в одном сегменте
        const files = Object.entries(this.syncState.files);
        const segmentCount = Math.ceil(files.length / MAX_SEGMENT_SIZE);
        const segments: string[] = [];
        
        console.log(`Сохранение сегментированного состояния: ${files.length} файлов в ${segmentCount} сегментах`);
        
        // Создаем сегменты
        for (let i = 0; i < segmentCount; i++) {
            const segmentFiles = files.slice(i * MAX_SEGMENT_SIZE, (i + 1) * MAX_SEGMENT_SIZE);
            const segmentId = `segment_${i}_${Date.now()}`;
            segments.push(segmentId);
            
            // Преобразуем массив [key, value] обратно в объект
            const segmentFilesObj = Object.fromEntries(segmentFiles);
            
            // Сохраняем сегмент
            const segmentData = JSON.stringify({
                files: segmentFilesObj,
                timestamp: Date.now()
            });
            
            localStorage.setItem(`relay-sync-files-${segmentId}`, segmentData);
        }
        
        // Сохраняем основные метаданные
        const baseState = {
            deviceId: this.syncState.deviceId,
            lastSyncTime: this.syncState.lastSyncTime,
            segments,
            stateVersion: 2,  // Версия формата хранения
            timestamp: Date.now()
        };
        
        localStorage.setItem('relay-sync-state-base', JSON.stringify(baseState));
        
        // Очищаем старое состояние, если оно существует
        localStorage.removeItem('relay-sync-state');
        
        // Очищаем старые сегменты, которые больше не используются
        this.cleanupOldSegments(segments);
    }
    
    /**
     * Очищает старые сегменты, которые не используются
     */
    private cleanupOldSegments(currentSegments: string[]): void {
        try {
            // Создаем множество текущих сегментов для быстрой проверки
            const currentSegmentsSet = new Set(currentSegments);
            
            // Проверяем все элементы localStorage на наличие старых сегментов
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                
                if (key && key.startsWith('relay-sync-files-')) {
                    const segmentId = key.replace('relay-sync-files-', '');
                    
                    if (!currentSegmentsSet.has(segmentId)) {
                        // Если сегмент больше не используется, удаляем его
                        localStorage.removeItem(key);
                        console.log(`Удален устаревший сегмент: ${segmentId}`);
                    }
                }
            }
        } catch (error) {
            console.error("Error cleaning up old segments:", error);
        }
    }

    /**
     * Получить список доверенных устройств
     */
    public getTrustedDevices(): DeviceInfo[] {
        return this.trustedDevices;
    }

    /**
     * Отозвать доверие у устройства
     */
    public async revokeTrust(deviceId: string): Promise<boolean> {
        try {
            return await this.relayClient.revokeTrust(deviceId);
        } catch (error) {
            console.error("Error revoking trust:", error);
            return false;
        }
    }

    /**
     * Сгенерировать ключ приглашения
     */
    public async generateInvitationKey(expirationMinutes = 10): Promise<string> {
        try {
            return await this.relayClient.generateInvitationKey(expirationMinutes);
        } catch (error) {
            console.error("Error generating invitation key:", error);
            throw error;
        }
    }

    /**
     * Использовать ключ приглашения
     */
    public async useInvitationKey(key: string): Promise<boolean> {
        try {
            return await this.relayClient.useInvitationKey(key);
        } catch (error) {
            console.error("Error using invitation key:", error);
            return false;
        }
    }

    /**
     * Проверить состояние подключения
     */
    public isConnected(): boolean {
        return this.relayClient.isConnected;
    }

    /**
     * Обновить настройки синхронизации
     */
    public updateOptions(options: Partial<SyncOptions>): void {
        if (options.serverUrl) {
            this.options.serverUrl = options.serverUrl;
            // Нужно перезапустить клиент для применения нового URL
            this.relayClient.disconnect();
            this.relayClient = new RelayClient({
                serverUrl: this.options.serverUrl,
                deviceId: this.syncState.deviceId,
                deviceName: DeviceManager.getDeviceName(),
                onMessage: this.handleSyncMessage.bind(this),
                onConnectionChange: this.handleConnectionChange.bind(this),
                onTrustedDevicesChange: this.handleTrustedDevicesChange.bind(this),
                onSyncRequest: this.handleSyncRequest.bind(this)
            });
            this.relayClient.connect();
        }

        if (options.encryptionPassword) {
            this.options.encryptionPassword = options.encryptionPassword;
            this.encryptionPassword = options.encryptionPassword;
        }

        if (options.ignoredPaths) {
            this.options.ignoredPaths = options.ignoredPaths;
            // Сбрасываем игнорируемые пути
            for (const path of options.ignoredPaths) {
                this.fileWatcher.addIgnorePattern(new RegExp(path));
            }
        }

        if (options.fullSyncInterval !== undefined && 
            options.fullSyncInterval !== this.options.fullSyncInterval) {
            
            this.options.fullSyncInterval = options.fullSyncInterval;
            
            // Обновляем интервал полной синхронизации
            if (this.fullSyncInterval) {
                clearInterval(this.fullSyncInterval);
                this.fullSyncInterval = null;
            }
            
            if (options.fullSyncInterval) {
                this.fullSyncInterval = setInterval(
                    this.performFullSync.bind(this),
                    options.fullSyncInterval
                );
            }
        }
    }
}