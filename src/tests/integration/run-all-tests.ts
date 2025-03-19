/**
 * Запуск всех интеграционных тестов для Obsidian Relay Sync
 */

// Загружаем мок-объекты перед импортом других файлов
import './mocks';

import { testConnection } from './connection-tests';
import { testSync } from './sync-tests';
import { testTrustedDevices } from './trusted-device-tests';
import { runAllTests as runOptimizerTests } from '../optimizer-tests';

/**
 * Запускает все интеграционные тесты
 */
export async function runAllIntegrationTests(): Promise<boolean> {
    console.log('\n======= ЗАПУСК ВСЕХ ИНТЕГРАЦИОННЫХ ТЕСТОВ ПЛАГИНА =======\n');
    
    const results = {
        connection: await testConnection(),
        sync: await testSync(),
        trustedDevices: await testTrustedDevices(),
    };
    
    console.log('\n======= РЕЗУЛЬТАТЫ ИНТЕГРАЦИОННЫХ ТЕСТОВ =======');
    for (const [test, result] of Object.entries(results)) {
        console.log(`${test}: ${result ? '✅ ПРОЙДЕН' : '❌ НЕ ПРОЙДЕН'}`);
    }
    
    const allPassed = Object.values(results).every(result => result);
    console.log(`\nОбщий результат интеграционных тестов: ${allPassed ? '✅ ВСЕ ТЕСТЫ ПРОЙДЕНЫ' : '❌ ЕСТЬ ПРОБЛЕМЫ'}`);
    
    return allPassed;
}

// Мок-объекты перемещены в отдельный файл mocks.ts

/**
 * Запускает все тесты, включая оптимизационные и интеграционные
 */
export async function runAllTests(): Promise<boolean> {
    console.log('\n======= ЗАПУСК ПОЛНОГО НАБОРА ТЕСТОВ ПЛАГИНА =======\n');
    
    try {
        // Запускаем оптимизационные тесты
        console.log('1. Запуск тестов оптимизаций...');
        const optimizerTestsResults = await runOptimizerTests();
        
        // Запускаем интеграционные тесты
        console.log('\n2. Запуск интеграционных тестов...');
        const integrationTestsResults = await runAllIntegrationTests();
        
        // Выводим общие результаты
        console.log('\n======= ОБЩИЕ РЕЗУЛЬТАТЫ ТЕСТИРОВАНИЯ =======');
        console.log(`Тесты оптимизаций: ${optimizerTestsResults ? '✅ ПРОЙДЕНЫ' : '❌ НЕ ПРОЙДЕНЫ'}`);
        console.log(`Интеграционные тесты: ${integrationTestsResults ? '✅ ПРОЙДЕНЫ' : '❌ НЕ ПРОЙДЕНЫ'}`);
        
        const allPassed = optimizerTestsResults && integrationTestsResults;
        console.log(`\nОбщий результат тестирования: ${allPassed ? '✅ ВСЕ ТЕСТЫ ПРОЙДЕНЫ' : '❌ ЕСТЬ ПРОБЛЕМЫ'}`);
        
        return allPassed;
    } catch (error) {
        console.error('Ошибка при запуске тестов:', error);
        return false;
    }
}

// Автоматически запускаем тесты, если этот файл исполняется напрямую
if (typeof require !== 'undefined' && require.main === module) {
    runAllTests().then(result => {
        process.exit(result ? 0 : 1);
    });
}