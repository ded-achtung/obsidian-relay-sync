/**
 * Утилиты для управления идентификатором устройства
 */
import { CryptoHelper } from './crypto';

// Ключ для хранения идентификатора устройства в LocalStorage
const DEVICE_ID_KEY = 'relay-sync-device-id';
const DEVICE_NAME_KEY = 'relay-sync-device-name';

export class DeviceManager {
    /**
     * Получить идентификатор устройства или создать новый, если не существует
     */
    public static getDeviceId(): string {
        let deviceId = localStorage.getItem(DEVICE_ID_KEY);
        
        if (!deviceId) {
            deviceId = CryptoHelper.generateDeviceId();
            localStorage.setItem(DEVICE_ID_KEY, deviceId);
        }
        
        return deviceId;
    }

    /**
     * Установить идентификатор устройства
     */
    public static setDeviceId(deviceId: string): void {
        localStorage.setItem(DEVICE_ID_KEY, deviceId);
    }

    /**
     * Получить имя устройства или вернуть значение по умолчанию
     */
    public static getDeviceName(): string {
        const deviceName = localStorage.getItem(DEVICE_NAME_KEY);
        
        if (!deviceName) {
            // Генерируем имя устройства на основе типа устройства и случайного числа
            const deviceType = this.detectDeviceType();
            const randomSuffix = Math.floor(Math.random() * 10000);
            const newName = `${deviceType}-${randomSuffix}`;
            
            localStorage.setItem(DEVICE_NAME_KEY, newName);
            return newName;
        }
        
        return deviceName;
    }

    /**
     * Установить имя устройства
     */
    public static setDeviceName(deviceName: string): void {
        localStorage.setItem(DEVICE_NAME_KEY, deviceName);
    }

    /**
     * Определить тип устройства (ПК, Android, iOS)
     */
    private static detectDeviceType(): string {
        const userAgent = navigator.userAgent.toLowerCase();
        
        if (/android/i.test(userAgent)) {
            return 'Android';
        } else if (/iphone|ipad|ipod/i.test(userAgent)) {
            return 'iOS';
        } else if (/windows/i.test(userAgent)) {
            return 'Windows';
        } else if (/macintosh/i.test(userAgent)) {
            return 'Mac';
        } else if (/linux/i.test(userAgent)) {
            return 'Linux';
        } else {
            return 'Unknown';
        }
    }
}