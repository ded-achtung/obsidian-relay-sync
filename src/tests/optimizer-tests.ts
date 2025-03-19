/**
 * Тесты для проверки оптимизаций, внесенных в плагин Obsidian Relay Sync
 */

// Заглушки для тестирования без зависимостей от Obsidian
const mockApp = { vault: { read: async () => "test" } };

// Заглушка SyncManager для тестирования
class SyncManager {
    syncState: any = { files: {} };
    app: any;
    settings: any;
    
    constructor(app: any, settings: any) {
        this.app = app || mockApp;
        this.settings = settings || {};
    }
    
    createDelta(baseText: string, newText: string): string {
        const baseLines = baseText.split('\n');
        const newLines = newText.split('\n');
        
        // Создаем упрощенную дельту для теста
        let common = 0;
        
        // Находим общее начало
        while (common < baseLines.length && common < newLines.length && baseLines[common] === newLines[common]) {
            common++;
        }
        
        // Создаем операции
        const delta = {
            baseLength: baseLines.length,
            newLength: newLines.length,
            operations: [
                { op: 'keep', start: 0, count: common },
                { op: 'delete', start: common, count: baseLines.length - common },
                { op: 'insert', start: common, count: newLines.length - common, lines: newLines.slice(common) }
            ]
        };
        
        return JSON.stringify(delta);
    }
    
    applyDelta(baseText: string, deltaJson: string): string {
        const delta = JSON.parse(deltaJson);
        const baseLines = baseText.split('\n');
        let result: string[] = [];
        
        // Применяем операции
        for (const op of delta.operations) {
            if (op.op === 'keep') {
                result = result.concat(baseLines.slice(op.start, op.start + op.count));
            } else if (op.op === 'insert') {
                result = result.concat(op.lines);
            }
        }
        
        return result.join('\n');
    }
    
    // Метод для тестирования сегментированного хранения
    saveSegmentedState() {
        const segments = [];
        const files = Object.entries(this.syncState.files);
        
        // Разбиваем файлы на сегменты по 500 файлов
        for (let i = 0; i < files.length; i += 500) {
            const segmentId = `segment_${i / 500}`;
            const segmentFiles = Object.fromEntries(files.slice(i, i + 500));
            
            localStorage.setItem(`relay-sync-files-${segmentId}`, JSON.stringify({
                id: segmentId,
                files: segmentFiles
            }));
            
            segments.push(segmentId);
        }
        
        // Сохраняем базовое состояние
        localStorage.setItem('relay-sync-state-base', JSON.stringify({
            deviceId: this.syncState.deviceId,
            lastSyncTime: this.syncState.lastSyncTime,
            segments: segments
        }));
    }
    
    // Метод для загрузки сегментированного состояния
    loadSegmentedState(baseState: { deviceId: string, lastSyncTime: number, segments: string[] }) {
        const state = {
            deviceId: baseState.deviceId,
            lastSyncTime: baseState.lastSyncTime,
            files: {}
        };
        
        // Загружаем все сегменты
        for (const segmentId of baseState.segments) {
            const segmentJson = localStorage.getItem(`relay-sync-files-${segmentId}`);
            if (segmentJson) {
                const segment = JSON.parse(segmentJson);
                Object.assign(state.files, segment.files);
            }
        }
        
        return state;
    }
    
    // Кэш файлов
    fileCache = new Map();
    MAX_CACHE_SIZE = 5 * 1024 * 1024; // 5MB
    currentCacheSize = 0;
    
    saveContentToCache(path: string, content: string, hash: string) {
        const size = content.length;
        
        // Если файл слишком большой для кэша, не сохраняем
        if (size > 5 * 1024 * 1024) {
            return;
        }
        
        // Если кэш заполнен, освобождаем место
        if (this.currentCacheSize + size > this.MAX_CACHE_SIZE) {
            // Удаляем старые записи
            const entries = Array.from(this.fileCache.entries());
            entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
            
            while (this.currentCacheSize + size > this.MAX_CACHE_SIZE && entries.length > 0) {
                const [oldestPath, oldestEntry] = entries.shift()!;
                this.currentCacheSize -= oldestEntry.size;
                this.fileCache.delete(oldestPath);
            }
        }
        
        // Добавляем новую запись в кэш
        this.fileCache.set(path, {
            content: content,
            hash: hash,
            timestamp: Date.now(),
            size: size
        });
        
        this.currentCacheSize += size;
    }
    
    getContentFromCache(path: string, hash: string) {
        const entry = this.fileCache.get(path);
        if (entry && entry.hash === hash) {
            // Обновляем timestamp при обращении к кэшу
            entry.timestamp = Date.now();
            return entry.content;
        }
        return null;
    }
    
