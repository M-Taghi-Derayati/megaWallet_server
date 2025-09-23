import { PrismaClient, Quote } from '@prisma/client';
import { EvmContractService } from './EvmContractService';
import { BlockchainRegistry } from '../config/BlockchainRegistry';
import {ethers} from "ethers";
import { FeeService } from './FeeService';
import { BitcoinPayoutService } from './BitcoinPayoutService';
import { AssetRegistry } from '../config/AssetRegistry'; // <<<--- ایمپورت جدید
import { PayoutService } from './PayoutService';
import { getWebSocketManager } from '../websocket/WebSocketManager';
import {ForwardRequest} from "./MetaTxService";

// تعریف اینترفیس‌ها برای ساختار داده ورودی جهت خوانایی و Type-Safety
interface PermitParameters {
    tokenAddress: string;
    userAddress: string;
    amount: string;
    deadline: number;
    v: number;
    r: string;
    s: string;
}

interface ExecuteTradeParams {
    quoteId: string;
    selectedNetworkId: string; // شناسه شبکه مقصد
    recipientAddress: string;
    permitParameters: PermitParameters;
}

interface NativeSwapEventData {
    user: string;
    amount: bigint; // ethers.js رویدادها را با bigint برمی‌گرداند
    quoteId: string; // این به صورت bytes32 (هگز) است
    networkId: string; // شناسه شبکه مبدا که رویداد در آن رخ داده
    txHash: string; // هش تراکنش واریز کاربر
}

// یک نمونه از Prisma Client برای تعامل با دیتابیس
const prisma = new PrismaClient();

export class TradeExecutionService {
    private evmContractService: EvmContractService;
    private registry: BlockchainRegistry;
    private feeService: FeeService;
    private payoutService: PayoutService;
    private bitcoinPayoutService: BitcoinPayoutService;
    private assetRegistry: AssetRegistry; // <<<--- پراپرتی جدید


    constructor() {
        // در یک پروژه واقعی، اینها از طریق Dependency Injection تزریق می‌شوند.
        this.registry = new BlockchainRegistry();
        this.feeService = new FeeService(this.registry);
        this.assetRegistry = new AssetRegistry(); // <<<--- مقداردهی اولیه
        this.payoutService = new PayoutService(this.registry, this.assetRegistry);
        this.bitcoinPayoutService = new BitcoinPayoutService(this.registry);
        this.evmContractService = new EvmContractService(this.registry);
    }

