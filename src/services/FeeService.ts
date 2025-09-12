import { ethers } from 'ethers';
import { BlockchainRegistry } from '../config/BlockchainRegistry';

// کانفیگ‌های ثابت مربوط به هزینه‌ها
const FEE_CONFIG = {
    // کارمزد درصدی صرافی (فرض می‌کنیم برای همه یکسان است)
    EXCHANGE_FEE_PERCENT: 0.001, // 0.1%

    // مدل کارمزد پلکانی ما
    OUR_FEE_TIERS: [
        { threshold: 1000, percent: 0.002 },  // برای معاملات زیر 1000 دلار، 0.2%
        { threshold: Infinity, percent: 0.001 } // برای معاملات 1000 دلار و بالاتر، 0.1%
    ],

    // مقادیر Gas Limit تخمینی برای تراکنش‌های مختلف
    GAS_LIMITS: {
        PERMIT_SWAP_CONTRACT_CALL: 150000, // اجرای قرارداد Phoenix
        FINAL_TRANSFER: 21000             // یک انتقال ساده ETH/Token
    },
};

export class FeeService {
    private blockchainRegistry: BlockchainRegistry;
    private providerCache: Map<number, ethers.JsonRpcProvider>;

    constructor(registry: BlockchainRegistry) {
        this.blockchainRegistry = registry;
        this.providerCache = new Map();
    }

    /**
     * یک نمونه JsonRpcProvider برای یک chainId خاص می‌سازد یا از کش برمی‌گرداند.
     */
    private getProvider(chainId: number): ethers.JsonRpcProvider {
        // اگر provider در کش وجود داشت، آن را برگردان
        if (this.providerCache.has(chainId)) {
            return this.providerCache.get(chainId)!;
        }

        // در غیر این صورت، یک نمونه جدید بساز
        const network = this.blockchainRegistry.getNetworkByChainId(chainId);
        if (!network || !network.rpcUrls || network.rpcUrls.length === 0) {
            throw new Error(`RPC URL for chainId ${chainId} not found in registry.`);
        }

        const providerOptions = {
            batchMaxCount: 1, // جلوگیری از خطای Batch Request در RPC های رایگان
        };

        // از اولین RPC URL در لیست استفاده می‌کنیم
        const provider = new ethers.JsonRpcProvider(
            network.rpcUrls[0],
            undefined,
            providerOptions
        );

        // provider جدید را در کش ذخیره کن
        this.providerCache.set(chainId, provider);
        return provider;
    }

    /**
     * قیمت لحظه‌ای Gas را از شبکه می‌خواند.
     */
    private async getGasPrice(chainId: number): Promise<bigint> {
        try {
            const provider = this.getProvider(chainId);
            const feeData = await provider.getFeeData();
            // از gasPrice استفاده می‌کنیم که با اکثر شبکه‌های EVM سازگار است
            return feeData.gasPrice || BigInt(0);
        } catch (error) {
            console.error(`Failed to get gas price for chainId ${chainId}:`, error);
            // در صورت خطا، یک مقدار پیش‌فرض بسیار بالا برمی‌گردانیم تا در محاسبات مشکل ایجاد نکند
            // یا می‌توانیم خطا را throw کنیم
            return BigInt("50000000000"); // 50 Gwei
        }
    }

    /**
     * کارمزد ثابت صرافی را محاسبه می‌کند.
     */
    public calculateExchangeFee(grossAmount: number): number {
        return grossAmount * FEE_CONFIG.EXCHANGE_FEE_PERCENT;
    }

    /**
     * کارمزد ما را بر اساس مدل پلکانی محاسبه می‌کند.
     */
    public calculateOurFee(tradeValueUsd: number, grossAmount: number): number {
        const feeTiers = FEE_CONFIG.OUR_FEE_TIERS;
        const tier = feeTiers.find(t => tradeValueUsd < t.threshold);

        let feePercent: number;

        if (tier) {
            feePercent = tier.percent;
        } else if (feeTiers.length > 0) {
            const lastTier = feeTiers[feeTiers.length - 1];
            feePercent = lastTier.percent;
        } else {
            console.warn("Fee tiers are not configured. Defaulting our fee to 0.");
            feePercent = 0;
        }

        return grossAmount * feePercent;
    }

    /**
     * هزینه Gas برای اجرای قرارداد هوشمند در شبکه مبدا را محاسبه می‌کند.
     */
    public async getContractCallGasCost(chainId: number): Promise<{ cost: number, asset: string }> {
        const network = this.blockchainRegistry.getNetworkByChainId(chainId);
        if (!network) throw new Error(`Network ${chainId} not found.`);

        const gasPrice = await this.getGasPrice(chainId);
        const gasLimit = FEE_CONFIG.GAS_LIMITS.PERMIT_SWAP_CONTRACT_CALL;
        const totalCostInWei = gasPrice * BigInt(gasLimit);

        return {
            cost: parseFloat(ethers.formatUnits(totalCostInWei, 18)), // formatUnits امن‌تر است
            asset: network.currencySymbol,
        };
    }

    /**
     * هزینه Gas برای ارسال نهایی (یک تراکنش ساده) را در شبکه مقصد محاسبه می‌کند.
     */
    public async getFinalTransferGasCost(chainId: number): Promise<{ cost: number, asset: string }> {
        const network = this.blockchainRegistry.getNetworkByChainId(chainId);
        if (!network) throw new Error(`Network ${chainId} not found.`);

        const gasPrice = await this.getGasPrice(chainId);
        const gasLimit = FEE_CONFIG.GAS_LIMITS.FINAL_TRANSFER;
        const totalCostInWei = gasPrice * BigInt(gasLimit);

        return {
            cost: parseFloat(ethers.formatUnits(totalCostInWei, 18)),
            asset: network.currencySymbol,
        };
    }
}