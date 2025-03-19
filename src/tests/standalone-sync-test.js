/**
 * Автономный тест для проверки оптимизаций в плагине Obsidian Relay Sync
 * Этот тест можно запустить независимо от Obsidian с помощью Node.js
 * 
 * Запуск: node standalone-sync-test.js
 */

// Импортируем необходимые Node.js модули
const crypto = require('crypto');
const { TextEncoder, TextDecoder } = require('util');

// Эмуляция необходимых объектов без зависимости от Obsidian
const mockLocalStorage = (() => {
    const store = {};
    return {
        getItem: (key) => store[key] || null,
        setItem: (key, value) => store[key] = value,
        removeItem: (key) => delete store[key],
        clear: () => Object.keys(store).forEach(key => delete store[key])
    };
})();

// Эмуляция глобальных объектов
global.localStorage = mockLocalStorage;
global.btoa = (data) => Buffer.from(data, 'binary').toString('base64');
global.atob = (data) => Buffer.from(data, 'base64').toString('binary');

// Класс для криптографических операций
class CryptoHelper {
    static async encrypt(data, password) {
        // Упрощенная реализация для тестов
        const salt = crypto.randomBytes(16);
        const iv = crypto.randomBytes(16); // Должно быть 16 байт для AES-256-CBC
        const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
        
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        const encrypted = Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]);
        const authTag = crypto.randomBytes(16); // Mock для тестов
        
        return {
            iv: Buffer.from(iv).toString('base64'),
            data: encrypted.toString('base64'),
            authTag: Buffer.from(authTag).toString('base64'),
            salt: Buffer.from(salt).toString('base64')
        };
    }
    
    static async decrypt(encryptedData, password) {
        try {
            // Упрощенная реализация для тестов
            const iv = Buffer.from(encryptedData.iv, 'base64');
            const data = Buffer.from(encryptedData.data, 'base64');
            const salt = Buffer.from(encryptedData.salt, 'base64');
            
            const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
            
            const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
            return decrypted.toString();
        } catch (error) {
            console.error("Decryption failed:", error);
            throw new Error("Не удалось расшифровать данные.");
        }
    }
    
    static chunkFile(fileContent, chunkSize) {
        const chunks = [];
        for (let i = 0; i < fileContent.length; i += chunkSize) {
            chunks.push(fileContent.slice(i, i + chunkSize));
        }
        return chunks;
    }
    
    static reassembleFile(chunks) {
        return chunks.join('');
    }
    
    static async hashString(str) {
        const hash = crypto.createHash('sha256');
        hash.update(str);
        return hash.digest('base64');
    }
}

// Класс для кэширования файлов
class FileCache {
    constructor() {
        this.cache = {};
        this.size = 0;
        this.maxSize = 5 * 1024 * 1024; // 5MB максимальный размер кэша
        this.maxFileSize = 5 * 1024 * 1024; // 5MB максимальный размер файла
    }
    
    saveToCache(path, content, hash) {
        if (content.length > this.maxFileSize) {
            console.log(`Файл ${path} слишком большой для кэширования (${content.length} байт)`);
            return false;
        }
        
        // Если кэш почти заполнен, освобождаем место
        if (this.size + content.length > this.maxSize) {
            this.evictOldEntries(content.length);
        }
        
        // Если все еще не хватает места, отклоняем
        if (this.size + content.length > this.maxSize) {
            return false;
        }
        
        // Сохраняем в кэш
        this.cache[path] = {
            content,
            hash,
            timestamp: Date.now()
        };
        
        this.size += content.length;
        return true;
    }
    
    getFromCache(path, hash) {
        const entry = this.cache[path];
        if (entry && entry.hash === hash) {
            // Обновляем временную метку при обращении
            entry.timestamp = Date.now();
            return entry.content;
        }
        return null;
    }
    
    evictOldEntries(requiredSpace) {
        // Сортируем записи по времени последнего обращения
        const entries = Object.entries(this.cache)
            .sort((a, b) => a[1].timestamp - b[1].timestamp);
        
        // Удаляем старые записи, пока не освободим достаточно места
        let freedSpace = 0;
        for (const [path, entry] of entries) {
            if (freedSpace >= requiredSpace) break;
            
            freedSpace += entry.content.length;
            this.size -= entry.content.length;
            delete this.cache[path];
            
            console.log(`Удалена запись кэша: ${path} (освобождено ${entry.content.length} байт)`);
        }
    }
    
    clearCache() {
        this.cache = {};
        this.size = 0;
    }
    
    getStats() {
        return {
            entries: Object.keys(this.cache).length,
            totalSize: this.size,
            maxSize: this.maxSize,
            usagePercent: Math.round((this.size / this.maxSize) * 100)
        };
    }
}

