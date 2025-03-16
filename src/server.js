const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const config = require('config');
const winston = require('winston');
const db = require('./db');
const auth = require('./auth');
const routes = require('./routes');

// Настройка логирования
const logger = winston.createLogger({
  level: config.get('logging.level'),
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: config.get('logging.file') })
  ]
});

// Инициализация базы данных
db.initialize();

// Создаем Express приложение
const app = express();
const server = http.createServer(app);

// Настройка WebSocket сервера
const wss = new WebSocket.Server({ server });

// Хранение активных соединений
const connections = new Map();

// Обработка HTTP запросов
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    activeConnections: connections.size,
    uptime: process.uptime()
  });
});

// WebSocket подключения
wss.on('connection', (ws) => {
  let deviceId = null;
  
  logger.info('Новое соединение установлено');
  
  // Обработка сообщений
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      // Логируем тип сообщения (но не содержимое для безопасности)
      logger.debug(`Получено сообщение типа: ${data.type}`);
      
      // Маршрутизация сообщений
      routes.handleMessage(data, ws, {
        deviceId,
        connections,
        setDeviceId: (id) => { deviceId = id; }
      });
      
    } catch (error) {
      logger.error('Ошибка обработки сообщения:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Ошибка обработки сообщения'
      }));
    }
  });
  
  // Ping/Pong для поддержания соединения
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30000);
  
  // Обработка закрытия соединения
  ws.on('close', () => {
    clearInterval(pingInterval);
    
    if (deviceId) {
      connections.delete(deviceId);
      logger.info(`Устройство ${deviceId} отключено`);
      
      // Обновляем статус устройства в БД
      db.updateDeviceStatus(deviceId, false);
    }
  });
  
  // Обработка ошибок соединения
  ws.on('error', (error) => {
    logger.error('Ошибка WebSocket:', error);
  });
});

// Запуск сервера
const PORT = config.get('server.port');
const HOST = config.get('server.host');

server.listen(PORT, HOST, () => {
  logger.info(`Сервер запущен на ${HOST}:${PORT}`);
});

// Обработка завершения работы
process.on('SIGTERM', () => {
  logger.info('SIGTERM получен, закрываем сервер...');
  server.close(() => {
    logger.info('Сервер закрыт');
    db.close();
    process.exit(0);
  });
});