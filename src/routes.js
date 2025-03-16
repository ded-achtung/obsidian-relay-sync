const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const auth = require('./auth');

/**
 * Обработка входящих сообщений WebSocket
 */
function handleMessage(data, ws, context) {
  const { deviceId, connections, setDeviceId } = context;
  
  // Маршрутизация сообщений по типу
  switch (data.type) {
    // Регистрация устройства
    case 'register':
      handleRegister(data, ws, context);
      break;
    
    // Генерация ключа приглашения
    case 'generateInvitationKey':
      handleGenerateKey(data, ws, deviceId);
      break;
    
    // Использование ключа приглашения
    case 'useInvitationKey':
      handleUseKey(data, ws, deviceId, context);  // Добавлен параметр context
      break;
    
    // Ответ на запрос синхронизации
    case 'syncResponse':
      handleSyncResponse(data, ws, deviceId, connections);
      break;
    
    // Пересылка сообщения
    case 'relay':
      handleRelay(data, ws, deviceId, connections);
      break;
    
    // Отзыв доверия
    case 'revokeTrust':
      handleRevokeTrust(data, ws, deviceId, connections);
      break;
    
    // Ping для поддержания соединения и обновления статуса
    case 'ping':
      if (deviceId) {
        db.updateDeviceStatus(deviceId, true);
        ws.send(JSON.stringify({ type: 'pong' }));
      }
      break;
    
    // Запрос списка доверенных устройств
    case 'getTrustedDevices':
      if (deviceId) {
        const trustedDevices = db.getTrustedDevices(deviceId);
        ws.send(JSON.stringify({
          type: 'trustedDevices',
          devices: trustedDevices
        }));
      }
      break;
    
    default:
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Неизвестный тип сообщения'
      }));
  }
}

/**
 * Обработка регистрации устройства
 */
function handleRegister(data, ws, context) {
  const { connections, setDeviceId } = context;
  
  // Получаем или генерируем ID устройства
  const deviceId = data.deviceId || auth.generateDeviceId();
  const deviceName = data.deviceName || 'Неизвестное устройство';
  
  // Сохраняем информацию об устройстве
  db.registerDevice(deviceId, deviceName);
  
  // Сохраняем соединение
  connections.set(deviceId, ws);
  setDeviceId(deviceId);
  
  // Отправляем подтверждение
  ws.send(JSON.stringify({
    type: 'registered',
    deviceId,
    message: 'Устройство зарегистрировано'
  }));
  
  // Отправляем список доверенных устройств
  const trustedDevices = db.getTrustedDevices(deviceId);
  ws.send(JSON.stringify({
    type: 'trustedDevices',
    devices: trustedDevices
  }));
}

/**
 * Обработка запроса на генерацию ключа
 */
function handleGenerateKey(data, ws, deviceId) {
  if (!deviceId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Устройство не зарегистрировано'
    }));
    return;
  }
  
  // Генерируем ключ
  const { key, expiresAt } = auth.generateInvitationKey(deviceId);
  
  // Отправляем ключ клиенту
  ws.send(JSON.stringify({
    type: 'invitationKey',
    key,
    expiresAt
  }));
}

/**
 * Обработка использования ключа приглашения
 */
function handleUseKey(data, ws, deviceId, context) {  // Исправлено: добавлен параметр context
  if (!deviceId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Устройство не зарегистрировано'
    }));
    return;
  }
  
  const { key } = data;
  
  // Проверяем ключ
  const validation = auth.validateInvitationKey(key);
  
  if (!validation.valid) {
    ws.send(JSON.stringify({
      type: 'error',
      message: validation.message
    }));
    return;
  }
  
  const targetDeviceId = validation.deviceId;
  
  // Отправляем запрос на подтверждение
  const { connections } = context;  // Исправлено: получаем connections из context
  
  if (connections.has(targetDeviceId)) {
    // Создаем ID запроса
    const requestId = uuidv4();
    
    // Получаем имя устройства
    const deviceName = data.deviceName || 'Неизвестное устройство';
    
    // Отправляем запрос на синхронизацию целевому устройству
    connections.get(targetDeviceId).send(JSON.stringify({
      type: 'syncRequest',
      sourceDeviceId: deviceId,
      sourceName: deviceName,
      requestId
    }));
    
    // Помечаем ключ как использованный
    auth.useInvitationKey(key);
    
    // Отправляем подтверждение
    ws.send(JSON.stringify({
      type: 'syncRequestSent',
      message: 'Запрос на синхронизацию отправлен, ожидайте подтверждения'
    }));
  } else {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Устройство, создавшее приглашение, не в сети'
    }));
  }
}

/**
 * Обработка ответа на запрос синхронизации
 */
function handleSyncResponse(data, ws, deviceId, connections) {
  if (!deviceId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Устройство не зарегистрировано'
    }));
    return;
  }
  
  const { targetDeviceId, accept, requestId, trustPermanently, expirationHours } = data;
  
  // Если запрос принят, устанавливаем доверие
  if (accept) {
    // Создаем двустороннее доверие
    auth.establishTrust(deviceId, targetDeviceId, expirationHours);
    auth.establishTrust(targetDeviceId, deviceId, expirationHours);
  }
  
  // Отправляем ответ целевому устройству
  if (connections.has(targetDeviceId)) {
    connections.get(targetDeviceId).send(JSON.stringify({
      type: 'syncResponseReceived',
      accepted: accept,
      requestId,
      sourceDeviceId: deviceId
    }));
  }
}

/**
 * Обработка пересылки сообщения
 */
function handleRelay(data, ws, deviceId, connections) {
  if (!deviceId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Устройство не зарегистрировано'
    }));
    return;
  }
  
  const { targetId, payload, oneTimeSync } = data;
  
  // Проверяем, является ли устройство доверенным или это разовая синхронизация
  const isTrusted = oneTimeSync || auth.checkTrust(deviceId, targetId);
  
  if (isTrusted) {
    // Пересылаем сообщение, если устройство в сети
    if (connections.has(targetId)) {
      connections.get(targetId).send(JSON.stringify({
        type: 'message',
        sourceId: deviceId,
        payload,
        oneTimeSync
      }));
    } else {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Целевое устройство не в сети'
      }));
    }
  } else {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Устройство не является доверенным, требуется повторная синхронизация'
    }));
  }
}

/**
 * Обработка отзыва доверия
 */
function handleRevokeTrust(data, ws, deviceId, connections) {
  if (!deviceId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Устройство не зарегистрировано'
    }));
    return;
  }
  
  const { targetId } = data;
  
  // Удаляем доверие в обоих направлениях
  auth.revokeTrust(deviceId, targetId);
  auth.revokeTrust(targetId, deviceId);
  
  // Оповещаем второе устройство, если оно онлайн
  if (connections.has(targetId)) {
    connections.get(targetId).send(JSON.stringify({
      type: 'trustRevoked',
      deviceId: deviceId
    }));
  }
  
  // Отправляем подтверждение
  ws.send(JSON.stringify({
    type: 'trustRevokeConfirmed',
    targetId
  }));
}

module.exports = {
  handleMessage
};