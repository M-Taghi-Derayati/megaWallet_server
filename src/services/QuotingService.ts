import {PrismaClient} from '@prisma/client';
import {IExchangeAdapter, OrderBook} from '../adapters/IExchangeAdapter';
import {WallexAdapter} from '../adapters/WallexAdapter';
import {OmpfinexAdapter} from '../adapters/OmpfinexAdapter';
import {FeeService} from './FeeService';
import {BlockchainRegistry} from '../config/BlockchainRegistry';
import {AssetRegistry} from '../config/AssetRegistry';
import {BitcoinHDWalletService, NewAddressResult} from './BitcoinHDWalletService';
import {v4 as uuidv4} from 'uuid';
import { BitcoinPayoutService } from './BitcoinPayoutService';

const prisma = new PrismaClient();

// اینترفیس‌ها برای خوانایی بهتر
interface QuoteResult {
    exchangeName: string;
    grossReceiveAmount: number;
    costInFromAsset: number;
}

interface QuoteFeeDetails {
    exchangeFee: number;
    ourFee: number;
    sourceGasCost: { cost: number, asset: string };
}

export class QuotingService {
    private adapters: IExchangeAdapter[];
    private feeService: FeeService;
    private blockchainRegistry: BlockchainRegistry;
    private assetRegistry: AssetRegistry;
    private bitcoinWalletService: BitcoinHDWalletService;
    private bitcoinPayoutService: BitcoinPayoutService;

    constructor() {
        this.blockchainRegistry = new BlockchainRegistry();
        this.assetRegistry = new AssetRegistry();
        this.adapters = [new WallexAdapter(), new OmpfinexAdapter()];
        this.feeService = new FeeService(this.blockchainRegistry);
        this.bitcoinWalletService = new BitcoinHDWalletService(this.blockchainRegistry);
        this.bitcoinPayoutService = new BitcoinPayoutService(this.blockchainRegistry);
    }

    /**
     * تابع اصلی و عمومی برای دریافت پیش‌فاکتور کامل.
     */
    public async getQuote(
        fromAssetSymbol: string,
        fromNetworkId: string,
        toAssetSymbol: string,
        fromAmount: number,
        recipientAddress?: string, // اختیاری
        toNetworkId?: string       // اختیاری
    ) {
        // ۱. اطلاعات شبکه مبدا را دریافت می‌کنیم
        const fromNetwork = this.blockchainRegistry.getNetworkById(fromNetworkId);
        if (!fromNetwork) {
            throw new Error(`Invalid source network ID: ${fromNetworkId}`);
        }

        // ۲. بهترین قیمت را از صرافی‌ها پیدا می‌کنیم (این بخش برای همه مشترک است)
        const exchangeSymbol = this.determineExchangeSymbol(fromAssetSymbol, toAssetSymbol);
        const orderBooks = await this.getOrderBooks(exchangeSymbol);
        const bestRawQuote = this.findBestQuote(fromAssetSymbol, toAssetSymbol, fromAmount, orderBooks);
        if (!bestRawQuote) {
            throw new Error("Not enough liquidity in the market to fill the order.");
        }

        // ۳. هزینه‌های پایه را بر اساس نوع شبکه مبدا محاسبه می‌کنیم
        let baseFees: QuoteFeeDetails;
        if (fromNetwork.networkType === 'EVM' && fromNetwork.chainId) {
            baseFees = await this.calculateEvmBaseFees(fromAssetSymbol, fromAmount, fromNetwork.chainId, bestRawQuote.grossReceiveAmount);
        } else if (fromNetwork.networkType === 'BITCOIN') {
            baseFees = await this.calculateUtxoBaseFees(fromAssetSymbol, fromAmount, bestRawQuote.grossReceiveAmount);
        } else {
            throw new Error(`Swap from ${fromNetwork.networkType} is not supported.`);
        }

        // ۴. مقدار پایه نهایی را محاسبه می‌کنیم
        const totalBaseCostInToAsset = await this.convertFeesToToAsset(baseFees, toAssetSymbol);
        const finalAmountBase = bestRawQuote.grossReceiveAmount - totalBaseCostInToAsset;

        // ۵. پاسخ نهایی را بر اساس اطلاعات موجود می‌سازیم
        return this.buildFinalResponse(
            fromAmount, fromAssetSymbol, fromNetworkId, toAssetSymbol,
            toNetworkId, recipientAddress,
            bestRawQuote, baseFees, finalAmountBase
        );
    }





