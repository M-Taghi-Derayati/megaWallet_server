import { Router } from 'express';
import { getQuoteHandler, executeSwapHandler } from './swap.controller';

const router = Router();

// مسیر برای دریافت پیش‌فاکتور (Quote)
// POST /api/v1/swap/quote
router.post('/quote', getQuoteHandler);

// مسیر برای اجرای نهایی معامله (Execute)
// POST /api/v1/swap/execute
router.post('/execute', executeSwapHandler);

export default router;