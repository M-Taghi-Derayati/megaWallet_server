import { Request, Response } from 'express';
import { QuotingService } from '../../services/QuotingService';
import { TradeExecutionService } from '../../services/TradeExecutionService';
import { MetaTxService } from '../../services/MetaTxService';
import {BlockchainRegistry} from "../../config/BlockchainRegistry";
import { AssetRegistry } from '../../config/AssetRegistry';
import { ethers } from 'ethers';

// یک نمونه از سرویس‌ها را می‌سازیم
const quotingService = new QuotingService();
const tradeExecutionService = new TradeExecutionService();
const blockchainRegistry = new BlockchainRegistry();
const assetRegistry = new AssetRegistry();
const metaTxService = new MetaTxService(blockchainRegistry);

/**
 * Handler برای دریافت پیش‌فاکتور (Quote).
 */
export const getQuoteHandler = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { fromAssetSymbol, fromNetworkId, toAssetSymbol, amount , recipientAddress, toNetworkId} = req.body;

        if (!fromAssetSymbol || !fromNetworkId || !toAssetSymbol || amount === undefined) {
            return res.status(400).json({
                error: 'Bad Request',
                message: 'Missing required fields: fromAssetSymbol, fromNetworkId, toAssetSymbol, amount'
            });
        }

        const numericAmount = parseFloat(amount);
        if (isNaN(numericAmount) || numericAmount <= 0) {
            return res.status(400).json({
                error: 'Bad Request',
                message: 'Invalid amount provided. Must be a positive number.'
            });
        }

        console.log(`[Quote] Received request: ${numericAmount} ${fromAssetSymbol} (${fromNetworkId}) -> ${toAssetSymbol}`);
        const quote = await quotingService.getQuote(
            fromAssetSymbol,
            fromNetworkId,
            toAssetSymbol,
            numericAmount,
            recipientAddress,
            toNetworkId
        );

        return res.status(200).json(quote);

    } catch (error: any) {
        console.error("[Controller Error] in getQuoteHandler:", error.message);
        return res.status(500).json({
            error: 'Internal Server Error',
            message: error.message || 'An unexpected error occurred while fetching the quote.'
        });
    }
};

/**
 * Handler برای اجرای نهایی معامله.
 */
export const executeSwapHandler = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { quoteId, selectedNetworkId, recipientAddress, permitParameters } = req.body;

        // اعتبارسنجی دقیق ورودی
        if (!quoteId || !selectedNetworkId || !recipientAddress || !permitParameters) {
            return res.status(400).json({ error: 'Bad Request', message: 'Missing required fields for execution.' });
        }
        // (در یک پروژه واقعی، هر فیلد داخلی permitParameters هم باید اعتبارسنجی شود)

        console.log(`[Execute] Received request for Quote ID: ${quoteId}`);
        const tradeId = await tradeExecutionService.executeTrade(req.body);

        // ارسال پاسخ موفقیت‌آمیز
        return res.status(200).json({
            message: "Trade submitted and is being processed.",
            tradeId: tradeId
        });

    } catch (error: any) {
        console.error("[Controller Error] in executeSwapHandler:", error.message);
        return res.status(500).json({
            error: 'Internal Server Error',
            message: error.message || 'An unexpected error occurred while executing the swap.'
        });
    }
};

/**
 * Handler برای دریافت پیش‌فاکتور (Quote) برای سواپ توکن‌های اصلی (Native).
 * این تابع دو کار اصلی انجام می‌دهد:
 * 1. یک پیش‌فاکتور قیمت‌گذاری از QuotingService دریافت می‌کند.
 * 2. ساختار داده EIP-712 را برای امضای Meta-Transaction از MetaTxService می‌سازد.
 * هر دو نتیجه را در یک پاسخ واحد به کلاینت برمی‌گرداند.
 */
