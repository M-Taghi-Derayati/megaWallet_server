import axios from 'axios';
import type { IExchangeAdapter, Order, OrderBook } from './IExchangeAdapter';

export class RamzinexAdapter implements IExchangeAdapter {
    public readonly id = 'ramzinex';
    public readonly name = 'ramzinex';
    private readonly baseUrl = 'https://publicapi.ramzinex.com/exchange/api/v1.0/exchange';

    public async getOrderBook(symbol: string): Promise<OrderBook> {
        const pairId = this.getPairIdForSymbol(symbol);

        try {
            // --- URL نهایی بر اساس ساختار صحیح API ---
            const url = `${this.baseUrl}/orderbooks/${pairId}/buys_sells`;
            console.log(`[RamzinexAdapter] Fetching from: ${url}`);

            const response = await axios.get(url);
            const data = response.data.data; // <<-- پاسخ رمزینکس یک کلید "data" اضافی ندارد

            if (!data || !data.buys || !data.sells) {
                throw new Error("Invalid response structure from Ramzinex API.");
            }

            // --- منطق پارس کردن (بدون تغییر) ---
            const bids: Order[] = data.sells.map((level: number[]) => ({
                price: level[0],
                quantity: level[1],
            }));

            const asks: Order[] = data.buys.map((level: number[]) => ({
                price: level[0],
                quantity: level[1],
            }));

            return { asks, bids };

        } catch (error: any) {
            console.error(`[RamzinexAdapter] Error fetching order book for symbol ${symbol} (ID: ${pairId}):`, error.message);
            throw new Error(`Failed to get order book from ${this.id} for symbol ${symbol}.   ${error}`);
        }
    }

    /**
     * نام استاندارد بازار را به ID عددی مورد استفاده در API رمزینکس تبدیل می‌کند.
     * !!! این مقادیر باید از مستندات یا با بررسی API پیدا شوند !!!
     */
    private getPairIdForSymbol(symbol: string): number {
        const standardizedSymbol = symbol.toUpperCase().replace('/', '').replace('_', '');

        // این Map باید با ID های واقعی رمزینکس پر شود
        const symbolMap: { [key: string]: number } = {
            'ETHUSDT': 13,   // این یک مثال فرضی است
            'BTCUSDT': 12,   // این یک مثال فرضی است
            'BNBUSDT': 18,   // این یک مثال فرضی است
        };

        const pairId = symbolMap[standardizedSymbol];
        if (!pairId) {
            throw new Error(`Pair ID for symbol ${symbol} not found for Ramzinex.`);
        }
        return pairId;
    }
}