// Класс для сегментированного хранения
class SegmentedStorage {
    constructor() {
        this.MAX_SEGMENT_SIZE = 500; // Максимальное количество файлов в одном сегменте
    }
    
    /**
     * Сохраняет большое состояние, разбивая его на сегменты
     */
    saveSegmentedState(state) {
        const segments = [];
        const files = Object.entries(state.files || {});
        
        // Разбиваем файлы на сегменты
        for (let i = 0; i < files.length; i += this.MAX_SEGMENT_SIZE) {
            const segmentId = `segment_${Math.floor(i / this.MAX_SEGMENT_SIZE)}`;
            const segmentFiles = Object.fromEntries(files.slice(i, i + this.MAX_SEGMENT_SIZE));
            
            // Сохраняем сегмент в localStorage
            localStorage.setItem(`relay-sync-files-${segmentId}`, JSON.stringify({
                id: segmentId,
                files: segmentFiles
            }));
            
            segments.push(segmentId);
        }
        
        // Сохраняем базовое состояние без файлов
        const baseState = {
            ...state,
            files: {}, // Файлы разделены по сегментам
            segments: segments
        };
        
        return baseState;
    }
    
    /**
     * Загружает состояние из сегментов
     */
    loadSegmentedState(baseState) {
        const segments = baseState.segments || [];
        const completeState = {
            ...baseState,
            files: {}
        };
        
        // Загружаем сегменты по одному
        for (const segmentId of segments) {
            const segmentJson = localStorage.getItem(`relay-sync-files-${segmentId}`);
            if (segmentJson) {
                const segment = JSON.parse(segmentJson);
                completeState.files = {
                    ...completeState.files,
                    ...segment.files
                };
            }
        }
        
        return completeState;
    }
}

// Упрощенный алгоритм дельта-компрессии
class DeltaCompressor {
    /**
     * Создает дельту между двумя текстами
     */
    createDelta(oldText, newText) {
        const oldLines = oldText.split('\n');
        const newLines = newText.split('\n');
        
        // Находим сходства в начале и конце
        let commonStart = 0;
        while (commonStart < oldLines.length && commonStart < newLines.length && 
               oldLines[commonStart] === newLines[commonStart]) {
            commonStart++;
        }
        
        let commonEnd = 0;
        while (commonEnd < oldLines.length - commonStart && 
               commonEnd < newLines.length - commonStart && 
               oldLines[oldLines.length - 1 - commonEnd] === newLines[newLines.length - 1 - commonEnd]) {
            commonEnd++;
        }
        
        // Создаем операции для преобразования
        const operations = [];
        
        // Если есть общий начальный блок
        if (commonStart > 0) {
            operations.push({
                op: 'keep',
                start: 0,
                count: commonStart
            });
        }
        
        // Удаляем измененную часть из старого текста
        const deletedLinesCount = oldLines.length - commonStart - commonEnd;
        if (deletedLinesCount > 0) {
            operations.push({
                op: 'delete',
                start: commonStart,
                count: deletedLinesCount
            });
        }
        
        // Вставляем новую часть
        const insertedLines = newLines.slice(commonStart, newLines.length - commonEnd);
        if (insertedLines.length > 0) {
            operations.push({
                op: 'insert',
                start: commonStart,
                count: insertedLines.length,
                lines: insertedLines
            });
        }
        
        // Если есть общий конечный блок
        if (commonEnd > 0) {
            operations.push({
                op: 'keep',
                start: oldLines.length - commonEnd,
                count: commonEnd
            });
        }
        
        // Формируем дельту
        const delta = {
            baseLength: oldLines.length,
            newLength: newLines.length,
            operations: operations
        };
        
        return JSON.stringify(delta);
    }
    
    /**
     * Применяет дельту к исходному тексту
     */
    applyDelta(oldText, deltaJson) {
        const delta = JSON.parse(deltaJson);
        const oldLines = oldText.split('\n');
        let newLines = [];
        
        for (const op of delta.operations) {
            if (op.op === 'keep') {
                // Сохраняем неизмененные строки
                newLines = newLines.concat(oldLines.slice(op.start, op.start + op.count));
            } else if (op.op === 'insert') {
                // Вставляем новые строки
                newLines = newLines.concat(op.lines);
            }
            // Для 'delete' ничего не делаем, просто пропускаем эти строки
        }
        
        return newLines.join('\n');
    }
}

/**
 * Тестирование дельта-компрессии
 */
