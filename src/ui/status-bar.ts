/**
 * Компонент для отображения статуса синхронизации в статусной строке Obsidian
 */
import { setIcon, moment } from 'obsidian';

export enum SyncStatus {
    DISCONNECTED = 'disconnected',
    CONNECTED = 'connected',
    SYNCING = 'syncing',
    ERROR = 'error'
}

export interface SyncStats {
    lastSyncTime?: number;      // Время последней синхронизации 
    filesTotal?: number;        // Общее количество файлов
    filesChanged?: number;      // Количество измененных файлов
    syncProgress?: number;      // Прогресс синхронизации (0-100%)
    trustedDevices?: number;    // Количество доверенных устройств
    errorMessage?: string;      // Сообщение об ошибке
}

export class StatusBarItem {
    private statusBarEl: HTMLElement;
    private status: SyncStatus = SyncStatus.DISCONNECTED;
    private syncingAnimationInterval: NodeJS.Timeout | null = null;
    private dots = 0;
    private stats: SyncStats = {};
    private showDetailedStatus: boolean = true;

    constructor(statusBarEl: HTMLElement) {
        this.statusBarEl = statusBarEl;
        this.statusBarEl.classList.add('relay-sync-statusbar');
        
        // Добавляем обработчик кликов для переключения подробной информации
        this.statusBarEl.addEventListener('click', this.toggleDetailedStatus.bind(this));
        
        this.render();
    }

    /**
     * Обновить статус синхронизации
     */
    public setStatus(status: SyncStatus, stats?: Partial<SyncStats>): void {
        const statusChanged = this.status !== status;
        this.status = status;

        // Обновляем статистику, если предоставлена
        if (stats) {
            this.stats = { ...this.stats, ...stats };
        }

        // Остановить анимацию синхронизации, если она запущена и статус изменился
        if (statusChanged && this.syncingAnimationInterval) {
            clearInterval(this.syncingAnimationInterval);
            this.syncingAnimationInterval = null;
        }

        // Запустить анимацию, если статус "синхронизация"
        if (status === SyncStatus.SYNCING && statusChanged) {
            this.startSyncingAnimation();
        }

        this.render();
    }

    /**
     * Переключить режим отображения подробной информации
     */
    private toggleDetailedStatus(): void {
        this.showDetailedStatus = !this.showDetailedStatus;
        this.render();
    }

    /**
     * Форматировать время в относительном формате
     */
    private formatTime(timestamp: number): string {
        return moment(timestamp).fromNow();
    }

    /**
     * Отрендерить компонент статусной строки
     */
    private render(): void {
        this.statusBarEl.empty();

        // Иконка в зависимости от статуса
        const iconContainer = this.statusBarEl.createSpan({
            cls: 'relay-sync-statusbar-icon'
        });

        // Основной контейнер для текста
        const textContainer = this.statusBarEl.createSpan({
            cls: 'relay-sync-statusbar-text'
        });

        // Контейнер для подробной информации, отображается только при showDetailedStatus = true
        const detailsContainer = this.statusBarEl.createDiv({
            cls: 'relay-sync-statusbar-details'
        });
        detailsContainer.style.display = this.showDetailedStatus ? 'flex' : 'none';

        // Настраиваем отображение в зависимости от статуса
        switch (this.status) {
            case SyncStatus.CONNECTED:
                setIcon(iconContainer, 'cloud');
                iconContainer.classList.add('relay-sync-statusbar-connected');
                textContainer.textContent = 'Синхронизация: Подключено';
                
                // Формируем подсказку с информацией
                let connectedTooltip = 'Подключено к серверу синхронизации';
                
                if (this.stats.lastSyncTime) {
                    connectedTooltip += `\nПоследняя синхронизация: ${this.formatTime(this.stats.lastSyncTime)}`;
                }
                
                if (this.stats.trustedDevices !== undefined) {
                    connectedTooltip += `\nДоверенных устройств: ${this.stats.trustedDevices}`;
                }
                
                if (this.stats.filesTotal !== undefined) {
                    connectedTooltip += `\nСинхронизировано файлов: ${this.stats.filesTotal}`;
                }
                
                this.statusBarEl.title = connectedTooltip;
                break;
                
            case SyncStatus.DISCONNECTED:
                setIcon(iconContainer, 'cloud-off');
                iconContainer.classList.add('relay-sync-statusbar-disconnected');
                textContainer.textContent = 'Синхронизация: Отключено';
                this.statusBarEl.title = 'Отключено от сервера синхронизации';
                break;
                
            case SyncStatus.SYNCING:
                setIcon(iconContainer, 'cloud-sync');
                iconContainer.classList.add('relay-sync-statusbar-syncing');
                textContainer.textContent = 'Синхронизация...';
                
                let syncingTooltip = 'Выполняется синхронизация';
                
                if (this.stats.syncProgress !== undefined) {
                    syncingTooltip += `\nПрогресс: ${this.stats.syncProgress}%`;
                }
                
                if (this.stats.filesChanged !== undefined) {
                    syncingTooltip += `\nСинхронизируется файлов: ${this.stats.filesChanged}`;
                }
                
                this.statusBarEl.title = syncingTooltip;
                break;
                
            case SyncStatus.ERROR:
                setIcon(iconContainer, 'alert-triangle');
                iconContainer.classList.add('relay-sync-statusbar-error');
                textContainer.textContent = 'Синхронизация: Ошибка';
                
                let errorTooltip = 'Ошибка синхронизации';
                if (this.stats.errorMessage) {
                    errorTooltip += `\n${this.stats.errorMessage}`;
                }
                
                this.statusBarEl.title = errorTooltip;
                break;
        }

        // Если включено отображение подробной информации, добавляем детали
        if (this.showDetailedStatus) {
            // Данные о последней синхронизации
            if (this.stats.lastSyncTime) {
                const lastSyncEl = detailsContainer.createDiv({
                    cls: 'relay-sync-detail-item'
                });
                
                setIcon(lastSyncEl.createSpan(), 'clock');
                lastSyncEl.createSpan({
                    text: this.formatTime(this.stats.lastSyncTime)
                });
            }
            
            // Данные о количестве доверенных устройств
            if (this.stats.trustedDevices !== undefined) {
                const devicesEl = detailsContainer.createDiv({
                    cls: 'relay-sync-detail-item'
                });
                
                setIcon(devicesEl.createSpan(), 'devices');
                devicesEl.createSpan({
                    text: `${this.stats.trustedDevices}`
                });
            }
            
            // Прогресс синхронизации
            if (this.status === SyncStatus.SYNCING && this.stats.syncProgress !== undefined) {
                const progressEl = detailsContainer.createDiv({
                    cls: 'relay-sync-detail-item'
                });
                
                setIcon(progressEl.createSpan(), 'percent');
                progressEl.createSpan({
                    text: `${this.stats.syncProgress}%`
                });
            }
        }
    }

    /**
     * Запустить анимацию синхронизации
     */
    private startSyncingAnimation(): void {
        this.dots = 0;
        this.syncingAnimationInterval = setInterval(() => {
            this.dots = (this.dots + 1) % 4;
            const dotsText = '.'.repeat(this.dots);
            
            const textContainer = this.statusBarEl.querySelector('.relay-sync-statusbar-text');
            if (textContainer) {
                textContainer.textContent = `Синхронизация${dotsText}`;
            }
        }, 500);
    }
}