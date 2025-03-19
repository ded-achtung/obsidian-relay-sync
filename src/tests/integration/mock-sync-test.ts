/**
 * Упрощенный тест синхронизации с использованием моков
 */

import { Notice } from 'obsidian';
import { SyncManager } from '../../client/sync-manager';
import { RelayClient, SyncMessage, DeviceInfo } from '../../client/relay-client';
import { CryptoHelper } from '../../utils/crypto';

/**
 * Мок для WebSocket, который соединяет два клиента напрямую
 */
class MockWebSocketPair {
    client1: MockWebSocket;
    client2: MockWebSocket;
    isOpen = false;
    
    constructor() {
        this.client1 = new MockWebSocket('ws://mock-server/1');
        this.client2 = new MockWebSocket('ws://mock-server/2');
        
        this.client1.pair = this;
        this.client2.pair = this;
        this.client1.otherClient = this.client2;
        this.client2.otherClient = this.client1;
    }
    
    open() {
        this.isOpen = true;
        
        // Эмулируем подключение для обоих клиентов
        setTimeout(() => {
            if (this.client1.onopen) this.client1.onopen();
            if (this.client2.onopen) this.client2.onopen();
        }, 10);
    }
    
    close() {
        this.isOpen = false;
        
        // Эмулируем отключение для обоих клиентов
        if (this.client1.onclose) this.client1.onclose({ code: 1000, reason: 'Closed' });
        if (this.client2.onclose) this.client2.onclose({ code: 1000, reason: 'Closed' });
    }
}

class MockWebSocket {
    url: string;
    pair: MockWebSocketPair | null = null;
    otherClient: MockWebSocket | null = null;
    onopen: (() => void) | null = null;
    onmessage: ((event: any) => void) | null = null;
    onclose: ((event: any) => void) | null = null;
    onerror: ((event: any) => void) | null = null;
    readyState = 0; // 0 = CONNECTING
    
    constructor(url: string) {
        this.url = url;
    }
    
    send(data: string) {
        // Эмулируем передачу сообщения второму клиенту
        if (this.otherClient && this.otherClient.onmessage) {
            setTimeout(() => {
                if (this.otherClient && this.otherClient.onmessage) {
                    this.otherClient.onmessage({ data });
                }
            }, 10);
        }
    }
    
    close() {
        this.readyState = 2; // CLOSING
        
        if (this.pair) {
            this.pair.close();
        } else if (this.onclose) {
            this.onclose({ code: 1000, reason: 'Closed' });
        }
        
        this.readyState = 3; // CLOSED
    }
}

/**
 * Мок для хранилища данных
 */
class MockVault {
    files: Record<string, { content: string, mtime: number }> = {};
    
    async read(file: any) {
        return this.files[file.path]?.content || '';
    }
    
    getAbstractFileByPath(path: string) {
        if (!this.files[path]) return null;
        
        return {
            path,
            stat: {
                size: this.files[path].content.length,
                mtime: this.files[path].mtime,
                ctime: this.files[path].mtime - 5000
            }
        };
    }
    
    async modify(path: string, content: string) {
        this.files[path] = {
            content,
            mtime: Date.now()
        };
    }
    
    async create(path: string, content: string) {
        this.files[path] = {
            content,
            mtime: Date.now()
        };
    }
    
    getFiles() {
        return Object.keys(this.files).map(path => ({
            path,
            stat: {
                size: this.files[path].content.length,
                mtime: this.files[path].mtime,
                ctime: this.files[path].mtime - 5000
            }
        }));
    }
    
    on() {
        return { unsubscribe: () => {} };
    }
    
    adapter = {
        read: async (path: string) => this.files[path]?.content || '',
        write: async (path: string, content: string) => {
            this.files[path] = { content, mtime: Date.now() };
            return true;
        }
    };
}

class MockApp {
    vault: MockVault;
    
    constructor() {
        this.vault = new MockVault();
    }
}

/**
 * Простой клиент для тестов, имитирующий RelayClient
 */
class MockRelayClient {
    wsConnection: MockWebSocketPair | null = null;
    deviceId: string;
    deviceName: string;
    isConnected = false;
    
    // Обработчики событий
    private onMessageCallback: (message: any) => void;
    private onConnectionChangeCallback: (connected: boolean) => void;
    private onTrustedDevicesChangeCallback: (devices: any[]) => void;
    private onSyncRequestCallback: (request: any) => void;
    