export const getNativeQuoteHandler = async (req: Request, res: Response): Promise<Response> => {
    try {
        // ۱. استخراج و اعتبارسنجی پارامترهای ورودی از بدنه درخواست
        const { fromAssetSymbol, fromNetworkId, toAssetSymbol, toNetworkId, amount, recipientAddress, userAddress } = req.body;

        // چک کردن فیلدهای ضروری
        if (!fromAssetSymbol || !fromNetworkId || !toAssetSymbol || !toNetworkId || amount === undefined || !recipientAddress || !userAddress) {
            return res.status(400).json({
                error: 'Bad Request',
                message: 'Missing required fields: fromAssetSymbol, fromNetworkId, toAssetSymbol, toNetworkId, amount, recipientAddress, userAddress'
            });
        }

        // اعتبارسنجی آدرس‌ها
        if (!ethers.isAddress(userAddress) || !ethers.isAddress(recipientAddress)) {
            return res.status(400).json({ error: 'Bad Request', message: 'Invalid userAddress or recipientAddress format.' });
        }

        const numericAmount = parseFloat(amount);
        if (isNaN(numericAmount) || numericAmount <= 0) {
            return res.status(400).json({ error: 'Bad Request', message: 'Invalid amount.' });
        }

        // ۲. دریافت پیش‌فاکتور قیمت‌گذاری از QuotingService
        console.log(`[Native Quote] Fetching price quote for ${numericAmount} ${fromAssetSymbol}...`);
        const quote = await quotingService.getQuote(
            fromAssetSymbol,
            fromNetworkId,
            toAssetSymbol,
            numericAmount,
            recipientAddress,
            toNetworkId
        );

        // ۳. ساخت ساختار Meta-Transaction برای امضای کلاینت
        console.log(`[Native Quote] Creating meta-transaction structure for user ${userAddress}...`);
        const network = blockchainRegistry.getNetworkById(fromNetworkId);
        if (!network || !network.chainId) throw new Error("Source network config is invalid.");

        // پیدا کردن تعداد اعشار صحیح برای تبدیل به کوچکترین واحد
        const fromAssetConfig = assetRegistry.getAssetBySymbol(fromAssetSymbol, fromNetworkId);
        if (!fromAssetConfig) throw new Error("Source asset config not found.");
        const amountInWei = ethers.parseUnits(numericAmount.toString(), fromAssetConfig.decimals).toString();

        const { request, domain } = await metaTxService.createForwardRequest(
            userAddress,
            network.chainId,
            quote.quoteId, // از quoteId تولید شده در مرحله قبل استفاده می‌کنیم
            amountInWei
        );

        // ۴. ارسال پاسخ جامع به کلاینت
        return res.status(200).json({
            quote,
            metaTx: {
                types: {
                    ForwardRequest: [
                        { name: 'from', type: 'address' },
                        { name: 'to', type: 'address' },
                        { name: 'value', type: 'uint256' },
                        { name: 'gas', type: 'uint256' },
                        { name: 'nonce', type: 'uint256' },
                        { name: 'data', type: 'bytes' },
                    ]
                },
                domain,
                primaryType: 'ForwardRequest',
                message: request
            }
        });

    } catch (error: any) {
        console.error("[Controller Error] in getNativeQuoteHandler:", error.message);
        return res.status(500).json({
            error: 'Internal Server Error',
            message: error.message || 'An unexpected error occurred.'
        });
    }
};

/**
 * Handler برای اجرای نهایی سواپ توکن اصلی با استفاده از Meta-Transaction.
 */
export const executeNativeSwapHandler = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { quoteId, request, signature } = req.body;

        if (!quoteId || !request || !signature) {
            return res.status(400).json({ error: 'Bad Request', message: 'Missing required fields: quoteId, request, signature' });
        }

        // ما کل وظیفه را به TradeExecutionService واگذار می‌کنیم
        const tradeId = await tradeExecutionService.executeNativeSwap(quoteId, request, signature);

        return res.status(200).json({
            message: "Native swap meta-transaction submitted and is being processed.",
            tradeId: tradeId
        });

    } catch (error: any) {
        console.error("[Controller Error] in executeNativeSwapHandler:", error.message);
        return res.status(500).json({
            error: 'Internal Server Error',
            message: error.message || 'An unexpected error occurred.'
        });
    }
};