    /**
     * تابع اصلی برای اجرای کامل یک معامله.
     * @param params پارامترهای دریافتی از API Controller.
     * @returns شناسه معامله (Trade ID) در صورت موفقیت.
     */
    public async executeTrade(params: ExecuteTradeParams): Promise<string> {
        // 1. بازیابی و اعتبارسنجی پیش‌فاکتور (Quote) از دیتابیس
        const quote = await this.validateQuote(params.quoteId);

        // 2. ایجاد یک رکورد معامله (Trade) در دیتابیس با وضعیت اولیه 'PENDING'
        const trade = await prisma.trade.create({
            data: {
                quoteId: quote.id,
                status: 'PENDING',
            }
        });
        console.log(`[Trade ${trade.id}] Created with status PENDING.`);

        try {
            // 3. پیدا کردن شبکه مبدا از روی اطلاعات Quote
            // ما باید fromNetworkId را در مدل Quote ذخیره کنیم تا این کار ممکن شود.
            // فعلاً فرض می‌کنیم این اطلاعات در quote ذخیره شده است.
            const fromNetwork = this.registry.getNetworkById(quote.fromNetworkId); // فرض می‌کنیم quote.fromNetworkId وجود دارد
            if (!fromNetwork || !fromNetwork.chainId) {
                throw new Error("Source network for the quote is invalid.");
            }
            const sourceChainId = fromNetwork.chainId;

            // 4. فراخوانی قرارداد هوشمند (در اینجا نسخه شبیه‌سازی شده را فراخوانی می‌کنیم)
            // برای اجرای واقعی، کافی است .simulateExecuteTrade را با .executeTrade جایگزین کنید.
            const { txHash, receipt } = await this.evmContractService.executeTrade(
                quote.id,
                params.permitParameters,
                sourceChainId
            );


            console.log(`[Trade ${trade.id}] Contract call simulated successfully. TxHash: ${txHash}`);

            // --- مرحله ۲: محاسبه هزینه Gas واقعی ---
            const actualGasUsed = receipt.gasUsed;
            const gasPrice = receipt.gasPrice || (await this.feeService['getGasPrice'](sourceChainId)); // getGasPrice پرایوت است
            const actualGasCostInWei = actualGasUsed * gasPrice;
            const actualGasCostInNativeToken = parseFloat(ethers.formatEther(actualGasCostInWei));


            console.log(`[Trade ${trade.id}] Actual Gas Cost: ${actualGasCostInNativeToken} ${fromNetwork.currencySymbol}`);

            // --- مرحله ۳: شبیه‌سازی معامله در صرافی (بدون تغییر) ---
            console.log(`[Trade ${trade.id}] [SIMULATION] Executing trade on exchange: ${quote.bestExchange}...`);

            // ما به مقادیر خام از quote نیاز داریم (که باید در دیتابیس ذخیره شده باشند)
            const grossReceiveAmount = parseFloat(quote.finalReceiveAmount.toString()); // این باید grossAmount باشد
            const exchangeFee = parseFloat(quote.exchangeFee.toString());
            const ourFee = parseFloat(quote.ourFee.toString());

            // --- مرحله ۴: محاسبه مقدار نهایی برای ارسال به کاربر ---
            const sourceGasCostInToAsset = await this.convertAmount(actualGasCostInNativeToken, fromNetwork.currencySymbol, quote.toAssetSymbol);
            const finalAmountToSend = grossReceiveAmount - exchangeFee - ourFee - sourceGasCostInToAsset;

            console.log(`[Trade ${trade.id}] Final amount calculated to send to user: ${finalAmountToSend} ${quote.toAssetSymbol}`);

            // --- مرحله ۵: شبیه‌سازی ارسال نهایی و محاسبه هزینه آن ---
            const toNetwork = this.registry.getNetworkById(params.selectedNetworkId);
            if (!toNetwork) throw new Error("Destination network not found.");

            const toAssetConfig = this.assetRegistry.getAssetBySymbol(quote.toAssetSymbol, toNetwork.id);
            if (!toAssetConfig) throw new Error("Destination asset config not found.");

            let finalTxHash: string;


            if (toNetwork.networkType === 'BITCOIN') {
                // **سناریوی صحیح: مقصد بیت‌کوین است**
                // ما باید سرویس پرداخت بیت‌کوین را فراخوانی کنیم
                finalTxHash = await this.bitcoinPayoutService.sendBitcoin(
                    params.recipientAddress,
                    finalAmountToSend
                );
            } else if (toNetwork.networkType === 'EVM') {
                if (toAssetConfig.contractAddress) {
                    // این یک توکن ERC20 است
                    finalTxHash = await this.payoutService.sendErc20Token(
                        toNetwork.chainId,
                        quote.toAssetSymbol,
                        params.recipientAddress,
                        finalAmountToSend.toString()
                    );
                } else {
                    // این توکن اصلی شبکه است
                    finalTxHash = await this.payoutService.sendNativeToken(
                        toNetwork.chainId,
                        params.recipientAddress,
                        finalAmountToSend.toString()
                    );
                }
            }else{
                throw new Error(`Unsupported destination network type: ${toNetwork.networkType}`);
            }

            const destinationGasCost = await this.feeService.getFinalTransferGasCost(toNetwork.chainId);
            console.log(`[Trade ${trade.id}] [SIMULATION] Estimated gas cost to transfer to user: ${destinationGasCost.cost} ${destinationGasCost.asset}`);

            // --- مرحله ۶: آپدیت نهایی Trade در دیتابیس ---
            await prisma.trade.update({
                where: { id: trade.id },
                data: {
                    status: 'COMPLETED',
                    txHashContractCall: txHash,
                    txHashFinalTransfer: finalTxHash,
                    // می‌توانیم هزینه‌های واقعی را هم برای حسابداری ذخیره کنیم
                }
            });

            console.log(`✅ [Trade ${trade.id}] Completed successfully.`);
            getWebSocketManager().broadcast({
                type: 'TRADE_COMPLETED',
                tradeId: trade.id,
                quoteId: quote.id,
                finalTxHash: finalTxHash
            });
            return trade.id;


        } catch (error) {
            // 8. در صورت بروز هرگونه خطا، وضعیت Trade را به 'FAILED' تغییر می‌دهیم
            console.error(`❌ [Trade ${trade.id}] Failed:`, error);
            await prisma.trade.update({
                where: { id: trade.id },
                data: {
                    status: 'FAILED',
                    failureReason: (error as Error).message
                }
            });
            getWebSocketManager().broadcast({
                type: 'TRADE_FAILED',
                tradeId: trade.id,
                quoteId: quote.id,
                reason: (error as Error).message
            });
            // خطا را مجدداً پرتاب می‌کنیم تا به Controller و سپس به کلاینت برسد
            throw error;
        }
    }