    constructor(options: any, deviceId: string) {
        this.deviceId = deviceId;
        this.deviceName = options.deviceName || 'Test Device';
        
        // Сохраняем обработчики
        this.onMessageCallback = options.onMessage;
        this.onConnectionChangeCallback = options.onConnectionChange;
        this.onTrustedDevicesChangeCallback = options.onTrustedDevicesChange;
        this.onSyncRequestCallback = options.onSyncRequest;
    }
    
    // Метод подключения
    connect() {
        console.log(`[TEST] Подключение к мок-серверу (устройство ${this.deviceId})`);
        
        // Создаем веб-сокет соединение
        if (!this.wsConnection) {
            this.wsConnection = new MockWebSocketPair();
        }
        
        const ws = this.deviceId === 'device1' ? 
            this.wsConnection.client1 : 
            this.wsConnection.client2;
        
        // Устанавливаем обработчики событий
        ws.onopen = () => {
            this.isConnected = true;
            this.onConnectionChangeCallback(true);
            
            // Отправляем сообщение об инициализации
            this.onMessageCallback({
                type: 'init_response',
                success: true
            });
            
            // Уведомляем о доверенных устройствах
            this.onTrustedDevicesChangeCallback([]);
        };
        
        ws.onmessage = (event: any) => {
            try {
                const message = JSON.parse(event.data);
                
                // Обработка сообщений
                if (message.type === 'sync_request') {
                    this.onSyncRequestCallback(message);
                } else {
                    this.onMessageCallback(message);
                }
                
                // Если это запрос на синхронизацию файла, имитируем ответ
                if (message.type === 'file_request') {
                    setTimeout(() => {
                        this.onMessageCallback({
                            type: 'file_response',
                            path: message.path,
                            content: 'Encrypted test content', // В реальной ситуации здесь будет зашифрованный контент
                            hash: 'test-hash',
                            sourceDeviceId: this.deviceId === 'device1' ? 'device2' : 'device1'
                        });
                    }, 100);
                }
            } catch (error) {
                console.error('Ошибка при обработке сообщения:', error);
            }
        };
        
        ws.onclose = () => {
            this.isConnected = false;
            this.onConnectionChangeCallback(false);
        };
        
        // Открываем соединение
        this.wsConnection.open();
    }
    
    // Метод отключения
    disconnect() {
        console.log(`[TEST] Отключение от мок-сервера (устройство ${this.deviceId})`);
        
        if (this.wsConnection) {
            this.wsConnection.close();
            this.wsConnection = null;
        }
        
        this.isConnected = false;
        this.onConnectionChangeCallback(false);
    }
    
    // Метод отправки сообщения
    sendMessage(message: any): boolean {
        if (!this.isConnected || !this.wsConnection) {
            console.error('Cannot send message: WebSocket not connected');
            return false;
        }
        
        try {
            // Преобразуем сообщение в строку
            const messageString = JSON.stringify(message);
            
            // Отправляем через соответствующий WebSocket
            const ws = this.deviceId === 'device1' ? 
                this.wsConnection.client1 : 
                this.wsConnection.client2;
                
            ws.send(messageString);
            return true;
        } catch (error) {
            console.error('Ошибка при отправке сообщения:', error);
            return false;
        }
    }
}

/**
 * Простой тест синхронизации с использованием моков
 */
