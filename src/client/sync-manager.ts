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
                    this.performFullSync.bind(this),
                    this.options.fullSyncInterval
                );
            }
            
            // Запускаем начальную синхронизацию
            console.log("Запуск начальной синхронизации...");
            await this.performFullSync();
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
     */
    private async syncFileWithPeers(
        path: string, 
        content: string, 
        hash: string, 
        mtime: number, 
        isNew: boolean = true,
        specificDevices?: string[],
        requestId?: string
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
                responseToRequestId: requestId
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
            
            // Для больших файлов используем сигнальную систему - сначала отправляем метаданные
            const metadataMessage = {
                path,
                hash,
                mtime,
                size: content.length,
                priority: isNew ? 'high' : 'normal',
                isMarkdown: isMarkdown
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
            
            // Записываем этот файл в локальный кэш для быстрого доступа при запросе
            this.saveContentToCache(path, content, hash);
            
            console.log(`Метаданные файла ${path} отправлены на ${targetDevices.length} устройств. Ожидаем запросы на получение содержимого.`);
            
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
     */
    private createDelta(baseContent: string, newContent: string): string {
        try {
            // Реализация простого алгоритма дельты для текстовых файлов
            // В реальном приложении здесь должен быть более эффективный алгоритм
            
            // Разбиваем текст на строки
            const baseLines = baseContent.split(/\r?\n/);
            const newLines = newContent.split(/\r?\n/);
            
            // Находим общие строки в начале файлов
            let commonStart = 0;
            while (commonStart < baseLines.length && 
                   commonStart < newLines.length && 
                   baseLines[commonStart] === newLines[commonStart]) {
                commonStart++;
            }
            
            // Находим общие строки в конце файлов
            let commonEnd = 0;
            while (commonEnd < baseLines.length - commonStart && 
                   commonEnd < newLines.length - commonStart && 
                   baseLines[baseLines.length - 1 - commonEnd] === newLines[newLines.length - 1 - commonEnd]) {
                commonEnd++;
            }
            
            // Извлекаем измененную часть
            const baseMiddle = baseLines.slice(commonStart, baseLines.length - commonEnd);
            const newMiddle = newLines.slice(commonStart, newLines.length - commonEnd);
            
            // Создаем дельту в формате JSON
            const delta = JSON.stringify({
                commonStart,
                commonEnd,
                baseMiddleLength: baseMiddle.length,
                newMiddle: newMiddle.join('\n')
            });
            
            return delta;
        } catch (error) {
            console.error("Ошибка при создании дельты:", error);
            return newContent; // В случае ошибки возвращаем полное содержимое
        }
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
     */
    private applyDelta(baseContent: string, delta: string): string {
        try {
            // Парсим дельту
            const deltaObj = JSON.parse(delta);
            
            // Разбиваем базовый контент на строки
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
            const newContent = [...startPart, ...newMiddle, ...endPart].join('\n');
            
            return newContent;
        } catch (error) {
            console.error("Ошибка при применении дельты:", error);
            throw new Error("Не удалось применить дельту к файлу");
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
     * Сохранить содержимое файла в кэш
     */
    private fileContentCache: Map<string, {content: string, hash: string, timestamp: number}> = new Map();
    
    private saveContentToCache(path: string, content: string, hash: string): void {
        // Ограничиваем размер кэша
        if (this.fileContentCache.size > 100) {
            // Удаляем самые старые записи
            const oldestEntries = Array.from(this.fileContentCache.entries())
                .sort((a, b) => a[1].timestamp - b[1].timestamp)
                .slice(0, 20);
                
            for (const [oldPath] of oldestEntries) {
                this.fileContentCache.delete(oldPath);
            }
        }
        
        // Сохраняем содержимое в кэш
        this.fileContentCache.set(path, {
            content,
            hash,
            timestamp: Date.now()
        });
    }
    
    /**
     * Получить содержимое файла из кэша
     */
    private getContentFromCache(path: string, hash: string): string | null {
        const cached = this.fileContentCache.get(path);
        if (cached && cached.hash === hash) {
            return cached.content;
        }
        return null;
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
                this.relayClient.sendMessage({
                    type: 'message',
                    targetDeviceId: message.sourceDeviceId,
                    payload: {
                        action: 'devicePingResponse',
                        pingId: message.payload.pingId
                    }
                });
                
                // Если мы в режиме ожидания и получили пинг от доверенного устройства, 
                // это значит, что есть активные устройства - проверяем и выходим из режима ожидания
                if (this.waitingMode && this.relayClient.isDeviceTrusted(message.sourceDeviceId || '')) {
                    console.log("Получен пинг от доверенного устройства. Выходим из режима ожидания.");
                    this.waitingMode = false;
                    
                    // Если есть накопленные изменения, запускаем синхронизацию
                    if (this.pendingChangesCount > 0) {
                        console.log(`Есть ${this.pendingChangesCount} накопленных изменений. Запускаем синхронизацию.`);
                        setTimeout(() => this.performFullSync(), 1000);
                    }
                }
                
                return;
            }
            
            // Обработка ответа на пинг устройства через тип 'message' (обрабатывается в checkActiveTrustedDevices)
            if (message.type === 'message' && message.payload && message.payload.action === 'devicePingResponse') {
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
            
            // Проверяем, нужен ли нам этот файл
            const needFile = await this.checkIfFileNeeded(path, payload.hash, payload.mtime);
            
            if (needFile) {
                // Запрашиваем файл от отправителя
                console.log(`Запрашиваем файл ${path} от устройства ${message.sourceDeviceId}`);
                
                this.relayClient.sendMessage({
                    type: 'requestFile',
                    targetDeviceId: message.sourceDeviceId,
                    requestId: Date.now().toString() + '-' + Math.random().toString(36).substr(2, 5),
                    payload: {
                        path,
                        hash: payload.hash
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
     */
    private async checkIfFileNeeded(path: string, hash: string, remoteMtime: number): Promise<boolean> {
        // Получаем локальный файл
        const file = this.app.vault.getAbstractFileByPath(path);
        
        // Если файла нет локально, он нам нужен
        if (!(file instanceof TFile)) {
            return true;
        }
        
        // Проверяем локальные метаданные
        const localMetadata = this.syncState.files[path];
        
        // Если нет локальных метаданных, но файл существует, нужно сверить хеш
        if (!localMetadata) {
            const content = await this.app.vault.read(file);
            const localHash = await CryptoHelper.hashString(content);
            return localHash !== hash;
        }
        
        // Если хеши различаются, нужно сравнить актуальность версий
        if (localMetadata.hash !== hash) {
            // Если локальная версия файла новее удаленной, не запрашиваем удаленную
            // Это важно, чтобы недавние редактирования не перезаписывались старыми версиями
            if (localMetadata.mtime > remoteMtime) {
                console.log(`КОНФЛИКТ ВЕРСИЙ: Локальная версия файла ${path} новее (${new Date(localMetadata.mtime).toISOString()}) чем удаленная (${new Date(remoteMtime).toISOString()}). Сохраняем локальную версию.`);
                
                // В будущем здесь может быть логика разрешения конфликтов
                // Но пока просто не запрашиваем файл, сохраняя более новую локальную версию
                return false;
            }
            
            // Если удаленная версия новее, запрашиваем ее
            console.log(`Удаленная версия файла ${path} новее (${new Date(remoteMtime).toISOString()}) чем локальная (${new Date(localMetadata.mtime).toISOString()}). Запрашиваем обновление.`);
            return true;
        }
        
        // Если хеши совпадают, файл не нужно синхронизировать
        return false;
    }
    
    /**
     * Обработчик запроса на получение файла
     */
    private async handleFileRequest(path: string, sourceDeviceId: string, requestId?: string): Promise<void> {
        try {
            console.log(`Обработка запроса на получение файла ${path}...`);
            
            // Получаем файл из хранилища
            const file = this.app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) {
                console.log(`Файл ${path} не найден или не является файлом`);
                return;
            }
            
            // Читаем содержимое файла
            const content = await this.app.vault.read(file);
            
            // Вычисляем хеш содержимого
            const hash = await CryptoHelper.hashString(content);
            
            // Отправляем файл запрашивающему устройству
            await this.syncFileWithPeers(path, content, hash, file.stat.mtime, true, [sourceDeviceId], requestId);
            
            console.log(`Файл ${path} отправлен устройству ${sourceDeviceId} по запросу`);
        } catch (error) {
            console.error(`Ошибка при обработке запроса на получение файла ${path}:`, error);
        }
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

            // Проверяем, есть ли у нас уже такая версия файла
            const existingFile = this.syncState.files[path];
            if (existingFile && existingFile.hash === hash) {
                console.log(`Пропуск файла ${path}: у нас уже есть актуальная версия`);
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

            // Обновляем состояние синхронизации
            this.syncState.files[path] = {
                path,
                hash,
                mtime,
                size: finalContent.length
            };

            console.log(`Файл синхронизирован: ${path} (${finalContent.length} байт)`);
        } catch (error) {
            console.error(`Ошибка обработки сообщения синхронизации для файла ${path}:`, error);
            new Notice(`Ошибка синхронизации файла ${path}: ${error.message}`);
        }
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
                return;
            }
            
            // Получаем текущие доверенные устройства от RelayClient
            const trustedDevices = this.relayClient.getTrustedDevices();
            
            // Безопасная проверка доверенных устройств
            const hasTrustedDevices = Array.isArray(trustedDevices) && trustedDevices.length > 0;
            
            if (this.isSyncing) {
                console.log("Синхронизация пропущена: уже выполняется синхронизация");
                return;
            }
            
            // Если мы в режиме ожидания или нет доверенных устройств - проверяем наличие активных устройств
            if (this.waitingMode || !hasTrustedDevices) {
                console.log(`${this.waitingMode ? 'Плагин в режиме ожидания' : 'Нет доверенных устройств'}. Проверка активности...`);
                
                // Проверяем наличие активных устройств
                await this.checkActiveTrustedDevices();
                
                // Если после проверки все еще в режиме ожидания, прекращаем синхронизацию
                if (this.waitingMode) {
                    console.log("После проверки по-прежнему нет активных устройств. Синхронизация отложена.");
                    
                    // Обновляем локальное состояние на всякий случай
                    await this.updateLocalFileState();
                    return;
                }
                
                // Проверяем заново после перехода в активный режим
                const updatedTrustedDevices = this.relayClient.getTrustedDevices();
                if (!Array.isArray(updatedTrustedDevices) || updatedTrustedDevices.length === 0) {
                    console.log("После проверки все еще нет доверенных устройств. Синхронизация отложена.");
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

            // Сканируем наши файлы
            const fileEntries = Object.entries(this.syncState.files);
            console.log(`Анализ ${fileEntries.length} файлов для интеллектуальной синхронизации...`);
            
            // Классифицируем файлы
            const filesForSync: {path: string, metadata: FileMetadata, isNew: boolean, targetDevices: string[]}[] = [];
            let unchangedFiles = 0;
            let identicalFiles = 0;

            console.log("СИГНАЛЬНАЯ СИСТЕМА: Проверка метаданных файлов для интеллектуальной синхронизации");
            
            // Проверяем каждый файл на необходимость синхронизации
            for (const [path, metadata] of fileEntries) {
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
                    identicalFiles++;
                } else {
                    console.log(`СИГНАЛЬНАЯ СИСТЕМА: Файл '${path}' не требует синхронизации`);
                    unchangedFiles++;
                }
            }
            
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
                console.log(`СИГНАЛЬНАЯ СИСТЕМА: Нет метаданных с устройства ${deviceName} для файла ${path}`);
                targetDevices.push(deviceId);
                needsSync = true;
                continue;
            }
            
            // Получаем метаданные файла с устройства
            const remoteFile = deviceMetadata[path];
            
            // Если файла нет на удаленном устройстве, ему нужна синхронизация
            if (!remoteFile) {
                console.log(`СИГНАЛЬНАЯ СИСТЕМА: Файл ${path} отсутствует на устройстве ${deviceName}`);
                targetDevices.push(deviceId);
                needsSync = true;
                continue;
            }
            
            // Если хеш отличается, нужна синхронизация
            if (remoteFile.hash !== metadata.hash) {
                console.log(`СИГНАЛЬНАЯ СИСТЕМА: Хеши файла ${path} различаются: локальный ${metadata.hash.substring(0, 8)}, удаленный ${remoteFile.hash.substring(0, 8)}`);
                targetDevices.push(deviceId);
                needsSync = true;
                continue;
            }
            
            // Если время модификации новее, нужна синхронизация
            if (metadata.mtime > remoteFile.mtime) {
                console.log(`СИГНАЛЬНАЯ СИСТЕМА: Время модификации файла ${path} новее: локальное ${new Date(metadata.mtime).toISOString()}, удаленное ${new Date(remoteFile.mtime).toISOString()}`);
                targetDevices.push(deviceId);
                needsSync = true;
            } else {
                console.log(`СИГНАЛЬНАЯ СИСТЕМА: Файл ${path} идентичен на устройстве ${deviceName}`);
            }
        }
        
        // Для недавно измененных файлов проверяем, нужна ли синхронизация
        // ВАЖНО: мы не будем передавать файлы, если они идентичны на всех устройствах
        if (isNew && targetDevices.length === 0) {
            // Добавляем более подробное логирование
            console.log(`Файл ${path} недавно изменен, но метаданные идентичны на всех устройствах - синхронизация не требуется`);
            needsSync = false;
        } 
        // Если есть устройства, нуждающиеся в синхронизации
        else if (isNew && targetDevices.length > 0) {
            console.log(`Файл ${path} недавно изменен, будет синхронизирован с ${targetDevices.length} устройствами`);
            needsSync = true;
        }
        
        return { needsSync, isNew, targetDevices };
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
     * Обновить локальное состояние файлов
     */
    private async updateLocalFileState(): Promise<void> {
        // Получаем текущие файлы
        const changes = await this.fileWatcher.scanAllFiles();
        
        // Получаем новое состояние
        const newState: Record<string, FileMetadata> = {};
        
        // Обрабатываем каждый файл
        for (const change of changes) {
            const file = change.file;
            const content = await this.app.vault.read(file);
            const hash = await CryptoHelper.hashString(content);
            
            newState[file.path] = {
                path: file.path,
                hash,
                mtime: file.stat.mtime,
                size: file.stat.size
            };
        }
        
        // Сохраняем удаленные файлы из предыдущего состояния
        for (const [path, metadata] of Object.entries(this.syncState.files)) {
            if (metadata.deleted && !newState[path]) {
                newState[path] = metadata;
            }
        }
        
        // Обновляем состояние
        this.syncState.files = newState;
        this.saveSyncState();
    }

    /**
     * Загрузить состояние синхронизации из локального хранилища
     */
    private loadSyncState(): SyncState {
        const savedState = localStorage.getItem('relay-sync-state');
        
        if (savedState) {
            try {
                return JSON.parse(savedState);
            } catch (error) {
                console.error("Error parsing saved sync state:", error);
            }
        }
        
        // Возвращаем начальное состояние, если сохраненное отсутствует или повреждено
        return {
            deviceId: DeviceManager.getDeviceId(),
            files: {},
            lastSyncTime: 0
        };
    }

    /**
     * Сохранить состояние синхронизации в локальное хранилище
     */
    private saveSyncState(): void {
        localStorage.setItem('relay-sync-state', JSON.stringify(this.syncState));
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