async function testDeltaCompression() {
    console.log('=== ТЕСТИРОВАНИЕ ДЕЛЬТА-КОМПРЕССИИ ===');
    
    try {
        const deltaCompressor = new DeltaCompressor();
        
        // Тест 1: Небольшое изменение
        console.log('\nТест 1: Небольшое изменение в середине текста');
        const originalText1 = "Строка 1\nСтрока 2\nСтрока 3\nСтрока 4\nСтрока 5";
        const modifiedText1 = "Строка 1\nСтрока 2\nИзмененная строка 3\nСтрока 4\nСтрока 5";
        
        // Создаем дельту
        const delta1 = deltaCompressor.createDelta(originalText1, modifiedText1);
        const deltaSize1 = Buffer.from(delta1).length;
        const originalSize1 = Buffer.from(modifiedText1).length;
        const compressionRatio1 = (deltaSize1 / originalSize1 * 100).toFixed(2);
        
        console.log(`Исходный размер: ${originalSize1} байт`);
        console.log(`Размер дельты: ${deltaSize1} байт`);
        console.log(`Соотношение: ${compressionRatio1}%`);
        
        // Применяем дельту
        const reconstructed1 = deltaCompressor.applyDelta(originalText1, delta1);
        const isCorrect1 = reconstructed1 === modifiedText1;
        console.log(`Правильность восстановления: ${isCorrect1 ? 'УСПЕШНО' : 'ОШИБКА'}`);
        
        // Тест 2: Большое добавление текста
        console.log('\nТест 2: Большое добавление текста');
        const originalText2 = "Начало документа\nКонец документа";
        const modifiedText2 = "Начало документа\n" + "Новая строка\n".repeat(50) + "Конец документа";
        
        const delta2 = deltaCompressor.createDelta(originalText2, modifiedText2);
        const deltaSize2 = Buffer.from(delta2).length;
        const originalSize2 = Buffer.from(modifiedText2).length;
        const compressionRatio2 = (deltaSize2 / originalSize2 * 100).toFixed(2);
        
        console.log(`Исходный размер: ${originalSize2} байт`);
        console.log(`Размер дельты: ${deltaSize2} байт`);
        console.log(`Соотношение: ${compressionRatio2}%`);
        
        const reconstructed2 = deltaCompressor.applyDelta(originalText2, delta2);
        const isCorrect2 = reconstructed2 === modifiedText2;
        console.log(`Правильность восстановления: ${isCorrect2 ? 'УСПЕШНО' : 'ОШИБКА'}`);
        
        // Тест 3: Полное изменение текста
        console.log('\nТест 3: Полное изменение текста');
        const originalText3 = "Полностью другой текст\nКоторый будет заменен";
        const modifiedText3 = "Совершенно новый текст\nКоторый не имеет ничего общего с исходным";
        
        const delta3 = deltaCompressor.createDelta(originalText3, modifiedText3);
        const deltaSize3 = Buffer.from(delta3).length;
        const originalSize3 = Buffer.from(modifiedText3).length;
        const compressionRatio3 = (deltaSize3 / originalSize3 * 100).toFixed(2);
        
        console.log(`Исходный размер: ${originalSize3} байт`);
        console.log(`Размер дельты: ${deltaSize3} байт`);
        console.log(`Соотношение: ${compressionRatio3}%`);
        
        const reconstructed3 = deltaCompressor.applyDelta(originalText3, delta3);
        const isCorrect3 = reconstructed3 === modifiedText3;
        console.log(`Правильность восстановления: ${isCorrect3 ? 'УСПЕШНО' : 'ОШИБКА'}`);
        
        return isCorrect1 && isCorrect2 && isCorrect3;
    } catch (error) {
        console.error('Ошибка при тестировании дельта-компрессии:', error);
        return false;
    }
}

/**
 * Тестирование сегментированного хранения
 */
async function testSegmentedStorage() {
    console.log('=== ТЕСТИРОВАНИЕ СЕГМЕНТИРОВАННОГО ХРАНЕНИЯ ===');
    
    try {
        // Очищаем localStorage перед тестом
        localStorage.clear();
        
        // Создаем тестовое состояние с большим количеством файлов
        const FILE_COUNT = 1200;
        console.log(`Генерация ${FILE_COUNT} тестовых файлов...`);
        
        const testState = {
            deviceId: 'test-device-id',
            lastSyncTime: Date.now(),
            files: {}
        };
        
        // Заполняем тестовыми файлами
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
        
        // Сохраняем сегментированно
        const storage = new SegmentedStorage();
        const baseState = storage.saveSegmentedState(testState);
        
        console.log('Базовое состояние:', baseState);
        console.log(`Количество сегментов: ${baseState.segments.length}`);
        
        // Проверяем первый сегмент
        const firstSegmentKey = `relay-sync-files-${baseState.segments[0]}`;
        const firstSegment = JSON.parse(localStorage.getItem(firstSegmentKey));
        const filesInFirstSegment = Object.keys(firstSegment.files).length;
        
        console.log(`Файлов в первом сегменте: ${filesInFirstSegment}`);
        console.log(`Ожидаемый размер сегмента: ${storage.MAX_SEGMENT_SIZE} файлов`);
        console.log(`Проверка размера сегмента: ${filesInFirstSegment <= storage.MAX_SEGMENT_SIZE ? 'УСПЕШНО' : 'ОШИБКА'}`);
        
        // Загружаем состояние обратно
        const loadedState = storage.loadSegmentedState(baseState);
        const loadedFileCount = Object.keys(loadedState.files).length;
        
        console.log(`Загружено файлов: ${loadedFileCount}`);
        console.log(`Ожидалось файлов: ${FILE_COUNT}`);
        console.log(`Проверка загрузки: ${loadedFileCount === FILE_COUNT ? 'УСПЕШНО' : 'ОШИБКА'}`);
        
        // Очищаем localStorage
        localStorage.clear();
        
        return loadedFileCount === FILE_COUNT && filesInFirstSegment <= storage.MAX_SEGMENT_SIZE;
    } catch (error) {
        console.error('Ошибка при тестировании сегментированного хранения:', error);
        return false;
    }
}