    // --- توابع محاسباتی و منطقی ---

    private async getOrderBooks(symbol: string): Promise<(OrderBook & { exchangeName: string })[]> {
        const promises = this.adapters.map(async (adapter) => {
            try {
                const orderBook = await adapter.getOrderBook(symbol);
                return {...orderBook, exchangeName: adapter.name};
            } catch (error) {
                console.error(`Failed to get order book from ${adapter.name} for ${symbol}:`, (error as Error).message);
                return null;
            }
        });
        const results = await Promise.all(promises);
        return results.filter(ob => ob !== null) as (OrderBook & { exchangeName: string })[];
    }

    private determineExchangeSymbol(fromAsset: string, toAsset: string): string {
        const {symbol} = this.determineSymbolAndDirection(fromAsset, toAsset);
        return symbol;
    }

    private determineSymbolAndDirection(from: string, to: string): { symbol: string, tradeDirection: 'buy' | 'sell' } {
        const standardPairs = ['BTCUSDT', 'ETHUSDT', 'BTCIRT', 'BNBUSDT', 'USDTIRT', 'ETHBTC'];

        const forwardSymbol = `${from}${to}`.toUpperCase();
        const reverseSymbol = `${to}${from}`.toUpperCase();

        if (standardPairs.includes(reverseSymbol)) {
            return {symbol: reverseSymbol, tradeDirection: 'buy'};
        }
        if (standardPairs.includes(forwardSymbol)) {
            return {symbol: forwardSymbol, tradeDirection: 'sell'};
        }

        throw new Error(`Market for ${from}/${to} is not supported.`);
    }

    private findBestQuote(fromAsset: string, toAsset: string, amount: number, orderBooks: (OrderBook & {
        exchangeName: string
    })[]): QuoteResult | null {
        const {tradeDirection} = this.determineSymbolAndDirection(fromAsset, toAsset);
        if (tradeDirection === 'buy') {
            return this.findBestBuyQuote(amount, orderBooks);
        } else {
            return this.findBestSellQuote(amount, orderBooks);
        }
    }

    private findBestBuyQuote(amountToSpend: number, orderBooks: (OrderBook & {
        exchangeName: string
    })[]): QuoteResult | null {
        let bestResult: QuoteResult | null = null;

        for (const ob of orderBooks) {
            let amountReceived = 0;
            let cost = 0;

            for (const ask of ob.asks) {
                const price = ask.price;
                const quantityAvailable = ask.quantity;
                const costToBuyThisLevel = quantityAvailable * price;

                if (cost + costToBuyThisLevel >= amountToSpend) {
                    const remainingCost = amountToSpend - cost;
                    amountReceived += remainingCost / price;
                    cost += remainingCost;
                    break;
                } else {
                    amountReceived += quantityAvailable;
                    cost += costToBuyThisLevel;
                }
            }

            if (Math.abs(cost - amountToSpend) < 1e-9) {
                if (bestResult === null || amountReceived > bestResult.grossReceiveAmount) {
                    bestResult = {
                        exchangeName: ob.exchangeName,
                        grossReceiveAmount: amountReceived,
                        costInFromAsset: cost
                    };
                }
            }
        }
        return bestResult;
    }

    private findBestSellQuote(amountToSell: number, orderBooks: (OrderBook & {
        exchangeName: string
    })[]): QuoteResult | null {
        let bestResult: QuoteResult | null = null;

        for (const ob of orderBooks) {
            let amountReceived = 0;
            let amountSold = 0;

            for (const bid of ob.bids) {
                const price = bid.price;
                const quantityAvailable = bid.quantity;

                if (amountSold + quantityAvailable >= amountToSell) {
                    const remainingAmountToSell = amountToSell - amountSold;
                    amountReceived += remainingAmountToSell * price;
                    amountSold += remainingAmountToSell;
                    break;
                } else {
                    amountReceived += quantityAvailable * price;
                    amountSold += quantityAvailable;
                }
            }

            if (Math.abs(amountSold - amountToSell) < 1e-9) {
                if (bestResult === null || amountReceived > bestResult.grossReceiveAmount) {
                    bestResult = {
                        exchangeName: ob.exchangeName,
                        grossReceiveAmount: amountReceived,
                        costInFromAsset: amountSold
                    };
                }
            }
        }
        return bestResult;
    }

    // --- توابع محاسبه کارمزد ---