export async function testMockSync(): Promise<boolean> {
    // Функция для логирования
    const log = (message: string) => {
        console.log(`[MOCK-SYNC-TEST] ${message}`);
        return message;
    };
    
    log('Запуск теста синхронизации с использованием моков');
    
    // Создаем фиксированные ID устройств для теста
    const device1Id = 'device1';
    const device2Id = 'device2';
    
    // Создаем моки для устройств
    const app1 = new MockApp();
    const app2 = new MockApp();
    
    // Создаем тестовые файлы
    app1.vault.create('test1.md', '# Test file 1\nContent from device 1');
    app2.vault.create('test2.md', '# Test file 2\nContent from device 2');
    
    log(`Создано тестовых файлов: 1 на устройстве 1, 1 на устройстве 2`);
    
    // Создаем менеджеры синхронизации
    const syncManager1 = new SyncManager(app1 as any, {
        serverUrl: 'ws://mock-server',
        encryptionPassword: 'test-password'
    });
    
    const syncManager2 = new SyncManager(app2 as any, {
        serverUrl: 'ws://mock-server',
        encryptionPassword: 'test-password'
    });
    
    // Заменяем методы для получения ID устройств
    (syncManager1 as any).deviceId = device1Id;
    (syncManager2 as any).deviceId = device2Id;
    
    // Проверяем наличие обработчиков событий в SyncManager
    // и создаем безопасные обертки для них
    const safeCreateHandler = (manager: any, methodName: string) => {
        return function(data: any) {
            if (manager && typeof manager[methodName] === 'function') {
                manager[methodName](data);
            } else {
                console.log(`Метод ${methodName} не найден в SyncManager или недоступен`);
            }
        };
    };
    
    // Заменяем клиентов на наши мок-клиенты
    (syncManager1 as any).relayClient = new MockRelayClient({
        serverUrl: 'ws://mock-server',
        deviceId: device1Id,
        deviceName: 'Test Device 1',
        onMessage: safeCreateHandler(syncManager1, 'handleMessage'),
        onConnectionChange: safeCreateHandler(syncManager1, 'handleConnectionChange'),
        onTrustedDevicesChange: safeCreateHandler(syncManager1, 'handleTrustedDevicesChange'),
        onSyncRequest: safeCreateHandler(syncManager1, 'handleSyncRequest')
    }, device1Id);
    
    (syncManager2 as any).relayClient = new MockRelayClient({
        serverUrl: 'ws://mock-server',
        deviceId: device2Id,
        deviceName: 'Test Device 2',
        onMessage: safeCreateHandler(syncManager2, 'handleMessage'),
        onConnectionChange: safeCreateHandler(syncManager2, 'handleConnectionChange'),
        onTrustedDevicesChange: safeCreateHandler(syncManager2, 'handleTrustedDevicesChange'),
        onSyncRequest: safeCreateHandler(syncManager2, 'handleSyncRequest')
    }, device2Id);
    
    try {
        // Шаг 1: Запускаем оба устройства
        log('Шаг 1: Подключение устройств...');
        await syncManager1.start();
        await syncManager2.start();
        
        // Ждем подключения
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Проверяем статус подключения
        const device1Connected = (syncManager1 as any).relayClient.isConnected;
        const device2Connected = (syncManager2 as any).relayClient.isConnected;
        
        log(`Устройство 1 подключено: ${device1Connected ? 'ДА' : 'НЕТ'}`);
        log(`Устройство 2 подключено: ${device2Connected ? 'ДА' : 'НЕТ'}`);
        
        if (!device1Connected || !device2Connected) {
            log('Ошибка: не удалось подключить устройства');
            return false;
        }
        
        // Шаг 2: Добавляем устройства как доверенные друг для друга
        log('Шаг 2: Добавление устройств как доверенных...');
        
        // Добавляем устройство 2 как доверенное для устройства 1
        (syncManager1 as any).trustedDevices = [{
            id: device2Id,
            name: 'Test Device 2',
            trusted: true,
            lastSeen: new Date().toISOString()
        }];
        
        // Добавляем устройство 1 как доверенное для устройства 2
        (syncManager2 as any).trustedDevices = [{
            id: device1Id,
            name: 'Test Device 1',
            trusted: true,
            lastSeen: new Date().toISOString()
        }];
        
        // Шаг 3: Запускаем синхронизацию
        log('Шаг 3: Запуск синхронизации...');
        
        // Эмулируем ручную синхронизацию (безопасный вызов)
        if (typeof (syncManager1 as any).checkForChanges === 'function') {
            (syncManager1 as any).checkForChanges();
        } else {
            console.log('Метод checkForChanges не найден в syncManager1, пробуем performFullSync');
            if (typeof (syncManager1 as any).performFullSync === 'function') {
                (syncManager1 as any).performFullSync();
            } else {
                console.log('Не найдены методы для синхронизации в syncManager1');
            }
        }
        
        if (typeof (syncManager2 as any).checkForChanges === 'function') {
            (syncManager2 as any).checkForChanges();
        } else {
            console.log('Метод checkForChanges не найден в syncManager2, пробуем performFullSync');
            if (typeof (syncManager2 as any).performFullSync === 'function') {
                (syncManager2 as any).performFullSync();
            } else {
                console.log('Не найдены методы для синхронизации в syncManager2');
            }
        }
        
        // Ждем завершения синхронизации
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Шаг 4: Проверяем, что файлы синхронизировались
        log('Шаг 4: Проверка синхронизации файлов...');
        
        // Проверяем наличие файлов
        const device1Files = Object.keys(app1.vault.files);
        const device2Files = Object.keys(app2.vault.files);
        
        log(`Файлы на устройстве 1: ${device1Files.join(', ')}`);
        log(`Файлы на устройстве 2: ${device2Files.join(', ')}`);
        
        // Проверяем содержимое файлов
        const test1OnDevice2 = await app2.vault.read({ path: 'test1.md' });
        const test2OnDevice1 = await app1.vault.read({ path: 'test2.md' });
        
        log(`Файл test1.md на устройстве 2: "${test1OnDevice2.substring(0, 30)}..."`);
        log(`Файл test2.md на устройстве 1: "${test2OnDevice1.substring(0, 30)}..."`);
        
        // Проверяем результаты
        const device1HasTest2 = device1Files.includes('test2.md') && test2OnDevice1.includes('Content from device 2');
        const device2HasTest1 = device2Files.includes('test1.md') && test1OnDevice2.includes('Content from device 1');
        
        log(`Устройство 1 получило файл устройства 2: ${device1HasTest2 ? 'ДА' : 'НЕТ'}`);
        log(`Устройство 2 получило файл устройства 1: ${device2HasTest1 ? 'ДА' : 'НЕТ'}`);
        
        // Шаг 5: Создаем новый файл на устройстве 1 и проверяем синхронизацию
        log('Шаг 5: Создание нового файла и проверка синхронизации...');
        
        // Создаем новый файл на устройстве 1
        await app1.vault.create('test3.md', '# Test file 3\nNew content from device 1');
        
        // Эмулируем обработку изменения (безопасный вызов)
        if (typeof (syncManager1 as any).handleFileChange === 'function') {
            (syncManager1 as any).handleFileChange({
                path: 'test3.md',
                type: 'create',
                file: app1.vault.getAbstractFileByPath('test3.md')
            });
        } else {
            console.log('Метод handleFileChange не найден в syncManager1, пробуем performFullSync');
            if (typeof (syncManager1 as any).performFullSync === 'function') {
                (syncManager1 as any).performFullSync();
            }
        }
        
        // Ждем синхронизации
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Проверяем, что файл появился на устройстве 2
        const test3OnDevice2 = await app2.vault.read({ path: 'test3.md' });
        
        log(`Файл test3.md на устройстве 2: "${test3OnDevice2.substring(0, 30)}..."`);
        
        const device2HasTest3 = test3OnDevice2.includes('New content from device 1');
        
        log(`Устройство 2 получило новый файл: ${device2HasTest3 ? 'ДА' : 'НЕТ'}`);
        
        // Шаг 6: Останавливаем синхронизацию
        log('Шаг 6: Остановка синхронизации...');
        
        await syncManager1.stop();
        await syncManager2.stop();
        
        // Проверяем общий результат
        const success = device1HasTest2 && device2HasTest1 && device2HasTest3;
        
        log(`Итоговый результат теста: ${success ? 'УСПЕШНО' : 'НЕУДАЧА'}`);
        
        return success;
    } catch (error) {
        log(`Ошибка при выполнении теста: ${error.message}`);
        console.error('Ошибка в тесте синхронизации:', error);
        
        // Останавливаем синхронизацию в случае ошибки
        await syncManager1.stop();
        await syncManager2.stop();
        
        return false;
    }
}

/**
 * Запуск теста синхронизации с моками из Obsidian
 */
export async function runMockSyncTest() {
    try {
        new Notice('Запуск теста синхронизации с моками...');
        console.log('===== ЗАПУСК ТЕСТА СИНХРОНИЗАЦИИ С МОКАМИ =====');
        
        // Запускаем тест
        const success = await testMockSync();
        
        // Выводим результат
        if (success) {
            new Notice('✅ Тест синхронизации с моками успешно пройден!', 10000);
        } else {
            new Notice('❌ Тест синхронизации с моками не пройден. Подробности в консоли разработчика.', 10000);
        }
        
        return success;
    } catch (error) {
        console.error('Критическая ошибка при запуске теста:', error);
        new Notice(`❌ Критическая ошибка при запуске теста: ${error.message}`, 10000);
        return false;
    }
}