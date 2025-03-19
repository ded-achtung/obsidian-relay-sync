/**
 * Команда для ручного запуска тестов из Obsidian
 */
import { Notice } from 'obsidian';
import { runAllTests as runOptimizerTestsOnly } from './optimizer-tests';
import { runAllTests as runAllTestsSuite } from './integration/run-all-tests';
import { runRealSyncTest } from './integration/real-sync-test';
import { runMockSyncTest } from './integration/mock-sync-test';

/**
 * Запускает тесты оптимизатора и выводит результаты
 */
export async function runOptimizerTests() {
    try {
        new Notice('Запуск тестов оптимизатора...');
        console.log('===== ЗАПУСК ТЕСТОВ ОПТИМИЗАТОРА =====');
        
        // Запускаем тесты
        const allPassed = await runOptimizerTestsOnly();
        
        // Выводим общий результат
        if (allPassed) {
            new Notice('✅ Все тесты оптимизатора успешно пройдены!', 10000);
        } else {
            new Notice('❌ Некоторые тесты оптимизатора не пройдены. Подробности в консоли разработчика.', 10000);
        }
        
        return allPassed;
    } catch (error) {
        console.error('Ошибка при запуске тестов оптимизатора:', error);
        new Notice(`❌ Ошибка при запуске тестов оптимизатора: ${error.message}`, 10000);
        return false;
    }
}

/**
 * Запускает все тесты плагина и выводит результаты
 */
export async function runAllTests() {
    try {
        new Notice('Запуск всех тестов плагина...');
        console.log('===== ЗАПУСК ВСЕХ ТЕСТОВ ПЛАГИНА =====');
        
        // Запускаем тесты
        const allPassed = await runAllTestsSuite();
        
        // Выводим общий результат
        if (allPassed) {
            new Notice('✅ Все тесты плагина успешно пройдены!', 10000);
        } else {
            new Notice('❌ Некоторые тесты плагина не пройдены. Подробности в консоли разработчика.', 10000);
        }
        
        return allPassed;
    } catch (error) {
        console.error('Ошибка при запуске всех тестов:', error);
        new Notice(`❌ Ошибка при запуске всех тестов: ${error.message}`, 10000);
        return false;
    }
}

/**
 * Запускает тест реальной синхронизации между устройствами
 */
export async function runRealSyncTests() {
    try {
        return await runRealSyncTest();
    } catch (error) {
        console.error('Ошибка при запуске теста реальной синхронизации:', error);
        new Notice(`❌ Ошибка при запуске теста реальной синхронизации: ${error.message}`, 10000);
        return false;
    }
}

/**
 * Запускает тест синхронизации с использованием моков
 */
export async function runMockSyncTests() {
    try {
        return await runMockSyncTest();
    } catch (error) {
        console.error('Ошибка при запуске теста с моками:', error);
        new Notice(`❌ Ошибка при запуске теста с моками: ${error.message}`, 10000);
        return false;
    }
}