    private async calculateBaseFees(fromAssetSymbol: string, fromAmount: number, sourceChainId: number, grossReceiveAmount: number): Promise<QuoteFeeDetails> {
        const fromAmountUsd = await this.getPriceInUsd(fromAssetSymbol) * fromAmount;

        const exchangeFee = this.feeService.calculateExchangeFee(grossReceiveAmount);
        const ourFee = this.feeService.calculateOurFee(fromAmountUsd, grossReceiveAmount);
        const sourceGasCost = await this.feeService.getContractCallGasCost(sourceChainId);

        return {exchangeFee, ourFee, sourceGasCost};
    }

    private async calculateEvmBaseFees(fromAssetSymbol: string, fromAmount: number, sourceChainId: number, grossReceiveAmount: number): Promise<QuoteFeeDetails> {
        const fromAmountUsd = await this.getPriceInUsd(fromAssetSymbol) * fromAmount;

        const exchangeFee = this.feeService.calculateExchangeFee(grossReceiveAmount);
        const ourFee = this.feeService.calculateOurFee(fromAmountUsd, grossReceiveAmount);
        // هزینه Gas برای اجرای قرارداد Phoenix
        const sourceGasCost = await this.feeService.getContractCallGasCost(sourceChainId);

        return { exchangeFee, ourFee, sourceGasCost };
    }

    /**
     * تابع کمکی جدید برای محاسبه هزینه‌های پایه مختص UTXO.
     */
    private async calculateUtxoBaseFees(fromAssetSymbol: string, fromAmount: number, grossReceiveAmount: number): Promise<QuoteFeeDetails> {
        const fromAmountUsd = await this.getPriceInUsd(fromAssetSymbol) * fromAmount;

        const exchangeFee = this.feeService.calculateExchangeFee(grossReceiveAmount);
        const ourFee = this.feeService.calculateOurFee(fromAmountUsd, grossReceiveAmount);
        // در سواپ UTXO، هزینه Gas در سمت مبدا نداریم (کاربر خودش واریز می‌کند)
        const sourceGasCost = { cost: 0, asset: fromAssetSymbol };

        return { exchangeFee, ourFee, sourceGasCost };
    }

    private async convertFeesToToAsset(fees: QuoteFeeDetails, toAssetSymbol: string): Promise<number> {
        const {exchangeFee, ourFee, sourceGasCost} = fees;
        const sourceGasCostInToAsset = await this.getConversionRate(sourceGasCost.asset, toAssetSymbol) * sourceGasCost.cost;
        return exchangeFee + ourFee + sourceGasCostInToAsset;
    }

    private async calculateTotalFeeInUsd(
        baseFees: QuoteFeeDetails,
        toAssetSymbol: string,
        destGasCost: { cost: number, asset: string }
    ): Promise<number> {
        const {exchangeFee, ourFee, sourceGasCost} = baseFees;

        // قیمت‌ها را یکجا می‌گیریم
        const prices = await Promise.all([
            this.getPriceInUsd(toAssetSymbol),
            this.getPriceInUsd(sourceGasCost.asset),
            this.getPriceInUsd(destGasCost.asset)
        ]);
        const [toAssetPriceUsd, sourceGasAssetPriceUsd, destGasAssetPriceUsd] = prices;

        const exchangeFeeInUsd = exchangeFee * toAssetPriceUsd;
        const ourFeeInUsd = ourFee * toAssetPriceUsd;
        const sourceGasCostInUsd = sourceGasCost.cost * sourceGasAssetPriceUsd;
        const destGasCostInUsd = destGasCost.cost * destGasAssetPriceUsd; // <<-- هزینه جدید

        return exchangeFeeInUsd + ourFeeInUsd + sourceGasCostInUsd + destGasCostInUsd;
    }

    // --- تابع ساخت پاسخ نهایی ---

