import { IExchangeAdapter } from '../adapters/IExchangeAdapter';
import { WallexAdapter } from '../adapters/WallexAdapter';
import { OmpfinexAdapter } from '../adapters/OmpfinexAdapter';
import { BitpinAdapter } from '../adapters/BitpinAdapter';
import { RamzinexAdapter } from '../adapters/RamzinexAdapter';
import { AggregatedOrder, AggregatedOrderBook } from '../types/OrderBook';

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
        this.adapters = [
            new WallexAdapter(),
            new OmpfinexAdapter(),
            new BitpinAdapter(),
            new RamzinexAdapter()
        ];
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
        responses.forEach((response, index) => {
            const adapterName = this.adapters[index].name;
            if (response.status === 'fulfilled' && response.value) {
                const { bids, asks, exchangeId } = response.value;
                const bidPriceRange = bids.length > 0 ? `${bids[0]?.price} - ${bids[bids.length - 1]?.price}` : 'N/A';
                const askPriceRange = asks.length > 0 ? `${asks[0]?.price} - ${asks[asks.length - 1]?.price}` : 'N/A';
                console.log(`[Aggregator] ✅ ${adapterName}: ${bids.length} bids (${bidPriceRange}), ${asks.length} asks (${askPriceRange})`);
                bids.forEach(bid => allBids.push({ ...bid, exchangeId }));
                asks.forEach(ask => allAsks.push({ ...ask, exchangeId }));
            } else if (response.status === 'rejected') {
                console.error(`[Aggregator] ❌ ${adapterName} FAILED:`, response.reason.message || response.reason);
            }
        });

        console.log(`[Aggregator] Total aggregated: ${allBids.length} bids, ${allAsks.length} asks`);

        // ۳. مرتب‌سازی لیست‌های تجمیع شده
        // Bids (سفارشات خرید) باید از بیشترین قیمت به کمترین مرتب شوند
        allBids.sort((a, b) => b.price - a.price);

        // Asks (سفارشات فروش) باید از کمترین قیمت به بیشترین مرتب شوند
        allAsks.sort((a, b) => a.price - b.price);

        const aggregatedBook: AggregatedOrderBook = {
            bids: allBids.slice(0, 50),
            asks: allAsks.slice(0, 50),
            timestamp: Date.now()
        };

        // لاگ توزیع صرافی‌ها در نتیجه نهایی
        const bidExchanges = aggregatedBook.bids.reduce((acc, bid) => {
            acc[bid.exchangeId] = (acc[bid.exchangeId] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);
        const askExchanges = aggregatedBook.asks.reduce((acc, ask) => {
            acc[ask.exchangeId] = (acc[ask.exchangeId] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);
        console.log('[Aggregator] Final top 50 bids distribution:', bidExchanges);
        console.log('[Aggregator] Final top 50 asks distribution:', askExchanges);

        // ۴. ذخیره نتیجه در کش
        orderBookCache.set(symbol, { data: aggregatedBook, timestamp: Date.now() });

        return aggregatedBook;
    }
}