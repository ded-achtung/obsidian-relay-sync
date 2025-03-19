/**
 * Клиент для взаимодействия с сервером-маршрутизатором
 * Обеспечивает WebSocket соединение и обработку сообщений
 */

export interface DeviceInfo {
    id: string;
    name: string;
    lastSeen?: string;
    trusted?: boolean;
}

export interface SyncMessage {
    type: string;
    payload?: any;
    sourceDeviceId?: string;
    targetDeviceId?: string;
    timestamp?: number;
    requestId?: string;
    deviceName?: string;
    sourceName?: string;  // Имя исходного устройства
    key?: string;
    accept?: boolean;
    accepted?: boolean;   // Флаг принятия запроса
    trusted?: boolean;
    message?: string;     // Текстовое сообщение
    success?: boolean;    // Флаг успешного выполнения
    devices?: DeviceInfo[]; // Список доверенных устройств (новый формат сервера)
    pingId?: string;      // Идентификатор для пингов устройств в сигнальной системе
}

export interface RelayClientOptions {
    serverUrl: string;
    deviceId: string;
    deviceName: string;
    onMessage: (message: SyncMessage) => void;
    onConnectionChange: (connected: boolean) => void;
    onTrustedDevicesChange: (devices: DeviceInfo[]) => void;
    onSyncRequest: (request: SyncMessage) => void;
}

export class RelayClient {
    private ws: WebSocket | null = null;
    private serverUrl: string;
    private deviceId: string;
    private deviceName: string;
    public isConnected = false;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 10;
    private heartbeatInterval: NodeJS.Timeout | null = null;
    private messageCallbacks: Map<string, (response: any) => void> = new Map();
    private pendingRequests: Map<string, SyncMessage> = new Map();
    private trustedDevices: DeviceInfo[] = [];

    private onMessageCallback: (message: SyncMessage) => void;
    private onConnectionChangeCallback: (connected: boolean) => void;
    private onTrustedDevicesChangeCallback: (devices: DeviceInfo[]) => void;
    private onSyncRequestCallback: (request: SyncMessage) => void;
    
    // Сохраняем оригинальный обработчик для генерации ключа
    private onMessageCallbackOriginal: (message: SyncMessage) => void = () => {};

    constructor(options: RelayClientOptions) {
        this.serverUrl = options.serverUrl;
        this.deviceId = options.deviceId;
        this.deviceName = options.deviceName;
        this.onMessageCallback = options.onMessage;
        this.onConnectionChangeCallback = options.onConnectionChange;
        this.onTrustedDevicesChangeCallback = options.onTrustedDevicesChange;
        this.onSyncRequestCallback = options.onSyncRequest;
    }

    /**
     * Подключиться к серверу
     */
    public connect(): void {
        if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
            console.log("WebSocket already connected or connecting");
            return;
        }

