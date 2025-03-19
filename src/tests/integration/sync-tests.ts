/**
 * Интеграционные тесты синхронизации для Obsidian Relay Sync
 */

import { SyncManager } from '../../client/sync-manager';
import { CryptoHelper } from '../../utils/crypto';

// Мок для Obsidian API
const mockObsidian = {
    vault: {
        getAbstractFileByPath: (path: string) => {
            // Возвращаем TFile для указанного пути
            if (filesMap[path]) {
                return {
                    path,
                    name: path.split('/').pop() || '',
                    stat: {
                        size: filesMap[path].content.length,
                        mtime: filesMap[path].mtime,
                        ctime: filesMap[path].mtime - 1000
                    }
                };
            }
            return null;
        },
        read: async (file: any) => {
            // Возвращаем содержимое файла
            return filesMap[file.path]?.content || '';
        },
        getFiles: () => {
            // Возвращаем список всех файлов
            return Object.keys(filesMap).map(path => ({
                path,
                name: path.split('/').pop() || '',
                stat: {
                    size: filesMap[path].content.length,
                    mtime: filesMap[path].mtime,
                    ctime: filesMap[path].mtime - 1000
                }
            }));
        },
        on: () => {}, // mock event registration
        adapter: {
            read: async (path: string) => {
                return filesMap[path]?.content || '';
            },
            write: async (path: string, content: string) => {
                if (!filesMap[path]) {
                    filesMap[path] = {
                        content: '',
                        mtime: Date.now()
                    };
                }
                filesMap[path].content = content;
                filesMap[path].mtime = Date.now();
            }
        }
    },
    Notice: (message: string) => console.log('NOTICE:', message)
};

// Мок данные файлов
const filesMap: {
    [path: string]: { content: string; mtime: number; }
} = {
    'test/file1.md': {
        content: '# Test File 1\n\nThis is a test file.',
        mtime: Date.now()
    },
    'test/file2.md': {
        content: '# Test File 2\n\nThis is another test file.',
        mtime: Date.now() - 5000
    },
    'test/notes/note1.md': {
        content: '# Note 1\n\nImportant information.',
        mtime: Date.now() - 10000
    }
};

// Мок для RelayClient
class MockRelayClient {
    isConnected: boolean = false;
    callbacks: Record<string, Function> = {};
    
    constructor(options: any) {
        // Сохраняем обработчики событий
        this.callbacks = {
            onConnect: options.onConnect,
            onDisconnect: options.onDisconnect,
            onMessage: options.onMessage,
            onDeviceConnected: options.onDeviceConnected,
            onDeviceDisconnected: options.onDeviceDisconnected,
            onTrustedDevicesChange: options.onTrustedDevicesChange,
            onSyncRequest: options.onSyncRequest,
            onInvitation: options.onInvitation
        };
    }
    
    connect() {
        this.isConnected = true;
        if (this.callbacks.onConnect) {
            this.callbacks.onConnect();
        }
    }
    
    disconnect() {
        this.isConnected = false;
        if (this.callbacks.onDisconnect) {
            this.callbacks.onDisconnect();
        }
    }
    
    sendMessage(message: any): boolean {
        console.log('Отправка сообщения:', message);
        
        // Имитируем ответ на сообщение
        setTimeout(() => {
            if (message.type === 'sync_request') {
                // Ответ на запрос синхронизации
                if (this.callbacks.onMessage) {
                    this.callbacks.onMessage({
                        type: 'sync_response',
                        success: true,
                        deviceId: 'test-device-2',
                        sourceName: 'Test Device 2'
                    });
                }
            } else if (message.type === 'file_request') {
                // Ответ на запрос файла
                if (this.callbacks.onMessage) {
                    this.callbacks.onMessage({
                        type: 'file_response',
                        path: message.path,
                        content: 'Encrypted content',
                        hash: 'test-hash',
                        sourceDeviceId: 'test-device-2',
                        sourceName: 'Test Device 2'
                    });
                }
            }
        }, 100);
        
        return true;
    }
}

/**
 * Тестирование синхронизации файлов
 */
