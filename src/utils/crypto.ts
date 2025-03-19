/**
 * Утилиты для шифрования и дешифрования данных
 * Использует AES-GCM для шифрования и PBKDF2 для генерации ключей
 */

export interface EncryptedData {
    iv: string;        // Initialization Vector (IV) в формате Base64
    data: string;      // Зашифрованные данные в формате Base64
    authTag: string;   // Authentication Tag в формате Base64
}

export class CryptoHelper {
    private static readonly ALGORITHM = 'AES-GCM';
    private static readonly KEY_LENGTH = 256; // bits
    private static readonly SALT_LENGTH = 16; // bytes
    private static readonly IV_LENGTH = 12;   // bytes
    private static readonly ITERATIONS = 100000;

    /**
     * Генерирует криптографически стойкий ключ из пароля
     */
    public static async generateKey(password: string, salt?: Uint8Array): Promise<{ key: CryptoKey, salt: Uint8Array }> {
        const encoder = new TextEncoder();
        const passwordBuffer = encoder.encode(password);
        
        // Генерируем соль, если не предоставлена
        if (!salt) {
            salt = crypto.getRandomValues(new Uint8Array(this.SALT_LENGTH));
        }

        // Генерируем ключ из пароля с использованием PBKDF2
        const keyMaterial = await crypto.subtle.importKey(
            'raw',
            passwordBuffer,
            { name: 'PBKDF2' },
            false,
            ['deriveKey']
        );

        const key = await crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt,
                iterations: this.ITERATIONS,
                hash: 'SHA-256'
            },
            keyMaterial,
            { name: this.ALGORITHM, length: this.KEY_LENGTH },
            false,
            ['encrypt', 'decrypt']
        );

        return { key, salt };
    }

    /**
     * Шифрует данные с использованием AES-GCM
     */
    public static async encrypt(data: string, password: string): Promise<EncryptedData & { salt: string }> {
        const encoder = new TextEncoder();
        const dataBuffer = encoder.encode(data);

        // Генерируем ключ
        const { key, salt } = await this.generateKey(password);

        // Генерируем IV (Initialization Vector)
        const iv = crypto.getRandomValues(new Uint8Array(this.IV_LENGTH));

        // Шифруем данные
        const encryptedBuffer = await crypto.subtle.encrypt(
            {
                name: this.ALGORITHM,
                iv,
                tagLength: 128  // Длина тега аутентификации в битах
            },
            key,
            dataBuffer
        );

        // AES-GCM возвращает объединенные данные + authTag в конце
        const encryptedArray = new Uint8Array(encryptedBuffer);
        const encryptedData = encryptedArray.slice(0, encryptedArray.length - 16);
        const authTag = encryptedArray.slice(encryptedArray.length - 16);

        // Преобразуем в Base64 для удобства хранения и передачи
        return {
            iv: this.arrayBufferToBase64(iv),
            data: this.arrayBufferToBase64(encryptedData),
            authTag: this.arrayBufferToBase64(authTag),
            salt: this.arrayBufferToBase64(salt)
        };
    }

    /**
     * Дешифрует данные, зашифрованные с использованием AES-GCM
     */
    public static async decrypt(encryptedData: EncryptedData & { salt: string }, password: string): Promise<string> {
        try {
            // Преобразуем данные из Base64
            const iv = this.base64ToArrayBuffer(encryptedData.iv);
            const data = this.base64ToArrayBuffer(encryptedData.data);
            const authTag = this.base64ToArrayBuffer(encryptedData.authTag);
            const salt = this.base64ToArrayBuffer(encryptedData.salt);

            // Комбинируем зашифрованные данные и тег аутентификации
            const encryptedBuffer = new Uint8Array(data.byteLength + authTag.byteLength);
            encryptedBuffer.set(new Uint8Array(data), 0);
            encryptedBuffer.set(new Uint8Array(authTag), data.byteLength);

            // Генерируем ключ с той же солью
            const { key } = await this.generateKey(password, new Uint8Array(salt));

            // Дешифруем данные
            const decryptedBuffer = await crypto.subtle.decrypt(
                {
                    name: this.ALGORITHM,
                    iv: new Uint8Array(iv),
                    tagLength: 128
                },
                key,
                encryptedBuffer
            );

            // Преобразуем обратно в строку
            const decoder = new TextDecoder();
            return decoder.decode(decryptedBuffer);
        } catch (error) {
            console.error("Decryption failed:", error);
            throw new Error("Не удалось расшифровать данные. Возможно, неверный пароль или поврежденные данные.");
        }
    }

    /**
     * Преобразует ArrayBuffer в строку Base64
     */
    private static arrayBufferToBase64(buffer: ArrayBuffer): string {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    /**
     * Преобразует строку Base64 в ArrayBuffer
     */
    private static base64ToArrayBuffer(base64: string): ArrayBuffer {
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
    }

    /**
     * Генерирует уникальный идентификатор устройства
     */
    public static generateDeviceId(): string {
        const array = new Uint8Array(16);
        crypto.getRandomValues(array);
        
        // Преобразуем в UUID-подобную строку
        return Array.from(array, byte => 
            byte.toString(16).padStart(2, '0')
        ).join('');
    }

    /**
     * Хеширует строку с использованием SHA-256
     */
    public static async hashString(str: string): Promise<string> {
        const encoder = new TextEncoder();
        const data = encoder.encode(str);
        const hash = await crypto.subtle.digest('SHA-256', data);
        
        return this.arrayBufferToBase64(hash);
    }

    /**
     * Разделяет файл на фрагменты заданного размера
     */
    public static chunkFile(fileContent: string, chunkSize: number): string[] {
        const chunks = [];
        for (let i = 0; i < fileContent.length; i += chunkSize) {
            chunks.push(fileContent.slice(i, i + chunkSize));
        }
        return chunks;
    }

    /**
     * Собирает файл из фрагментов
     */
    public static reassembleFile(chunks: string[]): string {
        return chunks.join('');
    }
}