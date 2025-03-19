/**
 * Интеграционный тест реальной синхронизации между двумя устройствами
 */

import { Notice } from 'obsidian';
import { SyncManager } from '../../client/sync-manager';
import { RelayClient } from '../../client/relay-client';
import { CryptoHelper } from '../../utils/crypto';

// Конфигурация теста
const SERVER_URL = 'ws://176.53.161.220:8080/ws';
const ENCRYPTION_PASSWORD = 'test-encryption-password';
const TEST_FILES_COUNT = 10;
const TEST_FILE_PREFIX = 'sync-test';
const TEST_TIMEOUT_MS = 60000; // 60 секунд максимальное время на тест

// Мок для Obsidian API
class MockVault {
    files: {[path: string]: {content: string, mtime: number}} = {};
    
    constructor(initialFiles?: {[path: string]: string}) {
        // Инициализируем хранилище начальными файлами
        if (initialFiles) {
            Object.entries(initialFiles).forEach(([path, content]) => {
                this.files[path] = {
                    content,
                    mtime: Date.now()
                };
            });
        }
    }
    
    getAbstractFileByPath(path: string) {
        if (!this.files[path]) return null;
        
        return {
            path,
            name: path.split('/').pop() || '',
            stat: {
                size: this.files[path].content.length,
                mtime: this.files[path].mtime,
                ctime: this.files[path].mtime - 1000
            }
        };
    }
    
    async read(file: any) {
        return this.files[file.path]?.content || '';
    }
    
    async write(path: string, content: string) {
        this.files[path] = {
            content,
            mtime: Date.now()
        };
        return true;
    }
    
    async modify(path: string, modifier: (content: string) => string) {
        if (!this.files[path]) return false;
        
        const oldContent = this.files[path].content;
        const newContent = modifier(oldContent);
        
        this.files[path] = {
            content: newContent,
            mtime: Date.now()
        };
        
        return true;
    }
    
    getFiles() {
        return Object.keys(this.files).map(path => ({
            path,
            name: path.split('/').pop() || '',
            stat: {
                size: this.files[path].content.length,
                mtime: this.files[path].mtime,
                ctime: this.files[path].mtime - 1000
            }
        }));
    }
    
    on() {
        // Мок для события
        return { unsubscribe: () => {} };
    }
    
    adapter = {
        getName: () => 'mock-adapter',
        exists: async (path: string) => !!this.files[path],
        read: async (path: string) => this.files[path]?.content || '',
        write: async (path: string, data: string) => {
            this.files[path] = {
                content: data,
                mtime: Date.now()
            };
            return true;
        },
        remove: async (path: string) => {
            delete this.files[path];
            return true;
        }
    };
}

class MockApp {
    vault: MockVault;
    
    constructor(vault: MockVault) {
        this.vault = vault;
    }
}

/**
 * Создает тестовые файлы для устройства
 */
function createTestFiles(deviceId: string): {[path: string]: string} {
    const files: {[path: string]: string} = {};
    
    for (let i = 1; i <= TEST_FILES_COUNT; i++) {
        const path = `${TEST_FILE_PREFIX}/${deviceId}/file${i}.md`;
        files[path] = `# Тестовый файл ${i} от устройства ${deviceId}\n\nЭто тестовый файл для проверки синхронизации.\nИзначальная версия файла.`;
    }
    
    return files;
}

/**
 * Функция ожидания
 */
