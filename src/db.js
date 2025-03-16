const Database = require('better-sqlite3');
const config = require('config');
const path = require('path');
const fs = require('fs');

let db;

/**
 * Инициализация базы данных
 */
function initialize() {
  const dbPath = config.get('database.path');
  
  // Создаем директорию, если не существует
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  
  db = new Database(dbPath);
  
  // Включение внешних ключей для целостности данных
  db.pragma('foreign_keys = ON');
  
  // Создание таблиц
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      last_seen TIMESTAMP,
      is_online BOOLEAN DEFAULT 0
    );
    
    CREATE TABLE IF NOT EXISTS invitation_keys (
      key TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      used BOOLEAN DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE
    );
    
    CREATE TABLE IF NOT EXISTS trusted_devices (
      device_id TEXT NOT NULL,
      trusted_device_id TEXT NOT NULL,
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (device_id, trusted_device_id),
      FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE,
      FOREIGN KEY (trusted_device_id) REFERENCES devices (id) ON DELETE CASCADE
    );
  `);
  
  // Индексы для оптимизации запросов
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_invitation_keys_expires 
      ON invitation_keys (expires_at);
    
    CREATE INDEX IF NOT EXISTS idx_trusted_devices_device 
      ON trusted_devices (device_id);
      
    CREATE INDEX IF NOT EXISTS idx_trusted_devices_trusted 
      ON trusted_devices (trusted_device_id);
  `);
  
  // Запланированная очистка устаревших записей
  scheduleCleanup();
}

/**
 * Планирование регулярной очистки устаревших данных
 */
function scheduleCleanup() {
  // Очистка каждый час
  setInterval(() => {
    try {
      // Удаление просроченных ключей
      db.prepare(`
        DELETE FROM invitation_keys 
        WHERE expires_at < datetime('now')
      `).run();
      
      // Удаление просроченных отношений доверия
      db.prepare(`
        DELETE FROM trusted_devices 
        WHERE expires_at IS NOT NULL AND expires_at < datetime('now')
      `).run();
      
    } catch (error) {
      console.error('Ошибка при очистке БД:', error);
    }
  }, 3600000); // 1 час
}

/**
 * Регистрация устройства
 */
function registerDevice(deviceId, deviceName) {
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO devices (id, name, last_seen, is_online)
      VALUES (?, ?, datetime('now'), 1)
    `);
    
    stmt.run(deviceId, deviceName);
    return true;
  } catch (error) {
    console.error('Ошибка при регистрации устройства:', error);
    return false;
  }
}

/**
 * Обновление статуса устройства
 */
function updateDeviceStatus(deviceId, isOnline) {
  try {
    const stmt = db.prepare(`
      UPDATE devices 
      SET is_online = ?, last_seen = datetime('now')
      WHERE id = ?
    `);
    
    stmt.run(isOnline ? 1 : 0, deviceId);
    return true;
  } catch (error) {
    console.error('Ошибка при обновлении статуса устройства:', error);
    return false;
  }
}

/**
 * Создание ключа приглашения
 */
function createInvitationKey(key, deviceId, expirationMinutes) {
  try {
    const stmt = db.prepare(`
      INSERT INTO invitation_keys (key, device_id, expires_at)
      VALUES (?, ?, datetime('now', '+' || ? || ' minutes'))
    `);
    
    stmt.run(key, deviceId, expirationMinutes);
    return true;
  } catch (error) {
    console.error('Ошибка при создании ключа приглашения:', error);
    return false;
  }
}

/**
 * Получение информации о ключе приглашения
 */
function getInvitationKey(key) {
  try {
    const stmt = db.prepare(`
      SELECT 
        key, device_id as deviceId, 
        expires_at as expiresAt, used 
      FROM invitation_keys
      WHERE key = ?
    `);
    
    return stmt.get(key);
  } catch (error) {
    console.error('Ошибка при получении ключа приглашения:', error);
    return null;
  }
}

/**
 * Пометить ключ приглашения как использованный
 */
function markKeyAsUsed(key) {
  try {
    const stmt = db.prepare(`
      UPDATE invitation_keys
      SET used = 1
      WHERE key = ?
    `);
    
    stmt.run(key);
    return true;
  } catch (error) {
    console.error('Ошибка при обновлении ключа приглашения:', error);
    return false;
  }
}

/**
 * Добавление доверенного устройства
 */
function addTrustedDevice(deviceId, trustedDeviceId, expirationHours = null) {
  try {
    let expiresAt = null;
    if (expirationHours) {
      expiresAt = `datetime('now', '+${expirationHours} hours')`;
    }
    
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO trusted_devices 
        (device_id, trusted_device_id, expires_at)
      VALUES (?, ?, ${expirationHours ? expiresAt : 'NULL'})
    `);
    
    stmt.run(deviceId, trustedDeviceId);
    return true;
  } catch (error) {
    console.error('Ошибка при добавлении доверенного устройства:', error);
    return false;
  }
}

/**
 * Удаление доверенного устройства
 */
function removeTrustedDevice(deviceId, trustedDeviceId) {
  try {
    const stmt = db.prepare(`
      DELETE FROM trusted_devices
      WHERE device_id = ? AND trusted_device_id = ?
    `);
    
    stmt.run(deviceId, trustedDeviceId);
    return true;
  } catch (error) {
    console.error('Ошибка при удалении доверенного устройства:', error);
    return false;
  }
}

/**
 * Проверка, является ли устройство доверенным
 */
function isTrustedDevice(deviceId, targetDeviceId) {
  try {
    const stmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM trusted_devices
      WHERE device_id = ? 
        AND trusted_device_id = ?
        AND (expires_at IS NULL OR expires_at > datetime('now'))
    `);
    
    const result = stmt.get(deviceId, targetDeviceId);
    return result && result.count > 0;
  } catch (error) {
    console.error('Ошибка при проверке доверенного устройства:', error);
    return false;
  }
}

/**
 * Получение списка доверенных устройств
 */
function getTrustedDevices(deviceId) {
  try {
    const stmt = db.prepare(`
      SELECT 
        d.id, d.name, d.is_online as isOnline, 
        td.expires_at as expiresAt
      FROM trusted_devices td
      JOIN devices d ON td.trusted_device_id = d.id
      WHERE td.device_id = ?
        AND (td.expires_at IS NULL OR td.expires_at > datetime('now'))
    `);
    
    return stmt.all(deviceId);
  } catch (error) {
    console.error('Ошибка при получении списка доверенных устройств:', error);
    return [];
  }
}

/**
 * Закрытие соединения с БД
 */
function close() {
  if (db) {
    db.close();
  }
}

module.exports = {
  initialize,
  registerDevice,
  updateDeviceStatus,
  createInvitationKey,
  getInvitationKey,
  markKeyAsUsed,
  addTrustedDevice,
  removeTrustedDevice,
  isTrustedDevice,
  getTrustedDevices,
  close
};