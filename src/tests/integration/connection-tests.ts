/**
 * Интеграционные тесты подключения для Obsidian Relay Sync
 */

import { RelayClient } from '../../client/relay-client';
import { DeviceManager } from '../../utils/device-id';

// Тестовые данные
const TEST_SERVER_URL = 'ws://localhost:8080/ws';
const TEST_DEVICE_ID = 'test-device-id';
const TEST_DEVICE_NAME = 'Test Device';

/**
 * Тестирование подключения к серверу
 */
export async function testConnection(): Promise<boolean> {
    console.log('=== ТЕСТИРОВАНИЕ ПОДКЛЮЧЕНИЯ К СЕРВЕРУ ===');
    
    // Создаём мок WebSocket
    class MockWebSocket {
        url: string;
        onopen: (() => void) | null = null;
        onmessage: ((event: any) => void) | null = null;
        onclose: ((event: any) => void) | null = null;
        onerror: ((event: any) => void) | null = null;
        readyState: number = 0; // 0 = CONNECTING, 1 = OPEN, 2 = CLOSING, 3 = CLOSED
        
        constructor(url: string) {
            this.url = url;
            // Имитируем успешное подключение через 100мс
            setTimeout(() => {
                this.readyState = 1;
                if (this.onopen) this.onopen();
            }, 100);
        }
        
        send(data: string): void {
            if (this.readyState !== 1) {
                throw new Error('WebSocket is not connected');
            }
            
            // Имитируем получение ответа от сервера
            const message = JSON.parse(data);
            
            setTimeout(() => {
                if (message.type === 'init') {
                    // Ответ на инициализацию
                    if (this.onmessage) {
                        this.onmessage({
                            data: JSON.stringify({
                                type: 'init_response',
                                success: true,
                                message: 'Connected successfully'
                            })
                        });
                    }
                } else if (message.type === 'ping') {
                    // Ответ на пинг
                    if (this.onmessage) {
                        this.onmessage({
                            data: JSON.stringify({
                                type: 'pong',
                                timestamp: Date.now()
                            })
                        });
                    }
                }
            }, 50);
        }
        
        close(): void {
            this.readyState = 3;
            if (this.onclose) {
                this.onclose({ code: 1000, reason: 'Normal closure' });
            }
        }
    }
    
    // Задаём глобальный WebSocket для теста
    const originalWebSocket = global.WebSocket;
    global.WebSocket = MockWebSocket as any;
    
    try {
        // Создаём тестовые обработчики событий
        let isConnected = false;
        let receivedInitResponse = false;
        
        const onConnect = () => {
            console.log('Соединение установлено');
            isConnected = true;
        };
        
        const onDisconnect = () => {
            console.log('Соединение разорвано');
            isConnected = false;
        };
        
        const onMessage = (message: any) => {
            console.log('Получено сообщение:', message);
            if (message.type === 'init_response') {
                receivedInitResponse = true;
            }
        };
        
        // Создаём клиент Relay
        const client = new RelayClient({
            serverUrl: TEST_SERVER_URL,
            deviceId: TEST_DEVICE_ID,
            deviceName: TEST_DEVICE_NAME,
            onMessage,
            onConnectionChange: (connected) => {
                if (connected) onConnect();
                else onDisconnect();
            },
            onTrustedDevicesChange: () => {},
            onSyncRequest: () => {}
        });
        
        // Подключаемся к серверу
        console.log('Подключение к серверу...');
        client.connect();
        
        // Проверяем статус подключения через некоторое время
        await new Promise(resolve => setTimeout(resolve, 200));
        
        console.log(`Статус соединения: ${isConnected ? 'ПОДКЛЮЧЕНО' : 'ОТКЛЮЧЕНО'}`);
        console.log(`Получен ответ инициализации: ${receivedInitResponse ? 'ДА' : 'НЕТ'}`);
        
        // Отправляем пинг
        const pingSuccess = client.sendMessage({
            type: 'ping',
            timestamp: Date.now()
        });
        
        console.log(`Отправка пинга: ${pingSuccess ? 'УСПЕШНО' : 'ОШИБКА'}`);
        
        // Отключаемся от сервера
        client.disconnect();
        
        // Проверяем отключение
        await new Promise(resolve => setTimeout(resolve, 100));
        console.log(`Статус после отключения: ${isConnected ? 'ПОДКЛЮЧЕНО' : 'ОТКЛЮЧЕНО'}`);
        
        // Восстанавливаем оригинальный WebSocket
        global.WebSocket = originalWebSocket;
        
        const connectionSuccess = receivedInitResponse && pingSuccess;
        console.log(`Тест подключения: ${connectionSuccess ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН'}`);
        
        return connectionSuccess;
    } catch (error) {
        console.error('Ошибка при тестировании подключения:', error);
        
        // Восстанавливаем оригинальный WebSocket в случае ошибки
        global.WebSocket = originalWebSocket;
        
        return false;
    }
}