
import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { OrderBookAggregatorService } from '../services/OrderBookAggregatorService';

// --- یک تایپ سفارشی برای اضافه کردن پراپرتی به آبجکت WebSocket ---
interface MarketWebSocket extends WebSocket {
    market?: string; // بازاری که این کلاینت به آن مشترک شده است
    isAlive?: boolean;
}

const aggregator = new OrderBookAggregatorService();
let webSocketManagerInstance: WebSocketManager | null = null;
const UPDATE_INTERVAL_MS = 3000; // هر ۳ ثانیه

class WebSocketManager {
    private wss: WebSocketServer;
    private clients: Set<WebSocket> = new Set(); // لیستی از تمام کلاینت‌های متصل

    constructor(server: Server) {
        console.log("Initializing WebSocket server...");
        this.wss = new WebSocketServer({ server });
        this.initialize();
    }

    private initialize(): void {
        this.wss.on('connection', (ws: MarketWebSocket) => {
            this.clients.add(ws);
            console.log(`✅ WebSocket client connected. Total clients: ${this.wss.clients.size}`);

            // --- مدیریت Heartbeat (برای تشخیص اتصالات مرده) ---
            ws.isAlive = true;
            ws.on('pong', () => {
                ws.isAlive = true;
            });
            // --- پایان Heartbeat ---

            ws.on('message', (message: string) => {
                try {
                    const data = JSON.parse(message);

                    // --- منطق جدید: مدیریت اشتراک (Subscription) ---
                    if (data.action === 'subscribe' && data.market) {
                        ws.market = data.market.toUpperCase();
                        console.log(`Client subscribed to market: ${ws.market}`);
                        // بلافاصله آخرین Order Book را برای کلاینت جدید ارسال کن
                        this.sendInitialOrderBook(ws, ws.market!!);
                    } else if (data.action === 'unsubscribe') {
                        console.log(`Client unsubscribed from market: ${ws.market}`);
                        ws.market = undefined;
                    }
                    // --- پایان منطق جدید ---

                } catch (e) {
                    console.warn("Received invalid JSON message from client.");
                }
            });

            ws.on('close', () => {
                console.log(`⏹️ WebSocket client disconnected. Total clients: ${this.wss.clients.size}`);
            });

            ws.on('error', (error) => {
                console.error('WebSocket error:', error);
            });
        });

        // --- حلقه اصلی برای ارسال آپدیت‌ها ---
        setInterval(async () => {
            await this.broadcastOrderBooks();
        }, UPDATE_INTERVAL_MS);

        // --- حلقه برای بررسی اتصالات مرده ---
        setInterval(() => {
            this.wss.clients.forEach((ws: MarketWebSocket) => {
                if (ws.isAlive === false) {
                    console.warn("Terminating dead WebSocket connection.");
                    return ws.terminate();
                }
                ws.isAlive = false;
                ws.ping();
            });
        }, 30000); // هر ۳۰ ثانیه

        console.log("✅ WebSocket server is running with order book broadcasting.");
    }

    /**
     * به صورت دوره‌ای، Order Book هر بازار فعال را برای کلاینت‌های مشترک شده ارسال می‌کند.
     */
    private async broadcastOrderBooks() {
        const activeMarkets = this.getActiveMarkets();

        for (const market of activeMarkets) {
            try {
                const orderBook = await aggregator.getAggregatedOrderBook(market);
                const payload = JSON.stringify({ type: 'ORDER_BOOK_UPDATE', market, data: orderBook });

                this.wss.clients.forEach((client: MarketWebSocket) => {
                    if (client.readyState === WebSocket.OPEN && client.market === market) {
                        client.send(payload);
                    }
                });
            } catch (error) {
                console.error(`Failed to broadcast order book for market ${market}:`, error);
            }
        }

    }

    /**
     * اولین Order Book را بلافاصله پس از اشتراک برای کلاینت ارسال می‌کند.
     */
    private async sendInitialOrderBook(ws: MarketWebSocket, market: string) {
        try {
            const orderBook = await aggregator.getAggregatedOrderBook(market);
            const payload = JSON.stringify({ type: 'ORDER_BOOK_UPDATE', market, data: orderBook });
            ws.send(payload);
        } catch(e) { /* ... */ }
    }

    /**
     * لیستی از بازارهای منحصر به فردی که کلاینت‌ها در حال حاضر به آنها مشترک هستند را برمی‌گرداند.
     */
    private getActiveMarkets(): Set<string> {
        const markets = new Set<string>();
        this.wss.clients.forEach((client: MarketWebSocket) => {
            if (client.market) {
                markets.add(client.market);
            }
        });
        return markets;
    }

    // تابع broadcast عمومی برای ارسال پیام‌های دیگر (مثل Trade Status)
    public broadcast(message: object): void {
        const messageString = JSON.stringify(message);
        this.wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(messageString);
            }
        });
    }
}

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