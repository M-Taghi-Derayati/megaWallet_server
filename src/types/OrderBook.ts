export interface Order {
    price: number;
    quantity: number;
}

// این مدل جدید شامل شناسه صرافی است
export interface AggregatedOrder extends Order {
    exchangeId: string; // e.g., "wallex", "ompfinex"
}

export interface OrderBook {
    bids: Order[];
    asks: Order[];
}

export interface AggregatedOrderBook {
    bids: AggregatedOrder[];
    asks: AggregatedOrder[];
    timestamp: number;
}