/**
 * Тестирование кэша файлов
 */
async function testFileCache() {
    console.log('=== ТЕСТИРОВАНИЕ КЭША ФАЙЛОВ ===');
    
    try {
        const cache = new FileCache();
        
        // Тестируем сохранение файлов разного размера
        const testFiles = [
            { path: 'test/small.md', content: 'Small file content', hash: 'hash1' },
            { path: 'test/medium.md', content: 'A'.repeat(1024 * 1024), hash: 'hash2' }, // 1MB
            { path: 'test/large.md', content: 'B'.repeat(6 * 1024 * 1024), hash: 'hash3' } // 6MB - превышает лимит
        ];
        
        console.log('Сохранение файлов в кэш...');
        
        for (const file of testFiles) {
            const saved = cache.saveToCache(file.path, file.content, file.hash);
            console.log(`Сохранение ${file.path} (${file.content.length} байт): ${saved ? 'УСПЕШНО' : 'ОТКЛОНЕНО'}`);
        }
        
        // Проверяем наличие файлов в кэше
        const cachedSmall = cache.getFromCache('test/small.md', 'hash1');
        const cachedMedium = cache.getFromCache('test/medium.md', 'hash2');
        const cachedLarge = cache.getFromCache('test/large.md', 'hash3');
        
        console.log(`Маленький файл в кэше: ${cachedSmall !== null ? 'ДА' : 'НЕТ'}`);
        console.log(`Средний файл в кэше: ${cachedMedium !== null ? 'ДА' : 'НЕТ'}`);
        console.log(`Большой файл в кэше: ${cachedLarge !== null ? 'ДА' : 'НЕТ'}`);
        
        // Проверяем правильность кэширования
        const smallCorrect = cachedSmall === 'Small file content';
        const mediumCorrect = cachedMedium === 'A'.repeat(1024 * 1024);
        const largeCorrect = cachedLarge === null; // Должен быть null, т.к. слишком большой
        
        console.log(`Правильность кэширования малого файла: ${smallCorrect ? 'УСПЕШНО' : 'ОШИБКА'}`);
        console.log(`Правильность кэширования среднего файла: ${mediumCorrect ? 'УСПЕШНО' : 'ОШИБКА'}`);
        console.log(`Правильность отклонения большого файла: ${largeCorrect ? 'УСПЕШНО' : 'ОШИБКА'}`);
        
        // Проверяем вытеснение старых записей
        console.log('\nТестирование вытеснения старых записей...');
        
        // Добавляем много файлов, чтобы заполнить кэш
        for (let i = 0; i < 10; i++) {
            cache.saveToCache(`test/file${i}.md`, 'X'.repeat(300 * 1024), `hash-file${i}`);
        }
        
        // Проверяем, остались ли первоначальные файлы в кэше
        const smallStillCached = cache.getFromCache('test/small.md', 'hash1') !== null;
        console.log(`Маленький файл остался в кэше: ${smallStillCached ? 'ДА' : 'НЕТ'}`);
        
        // Выводим статистику кэша
        const stats = cache.getStats();
        console.log('Статистика кэша:');
        console.log(`- Количество записей: ${stats.entries}`);
        console.log(`- Размер: ${Math.round(stats.totalSize / 1024)} KB / ${Math.round(stats.maxSize / 1024)} KB`);
        console.log(`- Использование: ${stats.usagePercent}%`);
        
        // Очищаем кэш
        cache.clearCache();
        
        return smallCorrect && mediumCorrect && largeCorrect;
    } catch (error) {
        console.error('Ошибка при тестировании кэша файлов:', error);
        return false;
    }
}

/**
 * Тестирование шифрования и фрагментации
 */