    private async buildEvmResponse(
        fromAmount: number,
        fromAssetSymbol: string,
        fromNetworkId: string,
        toAssetSymbol: string,
        quoteResult: QuoteResult,
        fees: QuoteFeeDetails,
        finalAmountBase: number
    ) {
        const availableDestinationNetworks = this.assetRegistry.getAssetDeployments(toAssetSymbol);
        const receivingOptions = [];
        for (const deployment of availableDestinationNetworks) {
            const network = this.blockchainRegistry.getNetworkById(deployment.networkId);
            if (!network || !network.chainId) continue;

            const destGasCost = await this.feeService.getFinalTransferGasCost(network.chainId);
            const destGasCostInToAsset = await this.getConversionRate(destGasCost.asset, toAssetSymbol) * destGasCost.cost;
            const finalAmount = finalAmountBase - destGasCostInToAsset;
            const totalFeeForThisOptionInUsd = await this.calculateTotalFeeInUsd(fees, toAssetSymbol, destGasCost);

            const feesDetails = {
                exchangeFee: {amount: fees.exchangeFee.toFixed(8), asset: toAssetSymbol},
                ourFee: {amount: fees.ourFee.toFixed(8), asset: toAssetSymbol},
                sourceNetworkGasFee: {amount: fees.sourceGasCost.cost.toFixed(8), asset: fees.sourceGasCost.asset},
                destinationNetworkFee: {amount: destGasCost.cost.toFixed(8), asset: destGasCost.asset}
            };


            receivingOptions.push({
                networkId: network.id,
                networkName: network.name,
                // جزئیات کامل هزینه‌ها را برای هر گزینه به صورت جداگانه قرار می‌دهیم
                fees: {
                    totalFeeInUsd: totalFeeForThisOptionInUsd.toFixed(4), // <<-- محاسبه شده برای این گزینه
                    details: feesDetails
                },
                finalAmount: finalAmount.toFixed(8),
                estimatedDeliveryTime: "~ 1-2 minutes"
            });
        }

        let exchangeRate: number;
        const {tradeDirection} = this.determineSymbolAndDirection(fromAssetSymbol, toAssetSymbol);
        if (quoteResult.grossReceiveAmount > 0 && quoteResult.costInFromAsset > 0) {
            if (tradeDirection === 'buy') {
                exchangeRate = quoteResult.costInFromAsset / quoteResult.grossReceiveAmount;
            } else { // tradeDirection === 'sell'

                exchangeRate = quoteResult.grossReceiveAmount / quoteResult.costInFromAsset;
            }
        } else {
            exchangeRate = 0;
        }

        const responseJson = {
            quoteId: uuidv4(),
            fromAmount: fromAmount.toString(),
            fromAssetSymbol: fromAssetSymbol,
            bestExchange: quoteResult.exchangeName,
            exchangeRate: exchangeRate.toFixed(4),
            receivingOptions, // <<-- تمام جزئیات به داخل این آرایه منتقل شد
            expiresAt: new Date(Date.now() + 60000).toISOString()
        };

        // --- بخش ذخیره در دیتابیس (نسخه نهایی و کامل) ---
        try {
            console.log(`[DB] Saving Quote with ID: ${responseJson.quoteId}`);

            await prisma.quote.create({
                data: {
                    // --- فیلدهای شناسایی ---
                    id: responseJson.quoteId,
                    expiresAt: responseJson.expiresAt,

                    // --- فیلدهای اصلی که فراموش شده بودند ---
                    fromAssetId: `${fromAssetSymbol}-${fromNetworkId}`, // ساخت ID کامل
                    toAssetId: `${toAssetSymbol}-TARGET_NETWORK`, // (این بخش نیاز به بهبود دارد)

                    // --- فیلدهای شناسایی اضافی ---
                    fromAssetSymbol: fromAssetSymbol,
                    fromNetworkId: fromNetworkId,
                    toAssetSymbol: toAssetSymbol,
                    bestExchange: responseJson.bestExchange,
                    grossReceiveAmount: quoteResult.grossReceiveAmount.toString(),
                    // --- فیلدهای عددی ---
                    fromAmount: fromAmount.toString(),
                    finalReceiveAmount: responseJson.receivingOptions[0].finalAmount,
                    exchangeRate: responseJson.exchangeRate,
                    exchangeFee: fees.exchangeFee.toString(),
                    ourFee: fees.ourFee.toString(),
                    gasCosts: fees.sourceGasCost.cost.toString()
                }
            });
            console.log(`[DB] Quote saved successfully.`);
        } catch (dbError) {
            console.error("❌ Failed to save quote to the database:", dbError);
            throw new Error("Failed to persist the quote. Please try again.");
        }
        return responseJson
    }


