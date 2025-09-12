import { Request, Response } from 'express';
import { QuotingService } from '../../services/QuotingService';
import { TradeExecutionService } from '../../services/TradeExecutionService';

// یک نمونه از سرویس‌ها را می‌سازیم
const quotingService = new QuotingService();
const tradeExecutionService = new TradeExecutionService();

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