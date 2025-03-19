/**
 * Мок-объекты для тестирования
 */

// Мок Obsidian API
export const mockObsidian = {
    Notice: (message: string) => console.log(`NOTICE: ${message}`),
    requestUrl: async () => ({ json: { tag_name: 'v1.0.0' }, status: 200 })
};

// Мок подмена модуля obsidian
// Не подменяем в production, только в тестовой среде
// Обход TypeScript проверки типов для сборки
// if (typeof module !== 'undefined' && typeof require === 'function') {
//     const originalRequire = module.require;
//     module.require = function(id: string) {
//         if (id === 'obsidian') {
//             return mockObsidian;
//         }
//         return originalRequire.apply(this, arguments as any);
//     };
// }

// Определяем глобальный WebSocket, если его нет
if (typeof global !== 'undefined' && !global.WebSocket) {
    global.WebSocket = class MockWebSocket {
        url: string;
        onopen: any = null;
        onmessage: any = null;
        onclose: any = null;
        onerror: any = null;
        readyState = 0;

        constructor(url: string) {
            this.url = url;
            setTimeout(() => {
                this.readyState = 1;
                if (this.onopen) this.onopen();
            }, 50);
        }

        send() {}
        close() {
            this.readyState = 3;
            if (this.onclose) this.onclose({ code: 1000 });
        }
    } as any;
}

// Определяем localStorage, если его нет
if (typeof global !== 'undefined' && !global.localStorage) {
    const storage: Record<string, string> = {};
    global.localStorage = {
        getItem: (key: string) => storage[key] || null,
        setItem: (key: string, value: string) => { storage[key] = value; },
        removeItem: (key: string) => { delete storage[key]; }
    } as any;
}