        try {
            this.ws = new WebSocket(this.serverUrl);

            this.ws.onopen = this.handleOpen.bind(this);
            this.ws.onmessage = this.handleMessage.bind(this);
            this.ws.onclose = this.handleClose.bind(this);
            this.ws.onerror = this.handleError.bind(this);
        } catch (error) {
            console.error("Error connecting to WebSocket server:", error);
            this.scheduleReconnect();
        }
    }

    /**
     * Отключиться от сервера
     */
    public disconnect(): void {
        this.stopHeartbeat();
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    /**
     * Отправить сообщение на сервер
     */
    public sendMessage(message: SyncMessage): boolean {
        // Проверяем состояние соединения
        if (!this.isConnected || !this.ws) {
            console.error("Cannot send message: WebSocket not connected");
            
            // Если соединение разорвано, пытаемся переподключиться
            if (!this.reconnectTimeout) {
                console.log("Попытка восстановить соединение автоматически...");
                this.scheduleReconnect();
            }
            
            return false;
        }

        // Дополнительная проверка состояния WebSocket
        if (this.ws.readyState !== WebSocket.OPEN) {
            console.error(`Cannot send message: WebSocket в неправильном состоянии (${this.ws.readyState})`);
            
            // Если состояние неверное, пробуем переподключиться
            this.disconnect(); // Сначала отключаемся полностью
            this.connect();    // Затем переподключаемся
            
            return false;
        }

        try {
            // Добавляем данные устройства к сообщению
            const fullMessage: SyncMessage = {
                ...message,
                sourceDeviceId: this.deviceId,
                timestamp: Date.now()
            };

            console.log("Отправка сообщения:", fullMessage);
            
            this.ws.send(JSON.stringify(fullMessage));
            console.log("Сообщение отправлено успешно");
            return true;
        } catch (error) {
            console.error("Error sending message:", error);
            return false;
        }
    }

    /**
     * Отправить сообщение и получить ответ через Promise
     */
    public async sendMessageWithResponse(message: SyncMessage, timeout = 30000): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.isConnected || !this.ws) {
                reject(new Error("WebSocket not connected"));
                return;
            }

            // Генерируем уникальный идентификатор запроса
            const requestId = this.generateRequestId();
            const fullMessage: SyncMessage = {
                ...message,
                sourceDeviceId: this.deviceId,
                requestId,
                timestamp: Date.now()
            };

            console.log("Отправка сообщения с ожиданием ответа:", fullMessage);

            // Устанавливаем обработчик ответа
            const timeoutId = setTimeout(() => {
                console.log("Таймаут для запроса:", requestId);
                this.messageCallbacks.delete(requestId);
                reject(new Error("Request timeout"));
            }, timeout);

            this.messageCallbacks.set(requestId, (response) => {
                console.log("Получен ответ на запрос:", requestId, response);
                clearTimeout(timeoutId);
                resolve(response);
            });

            try {
                this.ws.send(JSON.stringify(fullMessage));
                console.log("Сообщение отправлено успешно, ожидание ответа...");
            } catch (error) {
                console.error("Ошибка при отправке сообщения:", error);
                clearTimeout(timeoutId);
                this.messageCallbacks.delete(requestId);
                reject(error);
            }
        });
    }

    /**
     * Генерация ключа приглашения
     */
    public async generateInvitationKey(expirationMinutes = 10): Promise<string> {
        try {
            // Создаем Promise для ожидания ответа
            return new Promise((resolve, reject) => {
                // Устанавливаем обработчик для ответа с ключом
                const keyHandler = (message: SyncMessage) => {
                    if (message.type === 'invitationKey' && message.key) {
                        console.log("Получен ключ приглашения:", message.key);
                        
                        // Восстанавливаем оригинальный обработчик
                        this.onMessageCallback = this.onMessageCallbackOriginal;
                        
                        resolve(message.key);
                    }
                };
                
                // Сохраняем оригинальный обработчик
                this.onMessageCallbackOriginal = this.onMessageCallback;
                
                // Устанавливаем новый обработчик, который сначала проверит наш случай
                const tempHandler = (message: SyncMessage) => {
                    if (message.type === 'invitationKey') {
                        keyHandler(message);
                    } else {
                        // Если это не наш случай, вызываем оригинальный обработчик
                        this.onMessageCallbackOriginal(message);
                    }
                };
                
                this.onMessageCallback = tempHandler;
                
                // Отправляем запрос
                this.sendMessage({
                    type: "generateInvitationKey",
                    payload: {
                        expiration: expirationMinutes * 60 * 1000
                    }
                });
                
                // Устанавливаем таймаут
                setTimeout(() => {
                    // Восстанавливаем оригинальный обработчик
                    this.onMessageCallback = this.onMessageCallbackOriginal;
                    reject(new Error("Таймаут при запросе ключа приглашения"));
                }, 30000); // 30 секунд
            });
        } catch (error) {
            console.error("Error generating invitation key:", error);
            throw error;
        }
    }
    
    // Этот обработчик уже определен выше в классе

    /**
     * Использование ключа приглашения
     */
    public async useInvitationKey(key: string): Promise<boolean> {
        try {
            // Проверка на пустой ключ
            if (!key || key.trim() === '') {
                console.error("Error: Empty invitation key");
                return false;
            }

            // Используем тот же подход что и для генерации ключа
            return new Promise((resolve, reject) => {
                // Обработчик ответа на запрос синхронизации
                const syncRequestHandler = (message: SyncMessage) => {
                    if (message.type === 'syncRequestSent') {
                        console.log("Запрос на синхронизацию отправлен");
                        
                        // Запрашиваем обновление списка доверенных устройств
                        setTimeout(() => {
                            this.requestTrustedDevices();
                        }, 500);
                        
                        // Восстанавливаем оригинальный обработчик
                        this.onMessageCallback = this.onMessageCallbackOriginal;
                        
                        resolve(true);
                    } else if (message.type === 'error') {
                        console.error("Ошибка при использовании ключа:", message);
                        
                        // Восстанавливаем оригинальный обработчик
                        this.onMessageCallback = this.onMessageCallbackOriginal;
                        
                        resolve(false);
                    } else if (message.type === 'trustedDevices') {
                        // Обрабатываем обновление списка доверенных устройств
                        if (message.devices && Array.isArray(message.devices)) {
                            this.handleTrustedDevicesUpdate(message.devices);
                        } else if (message.payload) {
                            this.handleTrustedDevicesUpdate(message.payload);
                        }
                        
                        // Не восстанавливаем обработчик, т.к. еще может прийти syncRequestSent
                        // Просто пропускаем это сообщение
                    }
                };
                
                // Сохраняем оригинальный обработчик
                this.onMessageCallbackOriginal = this.onMessageCallback;
                
                // Устанавливаем новый обработчик
                const tempHandler = (message: SyncMessage) => {
                    if (message.type === 'syncRequestSent' || message.type === 'error' || message.type === 'trustedDevices') {
                        syncRequestHandler(message);
                    } else {
                        // Вызываем оригинальный обработчик для других сообщений
                        this.onMessageCallbackOriginal(message);
                    }
                };
                
                this.onMessageCallback = tempHandler;
                
                // Отправляем запрос
                // Заменим type на точную строку "useInvitationKey"
                // Убедимся, что ключ передается правильно
                const cleanKey = key.trim().toUpperCase(); // Удаляем пробелы и приводим к верхнему регистру
                console.log("Sending cleaned key:", cleanKey);
                
                this.sendMessage({
                    type: "useInvitationKey",
                    key: cleanKey,
                    deviceName: this.deviceName
                });
                
                // Устанавливаем таймаут
                setTimeout(() => {
                    // Восстанавливаем оригинальный обработчик
                    this.onMessageCallback = this.onMessageCallbackOriginal;
                    
                    // Запрашиваем список доверенных устройств на всякий случай
                    this.requestTrustedDevices();
                    
                    reject(new Error("Таймаут при использовании ключа приглашения"));
                }, 30000); // 30 секунд
            });
        } catch (error) {
            console.error("Error using invitation key:", error);
            return false;
        }
    }

    /**
     * Ответ на запрос синхронизации
     */
    public async respondToSyncRequest(
        requestId: string,
        targetDeviceId: string,
        accept: boolean,
        trusted = false
    ): Promise<boolean> {
        try {
            console.log(`Отправка ответа на запрос синхронизации: 
                requestId=${requestId}, 
                targetDeviceId=${targetDeviceId}, 
                accept=${accept}, 
                trusted=${trusted}`);
            
            // 1. Отправляем сообщение
            this.sendMessage({
                type: "syncResponse",
                requestId,
                targetDeviceId,
                accept,
                trusted: trusted || false
            });
            
            console.log("Сообщение с ответом на запрос отправлено");
            
            // 2. Если принимаем запрос, сразу добавляем устройство в список доверенных
            if (accept && trusted) {
                console.log(`Локально добавляем устройство ${targetDeviceId} в доверенные`);
                
                // Инициализируем массив, если он не определен
                if (!this.trustedDevices) {
                    this.trustedDevices = [];
                }
                
                // Безопасная проверка наличия устройства в списке
                let existingDevice = false;
                if (Array.isArray(this.trustedDevices)) {
                    existingDevice = this.trustedDevices.some(device => device.id === targetDeviceId);
                }
                
                // Если устройства нет в списке, добавляем его
                if (!existingDevice) {
                    const newDevice: DeviceInfo = {
                        id: targetDeviceId,
                        name: "Новое устройство" // Имя обновится позже от сервера
                    };
                    
                    // Добавляем в список доверенных
                    this.trustedDevices = [...this.trustedDevices, newDevice];
                    
                    // Уведомляем об изменении списка доверенных устройств
                    this.onTrustedDevicesChangeCallback(this.trustedDevices);
                    console.log("Список доверенных устройств обновлен локально");
                }
            }
            
            // Всегда возвращаем успех, не дожидаясь ответа от сервера
            return true;
        } catch (error) {
            console.error("Error responding to sync request:", error);
            return false;
        }
    }

    /**
     * Отзыв доверия устройству
     */
    public async revokeTrust(deviceId: string): Promise<boolean> {
        try {
            const response = await this.sendMessageWithResponse({
                type: "revokeTrust",
                targetDeviceId: deviceId
            });

            if (response.success) {
                // Обновляем список доверенных устройств
                this.trustedDevices = this.trustedDevices.filter(device => device.id !== deviceId);
                this.onTrustedDevicesChangeCallback(this.trustedDevices);
            }

            return response.success;
        } catch (error) {
            console.error("Error revoking trust:", error);
            return false;
        }
    }

    /**
     * Обработчик успешного подключения
     */
    private handleOpen(): void {
        console.log("WebSocket connected");
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.onConnectionChangeCallback(true);

        // Регистрируем устройство на сервере
        this.registerDevice();

        // Запускаем отправку пинг-сообщений для поддержания соединения
        this.startHeartbeat();
    }

    /**
     * Регистрация устройства на сервере
     */
    private registerDevice(): void {
        this.sendMessage({
            type: "register",
            deviceName: this.deviceName
        });

        // Запрашиваем список доверенных устройств
        this.requestTrustedDevices();
    }

    /**
     * Запрос списка доверенных устройств
     */
    public requestTrustedDevices(): void {
        console.log("Запрос списка доверенных устройств");
        
        // Теперь сервер поддерживает эту команду, отправляем запрос
        this.sendMessage({
            type: "getTrustedDevices"
        });
        
        // Также инициализируем список, если он пустой
        if (!this.trustedDevices || !Array.isArray(this.trustedDevices)) {
            this.trustedDevices = [];
        }
    }

    /**
     * Обработчик получения сообщения
     */
    private handleMessage(event: MessageEvent): void {
        try {
            const message = JSON.parse(event.data) as SyncMessage;
            console.log("Received WebSocket message:", message);

            // 1. Обработка сообщений с requestId (ответы на запросы)
            if (message.requestId && this.messageCallbacks.has(message.requestId)) {
                console.log("Обработка ответа на запрос:", message.requestId);
                const callback = this.messageCallbacks.get(message.requestId);
                this.messageCallbacks.delete(message.requestId);
                if (callback) callback(message);
                return;
            }
            
            // 2. Обработка по типу сообщения
            switch (message.type) {
                case "pong":
                    // Просто подтверждение активности сервера
                    break;

                case "invitationKey":
                    // Ключ приглашения
                    console.log("Получен ключ приглашения:", message.key);
                    this.onMessageCallback(message);
                    break;
                    
                case "trustedDevices":
                    // Обновление списка доверенных устройств
                    console.log("Получен список доверенных устройств");
                    // Обрабатываем массив устройств из свойства devices (новый формат сервера)
                    if (message.devices && Array.isArray(message.devices)) {
                        this.handleTrustedDevicesUpdate(message.devices);
                    } else if (message.payload) {
                        // Оставляем обратную совместимость со старым форматом
                        this.handleTrustedDevicesUpdate(message.payload);
                    } else {
                        // Если список пустой или отсутствует, инициализируем пустой массив
                        this.handleTrustedDevicesUpdate([]);
                    }
                    break;

                case "syncRequest":
                    // Запрос на синхронизацию
                    console.log("Получен запрос на синхронизацию от устройства:", 
                        message.sourceName || message.sourceDeviceId);
                    this.handleSyncRequest(message);
                    break;

                case "syncResponseReceived":
                    // Получено подтверждение принятия запроса
                    console.log("Получен ответ на запрос синхронизации:", 
                        message.accepted ? "ПРИНЯТ" : "ОТКЛОНЕН");
                    
                    // Если принято, обновляем локальный список доверенных устройств
                    if (message.accepted && message.sourceDeviceId) {
                        console.log("Запрос принят, обновляем локальный список доверенных устройств");
                        
                        // Инициализируем массив, если он не определен
                        if (!this.trustedDevices) {
                            this.trustedDevices = [];
                        }
                        
                        // Безопасная проверка наличия устройства в списке
                        let existingIndex = -1;
                        if (Array.isArray(this.trustedDevices)) {
                            existingIndex = this.trustedDevices.findIndex(d => 
                                d && d.id === message.sourceDeviceId
                            );
                        }
                        
                        if (existingIndex === -1) {
                            // Если устройства нет в списке, добавляем его
                            this.trustedDevices.push({
                                id: message.sourceDeviceId,
                                name: message.deviceName || "Устройство " + message.sourceDeviceId.substring(0, 8)
                            });
                            
                            // Уведомляем об изменении
                            this.onTrustedDevicesChangeCallback(this.trustedDevices);
                            console.log("Добавлено новое доверенное устройство:", message.sourceDeviceId);
                            
                            // Запрашиваем обновление списка доверенных устройств от сервера
                            setTimeout(() => {
                                this.requestTrustedDevices();
                            }, 1000);
                        }
                    }
                    
                    this.onMessageCallback(message);
                    break;
                    
                case "trustRevoked":
                    // Отзыв доверия
                    console.log("Получено уведомление об отзыве доверия");
                    this.handleTrustRevoked(message);
                    break;

                case "trustExpired":
                    // Истечение срока доверия
                    console.log("Получено уведомление об истечении срока доверия");
                    this.handleTrustExpired(message);
                    break;

                case "message":
                    // Проверяем, содержит ли сообщение payload с метаданными файла
                    // Это может быть сообщение fileSync, преобразованное сервером
                    if (message.payload) {
                        const payload = message.payload;
                        // Проверяем, что payload это объект и содержит признаки файловой операции
                        if (typeof payload === 'object' && payload !== null && 
                            ('path' in payload || 'encryptedData' in payload || 'deleted' in payload)) {
                            console.log("Получены данные файловой синхронизации (тип message)");
                            
                            // Преобразуем обратно в тип fileSync для обратной совместимости
                            const fileSyncMessage: SyncMessage = {
                                ...message,
                                type: "fileSync"
                            };
                            
                            // Передаем модифицированное сообщение в обработчик
                            this.onMessageCallback(fileSyncMessage);
                            break;
                        }
                    }
                    
                    // Если это обычное сообщение, передаем как есть
                    console.log("Получено обычное сообщение с данными");
                    this.onMessageCallback(message);
                    break;
                    
                case "error":
                    // Сообщение об ошибке
                    console.error("Получена ошибка от сервера:", message.message);
                    this.onMessageCallback(message);
                    break;

                default:
                    // Все остальные типы сообщений
                    console.log("Получено сообщение неизвестного типа:", message.type);
                    this.onMessageCallback(message);
                    break;
            }
        } catch (error) {
            console.error("Error parsing message:", error);
        }
    }

    /**
     * Обработка обновления списка доверенных устройств
     */
    private handleTrustedDevicesUpdate(devices: DeviceInfo[]): void {
        console.log("Обновление списка доверенных устройств:", devices);
        
        // Защита от undefined или null
        if (!devices) {
            console.log("Получен пустой список доверенных устройств, инициализируем пустой массив");
            this.trustedDevices = [];
            this.onTrustedDevicesChangeCallback([]);
            return;
        }
        
        // Фильтруем некорректные записи
        const validDevices = Array.isArray(devices) 
            ? devices.filter(d => d && typeof d === 'object' && d.id) 
            : [];
        
        console.log(`Обработано ${validDevices.length} доверенных устройств`);
        
        // Обновляем список
        this.trustedDevices = validDevices;
        this.onTrustedDevicesChangeCallback(validDevices);
    }

    /**
     * Обработка запроса на синхронизацию
     */
    private handleSyncRequest(request: SyncMessage): void {
        // Сохраняем запрос в списке ожидающих
        if (request.requestId) {
            this.pendingRequests.set(request.requestId, request);
        }

        // Передаем запрос в обработчик
        this.onSyncRequestCallback(request);
    }

    /**
     * Обработка отзыва доверия
     */
    private handleTrustRevoked(message: SyncMessage): void {
        if (message.sourceDeviceId) {
            // Удаляем устройство из списка доверенных
            this.trustedDevices = this.trustedDevices.filter(
                device => device.id !== message.sourceDeviceId
            );
            this.onTrustedDevicesChangeCallback(this.trustedDevices);
        }
    }

    /**
     * Обработка истечения срока доверия
     */
    private handleTrustExpired(message: SyncMessage): void {
        if (message.sourceDeviceId) {
            // Удаляем устройство из списка доверенных
            this.trustedDevices = this.trustedDevices.filter(
                device => device.id !== message.sourceDeviceId
            );
            this.onTrustedDevicesChangeCallback(this.trustedDevices);
        }
    }

    /**
     * Обработчик закрытия соединения
     */
    private handleClose(event: CloseEvent): void {
        console.log(`WebSocket disconnected with code: ${event.code}, reason: ${event.reason}`);
        this.isConnected = false;
        this.onConnectionChangeCallback(false);
        this.stopHeartbeat();

        // Пытаемся переподключиться, если соединение закрылось не по нашей инициативе
        if (this.ws) {
            this.scheduleReconnect();
        }
    }

    /**
     * Обработчик ошибки соединения
     */
    private handleError(error: Event): void {
        console.error("WebSocket error:", error);
    }

    /**
     * Планирование переподключения
     */
    private scheduleReconnect(): void {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.log("Maximum reconnect attempts reached");
            return;
        }

        // Экспоненциальное увеличение времени между попытками
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
        this.reconnectAttempts++;

        console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        this.reconnectTimeout = setTimeout(() => {
            console.log("Attempting to reconnect...");
            this.connect();
        }, delay);
    }

    /**
     * Начать отправку пинг-сообщений
     */
    private startHeartbeat(): void {
        this.heartbeatInterval = setInterval(() => {
            if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.sendMessage({ type: "ping" });
            }
        }, 30000); // 30 секунд
    }

    /**
     * Остановить отправку пинг-сообщений
     */
    private stopHeartbeat(): void {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    /**
     * Генерация уникального идентификатора запроса
     */
    private generateRequestId(): string {
        return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    }

    /**
     * Получить список доверенных устройств
     */
    public getTrustedDevices(): DeviceInfo[] {
        return [...this.trustedDevices];
    }

    /**
     * Проверить, является ли устройство доверенным
     */
    public isDeviceTrusted(deviceId: string): boolean {
        return this.trustedDevices.some(device => device.id === deviceId);
    }
}