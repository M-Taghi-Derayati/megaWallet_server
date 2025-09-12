export interface Order {
    price: number;
    quantity: number;
}

export interface OrderBook {
    bids: Order[];
    asks: Order[];
}

export interface IExchangeAdapter {
    name: string;
    getOrderBook(symbol: string): Promise<OrderBook>;
}