    /**
     * یک تابع کمکی برای اعتبارسنجی Quote.
     * @param quoteId شناسه پیش‌فاکتور.
     * @returns آبجکت Quote در صورت معتبر بودن.
     */
    private async validateQuote(quoteId: string): Promise<Quote> {
        const quote = await prisma.quote.findUnique({ where: { id: quoteId } });

        // آیا Quote اصلاً وجود دارد؟
        if (!quote) {
            throw new Error(`Quote with ID ${quoteId} not found.`);
        }

        // آیا Quote منقضی شده است؟
        if (new Date() > quote.expiresAt) {
            throw new Error("Quote has expired.");
        }

        // آیا این Quote قبلاً استفاده شده است؟
        const existingTrade = await prisma.trade.findFirst({ where: { quoteId: quoteId } });
        if (existingTrade) {
            throw new Error("This quote has already been used.");
        }

        return quote;
    }

    public async executeNativeSwap(quoteId: string, request: ForwardRequest, signature: string): Promise<string> {
        const quote = await this.validateQuote(quoteId);

        // پیدا کردن chainId از روی quote
        const fromNetwork = this.registry.getNetworkById(quote.fromNetworkId)!;
        const sourceChainId = fromNetwork.chainId!;

        // ایجاد رکورد Trade
        const trade = await prisma.trade.create({
            data: { quoteId: quote.id, status: 'PENDING' }
        });
        console.log(`[Trade ${trade.id}] Created for Native Swap with status PENDING.`);

        try {
            // ۱. ارسال Meta-Transaction به بلاک‌چین
            const txHash = await this.evmContractService.executeMetaTransaction(
                sourceChainId,
                request,
                signature
            );

            // ۲. محاسبه مجدد مقدار نهایی (بدون تغییر)



            const toNetwork = this.registry.getNetworkById(quote.toNetworkId!!)!;
            const toAssetConfig = this.assetRegistry.getAssetBySymbol(quote.toAssetSymbol, quote.toNetworkId!)!;
            const finalAmountToSend = parseFloat(quote.finalReceiveAmount.toString());




            const decimals = toAssetConfig.decimals;
            const roundedAmount = Math.floor(finalAmountToSend * (10 ** decimals)) / (10 ** decimals);
            const amountToSendString = roundedAmount.toFixed(decimals);

            // ۳. شبیه‌سازی معامله در صرافی (بدون تغییر)
            console.log(`[Trade ${trade.id}] [SIMULATION] Executing trade on exchange: ${quote.bestExchange}...`);

            // --- مرحله ۴: اجرای پرداخت نهایی واقعی (نسخه کامل و بازنویسی شده) ---
            console.log(`[Trade ${trade.id}] Initiating REAL payout of ${amountToSendString} ${quote.toAssetSymbol}...`);

            let finalTxHash: string;

            // **بخش کلیدی: تشخیص نوع شبکه مقصد**
            if (toNetwork.networkType === 'EVM' && toNetwork.chainId) {
                // **مقصد یک شبکه EVM است**
                const toAssetConfig = this.assetRegistry.getAssetBySymbol(quote.toAssetSymbol, quote.toNetworkId!!)!;
                if (toAssetConfig.contractAddress) {
                    finalTxHash = await this.payoutService.sendErc20Token(
                        toNetwork.chainId, quote.toAssetSymbol, quote.recipientAddress!!, amountToSendString
                    );
                } else {
                    finalTxHash = await this.payoutService.sendNativeToken(
                        toNetwork.chainId, quote.recipientAddress!!, amountToSendString
                    );
                }
            } else if (toNetwork.networkType === 'BITCOIN') {
                // (این بخش نیاز به گرد کردن جداگانه به ساتوشی دارد)
                const amountBtcRounded = parseFloat(finalAmountToSend.toFixed(8)); // بیت‌کوین ۸ رقم اعشار دارد
                // **مقصد یک شبکه بیت‌کوین است**
                finalTxHash = await this.bitcoinPayoutService.sendBitcoin(
                    quote.recipientAddress!!,
                    amountBtcRounded
                );
            } else {
                throw new Error(`Unsupported destination network type for payout: ${toNetwork.networkType}`);
            }
            // --- پایان بخش کلیدی ---

            // ۵. آپدیت نهایی Trade
            await prisma.trade.update({
                where: { id: trade.id },
                data: {
                    status: 'COMPLETED',
                    txHashContractCall: txHash,
                    txHashFinalTransfer: finalTxHash,
                }
            });

            console.log(`✅ [Trade ${trade.id}] Native swap completed successfully.`);
            // ... (ارسال رویداد WebSocket)
            return trade.id;


        } catch (error) {
            // ... (error handling)
            throw error;
        }
    }