async function wait(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Тест реальной синхронизации между двумя устройствами
 */
export async function testRealSync(): Promise<boolean> {
    // Метка для записи в консоль
    const log = (message: string) => {
        console.log(`[REAL-SYNC-TEST] ${message}`);
        return message;
    };
    
    // Создаем уникальные ID устройств для теста
    const device1Id = await CryptoHelper.hashString('test-device-1-' + Date.now());
    const device2Id = await CryptoHelper.hashString('test-device-2-' + Date.now());
    
    log(`Тестирование синхронизации между устройствами: ${device1Id.slice(0, 8)}... и ${device2Id.slice(0, 8)}...`);
    
    // Создаем файлы для устройств
    const device1Files = createTestFiles('device1');
    const device2Files = createTestFiles('device2');
    
    // Создаем моки для устройств
    const vault1 = new MockVault(device1Files);
    const vault2 = new MockVault(device2Files);
    
    const app1 = new MockApp(vault1);
    const app2 = new MockApp(vault2);
    
    // Создаем менеджеры синхронизации для устройств
    const syncManager1 = new SyncManager(app1 as any, {
        serverUrl: SERVER_URL,
        encryptionPassword: ENCRYPTION_PASSWORD,
        ignoredPaths: ['.obsidian/', '.git/']
    });
    
    const syncManager2 = new SyncManager(app2 as any, {
        serverUrl: SERVER_URL,
        encryptionPassword: ENCRYPTION_PASSWORD,
        ignoredPaths: ['.obsidian/', '.git/']
    });
    
    // Подменяем ID устройств для тестирования
    (syncManager1 as any).deviceId = device1Id;
    (syncManager2 as any).deviceId = device2Id;
    
    try {
        // Запускаем оба устройства
        log('Запуск синхронизации на устройстве 1...');
        await syncManager1.start();
        
        log('Запуск синхронизации на устройстве 2...');
        await syncManager2.start();
        
        // Ждем установления соединения
        log('Ожидание подключения к серверу...');
        await wait(5000);
        
        // Проверяем статус соединения
        const device1Connected = (syncManager1 as any).relayClient.isConnected;
        const device2Connected = (syncManager2 as any).relayClient.isConnected;
        
        log(`Статус соединения устройства 1: ${device1Connected ? 'ПОДКЛЮЧЕНО' : 'ОТКЛЮЧЕНО'}`);
        log(`Статус соединения устройства 2: ${device2Connected ? 'ПОДКЛЮЧЕНО' : 'ОТКЛЮЧЕНО'}`);
        
        if (!device1Connected || !device2Connected) {
            throw new Error('Не удалось подключиться к серверу');
        }
        
        // Делаем устройства доверенными (с помощью прямого добавления)
        log('Делаем устройства доверенными друг для друга...');
        
        // Добавляем устройство 2 как доверенное для устройства 1
        (syncManager1 as any).trustedDevices.push({
            id: device2Id,
            name: 'Test Device 2',
            trusted: true,
            lastSeen: new Date().toISOString()
        });
        
        // Добавляем устройство 1 как доверенное для устройства 2
        (syncManager2 as any).trustedDevices.push({
            id: device1Id,
            name: 'Test Device 1',
            trusted: true,
            lastSeen: new Date().toISOString()
        });
        
        // Ждем инициализации
        log('Инициализация синхронизации...');
        await wait(3000);
        
        // Проверяем доверенные устройства
        const device1TrustedCount = (syncManager1 as any).trustedDevices?.length || 0;
        const device2TrustedCount = (syncManager2 as any).trustedDevices?.length || 0;
        
        log(`Доверенных устройств у устройства 1: ${device1TrustedCount}`);
        log(`Доверенных устройств у устройства 2: ${device2TrustedCount}`);
        
        // Запускаем полную синхронизацию на обоих устройствах
        log('Запуск полной синхронизации...');
        await (syncManager1 as any).performFullSync();
        await (syncManager2 as any).performFullSync();
        
        // Ждем завершения синхронизации
        log('Ожидание завершения синхронизации...');
        await wait(5000);
        
        // Проверяем состояние файлов после первой синхронизации
        const device1FilesCount = Object.keys(vault1.files).length;
        const device2FilesCount = Object.keys(vault2.files).length;
        
        log(`Количество файлов на устройстве 1: ${device1FilesCount}`);
        log(`Количество файлов на устройстве 2: ${device2FilesCount}`);
        
        // Проверяем, что файлы синхронизировались в обоих направлениях
        const device1HasDevice2Files = Object.keys(vault1.files).some(path => path.includes('/device2/'));
        const device2HasDevice1Files = Object.keys(vault2.files).some(path => path.includes('/device1/'));
        
        log(`Устройство 1 имеет файлы устройства 2: ${device1HasDevice2Files ? 'ДА' : 'НЕТ'}`);
        log(`Устройство 2 имеет файлы устройства 1: ${device2HasDevice1Files ? 'ДА' : 'НЕТ'}`);
        
        // Теперь вносим изменения в файлы на обоих устройствах и проверяем синхронизацию
        log('Изменение файлов на устройстве 1...');
        for (let i = 1; i <= 3; i++) {
            const path = `${TEST_FILE_PREFIX}/device1/file${i}.md`;
            await vault1.modify(path, content => content + `\n\nИзменение #1 на устройстве 1. Метка времени: ${Date.now()}`);
            
            // Имитируем обработку изменения
            (syncManager1 as any).handleFileChange({
                path,
                type: 'modify',
                file: vault1.getAbstractFileByPath(path)
            });
        }
        
        log('Изменение файлов на устройстве 2...');
        for (let i = 1; i <= 3; i++) {
            const path = `${TEST_FILE_PREFIX}/device2/file${i}.md`;
            await vault2.modify(path, content => content + `\n\nИзменение #1 на устройстве 2. Метка времени: ${Date.now()}`);
            
            // Имитируем обработку изменения
            (syncManager2 as any).handleFileChange({
                path,
                type: 'modify',
                file: vault2.getAbstractFileByPath(path)
            });
        }
        
        // Ждем синхронизации
        log('Ожидание синхронизации изменений...');
        await wait(10000);
        
        // Проверяем, что изменения синхронизировались
        log('Проверка синхронизации изменений...');
        
        // Проверяем, что изменения с устройства 1 есть на устройстве 2
        let device1ChangesOnDevice2 = true;
        for (let i = 1; i <= 3; i++) {
            const path = `${TEST_FILE_PREFIX}/device1/file${i}.md`;
            const device2Content = await vault2.read(vault2.getAbstractFileByPath(path));
            if (!device2Content.includes('Изменение #1 на устройстве 1')) {
                device1ChangesOnDevice2 = false;
                break;
            }
        }
        
        // Проверяем, что изменения с устройства 2 есть на устройстве 1
        let device2ChangesOnDevice1 = true;
        for (let i = 1; i <= 3; i++) {
            const path = `${TEST_FILE_PREFIX}/device2/file${i}.md`;
            const device1Content = await vault1.read(vault1.getAbstractFileByPath(path));
            if (!device1Content.includes('Изменение #1 на устройстве 2')) {
                device2ChangesOnDevice1 = false;
                break;
            }
        }
        
        log(`Изменения с устройства 1 есть на устройстве 2: ${device1ChangesOnDevice2 ? 'ДА' : 'НЕТ'}`);
        log(`Изменения с устройства 2 есть на устройстве 1: ${device2ChangesOnDevice1 ? 'ДА' : 'НЕТ'}`);
        
        // Вносим вторую волну изменений для проверки устойчивости
        log('Внесение второй волны изменений...');
        
        // Изменяем файлы на обоих устройствах
        for (let i = 4; i <= 6; i++) {
            const path1 = `${TEST_FILE_PREFIX}/device1/file${i}.md`;
            await vault1.modify(path1, content => content + `\n\nИзменение #2 на устройстве 1. Метка времени: ${Date.now()}`);
            (syncManager1 as any).handleFileChange({
                path: path1,
                type: 'modify',
                file: vault1.getAbstractFileByPath(path1)
            });
            
            const path2 = `${TEST_FILE_PREFIX}/device2/file${i}.md`;
            await vault2.modify(path2, content => content + `\n\nИзменение #2 на устройстве 2. Метка времени: ${Date.now()}`);
            (syncManager2 as any).handleFileChange({
                path: path2,
                type: 'modify',
                file: vault2.getAbstractFileByPath(path2)
            });
        }
        
        // Ждем синхронизации
        log('Ожидание синхронизации второй волны изменений...');
        await wait(10000);
        
        // Проверяем синхронизацию второй волны
        log('Проверка синхронизации второй волны изменений...');
        
        // Проверяем, что вторая волна изменений с устройства 1 есть на устройстве 2
        let device1Changes2OnDevice2 = true;
        for (let i = 4; i <= 6; i++) {
            const path = `${TEST_FILE_PREFIX}/device1/file${i}.md`;
            const device2Content = await vault2.read(vault2.getAbstractFileByPath(path));
            if (!device2Content.includes('Изменение #2 на устройстве 1')) {
                device1Changes2OnDevice2 = false;
                break;
            }
        }
        
        // Проверяем, что вторая волна изменений с устройства 2 есть на устройстве 1
        let device2Changes2OnDevice1 = true;
        for (let i = 4; i <= 6; i++) {
            const path = `${TEST_FILE_PREFIX}/device2/file${i}.md`;
            const device1Content = await vault1.read(vault1.getAbstractFileByPath(path));
            if (!device1Content.includes('Изменение #2 на устройстве 2')) {
                device2Changes2OnDevice1 = false;
                break;
            }
        }
        
        log(`Вторая волна изменений с устройства 1 есть на устройстве 2: ${device1Changes2OnDevice2 ? 'ДА' : 'НЕТ'}`);
        log(`Вторая волна изменений с устройства 2 есть на устройстве 1: ${device2Changes2OnDevice1 ? 'ДА' : 'НЕТ'}`);
        
        // Симулируем конфликты: изменяем один и тот же файл на обоих устройствах
        log('Создание конфликтной ситуации...');
        
        const conflictPath = `${TEST_FILE_PREFIX}/conflict_test.md`;
        
        // Создаем файл на устройстве 1
        await vault1.write(conflictPath, '# Конфликтный файл\n\nЭто файл для проверки разрешения конфликтов.');
        (syncManager1 as any).handleFileChange({
            path: conflictPath,
            type: 'create',
            file: vault1.getAbstractFileByPath(conflictPath)
        });
        
        // Ждем синхронизации
        await wait(5000);
        
        // Изменяем файл на обоих устройствах с разным содержимым
        await vault1.modify(conflictPath, content => content + '\n\nИзменение для конфликта на устройстве 1.');
        (syncManager1 as any).handleFileChange({
            path: conflictPath,
            type: 'modify',
            file: vault1.getAbstractFileByPath(conflictPath)
        });
        
        await vault2.modify(conflictPath, content => content + '\n\nИзменение для конфликта на устройстве 2.');
        (syncManager2 as any).handleFileChange({
            path: conflictPath,
            type: 'modify',
            file: vault2.getAbstractFileByPath(conflictPath)
        });
        
        // Ждем разрешения конфликта
        log('Ожидание разрешения конфликта...');
        await wait(10000);
        
        // Проверяем наличие конфликтных файлов
        const device1Files = Object.keys(vault1.files);
        const device2Files = Object.keys(vault2.files);
        
        const conflictFilesOnDevice1 = device1Files.filter(path => path.includes('conflict') && path.includes('conflicted'));
        const conflictFilesOnDevice2 = device2Files.filter(path => path.includes('conflict') && path.includes('conflicted'));
        
        log(`Обнаружено конфликтных файлов на устройстве 1: ${conflictFilesOnDevice1.length}`);
        log(`Обнаружено конфликтных файлов на устройстве 2: ${conflictFilesOnDevice2.length}`);
        
        // Получаем итоговые результаты теста
        const syncResult = {
            initialSyncSuccess: device1HasDevice2Files && device2HasDevice1Files,
            changesSyncSuccess: device1ChangesOnDevice2 && device2ChangesOnDevice1,
            secondChangesSyncSuccess: device1Changes2OnDevice2 && device2Changes2OnDevice1,
            conflictResolution: conflictFilesOnDevice1.length > 0 || conflictFilesOnDevice2.length > 0
        };
        
        // Останавливаем синхронизацию
        log('Остановка синхронизации...');
        await syncManager1.stop();
        await syncManager2.stop();
        
        // Выводим общий результат
        const success = 
            syncResult.initialSyncSuccess && 
            syncResult.changesSyncSuccess && 
            syncResult.secondChangesSyncSuccess && 
            syncResult.conflictResolution;
        
        log(`Результат теста реальной синхронизации: ${success ? 'УСПЕШНО' : 'ОШИБКА'}`);
        log('Детали теста:');
        log(`- Начальная синхронизация: ${syncResult.initialSyncSuccess ? 'УСПЕШНО' : 'ОШИБКА'}`);
        log(`- Синхронизация первой волны изменений: ${syncResult.changesSyncSuccess ? 'УСПЕШНО' : 'ОШИБКА'}`);
        log(`- Синхронизация второй волны изменений: ${syncResult.secondChangesSyncSuccess ? 'УСПЕШНО' : 'ОШИБКА'}`);
        log(`- Обработка конфликтов: ${syncResult.conflictResolution ? 'УСПЕШНО' : 'ОШИБКА'}`);
        
        return success;
    } catch (error) {
        log(`ОШИБКА: ${error.message}`);
        console.error('Ошибка при тестировании реальной синхронизации:', error);
        
        // Останавливаем синхронизацию в случае ошибки
        await syncManager1.stop();
        await syncManager2.stop();
        
        return false;
    }
}

/**
 * Запуск теста реальной синхронизации из Obsidian
 */
export async function runRealSyncTest() {
    try {
        new Notice('Запуск теста реальной синхронизации...');
        console.log('===== ЗАПУСК ТЕСТА РЕАЛЬНОЙ СИНХРОНИЗАЦИИ =====');
        
        const testTimeout = setTimeout(() => {
            new Notice('❌ Тест прерван по таймауту', 10000);
            console.error('Тест реальной синхронизации прерван по таймауту');
        }, TEST_TIMEOUT_MS);
        
        // Запускаем тест
        const success = await testRealSync();
        
        // Отменяем таймаут
        clearTimeout(testTimeout);
        
        // Выводим результат
        if (success) {
            new Notice('✅ Тест реальной синхронизации успешно пройден!', 10000);
        } else {
            new Notice('❌ Тест реальной синхронизации не пройден. Подробности в консоли разработчика.', 10000);
        }
        
        return success;
    } catch (error) {
        console.error('Критическая ошибка при запуске теста:', error);
        new Notice(`❌ Критическая ошибка при запуске теста: ${error.message}`, 10000);
        return false;
    }
}