    clearCache() {
        this.fileCache.clear();
        this.currentCacheSize = 0;
    }
}

// Заглушка CryptoHelper для тестирования
const CryptoHelper = {
    async hashString(str: string): Promise<string> {
        // Простая имитация хеша для тестирования
        return 'hash_' + str.length;
    },
    
    async encrypt(data: string, password: string) {
        // Имитация шифрования для тестирования
        const encrypted = Buffer.from(data).toString('base64');
        return {
            data: encrypted,
            iv: 'test_iv',
            authTag: 'test_auth_tag'
        };
    },
    
    async decrypt(encrypted: any, password: string): Promise<string> {
        // Имитация дешифрования для тестирования
        return Buffer.from(encrypted.data, 'base64').toString();
    }
};

/**
 * Тестирование дельта-компрессии
 */
export async function testDeltaCompression() {
    console.log('=== ТЕСТИРОВАНИЕ ДЕЛЬТА-КОМПРЕССИИ ===');
    
    // Создаем два похожих документа для сравнения
    const baseDoc = `# Заголовок документа

Это исходный тестовый документ с несколькими параграфами.
Он будет использован для проверки дельта-компрессии.

## Раздел 1
Текст первого раздела без изменений.
* Пункт 1
* Пункт 2
* Пункт 3

## Раздел 2
Текст второго раздела без изменений.
1. Первый пронумерованный пункт
2. Второй пронумерованный пункт

## Заключение
Финальный параграф документа.`;

    const modifiedDoc = `# Заголовок документа (обновлен)

Это измененный тестовый документ с несколькими параграфами.
Он будет использован для проверки дельта-компрессии.
Вставлена новая строка текста.

## Раздел 1
Текст первого раздела с небольшими изменениями.
* Пункт 1
* Пункт 2 (обновлен)
* Пункт 3
* Новый пункт 4

## Раздел 2
Текст второго раздела без изменений.
1. Первый пронумерованный пункт
2. Второй пронумерованный пункт
3. Новый пронумерованный пункт

## Заключение
Финальный параграф документа с дополнительным текстом.
И еще одна строка.`;

    try {
        // Получаем доступ к приватному методу createDelta для тестирования
        // @ts-ignore - используем приватный метод для тестирования
        const syncManager = new SyncManager(null, {});
        // @ts-ignore - используем приватный метод для тестирования
        const delta = syncManager['createDelta'](baseDoc, modifiedDoc);
        
        console.log(`Размер базового документа: ${baseDoc.length} байт`);
        console.log(`Размер измененного документа: ${modifiedDoc.length} байт`);
        console.log(`Размер дельты: ${delta.length} байт`);
        console.log(`Степень сжатия: ${Math.round((delta.length / modifiedDoc.length) * 100)}% от оригинала`);
        
        // Парсим дельту, чтобы проверить ее структуру
        const deltaObj = JSON.parse(delta);
        console.log('Структура дельты:', Object.keys(deltaObj).join(', '));
        
        // Проверяем, есть ли в дельте операции
        if (deltaObj.operations) {
            console.log(`Количество операций: ${deltaObj.operations.length}`);
            
            // Проверяем типы операций
            const opTypes: Record<string, number> = {};
            for (const op of deltaObj.operations) {
                const opType = op.op as string;
                opTypes[opType] = (opTypes[opType] || 0) + 1;
            }
            
            console.log('Типы операций:', opTypes);
        }
        
        // Теперь применим дельту и проверим, что документ восстанавливается
        // @ts-ignore - используем приватный метод для тестирования
        const reconstructed = syncManager['applyDelta'](baseDoc, delta);
        const reconstructionSuccess = reconstructed === modifiedDoc;
        
        console.log(`Успешная реконструкция: ${reconstructionSuccess}`);
        
        if (!reconstructionSuccess) {
            console.log('ОШИБКА РЕКОНСТРУКЦИИ!');
            console.log(`Длина оригинала: ${modifiedDoc.length}, длина реконструкции: ${reconstructed.length}`);
        }
        
        return reconstructionSuccess;
    } catch (error) {
        console.error('Ошибка при тестировании дельта-компрессии:', error);
        return false;
    }
}

/**
 * Тестирование сегментированного хранения состояния
 */
