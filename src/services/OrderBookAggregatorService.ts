import { IExchangeAdapter } from '../adapters/IExchangeAdapter';
import { WallexAdapter } from '../adapters/WallexAdapter';
import { OmpfinexAdapter } from '../adapters/OmpfinexAdapter';
import { BitpinAdapter } from '../adapters/BitpinAdapter';
import { AggregatedOrder, AggregatedOrderBook, OrderBook } from '../types/OrderBook';

// در یک پروژه واقعی، می‌توان از Redis برای کش کردن استفاده کرد.
// برای سادگی، ما از یک Map ساده در حافظه استفاده می‌کنیم.
interface CacheEntry {
    data: AggregatedOrderBook;
    timestamp: number;
}
const orderBookCache: Map<string, CacheEntry> = new Map();
const CACHE_DURATION_MS = 2500; // ۲.۵ ثانیه

export class OrderBookAggregatorService {
    private adapters: IExchangeAdapter[];

    constructor() {
        // در یک پروژه واقعی، اینها از طریق Dependency Injection تزریق می‌شوند.
        this.adapters = [new WallexAdapter(), new OmpfinexAdapter(),new BitpinAdapter()];
    }

    /**
     * دفتر سفارشات تجمیع شده را برای یک بازار خاص برمی‌گرداند.
     * ابتدا کش را چک می‌کند، در صورت نبودن یا منقضی شدن، داده‌های جدید را واکشی می‌کند.
     * @param symbol - نماد بازار (e.g., "ETHUSDT")
     */
    public async getAggregatedOrderBook(symbol: string): Promise<AggregatedOrderBook> {
        const cachedEntry = orderBookCache.get(symbol);

        // اگر داده معتبر در کش وجود داشت، آن را برگردان
        if (cachedEntry && (Date.now() - cachedEntry.timestamp) < CACHE_DURATION_MS) {
            // console.log(`[Aggregator] Returning cached order book for ${symbol}`);
            return cachedEntry.data;
        }

        console.log(`[Aggregator] Fetching and aggregating new order book for ${symbol}...`);

        // ۱. دریافت Order Book ها از تمام آداپتورها به صورت موازی
        const responses = await Promise.allSettled(
            this.adapters.map(adapter =>
                adapter.getOrderBook(symbol).then(ob => ({ ...ob, exchangeId: adapter.id }))
            )
        );

        const allBids: AggregatedOrder[] = [];
        const allAsks: AggregatedOrder[] = [];

        // ۲. اضافه کردن شناسه صرافی به هر سطح از قیمت
        responses.forEach(response => {
            if (response.status === 'fulfilled' && response.value) {
                const { bids, asks, exchangeId } = response.value;
                bids.forEach(bid => allBids.push({ ...bid, exchangeId }));
                asks.forEach(ask => allAsks.push({ ...ask, exchangeId }));
            } else if (response.status === 'rejected') {
                console.error(`[Aggregator] Failed to fetch from an exchange:`, response.reason);
            }
        });

        // ۳. مرتب‌سازی لیست‌های تجمیع شده
        // Bids (سفارشات خرید) باید از بیشترین قیمت به کمترین مرتب شوند
        allBids.sort((a, b) => b.price - a.price);

        // Asks (سفارشات فروش) باید از کمترین قیمت به بیشترین مرتب شوند
        allAsks.sort((a, b) => a.price - b.price);

        const aggregatedBook: AggregatedOrderBook = {
            bids: allBids,
            asks: allAsks,
            timestamp: Date.now()
        };

        // ۴. ذخیره نتیجه در کش
        orderBookCache.set(symbol, { data: aggregatedBook, timestamp: Date.now() });

        return aggregatedBook;
    }
}