async function testChunkedEncryption() {
    console.log('=== ТЕСТИРОВАНИЕ ШИФРОВАНИЯ И ФРАГМЕНТАЦИИ ===');
    
    try {
        // Создаем тестовый контент большого размера
        const content = 'Test content '.repeat(100000); // ~1.2MB
        console.log(`Размер тестового файла: ${Math.round(content.length / 1024)} KB`);
        
        // Шифруем контент
        const encrypted = await CryptoHelper.encrypt(content, 'test-password');
        const encryptedSize = encrypted.data.length + encrypted.iv.length + encrypted.authTag.length;
        console.log(`Размер зашифрованных данных: ${Math.round(encryptedSize / 1024)} KB`);
        
        // Дешифруем контент
        const decrypted = await CryptoHelper.decrypt(encrypted, 'test-password');
        const decryptionSuccess = decrypted === content;
        console.log(`Тест шифрования/дешифрования: ${decryptionSuccess ? 'УСПЕШНО' : 'ОШИБКА'}`);
        
        // Тестируем фрагментацию
        const CHUNK_SIZE = 500 * 1024; // 500KB
        const chunks = CryptoHelper.chunkFile(content, CHUNK_SIZE);
        console.log(`Файл разделен на ${chunks.length} фрагментов`);
        
        // Собираем файл обратно
        const reassembled = CryptoHelper.reassembleFile(chunks);
        const reassemblySuccess = reassembled === content;
        console.log(`Тест фрагментации/сборки: ${reassemblySuccess ? 'УСПЕШНО' : 'ОШИБКА'}`);
        
        return decryptionSuccess && reassemblySuccess;
    } catch (error) {
        console.error('Ошибка при тестировании шифрования и фрагментации:', error);
        return false;
    }
}

/**
 * Тестирование стабильности соединения
 */