    private async buildFinalResponse(
        fromAmount: number,
        fromAssetSymbol: string,
        fromNetworkId: string,
        toAssetSymbol: string,
        toNetworkId: string | undefined,
        recipientAddress: string | undefined,
        quoteResult: QuoteResult,
        baseFees: QuoteFeeDetails,
        finalAmountBase: number
    ) {
        const quoteId = uuidv4().replace(/-/g, '');
        const expiresAt = new Date(Date.now() + 300000).toISOString();

        // --- ۱. اطلاعات شبکه مبدا را برای تصمیم‌گیری می‌گیریم ---
        const fromNetwork = this.blockchainRegistry.getNetworkById(fromNetworkId)!;

        let exchangeRate: number;
        // ... (منطق محاسبه exchangeRate بدون تغییر)
        const {tradeDirection} = this.determineSymbolAndDirection(fromAssetSymbol, toAssetSymbol);
        if (quoteResult.grossReceiveAmount > 0 && quoteResult.costInFromAsset > 0) {
            if (tradeDirection === 'buy') {
                exchangeRate = quoteResult.costInFromAsset / quoteResult.grossReceiveAmount;
            } else {
                exchangeRate = quoteResult.grossReceiveAmount / quoteResult.costInFromAsset;
            }
        } else {
            exchangeRate = 0;
        }

        const responseJson: any = {
            quoteId: quoteId,
            fromAmount: fromAmount.toString(),
            fromAssetSymbol: fromAssetSymbol,
            bestExchange: quoteResult.exchangeName,
            exchangeRate: exchangeRate.toFixed(8),
            expiresAt: expiresAt
        };

        // --- ۲. اگر شبکه مبدا بیت‌کوین بود، آدرس دیپازیت تولید می‌کنیم ---
        let newDepositAddressInfo: NewAddressResult | null = null;
        if (fromNetwork.networkType === 'BITCOIN') {
            newDepositAddressInfo = await this.bitcoinWalletService.getNewAddress();
            responseJson.depositAddress = newDepositAddressInfo.address;
        }

        // --- بقیه کد شما بدون تغییر باقی می‌ماند ---
        const toAssetDeployments = this.assetRegistry.getAssetDeployments(toAssetSymbol);
        if (toAssetDeployments.length === 0) throw new Error(`Asset ${toAssetSymbol} not supported.`);
        const primaryDeployment = toAssetDeployments[0];
        const targetNetwork = this.blockchainRegistry.getNetworkById(primaryDeployment.networkId)!;

        let finalReceiveAmountForDB: string;
        let finalToNetworkIdForDB: string;

        if (targetNetwork.networkType === 'EVM') {
            responseJson.receivingOptions = await this.buildEvmReceivingOptions(toAssetSymbol, finalAmountBase, baseFees);
            if (responseJson.receivingOptions.length === 0) {
                throw new Error(`No available EVM networks to receive ${toAssetSymbol}.`);
            }
            finalReceiveAmountForDB = responseJson.receivingOptions[0].finalAmount;
            finalToNetworkIdForDB = responseJson.receivingOptions[0].networkId;
        }
        else if (targetNetwork.networkType === 'BITCOIN') {
            // ... (منطق این بخش بدون تغییر)
            if (!toNetworkId || !recipientAddress) {
                throw new Error("toNetworkId and recipientAddress are mandatory for Bitcoin destination.");
            }
            const { feeBtc } = await this.bitcoinPayoutService.estimatePayoutFee();
            const btcPayoutFeeInToAsset = feeBtc; // چون toAsset خودش BTC است
            const finalAmount = finalAmountBase - btcPayoutFeeInToAsset;
            responseJson.finalReceiveAmount = finalAmount.toFixed(8);
            responseJson.receivingOptions = [];
            const totalFeeInUsd = await this.calculateTotalFeeInUsd(baseFees, toAssetSymbol, { cost: btcPayoutFeeInToAsset, asset: "BTC" });
            responseJson.fees = {
                totalFeeInUsd: totalFeeInUsd.toFixed(4),
                details: {
                    exchangeFee: { amount: baseFees.exchangeFee.toFixed(8), asset: toAssetSymbol },
                    ourFee: { amount: baseFees.ourFee.toFixed(8), asset: toAssetSymbol },
                    sourceNetworkGasFee: { amount: baseFees.sourceGasCost.cost.toFixed(8), asset: baseFees.sourceGasCost.asset },
                    destinationNetworkFee: { amount: btcPayoutFeeInToAsset.toFixed(8), asset: "BTC" },
                    iconUrl:""
                }
            };
            finalReceiveAmountForDB = responseJson.finalReceiveAmount;
            finalToNetworkIdForDB = toNetworkId;
        } else {
            throw new Error(`Unsupported destination asset type: ${targetNetwork.networkType}`);
        }

        // --- ذخیره در دیتابیس ---
        try {
            await prisma.$transaction(async (tx) => {
                await tx.quote.create({
                    data: {
                        // ... (تمام فیلدهای شما بدون تغییر)
                        id: quoteId,
                        expiresAt: expiresAt,
                        fromAssetId: `${fromAssetSymbol}-${fromNetworkId}`,
                        toAssetId: `${toAssetSymbol}-${finalToNetworkIdForDB}`,
                        fromAssetSymbol: fromAssetSymbol,
                        fromNetworkId: fromNetworkId,
                        toAssetSymbol: toAssetSymbol,
                        bestExchange: quoteResult.exchangeName,
                        recipientAddress: recipientAddress,
                        toNetworkId: finalToNetworkIdForDB,
                        fromAmount: fromAmount.toString(),
                        grossReceiveAmount: quoteResult.grossReceiveAmount.toString(),
                        finalReceiveAmount: finalReceiveAmountForDB,
                        exchangeRate: responseJson.exchangeRate,
                        exchangeFee: baseFees.exchangeFee.toString(),
                        ourFee: baseFees.ourFee.toString(),
                        gasCosts: baseFees.sourceGasCost.cost.toString(),
                    }
                });

                // --- ۳. اگر آدرس دیپازیت تولید شده بود، آن را هم در دیتابیس ذخیره می‌کنیم ---
                if (newDepositAddressInfo) {
                    await tx.bitcoinDepositAddress.create({
                        data: {
                            address: newDepositAddressInfo.address,
                            path: newDepositAddressInfo.path,
                            status: 'PENDING_DEPOSIT',
                            quoteId: quoteId,
                        }
                    });
                }
            });
            console.log(`[DB] Quote ${quoteId} saved successfully.`);
        } catch (dbError) {
            console.error("❌ Failed to save quote to the database:", dbError);
            throw new Error("Failed to persist the quote. Please try again.");
        }

        return responseJson;
    }