export async function testSync(): Promise<boolean> {
    console.log('=== ТЕСТИРОВАНИЕ СИНХРОНИЗАЦИИ ФАЙЛОВ ===');
    
    try {
        // Создаём менеджер синхронизации с моками
        const syncManager = new SyncManager(mockObsidian as any, {
            serverUrl: 'ws://localhost:8080/ws',
            encryptionPassword: 'test-password',
            ignoredPaths: ['.obsidian/', '.git/']
        });
        
        // Заменяем RelayClient на мок
        (syncManager as any).relayClient = new MockRelayClient({
            onConnect: (syncManager as any).handleConnect.bind(syncManager),
            onDisconnect: (syncManager as any).handleDisconnect.bind(syncManager),
            onMessage: (syncManager as any).handleMessage.bind(syncManager),
            onDeviceConnected: (syncManager as any).handleDeviceConnected.bind(syncManager),
            onDeviceDisconnected: (syncManager as any).handleDeviceDisconnected.bind(syncManager),
            onTrustedDevicesChange: (syncManager as any).handleTrustedDevicesChange.bind(syncManager),
            onSyncRequest: (syncManager as any).handleSyncRequest.bind(syncManager)
        });
        
        // Тестируем начало синхронизации
        console.log('Запуск синхронизации...');
        await syncManager.start();
        
        // Проверяем статус соединения
        console.log(`Статус соединения: ${(syncManager as any).relayClient.isConnected ? 'ПОДКЛЮЧЕНО' : 'ОТКЛЮЧЕНО'}`);
        
        // Тестируем индексацию файлов
        console.log('Индексация файлов...');
        await (syncManager as any).indexFiles();
        
        // Проверяем индекс файлов
        const syncState = (syncManager as any).syncState;
        const indexedFiles = Object.keys(syncState.files).length;
        console.log(`Индексировано файлов: ${indexedFiles}`);
        console.log(`Ожидаемое количество файлов: ${Object.keys(filesMap).length}`);
        
        // Тестируем синхронизацию изменений
        console.log('Имитация изменения файла...');
        
        // Изменяем файл
        const testFilePath = 'test/file1.md';
        const originalContent = filesMap[testFilePath].content;
        filesMap[testFilePath].content = originalContent + '\n\nUpdated content.';
        filesMap[testFilePath].mtime = Date.now();
        
        // Имитируем событие изменения файла
        await (syncManager as any).handleFileChange({
            path: testFilePath,
            type: 'modify',
            file: mockObsidian.vault.getAbstractFileByPath(testFilePath)
        });
        
        // Проверяем, что файл помечен для синхронизации
        const fileInQueue = (syncManager as any).pendingSyncFiles.has(testFilePath);
        console.log(`Файл добавлен в очередь синхронизации: ${fileInQueue ? 'ДА' : 'НЕТ'}`);
        
        // Тестируем дельта-компрессию
        const fileContent = await mockObsidian.vault.read(
            mockObsidian.vault.getAbstractFileByPath(testFilePath)
        );
        
        const delta = await (syncManager as any).createDelta(originalContent, fileContent);
        console.log(`Создана дельта размером: ${delta.length} байт`);
        console.log(`Размер исходного файла: ${fileContent.length} байт`);
        
        // Тестируем шифрование
        console.log('Тестирование шифрования...');
        const encrypted = await CryptoHelper.encrypt(fileContent, 'test-password');
        console.log(`Данные зашифрованы: ${encrypted ? 'ДА' : 'НЕТ'}`);
        
        // Тестируем дешифрование
        const decrypted = await CryptoHelper.decrypt(encrypted, 'test-password');
        const decryptionSuccess = decrypted === fileContent;
        console.log(`Дешифрование успешно: ${decryptionSuccess ? 'ДА' : 'НЕТ'}`);
        
        // Останавливаем синхронизацию
        await syncManager.stop();
        console.log(`Статус после остановки: ${(syncManager as any).relayClient.isConnected ? 'ПОДКЛЮЧЕНО' : 'ОТКЛЮЧЕНО'}`);
        
        // Общий результат теста
        const syncTestSuccess = 
            indexedFiles === Object.keys(filesMap).length &&
            fileInQueue &&
            decryptionSuccess;
        
        console.log(`Тест синхронизации: ${syncTestSuccess ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН'}`);
        
        return syncTestSuccess;
    } catch (error) {
        console.error('Ошибка при тестировании синхронизации:', error);
        return false;
    }
}