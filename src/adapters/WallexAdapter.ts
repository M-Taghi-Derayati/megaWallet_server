import axios from 'axios';
import type {IExchangeAdapter, Order, OrderBook} from './IExchangeAdapter';

// تعریف ساختار پاسخ API والکس برای Type Safety بهتر
interface WallexDepthResponse {
    result: {
        ask: { price: number; quantity: number }[];
        bid: { price: number; quantity: number }[];
    };
}

export class WallexAdapter implements IExchangeAdapter {
    public readonly id = 'Wallex';
    public readonly name = 'Wallex';
    private readonly apiKey = process.env.WALLEX_API_KEY;
    private readonly baseUrl = 'https://api.wallex.ir/v1';

    public async getOrderBook(symbol: string): Promise<OrderBook> {
        if (!this.apiKey) {
            throw new Error('Wallex API key is not configured.');
        }

        try {
            const url =`${this.baseUrl}/depth`;
            console.log(`[WallexAdapter] Fetching from: ${url}`);

            const response = await axios.get<WallexDepthResponse>(url, {
                params: { symbol },
                headers: {
                    'x-api-key': this.apiKey,
                },
            });

            // تبدیل پاسخ API به فرمت استاندارد داخلی ما
            const asks: Order[] = response.data.result.ask.map(item => ({
                price: Number(item.price),
                quantity: Number(item.quantity),
            }));

            const bids: Order[] = response.data.result.bid.map(item => ({
                price: Number(item.price),
                quantity: Number(item.quantity),
            }));

            return { asks, bids };

        } catch (error) {
            // مدیریت خطاها و ارائه یک پیام مشخص
            console.error(`Error fetching order book from Wallex for ${symbol}:`, error);
            throw new Error(`Failed to get order book from Wallex for symbol ${symbol}.`);
        }
    }
}