    private async convertAmount(amount: number, fromAsset: string, toAsset: string): Promise<number> {
        if (fromAsset.toUpperCase() === toAsset.toUpperCase()) {
            return amount;
        }
        // این باید از QuotingService بیاید، اما برای سادگی اینجا تکرار می‌کنیم
        const priceMap: { [key: string]: number } = { "ETH": 4300, "USDT": 1 ,"BNB": 908,"BTC": 113937};

        const fromPriceUsd = priceMap[fromAsset.toUpperCase()];
        const toPriceUsd = priceMap[toAsset.toUpperCase()];

        if (fromPriceUsd === undefined || toPriceUsd === undefined || toPriceUsd === 0) {
            throw new Error(`Cannot convert from ${fromAsset} to ${toAsset}: price not found.`);
        }

        const valueInUsd = amount * fromPriceUsd;
        return valueInUsd / toPriceUsd;
    }

    /**
     * فرآیند سواپ را پس از دریافت رویداد NativeTradeInitiated از بلاک‌چین آغاز می‌کند.
     * این تابع توسط EvmEventMonitorWorker فراخوانی می‌شود.
     */
    public async executeNativeSwapFromEvent(eventData: NativeSwapEventData): Promise<void> {
        // ۱. استخراج و تبدیل داده‌های رویداد
        const decodedQuoteId = eventData.quoteId;
        //const receivedAmount = parseFloat(ethers.formatEther(eventData.amount));

        console.log(`[Execute Event] Initiating swap for Quote ID: ${decodedQuoteId} from user ${eventData.user}`);

        // ۲. بازیابی Quote از دیتابیس
        const quote = await prisma.quote.findUnique({ where: { id: decodedQuoteId } });

        if (!quote) {
            console.error(`[Execute Event] CRITICAL: Quote with ID ${decodedQuoteId} not found in DB! Cannot proceed.`);
            // TODO: یک سیستم هشدار برای ادمین در اینجا باید پیاده‌سازی شود.
            return;
        }

        // ۳. ایجاد رکورد Trade
        // ما چک می‌کنیم که آیا قبلاً یک Trade برای این Quote ساخته شده یا نه تا از تکرار جلوگیری کنیم.
        const existingTrade = await prisma.trade.findFirst({ where: { quoteId: quote.id } });
        if (existingTrade) {
            console.warn(`[Execute Event] Trade for Quote ID ${quote.id} already exists. Skipping.`);
            return;
        }
        const trade = await prisma.trade.create({
            data: {
                quoteId: quote.id,
                status: 'PROCESSING',
                txHashContractCall: eventData.txHash, // هش تراکنش واریز کاربر
            }
        });
        console.log(`[Trade ${trade.id}] Created for Native Swap with status PROCESSING.`);

        try {
            // ۴. شبیه‌سازی معامله در صرافی (این بخش همچنان شبیه‌سازی است)
            console.log(`[Trade ${trade.id}] [SIMULATION] Executing trade on exchange: ${quote.bestExchange}...`);

            // ۵. اجرای پرداخت نهایی واقعی به کاربر
            const toNetwork = this.registry.getNetworkById(quote.toNetworkId!)!;
            const toAssetConfig = this.assetRegistry.getAssetBySymbol(quote.toAssetSymbol, quote.toNetworkId!)!;
            const finalAmountToSend = parseFloat(quote.finalReceiveAmount.toString());
            const recipientAddress = quote.recipientAddress!;

            // گرد کردن مقدار برای جلوگیری از خطای "too many decimals"
            const decimals = toAssetConfig.decimals;
            const roundedAmount = Math.floor(finalAmountToSend * (10 ** decimals)) / (10 ** decimals);
            const amountToSendString = roundedAmount.toFixed(decimals);

            console.log(`[Trade ${trade.id}] Initiating REAL payout of ${amountToSendString} ${quote.toAssetSymbol}...`);

            let finalTxHash: string;
            if (toNetwork.networkType === 'EVM' && toNetwork.chainId) {
                if (toAssetConfig.contractAddress) {
                    finalTxHash = await this.payoutService.sendErc20Token(
                        toNetwork.chainId, quote.toAssetSymbol, quote.recipientAddress!!, amountToSendString
                    );
                } else {
                    finalTxHash = await this.payoutService.sendNativeToken(
                        toNetwork.chainId, quote.recipientAddress!!, amountToSendString
                    );
                }
            } else if (toNetwork.networkType === 'BITCOIN') {
                // (این بخش نیاز به گرد کردن جداگانه به ساتوشی دارد)
                const amountBtcRounded = parseFloat(finalAmountToSend.toFixed(8)); // بیت‌کوین ۸ رقم اعشار دارد
                // **مقصد یک شبکه بیت‌کوین است**
                finalTxHash = await this.bitcoinPayoutService.sendBitcoin(
                    quote.recipientAddress!!,
                    amountBtcRounded
                );
            } else {
                throw new Error(`Unsupported destination network type: ${toNetwork.networkType}`);
            }

            // ۶. آپدیت نهایی Trade و اطلاع‌رسانی
            await prisma.trade.update({
                where: { id: trade.id },
                data: { status: 'COMPLETED', txHashFinalTransfer: finalTxHash }
            });
            console.log(`✅ [Trade ${trade.id}] Native swap from event completed successfully.`);

            getWebSocketManager().broadcast({
                type: 'TRADE_COMPLETED',
                tradeId: trade.id,
                quoteId: quote.id,
                finalTxHash: finalTxHash
            });

        } catch (error) {
            // ۷. مدیریت خطا
            const errorMessage = (error as Error).message;
            console.error(`❌ [Trade ${trade.id}] Failed during execution from event:`, errorMessage);
            await prisma.trade.update({
                where: { id: trade.id },
                data: { status: 'FAILED', failureReason: errorMessage }
            });

            getWebSocketManager().broadcast({
                type: 'TRADE_FAILED',
                tradeId: trade.id,
                quoteId: quote.id,
                reason: errorMessage
            });
        }
    }


}