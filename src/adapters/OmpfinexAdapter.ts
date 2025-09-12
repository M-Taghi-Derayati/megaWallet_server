import axios from 'axios';
import type {IExchangeAdapter, Order, OrderBook} from './IExchangeAdapter';

// تعریف ساختار پاسخ API OMPFinex
// پاسخ به صورت [price: string, quantity: string][] است
type OmpfinexOrderLevel = [string, string];

interface OmpfinexDepthResponse {
    data: {
        asks: OmpfinexOrderLevel[];
        bids: OmpfinexOrderLevel[];
    };
}

export class OmpfinexAdapter implements IExchangeAdapter {
    public readonly name = 'OMPFinex';
    private readonly baseUrl = 'https://api.ompfinex.com/v1';

    public async getOrderBook(symbol: string): Promise<OrderBook> {
        // در OMPFinex، symbol به صورت market ID عددی است.
        // ما باید یک mapping بین نام بازار (e.g., "USDTIRT") و ID آن (e.g., 1) داشته باشیم.
        // برای سادگی، فعلاً ID را هاردکد می‌کنیم.
        const marketId = this.getMarketIdForSymbol(symbol);

        try {
            const response = await axios.get<OmpfinexDepthResponse>(`${this.baseUrl}/market/${marketId}/depth`, {
                params: { limit: 200 }, // دریافت ۲۰۰ سطح از عمق بازار
            });


            // تبدیل آرایه‌ها به فرمت استاندارد داخلی ما
            const asks: Order[] = response.data.data.asks.map(level => ({
                price: parseFloat(level[0]),
                quantity: parseFloat(level[1]),
            }));

            const bids: Order[] = response.data.data.bids.map(level => ({
                price: parseFloat(level[0]),
                quantity: parseFloat(level[1]),
            }));
            console.log(asks[0],bids[0]);
            return { asks, bids };

        } catch (error) {
            console.error(`Error fetching order book from OMPFinex for ${symbol}:`, error);
            throw new Error(`Failed to get order book from OMPFinex for symbol ${symbol}.`);
        }
    }

    // تابع کمکی برای تبدیل نام بازار به ID
    private getMarketIdForSymbol(symbol: string): number {
        // در یک پروژه واقعی، این mapping از یک API یا فایل کانفیگ خوانده می‌شود.
        const symbolMap: { [key: string]: number } = {
            'BTCUSDT': 14,
            'ETHUSDT': 15,
            'BNBUSDT': 19,
            // ... سایر بازارها
        };
        const marketId = symbolMap[symbol.toUpperCase()];
        if (!marketId) {
            throw new Error(`Market ID for symbol ${symbol} not found for OMPFinex.`);
        }
        return marketId;
    }
}