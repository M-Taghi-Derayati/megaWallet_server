import axios from 'axios';
import type {IExchangeAdapter, Order, OrderBook} from './IExchangeAdapter';
import {response} from "express";
import * as console from "node:console";

export class BitpinAdapter implements IExchangeAdapter {
    // ۱. شناسه منحصر به فرد
    public readonly id = 'bitpin';
    public readonly name = 'bitpin';
    // ۲. آدرس پایه API
    private readonly baseUrl = 'https://api.bitpin.org/api/v1/mth';

    /**
     * دفتر سفارشات را برای یک بازار خاص از صرافی بیت‌پین دریافت می‌کند.
     * @param symbol نماد بازار (e.g., "ETH_USDT")
     */
    public async getOrderBook(symbol: string): Promise<OrderBook> {
        // API بیت‌پین از "_" به جای "" در نام بازار استفاده می‌کند
        const formattedSymbol = symbol.replace('USDT', '_USDT');

        try {
            // ۳. فراخوانی Endpoint
            const response = await axios.get(`${this.baseUrl}/orderbook/${formattedSymbol}/`);
            const data = response.data;

            if (!data || !data.bids || !data.asks) {
                throw new Error("Invalid response structure from Bitpin API.");
            }

            // ۴. "ترجمه" پاسخ به فرمت استاندارد ما
            const asks: Order[] = data.asks.map((level: string[]) => ({
                price: parseFloat(level[0]),
                quantity: parseFloat(level[1]),
            }));

            const bids: Order[] = data.bids.map((level: string[]) => ({
                price: parseFloat(level[0]),
                quantity: parseFloat(level[1]),
            }));

            return { asks ,bids};

        } catch (error: any) {
            console.error(`[BitpinAdapter] Error fetching order book for ${formattedSymbol}:`, error.message);
            // برای اینکه Promise.allSettled به درستی کار کند، خطا را پرتاب می‌کنیم
            throw new Error(`Failed to get order book from ${this.id} for symbol ${formattedSymbol}.`);
        }
    }


}