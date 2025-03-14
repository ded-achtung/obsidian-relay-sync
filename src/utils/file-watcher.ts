/**
 * Модуль для отслеживания изменений файлов в хранилище Obsidian
 */
import { TAbstractFile, TFile, Vault } from 'obsidian';

export interface FileChange {
    path: string;
    type: 'create' | 'modify' | 'delete' | 'rename';
    file: TFile;
    oldPath?: string;
    timestamp: number;
}

export class FileWatcher {
    private vault: Vault;
    private onChangeCallback: (change: FileChange) => void;
    private ignoredPatterns: RegExp[] = [
        /\.git\//,            // Git-файлы
        /\.obsidian\//,       // Настройки Obsidian
        /\.DS_Store/,         // Служебные файлы macOS
        /Thumbs\.db/,         // Служебные файлы Windows
        /\.sync\//,           // Папка синхронизации
        /\.trash\//           // Корзина
    ];
    private ignoredExtensions: string[] = [
        '.tmp', '.temp', '.swp', '.bak'
    ];

    constructor(vault: Vault, onChange: (change: FileChange) => void) {
        this.vault = vault;
        this.onChangeCallback = onChange;
    }

    /**
     * Запустить отслеживание изменений файлов
     */
    public startWatching(): void {
        // Слушать создание файлов
        this.vault.on('create', this.handleFileCreate.bind(this));
        
        // Слушать изменение файлов
        this.vault.on('modify', this.handleFileModify.bind(this));
        
        // Слушать удаление файлов
        this.vault.on('delete', this.handleFileDelete.bind(this));
        
        // Слушать переименование файлов
        this.vault.on('rename', this.handleFileRename.bind(this));
    }

    /**
     * Остановить отслеживание изменений файлов
     */
    public stopWatching(): void {
        this.vault.off('create', this.handleFileCreate.bind(this));
        this.vault.off('modify', this.handleFileModify.bind(this));
        this.vault.off('delete', this.handleFileDelete.bind(this));
        this.vault.off('rename', this.handleFileRename.bind(this));
    }

    /**
     * Добавить паттерн для игнорирования файлов
     */
    public addIgnorePattern(pattern: RegExp): void {
        this.ignoredPatterns.push(pattern);
    }

    /**
     * Добавить расширение для игнорирования файлов
     */
    public addIgnoreExtension(extension: string): void {
        this.ignoredExtensions.push(extension);
    }

    /**
     * Проверить, должен ли файл быть проигнорирован
     */
    private shouldIgnore(path: string): boolean {
        // Проверяем по паттернам
        for (const pattern of this.ignoredPatterns) {
            if (pattern.test(path)) {
                return true;
            }
        }

        // Проверяем по расширениям
        for (const ext of this.ignoredExtensions) {
            if (path.endsWith(ext)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Обработчик создания файла
     */
    private handleFileCreate(file: TAbstractFile): void {
        if (!(file instanceof TFile) || this.shouldIgnore(file.path)) {
            return;
        }

        this.onChangeCallback({
            path: file.path,
            type: 'create',
            file: file,
            timestamp: Date.now()
        });
    }

    /**
     * Обработчик изменения файла
     */
    private handleFileModify(file: TAbstractFile): void {
        if (!(file instanceof TFile) || this.shouldIgnore(file.path)) {
            return;
        }

        this.onChangeCallback({
            path: file.path,
            type: 'modify',
            file: file,
            timestamp: Date.now()
        });
    }

    /**
     * Обработчик удаления файла
     */
    private handleFileDelete(file: TAbstractFile): void {
        if (!(file instanceof TFile) || this.shouldIgnore(file.path)) {
            return;
        }

        this.onChangeCallback({
            path: file.path,
            type: 'delete',
            file: file,
            timestamp: Date.now()
        });
    }

    /**
     * Обработчик переименования файла
     */
    private handleFileRename(file: TAbstractFile, oldPath: string): void {
        if (!(file instanceof TFile) || this.shouldIgnore(file.path)) {
            return;
        }

        this.onChangeCallback({
            path: file.path,
            oldPath: oldPath,
            type: 'rename',
            file: file,
            timestamp: Date.now()
        });
    }

    /**
     * Получить текущее состояние всех файлов
     */
    public async scanAllFiles(): Promise<FileChange[]> {
        const files = this.vault.getFiles();
        const changes: FileChange[] = [];

        for (const file of files) {
            if (this.shouldIgnore(file.path)) {
                continue;
            }

            changes.push({
                path: file.path,
                type: 'create', // Используем 'create' как тип при сканировании
                file: file,
                timestamp: file.stat.mtime // Используем время модификации файла
            });
        }

        return changes;
    }
}