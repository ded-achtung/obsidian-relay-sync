import { App, Modal, Setting, ButtonComponent } from 'obsidian';
import { UpdateInfo } from '../utils/github-updater';

/**
 * Модальное окно для отображения информации об обновлении
 */
export class UpdateModal extends Modal {
    private updateInfo: UpdateInfo;

    constructor(app: App, updateInfo: UpdateInfo) {
        super(app);
        this.updateInfo = updateInfo;
    }

    onOpen() {
        const { contentEl } = this;
        
        contentEl.empty();
        contentEl.addClass('relay-sync-update-modal');
        
        // Заголовок с информацией о версии
        contentEl.createEl('h2', { 
            text: `Доступно обновление: ${this.updateInfo.latestVersion}`,
            cls: 'relay-sync-update-modal-title'
        });
        
        // Информация о текущей версии
        contentEl.createEl('div', {
            text: `Текущая версия: ${this.updateInfo.currentVersion}`,
            cls: 'relay-sync-update-modal-current-version'
        });
        
        // Дата публикации
        const publishDate = new Date(this.updateInfo.publishedAt);
        contentEl.createEl('div', {
            text: `Дата выпуска: ${publishDate.toLocaleDateString()}`,
            cls: 'relay-sync-update-modal-date'
        });
        
        // Разделитель
        contentEl.createEl('hr');
        
        // Заголовок для примечаний к выпуску
        contentEl.createEl('h3', {
            text: 'Примечания к выпуску:',
            cls: 'relay-sync-update-modal-notes-title'
        });
        
        // Контейнер для примечаний к выпуску
        const notesContainer = contentEl.createDiv({
            cls: 'relay-sync-update-modal-notes'
        });
        
        // Заполняем примечания к выпуску, преобразуя их в HTML
        notesContainer.innerHTML = this.updateInfo.releaseNotes || 'Информация о выпуске недоступна';
        
        // Разделитель
        contentEl.createEl('hr');
        
        // Контейнер для кнопок
        const buttonContainer = contentEl.createDiv({
            cls: 'relay-sync-update-modal-buttons'
        });
        
        // Кнопка для перехода на страницу релиза
        new ButtonComponent(buttonContainer)
            .setButtonText('Открыть страницу релиза')
            .setCta()
            .onClick(() => {
                window.open(this.updateInfo.releaseUrl, '_blank');
            });
        
        // Кнопка для закрытия окна
        new ButtonComponent(buttonContainer)
            .setButtonText('Закрыть')
            .onClick(() => {
                this.close();
            });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}