/**
 * Запускатель тестов для Obsidian Relay Sync
 * 
 * Запуск из командной строки:
 * node -r ts-node/register src/tests/run-tests.ts
 */

import { runAllTests } from './optimizer-tests';

// Запускаем все тесты
runAllTests().then(allPassed => {
    console.log(`Результат тестирования: ${allPassed ? 'Успешно' : 'Ошибка'}`);
    
    // Возвращаем код завершения в зависимости от результата тестов
    process.exit(allPassed ? 0 : 1);
});