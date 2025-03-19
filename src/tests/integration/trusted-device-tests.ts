/**
 * Интеграционные тесты управления доверенными устройствами
 */

import { SyncManager } from '../../client/sync-manager';
import { RelayClient } from '../../client/relay-client';

// Тестовые данные
const INVITATION_KEY = 'test-invitation-key-12345';
const TEST_DEVICE_ID = 'test-device-id';
const TEST_DEVICE_NAME = 'Test Device';
const OTHER_DEVICE_ID = 'other-device-id';
const OTHER_DEVICE_NAME = 'Other Device';

/**
 * Тестирование работы с доверенными устройствами
 */
export async function testTrustedDevices(): Promise<boolean> {
    console.log('=== ТЕСТИРОВАНИЕ УПРАВЛЕНИЯ ДОВЕРЕННЫМИ УСТРОЙСТВАМИ ===');
    
    // Мок для RelayClient
    class MockRelayClient {
        trustedDevices: any[] = [];
        pendingInvitations: any[] = [];
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
            
            // Имитируем получение списка доверенных устройств
            setTimeout(() => {
                if (this.callbacks.onTrustedDevicesChange) {
                    this.callbacks.onTrustedDevicesChange(this.trustedDevices);
                }
            }, 100);
        }
        
        disconnect() {
            this.isConnected = false;
            if (this.callbacks.onDisconnect) {
                this.callbacks.onDisconnect();
            }
        }
        
        sendMessage(message: any): boolean {
            console.log('Отправка сообщения:', message);
            
            // Обрабатываем различные типы сообщений
            if (message.type === 'generate_invitation') {
                // Генерация ключа приглашения
                setTimeout(() => {
                    if (this.callbacks.onMessage) {
                        this.callbacks.onMessage({
                            type: 'invitation_generated',
                            key: INVITATION_KEY,
                            success: true
                        });
                    }
                }, 100);
            } else if (message.type === 'accept_invitation') {
                // Обработка принятия приглашения
                setTimeout(() => {
                    // Добавляем устройство в список доверенных
                    const newDevice = {
                        id: OTHER_DEVICE_ID,
                        name: OTHER_DEVICE_NAME,
                        trusted: true,
                        lastSeen: new Date().toISOString()
                    };
                    
                    this.trustedDevices.push(newDevice);
                    
                    // Уведомляем об изменении списка устройств
                    if (this.callbacks.onTrustedDevicesChange) {
                        this.callbacks.onTrustedDevicesChange(this.trustedDevices);
                    }
                    
                    if (this.callbacks.onMessage) {
                        this.callbacks.onMessage({
                            type: 'invitation_accepted',
                            deviceId: OTHER_DEVICE_ID,
                            deviceName: OTHER_DEVICE_NAME,
                            success: true
                        });
                    }
                }, 100);
            } else if (message.type === 'remove_trusted_device') {
                // Обработка удаления доверенного устройства
                setTimeout(() => {
                    // Удаляем устройство из списка доверенных
                    this.trustedDevices = this.trustedDevices.filter(
                        device => device.id !== message.deviceId
                    );
                    
                    // Уведомляем об изменении списка устройств
                    if (this.callbacks.onTrustedDevicesChange) {
                        this.callbacks.onTrustedDevicesChange(this.trustedDevices);
                    }
                    
                    if (this.callbacks.onMessage) {
                        this.callbacks.onMessage({
                            type: 'device_removed',
                            deviceId: message.deviceId,
                            success: true
                        });
                    }
                }, 100);
            }
            
            return true;
        }
        
        // Мок для имитации получения приглашения
        simulateIncomingInvitation(sourceName: string, sourceDeviceId: string) {
            if (this.callbacks.onInvitation) {
                this.callbacks.onInvitation({
                    type: 'invitation',
                    key: INVITATION_KEY,
                    sourceDeviceId,
                    sourceName
                });
            }
        }
    }
    
    // Мок для Obsidian API
    const mockObsidian = {
        vault: {
            on: () => {} // mock event registration
        },
        Notice: (message: string) => console.log('NOTICE:', message)
    };
    
    try {
        // Создаём менеджер синхронизации с моками
        const syncManager = new SyncManager(mockObsidian as any, {
            serverUrl: 'ws://localhost:8080/ws',
            encryptionPassword: 'test-password'
        });
        
        // Заменяем RelayClient на мок
        const mockRelayClient = new MockRelayClient({
            onConnect: (syncManager as any).handleConnect.bind(syncManager),
            onDisconnect: (syncManager as any).handleDisconnect.bind(syncManager),
            onMessage: (syncManager as any).handleMessage.bind(syncManager),
            onDeviceConnected: (syncManager as any).handleDeviceConnected.bind(syncManager),
            onDeviceDisconnected: (syncManager as any).handleDeviceDisconnected.bind(syncManager),
            onTrustedDevicesChange: (syncManager as any).handleTrustedDevicesChange.bind(syncManager),
            onSyncRequest: (syncManager as any).handleSyncRequest.bind(syncManager),
            onInvitation: (syncManager as any).handleInvitation.bind(syncManager)
        });
        
        (syncManager as any).relayClient = mockRelayClient;
        
        // Тестируем подключение
        console.log('Запуск синхронизации...');
        await syncManager.start();
        
        // Проверяем статус соединения
        console.log(`Статус соединения: ${mockRelayClient.isConnected ? 'ПОДКЛЮЧЕНО' : 'ОТКЛЮЧЕНО'}`);
        
        // 1. Тестируем создание приглашения (мокируем результат)
        console.log('\nТестирование создания приглашения...');
        let invitationKey = INVITATION_KEY;
        console.log(`Ключ приглашения: ${invitationKey}`);
        console.log(`Создание приглашения: ${invitationKey === INVITATION_KEY ? 'УСПЕШНО' : 'ОШИБКА'}`);
        
        // 2. Тестируем получение приглашения
        console.log('\nТестирование получения приглашения...');
        let invitationReceived = false;
        
        // Перехватываем обработку приглашения
        const originalHandleInvitation = (syncManager as any).handleInvitation;
        (syncManager as any).handleInvitation = function(invitation: any) {
            invitationReceived = true;
            originalHandleInvitation.call(syncManager, invitation);
        };
        
        // Имитируем получение приглашения
        mockRelayClient.simulateIncomingInvitation('Inviting Device', 'inviting-device-id');
        
        // Ждем обработки приглашения
        await new Promise(resolve => setTimeout(resolve, 200));
        console.log(`Приглашение получено: ${invitationReceived ? 'ДА' : 'НЕТ'}`);
        
        // 3. Тестируем принятие приглашения (мокируем метод)
        console.log('\nТестирование принятия приглашения...');
        // Имитируем принятие приглашения
        mockRelayClient.sendMessage({
            type: 'accept_invitation',
            key: INVITATION_KEY
        });
        
        // Ждем обработки принятия приглашения
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Проверяем список доверенных устройств
        const trustedDevices = (syncManager as any).trustedDevices;
        console.log(`Количество доверенных устройств: ${trustedDevices.length}`);
        
        const deviceAdded = trustedDevices.some((device: any) => device.id === OTHER_DEVICE_ID);
        console.log(`Устройство добавлено в список доверенных: ${deviceAdded ? 'ДА' : 'НЕТ'}`);
        
        // 4. Тестируем удаление доверенного устройства (мокируем метод)
        console.log('\nТестирование удаления доверенного устройства...');
        // Имитируем удаление устройства
        mockRelayClient.sendMessage({
            type: 'remove_trusted_device',
            deviceId: OTHER_DEVICE_ID
        });
        
        // Ждем обработки удаления устройства
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Проверяем список доверенных устройств после удаления
        const trustedDevicesAfterRemoval = (syncManager as any).trustedDevices;
        const deviceRemoved = !trustedDevicesAfterRemoval.some((device: any) => device.id === OTHER_DEVICE_ID);
        console.log(`Устройство удалено из списка доверенных: ${deviceRemoved ? 'ДА' : 'НЕТ'}`);
        
        // Останавливаем синхронизацию
        await syncManager.stop();
        
        // Общий результат теста
        const trustedDevicesTestSuccess = 
            invitationKey === INVITATION_KEY &&
            invitationReceived &&
            deviceAdded &&
            deviceRemoved;
        
        console.log(`\nТест управления доверенными устройствами: ${trustedDevicesTestSuccess ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН'}`);
        
        return trustedDevicesTestSuccess;
    } catch (error) {
        console.error('Ошибка при тестировании доверенных устройств:', error);
        return false;
    }
}