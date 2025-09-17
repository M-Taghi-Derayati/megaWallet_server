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

            // ۲. شبیه‌سازی مراحل بعدی (صرافی و پرداخت)
            console.log(`[Trade ${trade.id}] [SIMULATION] Executing trade on exchange: ${quote.bestExchange}...`);
            console.log(`[Trade ${trade.id}] [SIMULATION] Transferring final amount...`);
            const fakeFinalTxHash = `0x_fake_final_tx_hash_${Date.now()}`;

            // ۳. آپدیت نهایی Trade
            await prisma.trade.update({
                where: { id: trade.id },
                data: {
                    status: 'COMPLETED',
                    txHashContractCall: txHash,
                    txHashFinalTransfer: fakeFinalTxHash,
                }
            });

            console.log(`✅ [Trade ${trade.id}] Native swap completed successfully.`);
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


}