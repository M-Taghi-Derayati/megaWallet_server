import { PrismaClient, Quote } from '@prisma/client';
import { PayoutService } from './PayoutService'; // برای پرداخت‌های EVM
import { BitcoinPayoutService } from './BitcoinPayoutService'; // برای پرداخت‌های Bitcoin
import { BlockchainRegistry } from '../config/BlockchainRegistry';
import { AssetRegistry } from '../config/AssetRegistry';
import { getWebSocketManager } from '../websocket/WebSocketManager';

const prisma = new PrismaClient();

export class UtxoTradeExecutionService {
    private evmPayoutService: PayoutService;
    private bitcoinPayoutService: BitcoinPayoutService;
    private registry: BlockchainRegistry;
    private assetRegistry: AssetRegistry;

    constructor() {
        this.registry = new BlockchainRegistry();
        this.assetRegistry = new AssetRegistry();
        this.evmPayoutService = new PayoutService(this.registry, this.assetRegistry);
        this.bitcoinPayoutService = new BitcoinPayoutService(this.registry);
    }

    /**
     * این تابع توسط DepositMonitorWorker فراخوانی می‌شود تا فرآیند سواپ را آغاز کند.
     * @param quoteId شناسه پیش‌فاکتور مرتبط با واریز.
     * @param receivedAmountBtc مقدار دقیق بیت‌کوینی که از کاربر دریافت شده.
     */
    public async initiateSwap(quoteId: string, receivedAmountBtc: number) {
        console.log(`[UTXO Execute] Initiating swap for Quote ID: ${quoteId} with received amount: ${receivedAmountBtc} BTC`);

        // ۱. بازیابی Quote از دیتابیس
        const quote = await prisma.quote.findUnique({
            where: { id: quoteId },
            include: { depositAddress: true }
        });

        if (!quote || !quote.depositAddress || !quote.recipientAddress || !quote.toNetworkId) {
            console.error(`[UTXO Execute] Invalid quote or missing critical info for Quote ID: ${quoteId}`);
            // TODO: یک مکانیسم برای بازگرداندن وجه به کاربر در این حالت باید در نظر گرفته شود.
            return;
        }

        // ۲. ایجاد رکورد Trade جدید
        const trade = await prisma.trade.create({
            data: {
                quoteId: quote.id,
                status: 'PROCESSING',
                txHashContractCall: quote.depositAddress.receivedTxHash, // هش واریزی کاربر
            }
        });
        console.log(`[Trade ${trade.id}] Created with status PROCESSING.`);

        try {
            // ۳. محاسبه مجدد مقدار نهایی بر اساس واریز واقعی
            // نرخ تبدیل را از Quote اولیه می‌خوانیم
            const exchangeRate = parseFloat(quote.exchangeRate.toString());
            const grossReceiveAmount = receivedAmountBtc * exchangeRate;

            // کارمزدها را دوباره محاسبه می‌کنیم (بهتر است درصدهای کارمزد هم در Quote ذخیره شوند)
            const exchangeFee = grossReceiveAmount * 0.001; // فرض 0.1%
            const ourFee = grossReceiveAmount * 0.002; // فرض 0.2%
            const finalAmountToSend = grossReceiveAmount - exchangeFee - ourFee;

            console.log(`[Trade ${trade.id}] Recalculated final amount: ${finalAmountToSend} ${quote.toAssetSymbol}`);

            // ۴. اجرای واقعی معامله در صرافی (این بخش همچنان شبیه‌سازی است)
            console.log(`[Trade ${trade.id}] [SIMULATION] Executing trade on exchange ${quote.bestExchange}...`);

            // ۵. ارسال نهایی و واقعی به کاربر
            const toNetwork = this.registry.getNetworkById(quote.toNetworkId)!;
            const toAssetConfig = this.assetRegistry.getAssetBySymbol(quote.toAssetSymbol, quote.toNetworkId)!;


            const decimals = toAssetConfig.decimals;
            const factor = 10 ** decimals;
            const roundedAmount = Math.floor(finalAmountToSend * factor) / factor;
            const amountToSendString = roundedAmount.toFixed(decimals);
            console.log(`[UTXO Execute] Final amount rounded to ${decimals} decimals: ${amountToSendString}`);

            let finalTxHash: string;
            console.log(`[Trade ${trade.id}] Initiating REAL payout of ${amountToSendString} ${quote.toAssetSymbol}...`);

            if (toNetwork.networkType === 'BITCOIN') {
                finalTxHash = await this.bitcoinPayoutService.sendBitcoin(quote.recipientAddress, finalAmountToSend);
            }
            else if (toNetwork.networkType === 'EVM') {
                if (toAssetConfig.contractAddress) {
                    finalTxHash = await this.evmPayoutService.sendErc20Token(
                        toNetwork.chainId, quote.toAssetSymbol, quote.recipientAddress, amountToSendString
                    );
                } else {
                    finalTxHash = await this.evmPayoutService.sendNativeToken(
                        toNetwork.chainId, quote.recipientAddress, amountToSendString
                    );
                }
            }
            else {
                throw new Error(`Unsupported destination network type: ${toNetwork.networkType}`);
            }

            // ۶. آپدیت نهایی Trade با هش تراکنش واقعی پرداخت
            await prisma.trade.update({
                where: { id: trade.id },
                data: {
                    status: 'COMPLETED',
                    txHashFinalTransfer: finalTxHash,
                }
            });

            console.log(`✅ [Trade ${trade.id}] UTXO swap completed successfully. Final TxHash: ${finalTxHash}`);

            getWebSocketManager().broadcast({
                type: 'TRADE_COMPLETED',
                tradeId: trade.id,
                quoteId: quote.id,
                finalTxHash: finalTxHash
            });

        } catch (error) {
            console.error(`❌ [Trade ${trade.id}] UTXO swap failed:`, error);
            await prisma.trade.update({
                where: { id: trade.id },
                data: { status: 'FAILED', failureReason: (error as Error).message }
            });
            getWebSocketManager().broadcast({
                type: 'TRADE_FAILED',
                tradeId: trade.id,
                quoteId: quote.id,
                reason: (error as Error).message
            });
            // در اینجا هم باید به کاربر اطلاع‌رسانی شود یا وجه بازگردانده شود
        }
    }
}