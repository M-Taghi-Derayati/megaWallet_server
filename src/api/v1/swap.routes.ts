import { Router } from 'express';
import {getQuoteHandler, executeSwapHandler, getNativeQuoteHandler, executeNativeSwapHandler} from './swap.controller';

const router = Router();

// مسیر برای دریافت پیش‌فاکتور (Quote)
// POST /api/v1/swap/quote
router.post('/quote', getQuoteHandler);
router.post('/native/quote', getNativeQuoteHandler);
// مسیر برای اجرای نهایی معامله (Execute)
// POST /api/v1/swap/execute
router.post('/execute', executeSwapHandler);
router.post('/native/execute', executeNativeSwapHandler);


export default router;