const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const config = require('config');
const db = require('./db');

/**
 * Генерация ключа приглашения
 */
function generateInvitationKey(deviceId) {
  // Создаем случайный ключ из 8 символов (буквы и цифры)
  const key = crypto.randomBytes(4)
    .toString('hex')
    .toUpperCase();
  
  // Сохраняем ключ в БД
  const expirationMinutes = config.get('auth.keyExpirationMinutes');
  db.createInvitationKey(key, deviceId, expirationMinutes);
  
  return {
    key,
    expiresAt: new Date(Date.now() + expirationMinutes * 60000).toISOString()
  };
}

/**
 * Проверка ключа приглашения
 */
function validateInvitationKey(key) {
  // Получаем информацию о ключе
  const keyInfo = db.getInvitationKey(key);
  
  if (!keyInfo) {
    return { 
      valid: false, 
      message: 'Ключ приглашения не существует' 
    };
  }
  
  if (keyInfo.used) {
    return { 
      valid: false, 
      message: 'Ключ приглашения уже использован' 
    };
  }
  
  const expiresAt = new Date(keyInfo.expiresAt);
  if (expiresAt < new Date()) {
    return { 
      valid: false, 
      message: 'Срок действия ключа приглашения истек' 
    };
  }
  
  return { 
    valid: true, 
    deviceId: keyInfo.deviceId 
  };
}

/**
 * Пометить ключ приглашения как использованный
 */
function useInvitationKey(key) {
  return db.markKeyAsUsed(key);
}

/**
 * Проверить доверие между устройствами
 */
function checkTrust(sourceDeviceId, targetDeviceId) {
  return db.isTrustedDevice(sourceDeviceId, targetDeviceId);
}

/**
 * Установить доверие между устройствами
 */
function establishTrust(deviceId, trustedDeviceId, expirationHours = null) {
  return db.addTrustedDevice(deviceId, trustedDeviceId, expirationHours);
}

/**
 * Отозвать доверие
 */
function revokeTrust(deviceId, trustedDeviceId) {
  return db.removeTrustedDevice(deviceId, trustedDeviceId);
}

/**
 * Генерация идентификатора устройства
 */
function generateDeviceId() {
  return uuidv4();
}

module.exports = {
  generateInvitationKey,
  validateInvitationKey,
  useInvitationKey,
  checkTrust,
  establishTrust,
  revokeTrust,
  generateDeviceId
};