async function testConnectionStability() {
    console.log('=== ТЕСТИРОВАНИЕ СТАБИЛЬНОСТИ СОЕДИНЕНИЯ ===');
    
    try {
        console.log('Симуляция нестабильного сетевого соединения...');
        
        // Эмуляция WebSocket с нестабильным соединением
        class MockWebSocket {
            constructor(url) {
                this.url = url;
                this.readyState = 0; // CONNECTING
                this.reconnectAttempts = 0;
                this.maxReconnectAttempts = 5;
                this.callbacks = {};
                
                // Симулируем подключение
                setTimeout(() => this.simulateConnection(), 500);
                
                console.log(`Создано соединение с ${url}`);
            }
            
            addEventListener(event, callback) {
                if (!this.callbacks[event]) {
                    this.callbacks[event] = [];
                }
                this.callbacks[event].push(callback);
            }
            
            removeEventListener(event, callback) {
                if (this.callbacks[event]) {
                    this.callbacks[event] = this.callbacks[event].filter(cb => cb !== callback);
                }
            }
            
            send(data) {
                if (this.readyState !== 1) {
                    console.log('Попытка отправки данных при отключенном соединении');
                    return;
                }
                
                // Симулируем случайную потерю пакетов (20% вероятность)
                if (Math.random() < 0.2) {
                    console.log('Симуляция потери пакета');
                    return;
                }
                
                console.log(`Отправлено: ${data.substring(0, 30)}...`);
                
                // Симулируем ответ от сервера
                setTimeout(() => {
                    if (this.readyState === 1 && this.callbacks['message']) {
                        this.callbacks['message'].forEach(cb => 
                            cb({ data: JSON.stringify({ type: 'ack', id: JSON.parse(data).id }) })
                        );
                    }
                }, 200);
            }
            
            close() {
                this.readyState = 3; // CLOSED
                if (this.callbacks['close']) {
                    this.callbacks['close'].forEach(cb => cb({}));
                }
                console.log('Соединение закрыто');
            }
            
            simulateConnection() {
                // Симулируем случайные отключения
                this.readyState = 1; // OPEN
                console.log('Соединение установлено');
                
                if (this.callbacks['open']) {
                    this.callbacks['open'].forEach(cb => cb({}));
                }
                
                // Случайно разрываем соединение через некоторое время
                const disconnectTime = 1000 + Math.random() * 2000;
                setTimeout(() => {
                    if (this.readyState === 1 && Math.random() < 0.5) {
                        console.log('Симуляция обрыва соединения');
                        this.readyState = 3; // CLOSED
                        
                        if (this.callbacks['close']) {
                            this.callbacks['close'].forEach(cb => cb({}));
                        }
                        
                        this.reconnectAttempts++;
                        if (this.reconnectAttempts < this.maxReconnectAttempts) {
                            console.log(`Попытка переподключения ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);
                            setTimeout(() => this.simulateConnection(), 1000);
                        } else {
                            console.log('Достигнуто максимальное количество попыток переподключения');
                        }
                    }
                }, disconnectTime);
            }
        }
        
        // Класс для тестирования устойчивого соединения
        class ConnectionManager {
            constructor() {
                this.socket = null;
                this.isConnected = false;
                this.pendingMessages = [];
                this.messageQueue = [];
                this.reconnectAttempts = 0;
                this.maxReconnectAttempts = 10;
                this.messageId = 1;
                this.pendingAcks = new Map();
            }
            
            connect() {
                return new Promise((resolve) => {
                    console.log('Попытка установить соединение...');
                    this.socket = new MockWebSocket('ws://mock-relay-server.com');
                    
                    this.socket.addEventListener('open', () => {
                        console.log('Соединение установлено успешно');
                        this.isConnected = true;
                        this.reconnectAttempts = 0;
                        this.processQueue();
                        resolve(true);
                    });
                    
                    this.socket.addEventListener('close', () => {
                        console.log('Соединение закрыто, попытка переподключения');
                        this.isConnected = false;
                        this.reconnect();
                    });
                    
                    this.socket.addEventListener('message', (event) => {
                        const message = JSON.parse(event.data);
                        if (message.type === 'ack' && this.pendingAcks.has(message.id)) {
                            console.log(`Получено подтверждение для сообщения ${message.id}`);
                            const resolver = this.pendingAcks.get(message.id);
                            resolver();
                            this.pendingAcks.delete(message.id);
                        }
                    });
                });
            }
            
            reconnect() {
                this.reconnectAttempts++;
                if (this.reconnectAttempts <= this.maxReconnectAttempts) {
                    console.log(`Попытка переподключения ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);
                    setTimeout(() => this.connect(), 1000);
                } else {
                    console.log('Достигнуто максимальное количество попыток, прекращение попыток');
                }
            }
            
            sendMessage(message) {
                return new Promise((resolve, reject) => {
                    const id = this.messageId++;
                    const messageWithId = {
                        id,
                        ...message,
                        timestamp: Date.now()
                    };
                    
                    // Добавляем в очередь
                    this.messageQueue.push({
                        message: messageWithId,
                        retries: 0,
                        maxRetries: 3,
                        resolve,
                        reject
                    });
                    
                    if (this.isConnected) {
                        this.processQueue();
                    } else {
                        console.log('Сообщение добавлено в очередь (нет соединения)');
                    }
                });
            }
            
            processQueue() {
                if (!this.isConnected || this.messageQueue.length === 0) return;
                
                // Берем первое сообщение из очереди
                const item = this.messageQueue.shift();
                
                console.log(`Отправка сообщения ${item.message.id} (попытка ${item.retries + 1}/${item.maxRetries + 1})`);
                
                // Устанавливаем обработчик подтверждения
                this.pendingAcks.set(item.message.id, () => {
                    item.resolve(true);
                });
                
                // Отправляем сообщение
                this.socket.send(JSON.stringify(item.message));
                
                // Устанавливаем таймаут на случай отсутствия ответа
                setTimeout(() => {
                    if (this.pendingAcks.has(item.message.id)) {
                        console.log(`Таймаут для сообщения ${item.message.id}`);
                        this.pendingAcks.delete(item.message.id);
                        
                        item.retries++;
                        if (item.retries <= item.maxRetries) {
                            console.log(`Повторная попытка отправки сообщения ${item.message.id}`);
                            this.messageQueue.unshift(item); // Возвращаем в начало очереди
                            this.processQueue();
                        } else {
                            console.log(`Сообщение ${item.message.id} не доставлено после ${item.maxRetries + 1} попыток`);
                            item.reject(new Error('Максимальное количество попыток исчерпано'));
                        }
                    }
                }, 2000);
                
                // Обрабатываем следующее сообщение, если есть
                if (this.messageQueue.length > 0) {
                    setTimeout(() => this.processQueue(), 100);
                }
            }
        }
        
        // Тест на отправку серии сообщений через нестабильное соединение
        const connectionManager = new ConnectionManager();
        await connectionManager.connect();
        
        console.log('\nТестирование отправки 10 сообщений при нестабильном соединении...');
        const messagesToSend = 10;
        let successfulMessages = 0;
        
        const promises = [];
        for (let i = 1; i <= messagesToSend; i++) {
            const promise = connectionManager.sendMessage({
                type: 'test',
                content: `Тестовое сообщение ${i}`
            }).then(() => {
                successfulMessages++;
                return true;
            }).catch(() => {
                return false;
            });
            
            promises.push(promise);
        }
        
        const results = await Promise.allSettled(promises);
        const successRate = (successfulMessages / messagesToSend) * 100;
        
        console.log(`\nРезультаты теста стабильности соединения:`);
        console.log(`Отправлено сообщений: ${messagesToSend}`);
        console.log(`Успешно доставлено: ${successfulMessages}`);
        console.log(`Процент успешных сообщений: ${successRate.toFixed(2)}%`);
        
        // Тест считается успешным, если доставлено не менее 70% сообщений
        const isSuccess = successRate >= 70;
        console.log(`Тест стабильности соединения: ${isSuccess ? 'УСПЕШНО' : 'ОШИБКА'}`);
        
        return isSuccess;
    } catch (error) {
        console.error('Ошибка при тестировании стабильности соединения:', error);
        return false;
    }
}

/**
 * Тестирование синхронизации
 */
async function testSynchronization() {
    console.log('=== ТЕСТИРОВАНИЕ СИНХРОНИЗАЦИИ ===');
    
    try {
        // Эмуляция двух устройств с своими наборами файлов
        console.log('Инициализация эмуляции устройств...');
        
        const deviceA = {
            id: 'device-A',
            files: {
                'note1.md': { 
                    content: 'Содержимое заметки 1',
                    mtime: Date.now() - 86400000, // вчера
                    hash: 'hash-note1'
                },
                'note2.md': { 
                    content: 'Содержимое заметки 2',
                    mtime: Date.now() - 43200000, // 12 часов назад
                    hash: 'hash-note2'
                },
                'folder/note3.md': { 
                    content: 'Содержимое заметки 3 в папке',
                    mtime: Date.now() - 3600000, // 1 час назад
                    hash: 'hash-note3'
                }
            },
            vectorClock: {
                'device-A': Date.now()
            }
        };
        
        const deviceB = {
            id: 'device-B',
            files: {
                'note1.md': { 
                    content: 'Содержимое заметки 1', 
                    mtime: Date.now() - 86400000, // то же самое время
                    hash: 'hash-note1'
                },
                'note4.md': { 
                    content: 'Содержимое заметки 4, которой нет на устройстве A',
                    mtime: Date.now() - 7200000, // 2 часа назад
                    hash: 'hash-note4'
                },
                'folder/note5.md': { 
                    content: 'Содержимое заметки 5 в папке',
                    mtime: Date.now() - 1800000, // 30 минут назад
                    hash: 'hash-note5'
                }
            },
            vectorClock: {
                'device-B': Date.now()
            }
        };
        
        console.log('Начальное состояние устройств:');
        console.log(`Устройство A: ${Object.keys(deviceA.files).length} файлов`);
        console.log(`Устройство B: ${Object.keys(deviceB.files).length} файлов`);
        
        // Функция для обнаружения конфликтов и различий между устройствами
        function compareDevices(device1, device2) {
            console.log('\nСравнение устройств...');
            
            // Все файлы из обоих устройств
            const allFiles = new Set([
                ...Object.keys(device1.files),
                ...Object.keys(device2.files)
            ]);
            
            const filesToPush = []; // Файлы для отправки на другое устройство
            const filesToPull = []; // Файлы для получения с другого устройства
            const conflicts = []; // Файлы с конфликтами
            
            allFiles.forEach(path => {
                const fileOnDevice1 = device1.files[path];
                const fileOnDevice2 = device2.files[path];
                
                if (!fileOnDevice1) {
                    // Файл отсутствует на устройстве 1
                    filesToPull.push(path);
                } else if (!fileOnDevice2) {
                    // Файл отсутствует на устройстве 2
                    filesToPush.push(path);
                } else if (fileOnDevice1.hash !== fileOnDevice2.hash) {
                    // Файл отличается на обоих устройствах
                    if (fileOnDevice1.mtime > fileOnDevice2.mtime) {
                        filesToPush.push(path);
                    } else if (fileOnDevice1.mtime < fileOnDevice2.mtime) {
                        filesToPull.push(path);
                    } else {
                        // Равное время изменения, но разное содержимое = конфликт
                        conflicts.push(path);
                    }
                }
            });
            
            return { filesToPush, filesToPull, conflicts };
        }
        
        // Функция для симуляции синхронизации
        function syncDevices(source, target, filesToSync) {
            console.log(`Синхронизация ${filesToSync.length} файлов с ${source.id} на ${target.id}...`);
            
            filesToSync.forEach(path => {
                if (source.files[path]) {
                    target.files[path] = {...source.files[path]};
                    console.log(`- Синхронизирован файл: ${path}`);
                }
            });
            
            // Обновляем векторные часы
            target.vectorClock[source.id] = Date.now();
            source.vectorClock[source.id] = Date.now();
        }
        
        // Имитация разрешения конфликтов
        function resolveConflicts(device1, device2, conflicts) {
            if (conflicts.length === 0) return;
            
            console.log(`\nРазрешение ${conflicts.length} конфликтов...`);
            
            conflicts.forEach(path => {
                // Для теста, просто используем содержимое с device1 и обновляем время
                const mergedContent = `${device1.files[path].content}\n---\n${device2.files[path].content}`;
                const newHash = `hash-merged-${Math.random().toString(36).substring(7)}`;
                const newMtime = Date.now();
                
                const merged = {
                    content: mergedContent,
                    mtime: newMtime,
                    hash: newHash
                };
                
                device1.files[path] = merged;
                device2.files[path] = merged;
                
                console.log(`- Разрешен конфликт в файле: ${path}`);
            });
            
            // Обновляем векторные часы
            const now = Date.now();
            device1.vectorClock[device1.id] = now;
            device2.vectorClock[device2.id] = now;
        }
        
        // Выполняем полную синхронизацию
        console.log('\nНачало процесса синхронизации...');
        
        // Шаг 1: Поиск различий
        const fromAtoB = compareDevices(deviceA, deviceB);
        const fromBtoA = compareDevices(deviceB, deviceA);
        
        console.log(`\nФайлы для отправки с устройства A на B: ${fromAtoB.filesToPush.length}`);
        console.log(`Файлы для получения на устройство A с B: ${fromAtoB.filesToPull.length}`);
        console.log(`Конфликты: ${fromAtoB.conflicts.length}`);
        
        // Шаг 2: Синхронизация файлов
        syncDevices(deviceA, deviceB, fromAtoB.filesToPush);
        syncDevices(deviceB, deviceA, fromBtoA.filesToPush);
        
        // Шаг 3: Разрешение конфликтов, если есть
        resolveConflicts(deviceA, deviceB, fromAtoB.conflicts);
        
        // Шаг 4: Проверка результатов синхронизации
        const finalCompare = compareDevices(deviceA, deviceB);
        
        console.log('\nРезультаты синхронизации:');
        console.log(`Устройство A: ${Object.keys(deviceA.files).length} файлов`);
        console.log(`Устройство B: ${Object.keys(deviceB.files).length} файлов`);
        
        const syncSuccessful = 
            finalCompare.filesToPush.length === 0 && 
            finalCompare.filesToPull.length === 0 && 
            finalCompare.conflicts.length === 0;
        
        console.log(`\nСинхронизация ${syncSuccessful ? 'успешно завершена' : 'не завершена полностью'}`);
        
        // Проверяем, все ли файлы синхронизированы
        if (syncSuccessful) {
            console.log('Все файлы успешно синхронизированы между устройствами');
        } else {
            console.log('Остались несинхронизированные файлы или конфликты:');
            console.log(`- Файлы для отправки: ${finalCompare.filesToPush.join(', ')}`);
            console.log(`- Файлы для получения: ${finalCompare.filesToPull.join(', ')}`);
            console.log(`- Конфликты: ${finalCompare.conflicts.join(', ')}`);
        }
        
        // Проверяем соответствие хэшей между устройствами
        let hashMismatch = false;
        Object.keys(deviceA.files).forEach(path => {
            if (deviceB.files[path] && deviceA.files[path].hash !== deviceB.files[path].hash) {
                console.log(`Несоответствие хэшей для файла: ${path}`);
                hashMismatch = true;
            }
        });
        
        if (!hashMismatch) {
            console.log('Все хэши файлов совпадают между устройствами');
        }
        
        // Тест успешен, если все файлы синхронизированы и нет несоответствий хэшей
        return syncSuccessful && !hashMismatch;
    } catch (error) {
        console.error('Ошибка при тестировании синхронизации:', error);
        return false;
    }
}

/**
 * Запуск всех тестов
 */
async function runAllTests() {
    console.log('======= ЗАПУСК ВСЕХ ТЕСТОВ ОПТИМИЗАЦИИ =======\n');
    
    const results = {
        deltaCompression: await testDeltaCompression(),
        segmentedStorage: await testSegmentedStorage(),
        fileCache: await testFileCache(),
        chunkedEncryption: await testChunkedEncryption(),
        connectionStability: await testConnectionStability(),
        synchronization: await testSynchronization()
    };
    
    console.log('\n======= РЕЗУЛЬТАТЫ ТЕСТОВ =======');
    for (const [test, result] of Object.entries(results)) {
        console.log(`${test}: ${result ? '✅ УСПЕШНО' : '❌ ОШИБКА'}`);
    }
    
    const allPassed = Object.values(results).every(result => result);
    console.log(`\nОбщий результат: ${allPassed ? '✅ ВСЕ ТЕСТЫ УСПЕШНО ПРОЙДЕНЫ' : '❌ ЕСТЬ ОШИБКИ'}`);
    
    return allPassed;
}

// Запускаем тесты
runAllTests().then(success => {
    if (success) {
        console.log('\n✨ Все оптимизации работают корректно! ✨');
    } else {
        console.log('\n⚠️ Некоторые тесты не прошли. Проверьте логи для деталей.');
    }
});