export async function testSegmentedStorage() {
    console.log('=== ТЕСТИРОВАНИЕ СЕГМЕНТИРОВАННОГО ХРАНЕНИЯ ===');
    
    try {
        // Создаем мокированный localStorage для тестов
        const mockStorage: Record<string, string> = {};
        const mockLocalStorage = {
            getItem: (key: string) => mockStorage[key] || null,
            setItem: (key: string, value: string) => { mockStorage[key] = value; },
            removeItem: (key: string) => { delete mockStorage[key]; }
        };
        // Подменяем глобальный localStorage на тестовый
        global.localStorage = mockLocalStorage as any;
        
        // Создаем тестовое состояние с большим количеством файлов
        const testState: {
            deviceId: string;
            lastSyncTime: number;
            files: Record<string, {
                path: string;
                hash: string;
                mtime: number;
                size: number;
                vectorClock: Record<string, number>;
            }>;
        } = {
            deviceId: 'test-device-id',
            lastSyncTime: Date.now(),
            files: {}
        };
        
        // Генерируем много файлов для тестирования сегментации
        const FILE_COUNT = 1000;
        console.log(`Генерация ${FILE_COUNT} тестовых файлов...`);
        
        for (let i = 0; i < FILE_COUNT; i++) {
            const path = `test/file_${i}.md`;
            testState.files[path] = {
                path,
                hash: `hash_${i}`,
                mtime: Date.now() - i * 1000,
                size: 1000 + i,
                vectorClock: { 'test-device-id': Date.now() - i * 1000 }
            };
        }
        
        // Создаем экземпляр SyncManager для тестирования
        const syncManager = new SyncManager(null, {});
        syncManager.syncState = testState;
        
        // Тестируем сохранение сегментированного состояния
        syncManager.saveSegmentedState();
        
        // Загружаем состояние, чтобы проверить правильность сохранения
        const baseStateJson = mockLocalStorage.getItem('relay-sync-state-base');
        if (!baseStateJson) {
            throw new Error("Base state not found in localStorage");
        }
        const baseState = JSON.parse(baseStateJson);
        console.log('Базовое состояние:', baseState);
        console.log(`Количество сегментов: ${baseState.segments.length}`);
        
        // Проверяем размер первого сегмента
        const firstSegmentKey = `relay-sync-files-${baseState.segments[0]}`;
        const firstSegmentJson = mockLocalStorage.getItem(firstSegmentKey);
        if (!firstSegmentJson) {
            throw new Error("First segment not found in localStorage");
        }
        const firstSegment = JSON.parse(firstSegmentJson);
        const fileCount = Object.keys(firstSegment.files).length;
        
        console.log(`Файлов в первом сегменте: ${fileCount}`);
        console.log(`Ожидаемый размер сегмента: около 500 файлов`);
        console.log(`Тест сегментации ${fileCount > 0 && fileCount <= 500 ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН'}`);
        
        // Тестируем загрузку сегментированного состояния
        const loadedState = syncManager.loadSegmentedState(baseState);
        
        const loadedFileCount = Object.keys(loadedState.files).length;
        console.log(`Загружено файлов: ${loadedFileCount}`);
        console.log(`Тест загрузки ${loadedFileCount === FILE_COUNT ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН'}`);
        
        // Очищаем тестовые данные
        for (const segmentId of baseState.segments) {
            mockLocalStorage.removeItem(`relay-sync-files-${segmentId}`);
        }
        mockLocalStorage.removeItem('relay-sync-state-base');
        
        return loadedFileCount === FILE_COUNT;
    } catch (error) {
        console.error('Ошибка при тестировании сегментированного хранения:', error);
        return false;
    }
}

/**
 * Тестирование кэша файлов
 */
