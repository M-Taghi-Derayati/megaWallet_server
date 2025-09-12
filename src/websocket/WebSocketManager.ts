import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';

class WebSocketManager {
    private wss: WebSocketServer;
    private clients: Set<WebSocket> = new Set(); // لیستی از تمام کلاینت‌های متصل

    constructor(server: Server) {
        console.log("Initializing WebSocket server...");
        this.wss = new WebSocketServer({ server });
        this.initialize();
    }

    private initialize(): void {
        this.wss.on('connection', (ws: WebSocket) => {
            this.clients.add(ws);
            console.log(`✅ WebSocket client connected. Total clients: ${this.clients.size}`);

            ws.on('close', () => {
                this.clients.delete(ws);
                console.log(`⏹️ WebSocket client disconnected. Total clients: ${this.clients.size}`);
            });

            ws.on('error', (error) => {
                console.error('WebSocket error:', error);
                this.clients.delete(ws); // در صورت خطا، کلاینت را حذف کن
            });

            // یک پیام خوش‌آمدگویی برای تست اتصال
            ws.send(JSON.stringify({ type: 'WELCOME', message: 'Successfully connected to MegaWallet notifications.' }));
        });
        console.log("✅ WebSocket server is listening for connections.");
    }

    /**
     * یک پیام را برای تمام کلاینت‌های متصل ارسال می‌کند.
     * @param message آبجکتی که باید به JSON تبدیل و ارسال شود.
     */
    public broadcast(message: object): void {
        if (this.clients.size === 0) return;

        const messageString = JSON.stringify(message);
        console.log(`[WebSocket] Broadcasting message to ${this.clients.size} clients: ${messageString}`);

        this.clients.forEach(client => {
            // فقط به کلاینت‌هایی که هنوز اتصالشان باز است پیام می‌دهیم
            if (client.readyState === WebSocket.OPEN) {
                client.send(messageString);
            }
        });
    }
}

// ما یک نمونه Singleton از این کلاس می‌سازیم تا از همه جای برنامه قابل دسترس باشد
let webSocketManagerInstance: WebSocketManager | null = null;

export const initializeWebSocket = (server: Server) => {
    if (!webSocketManagerInstance) {
        webSocketManagerInstance = new WebSocketManager(server);
    }
    return webSocketManagerInstance;
};

export const getWebSocketManager = (): WebSocketManager => {
    if (!webSocketManagerInstance) {
        throw new Error("WebSocketManager has not been initialized. Call initializeWebSocket first.");
    }
    return webSocketManagerInstance;
};