    private async buildEvmReceivingOptions(toAssetSymbol: string, finalAmountBase: number, baseFees: QuoteFeeDetails) {
        const availableDestinationNetworks = this.assetRegistry.getAssetDeployments(toAssetSymbol)
            .map(dep => this.blockchainRegistry.getNetworkById(dep.networkId))
            .filter(net => net && net.networkType === 'EVM');

        const receivingOptions = [];
        for (const network of availableDestinationNetworks) {
            if (!network || !network.chainId) continue;

            const destGasCost = await this.feeService.getFinalTransferGasCost(network.chainId);
            const destGasCostInToAsset = await this.getConversionRate(destGasCost.asset, toAssetSymbol) * destGasCost.cost;
            const finalAmount = finalAmountBase - destGasCostInToAsset;
            const totalFeeForThisOptionInUsd = await this.calculateTotalFeeInUsd(baseFees, toAssetSymbol, destGasCost);
            receivingOptions.push({
                networkId: network.id,
                networkName: network.name,
                fees: {
                    totalFeeInUsd: totalFeeForThisOptionInUsd.toFixed(4),
                    details: {
                        iconUrl:network.iconUrl,
                        exchangeFee: { amount: baseFees.exchangeFee.toFixed(8), asset: toAssetSymbol },
                        ourFee: { amount: baseFees.ourFee.toFixed(8), asset: toAssetSymbol },
                        sourceNetworkGasFee: { amount: baseFees.sourceGasCost.cost.toFixed(8), asset: baseFees.sourceGasCost.asset },
                        destinationNetworkFee: { amount: destGasCost.cost.toFixed(8), asset: destGasCost.asset }
                    }
                },
                finalAmount: finalAmount.toFixed(8),
                estimatedDeliveryTime: "~ 1-2 minutes"
            });
        }
        return receivingOptions;
    }

    // --- توابع کمکی قیمت (باید با یک سرویس واقعی جایگزین شوند) ---
    private async getPriceInUsd(assetSymbol: string): Promise<number> {
        const priceMap: { [key: string]: number } = {
            "ETH": 4300,
            "BTC": 113000,
            "USDT": 1,
            "POL": 0.28,
            "BNB": 902
        };
        return priceMap[assetSymbol.toUpperCase()] || 0;
    }

    private async getConversionRate(fromAsset: string, toAsset: string): Promise<number> {
        const fromPrice = await this.getPriceInUsd(fromAsset);
        const toPrice = await this.getPriceInUsd(toAsset);
        if (toPrice === 0) throw new Error(`Price for toAsset ${toAsset} is not available.`);
        return fromPrice / toPrice;
    }
}