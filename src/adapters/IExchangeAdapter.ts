import { OrderBook } from '../types/OrderBook';

export { Order, OrderBook } from '../types/OrderBook';

export interface IExchangeAdapter {
    id: string;
    name: string;
    getOrderBook(symbol: string): Promise<OrderBook>;
}