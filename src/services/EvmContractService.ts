import { ethers, Wallet, Contract } from 'ethers';
import { BlockchainRegistry } from '../config/BlockchainRegistry';
import PhoenixContractAbi from '../abi/phoenixAbi.json';

// اینترفیس برای پارامترهای Permit
interface PermitParams {
    tokenAddress: string;
    userAddress: string;
    amount: string;
    deadline: number;
    v: number;
    r: string;
    s: string;
}

export class EvmContractService {
    private registry: BlockchainRegistry;

    constructor(registry: BlockchainRegistry) {
        this.registry = registry;
    }

    /**
     * یک کیف پول "مالک" (owner) برای یک شبکه خاص می‌سازد.
     */
    private getOwnerWallet(chainId: number): Wallet {
        const network = this.registry.getNetworkByChainId(chainId);
        if (!network) {
            throw new Error(`Network configuration for chainId ${chainId} not found.`);
        }

        const privateKeyEnvVar = `${network.name.toUpperCase()}_ADMIN_PRIVATE_KEY`;
        const privateKey = process.env[privateKeyEnvVar];
        const rpcUrl = network.rpcUrls[0];

        if (!privateKey || !rpcUrl) {
            throw new Error(`Admin private key or RPC URL for ${network.name} is not configured in .env`);
        }

        const provider = this.registry.getProvider(chainId);
        return new Wallet(privateKey, provider);
    }

    /**
     * یک آبجکت Contract برای قرارداد Phoenix در یک شبکه خاص می‌سازد.
     */
    private getPhoenixContract(chainId: number): Contract {
        const network = this.registry.getNetworkByChainId(chainId);
        if (!network || !network.phoenixContractAddress) {
            throw new Error(`PhoenixContract address for chainId ${chainId} not found.`);
        }
        const ownerWallet = this.getOwnerWallet(chainId);

        return new Contract(network.phoenixContractAddress, PhoenixContractAbi, ownerWallet);
    }

    /**
     * تابع executeTradeWithPermit را روی قرارداد هوشمند مربوط به شبکه مشخص شده
     * فراخوانی کرده، تراکنش را به شبکه ارسال می‌کند و منتظر تایید آن می‌ماند.
     *
     * @param quoteId شناسه پیش‌فاکتور از سیستم ما.
     * @param params پارامترهای امضای Permit از کلاینت.
     * @param chainId شناسه زنجیره شبکه مبدا.
     * @returns هش تراکنش واقعی (Transaction Hash) در صورت موفقیت.
     */
    public async executeTrade(quoteId: string, params: PermitParams, chainId: number): Promise<{ txHash: string, receipt: ethers.TransactionReceipt}> {
        console.log(`Executing REAL trade on chainId: ${chainId}`);

        const contract = this.getPhoenixContract(chainId);

        // تبدیل quoteId رشته‌ای به فرمت bytes32
        const quoteIdBytes32 = ethers.encodeBytes32String(quoteId.substring(0, 31));

        try {

            const contract = this.getPhoenixContract(chainId);

            // --- بخش جدید: استراتژی Gas بهتر ---
            const feeData = await contract.runner!!.provider!!.getFeeData();
            const gasPrice = feeData.gasPrice;

            if (!gasPrice) {
                throw new Error("Could not fetch gas price from the network.");
            }

            // قیمت Gas را ۲۰٪ افزایش می‌دهیم تا اولویت بیشتری بگیریم
            // BigInt برای محاسبات امن با اعداد بزرگ استفاده می‌شود
            const boostedGasPrice = (gasPrice * BigInt(110)) / BigInt(100);
            console.log(`   - Base Gas Price: ${ethers.formatUnits(gasPrice, 'gwei')} Gwei`);
            console.log(`   - Boosted Gas Price: ${ethers.formatUnits(boostedGasPrice, 'gwei')} Gwei`);

            console.log(`Calling executeTradeWithPermit on ${contract.target}...`);





            // --- ارسال تراکنش واقعی به شبکه ---
            const tx = await contract.executeTradeWithPermit(
                params.tokenAddress,
                params.userAddress,
                params.amount,
                params.deadline,
                quoteIdBytes32,
                params.v,
                params.r,
                params.s,
                {
                    gasLimit: 250000, // تنظیم یک Gas Limit معقول برای جلوگیری از خطای out of gas
                    gasPrice: boostedGasPrice // <<<--- استفاده از قیمت Gas افزایش یافته
                }
            );

            console.log(`Transaction sent to mempool. Hash: ${tx.hash}`);
            console.log("Waiting for transaction to be mined (this may take a moment)...");

            // --- بخش جدید: اضافه کردن Timeout ---
            // یک Promise می‌سازیم که بعد از 80 ثانیه با خطا رد می‌شود
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Transaction timed out after 80 seconds.")), 80000)
            );

            // با Promise.race، منتظر اولین اتفاق می‌مانیم: یا تایید تراکنش یا Timeout
            const receipt = await Promise.race([
                tx.wait(1),
                timeoutPromise
            ]) as ethers.TransactionReceipt;

            if (receipt.status !== 1) {
                // اگر تراکنش در بلاک‌چین revert شد
                console.error(`❌ Transaction reverted on-chain. Receipt:`, receipt);
                throw new Error(`Transaction failed on-chain with status 0.`);
            }

            console.log(`✅ Transaction successfully mined in block ${receipt.blockNumber}.`);
            return { txHash: tx.hash, receipt: receipt! };

        } catch (error: any) {
            console.error("❌ Error executing contract call:", error.message);
            if (error.reason) console.error("   - Revert Reason:", error.reason);

            // برگرداندن یک پیام خطای قابل فهم‌تر برای کلاینت
            throw new Error(`On-chain transaction failed: ${error.reason || 'Unknown error'}`);
        }
    }
}