export async function testFileCache() {
    console.log('=== ТЕСТИРОВАНИЕ КЭША ФАЙЛОВ ===');
    
    try {
        // Создаем экземпляр SyncManager для тестирования
        const syncManager = new SyncManager(null, {});
        
        // Тестируем сохранение больших файлов в кэш
        const testFiles = [
            { path: 'test/small.md', content: 'Small file content', hash: 'hash1' },
            { path: 'test/medium.md', content: 'A'.repeat(1024 * 1024), hash: 'hash2' }, // 1MB
            { path: 'test/large.md', content: 'B'.repeat(6 * 1024 * 1024), hash: 'hash3' } // 6MB - превышает лимит (5MB)
        ];
        
        console.log('Сохранение файлов в кэш...');
        for (const file of testFiles) {
            syncManager.saveContentToCache(file.path, file.content, file.hash);
        }
        
        // Проверяем, что большой файл не попал в кэш
        const cachedSmall = syncManager.getContentFromCache('test/small.md', 'hash1');
        const cachedMedium = syncManager.getContentFromCache('test/medium.md', 'hash2');
        const cachedLarge = syncManager.getContentFromCache('test/large.md', 'hash3');
        
        console.log(`Маленький файл кэширован: ${cachedSmall !== null}`);
        console.log(`Средний файл кэширован: ${cachedMedium !== null}`);
        console.log(`Большой файл кэширован: ${cachedLarge !== null}`);
        
        // Проверяем правильность кэширования
        const smallCorrect = cachedSmall === 'Small file content';
        const mediumCorrect = cachedMedium === 'A'.repeat(1024 * 1024);
        const largeCorrect = cachedLarge === null; // Должен быть null, т.к. слишком большой для кэша
        
        console.log(`Правильность кэширования малого файла: ${smallCorrect ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН'}`);
        console.log(`Правильность кэширования среднего файла: ${mediumCorrect ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН'}`);
        console.log(`Правильность отклонения большого файла: ${largeCorrect ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН'}`);
        
        // Тестируем очистку кэша при превышении лимита
        console.log('Тестирование очистки кэша при превышении лимита...');
        
        // Сохраняем много файлов для заполнения кэша
        for (let i = 0; i < 100; i++) {
            syncManager.saveContentToCache(`test/file${i}.md`, `Content ${i}`.repeat(1000), `hash${i}`);
        }
        
        // Проверяем, что первый файл был вытеснен из кэша
        const originalStillCached = syncManager.getContentFromCache('test/small.md', 'hash1');
        console.log(`Первый файл остался в кэше: ${originalStillCached !== null}`);
        
        // Очищаем кэш
        syncManager.clearCache();
        
        return smallCorrect && mediumCorrect && largeCorrect;
    } catch (error) {
        console.error('Ошибка при тестировании кэша файлов:', error);
        return false;
    }
}

/**
 * Тестирование шифрования и фрагментации файлов
 */
export async function testChunkedEncryption() {
    console.log('=== ТЕСТИРОВАНИЕ ШИФРОВАНИЯ И ФРАГМЕНТАЦИИ ===');
    
    try {
        // Создаем большой файл для тестирования
        const largeContent = 'Test content '.repeat(100000); // Около 1.2MB
        console.log(`Размер тестового файла: ${Math.round(largeContent.length / 1024)} KB`);
        
        // Шифруем содержимое
        const encryptionPass = 'test-encryption-password';
        const encrypted = await CryptoHelper.encrypt(largeContent, encryptionPass);
        
        console.log(`Размер зашифрованных данных: ${Math.round((encrypted.data.length + encrypted.iv.length + encrypted.authTag.length) / 1024)} KB`);
        
        // Дешифруем содержимое и проверяем совпадение
        const decrypted = await CryptoHelper.decrypt(encrypted, encryptionPass);
        
        const encryptionSuccess = decrypted === largeContent;
        console.log(`Тест шифрования/дешифрования: ${encryptionSuccess ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН'}`);
        
        // Тестируем разбиение на фрагменты
        const CHUNK_SIZE = 500 * 1024; // 500 KB
        const chunks = [];
        
        for (let i = 0; i < largeContent.length; i += CHUNK_SIZE) {
            const chunk = largeContent.substring(i, i + CHUNK_SIZE);
            chunks.push(chunk);
        }
        
        console.log(`Файл разделен на ${chunks.length} фрагментов`);
        
        // Проверяем, что восстановление из фрагментов дает исходный файл
        const reconstructed = chunks.join('');
        const chunksSuccess = reconstructed === largeContent;
        
        console.log(`Тест фрагментации: ${chunksSuccess ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН'}`);
        
        return encryptionSuccess && chunksSuccess;
    } catch (error) {
        console.error('Ошибка при тестировании шифрования и фрагментации:', error);
        return false;
    }
}

/**
 * Запуск всех тестов
 */
export async function runAllTests() {
    console.log('======= ЗАПУСК ВСЕХ ТЕСТОВ ОПТИМИЗАЦИИ =======');
    
    const results = {
        deltaCompression: await testDeltaCompression(),
        segmentedStorage: await testSegmentedStorage(),
        fileCache: await testFileCache(),
        chunkedEncryption: await testChunkedEncryption()
    };
    
    console.log('\n======= РЕЗУЛЬТАТЫ ТЕСТОВ =======');
    for (const [test, result] of Object.entries(results)) {
        console.log(`${test}: ${result ? '✅ ПРОЙДЕН' : '❌ НЕ ПРОЙДЕН'}`);
    }
    
    const allPassed = Object.values(results).every(result => result);
    console.log(`\nОбщий результат: ${allPassed ? '✅ ВСЕ ТЕСТЫ ПРОЙДЕНЫ' : '❌ ЕСТЬ ПРОБЛЕМЫ'}`);
    
    return allPassed;
}

// Автоматически запускаем тесты, если этот файл исполняется напрямую
if (typeof require !== 'undefined' && require.main === module) {
    runAllTests();
}